"""Cookout game runtime (workspace 00058, spec/server-chat/09-cookout.md §1, §4.2 and the twists
addendum 09a): seat identity, the turn arithmetic the store and the view share, and the wire shapes
the server answers with.

The store (`LiveChatStore`) owns every transition; this module holds the PURE parts: who a viewer
is (`slot_of`), where a round currently stands (`current_turn`), what a draw must avoid
(`draw_inputs`), the effective basket (`basket_snaps`), the chef gate (`waiting_for`), and the one
place a round leaves the server (`cookout_view_json`), which is also where Blind mode's redaction
happens — in Python, before serialisation (spec §1.3), never in the client. Nothing here touches the
database or the clock.
"""

from __future__ import annotations

import json
import random
from collections.abc import Mapping, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast

from builder.jsontypes import JsonObject, JsonValue
from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat import cookout_twists
from wixy_server.livechat.cookout_bank import CookoutExhaustedError, load_cookout_bank_or_empty
from wixy_server.livechat.cookout_modes import CookoutMode, default_modes
from wixy_server.livechat.cookout_visuals import default_visuals
from wixy_server.livechat.models import (
    AttachmentRow,
    CookoutGenerationRow,
    CookoutRecipeRow,
    CookoutRoundRow,
    CookoutTurnRow,
    MediaUrlSigner,
)

TOTAL_TURNS = 10
PICKS_PER_PLAYER = 5
"""The Classic constants. Every use that decides round flow reads the round's game mode instead
(`turns_of`, spec 09c §5.3); these stay as Classic's data and the fallback for an unknown mode."""
CLASSIC_MODE_ID = "classic"
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
MAX_STARTERS = 2
"""Spec 09a §1.3: at most two starters (one per player's first turn) so both draft equally."""
MIN_SEARCH_CHARS = 2
MAX_SEARCH_CHARS = 40
MAX_ROUND_PHOTOS = 50

CONCEPTS_UNAVAILABLE_TEXT = "Recipe ideas are not available on this server."
RECIPE_UNAVAILABLE_TEXT = "Writing recipes is not available on this server."

Via = Literal["pick", "lucky", "chaos", "seed", "wildcard", "swap"]


CookoutDrawExhausted = CookoutExhaustedError
"""The error `CookoutBank.draw_pair` raises when no valid pair exists; the store maps it to
`409 exhausted`."""


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
    @property
    def role(self) -> str: ...


class StapleLike(Protocol):
    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...


class BankLike(Protocol):
    """What the game needs of `cookout_bank.CookoutBank` (spec 09a Appendix A.1). A Protocol so
    tests can drive the whole state machine with a tiny deterministic fake. A Classic round calls
    the draws exactly as before; a sequence game mode additionally passes `candidates` and `facet`
    (and `search` a `candidates` pool) — the frozen interface A.2 — which only the real bank
    implements (`draw_kwargs`)."""

    def ingredient(self, ingredient_id: str) -> IngredientLike | None: ...
    def staple(self, staple_id: str) -> StapleLike | None: ...
    @property
    def staples(self) -> Sequence[StapleLike]: ...
    def shuffle_role_schedule(
        self, rng: random.Random | None = None, *, first_role: Any = None
    ) -> Sequence[str]: ...
    def draw_pair(
        self,
        *,
        role: Any,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        player_offered_categories: Sequence[str],
        rng: random.Random | None = None,
        rarity_mode: Any = "normal",
    ) -> tuple[IngredientLike, IngredientLike]: ...
    def draw_replacement(
        self,
        *,
        role: Any,
        keep_id: str,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        player_offered_categories: Sequence[str],
        rarity_mode: Any = "normal",
        rng: random.Random | None = None,
    ) -> IngredientLike: ...
    def draw_wildcard(
        self,
        *,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        basket_categories: AbstractSet[str],
        rng: random.Random | None = None,
    ) -> IngredientLike: ...
    def search(self, query: str, *, limit: int = 20) -> Sequence[IngredientLike]: ...


class CookoutRunner(Protocol):
    """What the routes need of the AI/pictures runner (spec 09a Appendix A.2; the real one lives
    in `cookout_ai.py`). The routes only ever START a job after the store committed the transition
    that wants it; the runner owns polling, validation and the compare-and-set completion. A
    concepts or recipe job carries the round `generation` it was started for (spec 09a §1.10)."""

    @property
    def available(self) -> bool: ...
    @property
    def images_available(self) -> bool: ...
    def start_concepts(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int
    ) -> None: ...
    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None: ...
    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int, concept_id: str
    ) -> None: ...
    async def resume(self, background: ContainedTaskGroup) -> None: ...
    def supervise(self, background: ContainedTaskGroup) -> None: ...


class NullCookoutRunner:
    """No runner configured (the standalone edition, or the real one is not wired yet): concepts and
    recipes go `unavailable`, no pictures, no jobs."""

    available = False
    images_available = False

    def start_concepts(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int
    ) -> None:
        return None

    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None:
        return None

    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int, concept_id: str
    ) -> None:
        return None

    async def resume(self, background: ContainedTaskGroup) -> None:
        return None

    def supervise(self, background: ContainedTaskGroup) -> None:
        return None


def default_bank() -> BankLike:
    """The shipped ingredient bank. A missing or malformed file yields an EMPTY bank (the loader
    logs why): the game is then unavailable (`503 game_unavailable`), chat lives."""
    return load_cookout_bank_or_empty()


@dataclass(frozen=True, slots=True)
class EncoreSpec:
    """Leftover encore / remix (twist T9, spec 09a §1.3): the concept a new round is seeded from."""

    from_seq: int
    generation: int
    concept_id: str
    kind: Literal["leftovers", "remix"]
    seed_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CookoutSetup:
    """The start-sheet twists, fixed at creation (spec 09a §1.1). The all-default value is the
    core game, byte for byte."""

    style: str | None = None
    style_spun: bool = False
    challenge: str | None = None
    wildcard: bool = False
    stars: bool = False
    fridge_seed_id: str | None = None
    encore: EncoreSpec | None = None

    @property
    def chef_only(self) -> bool:
        """True when any option exists only to change what the chef makes."""
        return bool(self.style or self.challenge or self.wildcard or self.stars)


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


def round_mode(round_: CookoutRoundRow) -> CookoutMode | None:
    """The game mode this process knows for the round, or `None` for a mode it does not know (a
    row written by a newer release: untouchable, spec 09c §5.6)."""
    return default_modes().mode(round_.mode)


def turns_of(round_: CookoutRoundRow) -> int:
    """How many turns the round has: the mode's, else (an unknown mode, read-only) the stored
    schedule's length, else Classic's."""
    mode = round_mode(round_)
    if mode is not None:
        return mode.turns
    return len(round_.role_schedule) or TOTAL_TURNS


def kind_of_turn(round_: CookoutRoundRow, turn: int) -> str | None:
    """The pick kind a turn offers (Classic: the bank role), `None` for an unknown mode."""
    mode = round_mode(round_)
    return None if mode is None else mode.kind_for_turn(round_.role_schedule, turn)


def draw_kwargs(mode: CookoutMode, kind_id: str) -> dict[str, Any]:
    """The extra keyword arguments the bank's draws take for a kind: nothing for Classic (the core
    draw, byte for byte), the kind's candidate pool and facet for a sequence mode."""
    if mode.plan_type == "classic":
        return {}
    kind = mode.kinds[kind_id]
    return {"candidates": kind.candidates, "facet": kind.facet}


def shown_for(inputs: DrawInputs, mode: CookoutMode, kind_id: str) -> tuple[str, ...]:
    """The shown-so-far list matching the kind's facet (categories or families)."""
    if mode.plan_type != "classic" and mode.kinds[kind_id].facet == "family":
        return inputs.player_offered_families
    return inputs.player_offered_categories


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
    """The drawn turn; `None` while the round waits for Player 2 to join (their turn, not drawn)."""

    @property
    def waiting_for_join(self) -> bool:
        return self.row is None


def current_turn(round_: CookoutRoundRow, turns: Sequence[CookoutTurnRow]) -> CurrentTurn | None:
    """Where a `picking` round stands: the last drawn turn if it has no choice yet, else the next
    turn awaiting its first draw (a Player 2 turn with Player 2 unbound). `None` once the round is
    not `picking`, or every turn is picked."""
    if round_.state != "picking":
        return None
    if turns and turns[-1].choice_id is None:
        last = turns[-1]
        return CurrentTurn(last.turn, player_of_turn(last.turn), last)
    next_turn = len(turns) + 1
    if next_turn > turns_of(round_):
        return None
    return CurrentTurn(next_turn, player_of_turn(next_turn), None)


def next_turn_draws_now(round_: CookoutRoundRow, next_turn: int) -> bool:
    """Spec 09a §1.3: *a turn belonging to Player 2 is never drawn until Player 2 is bound.*"""
    if next_turn > turns_of(round_):
        return False
    return not (player_of_turn(next_turn) == 2 and round_.player2_key is None)


@dataclass(frozen=True, slots=True)
class DrawInputs:
    seen_ids: frozenset[str]
    picked_families: frozenset[str]
    offered_families: frozenset[str]
    player_offered_categories: tuple[str, ...]
    player_offered_families: tuple[str, ...] = ()


def turn_snaps(turns: Sequence[CookoutTurnRow]) -> dict[str, dict[str, str]]:
    """Every ingredient snapshot a round's turns hold, by id: seeds, offered options and the
    options a veto or the chaos shelf replaced."""
    by_id: dict[str, dict[str, str]] = {}
    for row in turns:
        if row.seed is not None:
            by_id.setdefault(row.seed["id"], row.seed)
        for pair in row.offers:
            for snap in pair:
                by_id.setdefault(snap["id"], snap)
        for entry in row.replaced:
            replaced_snap = entry.get("snap")
            if isinstance(replaced_snap, dict):
                by_id.setdefault(str(replaced_snap["id"]), replaced_snap)
    return by_id


def draw_inputs(turns: Sequence[CookoutTurnRow], player: int) -> DrawInputs:
    """What the next pair for `player` must avoid, from the round alone (no cross-round memory):
    every id ever offered (starters and replaced options included), the family of every id chosen,
    every family ever offered, and the categories of everything already shown to `player` (repeats
    kept, for the least-shown pick). A starter was never shown as an option, so it does not count
    towards any category."""
    seen: set[str] = set()
    offered_families: set[str] = set()
    picked_ids: set[str] = set()
    categories: list[str] = []
    families: list[str] = []
    snap_family: dict[str, str] = {}
    for row in turns:
        if row.choice_id is not None:
            picked_ids.add(row.choice_id)
        if row.seed is not None:
            seen.add(row.seed["id"])
            family = row.seed.get("family", "")
            snap_family[row.seed["id"]] = family
            offered_families.add(family)
        for pair in row.offers:
            for snap in pair:
                seen.add(snap["id"])
                family = snap.get("family", "")
                snap_family[snap["id"]] = family
                offered_families.add(family)
                if row.player == player:
                    categories.append(snap["category"])
                    families.append(family)
        for entry in row.replaced:
            snap = entry["snap"]
            seen.add(snap["id"])
            family = snap.get("family", "")
            snap_family[snap["id"]] = family
            offered_families.add(family)
            if row.player == player:
                categories.append(snap["category"])
                families.append(family)
    picked_families = {snap_family[i] for i in picked_ids if i in snap_family}
    return DrawInputs(
        frozenset(seen),
        frozenset(picked_families),
        frozenset(offered_families),
        tuple(categories),
        tuple(families),
    )


def choice_snap(row: CookoutTurnRow) -> dict[str, str] | None:
    """The snapshot a picked turn chose (the seed for a seeded turn)."""
    if row.choice_id is None:
        return None
    if row.seed is not None and row.seed["id"] == row.choice_id:
        return row.seed
    for pair in row.offers:
        for snap in pair:
            if snap["id"] == row.choice_id:
                return snap
    return None


def picks_of(turns: Sequence[CookoutTurnRow], player: int | None = None) -> list[dict[str, str]]:
    """The chosen snapshots in turn order (optionally only `player`'s), starters included."""
    picks: list[dict[str, str]] = []
    for row in turns:
        if row.choice_id is None or (player is not None and row.player != player):
            continue
        snap = choice_snap(row)
        if snap is not None:
            picks.append(snap)
    return picks


def via_of(row: CookoutTurnRow) -> Via:
    """How a picked turn's ingredient got into the basket (spec 09a §4.3 `PickSnap.via`)."""
    if row.seed is not None:
        return "seed"
    if row.lucky:
        return "lucky"
    if row.chaos_offer is not None and row.chaos_offer == len(row.offers) - 1:
        return "chaos"
    return "pick"


def basket_snaps(
    round_: CookoutRoundRow, turns: Sequence[CookoutTurnRow]
) -> list[tuple[int | None, Via, dict[str, str]]]:
    """The EFFECTIVE basket (spec 09a §2.4) as `(turn, via, snapshot)`: the ten turn choices in turn
    order (the seed for a seeded turn), `swap_out_id` replaced by `swap_in` once the swap is done,
    then the lifted wildcard appended (itself replaced if it was the swap target)."""
    out: list[tuple[int | None, Via, dict[str, str]]] = []
    swapped = (
        round_.swap_state == "done"
        and round_.swap_out_id is not None
        and round_.swap_in is not None
    )
    for row in turns:
        snap = choice_snap(row)
        if snap is None:
            continue
        if swapped and round_.swap_in is not None and snap["id"] == round_.swap_out_id:
            out.append((row.turn, "swap", round_.swap_in))
        else:
            out.append((row.turn, via_of(row), snap))
    if round_.wildcard == "lifted" and round_.wildcard_snap is not None:
        wild = round_.wildcard_snap
        if swapped and round_.swap_in is not None and wild["id"] == round_.swap_out_id:
            out.append((None, "swap", round_.swap_in))
        else:
            out.append((None, "wildcard", wild))
    return out


def round_snaps(
    round_: CookoutRoundRow, turns: Sequence[CookoutTurnRow]
) -> dict[str, dict[str, str]]:
    """Every immutable ingredient snapshot a round owns, by id: its turns' (seeds, offers, replaced
    options), the wildcard, the swap pair(s) and the swapped-in item."""
    by_id: dict[str, dict[str, str]] = dict(turn_snaps(turns))
    extra: list[dict[str, str]] = []
    if round_.wildcard_snap is not None:
        extra.append(round_.wildcard_snap)
    if round_.swap_in is not None:
        extra.append(round_.swap_in)
    if round_.swap_pair is not None:
        extra.extend(round_.swap_pair)
    extra.extend(round_.swap_seen)
    for snap in extra:
        by_id.setdefault(snap["id"], snap)
    return by_id


def basket_ids(round_: CookoutRoundRow, turns: Sequence[CookoutTurnRow]) -> list[str]:
    return [snap["id"] for _, _, snap in basket_snaps(round_, turns)]


def swap_target_role(
    round_: CookoutRoundRow, turns: Sequence[CookoutTurnRow], target_id: str, bank: BankLike
) -> str | None:
    """The kind a replacement for `target_id` must serve (Classic: the bank role): the turn's kind
    for a drafted pick, the mode's classification for a starter or the wildcard; `None` when the
    id is not in the basket (or the round's mode is unknown)."""
    mode = round_mode(round_)
    if mode is None:
        return None

    def classified(ingredient_id: str) -> str | None:
        if mode.plan_type == "classic":
            found = bank.ingredient(ingredient_id)
            return found.role if found is not None else None
        return mode.kind_of(ingredient_id)

    for row in turns:
        if row.choice_id == target_id:
            if row.seed is not None:
                return classified(target_id)
            return mode.kind_for_turn(round_.role_schedule, row.turn)
    if round_.wildcard == "lifted" and round_.wildcard_snap is not None:
        if round_.wildcard_snap["id"] == target_id:
            return classified(target_id)
    return None


def stars_locked(round_: CookoutRoundRow) -> bool:
    """Reveal and lock are ONE transition (spec 09a §1.5)."""
    return (
        round_.state == "finished" and round_.star1_id is not None and round_.star2_id is not None
    )


def waiting_for(round_: CookoutRoundRow) -> tuple[Literal["stars", "wildcard"], ...]:
    """The chef gate (spec 09a §1.4): what a finished round still waits for before the concepts job
    may start. Empty = the gate is clear (or the round is not in the gated position)."""
    if round_.state != "finished" or round_.concepts != "none":
        return ()
    waiting: list[Literal["stars", "wildcard"]] = []
    if round_.stars and (round_.star1_id is None or round_.star2_id is None):
        waiting.append("stars")
    if round_.wildcard in ("armed", "offered"):
        waiting.append("wildcard")
    return tuple(waiting)


def waiting_from_columns(
    state: str, concepts: str, wildcard: str, stars: bool, star1: str | None, star2: str | None
) -> tuple[Literal["stars", "wildcard"], ...]:
    """`waiting_for` over raw `cookout_rounds` columns (the broadcast summary query)."""
    if state != "finished" or concepts != "none":
        return ()
    waiting: list[Literal["stars", "wildcard"]] = []
    if stars and (star1 is None or star2 is None):
        waiting.append("stars")
    if wildcard in ("armed", "offered"):
        waiting.append("wildcard")
    return tuple(waiting)


def chaos_used(turns: Sequence[CookoutTurnRow], slot: int) -> bool:
    """Player `slot` has spent the chaos shelf (derived, not stored: spec 09a §1.2)."""
    return any(t.player == slot and t.chaos_offer is not None for t in turns)


def veto_used(turns: Sequence[CookoutTurnRow], slot: int) -> bool:
    """Player `slot` has spent the veto: one of their PARTNER's turns carries a veto."""
    return any(t.player != slot and t.veto_offer is not None for t in turns)


def _snap_json(snap: dict[str, str]) -> JsonObject:
    """The wire `IngredientSnap`: the stored snapshot minus its draw-only `family`, plus the
    read-time `what` and `image` looked up by id (09b E.1). The stored snapshot never changes; a
    better picture shipped later simply shows up."""
    extras = default_visuals().snap_extras(snap["id"])
    return {
        "id": snap["id"],
        "name": snap["name"],
        "category": snap["category"],
        "emoji": snap["emoji"],
        "blurb": snap["blurb"],
        "what": cast("str | None", extras["what"]),
        "image": cast("JsonObject | None", extras["image"]),
    }


def _facts_json(ingredient_id: str) -> JsonValue:
    facts = default_visuals().facts(ingredient_id)
    return cast("JsonValue", facts)


def _with_facts(out: JsonObject, ingredient_id: str, facts: bool) -> JsonObject:
    if facts:
        out["facts"] = _facts_json(ingredient_id)
    return out


def _pick_json(
    turn: int | None,
    via: Via,
    snap: dict[str, str],
    *,
    facts: bool = False,
    kind: str | None = None,
) -> JsonObject:
    """A `PickSnap`. `facts` is sent only once the round is past picking (09b E.1). `kind` is the
    pick kind the ingredient served (spec 09c §5.3); it rides with the pick, so it is exactly as
    visible as the pick."""
    return _with_facts(
        {**_snap_json(snap), "turn": turn, "via": via, "kind": kind}, snap["id"], facts
    )


def _pick_kind(
    round_: CookoutRoundRow,
    mode: CookoutMode | None,
    turn: int | None,
    via: Via,
    ingredient_id: str,
) -> str | None:
    """The kind a pick served: the turn's kind for a drafted pick (a swap serves the kind it
    replaced), the mode's classification for a starter or the wildcard."""
    if mode is None:
        return None
    if turn is None or via in ("seed", "wildcard"):
        return mode.kind_of(ingredient_id)
    return mode.kind_for_turn(round_.role_schedule, turn)


def mode_json(round_: CookoutRoundRow, mode: CookoutMode | None) -> JsonObject:
    """The public `mode` block of the view (spec 09c §5.4). A round of a mode this process does
    not know is described from what is stored, with no kinds."""
    if mode is None:
        total = turns_of(round_)
        return {
            "id": round_.mode,
            "label": round_.mode,
            "emoji": "",
            "turns": total,
            "picksPerPlayer": total // 2,
            "kinds": [],
            "anchorKind": None,
        }
    return {
        "id": mode.id,
        "label": mode.label,
        "emoji": mode.emoji,
        "turns": mode.turns,
        "picksPerPlayer": mode.picks_per_player,
        "kinds": [{"id": k.id, "label": k.label, "prompt": k.prompt} for k in mode.kinds.values()],
        "anchorKind": mode.chef.anchor_kind,
    }


def build_ref(mode: CookoutMode | None, build_id: object) -> JsonObject | None:
    """A concept's `build` as `{id, label}`; `None` for Classic (no builds)."""
    if mode is None or not isinstance(build_id, str) or not build_id:
        return None
    found = next((b for b in mode.chef.builds if b.id == build_id), None)
    return {"id": build_id, "label": found.label if found is not None else build_id}


def _loads(text: str | None) -> Any:
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def concepts_from_json(text: str | None) -> list[dict[str, Any]]:
    """Stored concepts (`{"concepts": [...]}` or a bare list), only well-formed objects."""
    data = _loads(text)
    raw = data.get("concepts") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        return []
    return [c for c in raw if isinstance(c, dict) and c.get("id") in CONCEPT_IDS]


def concept_list(round_: CookoutRoundRow) -> list[dict[str, Any]]:
    """The stored concepts of the CURRENT generation."""
    return concepts_from_json(round_.concepts_json)


def concept_by_id(round_: CookoutRoundRow, concept_id: str) -> dict[str, Any] | None:
    return next((c for c in concept_list(round_) if c.get("id") == concept_id), None)


def _resolver(
    round_: CookoutRoundRow | None, turns: Sequence[CookoutTurnRow], bank: BankLike | None
) -> Any:
    """id -> `IngredientSnap` JSON: the round's own immutable snapshots first, then the bank."""
    by_id: dict[str, dict[str, str]] = (
        round_snaps(round_, turns) if round_ is not None else dict(turn_snaps(turns))
    )

    def resolve(ingredient_id: str) -> JsonObject | None:
        snap = by_id.get(ingredient_id)
        if snap is not None:
            return _snap_json(snap)
        found = bank.ingredient(ingredient_id) if bank is not None else None
        if found is None:
            return None
        return bank_ingredient_json(found)

    return resolve


def bank_ingredient_json(found: IngredientLike) -> JsonObject:
    """A bank ingredient as an `IngredientSnap` (fridge search, options, resolver fallback)."""
    return _snap_json(snapshot(found))


def _staple_json(bank: BankLike | None, staple_id: str) -> JsonObject:
    staple = bank.staple(staple_id) if bank is not None else None
    extras = default_visuals().snap_extras(staple_id)
    return {
        "id": staple_id,
        "name": staple.name if staple is not None else staple_id,
        "image": cast("JsonObject | None", extras["image"]),
    }


def _concept_cards(
    concepts: Sequence[dict[str, Any]],
    resolve: Any,
    bank: BankLike | None,
    mode: CookoutMode | None = None,
) -> list[JsonValue]:
    out: list[JsonValue] = []
    for concept in concepts:
        picked_ids = [i for i in concept.get("pickedIngredientIds", []) if isinstance(i, str)]
        staple_ids = [i for i in concept.get("stapleIds", []) if isinstance(i, str)]
        omitted: list[JsonValue] = []
        for entry in concept.get("omitted", []):
            if not isinstance(entry, dict):
                continue
            ingredient = resolve(str(entry.get("id")))
            if ingredient is not None:
                omitted.append({"ingredient": ingredient, "reason": str(entry.get("reason", ""))})
        note = concept.get("challengeNote")
        minutes = concept.get("totalMinutes")
        out.append(
            {
                "id": str(concept["id"]),
                "title": str(concept.get("title", "")),
                "vibe": str(concept.get("vibe", "")),
                "dishType": str(concept.get("dishType", "")),
                "technique": str(concept.get("technique", "")),
                "build": build_ref(mode, concept.get("build")),
                "description": str(concept.get("description", "")),
                "pickedIngredients": [r for i in picked_ids if (r := resolve(i)) is not None],
                "staplesUsed": [_staple_json(bank, i) for i in staple_ids],
                "omitted": omitted,
                "challengeNote": note if isinstance(note, str) else None,
                "totalMinutes": minutes
                if isinstance(minutes, int) and not isinstance(minutes, bool)
                else None,
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
    pictures: Mapping[str, str], attachments: Sequence[AttachmentRow], signer: MediaUrlSigner | None
) -> JsonObject:
    by_id = {a.id: a for a in attachments}
    return {slot: picture_json(by_id.get(pictures.get(slot, "")), signer) for slot in CONCEPT_IDS}


def _catalogue_ref(entry: Any, ident: str) -> JsonObject:
    if entry is None:
        return {"id": ident, "label": ident, "emoji": ""}
    return {"id": entry.id, "label": entry.label, "emoji": entry.emoji}


def style_ref(style_id: str | None) -> JsonObject | None:
    return (
        None if style_id is None else _catalogue_ref(cookout_twists.style_by_id(style_id), style_id)
    )


def challenge_ref(challenge_id: str | None) -> JsonObject | None:
    return (
        None
        if challenge_id is None
        else _catalogue_ref(cookout_twists.challenge_by_id(challenge_id), challenge_id)
    )


def _linked_photo(
    recipe: CookoutRecipeRow,
    photo_attachments: Sequence[AttachmentRow],
    signer: MediaUrlSigner | None,
) -> JsonObject | None:
    """The "Our plate" picture: shown only while the linked attachment still exists on the linked
    message, is a photo and is `ready` (spec 09a §1.8)."""
    if recipe.photo_message_seq is None or recipe.photo_attachment_id is None:
        return None
    for attachment in photo_attachments:
        if (
            attachment.id == recipe.photo_attachment_id
            and attachment.message_seq == recipe.photo_message_seq
            and attachment.kind == "photo"
        ):
            return picture_json(attachment, signer)
    return None


def _recipe_slot(
    recipe: CookoutRecipeRow | None,
    bank: BankLike | None,
    photo_attachments: Sequence[AttachmentRow],
    signer: MediaUrlSigner | None,
    generation: int,
) -> JsonObject:
    if recipe is None:
        return {
            "state": "none",
            "requestedBy": None,
            "bankedAt": None,
            "error": None,
            "data": None,
            "generation": generation,
            "cooked": None,
        }
    cooked: JsonObject | None = None
    if recipe.state == "banked" and recipe.cooked_at is not None:
        cooked = {
            "cookedAt": recipe.cooked_at,
            "cookedBy": recipe.cooked_by or "",
            "ratings": {"1": recipe.rating1, "2": recipe.rating2},
            "photo": _linked_photo(recipe, photo_attachments, signer),
            "photoMessageSeq": recipe.photo_message_seq,
        }
    return {
        "state": recipe.state,
        "requestedBy": recipe.requested_by,
        "bankedAt": recipe.banked_at,
        "error": recipe.error if recipe.state in ("failed", "unavailable") else None,
        "data": recipe_data(recipe.recipe_json, bank) if recipe.state == "banked" else None,
        "generation": recipe.generation,
        "cooked": cooked,
    }


def _vote_result(vote1: str | None, vote2: str | None) -> tuple[JsonObject | None, str | None]:
    """`(votes, match)` — non-null only when BOTH votes exist (spec 09a §1.7); a one-sided vote is
    never serialised, for anyone."""
    if vote1 is None or vote2 is None:
        return None, None
    return {"1": vote1, "2": vote2}, (vote1 if vote1 == vote2 else None)


def dinner_pick(vote1: str | None, vote2: str | None, concept_id: str) -> bool:
    return vote1 is not None and vote1 == vote2 and vote1 == concept_id


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
    generations: Sequence[CookoutGenerationRow] = (),
    all_recipes: Sequence[CookoutRecipeRow] = (),
    photo_attachments: Sequence[AttachmentRow] = (),
    encore_title: str | None = None,
) -> JsonObject:
    """The `GET /cookout/{seq}?as=` body (spec §4.2, 09a §4.3), personalised and — in Blind mode —
    redacted here, in Python, before it is serialised (§1.3):

    - While `picking`, the partner's `picks` are `null` (only `pickCount`), and `current.role /
      options / offerIndex / skipsRemaining` (and the twist fields beside them) are filled only for
      the viewer whose turn it is (everyone else, a non-player included, sees only the public
      `turn`, `player`, `waitingForJoin`). Starters are public and ride in `starters`.
    - `history` holds only the viewer's OWN completed turns, always — even once `finished`; the
      partner's skipped, replaced and unchosen options never leave the server.
    - Only `state == "finished"` reveals the picks (`revealed`); an `abandoned` blind round never
      does. Secret stars and dinner votes stay hidden from the partner in BOTH modes until their own
      reveal moment.
    Open mode shows everything except those two secrets."""
    viewer_slot = slot_of(round_, viewer_key, viewer_email)
    mode = round_mode(round_)
    blind = round_.blind
    revealed = (not blind) or round_.state == "finished"
    # Facts ride only on picks once the round is past `picking` (09b E.1): not needed earlier, and
    # it keeps the frequently polled view small.
    with_facts = round_.state != "picking"
    cur = current_turn(round_, turns)

    players: list[JsonValue] = []
    for slot in (1, 2):
        name = round_.player1_name if slot == 1 else round_.player2_name
        own = [(row, choice_snap(row)) for row in turns if row.player == slot]
        own_picks = [(r, s) for r, s in own if r.choice_id is not None and s is not None]
        visible = revealed or viewer_slot == slot
        chaos_visible = viewer_slot == slot or not blind or revealed
        players.append(
            {
                "slot": slot,
                "name": name,
                "pickCount": len(own_picks),
                "picks": (
                    [
                        _pick_json(
                            r.turn,
                            via_of(r),
                            s,
                            facts=with_facts,
                            kind=_pick_kind(round_, mode, r.turn, via_of(r), s["id"]),
                        )
                        for r, s in own_picks
                        if s is not None
                    ]
                    if visible
                    else None
                ),
                "chaosUsed": chaos_used(turns, slot) if chaos_visible else None,
                "vetoUsed": veto_used(turns, slot),
            }
        )

    starters: list[JsonValue] = [
        _pick_json(
            row.turn,
            "seed",
            row.seed,
            kind=_pick_kind(round_, mode, row.turn, "seed", row.seed["id"]),
        )
        for row in turns
        if row.seed is not None
    ]

    current: JsonObject | None = None
    if cur is not None:
        shown = not blind or viewer_slot == cur.player
        row = cur.row
        role = kind_of_turn(round_, cur.turn)
        live_pair = row is not None and bool(row.offers)
        chaos_pair: bool | None = None
        vetoed: JsonObject | None = None
        can_chaos: bool | None = None
        can_lucky: bool | None = None
        if shown and row is not None:
            index = len(row.offers) - 1
            chaos_pair = row.chaos_offer is not None and row.chaos_offer == index
            # The "swept" banner belongs to the table the veto changed: a later chaos shelf on the
            # same offer replaced that table, so the banner is stale and goes (spec 09a §1.9).
            swept = None
            if row.veto_offer == index:
                for e in reversed([e for e in row.replaced if e.get("offer") == index]):
                    if e.get("by") == "chaos":
                        break
                    if e.get("by") == "veto":
                        swept = e
                        break
            vetoed = {"snap": _snap_json(swept["snap"])} if swept is not None else None
            active = viewer_slot == cur.player
            # Chaos is a kind-level setting (the bread turn offers no weird shelf) and every
            # in-game twist button follows the mode's twist list (spec 09c §4); an unknown mode
            # is read-only, with no actions at all (§5.6).
            chaos_here = (
                mode is not None
                and "chaos" in mode.twists
                and (mode.plan_type == "classic" or mode.kinds[str(role)].chaos)
            )
            can_chaos = bool(
                chaos_here and active and live_pair and not chaos_used(turns, cur.player)
            )
            can_lucky = bool(mode is not None and "lucky" in mode.twists and active and live_pair)
        can_veto: bool | None = None
        if not blind:
            can_veto = bool(
                mode is not None
                and "veto" in mode.twists
                and viewer_slot is not None
                and viewer_slot != cur.player
                and row is not None
                and row.offers
                and row.veto_offer is None
                and not veto_used(turns, viewer_slot)
                and round_.player2_key is not None
            )
        current = {
            "turn": cur.turn,
            "player": cur.player,
            "waitingForJoin": cur.waiting_for_join,
            "role": role if shown and (row is not None or not blind) else None,
            "options": (
                [_snap_json(row.offers[-1][0]), _snap_json(row.offers[-1][1])]
                if shown and row is not None and row.offers
                else None
            ),
            "offerIndex": len(row.offers) - 1 if shown and row is not None else None,
            "skipsRemaining": (
                MAX_SKIPS - (len(row.offers) - 1) if shown and row is not None else None
            ),
            "chaosPair": chaos_pair,
            "vetoed": vetoed,
            "canChaos": can_chaos,
            "canLucky": can_lucky,
            "canVeto": can_veto,
        }

    history: list[JsonValue] = []
    for row in turns:
        if row.choice_id is None:
            continue
        if blind and row.player != viewer_slot:
            continue
        choice = choice_snap(row)
        history.append(
            {
                "turn": row.turn,
                "player": row.player,
                "offers": [[_snap_json(a), _snap_json(b)] for a, b in row.offers],
                "choice": _snap_json(choice) if choice is not None else None,
                "seed": _snap_json(row.seed) if row.seed is not None else None,
                "replaced": [
                    {
                        "offer": int(e["offer"]),
                        "snap": _snap_json(e["snap"]),
                        "by": str(e["by"]),
                    }
                    for e in row.replaced
                ],
                "chaosOffer": row.chaos_offer,
                "lucky": row.lucky,
            }
        )

    finished = round_.state == "finished"
    concepts_ready = finished and round_.concepts == "ready"
    resolve = _resolver(round_, turns, bank)
    by_recipe = {r.concept_id: r for r in recipes if r.generation == round_.generation}
    recipe_slots: JsonObject = {
        concept_id: _recipe_slot(
            by_recipe.get(concept_id), bank, photo_attachments, signer, round_.generation
        )
        for concept_id in CONCEPT_IDS
    }

    basket: list[JsonValue] | None = None
    if revealed:
        basket = [
            _pick_json(t, via, snap, kind=_pick_kind(round_, mode, t, via, snap["id"]))
            for t, via, snap in basket_snaps(round_, turns)
        ]

    locked = stars_locked(round_)
    partner_slot = None if viewer_slot is None else (2 if viewer_slot == 1 else 1)
    star_of = {1: round_.star1_id, 2: round_.star2_id}
    stars: JsonObject = {
        "enabled": round_.stars,
        "mine": star_of[viewer_slot] if viewer_slot is not None else None,
        "partnerChosen": bool(partner_slot is not None and star_of[partner_slot] is not None),
        "revealed": locked,
        "partner": star_of[partner_slot] if locked and partner_slot is not None else None,
    }

    vote: JsonObject | None = None
    if concepts_ready:
        votes, match = _vote_result(round_.vote1, round_.vote2)
        vote_of = {1: round_.vote1, 2: round_.vote2}
        vote = {
            "you": vote_of[viewer_slot] if viewer_slot is not None else None,
            "partnerVoted": bool(partner_slot is not None and vote_of[partner_slot] is not None),
            "revealed": votes is not None,
            "votes": votes,
            "match": match,
        }

    snaps = _resolver(round_, turns, None)
    pending_current = any(r.state == "pending" for r in by_recipe.values())
    swap: JsonObject = {
        "state": round_.swap_state,
        "available": bool(
            concepts_ready
            and round_.swap_state == "none"
            and viewer_slot is not None
            and not pending_current
        ),
        "by": round_.swap_by if round_.swap_state == "proposed" else None,
        "out": (snaps(round_.swap_out_id) if round_.swap_out_id is not None else None)
        if round_.swap_state in ("proposed", "done")
        else None,
        "pair": (
            [_snap_json(round_.swap_pair[0]), _snap_json(round_.swap_pair[1])]
            if round_.swap_state == "proposed" and round_.swap_pair is not None
            else None
        ),
        "in": _snap_json(round_.swap_in)
        if round_.swap_state == "done" and round_.swap_in is not None
        else None,
    }

    archived: list[JsonValue] = []
    for gen in sorted(generations, key=lambda g: g.generation):
        g_votes, g_match = _vote_result(gen.vote1, gen.vote2)
        g_recipes = {r.concept_id: r for r in all_recipes if r.generation == gen.generation}
        archived.append(
            {
                "generation": gen.generation,
                "basket": [r for i in gen.basket if (r := resolve(i)) is not None],
                "concepts": _concept_cards(
                    concepts_from_json(gen.concepts_json), resolve, bank, mode
                ),
                "pictures": _pictures_json(gen.pictures, attachments, signer),
                "vote": {"votes": g_votes, "match": g_match},
                "recipes": {
                    cid: _recipe_slot(
                        g_recipes.get(cid), bank, photo_attachments, signer, gen.generation
                    )
                    for cid in CONCEPT_IDS
                },
            }
        )

    return {
        "seq": round_.anchor_message_seq,
        "state": round_.state,
        "rev": round_.rev,
        "blind": blind,
        "revealed": revealed,
        "mode": mode_json(round_, mode),
        "setup": {
            "style": style_ref(round_.style),
            "styleSpun": round_.style_spun,
            "challenge": challenge_ref(round_.challenge),
            "wildcard": round_.wildcard != "off",
            "stars": round_.stars,
            "fridgeRaid": any(r.seed_source == "fridge" for r in turns),
            "encore": (
                {
                    "kind": round_.encore_kind,
                    "fromSeq": round_.encore_from_seq,
                    "fromTitle": encore_title if round_.encore_from_seq is not None else None,
                }
                if round_.encore_kind is not None
                else None
            ),
        },
        "generation": round_.generation,
        "starters": starters,
        "players": players,
        "you": (
            {
                "slot": viewer_slot,
                "chaosUsed": chaos_used(turns, viewer_slot),
                "vetoUsed": veto_used(turns, viewer_slot),
            }
            if viewer_slot is not None
            else None
        ),
        "current": current,
        "history": history,
        "basket": basket,
        "gate": {"waitingFor": list(waiting_for(round_))},
        "wildcard": {
            "state": round_.wildcard,
            "ingredient": (
                _with_facts(
                    {
                        **_snap_json(round_.wildcard_snap),
                        "kind": mode.kind_of(round_.wildcard_snap["id"])
                        if mode is not None
                        else None,
                    },
                    round_.wildcard_snap["id"],
                    with_facts,
                )
                if round_.wildcard == "lifted" and round_.wildcard_snap is not None
                else None
            ),
        },
        "stars": stars,
        "vote": vote,
        "swap": swap,
        "staples": [_staple_json(bank, s.id) for s in (bank.staples if bank is not None else ())],
        "concepts": {
            "state": round_.concepts,
            "data": _concept_cards(concept_list(round_), resolve, bank, mode)
            if concepts_ready
            else None,
            "error": (
                round_.concepts_error if round_.concepts in ("failed", "unavailable") else None
            ),
        },
        "images": {
            "state": round_.images,
            "pictures": _pictures_json(round_.pictures, attachments, signer)
            if concepts_ready
            else {slot: None for slot in CONCEPT_IDS},
        },
        "recipes": recipe_slots,
        "generations": archived,
    }


def bank_entry_json(
    round_: CookoutRoundRow,
    recipe: CookoutRecipeRow,
    attachments: Sequence[AttachmentRow],
    signer: MediaUrlSigner | None,
    *,
    turns: Sequence[CookoutTurnRow] = (),
    generation_row: CookoutGenerationRow | None = None,
    photo_attachments: Sequence[AttachmentRow] = (),
    bank: BankLike | None = None,
) -> JsonObject | None:
    """One `GET /cookout/bank` entry for a banked recipe; `None` when its concept or recipe body
    is unreadable (never expected: `banked` is only written with a validated body). A recipe of a
    superseded generation resolves its concept, vote and picture from `generation_row`."""
    if generation_row is not None:
        concepts = concepts_from_json(generation_row.concepts_json)
        pictures: Mapping[str, str] = generation_row.pictures
        vote1, vote2 = generation_row.vote1, generation_row.vote2
    else:
        concepts = concept_list(round_)
        pictures = round_.pictures
        vote1, vote2 = round_.vote1, round_.vote2
    concept = next((c for c in concepts if c.get("id") == recipe.concept_id), None)
    body = _loads(recipe.recipe_json)
    if concept is None or not isinstance(body, dict):
        return None
    prep = body.get("prepMinutes")
    cook = body.get("cookMinutes")
    if not isinstance(prep, int) or not isinstance(cook, int):
        return None
    by_id = {a.id: a for a in attachments}
    resolve = _resolver(round_, turns, bank)
    mode = round_mode(round_)
    used = [r for i in concept.get("pickedIngredientIds", []) if (r := resolve(str(i))) is not None]
    left = [
        r
        for e in concept.get("omitted", [])
        if isinstance(e, dict) and (r := resolve(str(e.get("id")))) is not None
    ]
    cooked: JsonObject | None = None
    if recipe.cooked_at is not None:
        names = {1: round_.player1_name, 2: round_.player2_name or ""}
        cooked = {
            "cookedAt": recipe.cooked_at,
            "ratings": [
                {"name": names[1], "rating": recipe.rating1},
                {"name": names[2], "rating": recipe.rating2},
            ],
            "photo": _linked_photo(recipe, photo_attachments, signer),
        }
    return {
        "seq": round_.anchor_message_seq,
        "generation": recipe.generation,
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
        "picture": picture_json(by_id.get(pictures.get(recipe.concept_id, "")), signer),
        "cooked": cooked,
        "dinnerPick": dinner_pick(vote1, vote2, recipe.concept_id),
        "style": style_ref(round_.style),
        "challenge": challenge_ref(round_.challenge),
        "mode": {
            "id": mode.id if mode is not None else round_.mode,
            "label": mode.label if mode is not None else round_.mode,
            "emoji": mode.emoji if mode is not None else "",
        },
        "build": build_ref(mode, concept.get("build")),
        "ingredients": used,
        "leftovers": left,
    }
