"""The Cookout ingredient bank (workspace 00058, spec/server-chat/09-cookout.md, ruling 12).

The bank ships in the repo as `cookout_ingredients.json` beside this module: roughly three thousand
genuine ingredients in 15 categories, each with a culinary `role` (what the pair draw schedules
on), a `family` (near-variants that must never be offered together) and a `rarity`. Like the
Adventure Time destination bank it is STATIC content: it lives in the repo, not in `server.db`,
and names nothing about anyone, so delete/wipe never touch it. What a round offered and picked is
stored as immutable snapshots in the round's own tables.

`load_cookout_bank` is STRICT: a typo in a committed bank is a broken asset, so every key, bound
and identifier rule is checked and an unknown key is refused. `load_cookout_bank_or_none` is what
`create_app` calls: a missing or malformed bank must not stop the whole app starting, so it logs
the reason and returns None (the game is then unavailable, chat lives). CI's `test_cookout_bank.py`
and `tooling/cookout/validate_bank.py` keep the shipped file honest.

Staples are the cupboard items every concept may use for free: `water`, `salt` and `black-pepper`
are never offered as picks; the other five are ALSO ordinary bank entries (same ids), so "sugar"
or "butter" can be offered and picked.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

_LOGGER = logging.getLogger(__name__)

BANK_PATH = Path(__file__).with_name("cookout_ingredients.json")
BANK_VERSION = 1

ROLES = ("base", "protein", "produce", "accent")
RARITIES = ("everyday", "uncommon", "exotic")
CATEGORY_IDS = (
    "meat-poultry",
    "fish-seafood",
    "vegetables",
    "fungi",
    "fruit",
    "dairy-eggs",
    "grains-bakery",
    "legumes-nuts-seeds",
    "herbs-aromatics",
    "spices-seasonings",
    "oils-fats-condiments",
    "sauces-stocks-fermented",
    "sweet-baking",
    "prepared-pantry",
    "drinks-alcohol",
)
STAPLE_IDS = (
    "water",
    "salt",
    "black-pepper",
    "butter",
    "plain-flour",
    "cooking-oil",
    "granulated-sugar",
    "milk",
)
UNPICKABLE_STAPLES = frozenset({"water", "salt", "black-pepper"})

MIN_INGREDIENTS = 2500
MAX_INGREDIENTS = 4000
MIN_PER_ROLE = 300

_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_MAX_ID = 64
_MAX_NAME = 70
_MAX_FAMILY = 48
_MAX_BLURB = 90
_MAX_ALIASES = 4


def fold(text: str) -> str:
    """Case- and accent-folded form used for every uniqueness check."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


class CookoutBankError(ValueError):
    """The ingredient bank does not satisfy the schema. The message names the entry."""


@dataclass(frozen=True, slots=True)
class Category:
    id: str
    name: str
    emoji: str


@dataclass(frozen=True, slots=True)
class Staple:
    id: str
    name: str
    pickable: bool


@dataclass(frozen=True, slots=True)
class Ingredient:
    id: str
    name: str
    aliases: tuple[str, ...]
    category: str
    category_name: str
    emoji: str
    role: str
    family: str
    rarity: str
    blurb: str


@dataclass(frozen=True, slots=True)
class CookoutBank:
    categories: tuple[Category, ...]
    staples: tuple[Staple, ...]
    ingredients: tuple[Ingredient, ...]
    _by_id: Mapping[str, Ingredient] = field(init=False, repr=False, compare=False)
    _staples_by_id: Mapping[str, Staple] = field(init=False, repr=False, compare=False)
    _by_role: Mapping[str, tuple[Ingredient, ...]] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_by_id", {i.id: i for i in self.ingredients})
        object.__setattr__(self, "_staples_by_id", {s.id: s for s in self.staples})
        object.__setattr__(
            self,
            "_by_role",
            {role: tuple(i for i in self.ingredients if i.role == role) for role in ROLES},
        )

    def ingredient(self, ingredient_id: str) -> Ingredient | None:
        return self._by_id.get(ingredient_id)

    def staple(self, staple_id: str) -> Staple | None:
        return self._staples_by_id.get(staple_id)

    @property
    def staple_ids(self) -> tuple[str, ...]:
        return tuple(s.id for s in self.staples)

    def by_role(self, role: str) -> tuple[Ingredient, ...]:
        return self._by_role.get(role, ())

    # -- draw_pair: second checkpoint -----------------------------------------------------------
    # The server-authoritative pair draw (ruling 3) lands here once its signature is frozen.


# -- strict loading ----------------------------------------------------------------------------


def _expect_keys(where: str, data: Mapping[str, object], required: set[str]) -> None:
    missing = required - data.keys()
    extra = data.keys() - required
    if missing:
        raise CookoutBankError(f"{where}: missing keys {sorted(missing)}")
    if extra:
        raise CookoutBankError(f"{where}: unknown keys {sorted(extra)}")


def _text(where: str, value: object, *, maximum: int) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise CookoutBankError(f"{where}: must be a non-empty trimmed string")
    if len(value) > maximum:
        raise CookoutBankError(f"{where}: longer than {maximum} characters")
    if _CONTROL_RE.search(value):
        raise CookoutBankError(f"{where}: contains a control character")
    return value


def _ident(where: str, value: object, *, low: int, high: int) -> str:
    text = _text(where, value, maximum=high)
    if len(text) < low or not _ID_RE.fullmatch(text):
        raise CookoutBankError(f"{where}: {text!r} must be {low}-{high} chars of ascii kebab-case")
    return text


def _category(index: int, raw: object) -> Category:
    where = f"category #{index + 1}"
    if not isinstance(raw, dict):
        raise CookoutBankError(f"{where}: must be an object")
    _expect_keys(where, raw, {"id", "name", "emoji"})
    return Category(
        id=_ident(f"{where} id", raw["id"], low=2, high=_MAX_ID),
        name=_text(f"{where} name", raw["name"], maximum=_MAX_NAME),
        emoji=_text(f"{where} emoji", raw["emoji"], maximum=8),
    )


def _staple(index: int, raw: object) -> Staple:
    where = f"staple #{index + 1}"
    if not isinstance(raw, dict):
        raise CookoutBankError(f"{where}: must be an object")
    _expect_keys(where, raw, {"id", "name", "pickable"})
    pickable = raw["pickable"]
    if not isinstance(pickable, bool):
        raise CookoutBankError(f"{where}: pickable must be a boolean")
    return Staple(
        id=_ident(f"{where} id", raw["id"], low=2, high=_MAX_ID),
        name=_text(f"{where} name", raw["name"], maximum=_MAX_NAME),
        pickable=pickable,
    )


def _ingredient(index: int, raw: object, categories: Mapping[str, Category]) -> Ingredient:
    where = f"ingredient #{index + 1}"
    if not isinstance(raw, dict):
        raise CookoutBankError(f"{where}: must be an object")
    _expect_keys(
        where, raw, {"id", "name", "aliases", "category", "role", "family", "rarity", "blurb"}
    )
    ingredient_id = _ident(f"{where} id", raw["id"], low=2, high=_MAX_ID)
    where = f"ingredient {ingredient_id}"
    aliases_raw = raw["aliases"]
    if not isinstance(aliases_raw, list) or len(aliases_raw) > _MAX_ALIASES:
        raise CookoutBankError(f"{where}: aliases must be a list of at most {_MAX_ALIASES}")
    aliases = tuple(_text(f"{where} alias", a, maximum=_MAX_NAME) for a in aliases_raw)
    category_id = raw["category"]
    if not isinstance(category_id, str) or category_id not in categories:
        raise CookoutBankError(f"{where}: unknown category {category_id!r}")
    role = raw["role"]
    if not isinstance(role, str) or role not in ROLES:
        raise CookoutBankError(f"{where}: role must be one of {list(ROLES)}")
    rarity = raw["rarity"]
    if not isinstance(rarity, str) or rarity not in RARITIES:
        raise CookoutBankError(f"{where}: rarity must be one of {list(RARITIES)}")
    category = categories[category_id]
    return Ingredient(
        id=ingredient_id,
        name=_text(f"{where} name", raw["name"], maximum=_MAX_NAME),
        aliases=aliases,
        category=category.id,
        category_name=category.name,
        emoji=category.emoji,
        role=role,
        family=_ident(f"{where} family", raw["family"], low=2, high=_MAX_FAMILY),
        rarity=rarity,
        blurb=_text(f"{where} blurb", raw["blurb"], maximum=_MAX_BLURB),
    )


def parse_cookout_bank(raw: object) -> CookoutBank:
    """Validate an already-decoded bank document and build the typed bank."""
    if not isinstance(raw, dict):
        raise CookoutBankError("the bank must be a JSON object")
    _expect_keys("bank", raw, {"version", "categories", "staples", "ingredients"})
    if raw["version"] != BANK_VERSION or isinstance(raw["version"], bool):
        raise CookoutBankError(f"bank version must be {BANK_VERSION}")
    categories_raw, staples_raw, ingredients_raw = (
        raw["categories"],
        raw["staples"],
        raw["ingredients"],
    )
    if not isinstance(categories_raw, list) or not isinstance(staples_raw, list):
        raise CookoutBankError("bank categories and staples must be lists")
    if not isinstance(ingredients_raw, list):
        raise CookoutBankError("bank ingredients must be a list")

    categories = tuple(_category(i, c) for i, c in enumerate(categories_raw))
    if tuple(c.id for c in categories) != CATEGORY_IDS:
        raise CookoutBankError(f"categories must be exactly {list(CATEGORY_IDS)} in order")
    category_map = {c.id: c for c in categories}

    staples = tuple(_staple(i, s) for i, s in enumerate(staples_raw))
    if tuple(s.id for s in staples) != STAPLE_IDS:
        raise CookoutBankError(f"staples must be exactly {list(STAPLE_IDS)} in order")
    for staple in staples:
        if staple.pickable == (staple.id in UNPICKABLE_STAPLES):
            raise CookoutBankError(f"staple {staple.id}: wrong pickable flag")

    if not (MIN_INGREDIENTS <= len(ingredients_raw) <= MAX_INGREDIENTS):
        raise CookoutBankError(
            f"bank must hold {MIN_INGREDIENTS}-{MAX_INGREDIENTS} ingredients, "
            f"has {len(ingredients_raw)}"
        )
    ingredients = tuple(_ingredient(i, r, category_map) for i, r in enumerate(ingredients_raw))

    ids: set[str] = set()
    names: dict[str, str] = {}
    for ingredient in ingredients:
        if ingredient.id in ids:
            raise CookoutBankError(f"duplicate ingredient id {ingredient.id!r}")
        ids.add(ingredient.id)
        key = fold(ingredient.name)
        if key in names:
            raise CookoutBankError(
                f"ingredient {ingredient.id}: name {ingredient.name!r} duplicates {names[key]!r}"
            )
        names[key] = ingredient.id
    for ingredient in ingredients:
        for alias in ingredient.aliases:
            owner = names.setdefault(fold(alias), ingredient.id)
            if owner != ingredient.id:
                raise CookoutBankError(
                    f"ingredient {ingredient.id}: alias {alias!r} collides with {owner!r}"
                )
    by_id = {i.id: i for i in ingredients}
    for staple in staples:
        if staple.id in UNPICKABLE_STAPLES:
            if staple.id in by_id:
                raise CookoutBankError(f"staple {staple.id} must not be an ingredient")
        else:
            entry = by_id.get(staple.id)
            if entry is None or entry.name != staple.name:
                raise CookoutBankError(
                    f"pickable staple {staple.id} must be an ingredient with the same name"
                )
    for role in ROLES:
        if sum(1 for i in ingredients if i.role == role) < MIN_PER_ROLE:
            raise CookoutBankError(f"role {role} has fewer than {MIN_PER_ROLE} ingredients")
    return CookoutBank(categories=categories, staples=staples, ingredients=ingredients)


def load_cookout_bank(path: Path = BANK_PATH) -> CookoutBank:
    """Load and strictly validate the bank at `path`; raises `CookoutBankError`."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CookoutBankError(f"cannot read the bank {path}: {exc}") from exc
    return parse_cookout_bank(raw)


def load_cookout_bank_or_none(path: Path = BANK_PATH) -> CookoutBank | None:
    """What `create_app` uses: a broken bank is logged and the game is unavailable, but the rest
    of Server chat still starts."""
    try:
        return load_cookout_bank(path)
    except CookoutBankError:
        _LOGGER.exception("Cookout ingredient bank unusable — the game is DISABLED")
        return None
