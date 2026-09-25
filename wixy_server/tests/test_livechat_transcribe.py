"""`livechat.transcribe.CmdTranscriber` (spec/server-chat/05-voice-transcription.md) — the
capability probe and its 60 s cache, the exact request wixy puts on the wire (private mode only,
no chat context), response mapping, and that no transcript text ever reaches a log line. Also the
pure pieces of `livechat.transcription`: the timeout formula and the per-identity rate limiter.
"""

from __future__ import annotations

import logging

import httpx
import pytest

from wixy_server.livechat.processing import VOICE_DURATION_CAP_S
from wixy_server.livechat.transcribe import (
    MAX_TRANSCRIPT_CHARS,
    PROBE_TTL_S,
    CmdTranscriber,
)
from wixy_server.livechat.transcription import SlidingWindowRateLimiter, transcribe_timeout_s
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app


def _transcriber(
    state: FakeCmdState, *, clock: list[float] | None = None
) -> tuple[CmdTranscriber, list[float]]:
    now = clock if clock is not None else [0.0]
    transcriber = CmdTranscriber(
        transport=httpx.ASGITransport(app=create_fake_cmd_app(state)), clock=lambda: now[0]
    )
    return transcriber, now


def _mock_transcriber(handler: httpx.MockTransport) -> CmdTranscriber:
    return CmdTranscriber(transport=handler)


class TestProbe:
    @pytest.mark.asyncio
    async def test_private_true_means_available(self) -> None:
        transcriber, _ = _transcriber(FakeCmdState(transcribe_private_supported=True))
        assert await transcriber.available() is True
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_a_cmd_without_the_private_mode_is_unavailable(self) -> None:
        transcriber, _ = _transcriber(FakeCmdState(transcribe_private_supported=False))
        assert await transcriber.available() is False
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_a_cmd_that_predates_the_probe_route_is_unavailable(self) -> None:
        state = FakeCmdState(transcribe_capabilities_status=404)
        transcriber, _ = _transcriber(state)
        assert await transcriber.available() is False
        await transcriber.aclose()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "body",
        [b"not json", b"[]", b'{"private": "yes"}', b'{"private": 1}', b'{"private": null}', b"{}"],
    )
    async def test_only_a_literal_true_counts(self, body: bytes) -> None:
        transcriber = _mock_transcriber(
            httpx.MockTransport(lambda _request: httpx.Response(200, content=body))
        )
        assert await transcriber.available() is False
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_an_unreachable_cmd_is_unavailable_not_an_error(self) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        transcriber = _mock_transcriber(httpx.MockTransport(refuse))
        assert await transcriber.available() is False
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_the_answer_is_cached_for_sixty_seconds_both_ways(self) -> None:
        state = FakeCmdState(transcribe_private_supported=False)
        transcriber, now = _transcriber(state)
        assert PROBE_TTL_S == 60.0

        assert await transcriber.available() is False
        assert await transcriber.available() is False
        assert state.transcribe_probe_count == 1  # a down/old cmd is not hammered either

        state.transcribe_private_supported = True
        now[0] = 59.0
        assert await transcriber.available() is False
        assert state.transcribe_probe_count == 1

        now[0] = 61.0
        assert await transcriber.available() is True
        assert state.transcribe_probe_count == 2
        await transcriber.aclose()


class TestFreshProbe:
    @pytest.mark.asyncio
    async def test_fresh_ignores_the_cache_and_refreshes_it(self) -> None:
        state = FakeCmdState(transcribe_private_supported=True)
        transcriber, _ = _transcriber(state)
        assert await transcriber.available() is True
        assert await transcriber.available() is True
        assert state.transcribe_probe_count == 1  # cached

        state.transcribe_private_supported = False  # a rollback, inside the 60 s window
        assert await transcriber.available() is True  # the cache still says yes...
        assert await transcriber.available(fresh=True) is False  # ...cmd, asked now, says no
        assert state.transcribe_probe_count == 2
        assert await transcriber.available() is False  # and the cache now agrees
        assert state.transcribe_probe_count == 2
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_a_probe_that_never_finishes_is_unavailable_within_its_budget(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import asyncio

        import wixy_server.livechat.transcribe as transcribe_module

        monkeypatch.setattr(transcribe_module, "PROBE_TIMEOUT_S", 0.1)

        async def stall(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(30)
            return httpx.Response(200, json={"private": True})

        transcriber = _mock_transcriber(httpx.MockTransport(stall))
        started = asyncio.get_running_loop().time()
        assert await transcriber.available() is False
        assert asyncio.get_running_loop().time() - started < 5
        await transcriber.aclose()


class TestRequestShape:
    @pytest.mark.asyncio
    async def test_sends_private_and_cleanup_off_and_nothing_about_the_chat(self) -> None:
        state = FakeCmdState()
        transcriber, _ = _transcriber(state)

        result = await transcriber.transcribe(
            audio=b"m4a-bytes", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )

        assert result.outcome == "ok"
        [request] = state.transcribe_requests
        assert request.fields == {"private": "1", "cleanup": "0"}
        assert "session_id" not in request.fields and "context" not in request.fields
        assert request.audio == b"m4a-bytes"
        assert request.filename == "play.m4a"
        assert request.content_type == "audio/mp4"
        assert state.transcribe_retained == []
        await transcriber.aclose()


class TestResponseMapping:
    @pytest.mark.asyncio
    async def test_ok_carries_stripped_text_and_a_sane_engine_label(self) -> None:
        state = FakeCmdState(transcribe_text="  hello there \n", transcribe_engine="parakeet")
        transcriber, _ = _transcriber(state)
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        assert (result.outcome, result.text, result.engine) == ("ok", "hello there", "parakeet")
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_an_empty_transcript_is_a_valid_answer(self) -> None:
        transcriber, _ = _transcriber(FakeCmdState(transcribe_text=""))
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        assert (result.outcome, result.text) == ("ok", "")
        await transcriber.aclose()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("engine", ["<script>", "x" * 41, "", None])
    async def test_an_odd_engine_label_is_dropped(self, engine: str | None) -> None:
        transcriber, _ = _transcriber(FakeCmdState(transcribe_engine=engine))
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        assert (result.outcome, result.engine) == ("ok", None)
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_raw_is_used_when_text_is_missing(self) -> None:
        transcriber = _mock_transcriber(
            httpx.MockTransport(lambda _r: httpx.Response(200, json={"raw": "from raw"}))
        )
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        assert (result.outcome, result.text) == ("ok", "from raw")
        await transcriber.aclose()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "response",
        [
            httpx.Response(200, content=b"not json"),
            httpx.Response(200, json=["a list"]),
            httpx.Response(200, json={"text": 5}),
            httpx.Response(200, json={}),
            httpx.Response(200, json={"text": "y" * (MAX_TRANSCRIPT_CHARS + 1)}),
        ],
        ids=["not-json", "not-an-object", "text-not-a-string", "no-text", "runaway-length"],
    )
    async def test_a_malformed_success_is_invalid_not_stored(
        self, response: httpx.Response
    ) -> None:
        transcriber = _mock_transcriber(httpx.MockTransport(lambda _r: response))
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        assert (result.outcome, result.text) == ("invalid", None)
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_asr_warming_is_its_own_outcome_and_keeps_the_probe(self) -> None:
        state = FakeCmdState(transcribe_status_code=503, transcribe_error="asr_warming")
        transcriber, _ = _transcriber(state)
        assert await transcriber.available() is True
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        assert result.outcome == "warming"
        assert await transcriber.available() is True
        assert state.transcribe_probe_count == 1
        await transcriber.aclose()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", [500, 502, 503, 404])
    async def test_a_server_side_failure_is_unavailable_and_reprobes(self, status: int) -> None:
        state = FakeCmdState(transcribe_status_code=status, transcribe_error="boom")
        transcriber, _ = _transcriber(state)
        assert await transcriber.available() is True
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        assert result.outcome == "unavailable"
        assert await transcriber.available() is True
        assert state.transcribe_probe_count == 2  # the failure dropped the cached answer
        await transcriber.aclose()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", [400, 413, 415, 422])
    async def test_a_request_cmd_refuses_is_rejected(self, status: int) -> None:
        transcriber, _ = _transcriber(FakeCmdState(transcribe_status_code=status))
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        assert result.outcome == "rejected"
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_a_transport_failure_is_unavailable(self) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        transcriber = _mock_transcriber(httpx.MockTransport(refuse))
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        assert result.outcome == "unavailable"
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_the_whole_request_has_one_time_budget(self) -> None:
        state = FakeCmdState(transcribe_delay_s=2.0)
        transcriber, _ = _transcriber(state)
        result = await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=0.1
        )
        assert result.outcome == "timeout"
        await transcriber.aclose()

    @pytest.mark.asyncio
    async def test_no_transcript_text_is_ever_logged(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.DEBUG)
        sentinel = "log-sentinel-c41e9b07"
        state = FakeCmdState(transcribe_text=sentinel)
        transcriber, _ = _transcriber(state)
        await transcriber.available()
        await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        state.transcribe_status_code = 500
        state.transcribe_error = sentinel
        await transcriber.transcribe(
            audio=b"x", filename="play.m4a", content_type="audio/mp4", timeout_s=5.0
        )
        await transcriber.aclose()
        assert sentinel not in caplog.text


class TestLimits:
    def test_timeout_is_sixty_seconds_plus_half_the_note(self) -> None:
        assert transcribe_timeout_s(0) == 60.0
        assert transcribe_timeout_s(None) == 60.0
        assert transcribe_timeout_s(120) == 120.0
        assert transcribe_timeout_s(VOICE_DURATION_CAP_S) == 60.0 + 450.0

    def test_timeout_never_exceeds_the_cap_even_for_a_lying_duration(self) -> None:
        assert transcribe_timeout_s(10 * VOICE_DURATION_CAP_S) == transcribe_timeout_s(
            VOICE_DURATION_CAP_S
        )
        assert transcribe_timeout_s(-5) == 60.0

    def test_six_a_minute_per_identity(self) -> None:
        now = [0.0]
        limiter = SlidingWindowRateLimiter(clock=lambda: now[0])
        for _ in range(6):
            assert limiter.hit("a@example.com") is None
        retry_after = limiter.hit("a@example.com")
        assert retry_after is not None and 0 < retry_after <= 60.0
        # Another identity has its own budget.
        assert limiter.hit("b@example.com") is None
        # The window slides: the first event leaves after 60 s.
        now[0] = 60.5
        assert limiter.hit("a@example.com") is None

    def test_a_refused_hit_is_not_recorded(self) -> None:
        now = [0.0]
        limiter = SlidingWindowRateLimiter(max_events=1, window_s=10.0, clock=lambda: now[0])
        assert limiter.hit("k") is None
        assert limiter.hit("k") is not None
        now[0] = 10.1
        assert limiter.hit("k") is None  # would still be refused if the refusal had been counted
