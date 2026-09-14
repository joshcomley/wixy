"""`/api/admin/server/*` — the PIN-protected admin live chat (spec/server-chat/
00-brief.md §5.1/§5.2/§5.3/§5.4/§5.7). P1 implements unlock, history, send,
stream and usage; P2b adds uploads (§5.5) and media (§5.6); P3b adds push (§5.8).

Every route here (except `POST /unlock`, which has no token yet) calls
`require_server_token` FIRST — a missing/invalid/expired token is a 401
`{"error":"locked"}` (Inv 41), and the client locks on any 401 it sees.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import AsyncGenerator, AsyncIterator

import anyio
from anyio.abc import TaskGroup
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from builder.jsontypes import JsonObject
from wixy_server.livechat.models import EventRow, MessageHook, MessageRow, message_json
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import PinVerifier
from wixy_server.livechat.store import LiveChatStore, UnusableAttachmentError
from wixy_server.livechat.tokens import (
    MediaSigner,
    ServerAuth,
    mint_unlock_token,
    require_server_token,
)
from wixy_server.settings import Settings

router = APIRouter(prefix="/api/admin/server")

_PING_INTERVAL_S = 15.0
_NOTIFIER_WAIT_S = 2.0
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")


def _invalid(detail: str) -> JSONResponse:
    """§5.3's 422 shape — literal `{"error":"invalid","detail":...}`, not FastAPI's
    default per-field validation-error array. Used for every BUSINESS rule (empty
    message, bad sender, too-long field, unusable attachment) — a malformed/missing
    JSON field still gets FastAPI's own generic 422 via pydantic, which is fine:
    that's a different failure class (the request isn't even shaped right) than
    these named business rejections."""
    return JSONResponse(status_code=422, content={"error": "invalid", "detail": detail})


# ---------------------------------------------------------------------------
# POST /unlock (§5.1) — the ONLY route with no token requirement.
# ---------------------------------------------------------------------------


class UnlockIn(BaseModel):
    # §5.1 v1.4: "wixy validates 4-16 digits locally and does not call cmd below
    # that" — cmd charges an attempt BEFORE checking it, so a stray keypress must
    # never reach the PIN service at all. Pydantic 422s a bad shape before this
    # route's body ever runs, so `verifier.verify()` is simply never called.
    pin: str = Field(pattern=r"^\d{4,16}$")


@router.post("/unlock", response_model=None)
async def unlock(body: UnlockIn, request: Request) -> JSONResponse:
    verifier: PinVerifier | None = request.app.state.livechat_pin_verifier
    access_email = getattr(request.state, "access_email", None) or ""

    if verifier is None:
        # Standalone edition (no cmd here) — R4: "there's no PIN verifier, so
        # /unlock -> 503 not_configured." Closed, never open.
        return JSONResponse(status_code=503, content={"error": "not_configured"})

    result = await verifier.verify(pin=body.pin, subject=access_email)

    if result.outcome == "ok":
        secret: bytes = request.app.state.livechat_secret
        token, expires_at = mint_unlock_token(secret, email=access_email, now=time.time())
        return JSONResponse(status_code=200, content={"token": token, "expiresAt": expires_at})
    if result.outcome == "wrong_pin":
        return JSONResponse(
            status_code=401,
            content={"error": "wrong_pin", "attemptsLeft": result.attempts_left},
        )
    if result.outcome == "locked_out":
        retry_after = result.retry_after_s if result.retry_after_s is not None else 1
        return JSONResponse(
            status_code=429,
            content={"error": "locked_out", "retryAfterS": retry_after},
            headers={"Retry-After": str(retry_after)},
        )
    if result.outcome == "pin_changed":
        # §5.1 v1.4: the PIN rotated mid-check on cmd's side. Nothing was spent —
        # the owner just tries again.
        return JSONResponse(status_code=409, content={"error": "pin_changed"})
    if result.outcome == "not_configured":
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    return JSONResponse(status_code=503, content={"error": "pin_service_unavailable"})


# ---------------------------------------------------------------------------
# GET /messages (§5.2) — history paging.
# ---------------------------------------------------------------------------


@router.get("/messages", response_model=None)
async def get_history(request: Request, before: int | None = None, limit: int = 50) -> JsonObject:
    auth = require_server_token(request)
    if not (1 <= limit <= 100):
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")

    store: LiveChatStore = request.app.state.livechat_store
    secret: bytes = request.app.state.livechat_secret
    signer = MediaSigner.for_auth(secret, auth)

    def _list() -> tuple[list[MessageRow], bool, int]:
        return store.list_messages(before=before, limit=limit)

    messages, has_more, cursor = await anyio.to_thread.run_sync(_list)
    return {
        "messages": [message_json(m, signer) for m in messages],
        "hasMore": has_more,
        "cursor": cursor,
    }


# ---------------------------------------------------------------------------
# POST /messages (§5.3) — send.
# ---------------------------------------------------------------------------


class SendMessageIn(BaseModel):
    clientId: str
    sender: str
    deviceId: str
    text: str | None = None
    attachmentIds: list[str] = Field(default_factory=list)


@router.post("/messages", response_model=None)
async def send_message(body: SendMessageIn, request: Request) -> JSONResponse:
    auth = require_server_token(request)

    if not (8 <= len(body.clientId) <= 64):
        return _invalid("clientId must be 8-64 characters")
    if not (8 <= len(body.deviceId) <= 64):
        return _invalid("deviceId must be 8-64 characters")
    sender = body.sender.strip()
    if not (1 <= len(sender) <= 32) or _CONTROL_CHAR_RE.search(sender):
        return _invalid("sender must be 1-32 characters with no control characters")
    text = body.text
    if text is not None and len(text) > 4000:
        return _invalid("text must be at most 4000 characters")
    if not text and not body.attachmentIds:
        return _invalid("a message needs text or at least one attachment")
    if len(body.attachmentIds) > 10:
        return _invalid("at most 10 attachments per message")

    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    hooks: list[MessageHook] = request.app.state.livechat_message_hooks
    background: TaskGroup = request.app.state.background_tasks
    secret: bytes = request.app.state.livechat_secret
    now = time.time()

    def _create() -> tuple[MessageRow, bool]:
        return store.create_message(
            client_id=body.clientId,
            sender=sender,
            device_id=body.deviceId,
            by_email=auth.email or None,
            text=text,
            attachment_ids=body.attachmentIds,
            now=now,
        )

    try:
        message, created = await anyio.to_thread.run_sync(_create)
    except UnusableAttachmentError as exc:
        return _invalid(f"attachment {exc.attachment_id} is unknown, already used, or failed")

    if created:
        notifier.publish()
        for hook in hooks:
            # `TaskGroup.start_soon` wants a `Callable[..., Coroutine]`, not the
            # broader `Awaitable`-returning `MessageHook` shape the frozen spec
            # gives `livechat_message_hooks` — a tiny wrapper coroutine bridges
            # the two (default arg captures THIS iteration's `hook`, not the
            # loop variable at completion time).
            async def _dispatch(h: MessageHook = hook) -> None:
                await h(message)

            background.start_soon(_dispatch)

    signer = MediaSigner.for_auth(secret, auth)
    return JSONResponse(
        status_code=201 if created else 200,
        content={"message": message_json(message, signer)},
    )


# ---------------------------------------------------------------------------
# GET /stream (§5.4, §3's SSE loop) — SSE over fetch(), not EventSource/WebSocket.
# ---------------------------------------------------------------------------


def _format_sse(event: str, data: JsonObject, *, event_id: int | None = None) -> str:
    lines: list[str] = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines.append(f"data: {json.dumps(data)}")
    return "\n".join(lines) + "\n\n"


async def _stream_events(
    store: LiveChatStore,
    notifier: LiveChatNotifier,
    secret: bytes,
    auth: ServerAuth,
    after: int,
) -> AsyncGenerator[str]:
    """§3's per-connection loop. Typed as the more specific `AsyncGenerator` (not
    just `AsyncIterator`) so a test can drive this directly and `.aclose()` it —
    same reasoning as `routes_chat.py::_stream_events`'s own note."""
    cursor = after
    last_ping = anyio.current_time()

    while True:
        if auth.exp <= time.time():
            # §6 R6: reaching the token's expiresAt locks. §5.4: "the token
            # expired mid-stream; the server closes after it."
            yield _format_sse("locked", {})
            return

        if anyio.current_time() - last_ping >= _PING_INTERVAL_S:
            last_ping = anyio.current_time()
            yield ": ping\n\n"

        events = await anyio.to_thread.run_sync(store.events_after, cursor)

        if not events:
            # §3 step 3: the 2 s re-check is what covers a sibling process's
            # write during a blue/green overlap (`notifier` only wakes THIS
            # process's own waiters — see notifier.py's own docstring).
            await notifier.wait(timeout_s=_NOTIFIER_WAIT_S)
            continue

        # Forward progress first, regardless of what's emitted below — an event
        # whose message somehow can't be loaded must still never be re-fetched
        # forever.
        cursor = max(event.event_seq for event in events)

        # §17.2 A1: 'wiped' carries no message_seq (NULL), so it's tracked
        # separately from the per-message groups below rather than colliding
        # every 'wiped' event onto a fake `None` group key.
        groups: dict[int, list[EventRow]] = {}
        order: list[int] = []
        wiped_events: list[EventRow] = []
        for event in events:
            if event.type == "wiped":
                wiped_events.append(event)
                continue
            message_seq = event.message_seq
            assert message_seq is not None  # every non-'wiped' event carries one
            if message_seq not in groups:
                groups[message_seq] = []
                order.append(message_seq)
            groups[message_seq].append(event)

        messages = await anyio.to_thread.run_sync(store.get_messages, order)
        by_seq = {message.seq: message for message in messages}
        signer = MediaSigner.for_auth(secret, auth)

        for message_seq in order:
            group = groups[message_seq]
            message = by_seq.get(message_seq)
            event_id = max(e.event_seq for e in group)
            if message is None:
                # §17.2 A1: a genuine delete emits 'message_deleted'; a
                # 'message'/'message_updated' whose row is now gone (deleted
                # concurrently, e.g. by P8's future delete route) is SKIPPED
                # entirely rather than sent with nothing to show.
                if any(e.type == "message_deleted" for e in group):
                    yield _format_sse("message_deleted", {"seq": message_seq}, event_id=event_id)
                continue
            # "Coalescing per message": one SSE frame per message per batch,
            # carrying the CURRENT full message JSON — a 'message' + a later
            # 'message_updated' for the same message in one batch collapse into
            # a single frame, typed 'message' (a genuinely new message matters
            # more to the client than an attachment-status change riding along).
            event_type = "message" if any(e.type == "message" for e in group) else "message_updated"
            yield _format_sse(event_type, message_json(message, signer), event_id=event_id)

        if wiped_events:
            # Coalesced too: however many 'wiped' events landed in one batch
            # (there should only ever be one), the client only needs to hear it
            # once.
            wiped_id = max(e.event_seq for e in wiped_events)
            yield _format_sse("wiped", {}, event_id=wiped_id)


@router.get("/stream")
async def stream(request: Request, after: int = 0) -> StreamingResponse:
    auth = require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    secret: bytes = request.app.state.livechat_secret

    async def _events() -> AsyncIterator[str]:
        async for payload in _stream_events(store, notifier, secret, auth, after):
            yield payload

    return StreamingResponse(
        _events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# GET /usage (§5.7).
# ---------------------------------------------------------------------------


@router.get("/usage", response_model=None)
async def usage(request: Request) -> JsonObject:
    require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    settings: Settings = request.app.state.settings
    media_available: bool = request.app.state.livechat_media_available

    used_bytes = await anyio.to_thread.run_sync(store.media_bytes_used)
    quota_bytes = settings.server_media_quota_bytes
    return {
        "usedBytes": used_bytes,
        "quotaBytes": quota_bytes,
        "freeBytes": max(0, quota_bytes - used_bytes),
        "mediaAvailable": media_available,
    }
