"""Cookout AI jobs (workspace 00058, spec/server-chat/09-cookout.md §3.1, §3.2, §3.4, §3.5): the
deterministic validation of concepts and recipes, the one-repair-run loop, compare-and-set
completion, restart/sweep recovery, spawn pacing and the standalone `unavailable` mode — against an
in-memory store that has exactly the Appendix A.2 signatures and a scanning bank double with the
Appendix A.1 `find_contraband_ingredients` contract (the real bank is tested by P1)."""

from __future__ import annotations

import copy
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
from wixy_server.livechat.cookout_ai import (
    BASKET_MARKER,
    CONCEPTS_CALLER,
    DISALLOWED_TOOLS,
    RECIPE_CALLER,
    CmdCookoutRunner,
    CookoutTiming,
    build_concepts_prompt,
    build_cookout_runner,
    parse_concepts,
    parse_recipe,
)
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.tests.fake_cmd import (
    FakeCmdState,
    FakeSpawnPlan,
    canned_cookout_concepts,
    create_fake_cmd_app,
)

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
    def __init__(self) -> None:
        self.rounds: dict[int, dict[str, Any]] = {}
        self.finished: list[tuple[str, int, str | None, str]] = []
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
    ) -> dict[str, Any]:
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
            "picked_ids": list(PICKED_IDS if picked is None else picked),
            "recipes": {},
        }
        self.rounds[seq] = row
        return row

    def add_recipe(self, seq: int, concept_id: str, *, run_id: str | None = None) -> None:
        self.rounds[seq]["recipes"][concept_id] = {
            "state": "pending",
            "run_id": run_id,
            "recipe_json": None,
            "error": None,
            "tries": 1,
            "deadline_at": time.time() + 900,
            "started_at": time.time(),
        }

    # -- A.2 ---------------------------------------------------------------------------------

    def get_cookout_round(self, anchor_seq: int) -> dict[str, Any] | None:
        row = self.rounds.get(anchor_seq)
        return copy.deepcopy(row) if row is not None else None

    def set_cookout_concepts_run(
        self, anchor_seq: int, run_id: str, *, expected_run_id: str | None = None
    ) -> bool:
        row = self.rounds.get(anchor_seq)
        if row is None or row["concepts"] != "pending" or row["concepts_run_id"] != expected_run_id:
            return False
        row["concepts_run_id"] = run_id
        return True

    def finish_cookout_concepts(
        self,
        anchor_seq: int,
        run_id: str | None,
        state: Literal["ready", "failed", "unavailable"],
        *,
        concepts_json: str | None = None,
        error: str | None = None,
        pictures_pending: bool = False,
    ) -> bool:
        row = self.rounds.get(anchor_seq)
        if row is None or row["concepts"] != "pending" or row["concepts_run_id"] != run_id:
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

    def cookout_pending_concepts(self) -> list[tuple[int, str | None]]:
        return [
            (s, r["concepts_run_id"]) for s, r in self.rounds.items() if r["concepts"] == "pending"
        ]

    def set_cookout_recipe_run(
        self, anchor_seq: int, concept_id: str, run_id: str, *, expected_run_id: str | None = None
    ) -> bool:
        slot = self.rounds.get(anchor_seq, {}).get("recipes", {}).get(concept_id)
        if slot is None or slot["state"] != "pending" or slot["run_id"] != expected_run_id:
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
        recipe_json: str | None = None,
        error: str | None = None,
    ) -> bool:
        slot = self.rounds.get(anchor_seq, {}).get("recipes", {}).get(concept_id)
        if slot is None or slot["state"] != "pending" or slot["run_id"] != run_id:
            return False
        slot["state"] = state
        slot["recipe_json"] = recipe_json
        slot["error"] = error
        self.finished.append(("recipe:" + concept_id, anchor_seq, run_id, state))
        return True

    def cookout_pending_recipes(self) -> list[tuple[int, str, str | None]]:
        return [
            (s, c, slot["run_id"])
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
    from wixy_server.livechat.cookout_ai import basket_payload

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

    def test_an_omitted_reason_may_not_name_a_non_pick(self) -> None:
        def edit(c: list[dict[str, Any]]) -> None:
            c[0]["omitted"][0]["reason"] = "Mango would be sweeter."

        parsed = self._mutated(edit)
        assert any("omitted reason mentions 'Mango'" in v for v in parsed.violations)

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
        from wixy_server.livechat.cookout_ai import build_recipe_prompt, concept_manifest
        from wixy_server.tests.fake_cmd import canned_cookout_recipe

        concept = _concept()
        prompt = build_recipe_prompt(concept, concept_manifest(concept, ScanBank()))
        recipe = canned_cookout_recipe(prompt)
        assert recipe is not None
        assert parse_recipe(json.dumps(recipe), bank=ScanBank(), concept=concept).value is not None


# -- the runner: Stage 1 ----------------------------------------------------------------------


def _drive_concepts(
    runner: CmdCookoutRunner, seq: int = 1, *, extra: Callable[[], Any] | None = None
) -> None:
    async def go() -> None:
        async with anyio.create_task_group() as tg:
            tg.start_soon(runner.run_concepts, seq)
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

    def test_a_second_failure_ends_the_job_failed(self, tmp_path: Path) -> None:
        bad = json.dumps({"concepts": []})
        state = FakeCmdState(cookout_response_text=bad)
        store = FakeStore()
        store.add_round()
        _drive_concepts(_runner(store, _client(state), tmp_path))
        assert store.rounds[1]["concepts"] == "failed"
        assert store.rounds[1]["concepts_error"]
        assert len(state.chat_spawn_runs) == 2  # the run and ONE repair, never a third

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
            await anyio.sleep(0.1)
            store.rounds[1]["concepts_run_id"] = "a-newer-run"

        _drive_concepts(_runner(store, _client(state), tmp_path), extra=retry_meanwhile)
        assert store.rounds[1]["concepts"] == "pending"
        assert store.rounds[1]["concepts_json"] is None
        (run,) = state.chat_spawn_runs.values()
        assert run.cancelled

    def test_a_late_completion_after_a_new_epoch_is_not_stored(self, tmp_path: Path) -> None:
        store = FakeStore()
        store.add_round(run_id="old-run")
        assert store.finish_cookout_concepts(1, "old-run", "failed", error="x")
        store.rounds[1]["concepts"] = "pending"
        store.rounds[1]["concepts_run_id"] = None
        assert not store.finish_cookout_concepts(
            1, "old-run", "ready", concepts_json=canned_concepts_text()
        )

    def test_a_deleted_round_costs_nothing(self, tmp_path: Path) -> None:
        state = FakeCmdState()
        store = FakeStore()
        runner = _runner(store, _client(state), tmp_path)
        anyio.run(runner.run_concepts, 99)
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
                    tg.start_soon(runner.run_concepts, seq)

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
        anyio.run(runner.run_concepts, 1)
        assert store.rounds[1]["concepts"] == "unavailable"

    def test_a_bank_request_without_cmd_ends_unavailable(self, tmp_path: Path) -> None:
        store = FakeStore()
        store.add_round(concepts="ready", concepts_json=canned_concepts_text())
        store.add_recipe(1, "a")
        runner = _runner(store, None, tmp_path)
        anyio.run(runner.run_recipe, 1, "a")
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


def _drive_recipe(runner: CmdCookoutRunner, seq: int = 1, concept_id: str = "a") -> None:
    anyio.run(runner.run_recipe, seq, concept_id)


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
        assert len(state.chat_spawn_runs) == 2

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
                tg.start_soon(runner.run_recipe, 1, "a")
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
            runner.start_concepts(background, 1)
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
            runner.start_recipe(background, 1, "a")

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

    def test_m1_a_rejected_resumed_run_is_failed_not_repaired_again(self, tmp_path: Path) -> None:
        bad = json.dumps({"concepts": []})
        state = FakeCmdState(chat_spawn_plans=[FakeSpawnPlan(response_text=bad)])
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
        assert len(state.chat_spawn_runs) == 1  # no second repair spawned

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
    from wixy_server.livechat.cookout_ai import basket_payload

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
            ("Peanut butter with extra butter and Beef ribeye steak.", False),
        ):
            concept["description"] = sentence
            parsed = _real_parse(real_bank, obj)
            banned = [v for v in parsed.violations if "concept a description" in v]
            assert (banned == []) is ok, (sentence, parsed.violations)

    def test_coconut_milk_is_fine_but_an_extra_bare_milk_is_not(self, real_bank: Any) -> None:
        obj = _real_concepts(real_bank)
        concept = obj["concepts"][0]
        assert "coconut-milk" in concept["pickedIngredientIds"]
        for sentence, ok in (
            ("Coconut milk curry with Beef ribeye steak and salt.", True),
            ("Coconut milk plus milk with Beef ribeye steak.", False),
        ):
            concept["description"] = sentence
            parsed = _real_parse(real_bank, obj)
            bad = [v for v in parsed.violations if "concept a description" in v]
            assert (bad == []) is ok, (sentence, parsed.violations)

    def test_a_fifth_undeclared_staple_in_prose_is_rejected(self, real_bank: Any) -> None:
        four = ["butter", "plain-flour", "cooking-oil", "granulated-sugar"]
        parsed = self._with_description(real_bank, "Finished with a splash of milk.", staples=four)
        assert any("'Milk'" in v for v in parsed.violations)

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
