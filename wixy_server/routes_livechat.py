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
import math
import re
import time
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Any, Literal

import anyio
import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from builder.jsontypes import JsonObject
from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat import janitor as livechat_janitor
from wixy_server.livechat.grants import (
    GRANT_ID_RE,
    GRANT_IDLE_EXPIRY_S,
    MAX_LIVE_GRANTS_PER_IDENTITY,
    GrantFailureLimiter,
    InvalidLabelError,
    clean_label,
    new_grant,
    secret_hash_from_wire,
)
from wixy_server.livechat.models import (
    EventRow,
    MessageHook,
    MessageRow,
    PushSubscriptionRow,
    TranscriptRow,
    message_json,
    transcript_json,
)
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import PinVerifier
from wixy_server.livechat.push import (
    PushEndpointError,
    VapidKeys,
    send_payloadless_push,
    validate_push_endpoint,
)
from wixy_server.livechat.reactions import is_allowed_reaction
from wixy_server.livechat.store import (
    AttachmentNotReadyError,
    LiveChatStore,
    MessageNotFoundError,
    UnusableAttachmentError,
)
from wixy_server.livechat.textcheck import has_unpaired_surrogate
from wixy_server.livechat.tokens import (
    MediaSigner,
    ServerAuth,
    mint_unlock_token,
    require_server_token,
    unlock_request_refusal,
)
from wixy_server.livechat.transcription import (
    SlidingWindowRateLimiter,
    TranscriptionRuntime,
)
from wixy_server.routes_livechat_media import _MEDIA_TYPE_BY_SUFFIX, _resolve_rendition_path
from wixy_server.settings import Settings
from wixy_server.storage import ProjectPaths

router = APIRouter(prefix="/api/admin/server")
_LOGGER = logging.getLogger(__name__)

_PING_INTERVAL_S = 15.0
_NOTIFIER_WAIT_S = 2.0
_DELETE_SCRUB_DEADLINE_S = 10.0
_ATTACHMENT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CLAIM_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")


def _valid_sender(sender: str) -> bool:
    """§5.3's sender rule (1-32 characters, trimmed, no control characters), plus the
    surrogate check (`textcheck.has_unpaired_surrogate`). Shared by every route that accepts
    a display name: `send_message`, `set_reaction`, and `put_push_subscription`."""
    return (
        1 <= len(sender) <= 32
        and _CONTROL_CHAR_RE.search(sender) is None
        and not has_unpaired_surrogate(sender)
    )


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


def _request_guard_refusal(request: Request, route: str) -> JSONResponse | None:
    """Refuse a request a cross-site page could have sent, BEFORE the body is read, cmd is
    called or a store is touched (audit round 4, F14). Shared by `/unlock` and every
    device-grant route (03-permanent-unlock.md §3), each of which either charges a PIN
    attempt or hands out a token."""
    refusal = unlock_request_refusal(request)
    if refusal is None:
        return None
    _LOGGER.warning("Server chat %s refused before doing anything: %s", route, refusal.reason)
    return JSONResponse(status_code=refusal.status_code, content={"error": refusal.error})


async def _json_object(request: Request) -> dict[str, object] | None:
    """The request body as a JSON object, or `None` for anything else (not JSON, not
    UTF-8, or not an object). Callers turn `None` into their own 422."""
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return None
    except UnicodeDecodeError:
        return None
    if not isinstance(body, dict):
        return None
    return body


async def _verify_pin(request: Request, pin: object) -> JSONResponse | None:
    """§5.1's PIN check — shape validation, cmd's verify, and the outcome -> status
    mapping — shared by `POST /unlock` and `POST /device-grants` (03 §3: "the same
    PinVerifier path ... the same 401/429/409/503/422 mapping and copy apply"). Returns
    the error response, or `None` when cmd said the PIN is right."""
    verifier: PinVerifier | None = request.app.state.livechat_pin_verifier
    access_email = getattr(request.state, "access_email", None) or ""
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
        return None
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


@router.post("/unlock", response_model=None)
async def unlock(request: Request) -> JSONResponse:
    # No token yet, so the token header cannot be this route's CSRF guard: refuse a
    # request a cross-site page could have sent BEFORE reading the body or calling cmd,
    # which charges an attempt before it checks (audit round 4, F14).
    refused = _request_guard_refusal(request, "unlock")
    if refused is not None:
        return refused
    body = await _json_object(request)
    if body is None:
        return JSONResponse(status_code=422, content={"error": "invalid_pin"})

    error = await _verify_pin(request, body.get("pin"))
    if error is not None:
        return error
    secret: bytes = request.app.state.livechat_secret
    access_email = getattr(request.state, "access_email", None) or ""
    token, expires_at = mint_unlock_token(secret, email=access_email, now=time.time())
    return JSONResponse(status_code=200, content={"token": token, "expiresAt": expires_at})


# ---------------------------------------------------------------------------
# Device grants (03-permanent-unlock.md §3, Inv 48) — "Keep this device unlocked".
# ---------------------------------------------------------------------------

_GRANT_INVALID = {"error": "grant_invalid"}
# These two responses carry a credential (the one-time secret, a fresh unlock token).
_NO_STORE = {"Cache-Control": "no-store"}


@router.post("/device-grants", response_model=None)
async def create_device_grant(request: Request) -> JSONResponse:
    """Enroll this device. Needs BOTH a valid unlock token (you are inside the unlocked
    chat) AND a PIN that cmd verifies right now — an attempt is charged exactly as for
    `/unlock`. The secret is returned here and nowhere else."""
    refused = _request_guard_refusal(request, "device-grants")
    if refused is not None:
        return refused
    auth = await require_server_token(request)
    body = await _json_object(request)
    if body is None:
        return JSONResponse(status_code=422, content={"error": "invalid_pin"})
    try:
        label = clean_label(body.get("label"))
    except InvalidLabelError as exc:
        return _invalid(str(exc))

    error = await _verify_pin(request, body.get("pin"))
    if error is not None:
        return error

    store: LiveChatStore = request.app.state.livechat_store
    secret: bytes = request.app.state.livechat_secret
    grant = new_grant()
    now = time.time()
    await anyio.to_thread.run_sync(
        lambda: store.create_device_grant(
            grant_id=grant.grant_id,
            secret_hash=grant.secret_hash,
            email=auth.email,
            label=label,
            now=now,
            max_live=MAX_LIVE_GRANTS_PER_IDENTITY,
        )
    )
    # §9: bound from the moment it is created — the device is going into permanent mode at
    # once, and an unbound token here would reopen the F4 hole for up to 12h.
    token, expires_at = mint_unlock_token(
        secret, email=auth.email, now=now, grant_id=grant.grant_id
    )
    return JSONResponse(
        status_code=201,
        content={
            "grantId": grant.grant_id,
            "secret": grant.secret,
            "token": token,
            "expiresAt": expires_at,
        },
        headers=_NO_STORE,
    )


@router.post("/unlock-with-grant", response_model=None)
async def unlock_with_grant(request: Request) -> JSONResponse:
    """Mint a normal unlock token from a device grant. No PIN, and cmd is never
    contacted. Every way this can fail is the same reason-free 401 `grant_invalid`."""
    refused = _request_guard_refusal(request, "unlock-with-grant")
    if refused is not None:
        return refused
    body = await _json_object(request)
    if body is None:
        return _invalid("expected a JSON object with grantId and secret")

    limiter: GrantFailureLimiter = request.app.state.livechat_grant_limiter
    store: LiveChatStore = request.app.state.livechat_store
    access_email = getattr(request.state, "access_email", None) or ""
    mono_now = time.monotonic()
    retry_after = limiter.retry_after_s(access_email, mono_now)
    if retry_after is not None:
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limited", "retryAfterS": retry_after},
            headers={"Retry-After": str(retry_after)},
        )

    grant_id = body.get("grantId")
    secret_hash = secret_hash_from_wire(body.get("secret"))
    now = time.time()
    valid = False
    bound_grant_id: str | None = None
    if isinstance(grant_id, str) and GRANT_ID_RE.fullmatch(grant_id) and secret_hash is not None:
        valid = await anyio.to_thread.run_sync(
            lambda: store.redeem_device_grant(
                grant_id=grant_id,
                secret_hash=secret_hash,
                email=access_email,
                now=now,
                max_idle_s=GRANT_IDLE_EXPIRY_S,
            )
        )
        if valid:
            bound_grant_id = grant_id
    if not valid:
        limiter.record_failure(access_email, mono_now)
        return JSONResponse(status_code=401, content=_GRANT_INVALID)

    secret: bytes = request.app.state.livechat_secret
    token, expires_at = mint_unlock_token(
        secret, email=access_email, now=now, grant_id=bound_grant_id
    )
    return JSONResponse(
        status_code=200,
        content={"token": token, "expiresAt": expires_at},
        headers=_NO_STORE,
    )


@router.delete("/device-grants/{grant_id}", response_model=None)
async def revoke_device_grant(grant_id: str, request: Request) -> Response:
    refused = _request_guard_refusal(request, "device-grants")
    if refused is not None:
        return refused
    auth = await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    found = False
    if GRANT_ID_RE.fullmatch(grant_id):
        found = await anyio.to_thread.run_sync(
            lambda: store.revoke_device_grant(grant_id=grant_id, email=auth.email, now=time.time())
        )
    if not found:
        # An unknown id and another identity's grant look exactly alike.
        return JSONResponse(status_code=404, content={"error": "not_found"})
    return Response(status_code=204)


@router.delete("/device-grants", response_model=None)
async def revoke_all_device_grants(request: Request) -> Response:
    refused = _request_guard_refusal(request, "device-grants")
    if refused is not None:
        return refused
    auth = await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    # §9 sub-ruling (ii): spare the caller's OWN grant when its session is bound to one, so
    # "other devices" is literally true and the click that fired this doesn't sign itself out.
    await anyio.to_thread.run_sync(
        lambda: store.revoke_all_device_grants(
            email=auth.email, now=time.time(), except_grant_id=auth.grant_id
        )
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# GET /messages (§5.2) — history paging.
# ---------------------------------------------------------------------------


@router.get("/messages", response_model=None)
async def get_history(request: Request, before: int | None = None, limit: int = 50) -> JsonObject:
    auth = await require_server_token(request)
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


class SetReactionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    emoji: str
    sender: str
    reacted: StrictBool


_SQLITE_MAX_INTEGER = 2**63 - 1


@router.post("/messages", response_model=None)
async def send_message(body: SendMessageIn, request: Request) -> JSONResponse:
    auth = await require_server_token(request)

    if not (8 <= len(body.clientId) <= 64):
        return _invalid("clientId must be 8-64 characters")
    if not (8 <= len(body.deviceId) <= 64):
        return _invalid("deviceId must be 8-64 characters")
    sender = body.sender.strip()
    if not _valid_sender(sender):
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
            or not (1 <= body.replyToSeq <= _SQLITE_MAX_INTEGER)
        ):
            # audit F7: a crafted replyToSeq >= 2**63 must 422 like any other
            # invalid shape, never reach SQLite and raise an OverflowError (500) —
            # the same range this file's own set_reaction route already guards.
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


class SendViewOnceMessageIn(BaseModel):
    clientId: str
    sender: str
    deviceId: str
    attachmentId: str
    durationS: int | None = None
    spotlight: StrictBool = False
    replyToSeq: Any = None


class OpenViewOnceIn(BaseModel):
    claimId: str
    sender: str


@router.post("/messages/view-once", response_model=None)
async def send_view_once_message(body: SendViewOnceMessageIn, request: Request) -> JSONResponse:
    auth = await require_server_token(request)

    if not (8 <= len(body.clientId) <= 64):
        return _invalid("clientId must be 8-64 characters")
    if not (8 <= len(body.deviceId) <= 64):
        return _invalid("deviceId must be 8-64 characters")
    sender = body.sender.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")
    if not _ATTACHMENT_ID_RE.match(body.attachmentId):
        return _invalid("attachmentId must be a 32-character hex string")
    if isinstance(body.durationS, bool) or body.durationS not in (None, 2, 5, 30):
        return _invalid("durationS must be 2, 5, 30, or null")

    reply_to_seq: int | None = None
    if body.replyToSeq is not None:
        if (
            isinstance(body.replyToSeq, bool)
            or not isinstance(body.replyToSeq, int)
            or not (1 <= body.replyToSeq <= _SQLITE_MAX_INTEGER)
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
        return store.create_view_once_message(
            client_id=body.clientId,
            sender=sender,
            device_id=body.deviceId,
            by_email=auth.email or None,
            attachment_id=body.attachmentId,
            duration_s=body.durationS,
            spotlight=body.spotlight,
            reply_to_seq=reply_to_seq,
            now=now,
        )

    try:
        message, created = await anyio.to_thread.run_sync(_create)
    except AttachmentNotReadyError:
        return JSONResponse(status_code=422, content={"error": "not_ready"})
    except UnusableAttachmentError as exc:
        return _invalid(
            f"attachment {exc.attachment_id} is unknown, already used, or invalid for view-once"
        )

    if created:
        notifier.publish()
        for hook in hooks:

            async def _dispatch(h: MessageHook = hook) -> None:
                await h(message)

            background.spawn("livechat-push-dispatch", _dispatch)

    signer = MediaSigner.for_auth(secret, auth)
    return JSONResponse(
        status_code=201 if created else 200,
        content={"message": message_json(message, signer)},
    )


@router.post("/messages/{seq}/view-once/open", response_model=None)
async def open_view_once(seq: int, body: OpenViewOnceIn, request: Request) -> JSONResponse:
    auth = await require_server_token(request)
    if not (0 < seq <= _SQLITE_MAX_INTEGER):
        return JSONResponse(status_code=404, content={"error": "not_found"})

    if not _CLAIM_ID_RE.match(body.claimId):
        return _invalid("claimId must be 32 lowercase hex characters")
    sender = body.sender.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")

    store: LiveChatStore = request.app.state.livechat_store
    now = time.time()

    outcome, msg, att = await anyio.to_thread.run_sync(
        lambda: store.claim_view_once(
            seq=seq,
            claim_id=body.claimId,
            email=auth.email or "",
            sender=sender,
            now=now,
        )
    )
    if outcome == "not_found":
        return JSONResponse(status_code=404, content={"error": "not_found"})
    if outcome == "own_message":
        return JSONResponse(status_code=403, content={"error": "own_message"})
    if outcome == "already_opened":
        return JSONResponse(status_code=409, content={"error": "already_opened"})

    assert msg is not None and att is not None
    duration_s = None if msg.view_once_s == 0 else msg.view_once_s
    return JSONResponse(
        status_code=200,
        content={
            "durationS": duration_s,
            "spotlight": bool(msg.view_spotlight),
            "kind": att.kind,
            "mime": att.mime,
        },
        headers={"Cache-Control": "no-store"},
    )


@router.get("/messages/{seq}/view-once/content", response_model=None)
async def get_view_once_content(seq: int, request: Request) -> Response:
    auth = await require_server_token(request)
    if not (0 < seq <= _SQLITE_MAX_INTEGER):
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    claim_id = request.headers.get("X-Wixy-View-Claim")
    if not claim_id or not _CLAIM_ID_RE.match(claim_id):
        raise HTTPException(status_code=403, detail={"error": "forbidden"})

    store: LiveChatStore = request.app.state.livechat_store
    paths: ProjectPaths = request.app.state.paths
    now = time.time()
    outcome, msg, att = await anyio.to_thread.run_sync(
        lambda: store.get_view_once_content_info(
            seq=seq, claim_id=claim_id, email=auth.email or "", now=now
        )
    )
    if outcome == "not_found":
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    if outcome == "forbidden":
        raise HTTPException(status_code=403, detail={"error": "forbidden"})
    if outcome == "expired":
        return JSONResponse(status_code=410, content={"error": "expired"})

    assert att is not None
    rendition = "full" if att.kind == "photo" else "play"
    if att.view_once_renditions is None or rendition not in att.view_once_renditions:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    path = await anyio.to_thread.run_sync(lambda: _resolve_rendition_path(paths, att.id, rendition))
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    media_type = _MEDIA_TYPE_BY_SUFFIX.get(path.suffix, "application/octet-stream")
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    background: ContainedTaskGroup = request.app.state.background_tasks

    async def _content_stream() -> AsyncIterator[bytes]:
        completed = False
        try:
            async with await anyio.open_file(path, "rb") as f:
                while True:
                    chunk = await f.read(16 * 1024)
                    if not chunk:
                        break
                    yield chunk
            completed = True
        finally:
            if completed:

                async def _erase() -> None:
                    attachment_ids, _ = await anyio.to_thread.run_sync(
                        lambda: store.delete_message_for_scrub(seq=seq, now=time.time())
                    )
                    commit_returned_at = time.monotonic()
                    await _finish_committed_erasure(
                        store=store,
                        paths=paths,
                        notifier=notifier,
                        attachment_ids=attachment_ids,
                        upload_ids=[],
                        wipe_token=None,
                        deadline_at=commit_returned_at + _DELETE_SCRUB_DEADLINE_S,
                    )

                background.spawn("livechat-view-once-erase", _erase)

    return StreamingResponse(
        _content_stream(),
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.put("/messages/{seq}/reactions", response_model=None)
async def set_reaction(seq: int, body: SetReactionIn, request: Request) -> JSONResponse:
    """Set one reactor's emoji on a message to present or absent (desired state, not a
    toggle, so a retry after a dropped response cannot flip it back). Reuses the
    `message_updated` event; a request that changes nothing writes no event."""
    auth = await require_server_token(request)

    if not is_allowed_reaction(body.emoji):
        return _invalid("emoji is not one of the allowed reactions")
    sender = body.sender.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")
    if not (0 < seq <= _SQLITE_MAX_INTEGER):
        return JSONResponse(status_code=404, content={"error": "not_found"})

    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    secret: bytes = request.app.state.livechat_secret

    def _set() -> tuple[MessageRow, bool]:
        return store.set_reaction(
            seq=seq,
            sender=sender,
            by_email=auth.email or None,
            emoji=body.emoji,
            reacted=body.reacted,
            now=time.time(),
        )

    try:
        message, changed = await anyio.to_thread.run_sync(_set)
    except MessageNotFoundError:
        return JSONResponse(status_code=404, content={"error": "not_found"})

    if changed:
        notifier.publish()
    signer = MediaSigner.for_auth(secret, auth)
    return JSONResponse(status_code=200, content={"message": message_json(message, signer)})


@router.delete("/messages/{seq}", response_model=None)
async def delete_message(seq: int, request: Request) -> Response:
    await require_server_token(request)
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
    await require_server_token(request)
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
    grant_id = auth.grant_id

    while True:
        if auth.exp <= time.time():
            # §6 R6: reaching the token's expiresAt locks. §5.4: "the token
            # expired mid-stream; the server closes after it."
            yield _format_sse("locked", {})
            return

        if grant_id is not None:
            # §9 (audit F4): a bound stream re-checks grant liveness on this same loop tick
            # (at most every `_NOTIFIER_WAIT_S`), so a revoked grant ends the connection within
            # about 2s — not just at the next fresh request.
            live = await anyio.to_thread.run_sync(
                lambda: store.is_device_grant_live(
                    grant_id=grant_id,
                    email=auth.email,
                    now=time.time(),
                    max_idle_s=GRANT_IDLE_EXPIRY_S,
                )
            )
            if not live:
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
    auth = await require_server_token(request)
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
    await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    settings: Settings = request.app.state.settings
    media_available: bool = request.app.state.livechat_media_available
    transcription: TranscriptionRuntime = request.app.state.livechat_transcription

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
        "transcriptionAvailable": await transcription.available(),
    }


# ---------------------------------------------------------------------------
# POST /attachments/{id}/transcribe — opt-in voice-note transcription
# (spec/server-chat/05-voice-transcription.md). Asynchronous: Cloudflare cuts a proxied
# origin response at 100 s, and a long note can take longer than that.
# ---------------------------------------------------------------------------


@router.post("/attachments/{att_id}/transcribe", response_model=None)
async def transcribe_attachment(att_id: str, request: Request) -> JSONResponse:
    auth = await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    runtime: TranscriptionRuntime = request.app.state.livechat_transcription
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    background: ContainedTaskGroup = request.app.state.background_tasks

    def _not_found() -> JSONResponse:
        return JSONResponse(status_code=404, content={"error": "not_found"})

    def _stored(transcript: TranscriptRow | None, *, status_code: int) -> JSONResponse:
        return JSONResponse(
            status_code=status_code, content={"transcript": transcript_json(transcript)}
        )

    if not _ATTACHMENT_ID_RE.match(att_id):
        return _not_found()
    attachment = await anyio.to_thread.run_sync(store.get_attachment, att_id)
    if attachment is None or attachment.kind != "voice" or attachment.message_seq is None:
        return _not_found()
    if attachment.status != "ready":
        return JSONResponse(status_code=409, content={"error": "not_ready"})

    def _pending() -> JSONResponse:
        return JSONResponse(status_code=202, content={"transcript": {"status": "pending"}})

    existing = attachment.transcript
    if existing is not None and existing.status == "done":
        return _stored(existing, status_code=200)  # reading a stored transcript needs no cmd
    if att_id in runtime.inflight:
        return _pending()  # single-flight: this process already has a job for the note

    if not await runtime.available():
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    if att_id in runtime.inflight:  # a concurrent request claimed it while we probed
        return _pending()
    retry_after = runtime.rate_limiter.hit(auth.email)
    if retry_after is not None:
        seconds = max(1, math.ceil(retry_after))
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limited", "retryAfterS": seconds},
            headers={"Retry-After": str(seconds)},
        )

    # Claim the note BEFORE the next await (nothing has been awaited since the check above), so a
    # concurrent request sees it in flight. A `pending` row with no claim here belongs to a job
    # that is gone (its outcome could not be recorded), so it is restarted rather than left
    # answering 202 forever.
    runtime.inflight.add(att_id)
    try:
        begin = await anyio.to_thread.run_sync(
            lambda: store.begin_transcript(att_id=att_id, now=time.time(), restart_pending=True)
        )
        if begin.state == "started":
            notifier.publish()  # the other device's spinner
            background.spawn("livechat-transcription", runtime.run_job, att_id)
            return _stored(begin.transcript, status_code=202)
    except BaseException:
        runtime.inflight.discard(att_id)
        raise
    runtime.inflight.discard(att_id)
    if begin.state == "done":
        return _stored(begin.transcript, status_code=200)
    return _not_found()  # "gone": deleted while we were deciding


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
    await require_server_token(request)
    keys = request.app.state.livechat_vapid_keys
    return {"publicKey": keys.public_key_b64}


@router.get("/push/subscriptions/{device_id}", response_model=None)
async def push_subscription_status(device_id: str, request: Request) -> JsonObject:
    await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    subscription = await anyio.to_thread.run_sync(store.get_push_subscription, device_id)
    return {
        "subscribed": subscription is not None,
        "endpoint": subscription.endpoint if subscription is not None else None,
    }


@router.put("/push/subscriptions/{device_id}", response_model=None)
async def put_push_subscription(
    device_id: str, body: PushSubscriptionUpsertIn, request: Request
) -> Response:
    await require_server_token(request)
    sender = body.sender.strip()
    if not _valid_sender(sender):
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
    await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    await anyio.to_thread.run_sync(store.delete_push_subscription, device_id)
    return Response(status_code=204)


_PUSH_TEST_RATE_LIMIT_S = 5.0
_push_test_limiter = SlidingWindowRateLimiter(max_events=1, window_s=_PUSH_TEST_RATE_LIMIT_S)


@router.post("/push/subscriptions/{device_id}/test", response_model=None)
async def post_push_test(device_id: str, request: Request) -> JSONResponse:
    await require_server_token(request)
    limiter: SlidingWindowRateLimiter = getattr(
        request.app.state, "livechat_push_test_limiter", _push_test_limiter
    )
    retry_after = limiter.hit(device_id)
    if retry_after is not None:
        seconds = max(1, math.ceil(retry_after))
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limited", "retryAfterS": seconds},
            headers={"Retry-After": str(seconds)},
        )

    store: LiveChatStore = request.app.state.livechat_store
    subscription = await anyio.to_thread.run_sync(store.get_push_subscription, device_id)
    if subscription is None:
        return JSONResponse(status_code=404, content={"error": "not_found"})

    try:
        validate_push_endpoint(subscription.endpoint)
    except PushEndpointError as exc:
        return _invalid(str(exc))

    keys: VapidKeys = request.app.state.livechat_vapid_keys
    project = request.app.state.project
    project_domain = project.domain
    push_client: httpx.AsyncClient | None = getattr(request.app.state, "livechat_push_client", None)
    close_client = False
    if push_client is None:
        push_client = httpx.AsyncClient(timeout=10.0)
        close_client = True

    try:
        result = await send_payloadless_push(
            push_client,
            subscription.endpoint,
            project_domain,
            keys,
        )
    except httpx.HTTPError:
        return JSONResponse(
            status_code=200,
            content={"ok": False, "statusCode": 502},
        )
    finally:
        if close_client:
            await push_client.aclose()

    if result.delete_subscription:
        await anyio.to_thread.run_sync(store.delete_push_subscription, subscription.device_id)
    elif result.ok:
        await anyio.to_thread.run_sync(
            lambda: store.record_push_result(
                device_id=subscription.device_id, ok=True, now=time.time()
            )
        )
    else:
        await anyio.to_thread.run_sync(
            lambda: store.record_push_result(
                device_id=subscription.device_id, ok=False, now=time.time()
            )
        )

    return JSONResponse(
        status_code=200,
        content={"ok": result.ok, "statusCode": result.status_code},
    )
