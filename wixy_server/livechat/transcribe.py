"""The wixy side of the private voice-transcription hop
(spec/server-chat/05-voice-transcription.md): one voice note's audio goes to cmd's on-box
ASR and the text comes back. Loopback only, no third party, no per-request cost.

cmd's plain `POST /api/transcribe` RETAINS what it transcribes (a rolling audio + transcript
debug buffer, and the ASR service's shadow log), where this chat's delete/wipe could never
reach it (Inv 40/46). So wixy talks to it ONLY through cmd's **private mode** — the form
field `private=1`, which cmd promises means "no debug save, no transcript in any log, ASR
not shadowed, bytes held in memory only" — and ONLY after `GET /api/transcribe/capabilities`
answers `{"private": true}`. A cmd that cannot promise that (or is unreachable) makes the
feature unavailable: nothing is ever sent to it.

Every request also carries `cleanup=0` (no LLM ever sees the text) and no `session_id` / no
`context` (nothing about the chat is disclosed). `Transcriber` is a `Protocol` so `create_app`
can inject `CmdTranscriber()` on the fleet, `None` on standalone (no cmd there), or one
pointed at `fake_cmd.py`'s double in tests — the same seam as `pinclient.PinVerifier`.

Nothing in this module ever logs, formats into an error, or otherwise emits transcript text.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal, Protocol

import anyio
import httpx

from builder.jsontypes import JsonObject

logger = logging.getLogger(__name__)

DEFAULT_TRANSCRIBE_BASE_URL: Final = "http://127.0.0.1:9320"
PROBE_TTL_S: Final = 60.0
PROBE_TIMEOUT_S: Final = 2.0
_CONNECT_TIMEOUT_S: Final = 5.0
MAX_TRANSCRIPT_CHARS: Final = 200_000
"""A 15-minute note is a few thousand words; anything past this is a runaway ASR loop or a
misbehaving service, and is refused rather than stored."""

_ENGINE_RE: Final = re.compile(r"^[A-Za-z0-9._ -]{1,40}$")

TranscribeOutcome = Literal["ok", "warming", "timeout", "unavailable", "rejected", "invalid"]


@dataclass(frozen=True, slots=True)
class TranscribeResult:
    """`text` and `engine` are only set for `ok`."""

    outcome: TranscribeOutcome
    text: str | None = None
    engine: str | None = None


class Transcriber(Protocol):
    async def available(self, *, fresh: bool = False) -> bool:
        """Whether cmd currently promises private mode. `fresh=True` ignores the cached answer
        and asks cmd now — required immediately before any audio is sent."""
        ...

    async def transcribe(
        self, *, audio: bytes, filename: str, content_type: str, timeout_s: float
    ) -> TranscribeResult: ...

    async def aclose(self) -> None: ...


class CmdTranscriber:
    """`POST {base}/api/transcribe` (multipart `audio`, form `private=1` + `cleanup=0`) gated
    by `GET {base}/api/transcribe/capabilities`, whose answer is cached for `probe_ttl_s`
    (both ways — a down cmd is not hammered on every usage poll). The cache is for the cheap
    "should the button show / may a request be accepted" questions; a job asks `fresh=True`
    immediately before it sends any audio, so a cmd that has just stopped promising private mode
    receives nothing even inside the 60 s window.

    No retries: a transcription is GPU/CPU work on a shared box, and repeating one whose
    response was merely lost would just do it twice; the user's Retry button is the retry.
    """

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_TRANSCRIBE_BASE_URL,
        probe_ttl_s: float = PROBE_TTL_S,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._probe_ttl_s = probe_ttl_s
        self._clock = clock
        self._client = httpx.AsyncClient(transport=transport)
        self._probe_result: bool | None = None
        self._probe_expires_at = 0.0

    async def aclose(self) -> None:
        await self._client.aclose()

    def invalidate_probe(self) -> None:
        self._probe_result = None

    async def available(self, *, fresh: bool = False) -> bool:
        if not fresh and self._probe_result is not None and self._clock() < self._probe_expires_at:
            return self._probe_result
        result = await self._probe()
        self._probe_result = result
        self._probe_expires_at = self._clock() + self._probe_ttl_s
        return result

    async def _probe(self) -> bool:
        try:
            # `httpx` timeouts are per phase; `fail_after` bounds the whole probe, so a cmd that
            # trickles bytes cannot stall `GET /usage` or a job waiting for its turn.
            with anyio.fail_after(PROBE_TIMEOUT_S):
                response = await self._client.get(
                    f"{self._base_url}/api/transcribe/capabilities", timeout=PROBE_TIMEOUT_S
                )
        except TimeoutError:
            return False
        except httpx.HTTPError:
            return False
        if response.status_code != 200:
            return False
        data = _json_object(response)
        return data is not None and data.get("private") is True

    async def transcribe(
        self, *, audio: bytes, filename: str, content_type: str, timeout_s: float
    ) -> TranscribeResult:
        url = f"{self._base_url}/api/transcribe"
        timeout = httpx.Timeout(
            connect=_CONNECT_TIMEOUT_S, read=timeout_s, write=timeout_s, pool=_CONNECT_TIMEOUT_S
        )
        try:
            # `httpx` timeouts are per phase; `fail_after` is the whole-request budget.
            with anyio.fail_after(timeout_s):
                response = await self._client.post(
                    url,
                    data={"private": "1", "cleanup": "0"},
                    files={"audio": (filename, audio, content_type)},
                    timeout=timeout,
                )
        except TimeoutError:
            logger.warning("livechat: cmd transcription timed out after %.0fs", timeout_s)
            return TranscribeResult("timeout")
        except httpx.TimeoutException:
            logger.warning("livechat: cmd transcription timed out after %.0fs", timeout_s)
            return TranscribeResult("timeout")
        except httpx.HTTPError as exc:
            logger.warning("livechat: cmd transcription transport failure (%s)", type(exc).__name__)
            self.invalidate_probe()
            return TranscribeResult("unavailable")
        return self._map_response(response)

    def _map_response(self, response: httpx.Response) -> TranscribeResult:
        status = response.status_code
        if status == 200:
            return _parse_success(response)
        if status == 503:
            error = (_json_object(response) or {}).get("error")
            if error == "asr_warming":
                # The ASR models are still loading; cmd says "come back shortly". The private
                # promise itself is unaffected, so the cached probe stays.
                return TranscribeResult("warming")
            self.invalidate_probe()
            return TranscribeResult("unavailable")
        if status in (400, 413, 415, 422):
            logger.warning("livechat: cmd rejected the transcription request (%s)", status)
            return TranscribeResult("rejected")
        logger.warning("livechat: cmd transcription failed (%s)", status)
        self.invalidate_probe()
        return TranscribeResult("unavailable")


def _json_object(response: httpx.Response) -> JsonObject | None:
    try:
        data = response.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _has_lone_surrogate(text: str) -> bool:
    """A plain JSON body containing e.g. `"\\ud800"` decodes, via `response.json()`, into a real
    Python `str` holding an unpaired UTF-16 surrogate code point — no malformed JSON required.
    Such a string crashes at the SQLite text bind with `UnicodeEncodeError` when a later caller
    tries to store it, which is far from this narrow boundary; reject it here instead, where the
    failure maps cleanly onto the existing `invalid` outcome (a working Retry, no stuck spinner)."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return True
    return False


def _parse_success(response: httpx.Response) -> TranscribeResult:
    data = _json_object(response)
    if data is None:
        return TranscribeResult("invalid")
    text = data.get("text")
    if not isinstance(text, str):
        text = data.get("raw")
    if not isinstance(text, str) or len(text) > MAX_TRANSCRIPT_CHARS:
        return TranscribeResult("invalid")
    text = text.strip()
    if _has_lone_surrogate(text):
        return TranscribeResult("invalid")
    engine = data.get("engine")
    return TranscribeResult(
        "ok",
        text=text,
        engine=engine if isinstance(engine, str) and _ENGINE_RE.match(engine) else None,
    )
