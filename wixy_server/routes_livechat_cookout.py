"""`/api/admin/server/cookout*` — the Cookout two-player cooking game (workspace 00058,
spec/server-chat/09-cookout.md §4.2; docs/ai/livechat.md, Inv 57).

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
`exhausted`, 422 `invalid`, 503 `game_unavailable`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import anyio
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictBool, StrictInt

from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat.cookout_game import (
    CONCEPT_IDS,
    MAX_ID_CHARS,
    MAX_MOVE_ID_CHARS,
    MAX_OFFERS,
    MIN_MOVE_ID_CHARS,
    TOTAL_TURNS,
    BankLike,
    CookoutRunner,
    bank_entry_json,
    cookout_view_json,
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
    CookoutRoundNotFoundError,
    CookoutSkipExhaustedError,
    LiveChatStore,
)
from wixy_server.livechat.tokens import MediaSigner, ServerAuth, require_server_token
from wixy_server.routes_livechat import _SQLITE_MAX_INTEGER, _invalid, _valid_sender

router = APIRouter(prefix="/api/admin/server")

_NO_STORE = {"Cache-Control": "no-store"}


class CreateCookoutIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientId: str
    deviceId: str
    sender: str
    blind: StrictBool = False


class CookoutSenderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str


class CookoutSkipIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str
    turn: StrictInt
    offer: StrictInt


class CookoutPickIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str
    turn: StrictInt
    offer: StrictInt
    ingredientId: str


class CookoutBankIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: str
    moveId: str


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
    )
    return JSONResponse(status_code=200, content=content, headers=_NO_STORE)


@router.post("/cookout", response_model=None)
async def create_cookout(body: CreateCookoutIn, request: Request) -> JSONResponse:
    """Start a Cookout (the header's ... menu). Abandons any round still `picking`, binds the
    sender to Slot 1 and draws Turn 1's first pair; idempotent on `clientId`."""
    auth = await require_server_token(request)

    if not (8 <= len(body.clientId) <= 64):
        return _invalid("clientId must be 8-64 characters")
    if not (8 <= len(body.deviceId) <= 64):
        return _invalid("deviceId must be 8-64 characters")
    sender = body.sender.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")
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
        )

    try:
        message, created = await anyio.to_thread.run_sync(_create)
    except CookoutExhaustedError:
        # An empty or unusable bank cannot deal even the first pair: nothing to play with.
        return _unavailable()
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
    recipes = [
        entry
        for round_, recipe, attachments in rows
        if (entry := bank_entry_json(round_, recipe, attachments, signer)) is not None
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
        or not (1 <= body.turn <= TOTAL_TURNS)
        or not (0 <= body.offer < MAX_OFFERS)
    ):
        await require_server_token(request)
        return _invalid("moveId must be 8-64 characters, turn 1-10, offer 0-2")
    bank = _bank(request)
    if bank is None:
        await require_server_token(request)
        return _unavailable()
    return await _mutation(
        request,
        seq,
        body.sender,
        lambda store, sender, email: store.skip_cookout(
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
    """Pick one of the live pair. The tenth pick finishes the round and starts the concepts job."""
    if (
        _bad_move_id(body.moveId)
        or not (1 <= body.turn <= TOTAL_TURNS)
        or not (0 <= body.offer < MAX_OFFERS)
        or not (1 <= len(body.ingredientId) <= MAX_ID_CHARS)
    ):
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

    def _after(round_: CookoutRoundRow, background: ContainedTaskGroup) -> None:
        if round_.state == "finished" and round_.concepts == "pending":
            runner.start_concepts(background, seq)

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
        after=_after,
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
    State-idempotent per concept (already `pending` or `banked` starts nothing)."""
    if _bad_move_id(body.moveId):
        await require_server_token(request)
        return _invalid("moveId must be 8-64 characters")
    if concept_id not in CONCEPT_IDS:
        await require_server_token(request)
        return _not_found()
    runner = _runner(request)
    available = runner.available

    def _after(round_: CookoutRoundRow, background: ContainedTaskGroup) -> None:
        if available:
            runner.start_recipe(background, seq, concept_id)

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
            runner_available=available,
        ),
        after=_after,
    )


async def _retry(
    request: Request,
    seq: int,
    sender_raw: str,
    *,
    check: Callable[[LiveChatStore, dict[str, Any]], str],
    run: Callable[[LiveChatStore], bool],
    start: Callable[[ContainedTaskGroup], None],
) -> JSONResponse:
    """Shared body of the three retries. `check` reads the round (`get_cookout_round`) and answers
    `"go"` (attempt it), `"noop"` (already `pending`: an idempotent 200) or `"bad"`. The store's
    own transaction is still the arbiter: if the attempt finds the state moved, a re-read decides
    between an idempotent success and `bad_state`."""
    auth = await require_server_token(request)
    sender = sender_raw.strip()
    if not _valid_sender(sender):
        return _invalid("sender must be 1-32 characters with no control characters")
    if not _seq_ok(seq):
        return _not_found()
    store: LiveChatStore = request.app.state.livechat_store
    notifier: LiveChatNotifier = request.app.state.livechat_notifier
    email = auth.email or None

    def _attempt() -> tuple[str, bool]:
        slot = store.cookout_player_slot(anchor_seq=seq, sender=sender, email=email)
        if slot is None:
            raise CookoutNotPlayerError("you are not a player in this round")
        data = store.get_cookout_round(seq)
        if data is None:
            raise CookoutRoundNotFoundError(seq)
        verdict = check(store, data)
        if verdict != "go":
            return verdict, False
        if run(store):
            return "go", True
        again = store.get_cookout_round(seq)
        if again is not None and check(store, again) == "noop":
            return "noop", False
        return "bad", False

    try:
        verdict, changed = await anyio.to_thread.run_sync(_attempt)
    except _STORE_ERRORS as exc:
        return _cookout_error(exc)
    if verdict == "bad":
        return _conflict("bad_state")
    if changed:
        notifier.publish()
        start(request.app.state.background_tasks)
    return await _view_response(request, seq, auth, sender)


@router.post("/cookout/{seq}/concepts/retry", response_model=None)
async def retry_cookout_concepts(seq: int, body: CookoutSenderIn, request: Request) -> JSONResponse:
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
        check=_check,
        run=lambda store: store.retry_cookout_concepts(seq),
        start=lambda background: runner.start_concepts(background, seq),
    )


@router.post("/cookout/{seq}/pictures/retry", response_model=None)
async def retry_cookout_pictures(seq: int, body: CookoutSenderIn, request: Request) -> JSONResponse:
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
        check=_check,
        run=lambda store: store.retry_cookout_pictures(seq),
        start=lambda background: runner.start_pictures(background, seq),
    )


@router.post("/cookout/{seq}/concepts/{concept_id}/recipe/retry", response_model=None)
async def retry_cookout_recipe(
    seq: int, concept_id: str, body: CookoutSenderIn, request: Request
) -> JSONResponse:
    """Try one concept's recipe again after it failed (or while recipes were unavailable)."""
    if concept_id not in CONCEPT_IDS:
        await require_server_token(request)
        return _not_found()
    runner = _runner(request)

    def _check(_store: LiveChatStore, data: dict[str, Any]) -> str:
        if data["state"] != "finished" or data["concepts"] != "ready":
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
        check=_check,
        run=lambda store: store.retry_cookout_recipe(seq, concept_id),
        start=lambda background: runner.start_recipe(background, seq, concept_id),
    )
