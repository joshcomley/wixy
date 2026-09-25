"""`/api/admin/server/*` — the PIN-protected admin live chat (spec/server-chat/
00-brief.md §5.1/§5.2/§5.3/§5.4/§5.7). P1 implements unlock, history, send,
stream and usage; P2b adds uploads (§5.5) and media (§5.6); P3b adds push (§5.8).

Every route here (except `POST /unlock`, which has no token yet) calls
`require_server_token` FIRST — a missing/invalid/expired token is a 401
`{"error":"locked"}` (Inv 41), and the client locks on any 401 it sees. `POST /unlock`
instead runs `unlock_request_refusal` FIRST (custom guard header + strict JSON content
type + same-origin `Sec-Fetch-Site`), so a cross-site page cannot make cmd charge
PIN attempts against the owner.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Any, Literal

import anyio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from builder.jsontypes import JsonObject
from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat import janitor as livechat_janitor
from wixy_server.livechat.models import (
    EventRow,
    MessageHook,
    MessageRow,
    PushSubscriptionRow,
    message_json,
)
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import PinVerifier
from wixy_server.livechat.push import PushEndpointError, validate_push_endpoint
from wixy_server.livechat.store import (
    LiveChatStore,
    UnusableAttachmentError,
)
from wixy_server.livechat.tokens import (
    MediaSigner,
    ServerAuth,
    mint_unlock_token,
    require_server_token,
    unlock_request_refusal,
)
from wixy_server.settings import Settings
from wixy_server.storage import ProjectPaths

router = APIRouter(prefix="/api/admin/server")
_LOGGER = logging.getLogger(__name__)

_PING_INTERVAL_S = 15.0
_NOTIFIER_WAIT_S = 2.0
_DELETE_SCRUB_DEADLINE_S = 10.0
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")


def _invalid(detail: str) -> JSONResponse:
    """§5.3's 422 shape — literal `{"error":"invalid","detail":...}`, not FastAPI's
    default per-field validation-error array. Used for every BUSINESS rule (empty
    message, bad sender, too-long field, unusable attachment) — a malformed/missing
    JSON field still gets FastAPI's own generic 422 via pydantic, which is fine:
    that's a different failure class (the request isn't even shaped right) than
    these named business rejections."""
    return JSONResponse(status_code=422, content={"error": "invalid", "detail": detail})


def _scrub_pending_locked(store: LiveChatStore, *, deadline_at: float) -> bool:
    """Scrub and clear the current marker within the mutation's full deadline."""
    remaining = deadline_at - time.monotonic()
    if remaining <= 0:
        return False
    with store.scrub_guard(timeout_s=remaining) as acquired:
        if not acquired:
            return False
        pending_token = store.scrub_pending_token()
        if pending_token is None:
            # The background worker may already have completed this request's scrub.
            return True
        remaining = deadline_at - time.monotonic()
        if remaining <= 0 or not store.scrub(deadline_s=remaining):
            return False
        if not store.clear_scrub_pending(expected_token=pending_token):
            return False
        try:
            store.scrub(deadline_s=min(0.25, max(0.0, deadline_at - time.monotonic())))
        except Exception:
            _LOGGER.warning(
                "Best-effort checkpoint after clearing pending scrub failed", exc_info=True
            )
        return True


async def _finish_committed_erasure(
    *,
    store: LiveChatStore,
    paths: ProjectPaths,
    notifier: LiveChatNotifier,
    attachment_ids: list[str],
    upload_ids: list[str],
    wipe_token: str | None,
    deadline_at: float,
) -> Response:
    """Finish best-effort work after commit; committed mutations never return 5xx."""
    try:
        notifier.publish()
        items = {
            item
            for storage_id in attachment_ids
            for item in (("attachment", storage_id), ("upload", storage_id))
        }
        items.update(("upload", storage_id) for storage_id in upload_ids)
        await anyio.to_thread.run_sync(
            lambda: livechat_janitor.cleanup_deleted_storage_once(
                store=store, paths=paths, only_items=items
            )
        )
        if wipe_token is not None:
            await anyio.to_thread.run_sync(
                lambda: livechat_janitor.cleanup_unreferenced_storage_once(store=store, paths=paths)
            )
        await anyio.to_thread.run_sync(
            lambda: _scrub_pending_locked(store, deadline_at=deadline_at)
        )
        erasure_pending = await anyio.to_thread.run_sync(
            lambda: store.scrub_pending() or store.storage_cleanup_pending()
        )
    except Exception:
        _LOGGER.exception("Server chat erasure committed but synchronous cleanup did not finish")
        return JSONResponse(status_code=202, content={"erasurePending": True})
    if erasure_pending:
        return JSONResponse(status_code=202, content={"erasurePending": True})
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# POST /unlock (§5.1) — the ONLY route with no token requirement.
# ---------------------------------------------------------------------------


@router.post("/unlock", response_model=None)
async def unlock(request: Request) -> JSONResponse:
    # No token yet, so the token header cannot be this route's CSRF guard: refuse a
    # request a cross-site page could have sent BEFORE reading the body or calling cmd,
    # which charges an attempt before it checks (audit round 4, F14).
    refusal = unlock_request_refusal(request)
    if refusal is not None:
        _LOGGER.warning("Server chat unlock refused before cmd was contacted: %s", refusal.reason)
        return JSONResponse(status_code=refusal.status_code, content={"error": refusal.error})
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return JSONResponse(status_code=422, content={"error": "invalid_pin"})
    except UnicodeDecodeError:
        return JSONResponse(status_code=422, content={"error": "invalid_pin"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=422, content={"error": "invalid_pin"})

    verifier: PinVerifier | None = request.app.state.livechat_pin_verifier
    access_email = getattr(request.state, "access_email", None) or ""
    pin = body.get("pin")
    if (
        not isinstance(pin, str)
        or not pin.isascii()
        or not pin.isdecimal()
        or not 4 <= len(pin) <= 16
    ):
        return JSONResponse(status_code=422, content={"error": "invalid_pin"})

    if verifier is None:
        # Standalone edition (no cmd here) — R4: "there's no PIN verifier, so
        # /unlock -> 503 not_configured." Closed, never open.
        return JSONResponse(status_code=503, content={"error": "not_configured"})

    result = await verifier.verify(pin=pin, subject=access_email)

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
    if result.outcome == "invalid_request":
        # §5.1's mapping table: cmd's 400 invalid_request -> wixy 422, never a
        # closed-fail 503 — "wixy validates first, so this is a wixy bug."
        # Provably unreachable via any real user path (manual 4-16 ASCII digit
        # validation above rejects anything that could trigger it), but the
        # frozen contract still specifies this exact mapping.
        return _invalid("cmd rejected the PIN request as malformed — this is a wixy-side bug")
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
    # Typed loosely (round 2 ruling item 10 §(3)) rather than `int | None`:
    # pydantic v2 silently coerces `True`/`False` to `1`/`0` for an `int`
    # field (measured 2026-09-25), which would make a boolean indistinguishable
    # from a real seq by the time this model is built. The route below does
    # every real check by hand, exactly like every other business rule in this
    # handler (`_invalid(...)`, not FastAPI's generic per-field 422).
    replyToSeq: Any = None


class WipeChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm: Literal["WIPE"]


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
    reply_to_seq: int | None = None
    if body.replyToSeq is not None:
        if (
            isinstance(body.replyToSeq, bool)
            or not isinstance(body.replyToSeq, int)
            or body.replyToSeq < 1
        ):
            return _invalid("replyToSeq must be an integer >= 1")
        reply_to_seq = body.replyToSeq

    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    hooks: list[MessageHook] = request.app.state.livechat_message_hooks
    background: ContainedTaskGroup = request.app.state.background_tasks
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
            reply_to_seq=reply_to_seq,
            now=now,
        )

    try:
        message, created = await anyio.to_thread.run_sync(_create)
    except UnusableAttachmentError as exc:
        return _invalid(f"attachment {exc.attachment_id} is unknown, already used, or failed")

    if created:
        notifier.publish()
        for hook in hooks:
            # The contained group accepts positional arguments, not the
            # broader `Awaitable`-returning `MessageHook` shape the frozen spec
            # gives `livechat_message_hooks` — a tiny wrapper coroutine bridges
            # the two (default arg captures THIS iteration's `hook`, not the
            # loop variable at completion time).
            async def _dispatch(h: MessageHook = hook) -> None:
                await h(message)

            background.spawn("livechat-push-dispatch", _dispatch)

    signer = MediaSigner.for_auth(secret, auth)
    return JSONResponse(
        status_code=201 if created else 200,
        content={"message": message_json(message, signer)},
    )


@router.delete("/messages/{seq}", response_model=None)
async def delete_message(seq: int, request: Request) -> Response:
    require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    paths: ProjectPaths = request.app.state.paths
    notifier: LiveChatNotifier = request.app.state.livechat_notifier

    attachment_ids, _pending_token = await anyio.to_thread.run_sync(
        lambda: store.delete_message_for_scrub(seq=seq, now=time.time())
    )
    commit_returned_at = time.monotonic()
    return await _finish_committed_erasure(
        store=store,
        paths=paths,
        notifier=notifier,
        attachment_ids=attachment_ids,
        upload_ids=[],
        wipe_token=None,
        deadline_at=commit_returned_at + _DELETE_SCRUB_DEADLINE_S,
    )


@router.post("/wipe", response_model=None)
async def wipe_chat(body: WipeChatIn, request: Request) -> Response:
    require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    paths: ProjectPaths = request.app.state.paths
    notifier: LiveChatNotifier = request.app.state.livechat_notifier

    attachment_ids, upload_ids, _pending_token, wipe_token = await anyio.to_thread.run_sync(
        lambda: store.wipe_for_scrub(now=time.time())
    )
    commit_returned_at = time.monotonic()
    return await _finish_committed_erasure(
        store=store,
        paths=paths,
        notifier=notifier,
        attachment_ids=attachment_ids,
        upload_ids=upload_ids,
        wipe_token=wipe_token,
        deadline_at=commit_returned_at + _DELETE_SCRUB_DEADLINE_S,
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

        # Coalesce message events only within the region between wipes. A wipe
        # is an ordering boundary: a later message in this batch must be sent
        # after the wipe so clients never clear newer content or regress their
        # event cursor.
        batches: list[dict[int, list[EventRow]] | EventRow] = []
        groups: dict[int, list[EventRow]] = {}
        for event in events:
            if event.type == "wiped":
                if groups:
                    batches.append(groups)
                    groups = {}
                batches.append(event)
                continue
            message_seq = event.message_seq
            assert message_seq is not None  # every non-'wiped' event carries one
            if message_seq not in groups:
                groups[message_seq] = []
            groups[message_seq].append(event)
        if groups:
            batches.append(groups)

        signer = MediaSigner.for_auth(secret, auth)
        for batch in batches:
            if isinstance(batch, EventRow):
                yield _format_sse("wiped", {}, event_id=batch.event_seq)
                continue
            order = sorted(
                batch,
                key=lambda message_seq: max(event.event_seq for event in batch[message_seq]),
            )
            messages = await anyio.to_thread.run_sync(store.get_messages, order)
            by_seq = {message.seq: message for message in messages}
            for message_seq in order:
                group = batch[message_seq]
                message = by_seq.get(message_seq)
                event_id = max(e.event_seq for e in group)
                if message is None:
                    # A genuine delete emits 'message_deleted'; a stale
                    # message event whose row vanished is skipped.
                    if any(e.type == "message_deleted" for e in group):
                        yield _format_sse(
                            "message_deleted", {"seq": message_seq}, event_id=event_id
                        )
                    continue
                # Coalesce per message within this no-wipe region, carrying the
                # current full message JSON.
                event_type = (
                    "message" if any(e.type == "message" for e in group) else "message_updated"
                )
                yield _format_sse(event_type, message_json(message, signer), event_id=event_id)


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
        "erasurePending": await anyio.to_thread.run_sync(
            lambda: store.scrub_pending() or store.storage_cleanup_pending()
        ),
    }


# ---------------------------------------------------------------------------
# Push subscriptions (§5.8).
# ---------------------------------------------------------------------------


class PushKeysIn(BaseModel):
    p256dh: str
    auth: str


class PushSubscriptionIn(BaseModel):
    endpoint: str
    keys: PushKeysIn


class PushSubscriptionUpsertIn(BaseModel):
    sender: str
    subscription: PushSubscriptionIn


@router.get("/push/config", response_model=None)
async def push_config(request: Request) -> JsonObject:
    require_server_token(request)
    keys = request.app.state.livechat_vapid_keys
    return {"publicKey": keys.public_key_b64}


@router.get("/push/subscriptions/{device_id}", response_model=None)
async def push_subscription_status(device_id: str, request: Request) -> JsonObject:
    require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    subscription = await anyio.to_thread.run_sync(store.get_push_subscription, device_id)
    return {"subscribed": subscription is not None}


@router.put("/push/subscriptions/{device_id}", response_model=None)
async def put_push_subscription(
    device_id: str, body: PushSubscriptionUpsertIn, request: Request
) -> Response:
    require_server_token(request)
    sender = body.sender.strip()
    if not (1 <= len(sender) <= 32) or _CONTROL_CHAR_RE.search(sender):
        return _invalid("sender must be 1-32 characters with no control characters")
    try:
        validate_push_endpoint(body.subscription.endpoint)
    except PushEndpointError as exc:
        return _invalid(str(exc))

    row = PushSubscriptionRow(
        device_id=device_id,
        sender=sender,
        endpoint=body.subscription.endpoint,
        p256dh=body.subscription.keys.p256dh,
        auth=body.subscription.keys.auth,
        created_at=time.time(),
        last_ok_at=None,
        consecutive_failures=0,
    )
    store: LiveChatStore = request.app.state.livechat_store
    await anyio.to_thread.run_sync(store.upsert_push_subscription, row)
    return Response(status_code=204)


@router.delete("/push/subscriptions/{device_id}", response_model=None)
async def delete_push_subscription(device_id: str, request: Request) -> Response:
    require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    await anyio.to_thread.run_sync(store.delete_push_subscription, device_id)
    return Response(status_code=204)
