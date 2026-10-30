"""Cookout AI jobs (workspace 00058, spec/server-chat/09-cookout.md §3.1, §3.2, §3.4, §3.5): the
deterministic validation of concepts and recipes, the one-repair-run loop, compare-and-set
completion, restart/sweep recovery, spawn pacing and the standalone `unavailable` mode — against an
in-memory store that has exactly the Appendix A.2 signatures and a scanning bank double with the
Appendix A.1 `find_contraband_ingredients` contract (the real bank is tested by P1)."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import time
import unicodedata
from collections.abc import Callable, Iterable, Set
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import anyio
import httpx
import pytest

from wixy_server.background import BackgroundTaskHealth, ContainedTaskGroup
from wixy_server.cmdchat import CmdChatClient
from wixy_server.livechat import cookout_ai as real_ai
from wixy_server.livechat.cookout_ai import (
    BASKET_MARKER,
    CONCEPTS_CALLER,
    DISALLOWED_TOOLS,
    RECIPE_CALLER,
    CmdCookoutRunner,
    ConceptTwists,
    CookoutTiming,
    RecipeTwists,
    basket_payload,
    build_cookout_runner,
    build_repair_suffix,
    concept_manifest,
    display_name,
    known_forbidden,
)
from wixy_server.livechat.cookout_images import build_image_prompt
from wixy_server.livechat.cookout_modes import CookoutMode, default_modes
from wixy_server.livechat.cookout_twists import challenge_by_id, style_by_id
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.tests.fake_cmd import (
    FakeCmdState,
    FakeSpawnPlan,
    canned_cookout_concepts,
    canned_cookout_recipe,
    create_fake_cmd_app,
)

CLASSIC = default_modes().default
"""Every pre-existing test is a Classic test: the AI functions take the game mode without a
default (so production call sites state it), and these wrappers state it for the tests."""


def build_concepts_prompt(*args: Any, **kwargs: Any) -> str:
    kwargs.setdefault("mode", CLASSIC)
    return real_ai.build_concepts_prompt(*args, **kwargs)


def build_recipe_prompt(*args: Any, **kwargs: Any) -> str:
    kwargs.setdefault("mode", CLASSIC)
    return real_ai.build_recipe_prompt(*args, **kwargs)


def parse_concepts(*args: Any, **kwargs: Any) -> Any:
    kwargs.setdefault("mode", CLASSIC)
    return real_ai.parse_concepts(*args, **kwargs)


def parse_recipe(*args: Any, **kwargs: Any) -> Any:
    kwargs.setdefault("mode", CLASSIC)
    return real_ai.parse_recipe(*args, **kwargs)


# -- the bank double --------------------------------------------------------------------------


@dataclass(frozen=True)
class FIngredient:
    id: str
    name: str
    aliases: tuple[str, ...] = ()
    category: str = "prepared-pantry"
    blurb: str = "A test ingredient."


@dataclass(frozen=True)
class FStaple:
    id: str
    name: str


def _tokens(text: str) -> list[str]:
    folded = "".join(
        c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)
    ).casefold()
    return re.findall(r"[a-z0-9]+", folded)


PICKS = [
    FIngredient("ribeye-steak", "Ribeye steak"),
    FIngredient("thick-white-toast", "Thick-cut white toast", ("white toast",)),
    FIngredient("flat-leaf-parsley", "Flat-leaf parsley", ("parsley",)),
    FIngredient("tenderstem-broccoli", "Tenderstem broccoli", ("broccoli",)),
    FIngredient("smoked-paprika", "Smoked paprika"),
    FIngredient("dark-brown-sugar", "Dark brown sugar"),
    FIngredient("aged-gruyere", "Aged Gruyère", ("gruyere",)),
    FIngredient("double-espresso", "Double espresso", ("espresso",)),
    FIngredient("tinned-baked-beans", "Tinned baked beans", ("baked beans",)),
    FIngredient("white-miso", "White miso", ("miso",)),
]
PICKED_IDS = [p.id for p in PICKS]
EXTRAS = [
    FIngredient("mango", "Mango"),
    FIngredient("bacon", "Bacon"),
    FIngredient("peanut-butter", "Peanut butter"),
    FIngredient("coconut-milk", "Coconut milk"),
    FIngredient("chicken-thigh", "Chicken thigh", ("chicken",)),
    FIngredient("baking-powder", "Baking powder"),
    FIngredient("pot-barley", "Pot barley"),
]
STAPLES = [
    FStaple("water", "Water"),
    FStaple("salt", "Salt"),
    FStaple("black-pepper", "Black pepper"),
    FStaple("butter", "Butter"),
    FStaple("plain-flour", "Plain flour"),
    FStaple("cooking-oil", "Cooking oil"),
    FStaple("granulated-sugar", "Granulated sugar"),
    FStaple("milk", "Milk"),
]
_SHORT_FORMS = {
    "butter": "butter",
    "flour": "plain-flour",
    "oil": "cooking-oil",
    "sugar": "granulated-sugar",
    "milk": "milk",
}


class ScanBank:
    """The Appendix A.1 bank slice the AI module uses, with a faithful longest-span scanner."""

    def __init__(self, extras: Iterable[FIngredient] = ()) -> None:
        self._ingredients = {i.id: i for i in [*PICKS, *EXTRAS, *extras]}
        self._staples = {s.id: s for s in STAPLES}
        self._phrases: dict[tuple[str, ...], str] = {}
        for ingredient in self._ingredients.values():
            for name in (ingredient.name, *ingredient.aliases):
                self._phrases[tuple(_tokens(name))] = ingredient.id
        for staple in STAPLES:
            self._phrases[tuple(_tokens(staple.name))] = staple.id
        for short, staple_id in _SHORT_FORMS.items():
            self._phrases.setdefault((short,), staple_id)
        self._display = {**{i.id: i.name for i in self._ingredients.values()}}
        self._display.update({s.id: s.name for s in STAPLES})

    @property
    def staples(self) -> list[FStaple]:
        return list(STAPLES)

    def ingredient(self, ingredient_id: str) -> FIngredient | None:
        return self._ingredients.get(ingredient_id)

    def staple(self, staple_id: str) -> FStaple | None:
        return self._staples.get(staple_id)

    def _spans(self, text: str) -> list[tuple[str | None, str]]:
        """Longest-span recognition: `(entity id | None, token)` runs; a recognised food span is
        one `(id, "")` entry, every other token is `(None, token)`."""
        tokens = _tokens(text)
        longest = max((len(p) for p in self._phrases), default=1)
        out: list[tuple[str | None, str]] = []
        i = 0
        while i < len(tokens):
            for size in range(min(longest, len(tokens) - i), 0, -1):
                entity = self._phrases.get(tuple(tokens[i : i + size]))
                if entity is not None:
                    out.append((entity, ""))
                    i += size
                    break
            else:
                out.append((None, tokens[i]))
                i += 1
        return out

    def mentions(self, text: str, ingredient_id: str) -> bool:
        return any(entity == ingredient_id for entity, _ in self._spans(text))

    def food_free_tokens(self, text: str) -> tuple[str, ...]:
        return tuple(token for entity, token in self._spans(text) if entity is None)

    def find_contraband_ingredients(
        self,
        text: str,
        *,
        allowed_ingredient_ids: Set[str],
        allowed_staple_ids: Set[str],
        omitted_ingredient_ids: Set[str] = frozenset(),
        allow_omitted_mentions: bool = False,
    ) -> list[str]:
        tokens = _tokens(text)
        longest = max((len(p) for p in self._phrases), default=1)
        found: list[str] = []
        i = 0
        while i < len(tokens):
            for size in range(min(longest, len(tokens) - i), 0, -1):
                entity = self._phrases.get(tuple(tokens[i : i + size]))
                if entity is None:
                    continue
                if entity in omitted_ingredient_ids and not allow_omitted_mentions:
                    found.append(self._display[entity])
                elif entity not in allowed_ingredient_ids and entity not in allowed_staple_ids:
                    if entity not in omitted_ingredient_ids or not allow_omitted_mentions:
                        found.append(self._display[entity])
                i += size
                break
            else:
                i += 1
        return found


# -- the store double (Appendix A.2 signatures, real compare-and-set semantics) ---------------


class FakeStore:
    """Appendix A.2 signatures with the real generation-fenced compare-and-set semantics: every
    claim and completion names the generation it was started for and is refused unless the round
    is still at it."""

    def __init__(self) -> None:
        self.rounds: dict[int, dict[str, Any]] = {}
        self.finished: list[tuple[str, int, str | None, str]] = []
        self.claims: list[tuple[str, int, int, str | None, bool]] = []
        """`(kind, anchor, expected_generation, run_id, accepted)` for every claim and finish."""
        self.stored_pictures: list[dict[str, Any]] = []
        self.failed_pictures: list[tuple[int, int]] = []
        self.picture_attachments = 0

    def add_round(
        self,
        seq: int = 1,
        *,
        concepts: str = "pending",
        picked: list[str] | None = None,
        concepts_json: str | None = None,
        run_id: str | None = None,
        generation: int = 1,
        stars: list[str] | None = None,
        wildcard: str | None = None,
        forbidden: list[str] | None = None,
        style: str | None = None,
        challenge: str | None = None,
    ) -> dict[str, Any]:
        basket = list(PICKED_IDS if picked is None else picked)
        row: dict[str, Any] = {
            "anchor_message_seq": seq,
            "state": "finished",
            "blind": 0,
            "started_by": "Cupcake",
            "player1_key": "cupcake",
            "player1_name": "Cupcake",
            "player1_email": "cupcake@example.com",
            "player2_key": "pumpkin",
            "player2_name": "Pumpkin",
            "player2_email": "pumpkin@example.com",
            "concepts": concepts,
            "concepts_run_id": run_id,
            "concepts_json": concepts_json,
            "concepts_error": None,
            "concepts_started_at": time.time(),
            "concepts_tries": 1,
            "concepts_deadline_at": time.time() + 900,
            "images": "none",
            "pictures": None,
            "images_started_at": None,
            "images_tries": 0,
            "images_deadline_at": None,
            "images_generation": 0,
            "generation": generation,
            "basket_ids": basket,
            "picked_ids": list(basket),
            "star_ids": sorted(stars or []),
            "wildcard_id": wildcard,
            "forbidden_ids": sorted(forbidden or []),
            "style": style,
            "challenge": challenge,
            "recipes": {},
        }
        self.rounds[seq] = row
        return row

    def add_recipe(
        self, seq: int, concept_id: str, *, run_id: str | None = None, state: str = "pending"
    ) -> None:
        self.rounds[seq]["recipes"][concept_id] = {
            "state": state,
            "run_id": run_id,
            "recipe_json": None,
            "error": None,
            "deadline_at": time.time() + 900,
        }

    def complete_swap(self, seq: int, *, basket: list[str] | None = None) -> None:
        """What a completed rescue swap does to the live row: the generation moves on, the
        concepts start over (`pending`, no run) and the old recipe slots are gone."""
        row = self.rounds[seq]
        row["generation"] += 1
        row["concepts"] = "pending"
        row["concepts_run_id"] = None
        row["concepts_json"] = None
        row["recipes"] = {}
        row["images"] = "none"
        row["pictures"] = None
        row["images_generation"] += 1
        if basket is not None:
            row["basket_ids"] = list(basket)
            row["picked_ids"] = list(basket)

    # -- A.2 ---------------------------------------------------------------------------------

    def get_cookout_round(self, anchor_seq: int) -> dict[str, Any] | None:
        row = self.rounds.get(anchor_seq)
        return copy.deepcopy(row) if row is not None else None

    def set_cookout_concepts_run(
        self,
        anchor_seq: int,
        run_id: str,
        *,
        expected_run_id: str | None = None,
        expected_generation: int,
    ) -> bool:
        row = self.rounds.get(anchor_seq)
        accepted = (
            row is not None
            and row["generation"] == expected_generation
            and row["concepts"] == "pending"
            and row["concepts_run_id"] == expected_run_id
        )
        self.claims.append(("claim:c", anchor_seq, expected_generation, run_id, bool(accepted)))
        if not accepted or row is None:
            return False
        row["concepts_run_id"] = run_id
        return True

    def finish_cookout_concepts(
        self,
        anchor_seq: int,
        run_id: str | None,
        state: Literal["ready", "failed", "unavailable"],
        *,
        expected_generation: int,
        concepts_json: str | None = None,
        error: str | None = None,
        pictures_pending: bool = False,
    ) -> bool:
        row = self.rounds.get(anchor_seq)
        accepted = (
            row is not None
            and row["generation"] == expected_generation
            and row["concepts"] == "pending"
            and row["concepts_run_id"] == run_id
        )
        self.claims.append(("finish:c", anchor_seq, expected_generation, run_id, bool(accepted)))
        if not accepted or row is None:
            return False
        row["concepts"] = state
        row["concepts_json"] = concepts_json
        row["concepts_error"] = error
        if state == "ready" and pictures_pending:
            row["images"] = "pending"
            row["images_generation"] += 1
            row["images_started_at"] = time.time()
            row["images_tries"] = 1
        self.finished.append(("concepts", anchor_seq, run_id, state))
        return True

    def cookout_pending_concepts(self) -> list[tuple[int, int, str | None]]:
        return [
            (s, r["generation"], r["concepts_run_id"])
            for s, r in self.rounds.items()
            if r["concepts"] == "pending"
        ]

    def set_cookout_recipe_run(
        self,
        anchor_seq: int,
        concept_id: str,
        run_id: str,
        *,
        expected_run_id: str | None = None,
        expected_generation: int,
    ) -> bool:
        row = self.rounds.get(anchor_seq, {})
        slot = row.get("recipes", {}).get(concept_id)
        accepted = (
            slot is not None
            and row["generation"] == expected_generation
            and slot["state"] == "pending"
            and slot["run_id"] == expected_run_id
        )
        self.claims.append(
            (f"claim:r:{concept_id}", anchor_seq, expected_generation, run_id, bool(accepted))
        )
        if not accepted or slot is None:
            return False
        slot["run_id"] = run_id
        return True

    def finish_cookout_recipe(
        self,
        anchor_seq: int,
        concept_id: str,
        run_id: str | None,
        state: Literal["banked", "failed", "unavailable"],
        *,
        expected_generation: int,
        recipe_json: str | None = None,
        error: str | None = None,
    ) -> bool:
        row = self.rounds.get(anchor_seq, {})
        slot = row.get("recipes", {}).get(concept_id)
        accepted = (
            slot is not None
            and row["generation"] == expected_generation
            and slot["state"] == "pending"
            and slot["run_id"] == run_id
        )
        self.claims.append(
            (f"finish:r:{concept_id}", anchor_seq, expected_generation, run_id, bool(accepted))
        )
        if not accepted or slot is None:
            return False
        slot["state"] = state
        slot["recipe_json"] = recipe_json
        slot["error"] = error
        self.finished.append(("recipe:" + concept_id, anchor_seq, run_id, state))
        return True

    def cookout_pending_recipes(self) -> list[tuple[int, int, str, str | None]]:
        return [
            (s, r["generation"], c, slot["run_id"])
            for s, r in self.rounds.items()
            for c, slot in r["recipes"].items()
            if slot["state"] == "pending"
        ]

    # pictures (used by test_livechat_cookout_images)

    def claim_cookout_pictures(
        self, anchor_seq: int, *, stale_before: float | None, now: float
    ) -> tuple[str, int]:
        row = self.rounds.get(anchor_seq)
        if row is None:
            return "gone", 0
        if not (
            row["state"] == "finished" and row["concepts"] == "ready" and row["images"] == "pending"
        ):
            return "gone", row["images_generation"]
        if stale_before is not None and row["images_started_at"] >= stale_before:
            return "not_due", row["images_generation"]
        if row["images_tries"] >= 3:
            row["images"] = "failed"
            return "gave_up", row["images_generation"]
        row["images_generation"] += 1
        row["images_tries"] += 1
        row["images_started_at"] = now
        return "claimed", row["images_generation"]

    def _live(self, anchor_seq: int, generation: int) -> dict[str, Any] | None:
        row = self.rounds.get(anchor_seq)
        if (
            row is None
            or row["state"] != "finished"
            or row["concepts"] != "ready"
            or row["images"] != "pending"
            or row["images_generation"] != generation
        ):
            return None
        return row

    def store_cookout_pictures(
        self,
        anchor_seq: int,
        expected_generation: int,
        slot_uploads: Any,
        by_email: str | None,
        *,
        all_done: bool,
        now: float,
    ) -> bool:
        row = self._live(anchor_seq, expected_generation)
        if row is None:
            return False
        pictures = dict(row["pictures"] or {})
        for slot, (upload_id, size) in slot_uploads.items():
            self.picture_attachments += 1
            pictures[slot] = f"att-{upload_id}"
            self.stored_pictures.append({"slot": slot, "upload_id": upload_id, "size": size})
        row["pictures"] = pictures
        row["images"] = "done" if all_done else "failed"
        return True

    def fail_cookout_pictures(
        self, anchor_seq: int, *, expected_generation: int, now: float
    ) -> bool:
        self.failed_pictures.append((anchor_seq, expected_generation))
        row = self._live(anchor_seq, expected_generation)
        if row is None:
            return False
        row["images"] = "failed"
        return True

    def cookout_stale_pictures(self, *, stale_before: float) -> list[int]:
        return [
            s
            for s, r in self.rounds.items()
            if r["images"] == "pending"
            and r["concepts"] == "ready"
            and r["images_started_at"] < stale_before
        ]


# -- shared helpers ---------------------------------------------------------------------------

FAST = CookoutTiming(poll_interval_s=0.01, spawn_gap_s=0.0, give_up_s=20.0, early_retry_s=150.0)


def _client(state: FakeCmdState) -> CmdChatClient:
    return CmdChatClient(transport=httpx.ASGITransport(app=create_fake_cmd_app(state)))


def _prompt() -> str:
    bank = ScanBank()

    basket = basket_payload(bank, PICKED_IDS)
    assert basket is not None
    return build_concepts_prompt(basket)


def canned_concepts_text() -> str:
    return json.dumps(canned_cookout_concepts(_prompt()))


def canned_concepts_obj() -> dict[str, Any]:
    value = canned_cookout_concepts(_prompt())
    assert value is not None
    return value


def _notifier() -> LiveChatNotifier:
    return LiveChatNotifier()


async def _run_with_group(fn: Callable[[ContainedTaskGroup], Any]) -> None:
    async with anyio.create_task_group() as tg:
        await fn(ContainedTaskGroup(tg, BackgroundTaskHealth()))


def _runner(
    store: FakeStore,
    client: CmdChatClient | None,
    tmp_path: Path,
    *,
    timing: CookoutTiming = FAST,
    pictures: Any = None,
) -> CmdCookoutRunner:
    return CmdCookoutRunner(
        store=store,
        bank=ScanBank(),
        client=client,
        notifier=_notifier(),
        cwd=tmp_path / "cookout-jobs",
        pictures=pictures,
        timing=timing,
    )


# -- parse_concepts ---------------------------------------------------------------------------


def _parse(obj: dict[str, Any]) -> Any:
    return parse_concepts(json.dumps(obj), bank=ScanBank(), picked_ids=PICKED_IDS)


class TestParseConcepts:
    def test_a_valid_answer_passes_and_is_canonical(self) -> None:
        parsed = _parse(canned_concepts_obj())
        assert parsed.violations == ()
        assert [c["id"] for c in parsed.value["concepts"]] == ["a", "b", "c"]

    def test_prose_and_fences_around_the_object_are_ignored(self) -> None:
        text = "Here you go:\n```json\n" + canned_concepts_text() + "\n```\nEnjoy"
        assert parse_concepts(text, bank=ScanBank(), picked_ids=PICKED_IDS).value is not None

    @pytest.mark.parametrize("text", ["", "not json", "{}", '{"concepts": []}'])
    def test_garbage_is_rejected(self, text: str) -> None:
        assert parse_concepts(text, bank=ScanBank(), picked_ids=PICKED_IDS).value is None

    def _mutated(self, edit: Callable[[list[dict[str, Any]]], None]) -> Any:
        obj = canned_concepts_obj()
        edit(obj["concepts"])
        return _parse(obj)

    def test_an_unknown_pick_id_rejects_the_candidate(self) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["pickedIngredientIds"][0] = "mango"

        parsed = self._mutated(edit)
        assert parsed.value is None
        assert any("not one of the ten picks" in v for v in parsed.violations)

    def test_omitted_must_be_the_exact_complement(self) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["omitted"] = c[0]["omitted"][:1]

        parsed = self._mutated(edit)
        assert any("omitted must be exactly" in v for v in parsed.violations)

    def test_a_staple_that_is_also_picked_is_rejected(self) -> None:
        picks = [*PICKED_IDS[:9], "butter"]
        obj = canned_concepts_obj()
        for concept in obj["concepts"]:
            used = [i for i in concept["pickedIngredientIds"] if i != "white-miso"]
            if concept["id"] == "a":
                used = [*used[:7], "butter"]
                concept["stapleIds"] = ["salt", "butter"]  # butter is picked AND declared
            concept["pickedIngredientIds"] = used
            concept["omitted"] = [
                {"id": i, "reason": "Saved for later."} for i in picks if i not in used
            ]
        bank = ScanBank(extras=[FIngredient("butter", "Butter")])
        parsed = parse_concepts(json.dumps(obj), bank=bank, picked_ids=picks)
        assert any("repeats picked ingredient 'butter'" in v for v in parsed.violations)

    def test_an_unknown_staple_is_rejected(self) -> None:
        parsed = self._mutated(lambda c: c[1].__setitem__("stapleIds", ["salt", "saffron"]))
        assert any("not a cupboard staple" in v for v in parsed.violations)

    def test_five_non_seasoning_staples_break_the_cap(self) -> None:
        five = ["butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk"]
        parsed = self._mutated(lambda c: c[1].__setitem__("stapleIds", five))
        assert any("more than 4 extra staples" in v for v in parsed.violations)

    def test_four_non_seasoning_staples_are_fine(self) -> None:
        four = ["butter", "plain-flour", "cooking-oil", "granulated-sugar", "salt"]
        assert self._mutated(lambda c: c[1].__setitem__("stapleIds", four)).value is not None

    def test_each_concept_needs_seven_picks(self) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[2]["pickedIngredientIds"] = c[2]["pickedIngredientIds"][:6]
            c[2]["omitted"] = [
                {"id": i, "reason": "Saved for later."}
                for i in PICKED_IDS
                if i not in c[2]["pickedIngredientIds"]
            ]

        parsed = self._mutated(edit)
        assert any("each concept needs 7+" in v for v in parsed.violations)

    def test_one_concept_must_use_eight(self) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            for concept in c:
                concept["pickedIngredientIds"] = concept["pickedIngredientIds"][:7]
                concept["omitted"] = [
                    {"id": i, "reason": "Saved for later."}
                    for i in PICKED_IDS
                    if i not in concept["pickedIngredientIds"]
                ]

        parsed = self._mutated(edit)
        assert any("8+ of the ten picks" in v for v in parsed.violations)

    def test_the_union_must_cover_all_ten(self) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            # a: ids[0:8], b: ids[0:8], c: ids[0:7] -> tinned-baked-beans / white-miso uncovered.
            c[1]["pickedIngredientIds"] = list(c[0]["pickedIngredientIds"])
            c[1]["omitted"] = list(c[0]["omitted"])
            c[1]["title"] = "A different title altogether"
            c[1]["description"] = c[0]["description"]

        parsed = self._mutated(edit)
        assert any("no concept uses these picks" in v for v in parsed.violations)

    def test_three_distinct_dish_technique_pairs_and_two_dish_types(self) -> None:
        def same_pair(c: list[dict[str, Any]]) -> None:
            c[1]["dishType"], c[1]["technique"] = c[0]["dishType"], c[0]["technique"]

        assert any("three different" in v for v in self._mutated(same_pair).violations)

        def one_type(c: list[dict[str, Any]]) -> None:
            for index, concept in enumerate(c):
                concept["dishType"] = "bowl"
                concept["technique"] = ["roast", "bake", "steam"][index]

        assert any("two different dishType" in v for v in self._mutated(one_type).violations)

    def test_titles_must_be_distinct(self) -> None:
        parsed = self._mutated(lambda c: c[1].__setitem__("title", c[0]["title"].upper()))
        assert any("repeats another concept's title" in v for v in parsed.violations)

    def test_bounds_on_text_fields(self) -> None:
        parsed = self._mutated(lambda c: c[0].__setitem__("description", "too short"))
        assert any("description must be 20-500" in v for v in parsed.violations)
        parsed = self._mutated(lambda c: c[0].__setitem__("vibe", "x" * 41))
        assert any("vibe must be 1-40" in v for v in parsed.violations)

    def test_an_unpicked_bank_food_in_any_prose_field_is_contraband(self) -> None:
        for field_name in ("title", "vibe", "description"):

            def edit(c: list[dict[str, Any]], f: str = field_name) -> None:
                c[0][f] = c[0][f] + " with fresh mango"

            parsed = self._mutated(edit)
            assert any("'Mango'" in v for v in parsed.violations), field_name

    def test_bacon_is_contraband_too(self) -> None:
        parsed = self._mutated(
            lambda c: c[0].__setitem__("description", "Crispy bacon, " + c[0]["description"])
        )
        assert any("'Bacon'" in v for v in parsed.violations)

    def test_an_omitted_pick_may_not_be_mentioned_outside_its_own_reason(self) -> None:
        parsed = self._mutated(
            lambda c: c[0].__setitem__("description", c[0]["description"] + " No white miso here.")
        )
        assert any("'White miso'" in v for v in parsed.violations)

    def test_an_omitted_pick_may_be_named_in_its_own_reason(self) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["omitted"][0]["reason"] = "Tinned baked beans would swamp the other flavours."

        assert self._mutated(edit).value is not None

    def test_an_omitted_reason_is_an_explanation_never_scanned_as_consumption(self) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["omitted"][0]["reason"] = "Mango would be sweeter, and starch would clash."

        assert self._mutated(edit).value is not None

    def test_an_undeclared_staple_in_prose_is_rejected(self) -> None:
        parsed = self._mutated(
            lambda c: c[0].__setitem__(
                "description", c[0]["description"] + " Melted butter on top."
            )
        )
        assert any("'Butter'" in v for v in parsed.violations)

    def test_a_declared_staple_may_be_used(self) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["stapleIds"] = ["salt", "black-pepper", "butter"]
            c[0]["description"] += " Melted butter on top."

        assert self._mutated(edit).value is not None

    def test_longest_span_protects_a_picked_compound_but_not_a_later_bare_mention(self) -> None:
        bank = ScanBank()
        picks = [i for i in PICKED_IDS[:9]] + ["peanut-butter"]

        def run(sentence: str) -> Any:
            obj = canned_concepts_obj()
            for concept in obj["concepts"]:
                used = [i for i in concept["pickedIngredientIds"] if i != "white-miso"]
                if "peanut-butter" in picks and concept["id"] == "a":
                    used = used[:7] + ["peanut-butter"]
                concept["pickedIngredientIds"] = used
                concept["omitted"] = [
                    {"id": i, "reason": "Saved for later."} for i in picks if i not in used
                ]
            obj["concepts"][0]["description"] = sentence
            return parse_concepts(json.dumps(obj), bank=bank, picked_ids=picks)

        ok = run("Peanut butter and Ribeye steak, nothing else but salt.")
        assert not any("'Butter'" in v for v in ok.violations)
        bad = run("Peanut butter with extra butter and Ribeye steak.")
        assert any("'Butter'" in v for v in bad.violations)


# -- parse_recipe -----------------------------------------------------------------------------


def _concept() -> dict[str, Any]:
    concept: dict[str, Any] = canned_concepts_obj()["concepts"][0]
    return concept


def _recipe(concept: dict[str, Any]) -> dict[str, Any]:
    ids = [*concept["pickedIngredientIds"], *concept["stapleIds"]]
    return {
        "serves": 2,
        "prepMinutes": 10,
        "cookMinutes": 25,
        "ingredients": [{"id": i, "quantity": "1 portion", "note": ""} for i in ids],
        "steps": [
            {"text": "Get everything ready on the side.", "minutes": 5, "uses": ids[:5]},
            {"text": "Cook it all together until done.", "minutes": None, "uses": ids[5:]},
        ],
        "tips": ["Rest it before serving."],
    }


def _parse_recipe(recipe: dict[str, Any], concept: dict[str, Any] | None = None) -> Any:
    return parse_recipe(json.dumps(recipe), bank=ScanBank(), concept=concept or _concept())


class TestParseRecipe:
    def test_a_valid_recipe_passes_with_a_computed_total(self) -> None:
        parsed = _parse_recipe(_recipe(_concept()))
        assert parsed.violations == ()
        assert parsed.value["totalMinutes"] == 35 and parsed.value["serves"] == 2

    def test_serves_must_be_two(self) -> None:
        recipe = _recipe(_concept()) | {"serves": 4}
        assert any("serves must be 2" in v for v in _parse_recipe(recipe).violations)

    def test_every_manifest_item_must_be_present(self) -> None:
        recipe = _recipe(_concept())
        recipe["ingredients"].pop(0)
        recipe["steps"][0]["uses"] = recipe["steps"][0]["uses"][1:]
        assert any("missing" in v for v in _parse_recipe(recipe).violations)

    def test_an_omitted_pick_may_not_be_added(self) -> None:
        recipe = _recipe(_concept())
        recipe["ingredients"].append({"id": "white-miso", "quantity": "1 tsp", "note": ""})
        recipe["steps"][1]["uses"].append("white-miso")
        assert any("omitted pick" in v for v in _parse_recipe(recipe).violations)

    def test_an_undeclared_staple_may_not_be_added(self) -> None:
        recipe = _recipe(_concept())
        recipe["ingredients"].append({"id": "milk", "quantity": "1 cup", "note": ""})
        recipe["steps"][1]["uses"].append("milk")
        assert any("not in this dish's manifest" in v for v in _parse_recipe(recipe).violations)

    def test_water_is_always_free(self) -> None:
        recipe = _recipe(_concept())
        recipe["ingredients"].append({"id": "water", "quantity": "200ml", "note": ""})
        recipe["steps"][1]["uses"].append("water")
        assert _parse_recipe(recipe).value is not None

    def test_every_ingredient_must_be_used_in_a_step(self) -> None:
        recipe = _recipe(_concept())
        recipe["steps"][1]["uses"] = recipe["steps"][1]["uses"][1:]
        assert any("unused" in v for v in _parse_recipe(recipe).violations)

    def test_step_and_time_bounds(self) -> None:
        recipe = _recipe(_concept())
        recipe["steps"] = recipe["steps"][:1]
        assert any("steps must be a list of 2-20" in v for v in _parse_recipe(recipe).violations)
        zero = _recipe(_concept()) | {"prepMinutes": 0, "cookMinutes": 0}
        assert any("1-720" in v for v in _parse_recipe(zero).violations)

    def test_lexical_scan_covers_quantity_note_steps_and_tips(self) -> None:
        for where in ("quantity", "note", "step", "tip"):
            recipe = _recipe(_concept())
            if where == "quantity":
                recipe["ingredients"][0]["quantity"] = "1 mango"
            elif where == "note":
                recipe["ingredients"][0]["note"] = "or use bacon"
            elif where == "step":
                recipe["steps"][0]["text"] = "Add the chicken now."
            else:
                recipe["tips"] = ["Serve with butter."]
            assert _parse_recipe(recipe).value is None, where

    def test_an_omitted_pick_in_prose_is_rejected_even_negated(self) -> None:
        recipe = _recipe(_concept())
        recipe["tips"] = ["Skip the white miso."]
        assert any("'White miso'" in v for v in _parse_recipe(recipe).violations)

    def test_garbage_is_rejected(self) -> None:
        assert parse_recipe("nope", bank=ScanBank(), concept=_concept()).value is None


# -- the fake cmd answers (fake_cmd.py's canned Cookout responses are valid by construction) ---


class TestCannedResponses:
    def test_the_canned_concepts_validate_against_a_scanning_bank(self) -> None:
        assert _parse(canned_concepts_obj()).value is not None

    def test_the_canned_recipe_validates(self) -> None:

        concept = _concept()
        prompt = build_recipe_prompt(concept, concept_manifest(concept, ScanBank()))
        recipe = canned_cookout_recipe(prompt)
        assert recipe is not None
        assert parse_recipe(json.dumps(recipe), bank=ScanBank(), concept=concept).value is not None


# -- the runner: Stage 1 ----------------------------------------------------------------------


def _drive_concepts(
    runner: CmdCookoutRunner,
    seq: int = 1,
    *,
    generation: int = 1,
    extra: Callable[[], Any] | None = None,
) -> None:
    async def go() -> None:
        async with anyio.create_task_group() as tg:
            tg.start_soon(runner.run_concepts, seq, generation)
            if extra is not None:
                tg.start_soon(extra)

    anyio.run(go)


class TestConceptsJob:
    def test_a_finished_round_gets_three_validated_concepts(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        row = store.rounds[1]
        assert row["concepts"] == "ready"
        assert [c["id"] for c in json.loads(row["concepts_json"])["concepts"]] == ["a", "b", "c"]
        assert len(state.chat_spawn_runs) == 1

    def test_the_spawn_body_and_prompt_privacy(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        (run,) = state.chat_spawn_runs.values()
        body: dict[str, Any] = dict(run.body)
        assert body["caller"] == CONCEPTS_CALLER
        assert body["model"] == "claude-sonnet-5-5" and body["effort"] == "medium"
        assert body["spawned_by_session_id"] == "" and body["bucket"] == "subscription"
        assert body["timeout_secs"] == 300 and "tag" not in body
        assert body["cwd"].endswith("cookout-jobs")
        disallowed = set(body["disallowed_tools"])
        assert {"WebSearch", "WebFetch", "Bash", "Read", "Edit"} <= disallowed
        assert disallowed == set(DISALLOWED_TOOLS)
        prompt = str(body["prompt"])
        for private in ("Cupcake", "Pumpkin", "example.com", "cupcake", "pumpkin"):
            assert private not in prompt
        basket = json.loads(prompt.split(BASKET_MARKER, 1)[1].splitlines()[0])
        assert [i["id"] for i in basket["ingredients"]] == sorted(PICKED_IDS)
        assert len(basket["staples"]) == 8
        assert set(basket["ingredients"][0]) == {"id", "name", "category", "blurb"}

    def test_pick_order_does_not_reach_the_prompt(self, tmp_path: Path) -> None:
        prompts: list[str] = []
        for picked in (PICKED_IDS, list(reversed(PICKED_IDS))):
            store, state = FakeStore(), FakeCmdState()
            store.add_round(picked=picked)
            _drive_concepts(_runner(store, _client(state), tmp_path))
            (run,) = state.chat_spawn_runs.values()
            prompts.append(str(run.body["prompt"]))
        assert prompts[0] == prompts[1]

    def test_an_invalid_answer_gets_exactly_one_repair_run_naming_the_violations(
        self, tmp_path: Path
    ) -> None:
        bad = canned_concepts_obj()
        bad["concepts"][0]["description"] += " Topped with fresh mango."
        state = FakeCmdState(
            chat_spawn_plans=[
                FakeSpawnPlan(response_text=json.dumps(bad)),
                FakeSpawnPlan(response_text=canned_concepts_text()),
            ]
        )
        store = FakeStore()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "ready"
        runs = list(state.chat_spawn_runs.values())
        assert len(runs) == 2
        assert "REJECTED" in str(runs[1].body["prompt"])
        assert "Mango" in str(runs[1].body["prompt"])
        assert store.rounds[1]["concepts_run_id"] == runs[1].run_id

    def test_the_last_failure_ends_the_job_failed(self, tmp_path: Path) -> None:
        bad = json.dumps({"concepts": []})
        state = FakeCmdState(cookout_response_text=bad)
        store = FakeStore()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "failed"
        assert store.rounds[1]["concepts_error"]
        # the run and THREE repairs (MAX_REPAIRS), never a fifth
        assert len(state.chat_spawn_runs) == 4

    def test_a_third_repair_can_still_succeed(self, tmp_path: Path) -> None:
        bad = json.dumps({"concepts": []})
        state = FakeCmdState(
            chat_spawn_plans=[
                FakeSpawnPlan(response_text=bad),
                FakeSpawnPlan(response_text=bad),
                FakeSpawnPlan(response_text=bad),
                FakeSpawnPlan(response_text=canned_concepts_text()),
            ]
        )
        store = FakeStore()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "ready"
        assert len(state.chat_spawn_runs) == 4

    def test_cmd_refusing_the_run_fails_the_job(self, tmp_path: Path) -> None:
        state = FakeCmdState(chat_spawn_status_code=500)
        store = FakeStore()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "failed"

    def test_cmd_unreachable_makes_the_concepts_unavailable(self, tmp_path: Path) -> None:
        def down(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down", request=request)

        client = CmdChatClient(transport=httpx.MockTransport(down), max_attempts=1)
        store = FakeStore()
        store.add_round()
        _drive_concepts(_runner(store, client, tmp_path))
        assert store.rounds[1]["concepts"] == "unavailable"

    def test_a_run_that_errors_early_is_retried_once(self, tmp_path: Path) -> None:
        state = FakeCmdState(
            chat_spawn_plans=[
                FakeSpawnPlan(final_status="error"),
                FakeSpawnPlan(response_text=canned_concepts_text()),
            ]
        )
        store = FakeStore()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "ready"
        assert len(state.chat_spawn_runs) == 2

    def test_a_run_that_keeps_erroring_fails(self, tmp_path: Path) -> None:
        state = FakeCmdState(chat_spawn_final_status="error")
        store = FakeStore()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "failed"
        assert len(state.chat_spawn_runs) == 2

    def test_the_deadline_gives_up_and_cancels_the_run(self, tmp_path: Path) -> None:
        state = FakeCmdState(chat_spawn_plans=[FakeSpawnPlan(running_polls=10_000)])
        store = FakeStore()
        store.add_round()
        timing = CookoutTiming(poll_interval_s=0.01, spawn_gap_s=0.0, give_up_s=0.15)
        _drive_concepts(_runner(store, _client(state), tmp_path, timing=timing))
        assert store.rounds[1]["concepts"] == "failed"
        (run,) = state.chat_spawn_runs.values()
        assert run.cancelled

    def test_the_persisted_deadline_bounds_the_job(self, tmp_path: Path) -> None:
        state = FakeCmdState(chat_spawn_plans=[FakeSpawnPlan(running_polls=10_000)])
        store = FakeStore()
        store.add_round()["concepts_deadline_at"] = time.time() + 0.1
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "failed"

    def test_a_retried_round_is_left_alone_and_its_old_run_cancelled(self, tmp_path: Path) -> None:
        """Compare-and-set: the round moved to a NEW run id meanwhile (a manual retry); the old
        job stores nothing and cancels its run."""
        state = FakeCmdState(chat_spawn_plans=[FakeSpawnPlan(running_polls=10_000)])
        store = FakeStore()
        store.add_round()

        async def retry_meanwhile() -> None:
            # Wait (bounded) until the runner has spawned its run AND recorded it on the round,
            # then flip the run id: a fixed sleep raced the runner under load.
            with anyio.fail_after(30):
                while not (
                    state.chat_spawn_runs
                    and store.rounds[1]["concepts_run_id"] in state.chat_spawn_runs
                ):
                    await anyio.sleep(0.01)
            store.rounds[1]["concepts_run_id"] = "a-newer-run"

        _drive_concepts(_runner(store, _client(state), tmp_path), extra=retry_meanwhile)
        assert store.rounds[1]["concepts"] == "pending"
        assert store.rounds[1]["concepts_json"] is None
        (run,) = state.chat_spawn_runs.values()
        assert run.cancelled

    def test_a_late_completion_after_a_new_epoch_is_not_stored(self, tmp_path: Path) -> None:
        store = FakeStore()
        store.add_round(run_id="old-run")
        assert store.finish_cookout_concepts(
            1, "old-run", "failed", expected_generation=1, error="x"
        )
        store.rounds[1]["concepts"] = "pending"
        store.rounds[1]["concepts_run_id"] = None
        assert not store.finish_cookout_concepts(
            1, "old-run", "ready", expected_generation=1, concepts_json=canned_concepts_text()
        )

    def test_a_deleted_round_costs_nothing(self, tmp_path: Path) -> None:
        state = FakeCmdState()
        store = FakeStore()
        runner = _runner(store, _client(state), tmp_path)
        anyio.run(runner.run_concepts, 99, 1)
        assert not state.chat_spawn_runs

    def test_concurrent_spawns_are_at_least_the_gap_apart_and_two_at_a_time(
        self, tmp_path: Path
    ) -> None:
        state = FakeCmdState(chat_spawn_delay_s=0.05)
        store = FakeStore()
        for seq in (1, 2, 3):
            store.add_round(seq)
        timing = CookoutTiming(poll_interval_s=0.01, spawn_gap_s=0.2, give_up_s=20.0)
        runner = _runner(store, _client(state), tmp_path, timing=timing)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                for seq in (1, 2, 3):
                    tg.start_soon(runner.run_concepts, seq, 1)

        anyio.run(go)
        times = sorted(state.chat_spawn_spawn_times)
        assert len(times) == 3
        assert all(b - a >= 0.18 for a, b in zip(times, times[1:], strict=False))
        assert state.chat_spawn_in_flight_max <= 2
        assert all(r["concepts"] == "ready" for r in store.rounds.values())

    def test_a_finished_concepts_job_starts_the_picture_job_only_when_one_is_configured(
        self, tmp_path: Path
    ) -> None:
        class Pictures:
            def __init__(self) -> None:
                self.ran: list[int] = []

            async def run(self, anchor_seq: int, stale_before: float | None = None) -> None:
                self.ran.append(anchor_seq)

            async def resume(self, background: ContainedTaskGroup) -> int:
                return 0

            async def sweep(self, background: ContainedTaskGroup) -> int:
                return 0

        pictures = Pictures()
        store, state = FakeStore(), FakeCmdState()
        store.add_round()
        runner = _runner(store, _client(state), tmp_path, pictures=pictures)
        assert runner.images_available
        _drive_concepts(runner)
        assert pictures.ran == [1]
        assert store.rounds[1]["images"] == "pending"  # pictures_pending was set with `ready`

        plain_store, plain_state = FakeStore(), FakeCmdState()
        plain_store.add_round()
        plain = _runner(plain_store, _client(plain_state), tmp_path)
        assert not plain.images_available
        _drive_concepts(plain)
        assert plain_store.rounds[1]["images"] == "none"


# -- the runner: standalone edition -----------------------------------------------------------


class TestStandalone:
    def test_without_cmd_the_runner_is_unavailable_and_concepts_end_unavailable(
        self, tmp_path: Path
    ) -> None:
        store = FakeStore()
        store.add_round()
        runner = _runner(store, None, tmp_path)
        assert not runner.available and not runner.images_available
        anyio.run(runner.run_concepts, 1, 1)
        assert store.rounds[1]["concepts"] == "unavailable"

    def test_a_bank_request_without_cmd_ends_unavailable(self, tmp_path: Path) -> None:
        store = FakeStore()
        store.add_round(concepts="ready", concepts_json=canned_concepts_text())
        store.add_recipe(1, "a")
        runner = _runner(store, None, tmp_path)
        anyio.run(runner.run_recipe, 1, 1, "a")
        assert store.rounds[1]["recipes"]["a"]["state"] == "unavailable"

    def test_startup_resume_marks_pending_work_unavailable(self, tmp_path: Path) -> None:
        store = FakeStore()
        store.add_round(1)
        store.add_round(2, concepts="ready", concepts_json=canned_concepts_text())
        store.add_recipe(2, "b")
        runner = _runner(store, None, tmp_path)
        anyio.run(_run_with_group, runner.resume)
        assert store.rounds[1]["concepts"] == "unavailable"
        assert store.rounds[2]["recipes"]["b"]["state"] == "unavailable"


# -- the runner: Stage 2 ----------------------------------------------------------------------


def _drive_recipe(
    runner: CmdCookoutRunner, seq: int = 1, concept_id: str = "a", *, generation: int = 1
) -> None:
    anyio.run(runner.run_recipe, seq, generation, concept_id)


class TestRecipeJob:
    def _store(self) -> FakeStore:
        store = FakeStore()
        store.add_round(concepts="ready", concepts_json=canned_concepts_text())
        store.add_recipe(1, "a")
        return store

    def test_bank_this_writes_a_validated_recipe_and_banks_it(self, tmp_path: Path) -> None:
        store, state = self._store(), FakeCmdState()
        _drive_recipe(_runner(store, _client(state), tmp_path))
        slot = store.rounds[1]["recipes"]["a"]
        assert slot["state"] == "banked"
        recipe = json.loads(slot["recipe_json"])
        assert recipe["serves"] == 2 and recipe["totalMinutes"] == 30
        (run,) = state.chat_spawn_runs.values()
        assert run.body["caller"] == RECIPE_CALLER
        assert run.body["model"] == "claude-sonnet-5-5"
        body: dict[str, Any] = dict(run.body)
        assert set(body["disallowed_tools"]) == set(DISALLOWED_TOOLS)
        prompt = str(run.body["prompt"])
        assert "Cupcake" not in prompt and "Pumpkin" not in prompt
        assert "Ribeye steak" in prompt  # the frozen manifest of the concept

    def test_only_the_requested_concept_is_banked(self, tmp_path: Path) -> None:
        store = self._store()
        store.add_recipe(1, "c")
        state = FakeCmdState()
        _drive_recipe(_runner(store, _client(state), tmp_path), 1, "c")
        assert store.rounds[1]["recipes"]["c"]["state"] == "banked"
        assert store.rounds[1]["recipes"]["a"]["state"] == "pending"

    def test_an_invalid_recipe_is_repaired_once(self, tmp_path: Path) -> None:
        concept = _concept()
        bad = _recipe(concept)
        bad["steps"][0]["text"] = "Pour in the milk."
        good = _recipe(concept)
        state = FakeCmdState(
            chat_spawn_plans=[
                FakeSpawnPlan(response_text=json.dumps(bad)),
                FakeSpawnPlan(response_text=json.dumps(good)),
            ]
        )
        store = self._store()
        _drive_recipe(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["recipes"]["a"]["state"] == "banked"
        second = list(state.chat_spawn_runs.values())[1]
        assert "'Milk'" in str(second.body["prompt"])

    def test_two_invalid_recipes_fail_the_save_and_it_stays_unbanked(self, tmp_path: Path) -> None:
        state = FakeCmdState(cookout_response_text=json.dumps({"steps": []}))
        store = self._store()
        _drive_recipe(_runner(store, _client(state), tmp_path))
        slot = store.rounds[1]["recipes"]["a"]
        assert slot["state"] == "failed" and slot["recipe_json"] is None
        assert len(state.chat_spawn_runs) == 4  # the run and MAX_REPAIRS repairs

    def test_a_recipe_for_a_vanished_round_is_a_no_op(self, tmp_path: Path) -> None:
        state = FakeCmdState()
        _drive_recipe(_runner(FakeStore(), _client(state), tmp_path))
        assert not state.chat_spawn_runs

    def test_a_retried_recipe_is_left_alone_by_the_old_job(self, tmp_path: Path) -> None:
        state = FakeCmdState(chat_spawn_plans=[FakeSpawnPlan(running_polls=10_000)])
        store = self._store()
        runner = _runner(store, _client(state), tmp_path)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(runner.run_recipe, 1, 1, "a")
                await anyio.sleep(0.1)
                store.rounds[1]["recipes"]["a"]["run_id"] = "newer"

        anyio.run(go)
        assert store.rounds[1]["recipes"]["a"]["state"] == "pending"
        (run,) = state.chat_spawn_runs.values()
        assert run.cancelled


# -- restart, resume and the supervised sweep -------------------------------------------------


class TestRecovery:
    def test_a_pending_round_with_a_run_id_resumes_polling_that_run(self, tmp_path: Path) -> None:
        state = FakeCmdState(chat_spawn_plans=[FakeSpawnPlan(response_text=canned_concepts_text())])
        client = _client(state)

        async def go() -> None:
            run = await client.spawn_run(
                caller=CONCEPTS_CALLER,
                prompt="old",
                model="m",
                effort="medium",
                cwd="/x",
                timeout_secs=300,
                disallowed_tools=[],
            )
            store.add_round(run_id=run.run_id)
            runner = _runner(store, client, tmp_path)
            await _run_with_group(runner.resume)

        store = FakeStore()
        anyio.run(go)
        assert store.rounds[1]["concepts"] == "ready"
        assert len(state.chat_spawn_runs) == 1  # no second spawn: the recorded run was resumed

    def test_a_pending_round_without_a_run_id_starts_a_new_run(self, tmp_path: Path) -> None:
        state = FakeCmdState()
        store = FakeStore()
        store.add_round(run_id=None)
        runner = _runner(store, _client(state), tmp_path)
        anyio.run(_run_with_group, runner.resume)
        assert store.rounds[1]["concepts"] == "ready"
        assert len(state.chat_spawn_runs) == 1

    def test_resume_also_restarts_pending_recipes(self, tmp_path: Path) -> None:
        state = FakeCmdState()
        store = FakeStore()
        store.add_round(concepts="ready", concepts_json=canned_concepts_text())
        store.add_recipe(1, "b")
        runner = _runner(store, _client(state), tmp_path)
        anyio.run(_run_with_group, runner.resume)
        assert store.rounds[1]["recipes"]["b"]["state"] == "banked"

    def test_the_sweep_does_not_start_a_job_this_process_is_already_driving(
        self, tmp_path: Path
    ) -> None:
        state = FakeCmdState(
            chat_spawn_plans=[FakeSpawnPlan(delay_s=0.3, response_text=canned_concepts_text())]
        )
        store = FakeStore()
        store.add_round()
        runner = _runner(store, _client(state), tmp_path)

        async def go(background: ContainedTaskGroup) -> None:
            runner.start_concepts(background, 1, 1)
            await anyio.sleep(0.1)
            await runner.sweep(background)  # a second sweep pass must find the job running
            await runner.sweep(background)

        anyio.run(_run_with_group, go)
        assert len(state.chat_spawn_runs) == 1
        assert store.rounds[1]["concepts"] == "ready"

    def test_the_sweep_heals_a_pending_job_nothing_is_driving(self, tmp_path: Path) -> None:
        state = FakeCmdState()
        store = FakeStore()
        store.add_round()
        runner = _runner(store, _client(state), tmp_path)
        anyio.run(_run_with_group, runner.sweep)
        assert store.rounds[1]["concepts"] == "ready"

    def test_supervise_runs_the_sweep_on_a_timer(self, tmp_path: Path) -> None:
        state = FakeCmdState()
        store = FakeStore()
        store.add_round()
        timing = CookoutTiming(
            poll_interval_s=0.01, spawn_gap_s=0.0, give_up_s=20.0, sweep_interval_s=0.05
        )
        runner = _runner(store, _client(state), tmp_path, timing=timing)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                runner.supervise(ContainedTaskGroup(tg, BackgroundTaskHealth()))
                with anyio.fail_after(10):
                    while store.rounds[1]["concepts"] != "ready":
                        await anyio.sleep(0.02)
                tg.cancel_scope.cancel()

        anyio.run(go)

    def test_start_methods_spawn_the_jobs(self, tmp_path: Path) -> None:
        state = FakeCmdState()
        store = FakeStore()
        store.add_round(concepts="ready", concepts_json=canned_concepts_text())
        store.add_recipe(1, "a")
        runner = _runner(store, _client(state), tmp_path)

        async def go(background: ContainedTaskGroup) -> None:
            runner.start_recipe(background, 1, 1, "a")

        anyio.run(_run_with_group, go)
        assert store.rounds[1]["recipes"]["a"]["state"] == "banked"

    def test_start_pictures_is_a_no_op_without_a_picture_job(self, tmp_path: Path) -> None:
        runner = _runner(FakeStore(), None, tmp_path)

        async def go(background: ContainedTaskGroup) -> None:
            runner.start_pictures(background, 1)

        anyio.run(_run_with_group, go)


class TestFactory:
    def test_standalone_has_no_runner_backend_and_fleet_does(self, tmp_path: Path) -> None:
        from wixy_server.storage import ProjectPaths

        paths = ProjectPaths(slug="s", root=tmp_path)
        standalone = build_cookout_runner(
            store=FakeStore(), bank=ScanBank(), client=None, notifier=_notifier(), paths=paths
        )
        assert not standalone.available and not standalone.images_available
        fleet = build_cookout_runner(
            store=FakeStore(),
            bank=ScanBank(),
            client=_client(FakeCmdState()),
            notifier=_notifier(),
            paths=paths,
        )
        assert fleet.available and not fleet.images_available  # no ComfyUI configured

    def test_the_jobs_folder_is_created_on_demand(self, tmp_path: Path) -> None:
        runner = _runner(FakeStore(), None, tmp_path)
        runner.prepare_directory()
        assert (tmp_path / "cookout-jobs").is_dir()


# -- checkpoint 2 fold-ins (M1, M2, M4, L5, L8) ------------------------------------------


class TestFoldIns:
    def test_m2_malformed_types_are_violations_not_crashes(self) -> None:
        bads: list[Any] = [[], {}, ["a"], 7]
        for bad in bads:
            obj = canned_concepts_obj()
            obj["concepts"][0]["dishType"] = bad
            obj["concepts"][1]["technique"] = bad
            parsed = _parse(obj)
            assert parsed.value is None
            assert any("dishType must be one of" in v for v in parsed.violations)
        obj = canned_concepts_obj()
        obj["concepts"][0]["id"] = ["a"]
        assert _parse(obj).value is None

    def test_l8_a_repeated_id_in_a_step_is_deduplicated_not_rejected(self) -> None:
        recipe = _recipe(_concept())
        first = recipe["steps"][0]["uses"][0]
        recipe["steps"][0]["uses"] = [first, first, *recipe["steps"][0]["uses"]]
        parsed = _parse_recipe(recipe)
        assert parsed.value is not None
        assert parsed.value["steps"][0]["uses"].count(first) == 1

    def test_l8_repeated_ids_elsewhere_are_still_rejected(self) -> None:
        obj = canned_concepts_obj()
        obj["concepts"][0]["pickedIngredientIds"].append(
            obj["concepts"][0]["pickedIngredientIds"][0]
        )
        assert any("must not repeat" in v for v in _parse(obj).violations)

    def test_m1_a_rejected_resumed_run_counts_as_a_repair_already_used(
        self, tmp_path: Path
    ) -> None:
        bad = json.dumps({"concepts": []})
        state = FakeCmdState(cookout_response_text=bad)
        client = _client(state)
        store = FakeStore()

        async def go() -> None:
            run = await client.spawn_run(
                caller=CONCEPTS_CALLER,
                prompt="the repair run, in a previous process",
                model="m",
                effort="medium",
                cwd="/x",
                timeout_secs=300,
                disallowed_tools=[],
            )
            store.add_round(run_id=run.run_id)
            await _run_with_group(_runner(store, client, tmp_path).resume)

        anyio.run(go)
        assert store.rounds[1]["concepts"] == "failed"
        # the resumed run (counted as a repair already) and the two repairs it leaves
        assert len(state.chat_spawn_runs) == 3

    def test_m4_no_early_retry_after_a_repair_was_issued(self, tmp_path: Path) -> None:
        bad = json.dumps({"concepts": []})
        state = FakeCmdState(
            chat_spawn_plans=[
                FakeSpawnPlan(response_text=bad),
                FakeSpawnPlan(final_status="error"),
            ]
        )
        store = FakeStore()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "failed"
        assert len(state.chat_spawn_runs) == 2  # the run and ONE repair; nothing respawned

    def test_l5_a_pending_job_past_its_deadline_fails_without_spawning(
        self, tmp_path: Path
    ) -> None:
        state = FakeCmdState()
        store = FakeStore()
        store.add_round()["concepts_deadline_at"] = time.time() - 5
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "failed"
        assert not state.chat_spawn_runs


# -- M3: every spec 3.2 lexical case against the REAL CookoutBank ------------------

REAL_PICKS = [
    "beef-ribeye-steak",
    "thick-cut-white-toast",
    "flat-leaf-parsley",
    "tenderstem-broccoli",
    "smoked-paprika",
    "peanut-butter",
    "gruyere",
    "espresso",
    "coconut-milk",
    "white-miso",
]


@pytest.fixture(scope="module")
def real_bank() -> Any:
    from wixy_server.livechat.cookout_bank import load_cookout_bank

    return load_cookout_bank()


def _real_concepts(bank: Any) -> dict[str, Any]:

    basket = basket_payload(bank, REAL_PICKS)
    assert basket is not None
    value = canned_cookout_concepts(build_concepts_prompt(basket))
    assert value is not None
    return value


def _real_parse(bank: Any, obj: dict[str, Any]) -> Any:
    return parse_concepts(json.dumps(obj), bank=bank, picked_ids=REAL_PICKS)


class TestRealBankLexicalCases:
    def test_the_canned_concepts_pass_against_the_real_bank(self, real_bank: Any) -> None:
        parsed = _real_parse(real_bank, _real_concepts(real_bank))
        assert parsed.violations == ()

    def _with_description(self, bank: Any, extra: str, *, staples: list[str] | None = None) -> Any:
        obj = _real_concepts(bank)
        obj["concepts"][0]["description"] += " " + extra
        if staples is not None:
            obj["concepts"][0]["stapleIds"] = staples
        return _real_parse(bank, obj)

    @pytest.mark.parametrize("food", ["mango", "Streaky bacon", "BACON LARDONS"])
    def test_unpicked_bank_foods_are_contraband(self, real_bank: Any, food: str) -> None:
        parsed = self._with_description(real_bank, f"Served with {food}.")
        assert parsed.value is None
        assert any("does not use" in v for v in parsed.violations)

    def test_peanut_butter_is_fine_but_an_extra_bare_butter_is_not(self, real_bank: Any) -> None:
        obj = _real_concepts(real_bank)
        concept = obj["concepts"][0]
        used = [i for i in concept["pickedIngredientIds"] if i != "white-miso"]
        if "peanut-butter" not in used:
            used = [*used[:7], "peanut-butter"]
        concept["pickedIngredientIds"] = used
        concept["omitted"] = [
            {"id": i, "reason": "Saved for later."} for i in REAL_PICKS if i not in used
        ]
        for sentence, ok in (
            ("Peanut butter and Beef ribeye steak with salt.", True),
            # round 2: bare "butter" is shorthand for the used peanut butter...
            ("Peanut butter with extra butter and Beef ribeye steak.", True),
            # ...but another undeclared staple is still contraband
            ("Peanut butter with extra flour and Beef ribeye steak.", False),
        ):
            concept["description"] = sentence
            parsed = _real_parse(real_bank, obj)
            banned = [v for v in parsed.violations if "concept a description" in v]
            assert (banned == []) is ok, (sentence, parsed.violations)

    def test_coconut_milk_is_fine_but_an_extra_staple_is_not(self, real_bank: Any) -> None:
        obj = _real_concepts(real_bank)
        concept = obj["concepts"][0]
        assert "coconut-milk" in concept["pickedIngredientIds"]
        for sentence, ok in (
            ("Coconut milk curry with Beef ribeye steak and salt.", True),
            # "milk" is shorthand for the picked coconut milk (round 2: a bare word matches a pick
            # whose name contains it); a staple the dish does not have is still contraband.
            ("Coconut milk plus a little milk with Beef ribeye steak.", True),
            ("Coconut milk plus sugar with Beef ribeye steak.", False),
        ):
            concept["description"] = sentence
            parsed = _real_parse(real_bank, obj)
            bad = [v for v in parsed.violations if "concept a description" in v]
            assert (bad == []) is ok, (sentence, parsed.violations)

    def test_a_fifth_undeclared_staple_in_prose_is_rejected(self, real_bank: Any) -> None:
        four = ["butter", "plain-flour", "cooking-oil", "milk"]
        parsed = self._with_description(real_bank, "Finished with a pinch of sugar.", staples=four)
        assert any("'Granulated sugar'" in v for v in parsed.violations)

    def test_an_omitted_pick_in_prose_is_rejected_but_allowed_in_its_reason(
        self, real_bank: Any
    ) -> None:
        parsed = self._with_description(real_bank, "No white miso is used here.")
        assert any("White miso" in v for v in parsed.violations)
        obj = _real_concepts(real_bank)
        omitted = obj["concepts"][0]["omitted"][0]
        name = real_bank.ingredient(omitted["id"]).name
        omitted["reason"] = f"{name} would overpower the rest."
        assert _real_parse(real_bank, obj).value is not None

    def test_stop_words_never_hide_a_staple_name(self, real_bank: Any) -> None:
        assert not {"butter", "flour", "milk", "oil", "sugar", "salt", "pepper"} & set(
            real_bank.stop_words
        )

    def test_the_real_bank_validates_a_recipe_and_rejects_contraband_in_it(
        self, real_bank: Any
    ) -> None:
        concept = _real_concepts(real_bank)["concepts"][0]
        recipe = _recipe(concept)
        assert parse_recipe(json.dumps(recipe), bank=real_bank, concept=concept).value is not None
        recipe["steps"][0]["text"] = "Fold in some mango."
        assert parse_recipe(json.dumps(recipe), bank=real_bank, concept=concept).value is None


# =================================================================================================
# Cookout twists (spec/server-chat/09a-cookout-twists.md §5): prompts, deterministic validation and
# the generation-fenced runner
# =================================================================================================

GOLDEN_CONCEPTS_PROMPT_SHA256 = "fa9bc21a928b64b8fdec5c3501e40637b1d0200ae83ac1e90bdf45e177d5b49e"
GOLDEN_RECIPE_PROMPT_SHA256 = "4572e54187b1d913cfd87e0556656cadfc2e92977e5465c7931a09955449cd54"
"""sha256 of the twist-free prompts exactly as the shipped core builds them (taken from the code
before the twists existed): a twist-free round must stay byte-for-byte the core."""

BASKET11 = [*PICKED_IDS, "mango"]
STARS = frozenset({"ribeye-steak", "tenderstem-broccoli"})
STAPLE_NAMES = {
    "butter": ("Butter", "butter"),
    "plain-flour": ("Plain flour", "flour"),
    "cooking-oil": ("Cooking oil", "oil"),
    "granulated-sugar": ("Granulated sugar", "sugar"),
    "milk": ("Milk", "milk"),
}


def _forbidden_names(twists: ConceptTwists) -> list[str]:
    bank = ScanBank()
    return [display_name(bank, i) for i in known_forbidden(bank, twists.forbidden_ids)]


def _twist_prompt(twists: ConceptTwists, picks: list[str] | None = None) -> str:
    payload = basket_payload(ScanBank(), PICKED_IDS if picks is None else picks, twists=twists)
    assert payload is not None
    return build_concepts_prompt(payload, forbidden_names=_forbidden_names(twists))


def _twist_concepts(twists: ConceptTwists, picks: list[str] | None = None) -> dict[str, Any]:
    value = canned_cookout_concepts(_twist_prompt(twists, picks))
    assert value is not None
    return value


def _parse_tw(obj: dict[str, Any], twists: ConceptTwists, picks: list[str] | None = None) -> Any:
    return parse_concepts(
        json.dumps(obj),
        bank=ScanBank(),
        picked_ids=PICKED_IDS if picks is None else picks,
        twists=twists,
    )


def _violations(parsed: Any) -> str:
    return " | ".join(parsed.violations)


def _drop_pick(concept: dict[str, Any], ingredient_id: str) -> None:
    """Take a pick out of a concept (and keep `omitted` the exact complement)."""
    concept["pickedIngredientIds"] = [
        i for i in concept["pickedIngredientIds"] if i != ingredient_id
    ]
    concept["omitted"].append({"id": ingredient_id, "reason": "Saved for another night."})


class TestTwistFreeIsUnchanged:
    def test_the_concepts_prompt_is_byte_identical_to_the_core(self) -> None:
        prompt = _twist_prompt(ConceptTwists())
        assert hashlib.sha256(prompt.encode()).hexdigest() == GOLDEN_CONCEPTS_PROMPT_SHA256
        assert prompt == _prompt()

    def test_the_recipe_prompt_is_byte_identical_to_the_core(self) -> None:
        concept = _concept()
        prompt = build_recipe_prompt(concept, concept_manifest(concept, ScanBank()))
        assert hashlib.sha256(prompt.encode()).hexdigest() == GOLDEN_RECIPE_PROMPT_SHA256

    def test_no_twist_text_or_key_appears_without_a_twist(self) -> None:
        payload = basket_payload(ScanBank(), PICKED_IDS)
        assert payload is not None and set(payload) == {"ingredients", "staples"}
        prompt = build_concepts_prompt(payload)
        for word in ("STYLE", "STAR", "WILDCARD", "KITCHEN CHALLENGE", "NEVER use", "eleven"):
            assert word not in prompt
        recipe = build_recipe_prompt(_concept(), concept_manifest(_concept(), ScanBank()))
        for word in ("STYLE", "KITCHEN CHALLENGE", "cookware", "heroes"):
            assert word not in recipe

    def test_twist_free_parsing_ignores_the_new_fields(self) -> None:
        obj = canned_concepts_obj()
        assert "challengeNote" not in obj["concepts"][0]
        parsed = _parse(obj)
        assert parsed.value is not None and "challengeNote" not in parsed.value["concepts"][0]


class TestTwistPrompts:
    def test_each_directive_appears_only_when_set_and_in_order(self) -> None:
        twists = ConceptTwists(
            star_ids=STARS,
            wildcard_id="mango",
            style="cosy-pub",
            challenge="one-pan",
        )
        prompt = _twist_prompt(twists, BASKET11)
        style = style_by_id("cosy-pub")
        challenge = challenge_by_id("one-pan")
        assert style is not None and challenge is not None
        positions = [
            prompt.index(f"STYLE: {style.concept_directive}"),
            prompt.index(challenge.concept_directive),
            prompt.index("Two STAR ingredients (ids ribeye-steak, tenderstem-broccoli)"),
            prompt.index("The WILDCARD ingredient (id mango)"),
        ]
        assert positions == sorted(positions)
        assert prompt.index("WILDCARD") < prompt.index("Your FINAL message")
        assert '"challengeNote": a string (1-140 chars)' in prompt
        assert "totalMinutes" not in prompt

    def test_the_thirty_minute_challenge_asks_for_total_minutes(self) -> None:
        prompt = _twist_prompt(ConceptTwists(challenge="thirty-minutes"))
        assert '"totalMinutes": integer (5-30)' in prompt

    @pytest.mark.parametrize(
        "twists, absent",
        [
            (
                ConceptTwists(style="picnic"),
                ("STAR", "WILDCARD", "KITCHEN CHALLENGE", "removed ingredients"),
            ),
            (
                ConceptTwists(challenge="six-steps"),
                ("STYLE", "STAR", "WILDCARD", "removed ingredients"),
            ),
            (
                ConceptTwists(star_ids=STARS),
                ("STYLE", "WILDCARD", "KITCHEN CHALLENGE", "removed ingredients"),
            ),
        ],
    )
    def test_only_the_set_twist_adds_text(
        self, twists: ConceptTwists, absent: tuple[str, ...]
    ) -> None:
        prompt = _twist_prompt(twists)
        for word in absent:
            assert word not in prompt

    def test_the_basket_size_follows_the_wildcard(self) -> None:
        prompt = _twist_prompt(ConceptTwists(wildcard_id="mango"), BASKET11)
        assert "picked eleven" in prompt and "use ALL eleven picked" in prompt
        assert "the eleven picked ingredients" in prompt
        assert "all eleven" in prompt and not re.search(r"ten", prompt)

    def test_the_twists_object_strips_who_starred_what(self) -> None:
        payload = basket_payload(
            ScanBank(),
            BASKET11,
            twists=ConceptTwists(
                star_ids=STARS, wildcard_id="mango", style="campfire", challenge="no-oven"
            ),
        )
        assert payload is not None
        assert payload["twists"] == {
            "stars": ["ribeye-steak", "tenderstem-broccoli"],
            "wildcard": "mango",
            "style": "campfire",
            "challenge": "no-oven",
        }
        assert [i["id"] for i in payload["ingredients"]] == sorted(BASKET11)
        assert len(payload["staples"]) == 8

    def test_only_catalogue_text_and_ids_reach_the_prompt(self) -> None:
        twists = ConceptTwists(
            star_ids=STARS, wildcard_id="mango", style="posh-tasting", challenge="no-oven"
        )
        prompt = _twist_prompt(twists, BASKET11)
        for private in (
            "Cupcake",
            "Pumpkin",
            "example.com",
            "cupcake",
            "pumpkin",
            "vote",
            "rating",
        ):
            assert private not in prompt

    def test_an_unknown_style_or_challenge_id_adds_nothing(self) -> None:
        payload = basket_payload(ScanBank(), PICKED_IDS, twists=ConceptTwists(style="nonsense"))
        assert payload is not None
        assert "STYLE" not in build_concepts_prompt(payload)

    def test_the_recipe_prompt_carries_style_challenge_cookware_and_heroes(self) -> None:
        concept = _concept()
        concept["totalMinutes"] = 25
        twists = RecipeTwists(
            star_ids=frozenset({concept["pickedIngredientIds"][0]}),
            style="street-food",
            challenge="thirty-minutes",
        )
        prompt = build_recipe_prompt(concept, concept_manifest(concept, ScanBank()), twists=twists)
        style = style_by_id("street-food")
        challenge = challenge_by_id("thirty-minutes")
        assert style is not None and challenge is not None
        assert f"STYLE: {style.concept_directive}" in prompt
        assert challenge.recipe_directive in prompt
        assert '"cookware": [string (1-40 chars)] (1-4 cooking vessels and tools)' in prompt
        assert "planned to take 25 minutes" in prompt
        hero = ScanBank().ingredient(concept["pickedIngredientIds"][0])
        assert hero is not None
        assert f"Make {hero.name} the heroes: generous, central quantities." in prompt

    def test_every_catalogue_phrase_is_food_free_against_the_scanning_bank(self) -> None:
        from wixy_server.livechat.cookout_twists import CHALLENGES, STYLES

        bank = ScanBank()
        texts = [s.concept_directive for s in STYLES] + [s.picture_phrase for s in STYLES]
        texts += [c.concept_directive for c in CHALLENGES] + [
            c.recipe_directive for c in CHALLENGES
        ]
        for text in texts:
            assert (
                bank.find_contraband_ingredients(
                    text, allowed_ingredient_ids=set(), allowed_staple_ids=set()
                )
                == []
            ), text


class TestParseConceptsWithTwists:
    def test_eleven_items_are_checked_against_an_eleven_basket(self) -> None:
        twists = ConceptTwists(wildcard_id="mango")
        obj = _twist_concepts(twists, BASKET11)
        parsed = _parse_tw(obj, twists, BASKET11)
        assert parsed.violations == () and parsed.value is not None
        # the same answer is wrong for the ten-item basket (an unknown id) ...
        assert _parse_tw(obj, ConceptTwists(), PICKED_IDS).value is None
        # ... and an omission that is not the exact complement is caught
        obj["concepts"][0]["omitted"] = obj["concepts"][0]["omitted"][:-1] or [
            {"id": "x", "reason": "x"}
        ]
        assert "omitted must be exactly" in _violations(_parse_tw(obj, twists, BASKET11))

    def test_the_union_must_cover_all_eleven(self) -> None:
        twists = ConceptTwists(wildcard_id="mango")
        obj = _twist_concepts(twists, BASKET11)
        for concept in obj["concepts"]:
            if "mango" in concept["pickedIngredientIds"]:
                _drop_pick(concept, "mango")
        text = _violations(_parse_tw(obj, twists, BASKET11))
        assert "no concept uses these picks: mango" in text
        assert "wildcard 'mango' must be used in at least two concepts (it is in 0)" in text

    def test_stars_are_valid_when_used_and_named_in_every_concept(self) -> None:
        twists = ConceptTwists(star_ids=STARS)
        parsed = _parse_tw(_twist_concepts(twists), twists)
        assert parsed.violations == ()

    def test_a_star_missing_from_a_concept_is_rejected(self) -> None:
        twists = ConceptTwists(star_ids=STARS)
        obj = _twist_concepts(twists)
        _drop_pick(obj["concepts"][1], "ribeye-steak")
        assert "concept b must use star 'ribeye-steak'" in _violations(_parse_tw(obj, twists))

    def test_a_star_that_is_not_named_in_title_or_description_is_rejected(self) -> None:
        twists = ConceptTwists(star_ids=STARS)
        obj = _twist_concepts(twists)
        concept = obj["concepts"][2]
        concept["title"] = "Golden Comfort Supper"
        concept["description"] = "A simple supper for two with a pinch of salt and black pepper."
        text = _violations(_parse_tw(obj, twists))
        assert "concept c must name star 'ribeye-steak' in its title or description" in text
        assert "concept c must name star 'tenderstem-broccoli' in its title or description" in text

    def test_a_star_named_by_its_alias_counts(self) -> None:
        twists = ConceptTwists(star_ids=frozenset({"tenderstem-broccoli"}))
        obj = _twist_concepts(twists)
        concept = obj["concepts"][0]
        concept["title"] = "Golden Comfort Supper"
        concept["description"] = "A simple supper for two built around the broccoli and salt."
        used = set(concept["pickedIngredientIds"])
        assert "tenderstem-broccoli" in used
        parsed = _parse_tw(obj, twists)
        assert not any("must name star" in v for v in parsed.violations)

    def test_the_wildcard_needs_two_concepts(self) -> None:
        twists = ConceptTwists(wildcard_id="mango")
        obj = _twist_concepts(twists, BASKET11)
        assert _parse_tw(obj, twists, BASKET11).value is not None
        holders = [c for c in obj["concepts"] if "mango" in c["pickedIngredientIds"]]
        assert len(holders) >= 2
        for concept in holders[1:]:
            _drop_pick(concept, "mango")
        assert "must be used in at least two concepts (it is in 1)" in _violations(
            _parse_tw(obj, twists, BASKET11)
        )

    @pytest.mark.parametrize("challenge", ["one-pan", "no-oven", "thirty-minutes", "six-steps"])
    def test_the_canned_answer_for_each_challenge_passes_and_keeps_its_fields(
        self, challenge: str
    ) -> None:
        twists = ConceptTwists(challenge=challenge)
        parsed = _parse_tw(_twist_concepts(twists), twists)
        assert parsed.violations == () and parsed.value is not None
        for concept in parsed.value["concepts"]:
            assert concept["challengeNote"]
            assert ("totalMinutes" in concept) is (challenge == "thirty-minutes")

    @pytest.mark.parametrize("challenge", ["one-pan", "no-oven", "thirty-minutes", "six-steps"])
    def test_a_missing_challenge_note_is_rejected(self, challenge: str) -> None:
        twists = ConceptTwists(challenge=challenge)
        obj = _twist_concepts(twists)
        del obj["concepts"][0]["challengeNote"]
        assert "concept a challengeNote must be a string" in _violations(_parse_tw(obj, twists))

    def test_a_challenge_note_that_smuggles_a_food_is_rejected(self) -> None:
        twists = ConceptTwists(challenge="one-pan")
        obj = _twist_concepts(twists)
        obj["concepts"][1]["challengeNote"] = "One pan, then serve it with mango."
        assert "concept b challengeNote mentions 'Mango'" in _violations(_parse_tw(obj, twists))

    def test_thirty_minutes_needs_a_total_between_five_and_thirty(self) -> None:
        twists = ConceptTwists(challenge="thirty-minutes")
        for bad in (4, 31, 45, "25", True, None):
            obj = _twist_concepts(twists)
            obj["concepts"][0]["totalMinutes"] = bad
            assert "concept a totalMinutes must be a whole number 5-30" in _violations(
                _parse_tw(obj, twists)
            ), bad
        obj = _twist_concepts(twists)
        del obj["concepts"][2]["totalMinutes"]
        assert "concept c totalMinutes" in _violations(_parse_tw(obj, twists))

    def test_no_oven_rejects_roast_bake_and_oven_dishes(self) -> None:
        twists = ConceptTwists(challenge="no-oven")
        obj = _twist_concepts(twists)
        obj["concepts"][0]["technique"] = "roast"
        obj["concepts"][1]["dishType"] = "traybake"
        obj["concepts"][2]["technique"] = "bake"
        text = _violations(_parse_tw(obj, twists))
        assert "concept a technique may not be roast or bake" in text
        assert "concept b dishType may not be traybake, pie or bake" in text
        assert "concept c technique may not be roast or bake" in text

    @pytest.mark.parametrize("field", ["title", "vibe", "description"])
    @pytest.mark.parametrize("word", ["oven", "preheat", "roasted", "baking"])
    def test_no_oven_rejects_an_oven_word_in_prose(self, field: str, word: str) -> None:
        twists = ConceptTwists(challenge="no-oven")
        obj = _twist_concepts(twists)
        if field == "vibe":
            obj["concepts"][0][field] = f"Cosy {word}"
        elif field == "title":
            obj["concepts"][0][field] = f"Supper {word}"
        else:
            obj["concepts"][0][field] = f"{obj['concepts'][0][field]} {word}"
        assert f"concept a {field} mentions the oven" in _violations(_parse_tw(obj, twists))

    def test_no_oven_does_not_misread_a_food_span_as_an_oven_word(self) -> None:
        twists = ConceptTwists(challenge="no-oven")
        obj = _twist_concepts(twists)
        (concept,) = [
            c for c in obj["concepts"] if "tinned-baked-beans" in c["pickedIngredientIds"]
        ][:1]
        concept["description"] = (
            "A simple supper for two built around tinned baked beans, salt and black pepper."
        )
        assert not any("mentions the oven" in v for v in _parse_tw(obj, twists).violations)

    def test_the_swapped_out_ingredient_is_rejected_anywhere(self) -> None:
        twists = ConceptTwists(forbidden_ids=frozenset({"white-miso"}))
        picks = [i for i in PICKED_IDS if i != "white-miso"] + ["mango"]
        base = _twist_concepts(twists, picks)
        assert _parse_tw(base, twists, picks).violations == ()
        spots: dict[str, Callable[[dict[str, Any]], None]] = {
            "title": lambda c: c.__setitem__("title", "White miso supper"),
            "vibe": lambda c: c.__setitem__("vibe", "Miso comfort"),
            "description": lambda c: c.__setitem__(
                "description", c["description"] + " Finished with a spoon of miso."
            ),
            "reason": lambda c: c["omitted"][0].__setitem__("reason", "Not with the white miso."),
        }
        for name, edit in spots.items():
            obj = copy.deepcopy(base)
            edit(obj["concepts"][0])
            text = _violations(_parse_tw(obj, twists, picks))
            assert "removed and may not appear anywhere" in text, name

    def test_a_forbidden_id_in_the_id_lists_is_rejected(self) -> None:
        twists = ConceptTwists(forbidden_ids=frozenset({"white-miso"}))
        picks = [i for i in PICKED_IDS if i != "white-miso"] + ["mango"]
        for key in ("pickedIngredientIds", "stapleIds"):
            obj = _twist_concepts(twists, picks)
            obj["concepts"][0][key].append("white-miso")
            assert "forbidden" in _violations(_parse_tw(obj, twists, picks)), key
        obj = _twist_concepts(twists, picks)
        obj["concepts"][0]["omitted"].append({"id": "white-miso", "reason": "Removed."})
        assert "removed and is forbidden" in _violations(_parse_tw(obj, twists, picks))


class TestRemovedPickableStaples:
    """For each of the five pickable staples swapped out of a basket (09a §1.6, §5.3)."""

    STAPLES = tuple(STAPLE_NAMES)

    @pytest.mark.parametrize("staple", STAPLES)
    def test_it_is_absent_from_the_prompts_staples_and_named_as_removed(self, staple: str) -> None:
        twists = ConceptTwists(forbidden_ids=frozenset({staple}))
        payload = basket_payload(ScanBank(), PICKED_IDS, twists=twists)
        assert payload is not None
        assert staple not in [s["id"] for s in payload["staples"]]
        assert len(payload["staples"]) == 7
        assert payload["twists"] == {"forbidden": [staple]}
        name, _short = STAPLE_NAMES[staple]
        prompt = _twist_prompt(twists)
        assert (
            "NEVER use or mention these removed ingredients anywhere, not even as a cupboard "
            f"staple: {name}." in prompt
        )

    @pytest.mark.parametrize("staple", STAPLES)
    def test_it_is_rejected_when_declared_listed_or_named(self, staple: str) -> None:
        twists = ConceptTwists(forbidden_ids=frozenset({staple}))
        name, short = STAPLE_NAMES[staple]
        base = _twist_concepts(twists)
        assert _parse_tw(base, twists).violations == ()

        def mutated(edit: Callable[[dict[str, Any]], None]) -> str:
            obj = copy.deepcopy(base)
            edit(obj["concepts"][0])
            return _violations(_parse_tw(obj, twists))

        assert "removed and is forbidden" in mutated(lambda c: c["stapleIds"].append(staple))
        assert "forbidden" in mutated(lambda c: c["pickedIngredientIds"].append(staple))
        assert "removed and is forbidden" in mutated(
            lambda c: c["omitted"].append({"id": staple, "reason": "Removed."})
        )
        for spelling in (name, name.lower(), short):
            for field in ("title", "vibe", "description"):
                phrase = f"Cosy {spelling}" if field == "vibe" else f"{spelling} supper"

                def set_field(
                    c: dict[str, Any], f: str = field, p: str = phrase, sp: str = spelling
                ) -> None:
                    c[f] = p if f != "description" else c["description"] + f" Add some {sp}."

                text = mutated(set_field)
                assert "removed and may not appear anywhere" in text, (staple, spelling, field)

            def set_reason(c: dict[str, Any], sp: str = spelling) -> None:
                c["omitted"][0]["reason"] = f"No {sp} needed."

            text = mutated(set_reason)
            assert "concept a omitted reason mentions" in text, (staple, spelling)
            assert "removed and may not appear anywhere" in text, (staple, spelling)

    @pytest.mark.parametrize("staple", STAPLES)
    def test_it_cannot_return_through_a_recipe(self, staple: str) -> None:
        twists = RecipeTwists(forbidden_ids=frozenset({staple}))
        name, short = STAPLE_NAMES[staple]
        concept = _concept()
        manifest = concept_manifest(concept, ScanBank(), forbidden_ids=twists.forbidden_ids)
        assert all(i["id"] != staple for i in manifest["staples"] + manifest["ingredients"])

        def parse(recipe: dict[str, Any]) -> Any:
            return parse_recipe(json.dumps(recipe), bank=ScanBank(), concept=concept, twists=twists)

        assert parse(_recipe(concept)).violations == ()
        recipe = _recipe(concept)
        recipe["ingredients"].append({"id": staple, "quantity": "1 portion", "note": ""})
        assert "removed from the basket and is forbidden" in _violations(parse(recipe))
        for spelling in (name, short):
            for where in ("quantity", "note", "step", "tip"):
                recipe = _recipe(concept)
                if where == "quantity":
                    recipe["ingredients"][0]["quantity"] = f"1 spoon {spelling}"
                elif where == "note":
                    recipe["ingredients"][0]["note"] = f"with {spelling}"
                elif where == "step":
                    recipe["steps"][0]["text"] = f"Stir in the {spelling} now."
                else:
                    recipe["tips"] = [f"Serve with {spelling}."]
                assert "removed and may not appear anywhere" in _violations(parse(recipe)), (
                    staple,
                    where,
                    spelling,
                )

    @pytest.mark.parametrize("staple", STAPLES)
    def test_earlier_generation_recipes_stay_readable(self, staple: str) -> None:
        concept = _concept()
        concept["stapleIds"] = [*concept["stapleIds"], staple]
        recipe = _recipe(concept)
        assert staple in [i["id"] for i in recipe["ingredients"]]
        parsed = parse_recipe(json.dumps(recipe), bank=ScanBank(), concept=concept)
        assert parsed.violations == () and parsed.value is not None


def _challenge_concept(challenge: str) -> dict[str, Any]:
    twists = ConceptTwists(challenge=challenge)
    concept: dict[str, Any] = _twist_concepts(twists)["concepts"][0]
    return concept


def _challenge_recipe(challenge: str) -> tuple[dict[str, Any], dict[str, Any], RecipeTwists]:
    concept = _challenge_concept(challenge)
    twists = RecipeTwists(challenge=challenge)
    prompt = build_recipe_prompt(concept, concept_manifest(concept, ScanBank()), twists=twists)
    recipe = canned_cookout_recipe(prompt)
    assert recipe is not None
    return concept, recipe, twists


def _parse_tr(concept: dict[str, Any], recipe: dict[str, Any], twists: RecipeTwists) -> Any:
    return parse_recipe(json.dumps(recipe), bank=ScanBank(), concept=concept, twists=twists)


class TestParseRecipeWithChallenges:
    @pytest.mark.parametrize("challenge", ["one-pan", "no-oven", "thirty-minutes", "six-steps"])
    def test_the_canned_recipe_passes_and_keeps_its_cookware(self, challenge: str) -> None:
        concept, recipe, twists = _challenge_recipe(challenge)
        parsed = _parse_tr(concept, recipe, twists)
        assert parsed.violations == () and parsed.value is not None
        assert parsed.value["cookware"] == recipe["cookware"]

    @pytest.mark.parametrize("challenge", ["one-pan", "no-oven", "thirty-minutes", "six-steps"])
    def test_cookware_is_required_and_bounded(self, challenge: str) -> None:
        concept, recipe, twists = _challenge_recipe(challenge)
        for bad in (None, [], ["a"] * 5, [""], ["x" * 41], [3]):
            changed = {**recipe, "cookware": bad}
            if bad is None:
                del changed["cookware"]
            text = _violations(_parse_tr(concept, changed, twists))
            assert "cookware" in text, (challenge, bad)

    def test_cookware_is_scanned_for_food(self) -> None:
        concept, recipe, twists = _challenge_recipe("six-steps")
        recipe["cookware"] = ["Large pan for mango"]
        assert "cookware 1 mentions 'Mango'" in _violations(_parse_tr(concept, recipe, twists))

    def test_without_a_challenge_cookware_is_neither_required_nor_stored(self) -> None:
        concept = _concept()
        parsed = parse_recipe(json.dumps(_recipe(concept)), bank=ScanBank(), concept=concept)
        assert parsed.value is not None and "cookware" not in parsed.value

    def test_one_pan_needs_exactly_one_vessel(self) -> None:
        concept, recipe, twists = _challenge_recipe("one-pan")
        recipe["cookware"] = ["Large pan", "Saucepan"]
        assert "exactly one cooking vessel" in _violations(_parse_tr(concept, recipe, twists))

    def test_one_pan_rejects_a_second_vessel_in_the_method(self) -> None:
        concept, recipe, twists = _challenge_recipe("one-pan")
        for text in (
            "Boil the rest in a pot.",
            "Move it to a saucepan.",
            "Finish in a wok.",
            "Crisp it under a baking tray.",
            "Then use a casserole dish.",
        ):
            changed = copy.deepcopy(recipe)
            changed["steps"][0]["text"] = text
            assert "uses a second cooking vessel" in _violations(
                _parse_tr(concept, changed, twists)
            ), text
        changed = copy.deepcopy(recipe)
        changed["tips"] = ["A skillet works too."]
        assert "tip 1 uses a second cooking vessel ('skillet')" in _violations(
            _parse_tr(concept, changed, twists)
        )

    def test_one_pan_allows_naming_the_declared_vessel_itself(self) -> None:
        concept, recipe, twists = _challenge_recipe("one-pan")
        recipe["cookware"] = ["Large frying pan"]
        recipe["steps"][0]["text"] = "Heat the frying pan and get everything ready."
        assert _parse_tr(concept, recipe, twists).violations == ()
        recipe["steps"][1]["text"] = "Tip it all into a pot."
        assert "second cooking vessel ('pot')" in _violations(_parse_tr(concept, recipe, twists))

    def test_one_pan_does_not_misread_a_food_span_as_a_vessel(self) -> None:
        concept, recipe, twists = _challenge_recipe("one-pan")
        recipe["steps"][0]["text"] = "Stir the pot barley through the pan."
        assert "second cooking vessel" not in _violations(_parse_tr(concept, recipe, twists))

    def test_no_oven_rejects_oven_words_everywhere_but_not_baking_powder(self) -> None:
        concept, recipe, twists = _challenge_recipe("no-oven")
        spots: dict[str, Callable[[dict[str, Any]], None]] = {
            "quantity": lambda r: r["ingredients"][0].__setitem__("quantity", "1 oven tray"),
            "note": lambda r: r["ingredients"][0].__setitem__("note", "roasted first"),
            "step": lambda r: r["steps"][0].__setitem__("text", "Preheat the oven."),
            "tip": lambda r: r.__setitem__("tips", ["Bake it longer."]),
            "cookware": lambda r: r.__setitem__("cookware", ["Oven tray"]),
        }
        for name, edit in spots.items():
            changed = copy.deepcopy(recipe)
            edit(changed)
            assert "mentions the oven" in _violations(_parse_tr(concept, changed, twists)), name
        # "baking powder" is a recognised food span, not a technique word; the bank double knows it
        # as a bank food, so it is rejected as contraband (a food the dish does not use), never as
        # an oven word
        changed = copy.deepcopy(recipe)
        changed["steps"][0]["text"] = "Stir in the baking powder."
        text = _violations(_parse_tr(concept, changed, twists))
        assert "mentions the oven" not in text and "mentions 'Baking powder'" in text

    def test_thirty_minutes_caps_prep_plus_cook(self) -> None:
        concept, recipe, twists = _challenge_recipe("thirty-minutes")
        recipe["prepMinutes"], recipe["cookMinutes"] = 15, 15
        assert _parse_tr(concept, recipe, twists).violations == ()
        recipe["cookMinutes"] = 16
        assert "must be 30 or less (it is 31)" in _violations(_parse_tr(concept, recipe, twists))

    def test_six_steps_caps_the_method(self) -> None:
        concept, recipe, twists = _challenge_recipe("six-steps")
        ids = [i["id"] for i in recipe["ingredients"]]
        recipe["steps"] = [
            {"text": f"Do step {n} of the method.", "minutes": 1, "uses": ids if n == 0 else []}
            for n in range(6)
        ]
        assert _parse_tr(concept, recipe, twists).violations == ()
        recipe["steps"].append({"text": "One step too many.", "minutes": 1, "uses": []})
        assert "steps must be at most 6 (it is 7)" in _violations(
            _parse_tr(concept, recipe, twists)
        )

    def test_the_repair_run_is_told_the_rule(self) -> None:
        concept, recipe, twists = _challenge_recipe("thirty-minutes")
        recipe["cookMinutes"] = 40
        suffix = build_repair_suffix(_parse_tr(concept, recipe, twists).violations)
        assert "prepMinutes + cookMinutes must be 30 or less" in suffix

    def test_a_forbidden_cookware_word_is_rejected(self) -> None:
        concept, recipe, _ = _challenge_recipe("six-steps")
        twists = RecipeTwists(challenge="six-steps", forbidden_ids=frozenset({"milk"}))
        recipe["cookware"] = ["Milk pan"]
        text = _violations(_parse_tr(concept, recipe, twists))
        assert "cookware 1 mentions 'Milk'" in text
        assert "cookware 1 mentions 'Milk', which was removed" in text


class TestFakeCmdAnswersEveryCombination:
    """The canned answers are valid by construction for every twist combination (09a §8)."""

    @pytest.mark.parametrize(
        "challenge", [None, "one-pan", "no-oven", "thirty-minutes", "six-steps"]
    )
    @pytest.mark.parametrize("style", [None, "picnic"])
    @pytest.mark.parametrize("stars", [False, True])
    @pytest.mark.parametrize("wildcard", [False, True])
    def test_concepts_and_recipes_validate(
        self, challenge: str | None, style: str | None, stars: bool, wildcard: bool
    ) -> None:
        picks = BASKET11 if wildcard else PICKED_IDS
        twists = ConceptTwists(
            star_ids=STARS if stars else frozenset(),
            wildcard_id="mango" if wildcard else None,
            style=style,
            challenge=challenge,
        )
        parsed = _parse_tw(_twist_concepts(twists, picks), twists, picks)
        assert parsed.violations == () and parsed.value is not None
        recipe_twists = RecipeTwists(star_ids=twists.star_ids, style=style, challenge=challenge)
        for concept in parsed.value["concepts"]:
            prompt = build_recipe_prompt(
                concept, concept_manifest(concept, ScanBank()), twists=recipe_twists
            )
            recipe = canned_cookout_recipe(prompt)
            assert recipe is not None
            result = _parse_tr(concept, recipe, recipe_twists)
            assert result.violations == (), (concept["id"], result.violations)

    def test_the_canned_concepts_after_a_swap_avoid_the_removed_ingredient(self) -> None:
        twists = ConceptTwists(forbidden_ids=frozenset({"butter"}), style="campfire")
        picks = [*PICKED_IDS]
        parsed = _parse_tw(_twist_concepts(twists, picks), twists, picks)
        assert parsed.violations == ()


# -- the runner with twists and generations -----------------------------------------------------


def _spawned_prompts(state: FakeCmdState) -> list[str]:
    return [str(r.body["prompt"]) for r in state.chat_spawn_runs.values()]


class TestRunnerWithTwists:
    def test_a_stars_and_wildcard_round_sends_eleven_items_and_gets_valid_concepts(
        self, tmp_path: Path
    ) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(
            picked=BASKET11,
            stars=sorted(STARS),
            wildcard="mango",
            style="cosy-pub",
            challenge="one-pan",
        )
        _drive_concepts(_runner(store, _client(state), tmp_path))
        (prompt,) = _spawned_prompts(state)
        basket = json.loads(prompt.split(BASKET_MARKER, 1)[1].splitlines()[0])
        assert len(basket["ingredients"]) == 11
        assert basket["twists"]["stars"] == sorted(STARS)
        assert basket["twists"]["wildcard"] == "mango"
        assert "STYLE:" in prompt and "STAR ingredients" in prompt and "WILDCARD" in prompt
        assert store.rounds[1]["concepts"] == "ready"
        stored = json.loads(store.rounds[1]["concepts_json"])
        assert all(c["challengeNote"] for c in stored["concepts"])

    def test_a_ten_pick_basket_with_nothing_set_is_still_the_core_prompt(
        self, tmp_path: Path
    ) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        (prompt,) = _spawned_prompts(state)
        assert prompt == _prompt()

    def test_a_basket_of_the_wrong_size_fails_without_a_run(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(picked=PICKED_IDS[:9])
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert not state.chat_spawn_runs
        assert store.rounds[1]["concepts"] == "failed"

    def test_a_swap_round_forbids_the_removed_staple(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(forbidden=["milk"], generation=2)
        _drive_concepts(_runner(store, _client(state), tmp_path), generation=2)
        (prompt,) = _spawned_prompts(state)
        basket = json.loads(prompt.split(BASKET_MARKER, 1)[1].splitlines()[0])
        assert "milk" not in [s["id"] for s in basket["staples"]]
        assert "NEVER use or mention these removed ingredients" in prompt
        assert store.rounds[1]["concepts"] == "ready"

    def test_a_recipe_job_uses_the_challenge_and_stores_cookware(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        twists = ConceptTwists(challenge="one-pan")
        concepts = _twist_concepts(twists)
        store.add_round(concepts="ready", concepts_json=json.dumps(concepts), challenge="one-pan")
        store.add_recipe(1, "a")
        _drive_recipe(_runner(store, _client(state), tmp_path))
        (prompt,) = _spawned_prompts(state)
        assert "KITCHEN CHALLENGE - one pan only" in prompt
        slot = store.rounds[1]["recipes"]["a"]
        assert slot["state"] == "banked"
        assert json.loads(slot["recipe_json"])["cookware"]

    def test_the_repair_feedback_names_the_failed_star_rule(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(stars=sorted(STARS))
        broken = _twist_concepts(ConceptTwists(star_ids=STARS))
        _drop_pick(broken["concepts"][0], "ribeye-steak")
        good = _twist_concepts(ConceptTwists(star_ids=STARS))
        state.chat_spawn_plans = [
            FakeSpawnPlan(response_text=json.dumps(broken)),
            FakeSpawnPlan(response_text=json.dumps(good)),
        ]
        _drive_concepts(_runner(store, _client(state), tmp_path))
        first, second = _spawned_prompts(state)
        assert "concept a must use star 'ribeye-steak'" in second
        assert second.startswith(first)
        assert store.rounds[1]["concepts"] == "ready"


# -- generation identity: expected_generation on every claim / finish path -------------------------


class _GatedSpawns:
    """Holds the FIRST spawn after cmd has accepted it (the slow HTTP return), so a swap can land
    between the spawn and the claim - the exact window the generation fence has to close."""

    def __init__(self, runner: CmdCookoutRunner) -> None:
        self.gate = anyio.Event()
        self.calls = 0
        self._original = runner._spawn
        runner._spawn = self._spawn  # type: ignore[method-assign]

    async def _spawn(self, caller: str, prompt: str) -> str:
        self.calls += 1
        run_id = await self._original(caller, prompt)
        if self.calls == 1:
            await self.gate.wait()
        return run_id


async def _until(condition: Callable[[], bool]) -> None:
    with anyio.fail_after(10):
        while not condition():
            await anyio.sleep(0.001)


class TestGenerationFence:
    def test_every_concepts_claim_and_finish_names_the_captured_generation(
        self, tmp_path: Path
    ) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.claims and all(c[2] == 1 for c in store.claims)
        assert {c[0] for c in store.claims} == {"claim:c", "finish:c"}

    def test_every_recipe_claim_and_finish_names_the_captured_generation(
        self, tmp_path: Path
    ) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(concepts="ready", concepts_json=canned_concepts_text(), generation=2)
        store.add_recipe(1, "a")
        _drive_recipe(_runner(store, _client(state), tmp_path), generation=2)
        assert store.claims and all(c[2] == 2 for c in store.claims)
        assert store.rounds[1]["recipes"]["a"]["state"] == "banked"

    def test_a_job_for_an_older_generation_does_nothing_at_all(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(generation=2)
        _drive_concepts(_runner(store, _client(state), tmp_path), generation=1)
        assert not state.chat_spawn_runs and not store.claims
        assert store.rounds[1]["concepts"] == "pending"
        store.rounds[1]["concepts"] = "ready"
        store.rounds[1]["concepts_json"] = canned_concepts_text()
        store.add_recipe(1, "a")
        _drive_recipe(_runner(store, _client(state), tmp_path), generation=1)
        assert not state.chat_spawn_runs and store.rounds[1]["recipes"]["a"]["state"] == "pending"

    def test_a_slow_generation_1_concepts_spawn_cannot_claim_generation_2(
        self, tmp_path: Path
    ) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round()
        runner = _runner(store, _client(state), tmp_path)
        gated = _GatedSpawns(runner)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(runner.run_concepts, 1, 1)
                await _until(lambda: gated.calls == 1)
                assert ("c", 1, 1, "") in runner._running
                store.complete_swap(1)
                tg.start_soon(runner.run_concepts, 1, 2)
                await _until(lambda: ("c", 1, 2, "") in runner._running)
                gated.gate.set()

        anyio.run(go)
        first_id, second_id = sorted(state.chat_spawn_runs)
        first = state.chat_spawn_runs[first_id]
        assert first.cancel_requests >= 1, "the losing generation-1 spawn must be cancelled"
        assert ("claim:c", 1, 1, first_id, False) in store.claims, "generation 1's claim is refused"
        assert ("claim:c", 1, 2, second_id, True) in store.claims
        row = store.rounds[1]
        assert row["generation"] == 2 and row["concepts"] == "ready"
        assert row["concepts_run_id"] == second_id
        assert not any(c[0].startswith("finish") and c[2] == 1 and c[4] for c in store.claims)

    def test_a_slow_generation_1_recipe_spawn_cannot_claim_generation_2(
        self, tmp_path: Path
    ) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(concepts="ready", concepts_json=canned_concepts_text())
        store.add_recipe(1, "a")
        runner = _runner(store, _client(state), tmp_path)
        gated = _GatedSpawns(runner)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(runner.run_recipe, 1, 1, "a")
                await _until(lambda: gated.calls == 1)
                assert ("r", 1, 1, "a") in runner._running
                store.complete_swap(1)
                store.rounds[1]["concepts"] = "ready"
                store.rounds[1]["concepts_json"] = canned_concepts_text()
                store.add_recipe(1, "a")
                tg.start_soon(runner.run_recipe, 1, 2, "a")
                await _until(lambda: ("r", 1, 2, "a") in runner._running)
                gated.gate.set()

        anyio.run(go)
        first_id, second_id = sorted(state.chat_spawn_runs)
        assert state.chat_spawn_runs[first_id].cancel_requests >= 1
        assert ("claim:r:a", 1, 1, first_id, False) in store.claims
        slot = store.rounds[1]["recipes"]["a"]
        assert slot["state"] == "banked" and slot["run_id"] == second_id
        assert not any(c[0].startswith("finish") and c[2] == 1 and c[4] for c in store.claims)

    def test_a_generation_1_run_that_errors_after_the_swap_cannot_fail_generation_2(
        self, tmp_path: Path
    ) -> None:
        store = FakeStore()
        state = FakeCmdState(chat_spawn_running_polls=3, chat_spawn_final_status="error")
        store.add_round()
        runner = _runner(store, _client(state), tmp_path)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(runner.run_concepts, 1, 1)
                await _until(lambda: bool(state.chat_spawn_runs))
                store.complete_swap(1)

        anyio.run(go)
        assert store.rounds[1]["concepts"] == "pending", "generation 2 must be untouched"
        assert not any(c[0].startswith("finish") and c[4] for c in store.claims)
        assert next(iter(state.chat_spawn_runs.values())).cancel_requests >= 1

    def test_a_generation_1_success_after_the_swap_cannot_finish_generation_2(
        self, tmp_path: Path
    ) -> None:
        store, state = FakeStore(), FakeCmdState(chat_spawn_delay_s=0.1)
        store.add_round()
        runner = _runner(store, _client(state), tmp_path)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(runner.run_concepts, 1, 1)
                await _until(lambda: bool(state.chat_spawn_runs))
                store.complete_swap(1)

        anyio.run(go)
        row = store.rounds[1]
        assert row["concepts"] == "pending" and row["concepts_json"] is None
        assert not any(c[0].startswith("finish") and c[4] for c in store.claims)

    def test_a_crash_of_a_generation_1_job_cannot_fail_generation_2(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round()
        runner = _runner(store, _client(state), tmp_path)

        async def boom(*_args: Any, **_kwargs: Any) -> None:
            store.complete_swap(1)
            raise RuntimeError("the job died")

        runner._drive = boom  # type: ignore[method-assign]
        anyio.run(runner.run_concepts, 1, 1)
        assert store.rounds[1]["concepts"] == "pending"
        assert not any(c[0].startswith("finish") for c in store.claims)

    def test_a_recipe_crash_of_generation_1_cannot_fail_generation_2(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(concepts="ready", concepts_json=canned_concepts_text())
        store.add_recipe(1, "a")
        runner = _runner(store, _client(state), tmp_path)

        async def boom(*_args: Any, **_kwargs: Any) -> None:
            store.complete_swap(1)
            store.rounds[1]["concepts"] = "ready"
            store.add_recipe(1, "a")
            raise RuntimeError("the job died")

        runner._drive = boom  # type: ignore[method-assign]
        anyio.run(runner.run_recipe, 1, 1, "a")
        assert store.rounds[1]["recipes"]["a"]["state"] == "pending"
        assert not any(c[0].startswith("finish") for c in store.claims)

    def test_a_standalone_resume_marks_only_the_captured_generation_unavailable(
        self, tmp_path: Path
    ) -> None:
        store = FakeStore()
        store.add_round(generation=3)
        runner = _runner(store, None, tmp_path)
        anyio.run(runner.run_concepts, 1, 2)
        assert store.rounds[1]["concepts"] == "pending"
        anyio.run(runner.run_concepts, 1, 3)
        assert store.rounds[1]["concepts"] == "unavailable"

    def test_recovery_restarts_a_pending_job_with_its_own_generation(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(generation=2)
        runner = _runner(store, _client(state), tmp_path)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                await runner.resume(ContainedTaskGroup(tg, BackgroundTaskHealth()))

        anyio.run(go)
        assert store.rounds[1]["concepts"] == "ready"
        assert store.claims and all(c[2] == 2 for c in store.claims)

    def test_the_sweep_keys_running_jobs_by_generation(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(generation=2)
        runner = _runner(store, _client(state), tmp_path)
        runner._running.add(("c", 1, 1, ""))  # an old generation's job is not generation 2's
        anyio.run(_sweep(runner))
        assert store.rounds[1]["concepts"] == "ready"
        store.rounds[1]["concepts"] = "pending"
        store.rounds[1]["concepts_run_id"] = None
        runner = _runner(store, _client(state), tmp_path)
        runner._running.add(("c", 1, 2, ""))
        anyio.run(_sweep(runner))
        assert store.rounds[1]["concepts"] == "pending", "a job already driving it is left alone"

    def test_the_start_methods_pass_the_generation_through(self, tmp_path: Path) -> None:
        store, state = FakeStore(), FakeCmdState()
        store.add_round(generation=2)
        runner = _runner(store, _client(state), tmp_path)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                runner.start_concepts(ContainedTaskGroup(tg, BackgroundTaskHealth()), 1, 2)

        anyio.run(go)
        assert store.rounds[1]["concepts"] == "ready"
        assert all(c[2] == 2 for c in store.claims)


def _sweep(runner: CmdCookoutRunner) -> Callable[[], Any]:
    async def go() -> None:
        async with anyio.create_task_group() as tg:
            await runner.sweep(ContainedTaskGroup(tg, BackgroundTaskHealth()))

    return go


# -- the real bank (a double of nothing: the whole pipeline against cookout_bank.CookoutBank) ------


class TestRealBankWithTwists:
    @pytest.mark.parametrize(
        "challenge", [None, "one-pan", "no-oven", "thirty-minutes", "six-steps"]
    )
    def test_the_canned_answers_pass_the_real_bank_for_every_challenge(
        self, real_bank: Any, challenge: str | None
    ) -> None:
        twists = ConceptTwists(
            star_ids=frozenset(REAL_PICKS[:2]),
            wildcard_id="mango" if real_bank.ingredient("mango") else None,
            style="campfire",
            challenge=challenge,
        )
        picks = [*REAL_PICKS, "mango"] if twists.wildcard_id else list(REAL_PICKS)
        payload = basket_payload(real_bank, picks, twists=twists)
        assert payload is not None
        value = canned_cookout_concepts(build_concepts_prompt(payload))
        assert value is not None
        parsed = parse_concepts(json.dumps(value), bank=real_bank, picked_ids=picks, twists=twists)
        assert parsed.violations == () and parsed.value is not None
        recipe_twists = RecipeTwists(
            star_ids=twists.star_ids, style="campfire", challenge=challenge
        )
        for concept in parsed.value["concepts"]:
            prompt = build_recipe_prompt(
                concept, concept_manifest(concept, real_bank), twists=recipe_twists
            )
            recipe = canned_cookout_recipe(prompt)
            assert recipe is not None
            result = parse_recipe(
                json.dumps(recipe), bank=real_bank, concept=concept, twists=recipe_twists
            )
            assert result.violations == (), (challenge, concept["id"], result.violations)

    def test_a_removed_pickable_staple_is_forbidden_even_as_a_declared_staple(
        self, real_bank: Any
    ) -> None:
        for staple in ("butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk"):
            twists = ConceptTwists(forbidden_ids=frozenset({staple}))
            payload = basket_payload(real_bank, REAL_PICKS, twists=twists)
            assert payload is not None
            assert staple not in [s["id"] for s in payload["staples"]]
            value = canned_cookout_concepts(
                build_concepts_prompt(payload, forbidden_names=[display_name(real_bank, staple)])
            )
            assert value is not None
            assert (
                parse_concepts(
                    json.dumps(value), bank=real_bank, picked_ids=REAL_PICKS, twists=twists
                ).violations
                == ()
            )
            value["concepts"][0]["stapleIds"].append(staple)
            text = _violations(
                parse_concepts(
                    json.dumps(value), bank=real_bank, picked_ids=REAL_PICKS, twists=twists
                )
            )
            assert "forbidden" in text, staple


# -- follow-up: the staples sentence, late work after a swap, the real bank --------------------


class TestStaplesRuleSentence:
    @pytest.mark.parametrize("staple", tuple(STAPLE_NAMES))
    def test_a_removed_staple_is_dropped_from_the_at_most_rule(self, staple: str) -> None:
        prompt = _twist_prompt(ConceptTwists(forbidden_ids=frozenset({staple})))
        rule = prompt.split("At most 4 of ", 1)[1].split(" may be used", 1)[0]
        kept = [s for s in STAPLE_NAMES if s != staple]
        assert rule == ", ".join(kept[:-1]) + " and " + kept[-1]
        assert staple not in rule

    def test_with_nothing_removed_the_sentence_is_the_core_wording(self) -> None:
        assert (
            "At most 4 of butter, plain-flour, cooking-oil, granulated-sugar and milk may be used"
            in _twist_prompt(ConceptTwists(style="picnic"))
        )


class TestLateGenerationOneWork:
    def test_a_repair_run_is_not_started_for_a_generation_that_was_swapped_away(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import wixy_server.livechat.cookout_ai as module

        store = FakeStore()
        store.add_round()
        bad = canned_concepts_obj()
        bad["concepts"][0]["description"] += " Topped with fresh mango."
        state = FakeCmdState(chat_spawn_plans=[FakeSpawnPlan(response_text=json.dumps(bad))])
        original = module.parse_concepts

        def parse_then_swap(*args: Any, **kwargs: Any) -> Any:
            result = original(*args, **kwargs)
            store.complete_swap(1)  # the swap lands while the rejected answer is being judged
            return result

        monkeypatch.setattr(module, "parse_concepts", parse_then_swap)
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert len(state.chat_spawn_runs) == 1, "no repair run for the superseded generation"
        row = store.rounds[1]
        assert row["generation"] == 2 and row["concepts"] == "pending"
        assert not any(c[0].startswith("finish") and c[4] for c in store.claims)

    def test_cmd_going_unreachable_after_a_swap_cannot_end_generation_2(
        self, tmp_path: Path
    ) -> None:
        from wixy_server.livechat.cookout_ai import _RunUnavailableError

        store, state = FakeStore(), FakeCmdState()
        store.add_round()
        runner = _runner(store, _client(state), tmp_path)

        async def swap_then_unreachable(caller: str, prompt: str) -> str:
            store.complete_swap(1)
            raise _RunUnavailableError("cmd could not be reached")

        runner._spawn = swap_then_unreachable  # type: ignore[method-assign]
        _drive_concepts(runner)
        row = store.rounds[1]
        assert row["generation"] == 2 and row["concepts"] == "pending"
        assert ("finish:c", 1, 1, None, False) in store.claims, (
            "the unavailable write named generation 1 and was refused"
        )

    def test_cmd_going_unreachable_for_a_late_recipe_cannot_end_generation_2(
        self, tmp_path: Path
    ) -> None:
        from wixy_server.livechat.cookout_ai import _RunUnavailableError

        store, state = FakeStore(), FakeCmdState()
        store.add_round(concepts="ready", concepts_json=canned_concepts_text())
        store.add_recipe(1, "a")
        runner = _runner(store, _client(state), tmp_path)

        async def swap_then_unreachable(caller: str, prompt: str) -> str:
            store.complete_swap(1)
            store.rounds[1]["concepts"] = "ready"
            store.rounds[1]["concepts_json"] = canned_concepts_text()
            store.add_recipe(1, "a")
            raise _RunUnavailableError("cmd could not be reached")

        runner._spawn = swap_then_unreachable  # type: ignore[method-assign]
        _drive_recipe(runner)
        assert store.rounds[1]["recipes"]["a"]["state"] == "pending"
        assert ("finish:r:a", 1, 1, None, False) in store.claims


class TestRemovedPickableStaplesRealBank:
    """The five staple-swap cases, once more against the real bank (09a §8)."""

    @pytest.mark.parametrize("staple", tuple(STAPLE_NAMES))
    def test_prompt_concepts_and_recipes(self, real_bank: Any, staple: str) -> None:
        twists = ConceptTwists(forbidden_ids=frozenset({staple}))
        payload = basket_payload(real_bank, REAL_PICKS, twists=twists)
        assert payload is not None
        assert staple not in [s["id"] for s in payload["staples"]]
        name = display_name(real_bank, staple)
        prompt = build_concepts_prompt(payload, forbidden_names=[name])
        assert f"staple: {name}." in prompt
        rule = prompt.split("At most 4 of ", 1)[1].split(" may be used", 1)[0]
        assert staple not in rule
        base = canned_cookout_concepts(prompt)
        assert base is not None

        def parse(obj: dict[str, Any]) -> str:
            return _violations(
                parse_concepts(
                    json.dumps(obj), bank=real_bank, picked_ids=REAL_PICKS, twists=twists
                )
            )

        assert parse(base) == ""
        short = STAPLE_NAMES[staple][1]
        for spelling in (name, name.lower(), short):
            obj = copy.deepcopy(base)
            obj["concepts"][0]["description"] += f" Finished with {spelling}."
            assert "removed and may not appear anywhere" in parse(obj), (staple, spelling)
            obj = copy.deepcopy(base)
            obj["concepts"][0]["omitted"][0]["reason"] = f"No {spelling} needed."
            assert "removed and may not appear anywhere" in parse(obj), (staple, spelling)
        for key in ("stapleIds", "pickedIngredientIds"):
            obj = copy.deepcopy(base)
            obj["concepts"][0][key].append(staple)
            assert "forbidden" in parse(obj), (staple, key)
        # recipes: generation-1 recipes stay readable; generation 2 may not use or name it
        concept = copy.deepcopy(base["concepts"][0])
        old = copy.deepcopy(concept)
        old["stapleIds"] = [*old["stapleIds"], staple]
        recipe = _recipe(old)
        assert parse_recipe(json.dumps(recipe), bank=real_bank, concept=old).violations == ()
        rt = RecipeTwists(forbidden_ids=frozenset({staple}))
        fresh = _recipe(concept)
        assert parse_recipe(json.dumps(fresh), bank=real_bank, concept=concept, twists=rt).value
        fresh["ingredients"].append({"id": staple, "quantity": "1 portion", "note": ""})
        assert "forbidden" in _violations(
            parse_recipe(json.dumps(fresh), bank=real_bank, concept=concept, twists=rt)
        )
        for spelling in (name, short):
            text_recipe = _recipe(concept)
            text_recipe["steps"][0]["text"] = f"Stir in the {spelling} now."
            assert "removed and may not appear anywhere" in _violations(
                parse_recipe(json.dumps(text_recipe), bank=real_bank, concept=concept, twists=rt)
            ), (staple, spelling)


def test_the_concepts_schema_lists_challenge_note_only_for_a_challenge() -> None:
    plain = _twist_prompt(ConceptTwists())
    assert '"challengeNote": string' not in plain
    for challenge in ("no-oven", "thirty-minutes"):
        prompt = _twist_prompt(ConceptTwists(challenge=challenge))
        assert '\n   "challengeNote": string (1-140 chars),' in prompt
        assert ('"totalMinutes": integer (5-30),' in prompt) is (challenge == "thirty-minutes")


# -- game modes: Toasted sandwich (spec/server-chat/09c-cookout-modes.md §3, §8.3) -------------


def _toastie_mode() -> CookoutMode:
    mode = default_modes().mode("toastie")
    assert mode is not None
    return mode


TOASTIE = _toastie_mode()
GOLDEN = json.loads(
    (Path(__file__).parent / "fixtures" / "cookout_classic_golden.json").read_text("utf-8")
)
T_BREAD = "sliced-white-bread"
T_FILLINGS = [
    "mature-cheddar",
    "red-leicester",
    "cooked-ham",
    "streaky-bacon",
    "tomato",
    "spinach",
    "wholegrain-mustard",
]
T_IDS = [T_BREAD, *T_FILLINGS]
T_WILDCARD = "avocado"


def _t_prompt(bank: Any, ids: list[str], twists: ConceptTwists = ConceptTwists()) -> str:  # noqa: B008
    payload = basket_payload(bank, ids, twists=twists)
    assert payload is not None
    names = [display_name(bank, i) for i in known_forbidden(bank, twists.forbidden_ids)]
    return build_concepts_prompt(payload, mode=TOASTIE, forbidden_names=names)


def _t_answer(
    bank: Any,
    ids: list[str] | None = None,
    twists: ConceptTwists = ConceptTwists(),  # noqa: B008
) -> dict[str, Any]:
    value = canned_cookout_concepts(_t_prompt(bank, ids or T_IDS, twists))
    assert value is not None
    return value


def _t_parse(
    bank: Any,
    obj: dict[str, Any],
    ids: list[str] | None = None,
    twists: ConceptTwists = ConceptTwists(),  # noqa: B008
    bread_id: str | None = None,
) -> Any:
    return parse_concepts(
        json.dumps(obj),
        bank=bank,
        picked_ids=ids or T_IDS,
        mode=TOASTIE,
        bread_id=bread_id,
        twists=twists,
    )


def _set_used(concept: dict[str, Any], ids: list[str], used: list[str]) -> None:
    """Make `concept` use exactly `used` (bread included by the caller) and omit the rest."""
    concept["pickedIngredientIds"] = list(used)
    concept["omitted"] = [{"id": i, "reason": "Saved for later."} for i in ids if i not in used]


class TestClassicIsByteIdentical:
    """The golden file was recorded from the code at e17ed304 (the chef fix, before modes)."""

    VARIANTS: dict[str, tuple[str, ConceptTwists]] = {
        "plain": ("basket10", ConceptTwists()),
        "wildcard": ("basket11", ConceptTwists(wildcard_id=GOLDEN["basket11"][10])),
        "styled": ("basket10", ConceptTwists(style="posh-tasting")),
        "no-oven-stars": (
            "basket10",
            ConceptTwists(challenge="no-oven", star_ids=frozenset(GOLDEN["basket10"][:2])),
        ),
        "thirty": ("basket10", ConceptTwists(challenge="thirty-minutes")),
        "forbidden": ("basket10", ConceptTwists(forbidden_ids=frozenset({"milk"}))),
    }

    @pytest.mark.parametrize("name", sorted(VARIANTS))
    def test_the_concepts_prompt(self, real_bank: Any, name: str) -> None:
        key, twists = self.VARIANTS[name]
        payload = basket_payload(real_bank, GOLDEN[key], twists=twists)
        assert payload is not None
        names = [
            display_name(real_bank, i) for i in known_forbidden(real_bank, twists.forbidden_ids)
        ]
        prompt = build_concepts_prompt(payload, mode=CLASSIC, forbidden_names=names)
        assert prompt == GOLDEN["prompts"][f"concepts:{name}"]

    @pytest.mark.parametrize("name", ["plain", "styled", "challenge", "forbidden"])
    def test_the_recipe_prompt_and_manifest(self, real_bank: Any, name: str) -> None:
        basket10 = GOLDEN["basket10"]
        rt = {
            "plain": RecipeTwists(),
            "styled": RecipeTwists(style="posh-tasting", star_ids=frozenset(basket10[:2])),
            "challenge": RecipeTwists(challenge="thirty-minutes"),
            "forbidden": RecipeTwists(forbidden_ids=frozenset({"milk"})),
        }[name]
        concept = GOLDEN["concept"]
        manifest = concept_manifest(concept, real_bank, forbidden_ids=rt.forbidden_ids)
        assert json.dumps(manifest, sort_keys=True) == GOLDEN["prompts"][f"manifest:{name}"]
        assert (
            build_recipe_prompt(concept, manifest, mode=CLASSIC, twists=rt)
            == GOLDEN["prompts"][f"recipe:{name}"]
        )

    def test_the_picture_prompts(self, real_bank: Any) -> None:
        names = [real_bank.ingredient(i).name for i in GOLDEN["basket10"][:4]]
        assert build_image_prompt("Golden Steak Toast", names) == GOLDEN["prompts"]["image:plain"]
        assert (
            build_image_prompt("Golden Steak Toast", names, style="posh-tasting")
            == GOLDEN["prompts"]["image:styled"]
        )
        # stating the Classic mode changes nothing either
        assert (
            build_image_prompt("Golden Steak Toast", names, mode=CLASSIC)
            == GOLDEN["prompts"]["image:plain"]
        )


class TestToastieConceptsPrompt:
    def test_it_names_the_bread_by_name_and_id_and_the_rules(self, real_bank: Any) -> None:
        prompt = _t_prompt(real_bank, T_IDS)
        assert "a TOASTED SANDWICH: one bread and 7 fillings" in prompt
        assert 'the chosen bread (Sliced white bread, id "sliced-white-bread")' in prompt
        assert "Use the bread in all three ideas and name it" in prompt
        assert "at least 5 of the 7 fillings" in prompt
        assert "at least one idea must use 6 or more" in prompt
        assert "between them the three ideas must use all 7" in prompt
        assert "Butter is always allowed" in prompt
        assert "at most TWO of: plain flour, cooking oil, granulated sugar, milk" in prompt
        for build in TOASTIE.chef.builds:
            assert f"{build.id} ({build.label}: {build.prompt_phrase})" in prompt
        # the Classic prompt's measured steering is carried over (found by the real-run trial)
        assert "never name one: not what a picked sauce or spread is made of" in prompt
        assert "not another dish you compare the sandwich to" in prompt
        assert 'an idea that uses every filling has "omitted": []' in prompt
        assert "must be exactly 7." in prompt
        # not the Classic opening, rules or schema
        assert "THREE distinct recipe concepts" not in prompt
        assert '"dishType"' not in prompt
        assert '"build": one of "pressed"' in prompt

    def test_the_numbers_follow_the_wildcard_basket(self, real_bank: Any) -> None:
        prompt = _t_prompt(real_bank, [*T_IDS, T_WILDCARD], ConceptTwists(wildcard_id=T_WILDCARD))
        assert "one bread and 8 fillings" in prompt
        assert "at least 6 of the 8 fillings" in prompt
        assert "at least one idea must use 7 or more" in prompt
        assert "must use all 8" in prompt
        assert "WILDCARD ingredient (id avocado)" in prompt

    def test_the_basket_marker_line_carries_the_food_only_payload(self, real_bank: Any) -> None:
        prompt = _t_prompt(real_bank, T_IDS)
        line = next(x for x in prompt.splitlines() if x.startswith(BASKET_MARKER))
        payload = json.loads(line[len(BASKET_MARKER) :])
        assert [i["id"] for i in payload["ingredients"]] == sorted(T_IDS)
        assert "twists" not in payload

    def test_a_style_line_follows_the_style_and_a_challenge_adds_its_note(
        self, real_bank: Any
    ) -> None:
        plain = _t_prompt(real_bank, T_IDS)
        assert "STYLE:" not in plain
        assert "still a closed toasted sandwich" not in plain
        styled = _t_prompt(real_bank, T_IDS, ConceptTwists(style="posh-tasting"))
        style_line = next(x for x in styled.splitlines() if x.startswith("STYLE:"))
        assert style_line.endswith(
            "The style flavours the toasted sandwiches; every idea is still a closed toasted "
            "sandwich."
        )
        challenged = _t_prompt(real_bank, T_IDS, ConceptTwists(challenge="no-oven"))
        assert '"challengeNote": string' in challenged

    def test_a_basket_without_exactly_one_bread_cannot_be_prompted(self, real_bank: Any) -> None:
        payload = basket_payload(real_bank, T_FILLINGS + ["tomato-ketchup"])
        assert payload is not None
        with pytest.raises(ValueError, match="exactly one"):
            build_concepts_prompt(payload, mode=TOASTIE)


class TestToastieParseConcepts:
    def test_the_canned_answer_is_accepted_and_stores_the_dish_fields(self, real_bank: Any) -> None:
        parsed = _t_parse(real_bank, _t_answer(real_bank))
        assert parsed.violations == ()
        assert parsed.signals == ()
        concepts = parsed.value["concepts"]
        assert [c["build"] for c in concepts] == ["pressed", "skillet", "grill-toasted"]
        assert {c["dishType"] for c in concepts} == {"sandwich"}
        assert [c["technique"] for c in concepts] == ["grill", "pan-fry", "grill"]
        assert all(T_BREAD in c["pickedIngredientIds"] for c in concepts)

    def test_dish_type_and_technique_the_model_sent_are_ignored(self, real_bank: Any) -> None:
        obj = _t_answer(real_bank)
        for concept in obj["concepts"]:
            concept["dishType"] = "volcano"
            concept["technique"] = "teleport"
        parsed = _t_parse(real_bank, obj)
        assert parsed.violations == ()
        assert {c["dishType"] for c in parsed.value["concepts"]} == {"sandwich"}

    def test_a_wildcard_basket_with_eight_fillings(self, real_bank: Any) -> None:
        ids = [*T_IDS, T_WILDCARD]
        twists = ConceptTwists(wildcard_id=T_WILDCARD)
        parsed = _t_parse(real_bank, _t_answer(real_bank, ids, twists), ids, twists)
        assert parsed.violations == ()

    def test_the_bread_id_may_be_given_or_derived(self, real_bank: Any) -> None:
        obj = _t_answer(real_bank)
        assert _t_parse(real_bank, obj, bread_id=T_BREAD).value is not None
        assert _t_parse(real_bank, obj, bread_id=None).value is not None

    # -- rejections

    def _violations(
        self, bank: Any, edit: Callable[[list[dict[str, Any]]], None], **kw: Any
    ) -> str:
        obj = _t_answer(bank, kw.get("ids"), kw.get("twists", ConceptTwists()))
        edit(obj["concepts"])
        parsed = _t_parse(bank, obj, kw.get("ids"), kw.get("twists", ConceptTwists()))
        assert parsed.value is None
        return " | ".join(parsed.violations)

    def test_a_concept_without_the_bread(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            _set_used(c[1], T_IDS, T_FILLINGS)

        assert "concept b leaves out the bread 'sliced-white-bread'" in self._violations(
            real_bank, edit
        )

    def test_a_different_bread_is_not_in_the_basket(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["pickedIngredientIds"][c[0]["pickedIngredientIds"].index(T_BREAD)] = (
                "ciabatta-roll"
            )

        assert "'ciabatta-roll', which is not one of the 8 picks" in self._violations(
            real_bank, edit
        )

    def test_the_bread_may_not_be_omitted(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[2]["omitted"].append({"id": T_BREAD, "reason": "Not needed."})

        assert "omitted must be exactly" in self._violations(real_bank, edit)

    def test_each_idea_needs_f_minus_two_fillings(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            _set_used(c[2], T_IDS, [T_BREAD, *T_FILLINGS[:4]])

        assert "concept c uses only 4 fillings; each idea needs 5+ of the 7" in self._violations(
            real_bank, edit
        )

    def test_one_idea_must_use_f_minus_one(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            _set_used(c[0], T_IDS, [T_BREAD, *T_FILLINGS[0:5]])
            _set_used(c[1], T_IDS, [T_BREAD, *T_FILLINGS[2:7]])
            _set_used(c[2], T_IDS, [T_BREAD, *T_FILLINGS[1:6]])

        assert "at least one idea must use 6+ of the 7 fillings" in self._violations(
            real_bank, edit
        )

    def test_every_filling_must_be_used_somewhere(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            _set_used(c[0], T_IDS, [T_BREAD, *T_FILLINGS[:6]])
            _set_used(c[1], T_IDS, [T_BREAD, *T_FILLINGS[:6]])
            _set_used(c[2], T_IDS, [T_BREAD, *T_FILLINGS[:5]])

        assert "no concept uses these picks: wholegrain-mustard" in self._violations(
            real_bank, edit
        )

    def test_builds_must_be_known_and_different(self, real_bank: Any) -> None:
        text = self._violations(real_bank, lambda c: c[1].__setitem__("build", c[0]["build"]))
        assert "concepts a and b share the build 'pressed'" in text
        text = self._violations(real_bank, lambda c: c[1].__setitem__("build", "microwaved"))
        assert "concept b build must be one of pressed, skillet" in text
        text = self._violations(real_bank, lambda c: c[1].pop("build"))
        assert "concept b build must be one of" in text

    def test_the_oven_build_is_refused_under_no_oven(self, real_bank: Any) -> None:
        twists = ConceptTwists(challenge="no-oven")
        text = self._violations(
            real_bank, lambda c: c[2].__setitem__("build", "oven-baked"), twists=twists
        )
        assert "build 'oven-baked' needs the oven (no oven)" in text
        # outside the challenge the same build is fine
        obj = _t_answer(real_bank)
        obj["concepts"][2]["build"] = "oven-baked"
        assert _t_parse(real_bank, obj).value is not None

    def test_a_third_capped_staple_breaks_the_cap_of_two(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[1]["stapleIds"] = ["butter", "plain-flour", "cooking-oil", "milk"]

        assert "concept b uses more than 2 extra staples" in self._violations(real_bank, edit)

    def test_two_capped_staples_and_butter_are_fine(self, real_bank: Any) -> None:
        obj = _t_answer(real_bank)
        obj["concepts"][1]["stapleIds"] = ["butter", "plain-flour", "milk", "salt"]
        assert _t_parse(real_bank, obj).value is not None

    def test_a_genuine_unpicked_food_in_prose(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["description"] += " Served with a slice of mango."

        assert "mentions 'Mango'" in self._violations(real_bank, edit)

    def test_a_swapped_out_bread_may_not_be_named(self, real_bank: Any) -> None:
        twists = ConceptTwists(forbidden_ids=frozenset({"sourdough-loaf"}))

        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["description"] += " Not the usual sourdough loaf."

        assert "removed and may not appear anywhere" in self._violations(
            real_bank, edit, twists=twists
        )

    # -- acceptance regressions: correct answers must never be rejected (09c §3.4, §7)

    def _accept(
        self,
        bank: Any,
        *,
        ids: list[str] | None = None,
        twists: ConceptTwists = ConceptTwists(),  # noqa: B008
        edit: Callable[[list[dict[str, Any]]], None],
    ) -> Any:
        obj = _t_answer(bank, ids, twists)
        edit(obj["concepts"])
        parsed = _t_parse(bank, obj, ids, twists)
        assert parsed.violations == ()
        assert parsed.value is not None
        return parsed

    @pytest.mark.parametrize(
        ("bread", "title"),
        [
            ("sliced-white-bread", "White bread toastie"),
            ("ciabatta-roll", "Ciabatta toastie"),
            ("brioche-burger-bun", "Brioche toastie"),
        ],
    )
    def test_a_short_form_of_the_bread_name_is_accepted(
        self, real_bank: Any, bread: str, title: str
    ) -> None:
        ids = [bread, *T_FILLINGS]

        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["title"] = title

        self._accept(real_bank, ids=ids, edit=edit)

    def test_a_description_that_never_names_the_bread_is_accepted(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["title"] = "Melting Cheddar Toastie"
            c[0]["description"] = (
                "A golden, melting toastie for two with mature cheddar, red leicester, "
                "cooked ham, streaky bacon and tomato, finished with a little butter."
            )

        self._accept(real_bank, edit=edit)

    def test_never_an_open_sandwich_is_accepted_with_a_signal(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["description"] = "A closed sliced white bread toastie, never an open sandwich."

        parsed = self._accept(real_bank, edit=edit)
        assert parsed.signals == ("concept a: 'open sandwich'",)

    def test_a_bruschetta_inspired_filling_is_accepted_with_a_signal(self, real_bank: Any) -> None:
        ids = ["ciabatta-roll", *T_FILLINGS]

        def edit(c: list[dict[str, Any]]) -> None:
            c[1]["description"] = (
                "A closed ciabatta roll toastie with bruschetta-inspired tomato filling."
            )

        parsed = self._accept(real_bank, ids=ids, edit=edit)
        assert parsed.signals == ("concept b: 'bruschetta'",)

    def test_butter_may_be_named_without_being_declared(self, real_bank: Any) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["stapleIds"] = []
            c[0]["description"] += " Everything is fried in butter."

        self._accept(real_bank, edit=edit)

    def test_a_starred_bread_needs_no_name_in_the_prose(self, real_bank: Any) -> None:
        twists = ConceptTwists(star_ids=frozenset({T_BREAD, "tomato"}))

        def edit(c: list[dict[str, Any]]) -> None:
            for concept in c:
                concept["title"] = f"Hero {concept['build']} tomato toastie"
                concept["description"] = (
                    "A crisp toastie for two with tomato and red leicester, finished with butter."
                )

        self._accept(real_bank, twists=twists, edit=edit)

    def test_a_missing_star_is_still_a_violation(self, real_bank: Any) -> None:
        twists = ConceptTwists(star_ids=frozenset({"spinach"}))
        obj = _t_answer(real_bank, twists=twists)
        _set_used(obj["concepts"][2], T_IDS, [T_BREAD, *T_FILLINGS[:5]])
        parsed = _t_parse(real_bank, obj, twists=twists)
        assert any("must use star 'spinach'" in v for v in parsed.violations)

    def test_signals_never_stop_an_answer_or_start_a_repair(self, real_bank: Any) -> None:
        obj = _t_answer(real_bank)
        for concept in obj["concepts"]:
            concept["description"] = (
                "A closed toastie for two with red leicester, never an open "
                "sandwich or an open-faced bake, finished with butter."
            )
        parsed = _t_parse(real_bank, obj)
        assert parsed.value is not None
        assert parsed.violations == ()
        assert len(parsed.signals) == 6  # 'open sandwich' and 'open-faced' in each of the three

    def test_classic_never_reports_signals_or_a_build(self) -> None:
        parsed = _parse(canned_concepts_obj())
        assert parsed.signals == ()
        assert all("build" not in c for c in parsed.value["concepts"])

    def test_the_fake_chef_answers_every_random_basket_acceptably(self, real_bank: Any) -> None:
        import random

        rng = random.Random(7)
        accepted = 0
        for _ in range(40):

            def pick(kind: str) -> str:
                return rng.choice(TOASTIE.kinds[kind].candidates).id

            ids = [
                pick("bread"),
                *(pick("cheese") for _ in range(2)),
                *(pick("main") for _ in range(2)),
                *(pick("produce") for _ in range(2)),
                pick("finish"),
            ]
            if len(set(ids)) != 8:
                continue
            parsed = _t_parse(real_bank, _t_answer(real_bank, ids), ids)
            assert parsed.value is not None, (ids, parsed.violations)
            accepted += 1
        assert accepted >= 30


class TestToastieRecipe:
    @staticmethod
    def _concept(bank: Any, **edit: Any) -> dict[str, Any]:
        parsed = _t_parse(bank, _t_answer(bank))
        concept = dict(parsed.value["concepts"][1])  # the skillet idea
        concept.update(edit)
        return concept

    def test_the_prompt_carries_the_build_and_butter_is_free(self, real_bank: Any) -> None:
        concept = self._concept(real_bank, stapleIds=[])
        manifest = concept_manifest(concept, real_bank, mode=TOASTIE)
        assert "butter" in [s["id"] for s in manifest["staples"]]
        prompt = build_recipe_prompt(concept, manifest, mode=TOASTIE)
        assert (
            "This is the full recipe for one toasted sandwich idea, for two people (two "
            'sandwiches). Keep the bread on the outside and make it the "Skillet-fried" way: '
            "fried in a pan under a weight, turned once. Butter is always allowed."
        ) in prompt
        assert "Water, salt, black pepper and butter are always free too." in prompt
        assert "(no plain flour, cooking oil, granulated sugar or milk unless" in prompt
        assert '"build":"skillet"' in prompt
        # Classic's manifest never lists butter unless declared
        classic = concept_manifest(concept, real_bank)
        assert "butter" not in [s["id"] for s in classic["staples"]]

    def test_butter_is_accepted_undeclared_but_only_in_this_mode(self, real_bank: Any) -> None:
        concept = self._concept(real_bank, stapleIds=[])
        manifest = concept_manifest(concept, real_bank, mode=TOASTIE)
        recipe = canned_cookout_recipe(build_recipe_prompt(concept, manifest, mode=TOASTIE))
        assert recipe is not None
        recipe["steps"][0]["text"] += " Butter the outside of every slice."
        parsed = parse_recipe(json.dumps(recipe), bank=real_bank, concept=concept, mode=TOASTIE)
        assert parsed.violations == ()
        assert parsed.value is not None
        # the same recipe is refused by Classic's rules (butter is a capped, declared staple there)
        classic = parse_recipe(json.dumps(recipe), bank=real_bank, concept=concept, mode=CLASSIC)
        assert classic.value is None

    def test_a_capped_staple_must_still_be_declared(self, real_bank: Any) -> None:
        concept = self._concept(real_bank, stapleIds=["butter"])
        manifest = concept_manifest(concept, real_bank, mode=TOASTIE)
        recipe = canned_cookout_recipe(build_recipe_prompt(concept, manifest, mode=TOASTIE))
        assert recipe is not None
        recipe["ingredients"].append({"id": "plain-flour", "quantity": "1 tbsp", "note": ""})
        parsed = parse_recipe(json.dumps(recipe), bank=real_bank, concept=concept, mode=TOASTIE)
        assert any("not in this dish's manifest" in v for v in parsed.violations)

    def test_the_fake_chef_recipe_is_accepted(self, real_bank: Any) -> None:
        concept = self._concept(real_bank)
        manifest = concept_manifest(concept, real_bank, mode=TOASTIE)
        recipe = canned_cookout_recipe(build_recipe_prompt(concept, manifest, mode=TOASTIE))
        parsed = parse_recipe(json.dumps(recipe), bank=real_bank, concept=concept, mode=TOASTIE)
        assert parsed.violations == (), parsed.violations
        assert parsed.value is not None


class TestUnknownModeAbortsWithoutWriting:
    def test_a_round_of_a_mode_this_server_lacks_is_never_touched(self, tmp_path: Path) -> None:
        store = FakeStore()
        row = store.add_round(1)
        row["mode"] = "pizza"
        row["state"] = "finished"
        store.add_recipe(1, "a")
        for client in (None, _client_unused()):
            runner = _runner(store, client, tmp_path)

            async def go(r: CmdCookoutRunner = runner) -> None:
                await r.run_concepts(1, 1)
                await r.run_recipe(1, 1, "a")

            anyio.run(go)
        assert store.finished == []
        assert store.claims == []
        assert store.rounds[1]["concepts"] == "pending"


def _client_unused() -> CmdChatClient:
    """A client that is never called (the job aborts before it would spawn): any request fails."""
    return CmdChatClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(500)), max_attempts=1
    )
