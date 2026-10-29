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
    assert load_cookout_bank().stop_words >= {"sauce", "pan", "water"}


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
    # the bare word is shorthand for a used pick whose name contains it (round 2)
    assert _found("peanut butter with extra butter", picks) == []
    coconut = {"coconut-milk"}
    assert _found("Coconut milk curry", coconut) == []
    assert _found("coconut milk plus milk", coconut) == []
    assert _found("COCONUT MILK, then Milk", coconut) == []
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
    # round 2: the bare word "milk" is shorthand for the used "Whole milk" (a pick whose name
    # contains it); the staple is no longer smuggled by saying so
    assert found == []
    other = _mini(
        _item("Whole milk", "dairy", "milk", role="accent"),
        _item("Milk", "dairy", "milk", role="accent"),
        _item("Flour", "grain", "flour", role="base"),
    )
    assert other.find_contraband_ingredients(
        "whole milk, then flour", allowed_ingredient_ids={"whole-milk"}, allowed_staple_ids=set()
    ) == ["Flour"]


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


# -- review fixes: stop words are never food, family words are real name tails ------------------


def _single_word_family(d: dict[str, Any]) -> str:
    return str(next(i["family"] for i in d["ingredients"] if "-" not in i["family"]))


@pytest.mark.parametrize("word", ["stock", "spirit", "broth", "juice", "grain", "bread", "sweet"])
def test_loader_and_validator_refuse_food_words_as_stop_words(
    raw_bank: dict[str, Any], tmp_path: Path, word: str
) -> None:
    doc = _mutated(raw_bank, lambda d: d["stopWords"].append(word))
    with pytest.raises(CookoutBankError):
        parse_cookout_bank(doc)
    path = tmp_path / "stop.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    assert any(word in p for p in validator.validate(path))


def test_loader_refuses_a_stop_word_that_is_an_ingredient_family(
    raw_bank: dict[str, Any], tmp_path: Path
) -> None:
    doc = _mutated(raw_bank, lambda d: d["stopWords"].append(_single_word_family(d)))
    with pytest.raises(CookoutBankError, match="food word"):
        parse_cookout_bank(doc)
    path = tmp_path / "family.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    assert any("ingredient name or family" in p for p in validator.validate(path))


def test_committed_stop_words_hold_no_food() -> None:
    bank = load_cookout_bank()
    for word in ("stock", "spirit", "broth", "juice", "grain", "grains", "bread", "paste"):
        assert word not in bank.stop_words
    assert bank.stop_words >= {"pan", "oven", "sauce", "water", "dish"}


def test_unpicked_stock_and_spirit_are_flagged_on_the_committed_bank() -> None:
    bank = load_cookout_bank()
    # (a bare "stock" is a cooking by-product and passes since round 2; a named one does not)
    for text in ("Simmer in chicken stock", "Deglaze with a little white wine and spirit"):
        found = bank.find_contraband_ingredients(
            text, allowed_ingredient_ids=set(), allowed_staple_ids=set()
        )
        assert found, text


def test_ordinary_cooking_prose_is_clean_on_the_committed_bank() -> None:
    bank = load_cookout_bank()
    for text in (
        "Baked until golden, then rested in a hot pan",
        "Season with salt and pepper, grilled and served warm",
        "Crispy, tender and sweetly spiced",
    ):
        assert (
            bank.find_contraband_ingredients(
                text, allowed_ingredient_ids=set(), allowed_staple_ids=set()
            )
            == []
        ), text


def test_bare_family_word_is_flagged_only_when_it_ends_a_member_name() -> None:
    bank = _mini(
        _item("Streaky bacon", "meat", "bacon", role="protein"),
        _item("Tinned baked beans", "tins", "baked", role="protein"),
    )
    assert bank.find_contraband_ingredients(
        "Crisp the bacon", allowed_ingredient_ids=set(), allowed_staple_ids=set()
    ) == ["bacon"]
    assert (
        bank.find_contraband_ingredients(
            "Baked until golden", allowed_ingredient_ids=set(), allowed_staple_ids=set()
        )
        == []
    )


def test_a_stop_word_never_hides_an_omitted_item() -> None:
    bank = _mini(
        _item("Sauce", "sauces", "sauce", role="accent"),
        _item("Rice", "grains", "rice"),
        stop_words=frozenset({"sauce"}),
    )
    scan: dict[str, Any] = {"allowed_staple_ids": set(), "omitted_ingredient_ids": {"sauce"}}
    assert bank.find_contraband_ingredients(
        "Serve with sauce", allowed_ingredient_ids={"rice"}, **scan
    ) == ["Sauce"]
    assert (
        bank.find_contraband_ingredients(
            "Serve with sauce", allowed_ingredient_ids={"rice"}, allowed_staple_ids=set()
        )
        == []
    )


# -- twists: exotic pairs, replacements, wildcard, search, helpers (spec 09a section 5.1) ----------

COMMITTED = load_cookout_bank(REAL_BANK)


def _exotic_draw(bank: CookoutBank, seed: int = 1, **over: Any) -> tuple[Ingredient, Ingredient]:
    return _draw(bank, seed, rarity_mode="exotic", **over)


def test_exotic_pair_invariants_on_the_committed_bank() -> None:
    rng = random.Random(7)
    for role in ROLES:
        seen: set[str] = set()
        for turn in range(40):
            if turn % 4 == 0:
                seen.clear()  # a round only ever draws a handful of exotic pairs
            one, two = COMMITTED.draw_pair(
                role=role,
                seen_ids=seen,
                picked_families=set(),
                offered_families=set(),
                player_offered_categories=[],
                rng=rng,
                rarity_mode="exotic",
            )
            assert one.rarity == two.rarity == "exotic"
            assert one.role == two.role == role
            assert one.category != two.category and one.family != two.family
            assert not ({one.id, two.id} & seen)
            seen.update((one.id, two.id))


def test_exotic_pair_respects_picked_families_and_relaxes_the_offered_preference() -> None:
    bank = _mini(
        _item("Teff", "a", "teff", "exotic"),
        _item("Fonio", "b", "fonio", "exotic"),
        _item("Quinoa", "c", "quinoa", "exotic"),
        _item("Rice", "a", "rice"),
    )
    for seed in range(30):
        one, two = _exotic_draw(bank, seed, picked_families={"teff"})
        assert {one.id, two.id} == {"fonio", "quinoa"}
        # Avoiding the offered families alone would leave nothing, so the soft rule relaxes.
        one, two = _exotic_draw(bank, seed, offered_families={"fonio", "quinoa", "teff"})
        assert one.family != two.family and one.rarity == two.rarity == "exotic"
        # While a pairing exists without them, they are avoided.
        one, two = _exotic_draw(bank, seed, offered_families={"teff"})
        assert {one.id, two.id} == {"fonio", "quinoa"}


def test_exotic_pair_exhaustion() -> None:
    only_everyday = _mini(_item("Rice", "a", "rice"), _item("Toast", "b", "toast"))
    with pytest.raises(CookoutExhaustedError):
        _exotic_draw(only_everyday)
    one_category = _mini(
        _item("Teff", "a", "teff", "exotic"), _item("Fonio", "a", "fonio", "exotic")
    )
    with pytest.raises(CookoutExhaustedError):
        _exotic_draw(one_category)
    two_exotics = _mini(
        _item("Teff", "a", "teff", "exotic"), _item("Fonio", "b", "fonio", "exotic")
    )
    assert {o.id for o in _exotic_draw(two_exotics)} == {"teff", "fonio"}
    with pytest.raises(CookoutExhaustedError):
        _exotic_draw(two_exotics, seen_ids={"teff"})
    with pytest.raises(CookoutExhaustedError):
        _exotic_draw(two_exotics, picked_families={"fonio"})


def test_normal_draw_is_unchanged_by_the_new_parameter() -> None:
    for seed in range(20):
        assert _draw(COMMITTED, seed) == _draw(COMMITTED, seed, rarity_mode="normal")


def _replace(bank: CookoutBank, keep: str, seed: int = 1, **over: Any) -> Ingredient:
    kwargs: dict[str, Any] = {
        "role": "base",
        "keep_id": keep,
        "seen_ids": {keep},
        "picked_families": set(),
        "offered_families": set(),
        "player_offered_categories": [],
        "rng": random.Random(seed),
    }
    kwargs.update(over)
    result: Ingredient = bank.draw_replacement(**kwargs)
    return result


def test_replacement_keeps_the_pair_legal_on_the_committed_bank() -> None:
    rng = random.Random(11)
    for role in ROLES:
        seen: set[str] = set()
        for _ in range(60):
            kept, swept = COMMITTED.draw_pair(
                role=role,
                seen_ids=seen,
                picked_families=set(),
                offered_families=set(),
                player_offered_categories=[],
                rng=rng,
            )
            seen.update((kept.id, swept.id))
            extra = COMMITTED.draw_replacement(
                role=role,
                keep_id=kept.id,
                seen_ids=seen,
                picked_families=set(),
                offered_families=set(),
                player_offered_categories=[],
                rng=rng,
            )
            assert extra.role == role and extra.id not in seen
            assert extra.category != kept.category and extra.family != kept.family
            assert "everyday" in (kept.rarity, extra.rarity)
            seen.add(extra.id)


def test_replacement_must_be_everyday_when_the_kept_option_is_not() -> None:
    bank = _mini(
        _item("Teff", "a", "teff", "exotic"),
        _item("Rice", "b", "rice"),
        _item("Naan", "c", "naan", "uncommon"),
        _item("Toast", "d", "toast", "exotic"),
    )
    for seed in range(40):
        assert _replace(bank, "teff", seed).id == "rice"
    with pytest.raises(CookoutExhaustedError):
        _replace(bank, "teff", seen_ids={"teff", "rice"})
    # An everyday keeper leaves every tier open.
    assert {_replace(bank, "rice", seed).id for seed in range(120)} == {"teff", "naan", "toast"}


def test_replacement_exotic_mode_and_exhaustion() -> None:
    bank = _mini(
        _item("Teff", "a", "teff", "exotic"),
        _item("Fonio", "b", "fonio", "exotic"),
        _item("Rice", "c", "rice"),
        _item("Naan", "d", "naan", "uncommon"),
    )
    for seed in range(30):
        assert _replace(bank, "teff", seed, rarity_mode="exotic").id == "fonio"
    with pytest.raises(CookoutExhaustedError):
        _replace(bank, "teff", seen_ids={"teff", "fonio"}, rarity_mode="exotic")
    with pytest.raises(CookoutBankError):
        _replace(bank, "nope")


def test_replacement_excludes_keepers_category_and_family_and_prefers_new_families() -> None:
    bank = _mini(
        _item("Rice", "a", "rice"),
        _item("Brown rice", "b", "rice"),
        _item("Pasta", "a", "pasta"),
        _item("Toast", "c", "toast"),
        _item("Naan", "d", "naan"),
    )
    for seed in range(40):
        assert _replace(bank, "rice", seed).id in {"toast", "naan"}
        assert _replace(bank, "rice", seed, offered_families={"toast"}).id == "naan"
    # Relaxed when every candidate family has been offered.
    assert _replace(bank, "rice", offered_families={"toast", "naan"}).id in {"toast", "naan"}


def test_replacement_prefers_the_least_shown_category() -> None:
    bank = _mini(
        _item("Rice", "a", "rice"),
        _item("Toast", "b", "toast"),
        _item("Naan", "c", "naan"),
    )
    for seed in range(30):
        shown = ["b", "b", "c"]
        assert _replace(bank, "rice", seed, player_offered_categories=shown).id == "naan"


def test_wildcard_invariants_on_the_committed_bank() -> None:
    rng = random.Random(5)
    seen = {"butter", "milk"}
    picked = {"butter"}
    for _ in range(200):
        card = COMMITTED.draw_wildcard(
            seen_ids=seen,
            picked_families=picked,
            offered_families=set(),
            basket_categories={"vegetables"},
            rng=rng,
        )
        assert card.rarity in ("uncommon", "exotic")
        assert card.id not in seen and card.id not in STAPLE_IDS
        assert card.family not in picked
        assert card.category != "vegetables"


def test_wildcard_tiers_are_balanced_and_pickable_staples_excluded() -> None:
    bank = _mini(
        _item("Teff", "a", "teff", "exotic"),
        _item("Naan", "b", "naan", "uncommon"),
        _item("Rice", "c", "rice"),
        _item("Butter", "d", "butter", "uncommon"),
    )
    rng = random.Random(9)
    tally: collections.Counter[str] = collections.Counter()
    for _ in range(2000):
        card = bank.draw_wildcard(
            seen_ids=set(),
            picked_families=set(),
            offered_families=set(),
            basket_categories=set(),
            rng=rng,
        )
        tally[card.id] += 1
    assert set(tally) == {"teff", "naan"}
    assert 850 < tally["teff"] < 1150


def test_wildcard_soft_preferences_relax_category_first_then_family() -> None:
    bank = _mini(
        _item("Teff", "a", "teff", "exotic"),
        _item("Naan", "b", "naan", "uncommon"),
    )

    def wild(**over: Any) -> str:
        kwargs: dict[str, Any] = {
            "seen_ids": set(),
            "picked_families": set(),
            "offered_families": set(),
            "basket_categories": set(),
            "rng": random.Random(2),
        }
        kwargs.update(over)
        return bank.draw_wildcard(**kwargs).id

    for seed in range(20):
        rng = random.Random(seed)
        assert wild(basket_categories={"a"}, rng=rng) == "naan"
        assert wild(offered_families={"teff"}, rng=rng) == "naan"
        both = wild(basket_categories={"a", "b"}, offered_families={"teff"}, rng=rng)
        assert both == "naan"
    everything = wild(basket_categories={"a", "b"}, offered_families={"teff", "naan"})
    assert everything in {"teff", "naan"}
    with pytest.raises(CookoutExhaustedError):
        wild(seen_ids={"teff", "naan"})
    with pytest.raises(CookoutExhaustedError):
        wild(picked_families={"teff", "naan"})


def test_search_folds_accents_prefixes_and_multiple_tokens() -> None:
    bank = _mini(
        _item("Café noir", "a", "coffee", role="accent"),
        _item("Red onion", "b", "onion", role="produce", aliases=("scarlet onion",)),
        _item("Spring onion", "b", "spring-onion", role="produce"),
        _item("Streaky bacon", "c", "bacon", role="protein"),
    )
    assert [i.name for i in bank.search("CAFE")] == ["Café noir"]
    assert [i.name for i in bank.search("caf n")] == ["Café noir"]
    assert [i.id for i in bank.search("on")] == ["red-onion", "spring-onion"]
    assert [i.id for i in bank.search("scar on")] == ["red-onion"]
    assert [i.id for i in bank.search("onion red")] == ["red-onion"]
    assert bank.search("") == () and bank.search("   ") == () and bank.search("zzz") == ()
    assert len(bank.search("on", limit=1)) == 1 and bank.search("on", limit=0) == ()


def test_search_ranking_exact_prefix_name_then_alias_then_rarity_then_name() -> None:
    bank = _mini(
        _item("Onion", "a", "onion", "exotic"),
        _item("Onion rings", "b", "rings"),
        _item("Spring onion", "c", "spring"),
        _item("Shallot", "d", "shallot", aliases=("french onion",)),
        _item("Zesty onion", "e", "zesty", "uncommon"),
        _item("Brown onion", "f", "brown", "uncommon"),
    )
    assert [i.id for i in bank.search("onion")] == [
        "onion",  # exact name (beats the everyday rarity of the rest)
        "onion-rings",  # name prefix
        "spring-onion",  # other name matches: everyday first, then uncommon by name
        "brown-onion",
        "zesty-onion",
        "shallot",  # alias match last
    ]


def test_search_on_the_committed_bank_finds_staples_and_nothing_outside_it() -> None:
    for staple in ("butter", "plain flour", "cooking oil", "granulated sugar", "milk"):
        assert any(i.name.lower() == staple for i in COMMITTED.search(staple))
    assert all(i.id != "water" for i in COMMITTED.search("water"))
    for hit in COMMITTED.search("chic", limit=50):
        assert COMMITTED.ingredient(hit.id) is hit


def test_mentions_by_name_alias_plural_family_and_staple_short_form() -> None:
    bank = _scan_bank()
    assert bank.mentions("a bowl of Pak choi", "pak-choi")
    assert bank.mentions("stir in some bok choy", "pak-choi")
    assert bank.mentions("two mangoes", "mango")
    assert bank.mentions("crispy bacon bits", "streaky-bacon")  # bare family word
    assert bank.mentions("a knob of butter", "butter")
    assert bank.mentions("a cup of flour", "plain-flour")  # bare short form
    assert bank.mentions("a drizzle of oil", "cooking-oil")
    assert bank.mentions("a spoon of sugar", "granulated-sugar")
    assert not bank.mentions("a bowl of rice", "mango")
    assert not bank.mentions("anything", "no-such-id")


def test_mentions_longest_span_consumes_and_ignores_stop_words() -> None:
    bank = _scan_bank()
    assert not bank.mentions("spread on peanut butter", "butter")
    assert bank.mentions("spread on peanut butter", "peanut-butter")
    assert not bank.mentions("coconut milk sauce", "milk")
    assert bank.mentions("coconut milk sauce", "coconut-milk")
    stoppy = _mini(_item("Rye bread", "a", "bread"), stop_words=frozenset({"bread"}))
    assert stoppy.mentions("a slice of bread", "rye-bread")


def test_food_free_tokens_drops_recognised_foods_only() -> None:
    bank = _mini(
        _item("Baking powder", "a", "baking-powder", role="accent"),
        _item("Pot barley", "b", "barley"),
        _item("Rice", "c", "rice"),
    )
    assert bank.food_free_tokens("Add baking powder, then bake in the oven") == (
        "add",
        "then",
        "bake",
        "in",
        "the",
        "oven",
    )
    assert bank.food_free_tokens("one pot of pot barley and rice") == ("one", "pot", "of", "and")
    assert bank.food_free_tokens("") == ()
    assert bank.food_free_tokens("no foods here") == ("no", "foods", "here")


@pytest.mark.parametrize("role", ROLES)
def test_first_role_leads_the_schedule_for_every_role(role: RoleKey) -> None:
    bank = _mini(_item("Rice", "a", "rice"))
    for seed in range(40):
        schedule = bank.shuffle_role_schedule(random.Random(seed), first_role=role)
        assert schedule[0] == role
        assert sorted(schedule) == sorted(cookout_bank.ROLE_SCHEDULE)
        plain = bank.shuffle_role_schedule(random.Random(seed))
        assert plain == bank.shuffle_role_schedule(random.Random(seed), first_role=None)


def test_validator_twist_simulation_and_exotic_coverage(
    raw_bank: dict[str, Any], tmp_path: Path
) -> None:
    assert validator.simulate_twist_rounds(REAL_BANK, rounds=40) == []

    def strip_exotic_produce(doc: dict[str, Any]) -> None:
        for item in doc["ingredients"]:
            if item["role"] == "produce" and item["rarity"] == "exotic":
                item["rarity"] = "uncommon"

    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps(_mutated(raw_bank, strip_exotic_produce)), encoding="utf-8")
    problems = validator.validate(broken)
    assert any("role produce: exotic entries span fewer" in p for p in problems)
    assert any("role produce: fewer than 40 exotic families" in p for p in problems)


# -- round 2: the chef must succeed (operator first play, round 11132) ----------------------------

PRODUCTION_PICKS = {
    "guar-beans",
    "pea-shoots",
    "mantis-shrimp",
    "rolled-beef-joint",
    "dried-mixed-mushrooms",
    "lemongrass",
    "vegetable-oil",
    "dried-onion-granules",
    "baby-potato",
    "linguine",
}


@pytest.mark.parametrize(
    "prose",
    [
        # every false positive the operator's first game hit, verbatim
        "Mushroom sauce",
        "Crisp onion with a pan gravy",
        "a gravy made from the roasting juices",
        "lemongrass-scented oil",
        "crisp-tender pea shoots",
        "thickened with a little starch from the potato",
        "roasting juices spooned over the beef",
        "Mushroom broth with linguine",
        "onion and mushroom stock",
    ],
)
def test_ordinary_cooking_prose_passes_on_the_production_basket(prose: str) -> None:
    bank = load_cookout_bank()
    assert (
        bank.find_contraband_ingredients(
            prose, allowed_ingredient_ids=PRODUCTION_PICKS, allowed_staple_ids=set()
        )
        == []
    ), prose


@pytest.mark.parametrize(
    "prose",
    [
        "with fresh mango",
        "topped with salmon",
        "streaky bacon lardons",
        "melted chocolate",
        "grated cheese and garlic",
        "mango chutney on the side",
        "a handful of crisps",
        "served with olive oil",
        "a dollop of butter",
    ],
)
def test_a_distinct_unpicked_food_is_still_contraband_on_the_production_basket(
    prose: str,
) -> None:
    bank = load_cookout_bank()
    assert bank.find_contraband_ingredients(
        prose, allowed_ingredient_ids=PRODUCTION_PICKS, allowed_staple_ids=set()
    ), prose


def test_an_omitted_pick_is_still_caught_by_its_full_name_in_prose() -> None:
    bank = load_cookout_bank()
    picks = PRODUCTION_PICKS - {"rolled-beef-joint"}
    found = bank.find_contraband_ingredients(
        "a rolled beef joint, sliced",
        allowed_ingredient_ids=picks,
        allowed_staple_ids=set(),
        omitted_ingredient_ids={"rolled-beef-joint"},
    )
    assert found == ["Rolled beef joint"]


def test_a_culinary_word_never_counts_as_mentioning_a_removed_ingredient() -> None:
    bank = load_cookout_bank()
    assert not bank.mentions("rich roasting juices", "apple-juice")
    assert not bank.mentions("a crisp finish", "ready-salted-crisps")
    assert bank.mentions("a glass of apple juice", "apple-juice")


@pytest.mark.parametrize("word", ["butter", "oil", "salt", "mango", "honey", "two words", "Crisp"])
def test_the_loader_refuses_bad_culinary_words(
    raw_bank: dict[str, Any], tmp_path: Path, word: str
) -> None:
    doc = _mutated(raw_bank, lambda d: d["culinaryWords"].append(word))
    with pytest.raises(CookoutBankError):
        parse_cookout_bank(doc)


def test_the_committed_culinary_words_are_valid_and_cover_the_production_failures() -> None:
    bank = load_cookout_bank()
    assert {"crisp", "juices", "gravy", "starch", "stock", "broth"} <= bank.culinary_words


def test_date_night_and_choux_buns_are_not_read_as_foods() -> None:
    bank = load_cookout_bank()
    for prose in ("Candlelit date night supper", "baked into golden buns"):
        assert (
            bank.find_contraband_ingredients(
                prose, allowed_ingredient_ids=set(), allowed_staple_ids=set()
            )
            == []
        ), prose
    assert bank.find_contraband_ingredients(
        "stewed dates", allowed_ingredient_ids=set(), allowed_staple_ids=set()
    )


def test_a_dab_of_and_wafer_thin_are_not_read_as_foods() -> None:
    bank = load_cookout_bank()
    for prose in ("with a dab of heat", "wafer-thin slices", "leave any grit behind"):
        assert (
            bank.find_contraband_ingredients(
                prose, allowed_ingredient_ids=set(), allowed_staple_ids=set()
            )
            == []
        ), prose
    assert bank.find_contraband_ingredients(
        "grilled dab with a wafer", allowed_ingredient_ids=set(), allowed_staple_ids=set()
    )
