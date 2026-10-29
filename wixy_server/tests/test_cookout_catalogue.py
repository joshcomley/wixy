"""The Cookout ingredient catalogue loader and validator (spec/server-chat/09b §A, §F.1).

The loader owns every rule that needs one entry alone; the tooling validator
(`tooling/cookout/visual/validate_catalogue.py`) adds the ones that need the bank. Both are
exercised here against fixtures built from real bank entries.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from wixy_server.livechat import cookout_catalogue
from wixy_server.livechat.cookout_catalogue import (
    CatalogueError,
    entry_problems,
    load_cookout_catalogue,
    load_cookout_catalogue_or_empty,
    name_key,
    parse_cookout_catalogue,
)

REPO = Path(__file__).resolve().parents[2]
VALIDATOR = REPO / "tooling" / "cookout" / "visual" / "validate_catalogue.py"


def _load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cookout_validate_catalogue", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


vc: Any = _load_validator()
BANK = vc.load_bank_items()


def good_entry(ingredient_id: str = "andouille-sausage") -> dict[str, Any]:
    item = BANK[ingredient_id]
    return {
        "what": "A smoky, coarse pork sausage from Cajun cooking in Louisiana.",
        "visual": "one whole raw sausage link, dark reddish-brown smoked casing, coarse texture "
        "visible, lying in a gentle curve",
        "presentation": "whole",
        "facts": [
            "It came to Louisiana with French settlers and became a staple of Cajun cooking.",
            "It is a key ingredient in gumbo and jambalaya.",
        ],
        "nameKey": item.key,
        "source": {"author": "claude-haiku-5-5", "factCheck": "claude-haiku-5-5", "at": 1793318400},
    }


def catalogue_file(tmp_path: Path, items: dict[str, Any]) -> Path:
    path = tmp_path / "catalogue.json"
    path.write_text(
        json.dumps({"version": 1, "bankVersion": 1, "generated": 1, "items": items}),
        encoding="utf-8",
    )
    return path


def problems_for(ingredient_id: str, entry: dict[str, Any]) -> list[str]:
    return list(
        vc.item_problems(ingredient_id, entry, BANK[ingredient_id], vc.ingredient_names(BANK))
    )


# ---------------------------------------------------------------- the loader


def test_committed_catalogue_loads() -> None:
    catalogue = load_cookout_catalogue()
    assert catalogue.version == 1


def test_good_entry_loads_with_the_frozen_fields(tmp_path: Path) -> None:
    path = catalogue_file(tmp_path, {"andouille-sausage": good_entry()})
    catalogue = load_cookout_catalogue(path)
    entry = catalogue.get("andouille-sausage")
    assert entry is not None
    assert entry.presentation == "whole"
    assert len(entry.facts) == 2
    assert entry.name_key == BANK["andouille-sausage"].key
    assert len(catalogue) == 1
    assert catalogue.get("nothing") is None


def test_name_key_is_the_documented_hash() -> None:
    assert name_key("Lemon", ["unwaxed lemon"], "fruit") == name_key(
        "Lemon", ["unwaxed lemon"], "fruit"
    )
    assert len(name_key("Lemon", [], "fruit")) == 16
    assert name_key("Lemon", [], "fruit") != name_key("Lemon", [], "vegetables")
    assert name_key("Lemon", ["a"], "fruit") != name_key("Lemon", [], "fruit")


@pytest.mark.parametrize(
    ("field", "value", "fragment"),
    [
        ("what", "Short", "what is 5 characters"),
        ("what", "x" * 73, "what is 73 characters"),
        ("what", "A tasty thing 🍋 for you.", "emoji"),
        ("what", "A <b>tasty</b> thing for you.", "HTML"),
        ("visual", "too short to be a picture", "visual is 25 characters"),
        ("presentation", "pile", "unknown presentation"),
        ("nameKey", "XYZ", "nameKey"),
    ],
)
def test_loader_rejects_bad_fields(field: str, value: str, fragment: str) -> None:
    entry = good_entry()
    entry[field] = value
    problems = entry_problems("andouille-sausage", entry)
    assert any(fragment in p for p in problems), problems


@pytest.mark.parametrize(
    "visual",
    [
        "one whole sausage with the brand name printed on the casing, lying in a curve",
        "one whole sausage in a plastic packet, dark casing, lying in a gentle curve",
        "one whole sausage held in a hand, dark casing, lying in a gentle curve",
        "one whole sausage on a plate with a fork beside it, dark smoked casing",
        "one whole sausage with a label showing its name, dark smoked casing, curved",
        "a tin of baked beans, dark smoked casing, lying in a gentle curve on its own",
    ],
)
def test_visual_forbidden_words(visual: str) -> None:
    entry = good_entry()
    entry["visual"] = visual
    problems = entry_problems("andouille-sausage", entry)
    assert any("forbidden word" in p for p in problems), problems


@pytest.mark.parametrize(
    "visual",
    [
        "a plain unlabelled clear glass bottle of pale golden oil, filled to the shoulder",
        "a plain glass jar without a label holding thick red paste, lid off to one side",
    ],
)
def test_unlabelled_vessels_are_fine(visual: str) -> None:
    entry = good_entry()
    entry["visual"] = visual
    entry["presentation"] = "jar"
    assert entry_problems("andouille-sausage", entry) == []


@pytest.mark.parametrize(
    "fact",
    [
        "Lemons are said to boost the immune system when eaten every day.",
        "Garlic can help to prevent illness according to old folk remedies.",
        "A single serving carries around 120 calories and a lot of vitamin C.",
        "It is grown on 3 continents and harvested in 5 distinct seasons annually.",
    ],
)
def test_fact_honesty_rules(fact: str) -> None:
    entry = good_entry()
    entry["facts"] = [fact, "It is a key ingredient in gumbo and jambalaya."]
    assert entry_problems("andouille-sausage", entry), fact


def test_a_year_does_not_count_as_a_number() -> None:
    entry = good_entry()
    entry["facts"][0] = "It reached Europe in 1492 and spread across a dozen kitchens quickly."
    assert entry_problems("andouille-sausage", entry) == []


def test_fact_structure_rules() -> None:
    entry = good_entry()
    entry["facts"] = [
        "a" * 30 + " one.",
        "a" * 30 + " two.",
        "a" * 30 + " three.",
        "a" * 30 + " four.",
    ]
    assert any("at most 3" in p for p in entry_problems("andouille-sausage", entry))
    entry["facts"] = [
        "The same fact is repeated here word for word.",
        "The same fact is repeated here word for word.",
    ]
    assert any("repeats a fact" in p for p in entry_problems("andouille-sausage", entry))
    entry["facts"] = ["Too short."]
    assert any("fact is 10 characters" in p for p in entry_problems("andouille-sausage", entry))
    entry["facts"] = []
    assert entry_problems("andouille-sausage", entry) == []  # zero is the loader's to allow


def test_unknown_and_missing_keys() -> None:
    entry = good_entry()
    entry["extra"] = 1
    assert any("unknown keys" in p for p in entry_problems("andouille-sausage", entry))
    del entry["extra"], entry["what"]
    assert any("missing keys" in p for p in entry_problems("andouille-sausage", entry))
    assert entry_problems("Not An Id", good_entry())


def test_source_shape() -> None:
    entry = good_entry()
    entry["source"]["at"] = "2026-10-29"
    assert any("epoch-seconds" in p for p in entry_problems("andouille-sausage", entry))
    entry = good_entry()
    entry["source"].update({"visualBy": "claude-haiku-5-5", "visualAt": 5})
    assert entry_problems("andouille-sausage", entry) == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda raw: raw.update(version=2),
        lambda raw: raw.update(extra=1),
        lambda raw: raw.update(items=[]),
        lambda raw: raw.update(generated="now"),
    ],
)
def test_top_level_strictness(mutate: Any) -> None:
    raw = {"version": 1, "bankVersion": 1, "generated": 1, "items": {}}
    mutate(raw)
    with pytest.raises(CatalogueError):
        parse_cookout_catalogue(raw)


def test_or_empty_never_raises(tmp_path: Path) -> None:
    assert len(load_cookout_catalogue_or_empty(tmp_path / "missing.json")) == 0
    broken = tmp_path / "broken.json"
    broken.write_text("{nope", encoding="utf-8")
    assert len(load_cookout_catalogue_or_empty(broken)) == 0
    bad = catalogue_file(tmp_path, {"andouille-sausage": {**good_entry(), "presentation": "x"}})
    assert len(load_cookout_catalogue_or_empty(bad)) == 0


def test_module_default_path_is_the_committed_file() -> None:
    assert cookout_catalogue.CATALOGUE_PATH.name == "cookout_catalogue.json"
    assert cookout_catalogue.CATALOGUE_PATH.exists()


# ---------------------------------------------------------------- the validator (needs the bank)


def test_validator_accepts_a_good_partial_catalogue(tmp_path: Path) -> None:
    path = catalogue_file(tmp_path, {"andouille-sausage": good_entry()})
    assert vc.validate(path, allow_partial=True) == []
    assert any("no catalogue entry" in p for p in vc.validate(path))


def test_validator_flags_unknown_ids_and_stale_keys(tmp_path: Path) -> None:
    entry = good_entry()
    entry["nameKey"] = "0" * 16
    path = catalogue_file(tmp_path, {"andouille-sausage": entry, "not-a-thing": good_entry()})
    problems = vc.validate(path, allow_partial=True)
    assert any("not a bank ingredient" in p for p in problems)
    assert any("stale nameKey" in p for p in problems)


def test_what_may_not_open_with_the_name() -> None:
    entry = good_entry()
    entry["what"] = "Andouille sausage is a smoky pork sausage."
    assert any("repeats the ingredient name" in p for p in problems_for("andouille-sausage", entry))
    entry["what"] = "A andouille sausage, smoky and pork-filled."
    assert any("repeats the ingredient name" in p for p in problems_for("andouille-sausage", entry))


def test_visual_may_not_name_another_ingredient_after_with() -> None:
    entry = good_entry()
    entry["visual"] = "one whole raw sausage link served with lemon on a plain background, curved"
    assert any("after 'with'" in p for p in problems_for("andouille-sausage", entry))
    entry["visual"] = "one whole raw sausage link with a coarse natural texture, lying in a curve"
    assert problems_for("andouille-sausage", entry) == []


def test_vessel_categories_need_a_vessel() -> None:
    oil = next(i for i in BANK.values() if i.category == "oils-fats-condiments")
    entry = good_entry()
    entry["nameKey"] = oil.key
    entry["what"] = "A cooking fat used across many kitchens."
    entry["visual"] = "a generous quantity of the fat, golden and glossy, shown on its own plainly"
    entry["presentation"] = "heap"
    problems = list(vc.item_problems(oil.id, entry, oil, vc.ingredient_names(BANK)))
    assert any("needs presentation bowl/jar/bottle/glass" in p for p in problems)
    entry["presentation"] = "bottle"
    assert not any(
        "needs presentation" in p
        for p in vc.item_problems(oil.id, entry, oil, vc.ingredient_names(BANK))
    )
    entry["presentation"] = "whole"
    entry["visual"] = "one whole piece of the solid fat, pale and waxy, shown on its own plainly"
    assert not any(
        "needs presentation" in p
        for p in vc.item_problems(oil.id, entry, oil, vc.ingredient_names(BANK))
    )


def test_facts_may_not_repeat_across_entries(tmp_path: Path) -> None:
    other = copy.deepcopy(good_entry("butter"))
    other["facts"] = list(good_entry()["facts"])
    path = catalogue_file(tmp_path, {"andouille-sausage": good_entry(), "butter": other})
    assert any("fact repeated across 2 entries" in p for p in vc.validate(path, allow_partial=True))


def test_waivers_cover_only_listed_empty_entries(tmp_path: Path) -> None:
    empty = good_entry()
    empty["facts"] = []
    path = catalogue_file(tmp_path, {"andouille-sausage": empty})
    waivers = tmp_path / "waivers.json"
    waivers.write_text("{}", encoding="utf-8")
    assert any(
        "no facts and no entry" in p
        for p in vc.validate(path, allow_partial=True, waivers_path=waivers)
    )
    waivers.write_text(json.dumps({"andouille-sausage": "nothing safe to say"}), encoding="utf-8")
    assert vc.validate(path, allow_partial=True, waivers_path=waivers) == []
    waivers.write_text(json.dumps({"andouille-sausage": " ", "nope": "x"}), encoding="utf-8")
    problems = vc.validate(path, allow_partial=True, waivers_path=waivers)
    assert any("no reason" in p for p in problems) and any("not a bank id" in p for p in problems)
    full = catalogue_file(tmp_path, {"andouille-sausage": good_entry()})
    waivers.write_text(json.dumps({"andouille-sausage": "stale"}), encoding="utf-8")
    assert any(
        "needs no waiver" in p for p in vc.validate(full, allow_partial=True, waivers_path=waivers)
    )


def test_bank_view_has_3494_entries_including_the_seasonings() -> None:
    assert len(BANK) == 3494
    assert {"water", "salt", "black-pepper"} <= set(BANK)
    assert all(len(i.key) == 16 for i in BANK.values())
