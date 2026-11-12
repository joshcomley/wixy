"""Live voice notes: the decoder, the in-memory note state and the listener hub
(spec/server-chat/07-live-voice-notes.md, decisions/00211, Inv 58).

A voice note recorded in live mode is uploaded slice by slice (spec 06) while other people listen.
For every live attachment this module keeps ONE `LiveNote`:

- a long-lived ffmpeg decoder (`Decoder`) fed the slices as they arrive, writing 24 kHz mono s16le
  (the call's own format). It is a transcode under decisions/00209's progress rules: it is killed
  only when decoded output stops advancing for `STALL_S` while input is pending (the clock is frozen
  while the sender is paused), or past the voice ceiling, and then restarted from the first slice
  (decoding is deterministic, so frames already delivered are skipped).
- running per-second peaks (0..255), the decoded duration and a bounded ring of recent PCM frames.

A listener (`Listener`, one per page socket, many notes multiplexed) watches a note's state and
peaks, and may `play` it from the start, the live edge or a sample, credit-limited exactly like the
call's frames. A listener behind the ring (or starting from the start) is fed by its own decoder
over the stored slices, faster than real time but held back by its credit through a bounded buffer,
until it catches up with the ring.

Nothing here is persistent: no audio, peaks or transcript tail is written anywhere (Inv 40/46/58).
The sockets, auth and bounded queues follow `call_broker.py` / `routes_livechat_calls.py`.
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import logging
import subprocess
import time
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final, Literal
from uuid import uuid4

import anyio
import anyio.abc
from anyio.streams.memory import MemoryObjectReceiveStream, MemoryObjectSendStream

from builder.jsontypes import JsonObject
from wixy_server.livechat import live_voice_protocol as protocol
from wixy_server.livechat import uploads
from wixy_server.livechat.call_broker import Budget, CallWork
from wixy_server.livechat.models import AttachmentRow, clear_live_tail
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.processing import (
    _STALL_S,
    _VOICE_CEILING_S,
    MediaProcessingError,
    _creationflags,
    _demuxer_for,
    _niced,
    sniff,
)
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import ServerAuth
from wixy_server.storage import ProjectPaths

if TYPE_CHECKING:
    from wixy_server.livechat.live_transcription import LiveTranscriber

_LOGGER = logging.getLogger(__name__)

RATE: Final = protocol.RATE
SAMPLES: Final = protocol.SAMPLES
FRAME_BYTES: Final = protocol.FRAME_PCM_BYTES
FRAMES_PER_SECOND: Final = RATE // SAMPLES  # 50
RING_FRAMES: Final = 1500
"""Thirty seconds of PCM kept for listeners at the live edge; a listener that falls further behind
is fed from the stored slices instead."""
STALL_S: Final = _STALL_S
CEILING_S: Final = _VOICE_CEILING_S
NO_SLICE_END_S: Final = 60.0
"""spec §2: a live note with no slice for this long while recording is ended and processed."""
PAUSED_END_S: Final = 30 * 60.0
"""spec §2: ...and one paused for longer than this."""
MAX_STREAMS_PER_NOTE: Final = 4
MAX_RESTARTS: Final = 3
STATE_INTERVAL_S: Final = 1.0
ENDED_KEEP_S: Final = 30.0
"""How long an ended note stays registered, so a listener still catching up gets its `eof`."""
BACKFILL_BUFFER_FRAMES: Final = 16
WATCH_POLL_S: Final = 0.5
MAX_BAD_REQUESTS: Final = 10
MAX_SERVER_ENDED: Final = 256
MAX_LISTENERS: Final = 8
MAX_PENDING_LISTENERS: Final = 4
CONTROL_QUEUE_LIMIT: Final = 16
_DB_BACKSTOP_TICKS: Final = 5

Clock = Callable[[], float]
NoteState = Literal["recording", "paused", "ended"]
FrameSink = Callable[[int, bytes], Awaitable[None]]


class SliceUnavailableError(Exception):
    """A slice could be read neither as its chunk file nor from the assembled original."""


class LiveVoiceUnavailableError(Exception):
    """The hub is not running (no app lifespan), so no decoder task can be started."""


# ---------------------------------------------------------------------------
# Small pure pieces
# ---------------------------------------------------------------------------


class StallClock:
    """decisions/00209's progress rules for one decoder run.

    The stall clock counts only while input is PENDING (a slice has been fed and no decoded output
    has followed) and is frozen while `frozen` (the sender is paused, or the consumer is holding
    output back). Any decoded output resets it. The run clock (for the ceiling) also stops while
    frozen. `tick` returns what killed the run, or `None`."""

    def __init__(self, *, stall_s: float, ceiling_s: float, now: float) -> None:
        self._stall_s = stall_s
        self._ceiling_s = ceiling_s
        self._last = now
        self.stalled_for = 0.0
        self.run_for = 0.0
        self.pending = False

    def fed(self) -> None:
        self.pending = True

    def progressed(self) -> None:
        self.pending = False
        self.stalled_for = 0.0

    def tick(self, now: float, *, frozen: bool) -> Literal["stall", "ceiling"] | None:
        elapsed = max(0.0, now - self._last)
        self._last = now
        if frozen:
            return None
        self.run_for += elapsed
        if self.pending:
            self.stalled_for += elapsed
        if self.stalled_for > self._stall_s:
            return "stall"
        if self.run_for > self._ceiling_s:
            return "ceiling"
        return None


def frame_peak(pcm: bytes) -> int:
    """The loudest sample of a frame as 0..255 (full scale 32768)."""
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if not samples:
        return 0
    loudest = max(max(samples), -min(samples))
    return min(255, (loudest * 255 + 16384) // 32768)


class PeakTracker:
    """One bucket per second (50 frames) of the loudest frame in it. A bucket is appended when
    its second completes; the last, partial one is appended when the note ends."""

    def __init__(self) -> None:
        self.peaks: list[int] = []
        self._bucket_max = 0
        self._bucket_frames = 0

    def add(self, pcm: bytes) -> None:
        self._bucket_max = max(self._bucket_max, frame_peak(pcm))
        self._bucket_frames += 1
        if self._bucket_frames == FRAMES_PER_SECOND:
            self.peaks.append(self._bucket_max)
            self._bucket_max = 0
            self._bucket_frames = 0

    def flush(self) -> None:
        if self._bucket_frames:
            self.peaks.append(self._bucket_max)
            self._bucket_max = 0
            self._bucket_frames = 0


class Notify:
    """A broadcast wake-up: `event()` hands out the current event, `notify()` fires it and
    installs a fresh one. Capture the event BEFORE checking a condition, then wait on it: a
    notification between the check and the wait is never lost (everything runs on one loop)."""

    def __init__(self) -> None:
        self._event = anyio.Event()

    def event(self) -> anyio.Event:
        return self._event

    def notify(self) -> None:
        previous, self._event = self._event, anyio.Event()
        previous.set()


# ---------------------------------------------------------------------------
# One live note
# ---------------------------------------------------------------------------


class LiveNote:
    """Everything the hub knows about one live attachment, in memory only."""

    def __init__(
        self, att_id: str, *, upload_dir: Path, clock: Clock, on_audio: Callable[[], None]
    ) -> None:
        self.att_id = att_id
        self.upload_dir = upload_dir
        self.clock = clock
        self._on_audio = on_audio
        self.state: NoteState = "recording"
        self.last_activity = clock()
        self.paused_at: float | None = None
        self.slice_sizes: list[int] = []
        self.closed_total: int | None = None
        """The number of slices that make up the recording, set when the sender completes (or the
        note is auto-ended): the decoder drains exactly these and closes its input."""
        self.finishing = False
        self.changed = Notify()
        self.ring: deque[bytes] = deque()
        self.ring_start = 0
        self.ring_end = 0
        self.peaks = PeakTracker()
        self.total_samples: int | None = None
        self.taps: list[Callable[[int, bytes], None]] = []
        self.decoder_dead = False
        self.decoder_running = False
        self.decoder_done = anyio.Event()
        self.ended = anyio.Event()
        self.ended_at: float | None = None
        self.deleted = False
        self.scope = anyio.CancelScope()
        self.demuxer: str | None = None

    # -- read side ----------------------------------------------------------------------------

    @property
    def slice_count(self) -> int:
        return len(self.slice_sizes)

    @property
    def paused(self) -> bool:
        return self.state == "paused"

    @property
    def duration_ms(self) -> int:
        samples = self.total_samples if self.total_samples is not None else self.ring_end * SAMPLES
        return samples * 1000 // RATE

    def read_slice(self, index: int) -> bytes:
        """Blocking. A slice is its chunk file while the recording runs; once the sender has
        completed, the chunks are joined into `assembled` (and removed), so it is read from there
        at the offset the earlier slices add up to."""
        chunk = self.upload_dir / f"chunk-{index:06d}"
        try:
            return chunk.read_bytes()
        except OSError:
            pass
        try:
            size = self.slice_sizes[index]
            offset = sum(self.slice_sizes[:index])
            with (self.upload_dir / "assembled").open("rb") as handle:
                handle.seek(offset)
                data = handle.read(size)
        except OSError, IndexError:
            raise SliceUnavailableError(str(index)) from None
        if len(data) != size:
            raise SliceUnavailableError(str(index))
        return data

    # -- write side (all on the event loop) -----------------------------------------------------

    def slice_stored(self, index: int, size: int) -> None:
        if index < len(self.slice_sizes):
            self.slice_sizes[index] = size  # an idempotent re-PUT
        elif index == len(self.slice_sizes):
            self.slice_sizes.append(size)
        else:  # the route admits only the next missing slice, so this is a bug upstream
            return
        self.last_activity = self.clock()
        self.changed.notify()

    def set_state(self, state: Literal["recording", "paused"]) -> None:
        now = self.clock()
        self.state = state
        self.paused_at = now if state == "paused" else None
        self.last_activity = now
        self.changed.notify()

    def close(self, total_slices: int) -> None:
        self.closed_total = total_slices
        self.changed.notify()

    def add_live_frame(self, index: int, pcm: bytes) -> None:
        """The live decoder produced frame `index` (a restarted decoder re-delivers frames this
        note already has; those are dropped)."""
        if index < self.ring_end:
            return
        self.ring.append(pcm)
        if len(self.ring) > RING_FRAMES:
            self.ring.popleft()
            self.ring_start += 1
        self.ring_end = index + 1
        self.peaks.add(pcm)
        for tap in list(self.taps):
            tap(index, pcm)
        self._on_audio()

    def frame(self, index: int) -> bytes | None:
        if self.ring_start <= index < self.ring_end:
            return self.ring[index - self.ring_start]
        return None


# ---------------------------------------------------------------------------
# The decoder
# ---------------------------------------------------------------------------


@dataclass
class DecodeResult:
    failure: str | None
    """`None`: every slice was decoded and the decoder exited cleanly."""
    total_samples: int = 0
    """Exact samples decoded (not padded to a whole frame)."""


class Decoder:
    """One ffmpeg decode of a note's slices from the first slice, following the recording while it
    is live. Frames below `start_frame` are decoded and dropped; every later frame goes to
    `on_frame(index, pcm)`, which may block (that is how a listener's credit holds a catch-up
    decode back — ffmpeg simply blocks on its full pipe)."""

    def __init__(
        self,
        note: LiveNote,
        *,
        ffmpeg: str,
        start_frame: int,
        on_frame: FrameSink,
        clock: Clock,
        stall_s: float = STALL_S,
        ceiling_s: float = CEILING_S,
        poll_s: float = WATCH_POLL_S,
    ) -> None:
        self._note = note
        self._ffmpeg = ffmpeg
        self._start_frame = start_frame
        self._on_frame = on_frame
        self._clock = clock
        self._poll_s = poll_s
        self._stall = StallClock(stall_s=stall_s, ceiling_s=ceiling_s, now=clock())
        self._blocked = False
        self._failure: str | None = None
        self._fed_all = False
        self._frames = 0
        self._tail_bytes = 0
        self._stderr_tail = b""

    def _argv(self, demuxer: str) -> list[str]:
        return [
            self._ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "+nobuffer",
            "-probesize",
            "32768",
            "-analyzeduration",
            "0",
            "-f",
            demuxer,
            "-protocol_whitelist",
            "pipe",
            "-i",
            "pipe:0",
            "-map_metadata",
            "-1",
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(RATE),
            "-flush_packets",
            "1",
            "-f",
            "s16le",
            "pipe:1",
        ]

    async def _demuxer(self) -> str:
        if self._note.demuxer is not None:
            return self._note.demuxer
        while self._note.slice_count == 0:
            event = self._note.changed.event()
            if self._note.slice_count:
                break
            if self._note.closed_total == 0:
                raise MediaProcessingError("corrupt", "no slices")
            await event.wait()
        first = await anyio.to_thread.run_sync(self._note.read_slice, 0)
        self._note.demuxer = _demuxer_for(sniff(first), kind="voice")
        return self._note.demuxer

    async def run(self) -> DecodeResult:
        try:
            demuxer = await self._demuxer()
        except MediaProcessingError:
            return DecodeResult("unsupported")
        except SliceUnavailableError:
            return DecodeResult("source_gone")
        try:
            proc = await anyio.open_process(
                _niced(self._argv(demuxer)),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=_creationflags(),
            )
        except OSError:
            return DecodeResult("media_unavailable")
        try:
            async with anyio.create_task_group() as tg:
                tg.start_soon(self._feed, proc, tg.cancel_scope)
                tg.start_soon(self._read, proc, tg.cancel_scope)
                tg.start_soon(self._drain_stderr, proc)
                tg.start_soon(self._watch, proc, tg.cancel_scope)
        finally:
            with anyio.CancelScope(shield=True):
                if proc.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        proc.kill()
                await proc.wait()
                await proc.aclose()
        failure = self._failure
        if failure is None and proc.returncode not in (0, None):
            failure = "exit"
        if failure is None and not self._fed_all:
            failure = "exit"
        total = self._frames * SAMPLES
        if self._tail_bytes:
            total = (self._frames - 1) * SAMPLES + self._tail_bytes // 2
        return DecodeResult(failure, total)

    async def _feed(self, proc: anyio.abc.Process, scope: anyio.CancelScope) -> None:
        note = self._note
        stdin = proc.stdin
        assert stdin is not None
        index = 0
        try:
            while True:
                event = note.changed.event()
                if index < note.slice_count and (
                    note.closed_total is None or index < note.closed_total
                ):
                    data = await anyio.to_thread.run_sync(note.read_slice, index)
                    await stdin.send(data)
                    self._stall.fed()
                    index += 1
                    continue
                if note.closed_total is not None and index >= note.closed_total:
                    break
                await event.wait()
            await stdin.aclose()
            self._fed_all = True
        except SliceUnavailableError:
            self._failure = self._failure or "source_gone"
            scope.cancel()
        except anyio.BrokenResourceError, anyio.ClosedResourceError:
            return  # ffmpeg is gone; `_read` reports why

    async def _read(self, proc: anyio.abc.Process, scope: anyio.CancelScope) -> None:
        stdout = proc.stdout
        assert stdout is not None
        buffer = bytearray()
        try:
            while True:
                try:
                    data = await stdout.receive(65536)
                except anyio.EndOfStream:
                    break
                buffer += data
                while len(buffer) >= FRAME_BYTES:
                    frame = bytes(buffer[:FRAME_BYTES])
                    del buffer[:FRAME_BYTES]
                    await self._emit(frame)
            if buffer:
                self._tail_bytes = len(buffer) - (len(buffer) % 2)
                await self._emit(bytes(buffer) + bytes(FRAME_BYTES - len(buffer)))
        except anyio.BrokenResourceError, anyio.ClosedResourceError:
            pass
        scope.cancel()

    async def _emit(self, frame: bytes) -> None:
        index = self._frames
        self._frames += 1
        self._stall.progressed()
        if index < self._start_frame:
            return
        self._blocked = True
        try:
            await self._on_frame(index, frame)
        finally:
            self._blocked = False

    async def _drain_stderr(self, proc: anyio.abc.Process) -> None:
        stderr = proc.stderr
        assert stderr is not None
        try:
            while True:
                data = await stderr.receive(4096)
                self._stderr_tail = (self._stderr_tail + data)[-512:]
        except anyio.EndOfStream, anyio.BrokenResourceError, anyio.ClosedResourceError:
            return

    async def _watch(self, proc: anyio.abc.Process, scope: anyio.CancelScope) -> None:
        while True:
            await anyio.sleep(self._poll_s)
            verdict = self._stall.tick(self._clock(), frozen=self._note.paused or self._blocked)
            if verdict is not None:
                self._failure = verdict
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                scope.cancel()
                return


# ---------------------------------------------------------------------------
# Listeners
# ---------------------------------------------------------------------------


@dataclass
class _Watched:
    sent_peaks: int = 0
    sent_duration_ms: int = -1
    sent_state: NoteState | None = None
    last_sent: float = 0.0


@dataclass
class _Stream:
    att_id: str
    next_sample: int
    mode: Literal["ring", "backfill"]
    seq: int = 0
    credit: int = 0
    recv: MemoryObjectReceiveStream[tuple[int, bytes]] | None = None
    scope: anyio.CancelScope | None = None
    failure: str | None = None


@dataclass
class Listener:
    """One page's socket. `controls` is a bounded queue of small JSON messages; state messages are
    built lazily by the writer (coalesced: a slow client never accumulates them) and audio frames
    are pulled one at a time, only while the stream has credit."""

    auth: ServerAuth
    label: str
    deadline: float
    id: str = field(default_factory=lambda: uuid4().hex)
    controls: deque[JsonObject] = field(default_factory=deque)
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    closed: bool = False
    controls_budget: Budget = field(default_factory=lambda: Budget(80, 100))
    pong_at: float = field(default_factory=time.monotonic)
    grant_until: float = float("inf")
    watches: dict[str, _Watched] = field(default_factory=dict)
    stream: _Stream | None = None
    ping_ticks: int = 0
    bad_requests: int = 0


# ---------------------------------------------------------------------------
# The hub
# ---------------------------------------------------------------------------


class LiveVoiceHub:
    """Owns every live note and every listener socket of one app. Mutations of notes and listeners
    happen on the event loop and never await in the middle of a transition; blocking work (disk,
    SQLite) runs in threads."""

    def __init__(
        self,
        *,
        store: LiveChatStore,
        paths: ProjectPaths,
        notifier: LiveChatNotifier,
        ffmpeg: str | None,
        chunk_bytes: int,
        clock: Clock = time.monotonic,
        stall_s: float = STALL_S,
        decoder_poll_s: float = WATCH_POLL_S,
    ) -> None:
        self.store = store
        self.paths = paths
        self.notifier = notifier
        self.ffmpeg = ffmpeg
        self.chunk_bytes = chunk_bytes
        self.clock = clock
        self.stall_s = stall_s
        self.decoder_poll_s = decoder_poll_s
        self.notes: dict[str, LiveNote] = {}
        self.server_ended: dict[str, None] = {}
        """Notes THIS process ended itself (an auto-end or startup recovery), newest last and
        bounded: a later `complete` from the sender is then refused with 409 `not_live` instead of
        replaying as if it had ended the note, so the client learns the server got there first."""
        self.listeners: dict[str, Listener] = {}
        self.closed = False
        self.pending = 0
        self.connections = 0
        self.admissions: dict[str, Budget] = {}
        self.admission_work = CallWork(4, "wixy-live-voice-admission")
        self.refresh_work = CallWork(8, "wixy-live-voice-refresh")
        self.transcriber: LiveTranscriber | None = None
        self._tg: anyio.abc.TaskGroup | None = None
        self._ticks = 0

    # -- lifecycle ------------------------------------------------------------------------------

    async def run(self) -> None:
        """The supervised app-lifetime loop: owns the task group every decoder and catch-up decode
        runs in, and ticks the auto-end rules and the ended-note sweep once a second."""
        async with anyio.create_task_group() as tg:
            self._tg = tg
            try:
                for note in list(self.notes.values()):
                    note.decoder_running = False
                    self._ensure_decoder(note)
                while True:
                    await anyio.sleep(1.0)
                    await self.tick()
            finally:
                self._tg = None

    def shutdown(self) -> None:
        self.closed = True
        for listener in list(self.listeners.values()):
            self.remove_listener(listener)
        for note in list(self.notes.values()):
            note.scope.cancel()
            clear_live_tail(note.att_id)
        self.admission_work.close()
        self.refresh_work.close()

    def _spawn(self, fn: Callable[..., Coroutine[Any, Any, Any]], *args: Any) -> bool:
        if self._tg is None:
            return False
        self._tg.start_soon(fn, *args)
        return True

    def spawn_task(self, fn: Callable[..., Coroutine[Any, Any, Any]], *args: Any) -> None:
        """Start a task in the hub's group (the live transcriber's loops)."""
        if not self._spawn(fn, *args):
            raise LiveVoiceUnavailableError("the live voice hub is not running")

    # -- notes ----------------------------------------------------------------------------------

    def _note_for(self, att_id: str) -> LiveNote:
        note = self.notes.get(att_id)
        if note is None:
            note = LiveNote(
                att_id,
                upload_dir=self.paths.server_upload_dir(att_id),
                clock=self.clock,
                on_audio=self._wake_streams,
            )
            self.notes[att_id] = note
        return note

    def begin(self, attachment: AttachmentRow) -> LiveNote:
        """A `listen` upload was created: start tracking its note."""
        note = self._note_for(attachment.id)
        if attachment.live_state == "paused":
            note.set_state("paused")
        return note

    def slice_stored(self, att_id: str, index: int, size: int) -> None:
        """The upload route stored slice `index` of a live note (in order, or an idempotent
        re-PUT): tell the decoder."""
        note = self._note_for(att_id)
        note.slice_stored(index, size)
        self._ensure_decoder(note)

    def set_state(self, att_id: str, state: Literal["recording", "paused"]) -> None:
        note = self.notes.get(att_id)
        if note is not None:
            note.set_state(state)
            self._wake_all()

    def _ensure_decoder(self, note: LiveNote) -> None:
        if note.decoder_running or note.decoder_dead or note.deleted or self.ffmpeg is None:
            return
        if note.state == "ended" or (note.slice_count == 0 and note.closed_total is None):
            return
        if self._spawn(self._live_decoder, note):
            note.decoder_running = True

    async def _live_decoder(self, note: LiveNote) -> None:
        ffmpeg = self.ffmpeg
        assert ffmpeg is not None
        restarts = 0
        try:
            with note.scope:
                while True:
                    decoder = Decoder(
                        note,
                        ffmpeg=ffmpeg,
                        start_frame=note.ring_end,
                        on_frame=self._live_frame(note),
                        clock=self.clock,
                        stall_s=self.stall_s,
                        poll_s=self.decoder_poll_s,
                    )
                    result = await decoder.run()
                    if result.failure is None:
                        note.total_samples = result.total_samples
                        return
                    restarts += 1
                    # Ids and the failure class only: never audio, never content.
                    _LOGGER.warning(
                        "live voice: decoder for %s failed (%s), attempt %d",
                        note.att_id,
                        result.failure,
                        restarts,
                    )
                    if result.failure in ("unsupported", "media_unavailable") or (
                        restarts > MAX_RESTARTS
                    ):
                        note.decoder_dead = True
                        self._wake_all()
                        return
                    await anyio.sleep(min(2.0, 0.25 * restarts))
        finally:
            note.decoder_running = False
            note.decoder_done.set()
            self._wake_all()

    @staticmethod
    def _live_frame(note: LiveNote) -> FrameSink:
        async def deliver(index: int, pcm: bytes) -> None:
            note.add_live_frame(index, pcm)

        return deliver

    def _wake_streams(self) -> None:
        for listener in self.listeners.values():
            if listener.stream is not None:
                listener.wake.set()

    def _wake_all(self) -> None:
        for listener in self.listeners.values():
            listener.wake.set()

    # -- ending a note --------------------------------------------------------------------------

    async def finish(self, att_id: str, *, chunk_count: int | None) -> AttachmentRow:
        """Complete a live note (the sender's `complete`, an auto-end, or startup recovery): join
        the slices, turn `live` into `processing` (the queue held off by a lease), let the decoder
        drain and the listeners get their `eof`. Raises what `uploads.assemble` raises."""
        note = self.notes.get(att_id)
        if note is not None:
            note.finishing = True
        store, paths = self.store, self.paths

        def _assemble() -> AttachmentRow:
            return uploads.assemble(
                store=store,
                paths=paths,
                upload_id=att_id,
                chunk_bytes=self.chunk_bytes,
                now=time.time(),
                chunk_count=chunk_count,
            )

        try:
            attachment = await anyio.to_thread.run_sync(_assemble)
        except BaseException:
            if note is not None:
                note.finishing = False
            raise
        if note is None:
            await anyio.to_thread.run_sync(
                lambda: store.release_lease(att_id, owner=uploads.LIVE_DRAIN_LEASE_OWNER)
            )
            clear_live_tail(att_id)
            return attachment
        note.close(chunk_count if chunk_count is not None else note.slice_count)
        self._ensure_decoder(note)
        if not self._spawn(self._drain, note):
            note.state = "ended"
            note.ended_at = self.clock()
            note.ended.set()
            await anyio.to_thread.run_sync(
                lambda: store.release_lease(att_id, owner=uploads.LIVE_DRAIN_LEASE_OWNER)
            )
        return attachment

    async def _drain(self, note: LiveNote) -> None:
        """Wait for the decoder to consume the last slices, keeping the queue held off, then mark
        the note ended."""
        store = self.store
        owner = uploads.LIVE_DRAIN_LEASE_OWNER
        if not note.decoder_running and not note.decoder_done.is_set():
            note.decoder_done.set()  # nothing was ever decoded (no decoder to wait for)
        while not note.decoder_done.is_set():
            with anyio.move_on_after(15.0):
                await note.decoder_done.wait()
            if not note.decoder_done.is_set():
                await anyio.to_thread.run_sync(
                    lambda: store.renew_lease(
                        att_id=note.att_id,
                        owner=owner,
                        now=time.time(),
                        lease_s=uploads.LIVE_DRAIN_LEASE_S,
                    )
                )
        note.peaks.flush()
        if note.total_samples is None:
            note.total_samples = note.ring_end * SAMPLES
        note.state = "ended"
        note.ended_at = self.clock()
        note.ended.set()
        self._wake_all()
        await anyio.to_thread.run_sync(lambda: store.release_lease(note.att_id, owner=owner))
        self.notifier.publish()

    async def end_empty_or_finish(self, att_id: str) -> None:
        """Auto-end / startup recovery: complete with whatever slices arrived; a note that never
        stored one has nothing to process and is marked failed."""
        self.server_ended[att_id] = None
        while len(self.server_ended) > MAX_SERVER_ENDED:
            del self.server_ended[next(iter(self.server_ended))]
        try:
            await self.finish(att_id, chunk_count=None)
        except uploads.IncompleteUploadError:
            failed = await anyio.to_thread.run_sync(
                lambda: self.store.fail_live_attachment(
                    att_id, failure="empty_recording", now=time.time()
                )
            )
            if failed:
                self.notifier.publish()
            self._forget(att_id, announce_end=True)
        except uploads.UnknownUploadError:
            self._forget(att_id, announce_end=True)
        else:
            self.notifier.publish()

    async def recover(self) -> int:
        """Startup: a note left `live` belongs to a recording whose server died. End it and let
        the normal pipeline process what was stored. Returns how many were recovered."""
        att_ids = await anyio.to_thread.run_sync(self.store.live_attachment_ids)
        for att_id in att_ids:
            try:
                await self.end_empty_or_finish(att_id)
            except Exception:
                _LOGGER.exception("live voice: could not recover %s", att_id)
        return len(att_ids)

    # -- deletion ---------------------------------------------------------------------------------

    def deleted(self, att_ids: list[str]) -> None:
        """Message(s) deleted or the chat wiped: end the decoders, tell every listener the note is
        over and drop it. Never raises."""
        for att_id in att_ids:
            self._forget(att_id, announce_end=True)

    def _forget(self, att_id: str, *, announce_end: bool) -> None:
        clear_live_tail(att_id)
        note = self.notes.pop(att_id, None)
        if note is None:
            return
        note.deleted = True
        note.scope.cancel()
        note.state = "ended"
        note.ended_at = self.clock()
        note.ended.set()
        note.decoder_done.set()
        for listener in list(self.listeners.values()):
            watched = listener.watches.pop(att_id, None)
            if watched is not None and announce_end:
                self._emit(
                    listener,
                    {
                        "type": "state",
                        "attachmentId": att_id,
                        "state": "ended",
                        "durationMs": note.duration_ms,
                        "peaksFrom": watched.sent_peaks,
                        "peaks": [*note.peaks.peaks[watched.sent_peaks :]],
                    },
                )
            stream = listener.stream
            if stream is not None and stream.att_id == att_id:
                self._stop_stream(listener)
        self._wake_all()

    # -- the once-a-second rules ---------------------------------------------------------

    async def tick(self) -> None:
        """Auto-end rules (spec §2), the ended-note sweep, and a backstop that notices a note
        deleted by a process this hub never heard from."""
        now = self.clock()
        self._ticks += 1
        for note in list(self.notes.values()):
            if note.state == "ended" and note.ended_at is not None:
                if now - note.ended_at >= ENDED_KEEP_S:
                    self.notes.pop(note.att_id, None)
                continue
            if note.finishing or note.closed_total is not None:
                continue
            if (note.state == "recording" and now - note.last_activity >= NO_SLICE_END_S) or (
                note.state == "paused"
                and note.paused_at is not None
                and now - note.paused_at >= PAUSED_END_S
            ):
                _LOGGER.info("live voice: auto-ending %s", note.att_id)
                await self.end_empty_or_finish(note.att_id)
        if self._ticks % _DB_BACKSTOP_TICKS == 0 and self.notes:
            live_ids = set(await anyio.to_thread.run_sync(self.store.live_attachment_ids))
            for note in list(self.notes.values()):
                if note.state != "ended" and not note.finishing and note.att_id not in live_ids:
                    still_there = await anyio.to_thread.run_sync(
                        self.store.get_attachment, note.att_id
                    )
                    if still_there is None:
                        self._forget(note.att_id, announce_end=True)

    # -- listeners -----------------------------------------------------------------------

    def add_listener(self, listener: Listener) -> bool:
        if self.closed or len(self.listeners) >= MAX_LISTENERS:
            return False
        now = time.monotonic()
        email = listener.auth.email
        if email not in self.admissions:
            if len(self.admissions) >= 128:
                expired = [k for k, v in self.admissions.items() if now - v.at > 60]
                for key in expired:
                    del self.admissions[key]
                if len(self.admissions) >= 128:
                    return False
            self.admissions[email] = Budget(0.2, 4)
        if not self.admissions[email].take(now):
            return False
        self.listeners[listener.id] = listener
        self._emit(listener, {"type": "ready"})
        return not listener.closed

    def remove_listener(self, listener: Listener) -> None:
        listener.closed = True
        self._stop_stream(listener)
        self.listeners.pop(listener.id, None)
        listener.watches.clear()
        listener.controls.clear()
        listener.wake.set()

    def permitted(self, listener: Listener) -> bool:
        return (
            not listener.closed
            and self.listeners.get(listener.id) is listener
            and time.time() < listener.deadline
            and time.monotonic() < listener.grant_until
        )

    def _emit(self, listener: Listener, message: JsonObject) -> None:
        if listener.closed:
            return
        if len(listener.controls) >= CONTROL_QUEUE_LIMIT:
            # A client that does not read is dropped, never buffered without bound.
            self.remove_listener(listener)
            return
        listener.controls.append(message)
        listener.wake.set()

    def _error(self, listener: Listener, code: protocol.ErrorCode, att_id: str | None) -> None:
        message: JsonObject = {"type": "error", "code": code}
        if att_id is not None:
            message["attachmentId"] = att_id
        self._emit(listener, message)

    def report_bad_request(self, listener: Listener) -> None:
        """A control message that is not strict JSON of a known shape: answered, and a socket that
        keeps sending them is dropped."""
        listener.bad_requests += 1
        if listener.bad_requests > MAX_BAD_REQUESTS:
            raise ValueError("too many bad requests")
        self._error(listener, "bad_request", None)

    def tick_listener(self, listener: Listener) -> None:
        now = time.monotonic()
        if not self.permitted(listener) or now - listener.pong_at > 6:
            self.remove_listener(listener)
            return
        if listener.ping_ticks % 20 == 0:
            self._emit(listener, {"type": "ping"})
        listener.ping_ticks += 1
        listener.wake.set()  # re-evaluate the once-a-second state cadence

    async def command(self, listener: Listener, command: protocol.ClientCommand) -> None:
        now = time.monotonic()
        if not self.permitted(listener) or not listener.controls_budget.take(now):
            raise ValueError("control budget")
        if isinstance(command, protocol.Pong):
            listener.pong_at = now
            return
        att_id = command.attachmentId
        if isinstance(command, protocol.Unwatch):
            listener.watches.pop(att_id, None)
            if listener.stream is not None and listener.stream.att_id == att_id:
                self._stop_stream(listener)
            return
        if isinstance(command, protocol.Stop):
            if listener.stream is not None and listener.stream.att_id == att_id:
                self._stop_stream(listener)
            return
        if isinstance(command, protocol.Credit):
            stream = listener.stream
            if stream is not None and stream.att_id == att_id:
                stream.credit = min(protocol.MAX_OUTSTANDING_CREDIT, stream.credit + command.frames)
                listener.wake.set()
            return
        # watch / play need the attachment to be a sent, live voice note.
        attachment = await anyio.to_thread.run_sync(self.store.get_attachment, att_id)
        if attachment is None:
            self._error(listener, "not_found", att_id)
            return
        if attachment.kind != "voice" or attachment.message_seq is None:
            # Unsent audio is not shared (the message does not exist for anyone else yet).
            self._error(listener, "forbidden", att_id)
            return
        if attachment.live_state is None:
            self._error(listener, "not_live", att_id)
            return
        note = self.notes.get(att_id) or self.begin(attachment)
        if listener.closed:
            return
        if isinstance(command, protocol.Watch):
            if att_id not in listener.watches:
                listener.watches[att_id] = _Watched()
            listener.wake.set()
            return
        self._play(listener, note, command)

    def _play(self, listener: Listener, note: LiveNote, command: protocol.Play) -> None:
        att_id = note.att_id
        busy = sum(
            1
            for other in self.listeners.values()
            if other is not listener and other.stream is not None and other.stream.att_id == att_id
        )
        if busy >= MAX_STREAMS_PER_NOTE:
            self._error(listener, "too_many_listeners", att_id)
            return
        self._stop_stream(listener)
        if att_id not in listener.watches:
            listener.watches[att_id] = _Watched()
        edge = note.ring_end * SAMPLES
        if command.start == "live":
            start = edge
        elif command.start == "start":
            start = 0
        else:
            start = min(edge, (command.start // SAMPLES) * SAMPLES)
        stream = _Stream(att_id=att_id, next_sample=start, mode="ring")
        listener.stream = stream
        if start // SAMPLES < note.ring_start:
            self._start_backfill(listener, note, stream)
        listener.wake.set()

    def _stop_stream(self, listener: Listener) -> None:
        stream = listener.stream
        listener.stream = None
        if stream is None:
            return
        if stream.scope is not None:
            stream.scope.cancel()
        stream.recv = None

    def _start_backfill(self, listener: Listener, note: LiveNote, stream: _Stream) -> None:
        ffmpeg = self.ffmpeg
        if ffmpeg is None or note.decoder_dead:
            self._error(listener, "not_live", note.att_id)
            listener.stream = None
            return
        send, recv = anyio.create_memory_object_stream[tuple[int, bytes]](BACKFILL_BUFFER_FRAMES)
        stream.mode = "backfill"
        stream.recv = recv
        stream.failure = None
        stream.scope = anyio.CancelScope()
        started = self._spawn(self._backfill, listener, note, stream, send)
        if not started:
            self._error(listener, "not_live", note.att_id)
            listener.stream = None

    async def _backfill(
        self,
        listener: Listener,
        note: LiveNote,
        stream: _Stream,
        send: MemoryObjectSendStream[tuple[int, bytes]],
    ) -> None:
        assert self.ffmpeg is not None
        scope = stream.scope
        assert scope is not None

        async def put(index: int, pcm: bytes) -> None:
            await send.send((index, pcm))
            listener.wake.set()

        with scope:
            async with send:
                decoder = Decoder(
                    note,
                    ffmpeg=self.ffmpeg,
                    start_frame=stream.next_sample // SAMPLES,
                    on_frame=put,
                    clock=self.clock,
                    stall_s=self.stall_s,
                    poll_s=self.decoder_poll_s,
                )
                result = await decoder.run()
                stream.failure = result.failure
        listener.wake.set()

    # -- what the writer sends -----------------------------------------------------------

    def next_message(self, listener: Listener) -> JsonObject | bytes | None:
        """The next message for this listener's socket, or `None` when there is nothing to send
        right now: a queued control, then a due state message, then (credit permitting) one audio
        frame."""
        if listener.controls:
            return listener.controls.popleft()
        state = self._due_state(listener)
        if state is not None:
            return state
        return self._next_audio(listener)

    def _due_state(self, listener: Listener) -> JsonObject | None:
        now = self.clock()
        for att_id, watched in list(listener.watches.items()):
            note = self.notes.get(att_id)
            if note is None:
                listener.watches.pop(att_id, None)
                continue
            state = note.state
            peaks = note.peaks.peaks
            duration_ms = note.duration_ms
            first = watched.sent_state is None
            state_changed = state != watched.sent_state
            data_changed = (
                len(peaks) > watched.sent_peaks or duration_ms != watched.sent_duration_ms
            )
            if not (
                first
                or state_changed
                or (data_changed and now - watched.last_sent >= STATE_INTERVAL_S)
            ):
                continue
            message: JsonObject = {
                "type": "state",
                "attachmentId": att_id,
                "state": state,
                "durationMs": duration_ms,
                "peaksFrom": watched.sent_peaks,
                "peaks": list(peaks[watched.sent_peaks :]),
            }
            watched.sent_peaks = len(peaks)
            watched.sent_duration_ms = duration_ms
            watched.sent_state = state
            watched.last_sent = now
            if state == "ended":
                listener.watches.pop(att_id, None)
            return message
        return None

    def _next_audio(self, listener: Listener) -> JsonObject | bytes | None:
        stream = listener.stream
        if stream is None:
            return None
        note = self.notes.get(stream.att_id)
        if note is None:
            self._stop_stream(listener)
            return None
        frame_index = stream.next_sample // SAMPLES
        # Hand between the ring and the stored slices as the listener's position requires.
        if stream.mode == "backfill" and frame_index >= note.ring_start and not note.decoder_dead:
            self._leave_backfill(stream)
        if stream.mode == "ring" and frame_index < note.ring_start:
            if stream.credit <= 0:
                return None
            self._start_backfill(listener, note, stream)
            if listener.stream is None:
                return None
        pcm: bytes | None
        if stream.mode == "ring":
            pcm = note.frame(frame_index)
            if pcm is None:
                return self._ring_wait(listener, note)
            if stream.credit <= 0:
                return None
        else:
            recv = stream.recv
            assert recv is not None
            stats = recv.statistics()
            if stats.current_buffer_used == 0 and stats.open_send_streams == 0:
                return self._backfill_end(listener, note, stream)
            if stream.credit <= 0:
                return None
            try:
                index, pcm = recv.receive_nowait()
            except anyio.WouldBlock:
                return None
            except anyio.EndOfStream:
                return self._backfill_end(listener, note, stream)
            if index != frame_index:  # cannot happen: the decoder delivers in order from here
                self._stop_stream(listener)
                return {"type": "error", "attachmentId": note.att_id, "code": "not_live"}
        message = protocol.pack_frame(
            stream.att_id, seq=stream.seq, sample=stream.next_sample, pcm=pcm
        )
        stream.seq += 1
        stream.next_sample += SAMPLES
        stream.credit -= 1
        return message

    def _leave_backfill(self, stream: _Stream) -> None:
        if stream.scope is not None:
            stream.scope.cancel()
        stream.scope = None
        stream.recv = None
        stream.mode = "ring"

    def _ring_wait(self, listener: Listener, note: LiveNote) -> JsonObject | None:
        """The listener has consumed everything the ring holds. Wait for more, or, when the note is
        over (or its decoder is dead), say so."""
        if note.state == "ended" and note.total_samples is not None:
            self._stop_stream(listener)
            return {
                "type": "eof",
                "attachmentId": note.att_id,
                "sampleIndex": note.total_samples,
            }
        if note.decoder_dead:
            self._stop_stream(listener)
            return {"type": "error", "attachmentId": note.att_id, "code": "not_live"}
        return None

    def _backfill_end(self, listener: Listener, note: LiveNote, stream: _Stream) -> JsonObject:
        failure = stream.failure
        self._stop_stream(listener)
        if failure is not None:
            # The stored slices are gone (the finished note replaced them) or undecodable: the
            # client switches to the finished file.
            return {"type": "error", "attachmentId": note.att_id, "code": "not_live"}
        total = note.total_samples if note.total_samples is not None else stream.next_sample
        return {"type": "eof", "attachmentId": note.att_id, "sampleIndex": total}
