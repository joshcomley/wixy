"""The ONLY module that talks to the local cmd instance (spec/06-ai-chat.md §1
preamble: "These calls MUST go through one wixy_server/cmdchat.py client module
(timeouts 10s, retries x2 on connect errors, structured errors surfaced to the UI —
never a silent hang)"). Never call the Anthropic API directly, anywhere in this
engine — all inference is cmd-spawned chats (project CLAUDE.md, fleet rule).

Two cmd surfaces, both localhost-only:
  - the cmd **portal** (default `http://127.0.0.1:9320`) — new-chat, session
    readiness, the handover chain, send, and the `/ws/chat-pending` websocket;
  - **Cmd-Chats** introspection (default `http://127.0.0.1:9321`) — decoded
    messages + status for an existing session.

`CmdChatClient` is written against an interface (spec/06 §4: "tests run against a
fake cmd server") — `wixy_server/tests/fake_cmd.py` implements both surfaces as one
combined FastAPI app for hermetic unit tests (via `httpx.ASGITransport` for the pure
HTTP endpoints, a real ephemeral-port uvicorn instance for the websocket ones, which
need a genuine socket). One `@pytest.mark.live_cmd` smoke test (skipped in CI) is
the real end-to-end proof against a live local cmd, run during milestone 13's live
verification (spec/06 §4).

`wait_until_ready` is the higher-level provisioning orchestration spec/06 §1
describes ("poll it every 2s (max 120s)... for failure detail before the timeout,
subscribe to ws://.../ws/chat-pending... If the WS is unavailable, the 120s timeout
is the terminal signal"): it races a bounded 2s-interval poll of `GET
/api/session/<id>` against a best-effort websocket subscription for an early
`workspace_failed`/`cli_failed` signal, and returns whichever resolves first. A
websocket that never connects (cmd too old, transient hiccup, whatever) degrades
gracefully to pure polling — this is spec'd behavior, not a fallback of last resort.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Any, Literal

import anyio
import httpx
from websockets.asyncio.client import connect as websockets_connect

from builder.jsontypes import JsonObject

logger = logging.getLogger(__name__)

DEFAULT_PORTAL_BASE_URL = "http://127.0.0.1:9320"
DEFAULT_CHATS_BASE_URL = "http://127.0.0.1:9321"
DEFAULT_TIMEOUT_S = 10.0
# "retries x2 on connect errors" (spec/06 §1 preamble) = 1 initial attempt + 2 retries.
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_READINESS_TIMEOUT_S = 120.0
DEFAULT_READINESS_POLL_INTERVAL_S = 2.0

WsConnector = Callable[[], AbstractAsyncContextManager[Any]]
"""A zero-arg callable returning an async-context-managed websocket connection
(async-iterable over incoming frames) — the real default is a `websockets.connect(
url, ...)` call with the URL/timeout already bound; tests inject one pointed at a
real ephemeral-port fake server (ASGI transports can't do websocket upgrades)."""


class CmdChatError(Exception):
    """A cmdchat call to the local cmd instance failed after retries — a structured
    error surfaced to the UI (spec/06 §1 preamble), never a silent hang."""


@dataclass(frozen=True, slots=True)
class NewChatResult:
    session_id: str
    workspace_id: str | None
    pending_state: str


@dataclass(frozen=True, slots=True)
class SendResult:
    buffered: bool
    pending_state: str | None


@dataclass(frozen=True, slots=True)
class ChatMessage:
    """One decoded conversation-level message (spec/06 §1's `/messages` shape) —
    already decoded by cmd; this is a straight passthrough, "no raw-JSONL parsing
    in Wixy"."""

    index: int
    role: str
    kind: str  # text | tool_use | tool_result | thinking | error
    text: str | None
    timestamp: str
    tool_name: str | None
    truncated: bool


@dataclass(frozen=True, slots=True)
class ChatStatus:
    """`GET /sessions/<id>/status`'s fields this codebase actually consumes (spec/06
    §1: "prefer the `activity` field... over process liveness"), plus the raw body
    for anything a future caller needs that isn't modeled here yet."""

    activity: str | None
    process_kind: str | None
    handover_state: str | None
    raw: JsonObject


@dataclass(frozen=True, slots=True)
class PendingEvent:
    """One `/ws/chat-pending` transition event (spec/06 §1: "transition events
    carry `{session_id, state, message}`")."""

    session_id: str
    state: str
    message: str | None


@dataclass(frozen=True, slots=True)
class ReadyOutcome:
    kind: Literal["ready"] = "ready"


@dataclass(frozen=True, slots=True)
class FailedOutcome:
    """`reason` is `"workspace_failed"` / `"cli_failed"` (from a WS transition
    event), `"timeout"` (120s elapsed with no signal either way), or any other
    terminal `state` a future cmd version reports — surfaced verbatim rather than
    an enum so a new reason never gets silently swallowed."""

    reason: str
    message: str | None
    kind: Literal["failed"] = "failed"


ProvisioningOutcome = ReadyOutcome | FailedOutcome


def _json_object(response: httpx.Response) -> JsonObject:
    try:
        data = response.json()
    except ValueError as exc:
        raise CmdChatError(
            f"invalid JSON from {response.request.method} {response.request.url}: {exc}"
        ) from exc
    if not isinstance(data, dict):
        raise CmdChatError(
            f"expected a JSON object from {response.request.url}, got {type(data).__name__}"
        )
    return data


def _message_from_dict(data: object) -> ChatMessage | None:
    """Defensive parse — an unrecognized/malformed entry is skipped, not fatal
    (matches `wixy_server.ledger`'s own `_entry_from_dict` convention), since one
    bad message shouldn't blank the whole transcript."""
    if not isinstance(data, dict):
        return None
    index = data.get("index")
    role = data.get("role")
    kind = data.get("kind")
    timestamp = data.get("timestamp")
    if not isinstance(index, int) or isinstance(index, bool):
        return None
    if not isinstance(role, str) or not isinstance(kind, str) or not isinstance(timestamp, str):
        return None
    text = data.get("text")
    tool_name = data.get("tool_name")
    return ChatMessage(
        index=index,
        role=role,
        kind=kind,
        text=text if isinstance(text, str) else None,
        timestamp=timestamp,
        tool_name=tool_name if isinstance(tool_name, str) else None,
        truncated=bool(data.get("truncated", False)),
    )


def _pending_event_from_raw(raw: str | bytes) -> PendingEvent | None:
    """`None` for anything that isn't a `{session_id, state, ...}` transition event
    — including the hello frame (`{type: "hello", pending: [...]}`), which has no
    `session_id`/`state` at the top level and is otherwise ignored (nothing in this
    client needs the initial pending-chat listing)."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError, TypeError, UnicodeDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    session_id = data.get("session_id")
    state = data.get("state")
    if not isinstance(session_id, str) or not isinstance(state, str):
        return None
    message = data.get("message")
    return PendingEvent(
        session_id=session_id, state=state, message=message if isinstance(message, str) else None
    )


def _http_ws_url(http_base_url: str, path: str) -> str:
    if http_base_url.startswith("https://"):
        return "wss://" + http_base_url[len("https://") :] + path
    if http_base_url.startswith("http://"):
        return "ws://" + http_base_url[len("http://") :] + path
    raise ValueError(f"unsupported base URL scheme: {http_base_url!r}")


@dataclass(slots=True)
class _RetryState:
    """Just a box for the last transport error, so `_request`'s final `raise ...
    from` can cite it — `httpx.TransportError` subclasses vary (`ConnectError`,
    `ConnectTimeout`, `ReadTimeout`, ...) so this stays untyped-but-narrow rather
    than picking one."""

    last_error: Exception | None = field(default=None)


class CmdChatClient:
    def __init__(
        self,
        *,
        portal_base_url: str = DEFAULT_PORTAL_BASE_URL,
        chats_base_url: str = DEFAULT_CHATS_BASE_URL,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        readiness_timeout_s: float = DEFAULT_READINESS_TIMEOUT_S,
        readiness_poll_interval_s: float = DEFAULT_READINESS_POLL_INTERVAL_S,
        transport: httpx.AsyncBaseTransport | None = None,
        ws_connect: WsConnector | None = None,
    ) -> None:
        self._portal_base_url = portal_base_url.rstrip("/")
        self._chats_base_url = chats_base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._max_attempts = max_attempts
        self._readiness_timeout_s = readiness_timeout_s
        self._readiness_poll_interval_s = readiness_poll_interval_s
        self._client = httpx.AsyncClient(transport=transport)
        ws_url = _http_ws_url(self._portal_base_url, "/ws/chat-pending")
        self._ws_connect: WsConnector = (
            ws_connect
            if ws_connect is not None
            else (lambda: websockets_connect(ws_url, open_timeout=self._timeout_s))
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> CmdChatClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def _request(
        self,
        method: str,
        url: str,
        *,
        json_body: JsonObject | None = None,
        params: dict[str, str] | None = None,
    ) -> httpx.Response:
        retry = _RetryState()
        for attempt in range(1, self._max_attempts + 1):
            try:
                return await self._client.request(
                    method, url, json=json_body, params=params, timeout=self._timeout_s
                )
            except httpx.TransportError as exc:
                retry.last_error = exc
                logger.warning(
                    "cmdchat: %s %s attempt %d/%d failed: %s",
                    method,
                    url,
                    attempt,
                    self._max_attempts,
                    exc,
                )
        raise CmdChatError(
            f"{method} {url} failed after {self._max_attempts} attempts: {retry.last_error}"
        ) from retry.last_error

    # -- Portal (9320): lifecycle -------------------------------------------------

    async def new_chat(self, cmd_project: str, prompt: str) -> NewChatResult:
        url = f"{self._portal_base_url}/api/project/{cmd_project}/new-chat"
        response = await self._request("POST", url, json_body={"prompt": prompt})
        if response.status_code != 202:
            raise CmdChatError(
                f"new-chat for project '{cmd_project}' returned {response.status_code}: "
                f"{response.text[:500]}"
            )
        body = _json_object(response)
        session_id = body.get("session_id")
        if not isinstance(session_id, str):
            raise CmdChatError(f"new-chat response missing session_id: {body!r}")
        workspace_id = body.get("workspace_id")
        pending_state = body.get("pending_state")
        return NewChatResult(
            session_id=session_id,
            workspace_id=workspace_id if isinstance(workspace_id, str) else None,
            pending_state=pending_state if isinstance(pending_state, str) else "queued",
        )

    async def _session_ready(self, session_id: str) -> bool:
        url = f"{self._portal_base_url}/api/session/{session_id}"
        response = await self._request("GET", url)
        if response.status_code == 200:
            return True
        if response.status_code == 404:
            return False
        raise CmdChatError(
            f"GET session {session_id} returned {response.status_code}: {response.text[:500]}"
        )

    async def get_chain(self, session_id: str) -> list[str]:
        """The root->leaf handover chain (spec/06 §1: "adopt the LAST element as
        the live session id")."""
        url = f"{self._portal_base_url}/api/session/{session_id}/chain"
        response = await self._request("GET", url)
        if response.status_code != 200:
            raise CmdChatError(
                f"GET chain for {session_id} returned {response.status_code}: {response.text[:500]}"
            )
        body = _json_object(response)
        chain_raw = body.get("chain")
        if not isinstance(chain_raw, list):
            raise CmdChatError(f"chain response malformed: {body!r}")
        chain = [s for s in chain_raw if isinstance(s, str)]
        if len(chain) != len(chain_raw):
            raise CmdChatError(f"chain response malformed: {body!r}")
        return chain

    async def send_message(self, session_id: str, text: str, idempotency_key: str) -> SendResult:
        url = f"{self._portal_base_url}/api/session/{session_id}/send"
        response = await self._request(
            "POST", url, json_body={"text": text, "idempotency_key": idempotency_key}
        )
        if response.status_code != 202:
            raise CmdChatError(
                f"send to {session_id} returned {response.status_code}: {response.text[:500]}"
            )
        body = _json_object(response)
        pending_state = body.get("pending_state")
        return SendResult(
            buffered=bool(body.get("buffered", False)),
            pending_state=pending_state if isinstance(pending_state, str) else None,
        )

    async def watch_pending(self) -> AsyncIterator[PendingEvent]:
        """Best-effort subscription to `/ws/chat-pending` — yields transition
        events as they arrive. A single connect attempt, no retry loop: spec/06 §1
        explicitly treats WS absence as a graceful degradation ("If the WS is
        unavailable, the 120s timeout is the terminal signal"), not a fault to
        recover from. Any connect/protocol failure just ends the generator quietly.
        """
        try:
            async with self._ws_connect() as ws:
                async for raw in ws:
                    event = _pending_event_from_raw(raw)
                    if event is not None:
                        yield event
        except Exception:
            logger.info("cmdchat: chat-pending WS unavailable or ended early", exc_info=True)
            return

    async def wait_until_ready(self, session_id: str) -> ProvisioningOutcome:
        """Races a bounded readiness poll against a best-effort websocket watch for
        an early failure signal; whichever resolves first wins and the other is
        cancelled. `CmdChatError` (cmd itself unreachable — connect refused after
        retries) propagates to the caller rather than being folded into
        `FailedOutcome`, so a "cmd is down" offline banner (spec/06 §3) can be told
        apart from a genuine `workspace_failed`/`cli_failed`/`timeout`.
        """
        outcome: ProvisioningOutcome | None = None
        done = anyio.Event()

        def _resolve(value: ProvisioningOutcome) -> None:
            nonlocal outcome
            if outcome is None:
                outcome = value
                done.set()

        async def _poll() -> None:
            deadline = anyio.current_time() + self._readiness_timeout_s
            while outcome is None and anyio.current_time() < deadline:
                if await self._session_ready(session_id):
                    _resolve(ReadyOutcome())
                    return
                await anyio.sleep(self._readiness_poll_interval_s)
            _resolve(
                FailedOutcome(
                    reason="timeout", message="timed out waiting for the conversation to start"
                )
            )

        async def _watch() -> None:
            async for event in self.watch_pending():
                if outcome is not None:
                    return
                if event.session_id == session_id and event.state in (
                    "workspace_failed",
                    "cli_failed",
                ):
                    _resolve(FailedOutcome(reason=event.state, message=event.message))
                    return

        try:
            async with anyio.create_task_group() as tg:
                tg.start_soon(_poll)
                tg.start_soon(_watch)
                await done.wait()
                tg.cancel_scope.cancel()
        except BaseExceptionGroup as eg:
            # `_poll`'s `CmdChatError` (cmd unreachable) is the only exception
            # either child task can raise -- `_watch` only ever returns normally
            # or is cancelled -- but anyio/asyncio task groups always wrap even a
            # single child exception in a group, which would otherwise defeat a
            # caller's `except CmdChatError` (see this method's own docstring).
            # Unwrap when there's exactly one; an unexpected 2+ case is left
            # wrapped rather than arbitrarily discarding one.
            if len(eg.exceptions) == 1:
                raise eg.exceptions[0] from None
            raise

        assert outcome is not None  # `done` only ever sets after `_resolve` assigns it
        return outcome

    # -- Cmd-Chats (9321): transcript introspection --------------------------------

    async def get_messages(
        self,
        session_id: str,
        *,
        limit: int = 80,
        include_tools: bool = True,
        before: int | None = None,
        include_thinking: bool = False,
    ) -> list[ChatMessage]:
        url = f"{self._chats_base_url}/sessions/{session_id}/messages"
        params = {"limit": str(limit), "include_tools": "true" if include_tools else "false"}
        if before is not None:
            params["before"] = str(before)
        if include_thinking:
            params["include_thinking"] = "true"
        response = await self._request("GET", url, params=params)
        if response.status_code != 200:
            raise CmdChatError(
                f"GET messages for {session_id} returned {response.status_code}: "
                f"{response.text[:500]}"
            )
        body = _json_object(response)
        raw_messages = body.get("messages")
        if not isinstance(raw_messages, list):
            raise CmdChatError(f"messages response malformed: {body!r}")
        return [m for m in (_message_from_dict(item) for item in raw_messages) if m is not None]

    async def get_status(self, session_id: str) -> ChatStatus:
        url = f"{self._chats_base_url}/sessions/{session_id}/status"
        response = await self._request("GET", url)
        if response.status_code != 200:
            raise CmdChatError(
                f"GET status for {session_id} returned {response.status_code}: "
                f"{response.text[:500]}"
            )
        body = _json_object(response)
        activity = body.get("activity")
        handover_state = body.get("handover_state")
        process = body.get("process")
        process_kind = process.get("kind") if isinstance(process, dict) else None
        return ChatStatus(
            activity=activity if isinstance(activity, str) else None,
            process_kind=process_kind if isinstance(process_kind, str) else None,
            handover_state=handover_state if isinstance(handover_state, str) else None,
            raw=body,
        )
