"""`livechat.pinclient.CmdPinVerifier` (spec/server-chat/00-brief.md §5.1 v1.4 —
cmd workspace #875 PR #3068's real contract) — response mapping per the "Mapping
cmd -> wixy" table, and the narrow retry policy: exactly one retry on a
connection error that provably never reached cmd (`httpx.ConnectError` OR
`httpx.ConnectTimeout`), never on anything else (cmd charges an attempt BEFORE
checking it, so a retry after any received response risks double-counting)."""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from wixy_server.livechat.pinclient import CmdPinVerifier

APP_KEY = "wixy-livechat"


def _transport(
    status_code: int, json_body: object = None, headers: dict[str, str] | None = None
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if json_body is None:
            return httpx.Response(status_code, headers=headers)
        return httpx.Response(status_code, json=json_body, headers=headers)

    return httpx.MockTransport(handler)


def _counting_transport(
    make_response: Callable[[int], httpx.Response],
) -> tuple[httpx.MockTransport, list[int]]:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return make_response(len(calls))

    return httpx.MockTransport(handler), calls


class TestRequestShape:
    @pytest.mark.asyncio
    async def test_posts_to_the_path_scoped_verify_url(self) -> None:
        captured_url = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured_url["url"] = str(request.url)
            return httpx.Response(200, json={"ok": True, "app_key": APP_KEY})

        client = CmdPinVerifier(app_key=APP_KEY, transport=httpx.MockTransport(handler))
        await client.verify(pin="1234", subject="")
        assert captured_url["url"] == f"http://127.0.0.1:9320/api/pins/{APP_KEY}/verify"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_body_carries_pin_and_omits_empty_subject(self) -> None:
        captured: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={"ok": True, "app_key": APP_KEY})

        client = CmdPinVerifier(app_key=APP_KEY, transport=httpx.MockTransport(handler))
        await client.verify(pin="4321", subject="")
        assert captured == {"pin": "4321"}
        await client.aclose()

    @pytest.mark.asyncio
    async def test_body_includes_subject_when_present(self) -> None:
        captured: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={"ok": True, "app_key": APP_KEY})

        client = CmdPinVerifier(app_key=APP_KEY, transport=httpx.MockTransport(handler))
        await client.verify(pin="4321", subject="josh@example.com")
        assert captured == {"pin": "4321", "subject": "josh@example.com"}
        await client.aclose()

    @pytest.mark.asyncio
    async def test_sends_content_type_json(self) -> None:
        captured_ct = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured_ct["value"] = request.headers.get("content-type", "")
            return httpx.Response(200, json={"ok": True, "app_key": APP_KEY})

        client = CmdPinVerifier(app_key=APP_KEY, transport=httpx.MockTransport(handler))
        await client.verify(pin="1234", subject="")
        assert "application/json" in captured_ct["value"]
        await client.aclose()


class TestResponseMapping:
    @pytest.mark.asyncio
    async def test_200_ok_true_maps_to_ok(self) -> None:
        client = CmdPinVerifier(
            app_key=APP_KEY, transport=_transport(200, {"ok": True, "app_key": APP_KEY})
        )
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "ok"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_401_not_locked_maps_to_wrong_pin_with_attempts_left(self) -> None:
        client = CmdPinVerifier(
            app_key=APP_KEY,
            transport=_transport(
                401,
                {
                    "ok": False,
                    "error": "wrong_pin",
                    "attempts_left": 3,
                    "locked": False,
                    "lock_scope": None,
                    "retry_after_seconds": 0,
                },
            ),
        )
        result = await client.verify(pin="0000", subject="")
        assert result.outcome == "wrong_pin"
        assert result.attempts_left == 3
        await client.aclose()

    @pytest.mark.asyncio
    async def test_401_locked_true_maps_to_locked_out_not_wrong_pin(self) -> None:
        """§5.1's mapping table: "if locked is true, 429 with retryAfterS
        instead" — the SAME attempt that tripped the lockout still arrives as a
        401 from cmd, but wixy must normalize it to the locked_out outcome."""
        client = CmdPinVerifier(
            app_key=APP_KEY,
            transport=_transport(
                401,
                {
                    "ok": False,
                    "error": "wrong_pin",
                    "attempts_left": 0,
                    "locked": True,
                    "lock_scope": "subject",
                    "retry_after_seconds": 60,
                },
                headers={"Retry-After": "60"},
            ),
        )
        result = await client.verify(pin="0000", subject="")
        assert result.outcome == "locked_out"
        assert result.retry_after_s == 60
        await client.aclose()

    @pytest.mark.asyncio
    async def test_429_maps_to_locked_out(self) -> None:
        client = CmdPinVerifier(
            app_key=APP_KEY,
            transport=_transport(
                429,
                {"ok": False, "error": "locked", "lock_scope": "app", "retry_after_seconds": 42},
                headers={"Retry-After": "42"},
            ),
        )
        result = await client.verify(pin="0000", subject="")
        assert result.outcome == "locked_out"
        assert result.retry_after_s == 42
        await client.aclose()

    @pytest.mark.asyncio
    async def test_429_falls_back_to_retry_after_header_if_body_lacks_it(self) -> None:
        client = CmdPinVerifier(
            app_key=APP_KEY,
            transport=_transport(
                429, {"ok": False, "error": "locked"}, headers={"Retry-After": "15"}
            ),
        )
        result = await client.verify(pin="0000", subject="")
        assert result.outcome == "locked_out"
        assert result.retry_after_s == 15
        await client.aclose()

    @pytest.mark.asyncio
    async def test_404_unknown_app_maps_to_not_configured(self) -> None:
        client = CmdPinVerifier(
            app_key="unregistered", transport=_transport(404, {"ok": False, "error": "unknown_app"})
        )
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "not_configured"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_409_pin_changed_maps_to_pin_changed(self) -> None:
        client = CmdPinVerifier(
            app_key=APP_KEY, transport=_transport(409, {"ok": False, "error": "pin_changed"})
        )
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "pin_changed"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_400_invalid_app_key_maps_to_not_configured(self) -> None:
        client = CmdPinVerifier(
            app_key=APP_KEY,
            transport=_transport(
                400, {"ok": False, "error": "invalid_app_key", "message": "bad key"}
            ),
        )
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "not_configured"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_400_invalid_request_maps_to_unavailable_and_logs_error(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        import logging

        caplog.set_level(logging.ERROR)
        client = CmdPinVerifier(
            app_key=APP_KEY,
            transport=_transport(
                400, {"ok": False, "error": "invalid_request", "message": "bad shape"}
            ),
        )
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "unavailable"
        assert "invalid_request" in caplog.text
        await client.aclose()

    @pytest.mark.asyncio
    async def test_403_maps_to_unavailable(self) -> None:
        client = CmdPinVerifier(app_key=APP_KEY, transport=_transport(403))
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "unavailable"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_413_maps_to_unavailable(self) -> None:
        client = CmdPinVerifier(app_key=APP_KEY, transport=_transport(413))
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "unavailable"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_415_maps_to_unavailable(self) -> None:
        client = CmdPinVerifier(app_key=APP_KEY, transport=_transport(415))
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "unavailable"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_503_maps_to_unavailable(self) -> None:
        client = CmdPinVerifier(
            app_key=APP_KEY, transport=_transport(503, {"ok": False, "error": "unavailable"})
        )
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "unavailable"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_malformed_json_body_maps_to_unavailable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"not json at all")

        client = CmdPinVerifier(app_key=APP_KEY, transport=httpx.MockTransport(handler))
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "unavailable"
        await client.aclose()


class TestRetryPolicy:
    @pytest.mark.asyncio
    async def test_connect_error_retries_once_then_succeeds(self) -> None:
        def make_response(call_n: int) -> httpx.Response:
            if call_n == 1:
                raise httpx.ConnectError("refused")
            return httpx.Response(200, json={"ok": True, "app_key": APP_KEY})

        transport, calls = _counting_transport(make_response)
        client = CmdPinVerifier(app_key=APP_KEY, transport=transport)
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "ok"
        assert len(calls) == 2
        await client.aclose()

    @pytest.mark.asyncio
    async def test_connect_timeout_also_retries_once_then_succeeds(self) -> None:
        """§5.1 v1.4 widens the retry-safe set to include `ConnectTimeout` — both
        it and `ConnectError` provably never reach cmd."""

        def make_response(call_n: int) -> httpx.Response:
            if call_n == 1:
                raise httpx.ConnectTimeout("timed out connecting")
            return httpx.Response(200, json={"ok": True, "app_key": APP_KEY})

        transport, calls = _counting_transport(make_response)
        client = CmdPinVerifier(app_key=APP_KEY, transport=transport)
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "ok"
        assert len(calls) == 2
        await client.aclose()

    @pytest.mark.asyncio
    async def test_connect_error_twice_gives_up_after_exactly_two_attempts(self) -> None:
        def make_response(call_n: int) -> httpx.Response:
            raise httpx.ConnectError("refused")

        transport, calls = _counting_transport(make_response)
        client = CmdPinVerifier(app_key=APP_KEY, transport=transport)
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "unavailable"
        assert len(calls) == 2  # exactly one retry, never more
        await client.aclose()

    @pytest.mark.asyncio
    async def test_read_timeout_never_retries(self) -> None:
        """cmd charges the attempt BEFORE checking it — a read timeout means the
        body may already have been evaluated, so retrying risks double-counting
        toward the owner's real lockout."""

        def make_response(call_n: int) -> httpx.Response:
            raise httpx.ReadTimeout("timed out")

        transport, calls = _counting_transport(make_response)
        client = CmdPinVerifier(app_key=APP_KEY, transport=transport)
        result = await client.verify(pin="1234", subject="")
        assert result.outcome == "unavailable"
        assert len(calls) == 1
        await client.aclose()
