"""Audit F4 (senior ruling): the one rule for a multi-word bank product the chef names.

A multi-word product that is not a used pick passes only as (A) the pick's own name written
short, (B) an entry of the curated `byproducts` list whose sources the dish supplies, (C) the same
family, (D) a shape of a generic picked pasta. No word of a span is dropped before it is judged.
The matrix below is the ruling's: every FAIL must be flagged, every PASS must scan clean.
"""

from __future__ import annotations

from typing import Any

import pytest

from wixy_server.livechat.cookout_bank import load_cookout_bank

BANK = load_cookout_bank()


def _scan(text: str, picks: list[str], staples: list[str] | None = None) -> list[str]:
    return BANK.find_contraband_ingredients(
        text, allowed_ingredient_ids=set(picks), allowed_staple_ids=set(staples or [])
    )


FAIL = [
    ("salad cream", ["double-cream"]),
    ("salad cream", ["single-cream"]),
    ("salad cream", ["soured-cream"]),
    ("salad cream", ["clotted-cream"]),
    ("water chestnuts", ["chestnuts"]),
    ("water chestnut", ["chestnut-puree"]),
    ("water spinach", ["baby-spinach"]),
    ("spinach wrap", ["baby-spinach"]),
    ("spinach wrap", ["perpetual-spinach"]),
    ("tomato wrap", ["cherry-tomato"]),
    ("tomato wrap", ["green-tomato"]),
    ("stuffing mix", ["seafood-mix"]),
    ("tartare sauce", ["beef-tartare"]),
    ("soda water", ["bicarbonate-of-soda"]),
    ("rose water", ["rose-wine"]),
    ("water biscuits", ["rich-tea-biscuits"]),
    ("black bean sauce", ["black-eyed-peas"]),
    ("yellow bean sauce", ["yellow-wax-beans"]),
    ("gravy granules", ["garlic-granules"]),
    ("burger sauce", ["bison-burger"]),
    ("steak bake", ["gammon-steak"]),
    ("pork pie", ["pork-collar"]),
    ("water kefir", ["kefir"]),
    ("brown sauce", ["brown-crab"]),
    ("brown sauce", ["brown-onion"]),
    ("hot sauce", ["hot-smoked-salmon"]),
    ("hot sauce", ["hot-chilli-powder"]),
    ("white sauce", ["sliced-white-bread"]),
    ("white fat", ["white-pudding"]),
    ("fish sauce", ["whole-fish"]),
    ("oyster sauce", ["pacific-oysters"]),
    ("pizza sauce", ["stuffed-crust-frozen-pizza"]),
    ("curry sauce", ["ready-made-chicken-curry"]),
    ("stir-fry sauce", ["beef-stir-fry-strips"]),
    ("peanut butter", ["peanuts"], ["butter"]),
    ("pecan butter", ["pecans"], ["butter"]),
    ("banana pepper", ["naga-chilli", "banana"]),
    ("rice flour", ["basmati-rice"], ["plain-flour"]),
    ("coconut oil", ["young-coconut"], ["cooking-oil"]),
    ("walnut oil", ["walnut-halves"], ["cooking-oil"]),
    ("baked beans", ["split-mung-beans"]),
    ("refried beans", ["coffee-beans"]),
    ("red lentils", ["red-lentil-pasta"]),
    ("mango chutney", ["mango"]),
    ("salmon", ["chicken-breast"]),
    ("bacon", ["chicken-breast"]),
    ("garlic butter", ["garlic-flakes"]),
    ("mushroom sauce", []),
    ("vegetable stock", ["chantenay-carrot"]),
    ("date sugar", ["pitted-dates"], ["granulated-sugar"]),
    ("fish stock", ["opah"]),
    ("add lemon salt", ["lemon"]),
    ("pork pie", ["pork-loin-chop"]),
    ("hot sauce", ["hot-fudge-sauce"]),
    ("mushroom sauce", ["mushroom-soy-sauce"]),
    ("salad potato", ["ready-made-potato-salad"]),
    ("oyster sauce", ["pacific-oysters"]),
    ("salad cream", ["double-cream"]),
    ("crispy onion rings on top", ["stuffing-mix"]),
]
PASS = [
    ("mushroom sauce", ["dried-mixed-mushrooms"]),
    ("mushroom sauce", ["nameko-mushroom"]),
    ("apple sauce", ["braeburn-apple"]),
    ("apple sauce", ["bramley-apple"]),
    ("lamb stock", ["lamb-leg"]),
    ("lamb stock", ["lamb-mince"]),
    ("garlic butter", ["garlic-flakes"], ["butter"]),
    ("a pat of garlic butter", ["fresh-garlic", "salted-butter"]),
    ("garlic butter", ["garlic-cloves"], ["butter"]),
    ("lemongrass-scented oil", ["vegetable-oil", "lemongrass"]),
    ("crisp-tender pea shoots", ["pea-shoots"]),
    ("rich roasting juices", ["rolled-beef-joint"]),
    ("pan gravy", ["rolled-beef-joint"]),
    ("fry the onion", ["dried-onion-granules"]),
    ("beef gravy", ["rolled-beef-joint"]),
    ("beef stock", ["beef-shin"]),
    ("chicken stock", ["chicken-breast"]),
    ("fish stock", ["whole-fish"]),
    ("bacon fat", ["canadian-bacon"]),
    ("lemon juice", ["preserved-lemon"]),
    ("lime juice", ["key-lime"]),
    ("tomato sauce", ["cherry-tomato"]),
    ("onion gravy", ["white-onion"]),
    ("chilli oil", ["naga-chilli"], ["cooking-oil"]),
    ("beaten egg", ["large-egg"]),
    ("a poached egg", ["free-range-egg"]),
    ("egg yolk", ["goose-egg"]),
    ("basmati rice", ["microwave-basmati-rice-pouch"]),
    ("pepperoni pizza traybake", ["frozen-pepperoni-pizza"]),
    ("pan-fry in dried chilli", ["dried-chillies-whole"]),
    ("pasta sauce", ["pasta-sauce-jar"]),
    ("olive oil", ["extra-virgin-olive-oil"]),
    ("lentil pasta", ["red-lentil-pasta"]),
    ("cod fillet", ["frozen-breaded-cod-fillets"]),
    ("ice cream", ["mint-choc-chip-ice-cream"]),
    ("an apricot glaze", ["apricot-glaze"]),
    ("burgundy truffle shavings", ["burgundy-truffle"]),
    ("Pan-fry diced pork loin chop until golden", ["pork-loin-chop"]),
    ("pork mince", ["pork-mince"]),
    ("cranberry sauce", ["cranberry"]),
    ("strawberry jam", ["strawberry"], ["granulated-sugar"]),
    ("duck fat", ["duck-liver"]),
    ("chicken bone broth", ["chicken-breast-on-the-bone"]),
    ("brown butter", [], ["butter"]),
    ("orange juice", ["valencia-orange"]),
    ("cheese sauce", ["american-cheese-slices"]),
    ("bread sauce", ["danish-rye-bread"], ["milk"]),
    ("pork bone broth", ["pork-collar"]),
    ("tinned tomatoes", ["tinned-chopped-tomatoes"]),
    ("hot sauce", ["chipotle-hot-sauce"]),
    ("fish pie", ["fish-pie-mix"]),
    ("sage and onion stuffing", ["stuffing-mix"]),
    ("tinned pineapple rings sit under the cake", ["tinned-pineapple"]),
    ("fish stock", ["whole-fish"]),
]


@pytest.mark.parametrize("case", FAIL, ids=lambda c: c[0] + "|" + ",".join(c[1]))
def test_must_flag(case: tuple[Any, ...]) -> None:
    for pick in case[1]:
        assert BANK.ingredient(pick) is not None, pick
    assert _scan("serve with " + case[0], case[1], case[2] if len(case) > 2 else None), case


@pytest.mark.parametrize("case", PASS, ids=lambda c: c[0] + "|" + ",".join(c[1]))
def test_must_pass(case: tuple[Any, ...]) -> None:
    for pick in case[1]:
        assert BANK.ingredient(pick) is not None, pick
    assert _scan(case[0], case[1], case[2] if len(case) > 2 else None) == [], case


# -- the closed by-product validator ------------------------------------------------------------

import copy  # noqa: E402
import json  # noqa: E402

from wixy_server.livechat.cookout_bank import (  # noqa: E402
    BANK_PATH,
    CookoutBankError,
    parse_cookout_bank,
)

RAW: dict[str, Any] = json.loads(BANK_PATH.read_text(encoding="utf-8"))


def _with(byproducts: dict[str, list[str]]) -> dict[str, Any]:
    doc: dict[str, Any] = copy.deepcopy(RAW)
    doc["byproducts"].update(byproducts)
    return doc


def test_the_committed_bank_loads_and_holds_a_reviewable_list() -> None:
    assert 100 <= len(BANK.byproducts) <= 160


@pytest.mark.parametrize(
    "entry",
    [
        {"salad cream": ["salad"]},  # head outside BYPRODUCT_HEADS
        {"water chestnut": ["water"]},
        {"pork pie": ["pork"]},
        {"apple sauce": ["pear"]},  # a source that is not in its key
        {"cider sauce": ["zzzz"]},  # a source no bank name supplies
        {"garlic butter": ["garlic"]},  # the carrier is missing from the sources
        {"butter sauce": ["butter"], "unknown thing sauce": ["thing"]},  # unknown phrase
        {"cooking oil sauce": ["oil"]},
    ],
)
def test_the_validator_refuses_a_bad_entry(entry: dict[str, list[str]]) -> None:
    with pytest.raises(CookoutBankError, match="byproduct"):
        parse_cookout_bank(_with(entry))


def test_the_validator_refuses_a_staple_key_and_too_many_entries() -> None:
    with pytest.raises(CookoutBankError, match="byproduct"):
        parse_cookout_bank(_with({"plain flour": ["flour"]}))
    many = {f"x{i} sauce": ["sauce"] for i in range(251)}
    doc: dict[str, Any] = copy.deepcopy(RAW)
    doc["byproducts"] = many
    with pytest.raises(CookoutBankError, match="byproducts"):
        parse_cookout_bank(doc)


def test_the_byproducts_key_is_required() -> None:
    doc: dict[str, Any] = copy.deepcopy(RAW)
    del doc["byproducts"]
    with pytest.raises(CookoutBankError):
        parse_cookout_bank(doc)


# -- why a span passed, and the structural invariant --------------------------------------------


def test_every_pass_records_its_reason() -> None:
    reasons: list[tuple[str, str]] = []
    BANK.find_contraband_ingredients(
        "mushroom sauce, pepperoni pizza and onion rings",
        allowed_ingredient_ids={"nameko-mushroom", "frozen-pepperoni-pizza", "red-onion"},
        allowed_staple_ids=set(),
        reasons=reasons,
    )
    why = dict(reasons)
    assert why["mushroom sauce"].startswith("byproduct(mushroom sauce")
    assert why["pepperoni"] == "own-name"
    assert why["onion rings"].startswith("ring-shape(")


def _shares_word(a: str, b: str) -> bool:
    from wixy_server.livechat.cookout_bank import HEAD_MODIFIERS, tokenise

    return bool((set(tokenise(a)) - HEAD_MODIFIERS) & (set(tokenise(b)) - HEAD_MODIFIERS))


def test_structural_invariant_on_a_stride_of_the_bank() -> None:
    """A bank product named for a pick of another family is flagged unless the pick's own name
    contains it as a run or it is a curated by-product (pinned: pasta shapes, ring shapes)."""
    from wixy_server.livechat.cookout_bank import CONTAINER_WORDS, PASTA_SHAPE_FAMILIES, tokenise

    by_word: dict[str, set[str]] = {}
    for ing in BANK.ingredients:
        for word in {w for n in (ing.name, *ing.aliases) for w in tokenise(n)}:
            by_word.setdefault(word, set()).add(ing.id)
    leaks: list[str] = []
    for n, ing in enumerate(BANK.ingredients):
        if n % 20:
            continue
        words = tokenise(ing.name)
        if len(words) < 2 or BANK._dictionary.get(words) != ("ingredient", ing.id):
            continue
        trimmed = words
        while len(trimmed) > 1 and trimmed[-1] in CONTAINER_WORDS:
            trimmed = trimmed[:-1]
        if trimmed in BANK._byproduct_lookup or ing.family in PASTA_SHAPE_FAMILIES:
            continue
        others = set().union(*(by_word.get(w, set()) for w in words)) - {ing.id}
        for pid in sorted(others)[:12]:
            pick = BANK.ingredient(pid)
            assert pick is not None
            if pick.family == ing.family or words[-1] in ("ring", "rings"):
                continue
            if BANK._pick_run(words, BANK._pick_names({pid}, set()), with_implied=True):
                continue
            if not BANK.find_contraband_ingredients(
                "serve with " + ing.name, allowed_ingredient_ids={pid}, allowed_staple_ids=set()
            ):
                leaks.append(f"{ing.name} via {pid}")
    assert leaks == []


def test_review_follow_ups_nut_butters_and_cooked_eggs_are_not_the_raw_food() -> None:
    assert _scan("add brown butter", ["pecan-butter"])  # a nut butter is no dairy butter
    assert _scan("add brown butter", [], ["butter"]) == []
    assert _scan("top with a poached egg", ["century-egg"])
    assert _scan("top with a poached egg", ["free-range-egg"]) == []
    assert _scan("serve with a boiled egg", ["soy-marinated-egg"])
