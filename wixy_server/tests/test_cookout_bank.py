"""Cookout ingredient bank: the committed bank passes the offline validator, and the strict loader
rejects each class of bad input. Mutations start from the committed bank (a small fixture could
not satisfy the bank-wide size and role-coverage rules)."""

import copy
import importlib.util
import json
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from wixy_server.livechat import cookout_bank
from wixy_server.livechat.cookout_bank import (
    CATEGORY_IDS,
    ROLES,
    STAPLE_IDS,
    CookoutBankError,
    load_cookout_bank,
    load_cookout_bank_or_none,
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
        assert len(bank.by_role(role)) >= 300
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
        for item in base[200:]:
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


# -- the safe loader ---------------------------------------------------------------------------


def test_or_none_returns_none_for_missing_and_broken(tmp_path: Path) -> None:
    assert load_cookout_bank_or_none(tmp_path / "missing.json") is None
    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    assert load_cookout_bank_or_none(broken) is None
    assert load_cookout_bank_or_none(REAL_BANK) is not None


def test_module_default_path_is_the_committed_bank() -> None:
    assert cookout_bank.BANK_PATH == REAL_BANK
