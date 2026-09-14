"""The wixy side of the zero-PIN-state hop (spec/server-chat/00-brief.md R4/§5.1,
v1.4 — cmd workspace #875 PR #3068's real contract, superseding the original
strawman): wixy never holds a PIN — it forwards a submitted PIN and the CF Access
email (as `subject`) to cmd's app-key-scoped, loopback-only PIN-verify service, and
maps cmd's answer onto `POST /unlock`'s own response shape. cmd owns the
registered PIN, the comparison, and the failed-attempt lockout; this module owns
nothing but the HTTP hop, its response mapping, and its (deliberately narrow)
retry policy.

`PinVerifier` is a `Protocol` so `create_app` can inject `CmdPinVerifier()` on the
fleet, `None` on standalone (no cmd there — §5.1: "there's no PIN verifier, so
`/unlock` → 503 `not_configured`"), or a verifier pointed at `fake_cmd.py`'s double
in tests — mirrors `AIBackend`'s own injection seam (`wixy_server/ai/backend.py`).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal, Protocol

import httpx

from builder.jsontypes import JsonObject

logger = logging.getLogger(__name__)

PinOutcome = Literal[
    "ok", "wrong_pin", "locked_out", "pin_changed", "not_configured", "unavailable"
]

DEFAULT_PIN_SERVICE_BASE_URL = "http://127.0.0.1:9320"
DEFAULT_TIMEOUT_S = 5.0  # §5.1: "Timeout: 5 s."


@dataclass(frozen=True, slots=True)
class PinVerifyResult:
    """What `CmdPinVerifier.verify` hands back — `routes_livechat.py`'s `POST
    /unlock` handler maps this 1:1 onto §5.1's response shapes
    (200/401/429/409/503)."""

    outcome: PinOutcome
    attempts_left: int | None = None
    retry_after_s: int | None = None


class PinVerifier(Protocol):
    async def verify(self, *, pin: str, subject: str) -> PinVerifyResult: ...

    async def aclose(self) -> None: ...


class CmdPinVerifier:
    """§5.1 v1.4: `POST http://127.0.0.1:9320/api/pins/<app_key>/verify` — plural
    `pins`, the app key in the URL PATH (not the body) — with
    `{"pin": "<4-16 digits>", "subject": "<CF email, omitted if empty>"}`.

    Retry policy (§5.1: "cmd charges an attempt BEFORE checking it" — the one
    place in the whole feature where getting retries wrong double-counts a wrong
    PIN toward cmd's own lockout): **at most one retry, and only on a connection
    error that provably never reached cmd** — `httpx.ConnectError` (refused/DNS)
    or `httpx.ConnectTimeout` (timed out establishing the connection); BOTH mean
    nothing was ever written to the socket. Every other transport failure (a read
    timeout, a dropped connection mid-response) gets exactly one attempt, because
    the request MAY already have reached cmd — retrying it would risk submitting
    the same PIN twice and silently burning one of the owner's real lockout
    attempts on a transport hiccup wixy caused.
    """

    def __init__(
        self,
        *,
        app_key: str,
        base_url: str = DEFAULT_PIN_SERVICE_BASE_URL,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._app_key = app_key
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._client = httpx.AsyncClient(transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def verify(self, *, pin: str, subject: str) -> PinVerifyResult:
        url = f"{self._base_url}/api/pins/{self._app_key}/verify"
        body: dict[str, str] = {"pin": pin}
        if subject:
            body["subject"] = subject
        response = await self._post_with_narrow_retry(url, body)
        if response is None:
            return PinVerifyResult(outcome="unavailable")
        return _map_response(response)

    async def _post_with_narrow_retry(
        self, url: str, body: dict[str, str]
    ) -> httpx.Response | None:
        # Two separate `except` clauses rather than one tuple-matching clause
        # (`except (httpx.ConnectError, httpx.ConnectTimeout):`) — ruff's
        # formatter (0.16.0) corrupts that exact tuple-except form by dropping
        # its parentheses, producing invalid Python 2-style syntax
        # (`except A, B:`). Two clauses are equivalent and format-stable.
        try:
            return await self._client.post(
                url,
                json=body,
                timeout=self._timeout_s,
                headers={"Content-Type": "application/json"},
            )
        except httpx.ConnectError:
            pass  # provably never reached cmd — exactly one retry is safe.
        except httpx.ConnectTimeout:
            pass  # ditto: a connect-phase timeout never wrote to the socket either.
        except httpx.HTTPError:
            # Any other transport failure (ReadTimeout, a dropped connection, ...):
            # the body may already have reached cmd. Never retry.
            return None
        try:
            return await self._client.post(
                url,
                json=body,
                timeout=self._timeout_s,
                headers={"Content-Type": "application/json"},
            )
        except httpx.HTTPError:
            return None


def _json_or_none(response: httpx.Response) -> JsonObject | None:
    try:
        data = response.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _retry_after_s(response: httpx.Response, data: JsonObject | None) -> int:
    if data is not None:
        value = data.get("retry_after_seconds")
        if isinstance(value, int) and value > 0:
            return value
    header = response.headers.get("Retry-After")
    if header is not None:
        try:
            parsed = int(header)
        except ValueError:
            parsed = 0
        if parsed > 0:
            return parsed
    return 1


def _map_response(response: httpx.Response) -> PinVerifyResult:
    """§5.1's "Mapping cmd -> wixy" table, verbatim."""
    status = response.status_code

    if status == 200:
        # Closed-fail even on the success path: a 200 whose body doesn't
        # actually confirm `ok: true` (malformed JSON, a contract drift, a
        # misrouted response) must never mint an unlock token — never trust
        # the status code alone for the one outcome that opens the gate.
        data = _json_or_none(response)
        if data is not None and data.get("ok") is True:
            return PinVerifyResult(outcome="ok")
        logger.error(
            "livechat: cmd PIN-verify returned 200 without a genuine ok:true body — "
            "treating as unavailable rather than trusting the status code: %r",
            data,
        )
        return PinVerifyResult(outcome="unavailable")
    if status == 404:
        return PinVerifyResult(outcome="not_configured")
    if status == 429:
        data = _json_or_none(response)
        return PinVerifyResult(outcome="locked_out", retry_after_s=_retry_after_s(response, data))
    if status == 401:
        data = _json_or_none(response)
        if data is None:
            return PinVerifyResult(outcome="unavailable")
        if data.get("locked") is True:
            # "if locked is true, 429 with retryAfterS instead" — the SAME
            # attempt that tripped the lockout still comes back as a 401 from
            # cmd, but wixy normalizes it into the same outcome a genuine 429
            # produces, so the owner sees one consistent "try again in Ns."
            return PinVerifyResult(
                outcome="locked_out", retry_after_s=_retry_after_s(response, data)
            )
        attempts_left = data.get("attempts_left")
        return PinVerifyResult(
            outcome="wrong_pin",
            attempts_left=attempts_left if isinstance(attempts_left, int) else None,
        )
    if status == 409:
        return PinVerifyResult(outcome="pin_changed")
    if status == 400:
        data = _json_or_none(response)
        error = data.get("error") if data is not None else None
        if error == "invalid_app_key":
            return PinVerifyResult(outcome="not_configured")
        # "invalid_request": wixy validates the PIN shape locally before ever
        # calling cmd, so cmd rejecting the request as malformed means wixy
        # sent something wrong — a bug, not a PIN outcome. Logged, not raised:
        # the owner still needs a closed-fail 503, never a stack trace.
        logger.error(
            "livechat: cmd PIN-verify rejected wixy's own request as invalid_request "
            "(400) — this is a wixy-side bug, not a PIN or lockout outcome: %r",
            data,
        )
        return PinVerifyResult(outcome="unavailable")
    if status in (403, 413, 415):
        # same-box-only refusal / body too large / wrong content-type — every one
        # of these is either a wixy bug or a misrouted deployment, never
        # something the PIN itself caused.
        logger.error(
            "livechat: cmd PIN-verify rejected the request at the transport level "
            "(%s) — a wixy-side bug or a misrouted deployment",
            status,
        )
        return PinVerifyResult(outcome="unavailable")
    # 503 (`unavailable`) and any other unexpected status.
    return PinVerifyResult(outcome="unavailable")
