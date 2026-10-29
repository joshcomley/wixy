"""`/api/admin/server/cookout*` — the Cookout two-player cooking game (workspace 00058,
spec/server-chat/09-cookout.md §4.2 and the twists addendum 09a §4; docs/ai/livechat.md, Inv 57).

A round is anchored to a message (like a would-you-rather or Adventure Time round), so it lives in
the thread, streams via the ordinary `message_updated` events and erases with the message. Every
route calls `require_server_token` FIRST — before it looks at the body, the sender or the `?as=`
name; no player label is a credential — and only then decides who the caller is (`slot_of`).

The server is authoritative: it draws every pair, so a client only names the move it saw
(`moveId`, `turn`, `offer`). In Blind mode the personalised view is redacted in Python
(`cookout_view_json`) and EVERY response that carries a view — a mutation's included — is filtered
for its caller and sent `Cache-Control: no-store`. Mutations are idempotent: replaying the SAME move
answers 200 with the current view; a DIFFERENT move after the round advanced is 409 `bad_state`.
Errors: 404 `not_found`, 409 `bad_state` / `not_your_turn` / `not_player` / `skip_exhausted` /
`exhausted` / `token_used` / `recipe_pending`, 422 `invalid`, 503 `game_unavailable`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

import anyio
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictBool, StrictInt

from builder.jsontypes import JsonValue
from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat import cookout_twists
from wixy_server.livechat.cookout_game import (
    CONCEPT_IDS,
    MAX_ID_CHARS,
    MAX_MOVE_ID_CHARS,
    MAX_OFFERS,
    MAX_SEARCH_CHARS,
    MAX_STARTERS,
    MIN_MOVE_ID_CHARS,
    MIN_SEARCH_CHARS,
    TOTAL_TURNS,
    BankLike,
    CookoutRunner,
    CookoutSetup,
    EncoreSpec,
    bank_entry_json,
    cookout_view_json,
    picture_json,
)
from wixy_server.livechat.models import CookoutRoundRow, MessageHook, MessageRow, message_json
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.reactions import reactor_key
from wixy_server.livechat.store import (
    CookoutBadStateError,
    CookoutExhaustedError,
    CookoutInvalidError,
    CookoutNotPlayerError,
    CookoutNotYourTurnError,
    CookoutRecipePendingError,
    CookoutRoundNotFoundError,
    CookoutSkipExhaustedError,
    CookoutTokenUsedError,
    LiveChatStore,
)
from wixy_server.livechat.tokens import MediaSigner, ServerAuth, require_server_token
from wixy_server.routes_livechat import _SQLITE_MAX_INTEGER, _invalid, _valid_sender

router = APIRouter(prefix="/api/admin/server")

_NO_STORE = {"Cache-Control": "no-store"}
_MAX_GENERATION = 1000
"""A sanity bound on a named generation (a round has at most two today)."""


class EncoreIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fromSeq: StrictInt
    generation: StrictInt
    conceptId: str
    kind: Literal["leftovers", "remix"]
    seedIds: list[str]


class CreateCookoutIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientId: str
    deviceId: str
    sender: str
    blind: StrictBool = False
    style: str | None = None
    challenge: str | None = None
    wildcard: StrictBool = False
    stars: StrictBool = False
    fridgeSeedId: str | None = None
    encore: EncoreIn | None = None


class CookoutSenderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str


class CookoutGenerationIn(BaseModel):
    """A retry names the generation of the dishes it was rendered from (spec 09a §1.10); absent =
    a core-era client, accepted only while the round is still at generation 1."""

    model_config = ConfigDict(extra="forbid")

    sender: str
    generation: StrictInt | None = None


class CookoutSkipIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str
    turn: StrictInt
    offer: StrictInt
    optionIds: list[str] | None = None
    """Spec 09a §1.2: the pair the player saw. A veto or the chaos shelf changes the pair without
    changing `offer`, so when present it must equal the live pair (order-free)."""


class CookoutPickIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str
    turn: StrictInt
    offer: StrictInt
    ingredientId: str


class CookoutTwistMoveIn(BaseModel):
    """Lucky dip and chaos shelf: the move names the table it saw."""

    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str
    turn: StrictInt
    offer: StrictInt
    optionIds: list[str]


class CookoutVetoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str
    turn: StrictInt
    offer: StrictInt
    ingredientId: str


class CookoutStarIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    ingredientId: str


class CookoutWildcardIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str
    lift: StrictBool


class CookoutVoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    generation: StrictInt
    conceptId: str


class CookoutSwapIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str
    ingredientId: str


class CookoutBankIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str
    generation: StrictInt | None = None


class CookoutCookedIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    cooked: StrictBool


class CookoutRatingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    rating: StrictInt | None = None


class CookoutPhotoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    messageSeq: StrictInt | None = None
    attachmentId: str | None = None


def _not_found() -> JSONResponse:
    return JSONResponse(status_code=404, content={"error": "not_found"})


def _conflict(code: str) -> JSONResponse:
    return JSONResponse(status_code=409, content={"error": code})


def _unavailable() -> JSONResponse:
    return JSONResponse(status_code=503, content={"error": "game_unavailable"})


def _cookout_error(exc: Exception) -> JSONResponse:
    if isinstance(exc, CookoutRoundNotFoundError):
        return _not_found()
    if isinstance(exc, CookoutBadStateError):
        return _conflict("bad_state")
    if isinstance(exc, CookoutNotYourTurnError):
        return _conflict("not_your_turn")
    if isinstance(exc, CookoutNotPlayerError):
        return _conflict("not_player")
    if isinstance(exc, CookoutSkipExhaustedError):
        return _conflict("skip_exhausted")
    if isinstance(exc, CookoutExhaustedError):
        return _conflict("exhausted")
    if isinstance(exc, CookoutTokenUsedError):
        return _conflict("token_used")
    if isinstance(exc, CookoutRecipePendingError):
        return _conflict("recipe_pending")
    if isinstance(exc, CookoutInvalidError):
        return _invalid(str(exc))
    raise exc


_STORE_ERRORS = (
    CookoutRoundNotFoundError,
    CookoutBadStateError,
    CookoutNotYourTurnError,
    CookoutNotPlayerError,
    CookoutSkipExhaustedError,
    CookoutExhaustedError,
    CookoutTokenUsedError,
    CookoutRecipePendingError,
    CookoutInvalidError,
)


def _bank(request: Request) -> BankLike | None:
    bank: BankLike | None = request.app.state.livechat_cookout_bank
    return bank


def _runner(request: Request) -> CookoutRunner:
    runner: CookoutRunner = request.app.state.livechat_cookout_runner
    return runner


def _seq_ok(seq: int) -> bool:
    return 0 < seq <= _SQLITE_MAX_INTEGER


def _bad_move_id(move_id: str) -> bool:
    return not (MIN_MOVE_ID_CHARS <= len(move_id) <= MAX_MOVE_ID_CHARS)


def _bad_id(value: str) -> bool:
    return not (1 <= len(value) <= MAX_ID_CHARS)


def _bad_table(turn: int, offer: int) -> bool:
    return not (1 <= turn <= TOTAL_TURNS) or not (0 <= offer < MAX_OFFERS)


def _bad_generation(generation: int) -> bool:
    return not (1 <= generation <= _MAX_GENERATION)


async def _view_response(
    request: Request, seq: int, auth: ServerAuth, viewer: str | None
) -> JSONResponse:
    """The round's view for `viewer` (a display name, or None for nobody), redacted for them."""
    store: LiveChatStore = request.app.state.livechat_store
    secret: bytes = request.app.state.livechat_secret
    data = await anyio.to_thread.run_sync(lambda: store.cookout_view_data(anchor_seq=seq))
    if data is None:
        return JSONResponse(status_code=404, content={"error": "not_found"}, headers=_NO_STORE)
    content = cookout_view_json(
        data.round,
        data.turns,
        data.recipes,
        data.attachments,
        _bank(request),
        viewer_key=reactor_key(viewer) if viewer else None,
        viewer_email=auth.email or None,
        signer=MediaSigner.for_auth(secret, auth),
        generations=data.generations,
        all_recipes=data.all_recipes,
        photo_attachments=data.photo_attachments,
        encore_title=data.encore_title,
    )
    return JSONResponse(status_code=200, content=content, headers=_NO_STORE)


def _catalogue_entries(entries: Any) -> list[JsonValue]:
    return [{"id": e.id, "label": e.label, "emoji": e.emoji, "blurb": e.blurb} for e in entries]


@router.get("/cookout/options", response_model=None)
async def get_cookout_options(request: Request) -> JSONResponse:
    """What the start sheet may offer: the fixed style and challenge catalogues (labels only — the
    prompt directives never leave the server), whether a chef exists (`chef`; the style, challenge,
    wildcard and star options need one) and whether it can draw pictures. Declared before
    `/cookout/{seq}`."""
    await require_server_token(request)
    runner = _runner(request)
    return JSONResponse(
        status_code=200,
        content={
            "styles": _catalogue_entries(cookout_twists.STYLES),
            "challenges": _catalogue_entries(cookout_twists.CHALLENGES),
            "chef": bool(runner.available),
            "pictures": bool(runner.images_available),
        },
        headers=_NO_STORE,
    )


@router.get("/cookout/ingredients", response_model=None)
async def search_cookout_ingredients(request: Request) -> JSONResponse:
    """Fridge raid's search: up to 20 bank ingredients whose name or alias starts with every word of
    `?q=` (2-40 characters). Bank entries only — nothing outside the bank is ever returned."""
    await require_server_token(request)
    query = request.query_params.get("q", "").strip()
    if not (MIN_SEARCH_CHARS <= len(query) <= MAX_SEARCH_CHARS):
        return _invalid(f"q must be {MIN_SEARCH_CHARS}-{MAX_SEARCH_CHARS} characters")
    bank = _bank(request)
    if bank is None or not bank.staples:
        return _unavailable()
    found = await anyio.to_thread.run_sync(lambda: bank.search(query, limit=20))
    return JSONResponse(
        status_code=200,
        content={
            "ingredients": [
                {
                    "id": i.id,
                    "name": i.name,
                    "category": i.category,
                    "emoji": i.emoji,
                    "blurb": i.blurb,
                }
                for i in found
            ]
        },
        headers=_NO_STORE,
    )


@router.post("/cookout", response_model=None)
async def create_cookout(body: CreateCookoutIn, request: Request) -> JSONResponse:
    """Start a Cookout (the header's ... menu). Abandons any round still `picking`, binds the
    sender to Slot 1 and draws the first pair; idempotent on `clientId`. The optional start-sheet
    twists (style or `"spin"`, challenge, wildcard cloche, secret stars, fridge raid, encore) are
    fixed for the round; the chef-only ones are refused when no chef exists (spec 09a §1.1)."""
    auth = await require_server_token(request)

    if not (8 <= len(body.clientId) <= 64):
        return _invalid("clientId must be 8-64 characters")
    if not (8 <= len(body.deviceId) <= 64):
        return _invalid("deviceId must be 8-64 characters")
    sender = body.sender.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")

    style = body.style
    style_spun = False
    if style == "spin":
        style = cookout_twists.spin_style()
        style_spun = True
    elif style is not None and cookout_twists.style_by_id(style) is None:
        return _invalid("unknown style")
    if body.challenge is not None and cookout_twists.challenge_by_id(body.challenge) is None:
        return _invalid("unknown challenge")
    if body.fridgeSeedId is not None and _bad_id(body.fridgeSeedId):
        return _invalid("fridgeSeedId must be 1-64 characters")
    encore: EncoreSpec | None = None
    if body.encore is not None:
        raw = body.encore
        if (
            not _seq_ok(raw.fromSeq)
            or _bad_generation(raw.generation)
            or raw.conceptId not in CONCEPT_IDS
            or not (1 <= len(raw.seedIds) <= MAX_STARTERS)
            or any(_bad_id(i) for i in raw.seedIds)
        ):
            return _invalid("the encore names an unknown round, dish or ingredients")
        encore = EncoreSpec(
            from_seq=raw.fromSeq,
            generation=raw.generation,
            concept_id=raw.conceptId,
            kind=raw.kind,
            seed_ids=tuple(raw.seedIds),
        )
    setup = CookoutSetup(
        style=style,
        style_spun=style_spun,
        challenge=body.challenge,
        wildcard=body.wildcard,
        stars=body.stars,
        fridge_seed_id=body.fridgeSeedId,
        encore=encore,
    )
    if setup.chef_only and not _runner(request).available:
        return _invalid("those options need the chef, which is not available here")
    bank = _bank(request)
    if bank is None:
        return _unavailable()

    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    hooks: list[MessageHook] = request.app.state.livechat_message_hooks
    background: ContainedTaskGroup = request.app.state.background_tasks
    secret: bytes = request.app.state.livechat_secret

    def _create() -> tuple[MessageRow, bool]:
        return store.create_cookout_round(
            client_id=body.clientId,
            sender=sender,
            device_id=body.deviceId,
            by_email=auth.email or None,
            blind=body.blind,
            bank=bank,
            setup=setup,
        )

    try:
        message, created = await anyio.to_thread.run_sync(_create)
    except CookoutExhaustedError:
        # An empty or unusable bank cannot deal even the first pair: nothing to play with.
        return _unavailable()
    except CookoutInvalidError as exc:
        return _invalid(str(exc))
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
        headers=_NO_STORE,
    )


@router.get("/cookout/bank", response_model=None)
async def get_cookout_bank(request: Request) -> JSONResponse:
    """The Recipe book: every banked recipe, newest banked first. Declared BEFORE
    `/cookout/{seq}` so the literal path wins. Auth first, like every Cookout route."""
    auth = await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    secret: bytes = request.app.state.livechat_secret
    rows = await anyio.to_thread.run_sync(store.list_cookout_bank)
    signer = MediaSigner.for_auth(secret, auth)
    bank = _bank(request)
    recipes = [
        entry
        for row in rows
        if (
            entry := bank_entry_json(
                row.round,
                row.recipe,
                row.attachments,
                signer,
                turns=row.turns,
                generation_row=row.generation_row,
                photo_attachments=row.photo_attachments,
                bank=bank,
            )
        )
        is not None
    ]
    return JSONResponse(status_code=200, content={"recipes": recipes}, headers=_NO_STORE)


@router.get("/cookout/{seq}", response_model=None)
async def get_cookout(seq: int, request: Request) -> JSONResponse:
    """The viewer-filtered round body. `?as=<sender>` names who is looking (the chat's trust
    model: a display name, like every other route here — and like Would-You-Rather, Blind mode is
    a no-peeking sofa feature, not a boundary against someone typing the partner's name on a shared
    sign-in; Inv 57)."""
    auth = await require_server_token(request)
    viewer = request.query_params.get("as", "").strip()
    if viewer and not _valid_sender(viewer):
        return _invalid("as must be 1-32 characters with no control characters")
    if not _seq_ok(seq):
        return _not_found()
    return await _view_response(request, seq, auth, viewer or None)


@router.get("/cookout/{seq}/photos", response_model=None)
async def get_cookout_photos(seq: int, request: Request) -> JSONResponse:
    """The round's linkable mini-chat photos for "We cooked it!": ONE entry per message that has a
    ready photo, showing that message's lowest-ordinal ready photo at the time of this read, newest
    first, at most 50. The client posts the returned `attachmentId` back to link exactly it.
    Players only (`409 not_player`)."""
    auth = await require_server_token(request)
    viewer = request.query_params.get("as", "").strip()
    if not _valid_sender(viewer):
        return _invalid("as must be 1-32 characters with no control characters")
    if not _seq_ok(seq):
        return _not_found()
    store: LiveChatStore = request.app.state.livechat_store
    secret: bytes = request.app.state.livechat_secret
    email = auth.email or None

    def _read() -> tuple[int | None, list[tuple[MessageRow, Any]]]:
        slot = store.cookout_player_slot(anchor_seq=seq, sender=viewer, email=email)
        if slot is None:
            return None, []
        return slot, store.cookout_round_photos(anchor_seq=seq)

    try:
        slot, rows = await anyio.to_thread.run_sync(_read)
    except CookoutRoundNotFoundError:
        return _not_found()
    if slot is None:
        return _conflict("not_player")
    signer = MediaSigner.for_auth(secret, auth)
    photos: list[JsonValue] = []
    for message, attachment in rows:
        picture = picture_json(attachment, signer)
        if picture is None:
            continue
        photos.append(
            {
                "messageSeq": message.seq,
                "attachmentId": attachment.id,
                "sender": message.sender,
                "createdAt": message.created_at,
                "picture": picture,
            }
        )
    return JSONResponse(status_code=200, content={"photos": photos}, headers=_NO_STORE)


async def _mutation(
    request: Request,
    seq: int,
    sender_raw: str,
    action: Callable[[LiveChatStore, str, str | None], tuple[CookoutRoundRow, bool]],
    *,
    after: Callable[[CookoutRoundRow, ContainedTaskGroup], None] | None = None,
) -> JSONResponse:
    """Shared body of the player moves: token, sender, seq, then `action(store, sender, email)` on
    a worker thread. A real change is announced AFTER the commit and `after` (job starts) runs only
    then — a replay changes nothing and starts nothing. The answer is the caller's own view."""
    auth = await require_server_token(request)
    sender = sender_raw.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")
    if not _seq_ok(seq):
        return _not_found()
    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    email = auth.email or None
    try:
        round_, changed = await anyio.to_thread.run_sync(lambda: action(store, sender, email))
    except _STORE_ERRORS as exc:
        return _cookout_error(exc)
    if changed:
        notifier.publish()
        if after is not None:
            after(round_, request.app.state.background_tasks)
    return await _view_response(request, seq, auth, sender)


def _start_concepts_if_pending(
    runner: CookoutRunner, seq: int
) -> Callable[[CookoutRoundRow, ContainedTaskGroup], None]:
    """The `after` hook of every move that can start Stage 1 (the tenth pick, a star, the cloche, a
    swap choice): begin the concepts job for the generation the store just made pending."""

    def _after(round_: CookoutRoundRow, background: ContainedTaskGroup) -> None:
        if round_.state == "finished" and round_.concepts == "pending":
            runner.start_concepts(background, seq, round_.generation)

    return _after


@router.post("/cookout/{seq}/join", response_model=None)
async def join_cookout(seq: int, body: CookoutSenderIn, request: Request) -> JSONResponse:
    """Take Slot 2 — an explicit act: a seat is never bound by a first move."""
    bank = _bank(request)
    if bank is None:
        await require_server_token(request)
        return _unavailable()
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.join_cookout(
            anchor_seq=seq, sender=sender, email=email, bank=bank
        ),
    )


@router.post("/cookout/{seq}/skip", response_model=None)
async def skip_cookout(seq: int, body: CookoutSkipIn, request: Request) -> JSONResponse:
    """Deal a fresh pair for the same turn (two skips a turn, then a pick is forced)."""
    if (
        _bad_move_id(body.moveId)
        or _bad_table(body.turn, body.offer)
        or (body.optionIds is not None and _bad_pair(body.optionIds))
    ):
        await require_server_token(request)
        return _invalid("moveId must be 8-64 characters, turn 1-10, offer 0-2, two optionIds")
    bank = _bank(request)
    if bank is None:
        await require_server_token(request)
        return _unavailable()
    pair = (body.optionIds[0], body.optionIds[1]) if body.optionIds is not None else None
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.skip_cookout(
            option_ids=pair,
            anchor_seq=seq,
            sender=sender,
            email=email,
            move_id=body.moveId,
            turn=body.turn,
            offer=body.offer,
            bank=bank,
        ),
    )


@router.post("/cookout/{seq}/pick", response_model=None)
async def pick_cookout(seq: int, body: CookoutPickIn, request: Request) -> JSONResponse:
    """Pick one of the live pair. The tenth pick finishes the round and (once any cloche or star
    gate is answered) starts the concepts job."""
    if _bad_move_id(body.moveId) or _bad_table(body.turn, body.offer) or _bad_id(body.ingredientId):
        await require_server_token(request)
        return _invalid(
            "moveId must be 8-64 characters, turn 1-10, offer 0-2, ingredientId 1-64 characters"
        )
    bank = _bank(request)
    if bank is None:
        await require_server_token(request)
        return _unavailable()
    runner = _runner(request)
    available = runner.available

    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.pick_cookout(
            anchor_seq=seq,
            sender=sender,
            email=email,
            move_id=body.moveId,
            turn=body.turn,
            offer=body.offer,
            ingredient_id=body.ingredientId,
            bank=bank,
            runner_available=available,
        ),
        after=_start_concepts_if_pending(runner, seq),
    )


def _bad_pair(option_ids: list[str]) -> bool:
    return len(option_ids) != 2 or any(_bad_id(i) for i in option_ids)


@router.post("/cookout/{seq}/lucky", response_model=None)
async def lucky_cookout(seq: int, body: CookoutTwistMoveIn, request: Request) -> JSONResponse:
    """Lucky dip: the kitchen coin picks between the two options on the table (a real pick)."""
    if _bad_move_id(body.moveId) or _bad_table(body.turn, body.offer) or _bad_pair(body.optionIds):
        await require_server_token(request)
        return _invalid("moveId must be 8-64 characters, turn 1-10, offer 0-2, two optionIds")
    bank = _bank(request)
    if bank is None:
        await require_server_token(request)
        return _unavailable()
    runner = _runner(request)
    available = runner.available
    first, second = body.optionIds

    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.lucky_cookout(
            anchor_seq=seq,
            sender=sender,
            email=email,
            move_id=body.moveId,
            turn=body.turn,
            offer=body.offer,
            option_ids=(first, second),
            bank=bank,
            runner_available=available,
        ),
        after=_start_concepts_if_pending(runner, seq),
    )


@router.post("/cookout/{seq}/chaos", response_model=None)
async def chaos_cookout(seq: int, body: CookoutTwistMoveIn, request: Request) -> JSONResponse:
    """Chaos shelf: once per player per game, swap both options for two exotic ones."""
    if _bad_move_id(body.moveId) or _bad_table(body.turn, body.offer) or _bad_pair(body.optionIds):
        await require_server_token(request)
        return _invalid("moveId must be 8-64 characters, turn 1-10, offer 0-2, two optionIds")
    bank = _bank(request)
    if bank is None:
        await require_server_token(request)
        return _unavailable()
    first, second = body.optionIds
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.chaos_cookout(
            anchor_seq=seq,
            sender=sender,
            email=email,
            move_id=body.moveId,
            turn=body.turn,
            offer=body.offer,
            option_ids=(first, second),
            bank=bank,
        ),
    )


@router.post("/cookout/{seq}/veto", response_model=None)
async def veto_cookout(seq: int, body: CookoutVetoIn, request: Request) -> JSONResponse:
    """Partner veto (Open mode only): once per player per game, sweep one option off the partner's
    table before they pick."""
    if _bad_move_id(body.moveId) or _bad_table(body.turn, body.offer) or _bad_id(body.ingredientId):
        await require_server_token(request)
        return _invalid(
            "moveId must be 8-64 characters, turn 1-10, offer 0-2, ingredientId 1-64 characters"
        )
    bank = _bank(request)
    if bank is None:
        await require_server_token(request)
        return _unavailable()
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.veto_cookout(
            anchor_seq=seq,
            sender=sender,
            email=email,
            move_id=body.moveId,
            turn=body.turn,
            offer=body.offer,
            ingredient_id=body.ingredientId,
            bank=bank,
        ),
    )


@router.post("/cookout/{seq}/star", response_model=None)
async def star_cookout(seq: int, body: CookoutStarIn, request: Request) -> JSONResponse:
    """Secret star: set or change the caller's star among their own picks (may start the chef)."""
    if _bad_id(body.ingredientId):
        await require_server_token(request)
        return _invalid("ingredientId must be 1-64 characters")
    runner = _runner(request)
    available = runner.available
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.star_cookout(
            anchor_seq=seq,
            sender=sender,
            email=email,
            ingredient_id=body.ingredientId,
            runner_available=available,
        ),
        after=_start_concepts_if_pending(runner, seq),
    )


@router.post("/cookout/{seq}/wildcard", response_model=None)
async def wildcard_cookout(seq: int, body: CookoutWildcardIn, request: Request) -> JSONResponse:
    """The wildcard cloche: lift the lid (a surprise eleventh ingredient) or decline (may start the
    chef)."""
    if _bad_move_id(body.moveId):
        await require_server_token(request)
        return _invalid("moveId must be 8-64 characters")
    bank = _bank(request)
    if bank is None:
        await require_server_token(request)
        return _unavailable()
    runner = _runner(request)
    available = runner.available
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.wildcard_cookout(
            anchor_seq=seq,
            sender=sender,
            email=email,
            move_id=body.moveId,
            lift=body.lift,
            bank=bank,
            runner_available=available,
        ),
        after=_start_concepts_if_pending(runner, seq),
    )


@router.post("/cookout/{seq}/vote", response_model=None)
async def vote_cookout(seq: int, body: CookoutVoteIn, request: Request) -> JSONResponse:
    """The dinner vote: secretly tap the one dish you would actually eat tonight."""
    if body.conceptId not in CONCEPT_IDS or _bad_generation(body.generation):
        await require_server_token(request)
        return _invalid("conceptId must be a, b or c and generation a positive number")
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.vote_cookout(
            anchor_seq=seq,
            sender=sender,
            email=email,
            generation=body.generation,
            concept_id=body.conceptId,
        ),
    )


@router.post("/cookout/{seq}/swap/propose", response_model=None)
async def propose_cookout_swap(seq: int, body: CookoutSwapIn, request: Request) -> JSONResponse:
    """Rescue swap, step 1: send one basket ingredient back; the partner gets two replacements."""
    if _bad_move_id(body.moveId) or _bad_id(body.ingredientId):
        await require_server_token(request)
        return _invalid("moveId must be 8-64 characters, ingredientId 1-64 characters")
    bank = _bank(request)
    if bank is None:
        await require_server_token(request)
        return _unavailable()
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.propose_cookout_swap(
            anchor_seq=seq,
            sender=sender,
            email=email,
            move_id=body.moveId,
            ingredient_id=body.ingredientId,
            bank=bank,
        ),
    )


@router.post("/cookout/{seq}/swap/choose", response_model=None)
async def choose_cookout_swap(seq: int, body: CookoutSwapIn, request: Request) -> JSONResponse:
    """Rescue swap, step 2: the partner picks the replacement; the chef makes three new dishes."""
    if _bad_move_id(body.moveId) or _bad_id(body.ingredientId):
        await require_server_token(request)
        return _invalid("moveId must be 8-64 characters, ingredientId 1-64 characters")
    runner = _runner(request)
    available = runner.available
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.choose_cookout_swap(
            anchor_seq=seq,
            sender=sender,
            email=email,
            move_id=body.moveId,
            ingredient_id=body.ingredientId,
            runner_available=available,
        ),
        after=_start_concepts_if_pending(runner, seq),
    )


@router.post("/cookout/{seq}/swap/cancel", response_model=None)
async def cancel_cookout_swap(seq: int, body: CookoutSenderIn, request: Request) -> JSONResponse:
    """Keep these dishes: withdraw a proposed swap (the swap is not used up)."""
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.cancel_cookout_swap(
            anchor_seq=seq, sender=sender, email=email
        ),
    )


@router.post("/cookout/{seq}/abandon", response_model=None)
async def abandon_cookout(seq: int, body: CookoutSenderIn, request: Request) -> JSONResponse:
    """End an open round (End game). A finished round is never abandoned."""
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.abandon_cookout(
            anchor_seq=seq, sender=sender, email=email
        ),
    )


@router.post("/cookout/{seq}/concepts/{concept_id}/bank", response_model=None)
async def bank_cookout_concept(
    seq: int, concept_id: str, body: CookoutBankIn, request: Request
) -> JSONResponse:
    """ "Bank this": have the full recipe written for one concept and kept in the Recipe book.
    State-idempotent per concept (already `pending` or `banked` starts nothing); a move id the
    round's Bank ledger already holds is a no-job replay whatever generation it named."""
    if _bad_move_id(body.moveId) or (
        body.generation is not None and _bad_generation(body.generation)
    ):
        await require_server_token(request)
        return _invalid("moveId must be 8-64 characters")
    if concept_id not in CONCEPT_IDS:
        await require_server_token(request)
        return _not_found()
    runner = _runner(request)
    available = runner.available

    def _after(round_: CookoutRoundRow, background: ContainedTaskGroup) -> None:
        if available:
            runner.start_recipe(background, seq, round_.generation, concept_id)

    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.bank_cookout_concept(
            anchor_seq=seq,
            sender=sender,
            email=email,
            concept_id=concept_id,
            move_id=body.moveId,
            generation=body.generation,
            runner_available=available,
        ),
        after=_after,
    )


async def _retry(
    request: Request,
    seq: int,
    sender_raw: str,
    generation: int | None,
    *,
    check: Callable[[LiveChatStore, dict[str, Any]], str],
    run: Callable[[LiveChatStore], bool],
    start: Callable[[ContainedTaskGroup, int], None],
) -> JSONResponse:
    """Shared body of the three retries. `check` reads the round (`get_cookout_round`) and answers
    `"go"` (attempt it), `"noop"` (already `pending`: an idempotent 200) or `"bad"`. The store's
    own transaction is still the arbiter: if the attempt finds the state moved, a re-read decides
    between an idempotent success and `bad_state`. A request naming a generation that is no longer
    the round's current one (or none, on a generation-2 round) is `bad_state` before anything else
    (spec 09a §1.10)."""
    auth = await require_server_token(request)
    sender = sender_raw.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")
    if not _seq_ok(seq):
        return _not_found()
    if generation is not None and _bad_generation(generation):
        return _invalid("generation must be a positive number")
    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    email = auth.email or None

    def _attempt() -> tuple[str, bool, int]:
        slot = store.cookout_player_slot(anchor_seq=seq, sender=sender, email=email)
        if slot is None:
            raise CookoutNotPlayerError("you are not a player in this round")
        data = store.get_cookout_round(seq)
        if data is None:
            raise CookoutRoundNotFoundError(seq)
        current = int(data["generation"])
        if current != (1 if generation is None else generation):
            raise CookoutBadStateError("those dishes were replaced")
        verdict = check(store, data)
        if verdict != "go":
            return verdict, False, current
        if run(store):
            return "go", True, current
        again = store.get_cookout_round(seq)
        if again is not None and check(store, again) == "noop":
            return "noop", False, current
        return "bad", False, current

    try:
        verdict, changed, current = await anyio.to_thread.run_sync(_attempt)
    except _STORE_ERRORS as exc:
        return _cookout_error(exc)
    if verdict == "bad":
        return _conflict("bad_state")
    if changed:
        notifier.publish()
        start(request.app.state.background_tasks, current)
    return await _view_response(request, seq, auth, sender)


@router.post("/cookout/{seq}/concepts/retry", response_model=None)
async def retry_cookout_concepts(
    seq: int, body: CookoutGenerationIn, request: Request
) -> JSONResponse:
    """Have the chef try the three dishes again after they failed (or while the chef was
    unavailable and one now exists). A double tap while `pending` is an idempotent success."""
    runner = _runner(request)

    def _check(_store: LiveChatStore, data: dict[str, Any]) -> str:
        if data["state"] != "finished":
            return "bad"
        concepts = data["concepts"]
        if concepts == "pending":
            return "noop"
        if concepts == "failed" or (concepts == "unavailable" and runner.available):
            return "go"
        return "bad"

    return await _retry(
        request,
        seq,
        body.sender,
        body.generation,
        check=_check,
        run=lambda store: store.retry_cookout_concepts(seq, generation=body.generation),
        start=lambda background, generation: runner.start_concepts(background, seq, generation),
    )


@router.post("/cookout/{seq}/pictures/retry", response_model=None)
async def retry_cookout_pictures(
    seq: int, body: CookoutGenerationIn, request: Request
) -> JSONResponse:
    """Draw the missing dish pictures again (those already drawn are kept)."""
    runner = _runner(request)

    def _check(_store: LiveChatStore, data: dict[str, Any]) -> str:
        if data["state"] != "finished" or data["concepts"] != "ready":
            return "bad"
        if data["images"] == "pending":
            return "noop"
        missing = any(slot not in data["pictures"] for slot in CONCEPT_IDS)
        return "go" if missing and runner.images_available else "bad"

    return await _retry(
        request,
        seq,
        body.sender,
        body.generation,
        check=_check,
        run=lambda store: store.retry_cookout_pictures(seq, generation=body.generation),
        start=lambda background, _generation: runner.start_pictures(background, seq),
    )


@router.post("/cookout/{seq}/concepts/{concept_id}/recipe/retry", response_model=None)
async def retry_cookout_recipe(
    seq: int, concept_id: str, body: CookoutGenerationIn, request: Request
) -> JSONResponse:
    """Try one concept's recipe again after it failed (or while recipes were unavailable). Refused
    (`bad_state`, no job) while a rescue swap is proposed."""
    if concept_id not in CONCEPT_IDS:
        await require_server_token(request)
        return _not_found()
    runner = _runner(request)

    def _check(_store: LiveChatStore, data: dict[str, Any]) -> str:
        if data["state"] != "finished" or data["concepts"] != "ready":
            return "bad"
        if data["swap_state"] == "proposed":
            return "bad"
        recipe = data["recipes"].get(concept_id)
        if recipe is None:
            return "bad"
        if recipe["state"] == "pending":
            return "noop"
        if recipe["state"] == "failed" or (recipe["state"] == "unavailable" and runner.available):
            return "go"
        return "bad"

    return await _retry(
        request,
        seq,
        body.sender,
        body.generation,
        check=_check,
        run=lambda store: store.retry_cookout_recipe(seq, concept_id, generation=body.generation),
        start=lambda background, generation: runner.start_recipe(
            background, seq, generation, concept_id
        ),
    )


@router.post("/cookout/{seq}/recipes/{generation}/{concept_id}/cooked", response_model=None)
async def mark_cookout_cooked(
    seq: int, generation: int, concept_id: str, body: CookoutCookedIn, request: Request
) -> JSONResponse:
    """ "We cooked it!": mark a banked recipe of ANY generation cooked, or unmark it (which also
    clears its ratings and photo link)."""
    if concept_id not in CONCEPT_IDS or _bad_generation(generation):
        await require_server_token(request)
        return _not_found()
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.mark_cookout_cooked(
            anchor_seq=seq,
            sender=sender,
            email=email,
            generation=generation,
            concept_id=concept_id,
            cooked=body.cooked,
        ),
    )


@router.post("/cookout/{seq}/recipes/{generation}/{concept_id}/rating", response_model=None)
async def rate_cookout_recipe(
    seq: int, generation: int, concept_id: str, body: CookoutRatingIn, request: Request
) -> JSONResponse:
    """Set the caller's own 1-5 heart rating (or null to clear) on a cooked banked recipe."""
    if concept_id not in CONCEPT_IDS or _bad_generation(generation):
        await require_server_token(request)
        return _not_found()
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.rate_cookout_recipe(
            anchor_seq=seq,
            sender=sender,
            email=email,
            generation=generation,
            concept_id=concept_id,
            rating=body.rating,
        ),
    )


@router.post("/cookout/{seq}/recipes/{generation}/{concept_id}/photo", response_model=None)
async def link_cookout_photo(
    seq: int, generation: int, concept_id: str, body: CookoutPhotoIn, request: Request
) -> JSONResponse:
    """Link the exact mini-chat photo the chooser showed beside the AI's picture, or unlink (both
    fields null). The server validates and stores exactly that attachment; stale is `bad_state`."""
    if concept_id not in CONCEPT_IDS or _bad_generation(generation):
        await require_server_token(request)
        return _not_found()
    if (body.messageSeq is None) != (body.attachmentId is None):
        await require_server_token(request)
        return _invalid("name both the message and the photo, or neither")
    if body.messageSeq is not None and not _seq_ok(body.messageSeq):
        await require_server_token(request)
        return _invalid("messageSeq is not a message")
    if body.attachmentId is not None and _bad_id(body.attachmentId):
        await require_server_token(request)
        return _invalid("attachmentId must be 1-64 characters")
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.link_cookout_photo(
            anchor_seq=seq,
            sender=sender,
            email=email,
            generation=generation,
            concept_id=concept_id,
            message_seq=body.messageSeq,
            attachment_id=body.attachmentId,
        ),
    )
