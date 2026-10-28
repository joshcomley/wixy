"""Cookout ingredient bank: the committed bank passes the offline validator, and the strict loader
rejects each class of bad input. Mutations start from the committed bank (a small fixture could
not satisfy the bank-wide size and role-coverage rules)."""

import collections
import copy
import importlib.util
import json
import random
import sys
from collections.abc import Callable
from collections.abc import Set as AbstractSet
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from wixy_server.livechat import cookout_bank
from wixy_server.livechat.cookout_bank import (
    CATEGORY_IDS,
    ROLES,
    STAPLE_IDS,
    Category,
    CookoutBank,
    CookoutBankError,
    CookoutExhaustedError,
    Ingredient,
    RarityKey,
    RoleKey,
    Staple,
    load_cookout_bank,
    load_cookout_bank_or_empty,
    parse_cookout_bank,
)

REPO = Path(__file__).resolve().parents[2]
VALIDATOR = REPO / "tooling" / "cookout" / "validate_bank.py"
REAL_BANK = REPO / "wixy_server" / "livechat" / "cookout_ingredients.json"


def _load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cookout_validate_bank", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


validator = _load_validator()


@pytest.fixture(scope="module")
def raw_bank() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(REAL_BANK.read_text(encoding="utf-8"))
    return data


def _mutated(raw: dict[str, Any], change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    clone = copy.deepcopy(raw)
    change(clone)
    return clone


def _ingredient(doc: dict[str, Any], ingredient_id: str) -> dict[str, Any]:
    found: dict[str, Any] = next(i for i in doc["ingredients"] if i["id"] == ingredient_id)
    return found


# -- the committed bank ----------------------------------------------------------------------


def test_committed_bank_passes_the_validator() -> None:
    assert validator.validate(REAL_BANK) == []


def test_committed_bank_loads(raw_bank: dict[str, Any]) -> None:
    bank = load_cookout_bank(REAL_BANK)
    assert 2500 <= len(bank.ingredients) <= 4000
    assert [c.id for c in bank.categories] == list(CATEGORY_IDS)
    for role in ROLES:
        assert len(bank.by_role(role)) >= 200
    assert bank.by_role("nonsense") == ()


def test_staples_are_consistent() -> None:
    bank = load_cookout_bank(REAL_BANK)
    assert bank.staple_ids == STAPLE_IDS
    for staple_id in ("water", "salt", "black-pepper"):
        staple = bank.staple(staple_id)
        assert staple is not None and not staple.pickable
        assert bank.ingredient(staple_id) is None
    for staple_id in ("butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk"):
        staple = bank.staple(staple_id)
        assert staple is not None and staple.pickable
        entry = bank.ingredient(staple_id)
        assert entry is not None and entry.name == staple.name
    assert bank.staple("eggs") is None


def test_ingredient_carries_category_display_fields() -> None:
    bank = load_cookout_bank(REAL_BANK)
    toast = bank.ingredient("thick-cut-white-toast")
    assert toast is not None
    assert toast.category == "prepared-pantry"
    assert toast.emoji == "🥫"
    assert toast.category_name == "Prepared & Comfort Pantry"
    assert bank.ingredient("no-such-food") is None


def test_rarity_mix_is_roughly_the_brief(raw_bank: dict[str, Any]) -> None:
    items = raw_bank["ingredients"]
    share = {r: sum(1 for i in items if i["rarity"] == r) / len(items) for r in ("everyday",)}
    assert 0.35 <= share["everyday"] <= 0.62


# -- the loader rejects bad input -------------------------------------------------------------


def test_rejects_non_object() -> None:
    with pytest.raises(CookoutBankError):
        parse_cookout_bank([])


@pytest.mark.parametrize(
    ("label", "change"),
    [
        ("unknown top key", lambda d: d.update(extra=1)),
        ("missing top key", lambda d: d.pop("staples")),
        ("bad version", lambda d: d.update(version=2)),
        ("bool version", lambda d: d.update(version=True)),
        ("missing generated", lambda d: d.pop("generated")),
        ("bad generated", lambda d: d.update(generated="yesterday")),
        ("stop words not a list", lambda d: d.update(stopWords="bread")),
        ("stop word staple food", lambda d: d["stopWords"].append("milk")),
        ("stop word two words", lambda d: d["stopWords"].append("sour dough")),
        ("stop word upper", lambda d: d["stopWords"].append("ROAST2")),
        ("stop word duplicate", lambda d: d["stopWords"].append(d["stopWords"][0])),
        ("category order", lambda d: d["categories"].reverse()),
        ("category dropped", lambda d: d["categories"].pop()),
        ("staple order", lambda d: d["staples"].reverse()),
        ("salt made pickable", lambda d: d["staples"][1].update(pickable=True)),
        ("butter made unpickable", lambda d: d["staples"][3].update(pickable=False)),
        ("staple name drift", lambda d: d["staples"][3].update(name="Salted butter")),
        ("too few ingredients", lambda d: d["ingredients"].__delitem__(slice(0, 2000))),
        ("unknown ingredient key", lambda d: d["ingredients"][0].update(tags=[])),
        ("missing ingredient key", lambda d: d["ingredients"][0].pop("blurb")),
        ("bad id", lambda d: d["ingredients"][0].update(id="Bad_Id")),
        ("one-char id", lambda d: d["ingredients"][0].update(id="x")),
        ("long id", lambda d: d["ingredients"][0].update(id="a" * 65)),
        ("empty name", lambda d: d["ingredients"][0].update(name="")),
        ("untrimmed name", lambda d: d["ingredients"][0].update(name=" Padded")),
        ("long name", lambda d: d["ingredients"][0].update(name="n" * 71)),
        ("control char", lambda d: d["ingredients"][0].update(blurb="tab\there")),
        ("long blurb", lambda d: d["ingredients"][0].update(blurb="b" * 91)),
        ("empty blurb", lambda d: d["ingredients"][0].update(blurb="")),
        ("bad category", lambda d: d["ingredients"][0].update(category="snacks")),
        ("bad role", lambda d: d["ingredients"][0].update(role="dessert")),
        ("bad rarity", lambda d: d["ingredients"][0].update(rarity="legendary")),
        ("bad family", lambda d: d["ingredients"][0].update(family="Not Kebab")),
        ("aliases not list", lambda d: d["ingredients"][0].update(aliases="x")),
        ("too many aliases", lambda d: d["ingredients"][0].update(aliases=list("abcde"))),
        ("duplicate id", lambda d: d["ingredients"][1].update(id=d["ingredients"][0]["id"])),
        (
            "duplicate name folded",
            lambda d: d["ingredients"][1].update(name=d["ingredients"][0]["name"].upper()),
        ),
        (
            "alias collides with name",
            lambda d: d["ingredients"][1].update(aliases=[d["ingredients"][0]["name"]]),
        ),
        ("water as ingredient", lambda d: d["ingredients"][0].update(id="water")),
        (
            "pickable staple missing",
            lambda d: d["ingredients"].remove(_ingredient(d, "granulated-sugar")),
        ),
        (
            "pickable staple renamed",
            lambda d: _ingredient(d, "milk").update(name="Whole milk"),
        ),
    ],
)
def test_loader_rejects(
    raw_bank: dict[str, Any], label: str, change: Callable[[dict[str, Any]], None]
) -> None:
    with pytest.raises(CookoutBankError):
        parse_cookout_bank(_mutated(raw_bank, change))


def test_loader_rejects_a_starved_role(raw_bank: dict[str, Any]) -> None:
    def starve(doc: dict[str, Any]) -> None:
        base = [i for i in doc["ingredients"] if i["role"] == "base"]
        for item in base[150:]:
            item["role"] = "accent"

    with pytest.raises(CookoutBankError, match="role base"):
        parse_cookout_bank(_mutated(raw_bank, starve))


def test_validator_reports_every_problem(raw_bank: dict[str, Any], tmp_path: Path) -> None:
    def damage(d: dict[str, Any]) -> None:
        d["ingredients"][0].update(rarity="legendary")
        d["ingredients"][1].update(role="dessert")
        d["ingredients"][2].update(blurb="*markup*")

    doc = _mutated(raw_bank, damage)
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    problems = validator.validate(path)
    assert any("bad rarity" in p for p in problems)
    assert any("bad role" in p for p in problems)
    assert any("markup" in p for p in problems)


def test_validator_flags_plural_near_duplicates(raw_bank: dict[str, Any], tmp_path: Path) -> None:
    def add(d: dict[str, Any]) -> None:
        clone = copy.deepcopy(_ingredient(d, "milk"))
        clone["id"] = clone["id"] + "s"
        clone["name"] = clone["name"] + "s"
        d["ingredients"].append(clone)

    path = tmp_path / "dup.json"
    path.write_text(json.dumps(_mutated(raw_bank, add)), encoding="utf-8")
    assert any("near-duplicate" in p for p in validator.validate(path))


def test_names_are_sentence_case_and_blurbs_have_no_full_stop(raw_bank: dict[str, Any]) -> None:
    items = {i["id"]: i for i in raw_bank["ingredients"]}
    assert items["maris-piper-potato"]["name"] == "Maris Piper potato"
    assert items["whole-milk"]["name"] == "Whole milk"
    assert all(not i["blurb"].endswith(".") for i in items.values())


def test_validator_flags_title_case_and_full_stops(
    raw_bank: dict[str, Any], tmp_path: Path
) -> None:
    def damage(d: dict[str, Any]) -> None:
        _ingredient(d, "whole-milk").update(name="Whole Milk")
        _ingredient(d, "butter").update(blurb="Ends with a stop.")

    path = tmp_path / "case.json"
    path.write_text(json.dumps(_mutated(raw_bank, damage)), encoding="utf-8")
    problems = validator.validate(path)
    assert any("not sentence case" in p for p in problems)
    assert any("full stop" in p for p in problems)


# -- the safe loader ---------------------------------------------------------------------------


def test_or_empty_returns_an_empty_bank_for_missing_and_broken(tmp_path: Path) -> None:
    missing = load_cookout_bank_or_empty(tmp_path / "missing.json")
    assert missing.ingredients == () and missing.staples == ()
    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    assert load_cookout_bank_or_empty(broken).ingredients == ()
    assert len(load_cookout_bank_or_empty().ingredients) > 2000
    with pytest.raises(CookoutExhaustedError):
        missing.draw_pair(
            role="base",
            seen_ids=set(),
            picked_families=set(),
            offered_families=set(),
            player_offered_categories=[],
        )


def test_module_default_path_is_the_committed_bank() -> None:
    assert cookout_bank.BANK_PATH == REAL_BANK
    assert load_cookout_bank().stop_words >= {"bread", "sauce", "pan", "water"}


# -- draw: fixtures ----------------------------------------------------------------------------


def _item(
    name: str,
    category: str,
    family: str,
    rarity: RarityKey = "everyday",
    role: RoleKey = "base",
    aliases: tuple[str, ...] = (),
) -> Ingredient:
    return Ingredient(
        id=name.lower().replace(" ", "-").replace("'", ""),
        name=name,
        aliases=aliases,
        category=category,
        category_name=category.title(),
        emoji="x",
        role=role,
        family=family,
        rarity=rarity,
        blurb="b",
    )


def _mini(*items: Ingredient, stop_words: frozenset[str] = frozenset()) -> CookoutBank:
    return CookoutBank(
        categories=tuple(Category(c, c, "x") for c in sorted({i.category for i in items})),
        staples=(
            Staple("water", "Water", False),
            Staple("salt", "Salt", False),
            Staple("black-pepper", "Black pepper", False),
            Staple("butter", "Butter", True),
            Staple("plain-flour", "Plain flour", True),
            Staple("cooking-oil", "Cooking oil", True),
            Staple("granulated-sugar", "Granulated sugar", True),
            Staple("milk", "Milk", True),
        ),
        ingredients=items,
        stop_words=stop_words,
    )


def _draw(bank: CookoutBank, seed: int = 1, **over: Any) -> tuple[Ingredient, Ingredient]:
    kwargs: dict[str, Any] = {
        "role": "base",
        "seen_ids": set(),
        "picked_families": set(),
        "offered_families": set(),
        "player_offered_categories": [],
        "rng": random.Random(seed),
    }
    kwargs.update(over)
    return bank.draw_pair(**kwargs)


# -- draw: the rules ---------------------------------------------------------------------------


def test_role_schedule_is_one_two_one_shuffled_and_seedable() -> None:
    bank = load_cookout_bank()
    seen: set[tuple[str, ...]] = set()
    for seed in range(30):
        schedule = bank.shuffle_role_schedule(random.Random(seed))
        assert sorted(schedule) == ["accent", "base", "produce", "produce", "protein"]
        assert schedule == bank.shuffle_role_schedule(random.Random(seed))
        seen.add(schedule)
    assert len(seen) > 5
    assert len(bank.shuffle_role_schedule()) == 5


def test_draw_pair_hard_rules_on_the_committed_bank() -> None:
    bank = load_cookout_bank()
    rng = random.Random(7)
    for role in ROLES:
        seen: set[str] = set()
        offered: set[str] = set()
        shown: list[str] = []
        for _ in range(40):
            one, two = bank.draw_pair(
                role=role,
                seen_ids=seen,
                picked_families=set(),
                offered_families=offered,
                player_offered_categories=shown,
                rng=rng,
            )
            assert one.role == two.role == role
            assert one.category != two.category
            assert one.family != two.family
            assert "everyday" in (one.rarity, two.rarity)
            assert not ({one.id, two.id} & seen)
            seen |= {one.id, two.id}
            offered |= {one.family, two.family}
            shown += [one.category, two.category]


def test_draw_never_offers_a_seen_id_or_a_picked_family() -> None:
    bank = _mini(
        _item("Rice", "grains", "rice"),
        _item("Pasta", "grains", "pasta"),
        _item("Toast", "bread", "toast"),
        _item("Naan", "bread", "flatbread"),
        _item("Grits", "cereal", "corn"),
    )
    for seed in range(40):
        one, two = _draw(bank, seed, seen_ids={"rice"}, picked_families={"toast"})
        assert {one.id, two.id}.isdisjoint({"rice", "toast"})
        assert "toast" not in {one.family, two.family}


def test_offered_families_are_avoided_only_while_a_feasible_pair_remains() -> None:
    bank = _mini(
        _item("Rice", "grains", "rice"),
        _item("Pasta", "grains", "pasta"),
        _item("Toast", "bread", "toast"),
        _item("Naan", "bread", "flatbread"),
    )
    for seed in range(30):
        one, two = _draw(bank, seed, offered_families={"rice", "toast"})
        assert {one.family, two.family} == {"pasta", "flatbread"}
    # Avoiding rice/toast/pasta leaves one family: infeasible, so only the soft rule relaxes.
    for seed in range(30):
        one, two = _draw(bank, seed, offered_families={"rice", "toast", "pasta"})
        assert one.category != two.category and one.family != two.family
    # The hard rules are never relaxed.
    with pytest.raises(CookoutExhaustedError):
        _draw(bank, seen_ids={"rice", "pasta", "toast"})


def test_exhausted_when_one_category_or_family_remains() -> None:
    one_category = _mini(_item("Rice", "grains", "rice"), _item("Pasta", "grains", "pasta"))
    with pytest.raises(CookoutExhaustedError):
        _draw(one_category)
    one_family_across_categories = _mini(
        _item("Rice", "grains", "starch"), _item("Naan", "bread", "starch")
    )
    with pytest.raises(CookoutExhaustedError):
        _draw(one_family_across_categories)
    no_everyday = _mini(
        _item("Rice", "grains", "rice", "uncommon"), _item("Toast", "bread", "toast", "exotic")
    )
    with pytest.raises(CookoutExhaustedError):
        _draw(no_everyday)
    wrong_role = _mini(_item("Rice", "grains", "rice"), _item("Toast", "bread", "toast"))
    with pytest.raises(CookoutExhaustedError):
        _draw(wrong_role, role="protein")


def test_cross_category_family_collision_is_never_a_pair() -> None:
    bank = _mini(
        _item("Rice", "grains", "starch"),
        _item("Naan", "bread", "starch"),
        _item("Toast", "bread", "toast", "uncommon"),
    )
    for seed in range(30):
        one, two = _draw(bank, seed)
        assert {one.id, two.id} in ({"rice", "toast"}, {"naan", "toast"})
        assert one.family != two.family


def test_least_shown_category_without_everyday_does_not_strand_the_draw() -> None:
    bank = _mini(
        _item("Teff", "rare", "teff", "exotic"),
        _item("Rice", "grains", "rice"),
        _item("Toast", "bread", "toast"),
    )
    for seed in range(40):
        one, two = _draw(bank, seed, player_offered_categories=["grains", "bread"])
        assert "everyday" in (one.rarity, two.rarity)
        assert one.category != two.category


def test_least_shown_category_is_preferred_among_feasible_ones() -> None:
    bank = _mini(
        _item("Rice", "grains", "rice"),
        _item("Toast", "bread", "toast"),
        _item("Grits", "cereal", "corn"),
    )
    firsts: collections.Counter[str] = collections.Counter()
    for seed in range(60):
        pair = _draw(bank, seed, player_offered_categories=["grains", "grains", "bread"])
        firsts.update(o.category for o in pair)
    # Cereal has been shown least, so it is always one of the two.
    assert firsts["cereal"] == 60


def test_option_two_follows_the_rarity_weights() -> None:
    bank = _mini(
        _item("Rice", "grains", "rice"),
        _item("Toast", "bread", "toast"),
        _item("Plain bun", "bread", "bun", "uncommon"),
        _item("Teff roll", "bread", "teff", "exotic"),
    )
    rng = random.Random(3)
    tally: collections.Counter[str] = collections.Counter()
    for _ in range(3000):
        one, two = _draw(bank, rng=rng, player_offered_categories=["bread", "bread"])
        other = two if one.id == "rice" else one
        tally[other.rarity] += 1
    assert tally["everyday"] > tally["uncommon"] > tally["exotic"] > 0


def test_option_order_is_a_coin_toss() -> None:
    bank = _mini(_item("Rice", "grains", "rice"), _item("Toast", "bread", "toast"))
    first = collections.Counter(_draw(bank, seed)[0].id for seed in range(60))
    assert first["rice"] > 10 and first["toast"] > 10


def test_snapshot_shape() -> None:
    toast = load_cookout_bank().ingredient("thick-cut-white-toast")
    assert toast is not None
    snapshot = toast.to_snapshot()
    assert set(snapshot) == {"id", "name", "category", "emoji", "family", "blurb"}
    assert snapshot["name"] == "Thick-cut white toast"
    assert all(isinstance(v, str) for v in snapshot.values())


# -- contraband scan ---------------------------------------------------------------------------


def _scan_bank() -> CookoutBank:
    return _mini(
        _item("Streaky bacon", "meat", "bacon", role="protein"),
        _item("Mango", "fruit", "mango", role="produce"),
        _item("Chicken breast", "meat", "chicken", role="protein"),
        _item("Red onion", "veg", "onion", role="produce", aliases=("scarlet onion",)),
        _item("White onion", "veg", "onion", role="produce"),
        _item("Peanut butter", "nuts", "nut-butter", role="accent"),
        _item("Coconut milk", "drinks", "plant-milk", role="accent"),
        _item("Butter", "dairy", "butter", role="accent"),
        _item("Milk", "dairy", "milk", role="accent"),
        _item("Plain flour", "grains", "wheat-flour"),
        _item("Cooking oil", "oils", "oil", role="accent"),
        _item("Granulated sugar", "sweet", "sugar", role="accent"),
        _item("Pak choi", "veg", "pak-choi", role="produce", aliases=("bok choy",)),
        _item("Bird's eye chilli", "veg", "chilli", role="produce"),
        _item("Café noir", "drinks", "coffee", role="accent"),
        stop_words=frozenset({"sauce", "pan", "bread", "water"}),
    )


def _found(text: str, picks: AbstractSet[str] = frozenset(), **over: Any) -> list[str]:
    kwargs: dict[str, Any] = {"allowed_ingredient_ids": set(picks), "allowed_staple_ids": set()}
    kwargs.update(over)
    found: list[str] = _scan_bank().find_contraband_ingredients(text, **kwargs)
    return found


def test_scan_rejects_unpicked_foods_by_name_and_bare_word() -> None:
    assert _found("Mango and bacon over rice", {"chicken-breast"}) == ["Mango", "bacon"]
    assert _found("Smoky streaky bacon") == ["Streaky bacon"]


def test_scan_allows_picked_foods_their_families_staples_and_free_seasonings() -> None:
    assert _found("Mango salsa", {"mango"}) == []
    assert _found("Red onion and onion rings", {"red-onion"}) == []
    assert _found("White onion with a pinch of salt, water and black pepper", {"red-onion"}) == []
    assert _found("Butter the pan", allowed_staple_ids={"butter"}) == []
    assert _found("Plain flour dusting", {"plain-flour"}) == []


def test_scan_allows_generic_stop_words_but_not_staple_food_names() -> None:
    assert _found("A rich sauce in a hot pan with bread and water") == []
    assert _found("A rich sauce with milk") == ["Milk"]


def test_scan_is_case_accent_alias_and_plural_blind() -> None:
    assert _found("CAFE NOIR with BOK CHOY") == ["Café noir", "Pak choi"]
    assert _found("Scarlet onions") == ["Red onion"]
    assert _found("birds eye chillies") == ["Bird's eye chilli"]
    assert _found("mangoes, mangos") == ["Mango"]


def test_scan_is_word_boundary_not_substring() -> None:
    assert _found("A mangonel of milky bacony goodness") == []
    assert _found("pan-fried") == []


def test_scan_longest_span_wins_for_compound_foods() -> None:
    picks = {"peanut-butter", "chicken-breast"}
    assert _found("Peanut butter chicken", picks) == []
    assert _found("peanut butter with extra butter", picks) == ["Butter"]
    coconut = {"coconut-milk"}
    assert _found("Coconut milk curry", coconut) == []
    assert _found("coconut milk plus milk", coconut) == ["Milk"]
    assert _found("COCONUT MILK, then Milk", coconut) == ["Milk"]
    assert _found("peanut butter and butter") == ["Peanut butter", "Butter"]


def test_scan_rejects_an_omitted_item_everywhere_but_its_own_reason() -> None:
    omitted = {"mango"}
    picks = {"red-onion", "chicken-breast"}
    assert _found("Dice the mango", picks, omitted_ingredient_ids=omitted) == ["Mango"]
    assert _found("No mango here", picks, omitted_ingredient_ids=omitted) == ["Mango"]
    reason = {"omitted_ingredient_ids": omitted, "allow_omitted_mentions": True}
    assert _found("Left out: mango would clash", picks | omitted, **reason) == []
    # ... but the reason still may not name some OTHER food.
    assert _found("mango does not suit bacon", picks | omitted, **reason) == ["bacon"]


def test_scan_omitted_item_sharing_a_used_items_family_is_still_rejected() -> None:
    picks = {"red-onion"}
    white = {"omitted_ingredient_ids": {"white-onion"}}
    assert _found("Soften the white onion", picks, **white) == ["White onion"]
    assert _found("Soften the onion", picks, **white) == []


def test_scan_rejects_undeclared_staples_including_a_fifth() -> None:
    declared = {"butter", "plain-flour", "cooking-oil", "granulated-sugar"}
    assert _found("Butter, flour, oil and sugar", allowed_staple_ids=declared) == []
    assert _found("...and a splash of milk", allowed_staple_ids=declared) == ["Milk"]
    assert _found("fry in oil", allowed_staple_ids={"butter"}) == ["Cooking oil"]
    assert _found("dust with flour") == ["Plain flour"]
    assert _found("a spoon of sugar") == ["Granulated sugar"]
    assert _found("a spoon of sugar", {"granulated-sugar"}) == []


def test_scan_staple_words_are_not_suppressed_by_families() -> None:
    bank = _mini(
        _item("Whole milk", "dairy", "milk", role="accent"),
        _item("Milk", "dairy", "milk", role="accent"),
        stop_words=frozenset({"pan"}),
    )
    found = bank.find_contraband_ingredients(
        "whole milk, then milk", allowed_ingredient_ids={"whole-milk"}, allowed_staple_ids=set()
    )
    assert found == ["Milk"]


def test_scan_on_the_committed_bank_catches_the_spec_examples() -> None:
    bank = load_cookout_bank()
    out = bank.find_contraband_ingredients(
        "Seared with mango, then bacon and a splash of milk",
        allowed_ingredient_ids=set(),
        allowed_staple_ids=set(),
    )
    lowered = [o.lower() for o in out]
    assert any("mango" in o for o in lowered)
    assert any("bacon" in o for o in lowered)
    assert any("milk" in o for o in lowered)
    clean = bank.find_contraband_ingredients(
        "A rich sauce in a hot pan with salt and black pepper",
        allowed_ingredient_ids=set(),
        allowed_staple_ids=set(),
    )
    assert clean == []
