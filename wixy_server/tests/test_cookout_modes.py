"""Cookout game modes (spec/server-chat/09c-cookout-modes.md §1, §2, §8.1): the committed mode file
loads and passes the offline validator, the pools measure what the spec states, classification is
exact, schedules honour starters, and the strict loader rejects each class of bad input. Mutations
start from the committed file."""

import copy
import importlib.util
import json
import random
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from wixy_server.livechat import cookout_ai
from wixy_server.livechat.cookout_bank import (
    NON_SEASONING_STAPLES,
    ROLES,
    STAPLE_IDS,
    CookoutBank,
    load_cookout_bank,
)
from wixy_server.livechat.cookout_modes import (
    CLASSIC_STAPLES_CAP,
    CookoutMode,
    CookoutModes,
    CookoutModesError,
    default_modes,
    load_cookout_modes,
    parse_cookout_modes,
)

REPO = Path(__file__).resolve().parents[2]
VALIDATOR = REPO / "tooling" / "cookout" / "validate_modes.py"
MODES_FILE = REPO / "wixy_server" / "livechat" / "cookout_modes.json"


@pytest.fixture(scope="module")
def bank() -> CookoutBank:
    return load_cookout_bank()


@pytest.fixture(scope="module")
def modes(bank: CookoutBank) -> CookoutModes:
    return load_cookout_modes(bank)


@pytest.fixture(scope="module")
def toastie(modes: CookoutModes) -> CookoutMode:
    found = modes.mode("toastie")
    assert found is not None
    return found


@pytest.fixture(scope="module")
def raw() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(MODES_FILE.read_text(encoding="utf-8"))
    return data


def _validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cookout_validate_modes", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _toastie_raw(data: dict[str, Any]) -> dict[str, Any]:
    entry: dict[str, Any] = data["modes"][1]
    return entry


def _mutated(raw: dict[str, Any], mutate: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    clone = copy.deepcopy(raw)
    mutate(_toastie_raw(clone))
    return clone


# -- the committed file --------------------------------------------------------------------------


def test_committed_modes_pass_the_validator() -> None:
    assert _validator().validate(rounds=20) == []


def test_modes_load_classic_first_and_default(modes: CookoutModes) -> None:
    assert [m.id for m in modes.modes] == ["classic", "toastie"]
    assert modes.default.id == "classic"
    assert modes.mode("pizza") is None
    assert modes.mode("toastie") is not None


def test_identity_and_plan_numbers(modes: CookoutModes, toastie: CookoutMode) -> None:
    assert (toastie.label, toastie.emoji) == ("Toasted sandwich", "🥪")
    assert toastie.turns == 8 and toastie.picks_per_player == 4
    assert toastie.basket_sizes == (8, 9)
    assert len(toastie.intro) == 3 and "{starter}" in toastie.intro[1]
    classic = modes.default
    assert classic.turns == 10 and classic.picks_per_player == 5
    assert classic.basket_sizes == (10, 11)
    assert classic.fridge_kinds is None and toastie.fridge_kinds == frozenset({"bread"})
    assert len(classic.twists) == 12 == len(toastie.twists)


def test_prompts_fit_the_banner(toastie: CookoutMode) -> None:
    assert all(len(k.prompt) <= 22 for k in toastie.kinds.values())
    assert [k.prompt for k in toastie.kinds.values()] == [
        "pick the bread",
        "add a cheese",
        "add a main filling",
        "add veg or fruit",
        "add a finishing touch",
    ]


# -- pools (measured on the committed bank, 2026-10-29) ------------------------------------------


def test_bread_pool(toastie: CookoutMode) -> None:
    breads = toastie.kinds["bread"].candidates
    assert len(breads) == 52
    assert {b.category for b in breads} == {"grains-bakery"}
    assert len({b.family for b in breads}) == 14
    assert sum(1 for b in breads if b.rarity == "everyday") == 24
    assert len({b.family for b in breads if b.rarity == "everyday"}) == 13
    assert sum(1 for b in breads if b.rarity == "exotic") == 3
    assert not {b.id for b in breads} & set(STAPLE_IDS)
    assert toastie.kinds["bread"].facet == "family"
    assert toastie.kinds["bread"].chaos is False


def test_other_pool_sizes(toastie: CookoutMode) -> None:
    def stats(kind: str) -> tuple[int, int, int]:
        items = toastie.kinds[kind].candidates
        return (len(items), len({i.category for i in items}), len({i.family for i in items}))

    cheese = toastie.kinds["cheese"].candidates
    assert len(cheese) == 176 and len({c.family for c in cheese}) == 19
    assert len({c.family for c in cheese if c.rarity == "everyday"}) == 16
    assert sum(1 for c in cheese if c.rarity == "exotic") == 55
    assert stats("main")[:2] == (864, 6)
    assert stats("produce")[:2] == (605, 7)
    assert stats("finish")[:2] == (1060, 8)


def test_candidates_are_sorted_by_id(toastie: CookoutMode, modes: CookoutModes) -> None:
    for mode in modes.modes:
        for kind in mode.kinds.values():
            ids = [i.id for i in kind.candidates]
            assert ids == sorted(ids)


# -- classification ------------------------------------------------------------------------------


def test_every_ingredient_lands_in_at_most_one_kind(
    bank: CookoutBank, toastie: CookoutMode
) -> None:
    seen: dict[str, str] = {}
    for kind in toastie.kinds.values():
        for item in kind.candidates:
            assert item.id not in seen, f"{item.id} is in {seen[item.id]} and {kind.id}"
            seen[item.id] = kind.id
            assert toastie.kind_of(item.id) == kind.id
    classified = {i.id for i in bank.ingredients if toastie.kind_of(i.id) is not None}
    assert classified == set(seen)


def test_no_staple_is_ever_offered(toastie: CookoutMode) -> None:
    for staple in STAPLE_IDS:
        assert toastie.kind_of(staple) is None


def test_exclusions_hold(bank: CookoutBank, toastie: CookoutMode, raw: dict[str, Any]) -> None:
    rules = _toastie_raw(raw)["fillingRules"]
    bread_ids = {b.id for b in toastie.kinds["bread"].candidates}
    include = set(rules["includeIds"])
    for item in bank.ingredients:
        if item.id in bread_ids:
            assert toastie.kind_of(item.id) == "bread"
            continue
        kind = toastie.kind_of(item.id)
        banned = (
            item.category in rules["excludeCategories"]
            or item.family in rules["excludeFamilies"].get(item.category, [])
            or [item.role, item.category] in rules["excludeRoleCategories"]
            or item.id in rules["excludeIds"]
        ) and item.id not in include
        if banned:
            assert kind is None, f"{item.id} should be excluded"
        else:
            assert kind in {"cheese", "main", "produce", "finish"}, item.id
    assert toastie.kind_of("dulce-de-leche") is not None
    assert toastie.kind_of("garlic-butter") is not None
    assert toastie.kind_of("sourdough-loaf") == "bread"
    assert toastie.kind_of("dried-chickpeas") is None
    assert toastie.kind_of("cooking-oil") is None
    assert toastie.kind_of("no-such-food") is None


def test_no_bread_in_a_filling_kind(toastie: CookoutMode) -> None:
    bread_ids = {b.id for b in toastie.kinds["bread"].candidates}
    for name in ("cheese", "main", "produce", "finish"):
        assert not bread_ids & {i.id for i in toastie.kinds[name].candidates}
    assert not bread_ids & {i.id for i in toastie.filling_candidates()}


def test_cheese_kind_is_dairy_cheese_families(toastie: CookoutMode) -> None:
    assert {c.category for c in toastie.kinds["cheese"].candidates} == {"dairy-eggs"}
    assert all(i.role in ("protein", "base") for i in toastie.kinds["main"].candidates)
    assert all(i.role == "produce" for i in toastie.kinds["produce"].candidates)
    assert all(i.role == "accent" for i in toastie.kinds["finish"].candidates)


def test_filling_candidates_union(toastie: CookoutMode) -> None:
    union = toastie.filling_candidates()
    expected = {
        i.id for n in ("cheese", "main", "produce", "finish") for i in toastie.kinds[n].candidates
    }
    assert {i.id for i in union} == expected
    assert [i.id for i in union] == sorted(i.id for i in union)


def test_classic_kinds_are_the_bank_roles(bank: CookoutBank, modes: CookoutModes) -> None:
    classic = modes.default
    assert list(classic.kinds) == list(ROLES)
    for role in ROLES:
        kind = classic.kinds[role]
        assert kind.facet == "category" and kind.chaos is True
        assert {i.id for i in kind.candidates} == {i.id for i in bank.by_role(role)}
    for item in bank.ingredients:
        assert classic.kind_of(item.id) == item.role
    assert len(classic.filling_candidates()) == len(bank.ingredients)


# -- staples, chef and picture data --------------------------------------------------------------


def test_staple_rules(modes: CookoutModes, toastie: CookoutMode) -> None:
    assert toastie.staples.free == frozenset({"water", "salt", "black-pepper", "butter"})
    assert toastie.staples.capped == frozenset(
        {"plain-flour", "cooking-oil", "granulated-sugar", "milk"}
    )
    assert toastie.staples.cap == 2
    classic = modes.default.staples
    assert classic.cap == CLASSIC_STAPLES_CAP == cookout_ai.MAX_EXTRA_STAPLES
    assert classic.free == frozenset({"water", "salt", "black-pepper"})
    assert classic.capped == NON_SEASONING_STAPLES


def test_chef_format(modes: CookoutModes, toastie: CookoutMode) -> None:
    chef = toastie.chef
    assert chef.format == "single-dish" and chef.anchor_kind == "bread"
    assert (chef.each_missing_max, chef.best_missing_max) == (2, 1)
    assert chef.dish_noun == "toasted sandwich"
    assert [b.id for b in chef.builds] == [
        "pressed", "skillet", "grill-toasted", "oven-baked", "dipped", "crisp-crusted", "jaffle"
    ]  # fmt: skip
    assert {b.id for b in chef.builds if b.uses_oven} == {"oven-baked"}
    assert all(b.technique in cookout_ai.TECHNIQUES for b in chef.builds)
    assert "open sandwich" in chef.review_dish_words and "wrap" in chef.review_dish_words
    assert chef.concept_text is not None and "{build_list}" in chef.concept_text
    assert chef.recipe_text is not None and "{build_label}" in chef.recipe_text
    classic = modes.default
    assert classic.chef.format == "classic" and classic.chef.builds == ()
    assert classic.picture.format == "classic" and classic.picture.template is None
    assert toastie.picture.template is not None and "{fillings}" in toastie.picture.template


def test_mode_text_names_no_bank_food(bank: CookoutBank, toastie: CookoutMode) -> None:
    bread_ids = {b.id for b in toastie.kinds["bread"].candidates}
    staples = set(toastie.staples.free | toastie.staples.capped)
    chef, picture = toastie.chef, toastie.picture
    texts = [
        chef.concept_text, chef.recipe_text, chef.style_line,
        picture.template, picture.default_presentation,
        *(b.prompt_phrase for b in chef.builds),
        *(b.picture_phrase for b in chef.builds),
    ]  # fmt: skip
    for text in texts:
        assert text
        assert (
            bank.find_contraband_ingredients(
                text, allowed_ingredient_ids=bread_ids, allowed_staple_ids=staples
            )
            == []
        ), text


def test_contraband_scan_would_catch_a_planted_food(
    bank: CookoutBank, toastie: CookoutMode
) -> None:
    found = bank.find_contraband_ingredients(
        "Golden toast with mango chutney",
        allowed_ingredient_ids=set(),
        allowed_staple_ids=set(),
    )
    assert found  # the scan the test above relies on does discriminate


# -- schedules (§2.1, §2.5) ----------------------------------------------------------------------


def _pairs_ok(schedule: tuple[str, ...]) -> None:
    assert len(schedule) == 8
    assert schedule[0] == "bread" and schedule[-1] == "finish"
    assert sorted(schedule[1:7]) == ["cheese", "cheese", "main", "main", "produce", "produce"]
    for first in (1, 3, 5):
        assert schedule[first] == schedule[first + 1]


def test_default_schedule_shape(toastie: CookoutMode) -> None:
    for seed in range(200):
        _pairs_ok(toastie.build_schedule(random.Random(seed)))


def test_schedule_shuffles_pairs(toastie: CookoutMode) -> None:
    orders = {toastie.build_schedule(random.Random(s))[1:7:2] for s in range(120)}
    assert len(orders) == 6  # all 3! orders occur


def test_each_player_gets_each_pair_kind_once(toastie: CookoutMode) -> None:
    for seed in range(50):
        schedule = toastie.build_schedule(random.Random(seed))
        one = [toastie.kind_for_turn(schedule, t) for t in (1, 3, 5, 7)]
        two = [toastie.kind_for_turn(schedule, t) for t in (2, 4, 6, 8)]
        assert sorted(one[1:]) == ["cheese", "main", "produce"]
        assert sorted(two[:3]) == ["cheese", "main", "produce"]
        assert one[0] == "bread" and two[3] == "finish"


def test_turn_one_bread_starter(toastie: CookoutMode) -> None:
    schedule = toastie.build_schedule(random.Random(3), starter_kinds={1: "bread"})
    _pairs_ok(schedule)


@pytest.mark.parametrize("kind", ["cheese", "main", "produce"])
def test_pair_kind_starter_moves_to_front(toastie: CookoutMode, kind: str) -> None:
    for seed in range(30):
        schedule = toastie.build_schedule(random.Random(seed), starter_kinds={2: kind})
        _pairs_ok(schedule)
        assert schedule[1:3] == (kind, kind)


def test_finish_starter_takes_turn_two(toastie: CookoutMode) -> None:
    for seed in range(30):
        schedule = toastie.build_schedule(
            random.Random(seed), starter_kinds={1: "bread", 2: "finish"}
        )
        assert len(schedule) == 8 and schedule[:2] == ("bread", "finish")
        assert sorted(schedule[2:]) == ["cheese", "cheese", "main", "main", "produce", "produce"]
        for first in (2, 4, 6):
            assert schedule[first] == schedule[first + 1]


@pytest.mark.parametrize(
    "starters",
    [
        {1: "cheese"},  # turn 1 must be the bread
        {1: "finish"},
        {2: "bread"},  # at most one bread starter
        {3: "cheese"},  # only turns 1 and 2 can hold a starter
        {2: "pizza-sauce"},  # unknown kind
    ],
)
def test_unseatable_starters_raise(toastie: CookoutMode, starters: dict[int, str]) -> None:
    with pytest.raises(CookoutModesError):
        toastie.build_schedule(random.Random(0), starter_kinds=starters)


def test_kind_for_turn_reads_one_kind_per_turn(toastie: CookoutMode) -> None:
    schedule = ("bread", "main", "main", "produce", "produce", "cheese", "cheese", "finish")
    assert [toastie.kind_for_turn(schedule, t) for t in range(1, 9)] == list(schedule)
    for bad in (0, 9):
        with pytest.raises(CookoutModesError):
            toastie.kind_for_turn(schedule, bad)
    with pytest.raises(CookoutModesError):
        toastie.kind_for_turn(schedule[:5], 8)


def test_classic_schedule_is_the_bank_shuffle(bank: CookoutBank, modes: CookoutModes) -> None:
    classic = modes.default
    for seed in range(100):
        assert classic.build_schedule(random.Random(seed)) == bank.shuffle_role_schedule(
            random.Random(seed)
        )
    for role in ROLES:
        assert classic.build_schedule(random.Random(5), starter_kinds={1: role}) == (
            bank.shuffle_role_schedule(random.Random(5), first_role=role)
        )
    with pytest.raises(CookoutModesError):
        classic.build_schedule(random.Random(5), starter_kinds={1: "bread"})


def test_classic_kind_for_turn_is_the_paired_index(modes: CookoutModes) -> None:
    schedule = ("base", "protein", "produce", "produce", "accent")
    got = [modes.default.kind_for_turn(schedule, t) for t in range(1, 11)]
    assert got == [
        "base", "base", "protein", "protein", "produce",
        "produce", "produce", "produce", "accent", "accent",
    ]  # fmt: skip


# -- the strict loader ---------------------------------------------------------------------------


def _expect_error(raw: dict[str, Any], bank: CookoutBank, fragment: str) -> None:
    with pytest.raises(CookoutModesError, match=fragment):
        parse_cookout_modes(raw, bank)


def test_committed_dict_round_trips(raw: dict[str, Any], bank: CookoutBank) -> None:
    assert len(parse_cookout_modes(copy.deepcopy(raw), bank).modes) == 2


def _drop_kind(m: dict[str, Any]) -> None:
    del m["kinds"]["finish"]


def _bad_plan_kind(m: dict[str, Any]) -> None:
    m["plan"]["closing"] = ["garnish"]


def _odd_turns(m: dict[str, Any]) -> None:
    m["plan"]["opening"] = []


def _long_prompt(m: dict[str, Any]) -> None:
    m["kinds"]["cheese"]["prompt"] = "add a really lovely cheese"


def _bad_facet(m: dict[str, Any]) -> None:
    m["kinds"]["cheese"]["facet"] = "colour"


def _bad_twist(m: dict[str, Any]) -> None:
    m["twists"] = ["swap", "teleport"]


def _unknown_key(m: dict[str, Any]) -> None:
    m["surprise"] = True


def _unknown_kind_key(m: dict[str, Any]) -> None:
    m["kinds"]["cheese"]["colour"] = "yellow"


def _bad_bread_id(m: dict[str, Any]) -> None:
    m["kinds"]["bread"]["select"]["ids"].append("not-a-bread")


def _bad_id_shape(m: dict[str, Any]) -> None:
    m["id"] = "Toasted Sandwich"


def _bad_role(m: dict[str, Any]) -> None:
    m["kinds"]["main"]["select"]["roles"] = ["protein", "dessert"]


def _empty_select(m: dict[str, Any]) -> None:
    m["kinds"]["main"]["select"] = {}


def _bad_category(m: dict[str, Any]) -> None:
    m["fillingRules"]["excludeCategories"].append("space-food")


def _bad_exclude_id(m: dict[str, Any]) -> None:
    m["fillingRules"]["excludeIds"].append("no-such-thing")


def _kind_order_mismatch(m: dict[str, Any]) -> None:
    m["kindOrder"] = ["bread", "cheese"]


def _bad_anchor(m: dict[str, Any]) -> None:
    m["chef"]["anchorKind"] = "pizza-base"


def _bad_fridge(m: dict[str, Any]) -> None:
    m["fridgeKinds"] = ["dessert"]


def _bad_staple(m: dict[str, Any]) -> None:
    m["staples"]["capped"].append("unobtainium")


def _free_and_capped(m: dict[str, Any]) -> None:
    m["staples"]["capped"].append("butter")


def _duplicate_bread(m: dict[str, Any]) -> None:
    m["kinds"]["cheese"]["select"]["ids"] = ["sourdough-loaf"]


def _bad_chef_format(m: dict[str, Any]) -> None:
    m["chef"]["format"] = "mystery"


def _bad_plan_type(m: dict[str, Any]) -> None:
    m["plan"]["type"] = "spiral"


def _bad_intro(m: dict[str, Any]) -> None:
    m["intro"] = ["a", "b", "c", "d"]


@pytest.mark.parametrize(
    ("mutate", "fragment"),
    [
        (_drop_kind, "kindOrder"),
        (_bad_plan_kind, "unknown kind"),
        (_odd_turns, "must be even"),
        (_long_prompt, "longer than 22"),
        (_bad_facet, "facet"),
        (_bad_twist, "unknown twists"),
        (_unknown_key, "unknown keys"),
        (_unknown_kind_key, "unknown keys"),
        (_bad_bread_id, "unknown ingredient"),
        (_bad_id_shape, "kebab-case"),
        (_bad_role, "unknown roles"),
        (_empty_select, "selects nothing"),
        (_bad_category, "unknown categories"),
        (_bad_exclude_id, "unknown ingredient"),
        (_kind_order_mismatch, "kindOrder"),
        (_bad_anchor, "anchorKind"),
        (_bad_fridge, "fridgeKinds"),
        (_bad_staple, "unknown staple"),
        (_free_and_capped, "both free and capped"),
        (_duplicate_bread, "listed by both"),
        (_bad_chef_format, "format"),
        (_bad_plan_type, "plan.type"),
        (_bad_intro, "at most 3"),
    ],
)
def test_loader_rejects(
    raw: dict[str, Any],
    bank: CookoutBank,
    mutate: Callable[[dict[str, Any]], None],
    fragment: str,
) -> None:
    _expect_error(_mutated(raw, mutate), bank, fragment)


def test_loader_requires_classic_first(raw: dict[str, Any], bank: CookoutBank) -> None:
    swapped = copy.deepcopy(raw)
    swapped["modes"].reverse()
    _expect_error(swapped, bank, "first mode must be the Classic")
    _expect_error({"version": 1, "modes": []}, bank, "first mode must be the Classic")


def test_loader_rejects_duplicate_ids_and_bad_envelope(
    raw: dict[str, Any], bank: CookoutBank
) -> None:
    dupe = copy.deepcopy(raw)
    dupe["modes"].append(copy.deepcopy(dupe["modes"][1]))
    _expect_error(dupe, bank, "duplicate ids")
    _expect_error({"version": 2, "modes": raw["modes"]}, bank, "version")
    _expect_error({"modes": raw["modes"]}, bank, "missing keys")
    with pytest.raises(CookoutModesError, match="must be an object"):
        parse_cookout_modes([], bank)


def test_loader_reads_a_file_and_reports_a_missing_one(bank: CookoutBank, tmp_path: Path) -> None:
    with pytest.raises(CookoutModesError, match="cannot read"):
        load_cookout_modes(bank, tmp_path / "missing.json")
    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    with pytest.raises(CookoutModesError, match="cannot read"):
        load_cookout_modes(bank, broken)
    good = tmp_path / "good.json"
    good.write_text(MODES_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    assert len(load_cookout_modes(bank, good).modes) == 2


# -- the validator catches thinned pools and bad text --------------------------------------------


def test_validator_flags_a_thin_bread_list(
    raw: dict[str, Any], bank: CookoutBank, tmp_path: Path
) -> None:
    thin = _mutated(
        raw, lambda m: m["kinds"]["bread"]["select"].update(ids=["bagel", "sourdough-loaf"])
    )
    path = tmp_path / "thin.json"
    path.write_text(json.dumps(thin), encoding="utf-8")
    problems = _validator().validate(path, rounds=0)
    assert any("toastie.bread" in p and "items" in p for p in problems)
    assert any("families" in p for p in problems)


def test_validator_flags_a_food_in_the_template(raw: dict[str, Any], tmp_path: Path) -> None:
    dirty = _mutated(
        raw, lambda m: m["picture"].update(defaultPresentation="Served with mango chutney")
    )
    path = tmp_path / "dirty.json"
    path.write_text(json.dumps(dirty), encoding="utf-8")
    problems = _validator().validate(path, rounds=0)
    assert any("defaultPresentation" in p and "mango" in p.lower() for p in problems)


def test_validator_flags_a_missing_placeholder(raw: dict[str, Any], tmp_path: Path) -> None:
    broken = _mutated(raw, lambda m: m["picture"].update(template="A toasted sandwich of {title}."))
    path = tmp_path / "placeholder.json"
    path.write_text(json.dumps(broken), encoding="utf-8")
    problems = _validator().validate(path, rounds=0)
    assert any("never uses the placeholder {bread}" in p for p in problems)


def test_validator_flags_an_oven_mismatch(raw: dict[str, Any], tmp_path: Path) -> None:
    def flip(m: dict[str, Any]) -> None:
        m["chef"]["builds"][0]["usesOven"] = True

    path = tmp_path / "oven.json"
    path.write_text(json.dumps(_mutated(raw, flip)), encoding="utf-8")
    assert any("usesOven" in p for p in _validator().validate(path, rounds=0))


def test_validator_cli_exits_zero_on_the_committed_file() -> None:
    assert _validator().main(["--rounds", "5"]) == 0


# -- default_modes -------------------------------------------------------------------------------


def test_default_modes_is_built_once() -> None:
    assert default_modes() is default_modes()
    assert [m.id for m in default_modes().modes][0] == "classic"


def test_empty_bank_yields_classic_only(monkeypatch: pytest.MonkeyPatch) -> None:
    from wixy_server.livechat import cookout_game

    monkeypatch.setattr(cookout_game, "default_bank", lambda: CookoutBank.empty())
    default_modes.cache_clear()
    try:
        only = default_modes()
        assert [m.id for m in only.modes] == ["classic"]
        assert all(not k.candidates for k in only.default.kinds.values())
    finally:
        default_modes.cache_clear()
