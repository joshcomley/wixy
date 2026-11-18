"""Live transcription of a voice note while it is being recorded
(spec/server-chat/07-live-voice-notes.md §3, Inv 50 and Inv 58).

Started only by the existing `POST /attachments/{id}/transcribe` on a `live` note. Every ~8 s of new
audio it transcribes the window from the last FINALISED point to the live edge (never more than
90 s) through cmd's private mode exactly as every other transcription does (one at a time, cmd
asked afresh before audio leaves, a temporary private file deleted after): the text up to the last
sentence end is finalised and appended to the transcript row; the rest is the provisional tail,
replaced on the next pass and kept only in memory. When the note ends, one full-note pass (spec 06's
stretches, `TranscriptionRuntime.run_job`) replaces the live text with the normal `done` transcript.

The live text is best effort (the final pass is authoritative): audio is kept in a bounded
in-memory window (`ACCUMULATOR_CAP_S`), and a window that cannot be sent in time is dropped from
the live text rather than grown without bound. Nothing here ever logs transcript text.
"""

from __future__ import annotations

import array
import io
import logging
import re
import shutil
import time
import uuid
import wave
from collections import deque
from typing import Final

import anyio

from wixy_server.livechat.live_voice import (
    FRAMES_PER_SECOND,
    RATE,
    Decoder,
    LiveNote,
    LiveVoiceHub,
    Notify,
)
from wixy_server.livechat.models import clear_live_tail, set_live_tail
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.transcription import (
    TRANSCRIBE_TMP_DIRNAME,
    JobResult,
    TranscriptionRuntime,
)

_LOGGER = logging.getLogger(__name__)

STEP_S: Final = 8.0
"""A pass runs after this much NEW audio (the first one as soon as a second of it exists)."""
WINDOW_MAX_S: Final = 90.0
ACCUMULATOR_CAP_S: Final = 300.0
MAX_CONSECUTIVE_FAILURES: Final = 3
RETRY_DELAY_S: Final = 2.0
HANDOFF_POLL_S: Final = 1.0
LIVE_FILENAME: Final = "live.wav"
LIVE_CONTENT_TYPE: Final = "audio/wav"
_QUIET_RADIUS_FRAMES: Final = 3 * FRAMES_PER_SECOND
_SENTENCE_END = re.compile(r"[.!?…]+[\"'”’)\]]*(?=\s|$)")


def split_sentences(text: str) -> tuple[str, str]:
    """`(finalised, tail)`: the text up to the LAST sentence end (`.?!` — with any closing quote or
    bracket — followed by whitespace or the end of the text), and the rest. No sentence end means
    nothing is finalised."""
    last: re.Match[str] | None = None
    for match in _SENTENCE_END.finditer(text):
        last = match
    if last is None:
        return "", text.strip()
    return text[: last.end()].strip(), text[last.end() :].strip()


def wav_bytes(pcm: bytes) -> bytes:
    """24 kHz mono s16le PCM as a WAV file."""
    out = io.BytesIO()
    with wave.open(out, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(RATE)
        writer.writeframes(pcm)
    return out.getvalue()


def _frame_energy(pcm: bytes) -> int:
    samples = array.array("h")
    samples.frombytes(pcm)
    return sum(s * s for s in samples)


class Accumulator:
    """The PCM window a live transcription works on: consecutive 20 ms frames from `start` up to
    (not including) `end`, bounded to `cap_frames` (the oldest are dropped)."""

    def __init__(self, *, start: int, cap_frames: int) -> None:
        self.start = start
        self.end = start
        self.cap_frames = cap_frames
        self._frames: deque[bytes] = deque()
        self.changed = Notify()

    def add(self, index: int, pcm: bytes) -> None:
        if index != self.end:
            return  # a duplicate (a restarted decoder re-delivering) or a gap: never splice
        self._frames.append(pcm)
        self.end = index + 1
        if len(self._frames) > self.cap_frames:
            self._frames.popleft()
            self.start += 1
        self.changed.notify()

    def advance(self, new_start: int) -> None:
        """Drop everything before `new_start` (it has been finalised)."""
        new_start = max(self.start, min(new_start, self.end))
        for _ in range(new_start - self.start):
            self._frames.popleft()
        self.start = new_start

    def pcm(self, start: int, end: int) -> bytes:
        return b"".join(
            self._frames[i - self.start] for i in range(max(start, self.start), min(end, self.end))
        )

    def quietest_frame(self, around: int, low: int, high: int) -> int:
        """The frame index in `[low, high)` within a few seconds of `around` whose 20 ms of audio
        is the quietest: the best place to cut speech whose exact end the engine did not report."""
        lo = max(low, self.start, around - _QUIET_RADIUS_FRAMES)
        hi = min(high, self.end, around + _QUIET_RADIUS_FRAMES)
        if hi <= lo:
            return min(max(around, low), high)
        return min(range(lo, hi), key=lambda i: _frame_energy(self._frames[i - self.start]))


class LiveTranscriber:
    """Runs the live transcription loops. One per app; one loop per live note being transcribed."""

    def __init__(
        self,
        *,
        hub: LiveVoiceHub,
        store: LiveChatStore,
        runtime: TranscriptionRuntime,
        notifier: LiveChatNotifier,
        step_s: float = STEP_S,
        window_max_s: float = WINDOW_MAX_S,
        accumulator_cap_s: float = ACCUMULATOR_CAP_S,
    ) -> None:
        self.hub = hub
        self.store = store
        self.runtime = runtime
        self.notifier = notifier
        self.step_frames = int(step_s * FRAMES_PER_SECOND)
        self.window_max_frames = int(window_max_s * FRAMES_PER_SECOND)
        self.cap_frames = int(accumulator_cap_s * FRAMES_PER_SECOND)
        self.active: set[str] = set()

    def start(self, att_id: str) -> bool:
        """Begin live transcription of `att_id` (the transcript row is already `pending`).
        `False` when one is already running for it."""
        if att_id in self.active:
            return False
        self.active.add(att_id)
        try:
            self.hub.spawn_task(self._run, att_id)
        except BaseException:
            self.active.discard(att_id)
            raise
        return True

    async def _run(self, att_id: str) -> None:
        try:
            await self._loop(att_id)
        finally:
            self.active.discard(att_id)
            clear_live_tail(att_id)

    # -- the loop ----------------------------------------------------------------------------------

    async def _loop(self, att_id: str) -> None:
        note = self.hub.notes.get(att_id)
        if note is None:
            return
        state = _PassState()
        current = await anyio.to_thread.run_sync(self.store.get_attachment, att_id)
        if current is not None and current.transcript is not None and current.transcript.text:
            # A restart after a failed live transcript starts over from the first second: the text
            # the earlier run finalised would otherwise be said twice.
            await anyio.to_thread.run_sync(
                lambda: self.store.record_live_transcript(att_id, text="", now=time.time())
            )
        acc = await self._catch_up(note)
        if acc is None:
            await self._fail(att_id, "error")
            return
        tap_acc = acc

        def tap(index: int, pcm: bytes) -> None:
            tap_acc.add(index, pcm)

        # Frames the live decoder produced while the catch-up ran were queued by the early tap.
        note.taps.append(tap)
        try:
            while not note.deleted:
                if note.ended.is_set():
                    break
                window = acc.end - acc.start
                fresh = acc.end - state.last_pass_end
                if fresh < self.step_frames and not (state.first and window >= FRAMES_PER_SECOND):
                    event = acc.changed.event()
                    with anyio.move_on_after(1.0):
                        await event.wait()
                    continue
                outcome = await self._pass(att_id, acc, state)
                if outcome == "stop":
                    return
        finally:
            if tap in note.taps:
                note.taps.remove(tap)
        if note.deleted:
            return
        await self._handoff(att_id)

    async def _catch_up(self, note: LiveNote) -> Accumulator | None:
        """Fill an accumulator with the audio already decoded (the last `cap` of it) while the
        live decoder keeps delivering new frames, which are queued from the same instant and
        spliced on when the catch-up reaches them."""
        edge = note.ring_end
        start = max(0, edge - self.cap_frames)
        acc = Accumulator(start=start, cap_frames=self.cap_frames)
        queued: list[tuple[int, bytes]] = []
        catching = True

        def early_tap(index: int, pcm: bytes) -> None:
            if catching and index >= edge:
                queued.append((index, pcm))

        note.taps.append(early_tap)
        try:
            if edge > start and self.hub.ffmpeg is not None:
                with anyio.CancelScope() as scope:

                    async def sink(index: int, pcm: bytes) -> None:
                        if index >= edge:
                            scope.cancel()
                            return
                        acc.add(index, pcm)
                        if index == edge - 1:
                            scope.cancel()

                    decoder = Decoder(
                        note,
                        ffmpeg=self.hub.ffmpeg,
                        start_frame=start,
                        on_frame=sink,
                        clock=self.hub.clock,
                        stall_s=self.hub.stall_s,
                        poll_s=self.hub.decoder_poll_s,
                    )
                    result = await decoder.run()
                    if result.failure is not None and acc.end < edge:
                        return None
            elif edge > start:
                return None
            catching = False
            for index, pcm in queued:
                acc.add(index, pcm)
        finally:
            catching = False
            if early_tap in note.taps:
                note.taps.remove(early_tap)
        return acc

    async def _pass(self, att_id: str, acc: Accumulator, state: _PassState) -> str:
        end = min(acc.end, acc.start + self.window_max_frames)
        window = end - acc.start
        pcm = acc.pcm(acc.start, end)
        state.first = False
        state.last_pass_end = end
        result = await self._transcribe(pcm)
        if result is None or result.status != "done":
            state.failures += 1
            if state.failures >= MAX_CONSECUTIVE_FAILURES:
                await self._fail(att_id, result.failure if result is not None else "error")
                return "stop"
            state.last_pass_end = acc.start  # try this window again, after a short pause
            await anyio.sleep(RETRY_DELAY_S)
            return "retry"
        state.failures = 0
        text = (result.text or "").strip()
        final_part, tail = split_sentences(text)
        advance_to = acc.start
        if final_part:
            if not tail:
                advance_to = end
            else:
                # The engine gave no timestamps: place the cut by how much of the text is
                # finalised, then settle it on the quietest moment near there.
                guess = acc.start + int(window * len(final_part) / max(1, len(text)))
                advance_to = acc.quietest_frame(guess, acc.start + 1, end)
        elif window >= self.window_max_frames:
            # 90 s with no sentence end (or no speech at all): the engine gives no segment ends, so
            # everything in the window is finalised and the next window starts after it.
            final_part, tail, advance_to = text, "", end
        changed = False
        if final_part:
            state.final = f"{state.final} {final_part}".strip()
            changed = True
        if advance_to > acc.start:
            acc.advance(advance_to)
        if tail != state.tail:
            state.tail = tail
            changed = True
        set_live_tail(att_id, state.tail)
        if changed:
            stored = await anyio.to_thread.run_sync(
                lambda: self.store.record_live_transcript(att_id, text=state.final, now=time.time())
            )
            if not stored:
                return "stop"  # the note was deleted, or the transcript is no longer pending
            self.notifier.publish()
        return "ok"

    async def _transcribe(self, pcm: bytes) -> JobResult | None:
        """One window through cmd's private mode: a temporary private file in the server's own
        storage (written, read back, deleted), never the plain route (Inv 50)."""
        if not pcm:
            return None
        work = self.hub.paths.server_dir / TRANSCRIBE_TMP_DIRNAME / uuid.uuid4().hex
        wav = wav_bytes(pcm)

        def _stage() -> bytes:
            work.mkdir(parents=True, exist_ok=True)
            target = work / LIVE_FILENAME
            target.write_bytes(wav)
            try:
                return target.read_bytes()
            finally:
                target.unlink(missing_ok=True)

        try:
            audio = await anyio.to_thread.run_sync(_stage)
            return await self.runtime.transcribe_audio(
                audio=audio,
                filename=LIVE_FILENAME,
                content_type=LIVE_CONTENT_TYPE,
                duration_s=len(pcm) / (RATE * 2),
            )
        finally:
            # Synchronous on purpose: a cancelled loop must still clean up.
            shutil.rmtree(work, ignore_errors=True)

    async def _fail(self, att_id: str, failure: str | None) -> None:
        stored = await anyio.to_thread.run_sync(
            lambda: self.store.finish_transcript(
                att_id=att_id,
                status="failed",
                text=None,
                failure=failure or "error",
                engine=None,
                now=time.time(),
                only_if_pending=True,
            )
        )
        clear_live_tail(att_id)
        if stored:
            self.notifier.publish()

    async def _handoff(self, att_id: str) -> None:
        """The note ended: wait until the finished file is ready, then run the one full-note pass
        (spec 06's stretches) that replaces the live text with the stored `done` transcript."""
        clear_live_tail(att_id)
        while True:
            attachment = await anyio.to_thread.run_sync(self.store.get_attachment, att_id)
            if attachment is None:
                return
            if attachment.status == "ready":
                break
            if attachment.status == "failed":
                await self._fail(att_id, "media_failed")
                return
            await anyio.sleep(HANDOFF_POLL_S)
        begin = await anyio.to_thread.run_sync(
            lambda: self.store.begin_transcript(
                att_id=att_id, now=time.time(), restart_pending=True
            )
        )
        if begin.state != "started":
            return
        self.runtime.inflight.add(att_id)
        self.notifier.publish()
        await self.runtime.run_job(att_id)


class _PassState:
    def __init__(self) -> None:
        self.final = ""
        self.tail = ""
        self.failures = 0
        self.first = True
        self.last_pass_end = 0
