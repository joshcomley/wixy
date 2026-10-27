"""`/api/admin/server/adventure*` — the Adventure Time globe holiday game (workspace 00056,
spec/server-chat/08-adventure-time.md §4.2; docs/ai/livechat.md §23, Inv 56).

A round is anchored to a message (like a would-you-rather round), so it lives in the thread, streams
via the ordinary `message_updated` events and erases with the message. Every route calls
`require_server_token` first, like the rest of `/api/admin/server/*`. The client that makes a move
computes its consequence and posts it; these routes validate the SHAPE and BOUNDS, the store records
it once, and every other client replays the stored values (the server enforces consistency, not
anti-cheating — Inv 40's trust model). Anyone unlocked may make any move: the stored `by` names
who did, but nothing is refused for being the "wrong" person.

Every mutation is idempotent: replaying the SAME move answers 200 with the current view; a
DIFFERENT move after the round advanced is 409 `bad_state`. Errors: 404 `not_found`, 409
`bad_state` / `too_early` / `exhausted`, 422 `invalid`. Mutations answer with the full view and
announce themselves through the existing notifier (the store appended the `message_updated`
event); only creating a round also runs the message hooks (the push dispatch).
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from typing import Any, Literal

import anyio
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt

from builder.jsontypes import JsonObject
from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat.adventure_bank import AdventureBank
from wixy_server.livechat.adventure_game import (
    ADVENTURE_LIVE_EVENT,
    MAX_CHOICE_ID_CHARS,
    adventure_view_json,
    bank_trip_json,
    parse_live_frame,
    parse_spin,
    settings_json,
)
from wixy_server.livechat.adventure_pack import AdventurePackRunner
from wixy_server.livechat.drawing_broker import DrawingBroker
from wixy_server.livechat.drawings import MAX_LIVE_ANCHOR_SEQ, MAX_LIVE_BATCH_INDEX
from wixy_server.livechat.models import AdventureRoundRow, MessageHook, MessageRow, message_json
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.store import (
    AdventureBadStateError,
    AdventureExhaustedError,
    AdventureInvalidError,
    AdventureRoundNotFoundError,
    AdventureTooEarlyError,
    LiveChatStore,
)
from wixy_server.livechat.tokens import MediaSigner, ServerAuth, require_server_token
from wixy_server.livechat.transcription import SlidingWindowRateLimiter
from wixy_server.routes_livechat import (
    _SQLITE_MAX_INTEGER,
    _invalid,
    _live_relay_budget_key,
    _valid_sender,
)

router = APIRouter(prefix="/api/admin/server")

Number = StrictInt | StrictFloat
"""A JSON number (never a string, never a bool); finiteness is checked by hand."""


class CreateAdventureIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientId: str
    deviceId: str
    sender: str


class AdventureSpinIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    axis: Literal["lng", "lat"]
    from_: Number = Field(alias="from")
    delta: Number
    durationMs: Number
    # Required for the `lat` spin, refused for `lng`; its inner shape (point/sea/land/centre/
    # landUnit/candidates, unknown keys refused) is validated by `adventure_game.parse_spin`.
    result: dict[str, Any] | None = None


class AdventureStopIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    stage: Literal["country", "destination"]
    choice: str


class AdventureDecideIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    decision: Literal["bank", "reject"]


class AdventureRetryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str


class AdventureSettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    includeAdvised: StrictBool


class AdventureLiveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    anchorSeq: StrictInt
    clientId: str
    axis: Literal["lng", "lat"]
    rotation: list[Number]
    points: list[list[Number]]
    frame: StrictInt
    end: StrictBool = False


_adventure_live_limiter = SlidingWindowRateLimiter(max_events=30, window_s=1.0)

_NOT_FOUND = {"error": "not_found"}


def _not_found() -> JSONResponse:
    return JSONResponse(status_code=404, content=_NOT_FOUND)


def _adventure_error(exc: Exception) -> JSONResponse:
    if isinstance(exc, AdventureRoundNotFoundError):
        return _not_found()
    if isinstance(exc, AdventureBadStateError):
        return JSONResponse(status_code=409, content={"error": "bad_state"})
    if isinstance(exc, AdventureTooEarlyError):
        return JSONResponse(status_code=409, content={"error": "too_early"})
    if isinstance(exc, AdventureExhaustedError):
        return JSONResponse(status_code=409, content={"error": "exhausted"})
    if isinstance(exc, AdventureInvalidError):
        return _invalid(str(exc))
    raise exc


def _bank(request: Request) -> AdventureBank:
    bank: AdventureBank = request.app.state.livechat_adventure_bank
    return bank


def _runner(request: Request) -> AdventurePackRunner:
    runner: AdventurePackRunner = request.app.state.livechat_adventure_runner
    return runner


async def _view_response(request: Request, seq: int) -> JSONResponse:
    store: LiveChatStore = request.app.state.livechat_store
    state = await anyio.to_thread.run_sync(lambda: store.adventure_view_state(anchor_seq=seq))
    if state is None:
        return _not_found()
    round_, excluded, include_advised = state
    content = adventure_view_json(
        round_,
        _bank(request),
        excluded,
        now=time.time(),
        researcher_available=_runner(request).available,
        include_advised=include_advised,
    )
    return JSONResponse(status_code=200, content=content)


@router.post("/adventure", response_model=None)
async def create_adventure(body: CreateAdventureIn, request: Request) -> JSONResponse:
    """Start an adventure (the header's ... menu). Abandons any round still spinning or on a
    roulette (a `chosen` round — a real place awaiting a decision — is never abandoned)."""
    auth = await require_server_token(request)

    if not (8 <= len(body.clientId) <= 64):
        return _invalid("clientId must be 8-64 characters")
    if not (8 <= len(body.deviceId) <= 64):
        return _invalid("deviceId must be 8-64 characters")
    sender = body.sender.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")

    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    hooks: list[MessageHook] = request.app.state.livechat_message_hooks
    background: ContainedTaskGroup = request.app.state.background_tasks
    secret: bytes = request.app.state.livechat_secret
    bank = _bank(request)

    excluded = await anyio.to_thread.run_sync(store.adventure_excluded_ids)
    include_advised = await anyio.to_thread.run_sync(store.adventure_include_advised)
    if not bank.eligible_units(excluded, include_advised=include_advised):
        # An empty/unusable bank, or every destination rejected or banked: nothing to land on.
        return JSONResponse(status_code=503, content={"error": "game_unavailable"})

    def _create() -> tuple[MessageRow, bool]:
        return store.create_adventure_round(
            client_id=body.clientId,
            sender=sender,
            device_id=body.deviceId,
            by_email=auth.email or None,
        )

    message, created = await anyio.to_thread.run_sync(_create)
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


@router.get("/adventure/bank", response_model=None)
async def get_adventure_bank(request: Request) -> JSONResponse:
    """The banked trips, newest first. Declared BEFORE `/adventure/{seq}` so the literal path
    wins."""
    await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    bank = _bank(request)
    rows = await anyio.to_thread.run_sync(store.list_adventure_bank)
    trips = [trip for row in rows if (trip := bank_trip_json(row, bank)) is not None]
    return JSONResponse(status_code=200, content={"trips": trips})


async def _settings_response(request: Request) -> JSONResponse:
    store: LiveChatStore = request.app.state.livechat_store
    include_advised = await anyio.to_thread.run_sync(store.adventure_include_advised)
    return JSONResponse(status_code=200, content=settings_json(include_advised, _bank(request)))


@router.get("/adventure/settings", response_model=None)
async def get_adventure_settings(request: Request) -> JSONResponse:
    """The game's shared preference (operator decision #2113): `includeAdvised` — whether places
    under a whole-country UK "advise against all travel" are in the draw (off by default) — and
    `advisedUnits`, the units it governs. Declared BEFORE `/adventure/{seq}` so the literal path
    wins."""
    await require_server_token(request)
    return await _settings_response(request)


@router.put("/adventure/settings", response_model=None)
async def put_adventure_settings(body: AdventureSettingsIn, request: Request) -> JSONResponse:
    """Switch the shared preference for both people. A change reaches rounds still spinning (their
    view's `eligible` is computed at read time) and is announced so both screens re-read."""
    await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    changed = await anyio.to_thread.run_sync(
        lambda: store.set_adventure_include_advised(body.includeAdvised)
    )
    if changed:
        notifier.publish()
    return await _settings_response(request)


@router.get("/adventure/{seq}", response_model=None)
async def get_adventure(seq: int, request: Request) -> JSONResponse:
    """The round's view (spec §4.2): state, both spins, the landing, both roulettes, the holiday
    pack, `serverNow` for the client's clock offset."""
    await require_server_token(request)
    if not (0 < seq <= _SQLITE_MAX_INTEGER):
        return _not_found()
    return await _view_response(request, seq)


async def _adventure_mutation(
    request: Request,
    seq: int,
    sender_raw: str,
    action: Callable[[LiveChatStore, str], tuple[AdventureRoundRow, bool]],
) -> JSONResponse:
    """Shared body of the four mutations: token, sender, seq, then `action(store, sender)` on a
    worker thread. A real change is announced; a round that has just entered `chosen` with its pack
    `pending` and no run starts the holiday-pack job (once: a replay changes nothing)."""
    await require_server_token(request)
    sender = sender_raw.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")
    if not (0 < seq <= _SQLITE_MAX_INTEGER):
        return _not_found()
    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    try:
        round_, changed = await anyio.to_thread.run_sync(lambda: action(store, sender))
    except (
        AdventureRoundNotFoundError,
        AdventureBadStateError,
        AdventureTooEarlyError,
        AdventureExhaustedError,
        AdventureInvalidError,
    ) as exc:
        return _adventure_error(exc)
    if changed:
        notifier.publish()
        runner = _runner(request)
        if runner.available and round_.pack == "pending" and round_.pack_run_id is None:
            background: ContainedTaskGroup = request.app.state.background_tasks
            background.spawn("livechat-adventure-pack", runner.run_job, seq)
    return await _view_response(request, seq)


@router.post("/adventure/live", response_model=None)
async def post_adventure_live(body: AdventureLiveIn, request: Request) -> JSONResponse:
    """Relay the dragger's finger trail to every open stream as the SSE event `adventure_live`
    (spec §3.5) without ever touching the database, a file or a log line — a trail is chat content
    like a stored stroke (Inv 40/46/56). Rate-limited 30 a second on the same authenticated
    identity as drawing live, but with its OWN limiter. The relay carries no sender: a client
    ignores a frame carrying its own `clientId`."""
    auth: ServerAuth = await require_server_token(request)

    limiter: SlidingWindowRateLimiter = getattr(
        request.app.state, "livechat_adventure_live_limiter", _adventure_live_limiter
    )
    retry_after = limiter.hit(_live_relay_budget_key(request, auth))
    if retry_after is not None:
        seconds = max(1, math.ceil(retry_after))
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limited", "retryAfterS": seconds},
            headers={"Retry-After": str(seconds)},
        )

    frame = parse_live_frame(
        anchor_seq=body.anchorSeq,
        client_id=body.clientId,
        axis=body.axis,
        rotation=body.rotation,
        points=body.points,
        frame=body.frame,
        max_anchor_seq=MAX_LIVE_ANCHOR_SEQ,
        max_frame=MAX_LIVE_BATCH_INDEX,
    )
    if isinstance(frame, str):
        return _invalid(frame)
    relayed: JsonObject = {**frame, "end": body.end}
    broker: DrawingBroker = request.app.state.livechat_drawing_broker
    broker.publish(relayed, ADVENTURE_LIVE_EVENT)
    return JSONResponse(status_code=200, content={"ok": True})


@router.post("/adventure/{seq}/spin", response_model=None)
async def spin_adventure(seq: int, body: AdventureSpinIn, request: Request) -> JSONResponse:
    """Commit a spin: `lng` (the sideways spin) then `lat` (up/down, with the landing result)."""
    # Auth first: an invalid body must not reveal anything to a locked client.
    await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    include_advised = await anyio.to_thread.run_sync(store.adventure_include_advised)
    parsed = parse_spin(
        axis=body.axis,
        from_deg=body.from_,
        delta_deg=body.delta,
        duration_ms=body.durationMs,
        result=body.result,
        bank=_bank(request),
        include_advised=include_advised,
    )
    if isinstance(parsed, str):
        return _invalid(parsed)
    return await _adventure_mutation(
        request,
        seq,
        body.sender,
        lambda store, sender: store.spin_adventure(
            anchor_seq=seq,
            sender=sender,
            axis=body.axis,
            from_deg=parsed.from_deg,
            delta_deg=parsed.delta_deg,
            duration_ms=parsed.duration_ms,
            landing=parsed.landing,
            candidates=parsed.candidates,
        ),
    )


@router.post("/adventure/{seq}/stop", response_model=None)
async def stop_adventure(seq: int, body: AdventureStopIn, request: Request) -> JSONResponse:
    """Press Stop on a roulette. `choice` is the item the presser SAW lit."""
    if not (1 <= len(body.choice) <= MAX_CHOICE_ID_CHARS):
        await require_server_token(request)
        return _invalid(f"choice must be 1-{MAX_CHOICE_ID_CHARS} characters")
    bank = _bank(request)
    pack_available = _runner(request).available
    return await _adventure_mutation(
        request,
        seq,
        body.sender,
        lambda store, sender: store.stop_adventure(
            anchor_seq=seq,
            sender=sender,
            stage=body.stage,
            choice=body.choice,
            bank=bank,
            pack_available=pack_available,
        ),
    )


@router.post("/adventure/{seq}/decide", response_model=None)
async def decide_adventure(seq: int, body: AdventureDecideIn, request: Request) -> JSONResponse:
    """Bank ("Let's go there") or reject ("No") the chosen destination. A rejection also puts it on
    the never-again list."""
    return await _adventure_mutation(
        request,
        seq,
        body.sender,
        lambda store, sender: store.decide_adventure(
            anchor_seq=seq, sender=sender, decision=body.decision
        ),
    )


@router.post("/adventure/{seq}/pack/retry", response_model=None)
async def retry_adventure_pack(seq: int, body: AdventureRetryIn, request: Request) -> JSONResponse:
    """Try the holiday pack again after it failed (or while holiday packs were unavailable)."""
    available = _runner(request).available
    return await _adventure_mutation(
        request,
        seq,
        body.sender,
        lambda store, sender: store.retry_adventure_pack(
            anchor_seq=seq, researcher_available=available
        ),
    )
