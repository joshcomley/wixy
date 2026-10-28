"""Cookout game runtime (workspace 00058, spec/server-chat/09-cookout.md §1, §4.2): seat identity,
the turn arithmetic the store and the view share, and the wire shapes the server answers with.

The store (`LiveChatStore`) owns every transition; this module holds the PURE parts: who a viewer
is (`slot_of`), where a round currently stands (`current_turn`), what a draw must avoid
(`draw_inputs`), and the one place a round leaves the server (`cookout_view_json`), which is also
where Blind mode's redaction happens — in Python, before serialisation (spec §1.3), never in the
client. Nothing here touches the database or the clock.
"""

from __future__ import annotations

import json
import random
from collections.abc import Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from builder.jsontypes import JsonObject, JsonValue
from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat import cookout_bank as _cookout_bank
from wixy_server.livechat.models import (
    AttachmentRow,
    CookoutRecipeRow,
    CookoutRoundRow,
    CookoutTurnRow,
    MediaUrlSigner,
)

TOTAL_TURNS = 10
PICKS_PER_PLAYER = 5
MAX_SKIPS = 2
"""Two skips a turn: three pairs before a pick is forced."""
MAX_OFFERS = MAX_SKIPS + 1
CONCEPT_IDS = ("a", "b", "c")
CONCEPTS_DEADLINE_S = 900.0
PICTURES_DEADLINE_S = 600.0
RECIPE_DEADLINE_S = 900.0
MAX_ID_CHARS = 64
"""Upper bound on an ingredient id / move id carried by a request (bank ids are 2-64 characters)."""
MIN_MOVE_ID_CHARS = 8
MAX_MOVE_ID_CHARS = 64

CONCEPTS_UNAVAILABLE_TEXT = "Recipe ideas are not available on this server."
RECIPE_UNAVAILABLE_TEXT = "Writing recipes is not available on this server."


class _FallbackExhausted(Exception):
    """Stands in for the bank's own exhausted error until `cookout_bank` provides it."""


def _resolve_exhausted() -> type[Exception]:
    found = getattr(_cookout_bank, "CookoutExhaustedError", None)
    if isinstance(found, type) and issubclass(found, Exception):
        return found
    return _FallbackExhausted


CookoutDrawExhausted: type[Exception] = _resolve_exhausted()
"""The error `CookoutBank.draw_pair` raises when no valid pair exists (ruling: the bank's
`CookoutExhaustedError`); the store maps it to `409 exhausted`."""


class IngredientLike(Protocol):
    """The part of a bank `Ingredient` the game reads."""

    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...
    @property
    def category(self) -> str: ...
    @property
    def emoji(self) -> str: ...
    @property
    def family(self) -> str: ...
    @property
    def blurb(self) -> str: ...


class StapleLike(Protocol):
    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...


class BankLike(Protocol):
    """What the game needs of `cookout_bank.CookoutBank` (spec Appendix A.1). A Protocol so tests
    can drive the whole state machine with a tiny deterministic fake."""

    def ingredient(self, ingredient_id: str) -> IngredientLike | None: ...
    def staple(self, staple_id: str) -> StapleLike | None: ...
    @property
    def staples(self) -> Sequence[StapleLike]: ...
    def shuffle_role_schedule(self, rng: random.Random | None = None) -> Sequence[str]: ...
    def draw_pair(
        self,
        *,
        role: Any,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        player_offered_categories: Sequence[str],
        rng: random.Random | None = None,
    ) -> tuple[IngredientLike, IngredientLike]: ...


class CookoutRunner(Protocol):
    """What the routes need of the AI/pictures runner (spec Appendix A.2; the real one lives in
    `cookout_ai.py`). The routes only ever START a job after the store committed the transition
    that wants it; the runner owns polling, validation and the compare-and-set completion."""

    @property
    def available(self) -> bool: ...
    @property
    def images_available(self) -> bool: ...
    def start_concepts(self, background: ContainedTaskGroup, anchor_seq: int) -> None: ...
    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None: ...
    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, concept_id: str
    ) -> None: ...
    async def resume(self, background: ContainedTaskGroup) -> None: ...
    def supervise(self, background: ContainedTaskGroup) -> None: ...


class NullCookoutRunner:
    """No runner configured (the standalone edition, or the real one is not wired yet): concepts and
    recipes go `unavailable`, no pictures, no jobs."""

    available = False
    images_available = False

    def start_concepts(self, background: ContainedTaskGroup, anchor_seq: int) -> None:
        return None

    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None:
        return None

    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, concept_id: str
    ) -> None:
        return None

    async def resume(self, background: ContainedTaskGroup) -> None:
        return None

    def supervise(self, background: ContainedTaskGroup) -> None:
        return None


def default_bank() -> BankLike | None:
    """The shipped ingredient bank, or None (the game is then unavailable, chat lives): whichever
    of the bank module's tolerant loaders exists."""
    for name in ("load_cookout_bank_or_none", "load_cookout_bank_or_empty"):
        loader = getattr(_cookout_bank, name, None)
        if callable(loader):
            bank: BankLike | None = loader()
            return bank
    return None


def snapshot(ingredient: IngredientLike) -> dict[str, str]:
    """The immutable offer snapshot stored in `cookout_turns.offers` (spec §2.3 item 5): a later
    bank edit never alters an existing round. Carries `family` for the draw's exclusions."""
    return {
        "id": ingredient.id,
        "name": ingredient.name,
        "category": ingredient.category,
        "emoji": ingredient.emoji,
        "family": ingredient.family,
        "blurb": ingredient.blurb,
    }


def role_for_turn(role_schedule: Sequence[str], turn: int) -> str:
    """Each role is served on two consecutive turns (one per player): `schedule[(turn-1)//2]`."""
    return role_schedule[(turn - 1) // 2]


def player_of_turn(turn: int) -> Literal[1, 2]:
    """Odd turns belong to slot 1, even turns to slot 2."""
    return 1 if turn % 2 == 1 else 2


def slot_of(
    round_: CookoutRoundRow, viewer_key: str | None, viewer_email: str | None
) -> int | None:
    """The viewer's player slot, or None (spec §1.2). A name that is a slot but arrives under a
    different verified sign-in than the one that took the slot is someone ELSE asserting that
    name, so it is a stranger here. An unknown email on either side (dev/no-auth, grant sessions)
    falls back to the name alone."""
    if viewer_key is None:
        return None
    if round_.player1_key == viewer_key:
        slot = 1
        slot_email = round_.player1_email
    elif round_.player2_key is not None and round_.player2_key == viewer_key:
        slot = 2
        slot_email = round_.player2_email
    else:
        return None
    if viewer_email and slot_email and viewer_email.lower() != slot_email.lower():
        return None
    return slot


@dataclass(frozen=True, slots=True)
class CurrentTurn:
    turn: int
    player: Literal[1, 2]
    row: CookoutTurnRow | None
    """The drawn turn; `None` while the round waits for Player 2 to join (turn 2, not yet drawn)."""

    @property
    def waiting_for_join(self) -> bool:
        return self.row is None


def current_turn(round_: CookoutRoundRow, turns: Sequence[CookoutTurnRow]) -> CurrentTurn | None:
    """Where a `picking` round stands: the last drawn turn if it has no choice yet, else the next
    turn awaiting its first draw (only ever turn 2 with Player 2 unbound). `None` once the round is
    not `picking`, or every turn is picked."""
    if round_.state != "picking":
        return None
    if turns and turns[-1].choice_id is None:
        last = turns[-1]
        return CurrentTurn(last.turn, player_of_turn(last.turn), last)
    next_turn = len(turns) + 1
    if next_turn > TOTAL_TURNS:
        return None
    return CurrentTurn(next_turn, player_of_turn(next_turn), None)


@dataclass(frozen=True, slots=True)
class DrawInputs:
    seen_ids: frozenset[str]
    picked_families: frozenset[str]
    offered_families: frozenset[str]
    player_offered_categories: tuple[str, ...]


def draw_inputs(turns: Sequence[CookoutTurnRow], player: int) -> DrawInputs:
    """What the next pair for `player` must avoid, from the round alone (no cross-round memory):
    every id ever offered, the family of every id chosen, every family ever offered, and the
    categories of everything already shown to `player` (repeats kept, for the least-shown pick)."""
    seen: set[str] = set()
    offered_families: set[str] = set()
    picked_ids: set[str] = set()
    categories: list[str] = []
    snap_family: dict[str, str] = {}
    for row in turns:
        if row.choice_id is not None:
            picked_ids.add(row.choice_id)
        for pair in row.offers:
            for snap in pair:
                seen.add(snap["id"])
                family = snap.get("family", "")
                snap_family[snap["id"]] = family
                offered_families.add(family)
                if row.player == player:
                    categories.append(snap["category"])
    picked_families = {snap_family[i] for i in picked_ids if i in snap_family}
    return DrawInputs(
        frozenset(seen), frozenset(picked_families), frozenset(offered_families), tuple(categories)
    )


def picks_of(turns: Sequence[CookoutTurnRow], player: int | None = None) -> list[dict[str, str]]:
    """The chosen snapshots in turn order (optionally only `player`'s)."""
    picks: list[dict[str, str]] = []
    for row in turns:
        if row.choice_id is None or (player is not None and row.player != player):
            continue
        for pair in row.offers:
            match = next((s for s in pair if s["id"] == row.choice_id), None)
            if match is not None:
                picks.append(match)
                break
    return picks


def _snap_json(snap: dict[str, str]) -> JsonObject:
    """The wire `IngredientSnap`: the stored snapshot minus its draw-only `family`."""
    return {
        "id": snap["id"],
        "name": snap["name"],
        "category": snap["category"],
        "emoji": snap["emoji"],
        "blurb": snap["blurb"],
    }


def _loads(text: str | None) -> Any:
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def concept_list(round_: CookoutRoundRow) -> list[dict[str, Any]]:
    """The stored concepts (`{"concepts": [...]}` or a bare list), only well-formed objects."""
    data = _loads(round_.concepts_json)
    raw = data.get("concepts") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        return []
    return [c for c in raw if isinstance(c, dict) and c.get("id") in CONCEPT_IDS]


def concept_by_id(round_: CookoutRoundRow, concept_id: str) -> dict[str, Any] | None:
    return next((c for c in concept_list(round_) if c.get("id") == concept_id), None)


def _resolver(turns: Sequence[CookoutTurnRow], bank: BankLike | None) -> Any:
    """id -> `IngredientSnap` JSON: the round's own immutable snapshots first, then the bank."""
    by_id: dict[str, dict[str, str]] = {}
    for row in turns:
        for pair in row.offers:
            for snap in pair:
                by_id.setdefault(snap["id"], snap)

    def resolve(ingredient_id: str) -> JsonObject | None:
        snap = by_id.get(ingredient_id)
        if snap is not None:
            return _snap_json(snap)
        found = bank.ingredient(ingredient_id) if bank is not None else None
        if found is None:
            return None
        return {
            "id": found.id,
            "name": found.name,
            "category": found.category,
            "emoji": found.emoji,
            "blurb": found.blurb,
        }

    return resolve


def _staple_json(bank: BankLike | None, staple_id: str) -> JsonObject:
    staple = bank.staple(staple_id) if bank is not None else None
    return {"id": staple_id, "name": staple.name if staple is not None else staple_id}


def _concepts_data(
    round_: CookoutRoundRow, turns: Sequence[CookoutTurnRow], bank: BankLike | None
) -> list[JsonValue]:
    resolve = _resolver(turns, bank)
    out: list[JsonValue] = []
    for concept in concept_list(round_):
        picked_ids = [i for i in concept.get("pickedIngredientIds", []) if isinstance(i, str)]
        staple_ids = [i for i in concept.get("stapleIds", []) if isinstance(i, str)]
        omitted: list[JsonValue] = []
        for entry in concept.get("omitted", []):
            if not isinstance(entry, dict):
                continue
            ingredient = resolve(str(entry.get("id")))
            if ingredient is not None:
                omitted.append({"ingredient": ingredient, "reason": str(entry.get("reason", ""))})
        out.append(
            {
                "id": str(concept["id"]),
                "title": str(concept.get("title", "")),
                "vibe": str(concept.get("vibe", "")),
                "dishType": str(concept.get("dishType", "")),
                "technique": str(concept.get("technique", "")),
                "description": str(concept.get("description", "")),
                "pickedIngredients": [r for i in picked_ids if (r := resolve(i)) is not None],
                "staplesUsed": [_staple_json(bank, i) for i in staple_ids],
                "omitted": omitted,
            }
        )
    return out


def recipe_data(recipe_json: str | None, bank: BankLike | None) -> JsonObject | None:
    """A banked recipe's body for the wire: the stored validated JSON plus the server-computed
    `totalMinutes` and a display `name` on each ingredient line."""
    data = _loads(recipe_json)
    if not isinstance(data, dict):
        return None
    prep = data.get("prepMinutes")
    cook = data.get("cookMinutes")
    result: JsonObject = {k: v for k, v in data.items()}
    if isinstance(prep, int) and isinstance(cook, int):
        result["totalMinutes"] = prep + cook
    lines: list[JsonValue] = []
    for line in data.get("ingredients", []):
        if not isinstance(line, dict):
            continue
        line_id = str(line.get("id"))
        found = bank.ingredient(line_id) if bank is not None else None
        staple = bank.staple(line_id) if bank is not None else None
        name = found.name if found is not None else staple.name if staple is not None else line_id
        lines.append({**line, "name": name})
    result["ingredients"] = lines
    return result


def picture_json(
    attachment: AttachmentRow | None, signer: MediaUrlSigner | None
) -> JsonObject | None:
    """A `Picture` — only once the attachment is `ready` with its renditions (a still-processing
    one is left out; the round's `rev` moves when it finishes, so a client re-fetches)."""
    if (
        attachment is None
        or signer is None
        or attachment.status != "ready"
        or "thumb" not in attachment.renditions
        or "full" not in attachment.renditions
    ):
        return None
    return {
        "attachmentId": attachment.id,
        "thumbUrl": signer.url_for(attachment.id, "thumb"),
        "fullUrl": signer.url_for(attachment.id, "full"),
    }


def _pictures_json(
    round_: CookoutRoundRow, attachments: Sequence[AttachmentRow], signer: MediaUrlSigner | None
) -> JsonObject:
    by_id = {a.id: a for a in attachments}
    return {
        slot: picture_json(by_id.get(round_.pictures.get(slot, "")), signer) for slot in CONCEPT_IDS
    }


def cookout_view_json(
    round_: CookoutRoundRow,
    turns: Sequence[CookoutTurnRow],
    recipes: Sequence[CookoutRecipeRow],
    attachments: Sequence[AttachmentRow],
    bank: BankLike | None,
    *,
    viewer_key: str | None,
    viewer_email: str | None,
    signer: MediaUrlSigner | None,
) -> JsonObject:
    """The `GET /cookout/{seq}?as=` body (spec §4.2), personalised and — in Blind mode — redacted
    here, in Python, before it is serialised (§1.3):

    - While `picking`, the partner's `picks` are `null` (only `pickCount`), and `current.role /
      options / offerIndex / skipsRemaining` are filled only for the viewer whose turn it is
      (everyone else, a non-player included, sees only the public `turn`, `player`,
      `waitingForJoin`).
    - `history` holds only the viewer's OWN completed turns, always — even once `finished`; the
      partner's skipped and unchosen pairs never leave the server.
    - Only `state == "finished"` reveals the ten picks (`revealed`); an `abandoned` blind round
      never does.
    Open mode shows everything."""
    viewer_slot = slot_of(round_, viewer_key, viewer_email)
    blind = round_.blind
    revealed = (not blind) or round_.state == "finished"
    cur = current_turn(round_, turns)

    players: list[JsonValue] = []
    for slot in (1, 2):
        name = round_.player1_name if slot == 1 else round_.player2_name
        own = picks_of(turns, slot)
        visible = revealed or viewer_slot == slot
        players.append(
            {
                "slot": slot,
                "name": name,
                "pickCount": len(own),
                "picks": [_snap_json(s) for s in own] if visible else None,
            }
        )

    current: JsonObject | None = None
    if cur is not None:
        shown = not blind or viewer_slot == cur.player
        row = cur.row
        role = role_for_turn(round_.role_schedule, cur.turn)
        current = {
            "turn": cur.turn,
            "player": cur.player,
            "waitingForJoin": cur.waiting_for_join,
            "role": role if shown and (row is not None or not blind) else None,
            "options": (
                [_snap_json(row.offers[-1][0]), _snap_json(row.offers[-1][1])]
                if shown and row is not None
                else None
            ),
            "offerIndex": len(row.offers) - 1 if shown and row is not None else None,
            "skipsRemaining": (
                MAX_SKIPS - (len(row.offers) - 1) if shown and row is not None else None
            ),
        }

    history: list[JsonValue] = []
    for row in turns:
        if row.choice_id is None:
            continue
        if blind and row.player != viewer_slot:
            continue
        choice = next((s for pair in row.offers for s in pair if s["id"] == row.choice_id), None)
        history.append(
            {
                "turn": row.turn,
                "player": row.player,
                "offers": [[_snap_json(a), _snap_json(b)] for a, b in row.offers],
                "choice": _snap_json(choice) if choice is not None else None,
            }
        )

    finished = round_.state == "finished"
    concepts_ready = finished and round_.concepts == "ready"
    by_recipe = {r.concept_id: r for r in recipes}
    recipe_slots: JsonObject = {}
    for concept_id in CONCEPT_IDS:
        recipe = by_recipe.get(concept_id)
        if recipe is None:
            recipe_slots[concept_id] = {
                "state": "none",
                "requestedBy": None,
                "bankedAt": None,
                "error": None,
                "data": None,
            }
        else:
            recipe_slots[concept_id] = {
                "state": recipe.state,
                "requestedBy": recipe.requested_by,
                "bankedAt": recipe.banked_at,
                "error": recipe.error if recipe.state in ("failed", "unavailable") else None,
                "data": recipe_data(recipe.recipe_json, bank) if recipe.state == "banked" else None,
            }

    return {
        "seq": round_.anchor_message_seq,
        "state": round_.state,
        "rev": round_.rev,
        "blind": blind,
        "revealed": revealed,
        "players": players,
        "you": {"slot": viewer_slot} if viewer_slot is not None else None,
        "current": current,
        "history": history,
        "staples": [_staple_json(bank, s.id) for s in (bank.staples if bank is not None else ())],
        "concepts": {
            "state": round_.concepts,
            "data": _concepts_data(round_, turns, bank) if concepts_ready else None,
            "error": (
                round_.concepts_error if round_.concepts in ("failed", "unavailable") else None
            ),
        },
        "images": {
            "state": round_.images,
            "pictures": _pictures_json(round_, attachments, signer)
            if concepts_ready
            else {slot: None for slot in CONCEPT_IDS},
        },
        "recipes": recipe_slots,
    }


def bank_entry_json(
    round_: CookoutRoundRow,
    recipe: CookoutRecipeRow,
    attachments: Sequence[AttachmentRow],
    signer: MediaUrlSigner | None,
) -> JsonObject | None:
    """One `GET /cookout/bank` entry for a banked recipe; `None` when its concept or recipe body
    is unreadable (never expected: `banked` is only written with a validated body)."""
    concept = concept_by_id(round_, recipe.concept_id)
    body = _loads(recipe.recipe_json)
    if concept is None or not isinstance(body, dict):
        return None
    prep = body.get("prepMinutes")
    cook = body.get("cookMinutes")
    if not isinstance(prep, int) or not isinstance(cook, int):
        return None
    by_id = {a.id: a for a in attachments}
    return {
        "seq": round_.anchor_message_seq,
        "conceptId": recipe.concept_id,
        "title": str(concept.get("title", "")),
        "vibe": str(concept.get("vibe", "")),
        "description": str(concept.get("description", "")),
        "serves": body.get("serves", 2),
        "prepMinutes": prep,
        "cookMinutes": cook,
        "totalMinutes": prep + cook,
        "bankedAt": recipe.banked_at,
        "requestedBy": recipe.requested_by,
        "picture": picture_json(by_id.get(round_.pictures.get(recipe.concept_id, "")), signer),
    }
