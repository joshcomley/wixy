"""Voice-note transcription jobs (spec/server-chat/05-voice-transcription.md).

`routes_livechat.py`'s `POST /attachments/{id}/transcribe` answers immediately (Cloudflare cuts
a proxied response at 100 s, and a long note on the CPU engine can take longer): it upserts a
`pending` row through `LiveChatStore.begin_transcript` and hands `TranscriptionRuntime.run_job`
to the contained background group (Inv 47). The job reads the already-processed voice rendition,
sends it to cmd through a `Transcriber` (private mode only), and records the outcome, which
appends the existing `message_updated` event so every device renders it from the stream.

Concurrency limits, all in-process (a blue/green overlap doubles them briefly, which is fine):
- single-flight per attachment — `inflight` plus the store's atomic `pending` row;
- a global one job in flight — a `CapacityLimiter(1)`; further jobs wait, their rows `pending`;
- 6 new jobs a minute per identity — `SlidingWindowRateLimiter`.

The transcript is message-derived private content: it is stored only in the attachment's
`attachment_transcripts` row (erased with its message by `ON DELETE CASCADE`), and no line in this
module ever formats it.
"""

from __future__ import annotations

import logging
import math
import shutil
import time
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

import anyio
from anyio import CapacityLimiter

from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.processing import (
    VOICE_DURATION_CAP_S,
    MediaProcessingError,
    cut_voice_stretch,
)
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.transcribe import Transcriber, TranscribeResult
from wixy_server.storage import ProjectPaths

_LOGGER = logging.getLogger(__name__)

VOICE_RENDITION_FILENAME: Final = "play.m4a"
VOICE_CONTENT_TYPE: Final = "audio/mp4"
BASE_TIMEOUT_S: Final = 60.0
TIMEOUT_PER_AUDIO_SECOND_S: Final = 0.5
RATE_LIMIT_MAX_JOBS: Final = 6
RATE_LIMIT_WINDOW_S: Final = 60.0
_DURATION_TOLERANCE_S: Final = 0.5
TRANSCRIBE_STRETCH_S = 15 * 60.0
"""The longest audio one request to cmd carries (spec/server-chat/06 §2.4). A note longer than
this is transcribed in consecutive stretches of at most this long, each through the same
private-mode call. A module attribute (not `Final`) so a test can shrink it."""
TRANSCRIBE_TMP_DIRNAME: Final = "transcribe-tmp"
"""Under the server's private storage (`ProjectPaths.server_dir`): the stretch files of a job in
flight. Each job's files are deleted when it ends, however it ends, and the whole directory is
emptied at startup (no job can be in flight in a process that has only just started)."""


@dataclass(frozen=True, slots=True)
class Stretch:
    start_s: float
    length_s: float | None
    """`None`: to the end of the note."""


def plan_stretches(duration_s: float, *, stretch_s: float | None = None) -> list[Stretch]:
    """Cut a note into consecutive stretches of at most `stretch_s` (default
    `TRANSCRIBE_STRETCH_S`). A note within one stretch (plus the usual half-second duration
    tolerance) is a single stretch. Otherwise every stretch but the last is exactly `stretch_s`
    and the last runs to the end of the note, so nothing is dropped to rounding and no sliver is
    sent on its own."""
    limit = TRANSCRIBE_STRETCH_S if stretch_s is None else stretch_s
    if duration_s <= limit + _DURATION_TOLERANCE_S:
        return [Stretch(0.0, None)]
    count = max(1, math.ceil((duration_s - _DURATION_TOLERANCE_S) / limit))
    return [Stretch(index * limit, limit if index < count - 1 else None) for index in range(count)]


_FAILURE_BY_OUTCOME: Final[dict[str, str]] = {
    "warming": "warming",
    "timeout": "timeout",
    "unavailable": "unavailable",
    "rejected": "rejected",
    "invalid": "invalid_response",
}


def transcribe_timeout_s(duration_s: float | None) -> float:
    """cmd's whole-request budget: 60 s plus half the audio's length — a 15-minute stretch on the
    CPU engine cannot finish in a flat 60 s. A longer note is sent in stretches of at most
    `TRANSCRIBE_STRETCH_S`, so the budget is per request and never grows past that stretch's."""
    bounded = min(max(duration_s or 0.0, 0.0), TRANSCRIBE_STRETCH_S)
    return BASE_TIMEOUT_S + TIMEOUT_PER_AUDIO_SECOND_S * bounded


class SlidingWindowRateLimiter:
    """At most `max_events` per `window_s` per key. `hit` records an event and returns `None`,
    or refuses and returns the seconds until the oldest event leaves the window."""

    def __init__(
        self,
        *,
        max_events: int = RATE_LIMIT_MAX_JOBS,
        window_s: float = RATE_LIMIT_WINDOW_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_events = max_events
        self._window_s = window_s
        self._clock = clock
        self._events: dict[str, deque[float]] = {}
        self._last_sweep = clock()

    @property
    def tracked_key_count(self) -> int:
        """How many keys the table holds right now (a size probe: it must stay bounded by the
        keys active within one window)."""
        return len(self._events)

    def _sweep_idle_keys(self, now: float) -> None:
        """Drops every key whose newest event has left the window: such a key is
        indistinguishable from one never seen, so this cannot change any answer, and the table
        stays bounded by the keys active within one window rather than every key ever hit.
        Run at most once per window, so the O(keys) walk is amortised over the hits."""
        self._last_sweep = now
        idle = [
            key
            for key, events in self._events.items()
            if not events or now - events[-1] >= self._window_s
        ]
        for key in idle:
            del self._events[key]

    def hit(self, key: str) -> float | None:
        now = self._clock()
        if now - self._last_sweep >= self._window_s:
            self._sweep_idle_keys(now)
        events = self._events.setdefault(key, deque())
        while events and now - events[0] >= self._window_s:
            events.popleft()
        if len(events) >= self._max_events:
            return max(0.0, self._window_s - (now - events[0]))
        events.append(now)
        return None


@dataclass(frozen=True, slots=True)
class JobResult:
    status: Literal["done", "failed"]
    text: str | None = None
    failure: str | None = None
    engine: str | None = None


class TranscriptionRuntime:
    """Owns everything a transcription needs that is not in the database. `transcriber` is
    `None` on the standalone edition (no cmd there): the feature is then always unavailable."""

    def __init__(
        self,
        *,
        store: LiveChatStore,
        paths: ProjectPaths,
        notifier: LiveChatNotifier,
        transcriber: Transcriber | None,
        rate_limiter: SlidingWindowRateLimiter | None = None,
        ffmpeg: str | None = None,
    ) -> None:
        self.store = store
        self.paths = paths
        self.notifier = notifier
        self.transcriber = transcriber
        self.rate_limiter = rate_limiter if rate_limiter is not None else SlidingWindowRateLimiter()
        self.ffmpeg = ffmpeg
        """The ffmpeg binary that cuts a long note into stretches (`None`: media pipeline
        unavailable, so a note past one stretch cannot be transcribed)."""
        self.inflight: set[str] = set()
        self._limiter: CapacityLimiter | None = None

    def reset_loop_state(self) -> None:
        """Called at app startup: the limiter belongs to one event loop, and no job can be in
        flight in a process that has only just started — so any stretch file a killed process
        left behind is removed."""
        self._limiter = None
        self.inflight.clear()
        shutil.rmtree(self.paths.server_dir / TRANSCRIBE_TMP_DIRNAME, ignore_errors=True)

    async def available(self) -> bool:
        return self.transcriber is not None and await self.transcriber.available()

    def _global_limiter(self) -> CapacityLimiter:
        if self._limiter is None:
            self._limiter = anyio.CapacityLimiter(1)
        return self._limiter

    async def transcribe_audio(
        self, *, audio: bytes, filename: str, content_type: str, duration_s: float
    ) -> JobResult:
        """One private-mode request for audio the caller already holds (the live transcription's
        windows, spec/server-chat/07 §3): the same one-at-a-time limiter as every other job, and
        cmd asked afresh immediately before the audio leaves (Inv 50). Never raises for a
        transcription failure: the result says `failed` and why."""
        transcriber = self.transcriber
        if transcriber is None:
            return JobResult("failed", failure="unavailable")
        async with self._global_limiter():
            if not await transcriber.available(fresh=True):
                return JobResult("failed", failure="unavailable")
            response = await transcriber.transcribe(
                audio=audio,
                filename=filename,
                content_type=content_type,
                timeout_s=transcribe_timeout_s(duration_s),
            )
        return _result_from(response)

    async def run_job(self, att_id: str) -> None:
        """Run one job to a recorded outcome. A job failure never raises: the row becomes `failed`.
        Cancellation (shutdown, or a slot swap stopping this process) marks the row `failed`
        (`interrupted`) under a shield — so no spinner outlives its process, even when no later
        startup would sweep it — and then propagates."""
        result: JobResult | None
        try:
            async with self._global_limiter():
                result = await self._transcribe(att_id)
        except anyio.get_cancelled_exc_class():
            with anyio.CancelScope(shield=True):
                await self._record(
                    att_id, JobResult("failed", failure="interrupted"), only_if_pending=True
                )
            raise
        except Exception:
            _LOGGER.exception("livechat: transcription job for %s failed unexpectedly", att_id)
            result = JobResult("failed", failure="error")
        finally:
            self.inflight.discard(att_id)
        if result is not None:  # None: the attachment was deleted while the job ran
            await self._record(att_id, result)

    async def _record(
        self, att_id: str, result: JobResult, *, only_if_pending: bool = False
    ) -> None:
        try:
            stored = await anyio.to_thread.run_sync(
                lambda: self.store.finish_transcript(
                    att_id=att_id,
                    status=result.status,
                    text=result.text,
                    failure=result.failure,
                    engine=result.engine,
                    now=time.time(),
                    only_if_pending=only_if_pending,
                )
            )
        except Exception:
            # The row stays `pending` until the next startup fails it; nothing here may raise
            # (on the cancellation path that would replace the cancellation itself).
            _LOGGER.exception("livechat: could not record the transcription outcome for %s", att_id)
            return
        if stored:
            self.notifier.publish()

    async def _transcribe(self, att_id: str) -> JobResult | None:
        transcriber = self.transcriber
        if transcriber is None:
            return JobResult("failed", failure="unavailable")
        attachment = await anyio.to_thread.run_sync(self.store.get_attachment, att_id)
        if attachment is None or attachment.kind != "voice":
            return None
        duration_s = attachment.duration_s
        if duration_s is not None and duration_s > VOICE_DURATION_CAP_S + _DURATION_TOLERANCE_S:
            return JobResult("failed", failure="too_long")

        path = self.paths.server_attachment_media_dir(att_id) / VOICE_RENDITION_FILENAME
        if duration_s is not None and duration_s > TRANSCRIBE_STRETCH_S + _DURATION_TOLERANCE_S:
            return await self._transcribe_in_stretches(transcriber, att_id, path, duration_s)
        try:
            audio = await anyio.to_thread.run_sync(path.read_bytes)
        except OSError:
            # A deleted message removes the row first and its files after: only a row that
            # still exists makes a missing file a real failure.
            gone = await anyio.to_thread.run_sync(self.store.get_attachment, att_id) is None
            return None if gone else JobResult("failed", failure="media_missing")

        # Asked of cmd NOW, not answered from the 60 s cache: a cmd that stopped promising private
        # mode since the request was accepted (a rollback to a retaining build) must not receive
        # the audio.
        if not await transcriber.available(fresh=True):
            return JobResult("failed", failure="unavailable")
        response = await transcriber.transcribe(
            audio=audio,
            filename=VOICE_RENDITION_FILENAME,
            content_type=VOICE_CONTENT_TYPE,
            timeout_s=transcribe_timeout_s(duration_s),
        )
        return _result_from(response)

    async def _transcribe_in_stretches(
        self, transcriber: Transcriber, att_id: str, path: Path, duration_s: float
    ) -> JobResult | None:
        """A note longer than one stretch (spec/server-chat/06 §2.4): consecutive stretches of at
        most `TRANSCRIBE_STRETCH_S`, each cut by ffmpeg into a temporary file in the server's
        private storage, sent through the same private-mode call as a short note, and joined with
        one space. The files are deleted when the job ends however it ends; one failed stretch
        fails the whole transcript (the person's Retry runs it again)."""
        ffmpeg = self.ffmpeg
        if ffmpeg is None:
            return JobResult("failed", failure="error")
        work_dir = self.paths.server_dir / TRANSCRIBE_TMP_DIRNAME / uuid.uuid4().hex
        texts: list[str] = []
        engine: str | None = None
        try:
            for stretch in plan_stretches(duration_s):
                length_s = (
                    stretch.length_s
                    if stretch.length_s is not None
                    else duration_s - stretch.start_s
                )
                stretch_file = work_dir / "stretch.m4a"

                def _cut_and_read(
                    start_s: float = stretch.start_s,
                    cut_length_s: float | None = stretch.length_s,
                    target: Path = stretch_file,
                ) -> bytes:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    cut_voice_stretch(
                        path, target, ffmpeg=ffmpeg, start_s=start_s, length_s=cut_length_s
                    )
                    try:
                        return target.read_bytes()
                    finally:
                        target.unlink(missing_ok=True)

                try:
                    audio = await anyio.to_thread.run_sync(_cut_and_read)
                except OSError, MediaProcessingError:
                    # A deleted message removes the row first and its files after: only a row that
                    # still exists makes a missing file a real failure.
                    gone = await anyio.to_thread.run_sync(self.store.get_attachment, att_id) is None
                    if gone:
                        return None
                    exists = await anyio.to_thread.run_sync(path.is_file)
                    return JobResult("failed", failure="error" if exists else "media_missing")
                # Asked of cmd NOW before EVERY stretch, exactly as for a short note.
                if not await transcriber.available(fresh=True):
                    return JobResult("failed", failure="unavailable")
                response = await transcriber.transcribe(
                    audio=audio,
                    filename=VOICE_RENDITION_FILENAME,
                    content_type=VOICE_CONTENT_TYPE,
                    timeout_s=transcribe_timeout_s(length_s),
                )
                result = _result_from(response)
                if result.status != "done":
                    return result
                if result.text:
                    texts.append(result.text)
                if engine is None:
                    engine = result.engine
        finally:
            # Synchronous on purpose: a cancelled job must still clean up, and an `await` here
            # would be cancelled too. It is one small directory.
            shutil.rmtree(work_dir, ignore_errors=True)
        return JobResult("done", text=" ".join(texts), engine=engine)


def _result_from(response: TranscribeResult) -> JobResult:
    if response.outcome == "ok":
        return JobResult(
            "done", text=response.text if response.text is not None else "", engine=response.engine
        )
    return JobResult("failed", failure=_FAILURE_BY_OUTCOME.get(response.outcome, "error"))
