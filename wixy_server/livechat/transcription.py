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
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal

import anyio
from anyio.abc import CapacityLimiter

from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.processing import VOICE_DURATION_CAP_S
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

_FAILURE_BY_OUTCOME: Final[dict[str, str]] = {
    "warming": "warming",
    "timeout": "timeout",
    "unavailable": "unavailable",
    "rejected": "rejected",
    "invalid": "invalid_response",
}


def transcribe_timeout_s(duration_s: float | None) -> float:
    """cmd's whole-request budget: 60 s plus half the note's length — a 15-minute note on the
    CPU engine cannot finish in a flat 60 s."""
    bounded = min(max(duration_s or 0.0, 0.0), VOICE_DURATION_CAP_S)
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

    def hit(self, key: str) -> float | None:
        now = self._clock()
        events = self._events.setdefault(key, deque())
        while events and now - events[0] >= self._window_s:
            events.popleft()
        if len(events) >= self._max_events:
            return max(0.0, self._window_s - (now - events[0]))
        events.append(now)
        return None


@dataclass(frozen=True, slots=True)
class _JobResult:
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
    ) -> None:
        self.store = store
        self.paths = paths
        self.notifier = notifier
        self.transcriber = transcriber
        self.rate_limiter = rate_limiter if rate_limiter is not None else SlidingWindowRateLimiter()
        self.inflight: set[str] = set()
        self._limiter: CapacityLimiter | None = None

    def reset_loop_state(self) -> None:
        """Called at app startup: the limiter belongs to one event loop, and no job can be in
        flight in a process that has only just started."""
        self._limiter = None
        self.inflight.clear()

    async def available(self) -> bool:
        return self.transcriber is not None and await self.transcriber.available()

    def _global_limiter(self) -> CapacityLimiter:
        if self._limiter is None:
            self._limiter = anyio.CapacityLimiter(1)
        return self._limiter

    async def run_job(self, att_id: str) -> None:
        """Run one job to a recorded outcome. A job failure never raises: the row becomes `failed`.
        Cancellation (shutdown, or a slot swap stopping this process) marks the row `failed`
        (`interrupted`) under a shield — so no spinner outlives its process, even when no later
        startup would sweep it — and then propagates."""
        result: _JobResult | None
        try:
            async with self._global_limiter():
                result = await self._transcribe(att_id)
        except anyio.get_cancelled_exc_class():
            with anyio.CancelScope(shield=True):
                await self._record(
                    att_id, _JobResult("failed", failure="interrupted"), only_if_pending=True
                )
            raise
        except Exception:
            _LOGGER.exception("livechat: transcription job for %s failed unexpectedly", att_id)
            result = _JobResult("failed", failure="error")
        finally:
            self.inflight.discard(att_id)
        if result is not None:  # None: the attachment was deleted while the job ran
            await self._record(att_id, result)

    async def _record(
        self, att_id: str, result: _JobResult, *, only_if_pending: bool = False
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

    async def _transcribe(self, att_id: str) -> _JobResult | None:
        transcriber = self.transcriber
        if transcriber is None:
            return _JobResult("failed", failure="unavailable")
        attachment = await anyio.to_thread.run_sync(self.store.get_attachment, att_id)
        if attachment is None or attachment.kind != "voice":
            return None
        duration_s = attachment.duration_s
        if duration_s is not None and duration_s > VOICE_DURATION_CAP_S + _DURATION_TOLERANCE_S:
            return _JobResult("failed", failure="too_long")

        path = self.paths.server_attachment_media_dir(att_id) / VOICE_RENDITION_FILENAME
        try:
            audio = await anyio.to_thread.run_sync(path.read_bytes)
        except OSError:
            # A deleted message removes the row first and its files after: only a row that
            # still exists makes a missing file a real failure.
            gone = await anyio.to_thread.run_sync(self.store.get_attachment, att_id) is None
            return None if gone else _JobResult("failed", failure="media_missing")

        # Asked of cmd NOW, not answered from the 60 s cache: a cmd that stopped promising private
        # mode since the request was accepted (a rollback to a retaining build) must not receive
        # the audio.
        if not await transcriber.available(fresh=True):
            return _JobResult("failed", failure="unavailable")
        response = await transcriber.transcribe(
            audio=audio,
            filename=VOICE_RENDITION_FILENAME,
            content_type=VOICE_CONTENT_TYPE,
            timeout_s=transcribe_timeout_s(duration_s),
        )
        return _result_from(response)


def _result_from(response: TranscribeResult) -> _JobResult:
    if response.outcome == "ok":
        return _JobResult(
            "done", text=response.text if response.text is not None else "", engine=response.engine
        )
    return _JobResult("failed", failure=_FAILURE_BY_OUTCOME.get(response.outcome, "error"))
