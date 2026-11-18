"""Cookout game modes (workspace 00058, spec/server-chat/09c-cookout-modes.md §1).

A game mode is DATA: `cookout_modes.json` beside this module says what a round makes (today
`classic`, the original game, and `toastie`, a toasted sandwich). Each mode lists its draft plan,
its pick kinds and which bank ingredients each kind may offer, its staples, its chef and picture
text and the twists it allows. `load_cookout_modes` is STRICT (an unknown key, a bad id or an
unknown kind raises `CookoutModesError`) and resolves every kind against the loaded bank ONCE
into immutable candidate tuples, so the draw never re-filters the bank. Nothing is copied from
the bank.

Classic is today's game byte for byte: its kinds are the four bank roles, its schedule is
`CookoutBank.shuffle_role_schedule` (five paired roles), and code routes it to the existing paths.

`default_modes()` is built lazily once per process like the shipped bank. This module never imports
`cookout_game` or `cookout_ai` at import time (both import this module), so constants they own
(the Classic staple cap, the technique names) are mirrored here and pinned equal by tests.
"""

from __future__ import annotations

import functools
import json
import random
import re
import secrets
import string
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Literal, cast

from .cookout_bank import ROLES, CookoutBank, Ingredient

MODES_PATH = Path(__file__).with_name("cookout_modes.json")
MODES_VERSION = 1

FacetKey = Literal["category", "family"]
PlanType = Literal["classic", "sequence"]
ChefFormatKey = Literal["classic", "single-dish"]
TwistKey = Literal[
    "swap",
    "vote",
    "style",
    "cooked",
    "wildcard",
    "fridge",
    "challenge",
    "veto",
    "encore",
    "lucky",
    "stars",
    "chaos",
]

TWIST_KEYS: Final[tuple[TwistKey, ...]] = (
    "swap",
    "vote",
    "style",
    "cooked",
    "wildcard",
    "fridge",
    "challenge",
    "veto",
    "encore",
    "lucky",
    "stars",
    "chaos",
)
FACETS: Final[tuple[FacetKey, ...]] = ("category", "family")
CLASSIC_ID: Final = "classic"
CLASSIC_TURNS: Final = 10
CLASSIC_ROLE_SCHEDULE_LENGTH: Final = 5
CLASSIC_STAPLES_CAP: Final = 4  # == cookout_ai.MAX_EXTRA_STAPLES (pinned by a test)
CLASSIC_FREE_STAPLES: Final = frozenset({"water", "salt", "black-pepper"})
CLASSIC_CAPPED_STAPLES: Final = frozenset(
    {"butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk"}
)
# Classic kinds are the bank roles; the labels are never shown (the Classic UI is unchanged).
CLASSIC_KIND_TEXT: Final[Mapping[str, tuple[str, str]]] = {
    "base": ("a base", "tap the one you want"),
    "protein": ("a protein", "tap the one you want"),
    "produce": ("a veg or fruit", "tap the one you want"),
    "accent": ("an accent", "tap the one you want"),
}
MAX_PROMPT = 22

_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_SYSTEM_RNG = secrets.SystemRandom()


class CookoutModesError(ValueError):
    """The mode definitions do not satisfy the schema, or a schedule request cannot be seated.
    The message names the mode and field."""


@dataclass(frozen=True, slots=True)
class PickKind:
    id: str
    label: str
    prompt: str  # <= 22 chars, completes "Your turn — "
    facet: FacetKey
    chaos: bool
    candidates: tuple[Ingredient, ...]  # resolved against the bank at load, sorted by id


@dataclass(frozen=True, slots=True)
class Build:
    id: str
    label: str
    technique: str  # one of cookout_ai.TECHNIQUES
    prompt_phrase: str
    picture_phrase: str
    uses_oven: bool


@dataclass(frozen=True, slots=True)
class StapleRules:
    free: frozenset[str]
    capped: frozenset[str]
    cap: int


@dataclass(frozen=True, slots=True)
class ChefFormat:
    format: ChefFormatKey
    dish_noun: str | None  # "toasted sandwich"
    anchor_kind: str | None  # "bread": in every idea, never omitted, named
    builds: tuple[Build, ...]
    each_missing_max: int | None  # 2: each idea uses >= F - 2 fillings
    best_missing_max: int | None  # 1
    review_dish_words: tuple[str, ...]  # signals only (§3.4), never a violation
    concept_text: str | None  # §3.2, with {bread} {bread_id} {n} {each} {best} {build_list}
    recipe_text: str | None  # §3.5, with {build_label} {build_phrase}
    style_line: str | None


@dataclass(frozen=True, slots=True)
class PictureStyle:
    format: ChefFormatKey
    template: str | None  # §3.6, with {title} {bread} {build_phrase} {fillings} {presentation}
    default_presentation: str | None


@dataclass(frozen=True, slots=True)
class CookoutMode:
    id: str
    label: str
    emoji: str
    blurb: str
    intro: tuple[str, ...]
    plan_type: PlanType
    turns: int
    picks_per_player: int
    kinds: Mapping[str, PickKind]  # Classic: the four roles, facet "category"
    staples: StapleRules
    chef: ChefFormat
    picture: PictureStyle
    twists: frozenset[TwistKey]
    fridge_kinds: frozenset[str] | None  # None = any kind (Classic)
    # Not part of the frozen interface: the plan and classification the methods read.
    _bank: CookoutBank = field(default_factory=CookoutBank.empty, repr=False, compare=False)
    _opening: tuple[str, ...] = field(default=(), repr=False, compare=False)
    _pairs: tuple[str, ...] = field(default=(), repr=False, compare=False)
    _closing: tuple[str, ...] = field(default=(), repr=False, compare=False)
    _kind_by_id: Mapping[str, str] = field(default_factory=dict, repr=False, compare=False)

    @property
    def basket_sizes(self) -> tuple[int, int]:
        """The two legal basket sizes: every pick, or every pick plus the wildcard."""
        return (self.turns, self.turns + 1)

    def kind_of(self, ingredient_id: str) -> str | None:
        """The pick kind an ingredient belongs to in this mode; `None` = excluded here (never
        offered, swapped in, drawn as the wildcard or used as a starter)."""
        return self._kind_by_id.get(ingredient_id)

    def kind_for_turn(self, role_schedule: Sequence[str], turn: int) -> str:
        """The kind of 1-based `turn`. Classic reads the paired five-role schedule
        (`schedule[(turn - 1) // 2]`); a sequence mode reads one kind per turn."""
        if not 1 <= turn <= self.turns:
            raise CookoutModesError(f"{self.id}: turn {turn} is outside 1..{self.turns}")
        index = (turn - 1) // 2 if self.plan_type == "classic" else turn - 1
        if index >= len(role_schedule):
            raise CookoutModesError(
                f"{self.id}: schedule of {len(role_schedule)} has no entry for turn {turn}"
            )
        return role_schedule[index]

    def build_schedule(
        self,
        rng: random.Random | None = None,
        *,
        starter_kinds: Mapping[int, str] = {},  # noqa: B006 - read-only, never mutated
    ) -> tuple[str, ...]:
        """The round's resolved schedule. `starter_kinds` maps a turn to the kind of the seed on it.

        Classic: `CookoutBank.shuffle_role_schedule`, with a turn-1 seed's role swapped to the
        front (fridge raid); seeds on other turns do not move a Classic schedule (unchanged
        behaviour). Sequence: `opening` + `pairs` shuffled (each serving two consecutive turns) +
        `closing`; a turn-1 seed must be the opening kind, and one filling seed on turn 2 moves its
        kind to turn 2 (§2.5). Raises `CookoutModesError` for a seed the plan cannot seat."""
        generator = rng or _SYSTEM_RNG
        if self.plan_type == "classic":
            first = starter_kinds.get(1)
            if first is not None and first not in ROLES:
                raise CookoutModesError(f"{self.id}: {first!r} is not a Classic role")
            return tuple(self._bank.shuffle_role_schedule(generator, first_role=first))

        for turn, kind in starter_kinds.items():
            if turn not in (1, 2):
                raise CookoutModesError(f"{self.id}: a starter cannot sit on turn {turn}")
            if kind not in self.kinds:
                raise CookoutModesError(f"{self.id}: unknown starter kind {kind!r}")
        opening = list(self._opening)
        closing = list(self._closing)
        pairs = list(self._pairs)
        turn_one = starter_kinds.get(1)
        if turn_one is not None and (not opening or turn_one != opening[0]):
            raise CookoutModesError(
                f"{self.id}: the turn-1 starter must be {opening[0] if opening else 'none'!r}, "
                f"not {turn_one!r}"
            )
        turn_two = starter_kinds.get(2)
        front: list[str] = []
        if turn_two is not None:
            if len(opening) != 1:
                raise CookoutModesError(f"{self.id}: this plan cannot seat a turn-2 starter")
            if turn_two in pairs:
                pairs.remove(turn_two)
                front = [turn_two, turn_two]
            elif turn_two in closing:
                closing.remove(turn_two)
                front = [turn_two]
            else:
                raise CookoutModesError(
                    f"{self.id}: a turn-2 starter must be a filling kind, not {turn_two!r}"
                )
        generator.shuffle(pairs)
        schedule = [*opening, *front, *(k for kind in pairs for k in (kind, kind)), *closing]
        if len(schedule) != self.turns:
            raise CookoutModesError(
                f"{self.id}: schedule has {len(schedule)} turns, expected {self.turns}"
            )
        return tuple(schedule)

    def filling_candidates(self) -> tuple[Ingredient, ...]:
        """Every non-anchor kind's candidates, sorted by id (the wildcard cloche's pool, T5)."""
        anchor = self.chef.anchor_kind
        seen: dict[str, Ingredient] = {}
        for kind in self.kinds.values():
            if kind.id == anchor:
                continue
            for ingredient in kind.candidates:
                seen.setdefault(ingredient.id, ingredient)
        return tuple(seen[i] for i in sorted(seen))


@dataclass(frozen=True, slots=True)
class CookoutModes:
    _modes: tuple[CookoutMode, ...]

    def mode(self, mode_id: str) -> CookoutMode | None:
        for candidate in self._modes:
            if candidate.id == mode_id:
                return candidate
        return None

    @property
    def modes(self) -> tuple[CookoutMode, ...]:
        """Every loaded mode, Classic first."""
        return self._modes

    @property
    def default(self) -> CookoutMode:
        return self._modes[0]


# -- strict loading ----------------------------------------------------------------------------


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    out: dict[str, object] = {}
    for key, value in pairs:
        if key in out:
            raise CookoutModesError(f"duplicate key {key!r} in the modes file")
        out[key] = value
    return out


def _check_placeholders(where: str, text: str, allowed: frozenset[str]) -> None:
    """The text is `str.format`-ed at runtime: fail loudly now on a bad, unknown or unused field."""
    used: set[str] = set()
    try:
        for _lit, name, _spec, _conv in string.Formatter().parse(text):
            if name is not None:
                used.add(name)
    except ValueError as exc:
        raise CookoutModesError(f"{where}: not a valid format string ({exc})") from exc
    if used - allowed:
        raise CookoutModesError(f"{where}: unknown placeholder {{{sorted(used - allowed)[0]}}}")
    if allowed - used:
        raise CookoutModesError(
            f"{where}: never uses the placeholder {{{sorted(allowed - used)[0]}}}"
        )


def _object(where: str, value: object) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise CookoutModesError(f"{where}: must be an object")
    return cast("Mapping[str, object]", value)


def _expect_keys(
    where: str,
    data: Mapping[str, object],
    required: set[str],
    optional: frozenset[str] = frozenset(),
) -> None:
    missing = required - data.keys()
    extra = data.keys() - required - optional
    if missing:
        raise CookoutModesError(f"{where}: missing keys {sorted(missing)}")
    if extra:
        raise CookoutModesError(f"{where}: unknown keys {sorted(extra)}")


def _text(where: str, value: object, *, maximum: int = 2000, multiline: bool = False) -> str:
    if not isinstance(value, str) or not value:
        raise CookoutModesError(f"{where}: must be a non-empty string")
    if len(value) > maximum:
        raise CookoutModesError(f"{where}: longer than {maximum} characters")
    pattern = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]") if multiline else _CONTROL_RE
    if pattern.search(value):
        raise CookoutModesError(f"{where}: contains a control character")
    return value


def _ident(where: str, value: object) -> str:
    text = _text(where, value, maximum=64)
    if not _ID_RE.fullmatch(text):
        raise CookoutModesError(f"{where}: {text!r} must be ascii kebab-case")
    return text


def _list(where: str, value: object) -> list[object]:
    if not isinstance(value, list):
        raise CookoutModesError(f"{where}: must be a list")
    return value


def _idents(where: str, value: object, *, unique: bool = True) -> tuple[str, ...]:
    items = tuple(_ident(f"{where}[{n}]", v) for n, v in enumerate(_list(where, value)))
    if unique and len(set(items)) != len(items):
        dupes = sorted(k for k, n in Counter(items).items() if n > 1)
        raise CookoutModesError(f"{where}: duplicate entries {dupes}")
    return items


def _int(where: str, value: object, *, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise CookoutModesError(f"{where}: must be an integer {low}-{high}")
    return value


def _bool(where: str, value: object) -> bool:
    if not isinstance(value, bool):
        raise CookoutModesError(f"{where}: must be true or false")
    return value


def _twists(where: str, value: object) -> frozenset[TwistKey]:
    keys = _idents(where, value)
    unknown = [k for k in keys if k not in TWIST_KEYS]
    if unknown:
        raise CookoutModesError(f"{where}: unknown twists {unknown}")
    return frozenset(cast("tuple[TwistKey, ...]", keys))


def _lines(where: str, value: object) -> str:
    """A text block written as a list of lines in the JSON, joined with newlines."""
    if isinstance(value, str):
        return _text(where, value, multiline=True)
    lines = _list(where, value)
    return "\n".join(
        _text(f"{where}[{n}]", v, multiline=True) if v != "" else "" for n, v in enumerate(lines)
    )


def _staples(where: str, raw: object, bank: CookoutBank) -> StapleRules:
    data = _object(where, raw)
    _expect_keys(where, data, {"free", "capped", "cap"})
    free = frozenset(_idents(f"{where}.free", data["free"]))
    capped = frozenset(_idents(f"{where}.capped", data["capped"]))
    if free & capped:
        raise CookoutModesError(f"{where}: {sorted(free & capped)} are both free and capped")
    if bank.ingredients:
        for sid in sorted(free | capped):
            if bank.staple(sid) is None:
                raise CookoutModesError(f"{where}: unknown staple {sid!r}")
    return StapleRules(free, capped, _int(f"{where}.cap", data["cap"], low=0, high=8))


def _classic_chef(where: str, raw: object) -> ChefFormat:
    data = _object(where, raw)
    _expect_keys(where, data, {"format"})
    if data["format"] != "classic":
        raise CookoutModesError(f"{where}: a classic-plan mode needs format 'classic'")
    return ChefFormat("classic", None, None, (), None, None, (), None, None, None)


def _chef(where: str, raw: object, kind_ids: frozenset[str]) -> ChefFormat:
    data = _object(where, raw)
    fmt = data.get("format")
    if fmt == "classic":
        return _classic_chef(where, raw)
    if fmt != "single-dish":
        raise CookoutModesError(f"{where}.format: must be 'classic' or 'single-dish'")
    _expect_keys(
        where,
        data,
        {
            "format", "dishNoun", "anchorKind", "eachMissingMax", "bestMissingMax",
            "reviewDishWords", "conceptText", "recipeText", "styleLine", "builds",
        },
    )  # fmt: skip
    anchor = _ident(f"{where}.anchorKind", data["anchorKind"])
    if anchor not in kind_ids:
        raise CookoutModesError(f"{where}.anchorKind: unknown kind {anchor!r}")
    builds: list[Build] = []
    for n, item in enumerate(_list(f"{where}.builds", data["builds"])):
        w = f"{where}.builds[{n}]"
        b = _object(w, item)
        _expect_keys(
            w, b, {"id", "label", "technique", "promptPhrase", "picturePhrase", "usesOven"}
        )
        builds.append(
            Build(
                id=_ident(f"{w}.id", b["id"]),
                label=_text(f"{w}.label", b["label"], maximum=40),
                technique=_ident(f"{w}.technique", b["technique"]),
                prompt_phrase=_text(f"{w}.promptPhrase", b["promptPhrase"], maximum=200),
                picture_phrase=_text(f"{w}.picturePhrase", b["picturePhrase"], maximum=200),
                uses_oven=_bool(f"{w}.usesOven", b["usesOven"]),
            )
        )
    if len({b.id for b in builds}) != len(builds):
        raise CookoutModesError(f"{where}.builds: duplicate build ids")
    words = tuple(
        _text(f"{where}.reviewDishWords[{n}]", v, maximum=40)
        for n, v in enumerate(_list(f"{where}.reviewDishWords", data["reviewDishWords"]))
    )
    concept_text = _lines(f"{where}.conceptText", data["conceptText"])
    recipe_text = _lines(f"{where}.recipeText", data["recipeText"])
    _check_placeholders(
        f"{where}.conceptText",
        concept_text,
        frozenset({"bread", "bread_id", "n", "each", "best", "build_list"}),
    )
    _check_placeholders(
        f"{where}.recipeText", recipe_text, frozenset({"build_label", "build_phrase"})
    )
    return ChefFormat(
        format="single-dish",
        dish_noun=_text(f"{where}.dishNoun", data["dishNoun"], maximum=40),
        anchor_kind=anchor,
        builds=tuple(builds),
        each_missing_max=_int(f"{where}.eachMissingMax", data["eachMissingMax"], low=0, high=4),
        best_missing_max=_int(f"{where}.bestMissingMax", data["bestMissingMax"], low=0, high=4),
        review_dish_words=words,
        concept_text=concept_text,
        recipe_text=recipe_text,
        style_line=_text(f"{where}.styleLine", data["styleLine"], multiline=True),
    )


def _picture(where: str, raw: object) -> PictureStyle:
    data = _object(where, raw)
    fmt = data.get("format")
    if fmt == "classic":
        _expect_keys(where, data, {"format"})
        return PictureStyle("classic", None, None)
    if fmt != "single-dish":
        raise CookoutModesError(f"{where}.format: must be 'classic' or 'single-dish'")
    _expect_keys(where, data, {"format", "template", "defaultPresentation"})
    template = _text(f"{where}.template", data["template"], multiline=True)
    _check_placeholders(
        f"{where}.template",
        template,
        frozenset({"title", "bread", "build_phrase", "fillings", "presentation"}),
    )
    return PictureStyle(
        "single-dish",
        template,
        _text(f"{where}.defaultPresentation", data["defaultPresentation"], maximum=200),
    )


def _classic_kinds(bank: CookoutBank) -> dict[str, PickKind]:
    kinds: dict[str, PickKind] = {}
    for role in ROLES:
        label, prompt = CLASSIC_KIND_TEXT[role]
        kinds[role] = PickKind(
            id=role,
            label=label,
            prompt=prompt,
            facet="category",
            chaos=True,
            candidates=tuple(sorted(bank.by_role(role), key=lambda i: i.id)),
        )
    return kinds


def _str_set(where: str, data: Mapping[str, object], key: str) -> frozenset[str]:
    return frozenset(_idents(f"{where}.{key}", data.get(key, [])))


def _sequence_kinds(
    where: str, data: Mapping[str, object], bank: CookoutBank
) -> tuple[dict[str, PickKind], dict[str, str]]:
    """Resolve the `kinds`, `kindOrder` and `fillingRules` of a sequence mode against the bank.

    Classification (§1.4): an id in the anchor kind's `ids` is that kind only; otherwise a
    `fillingRules` exclusion drops the ingredient unless its id is in `includeIds`; otherwise the
    first kind in `kindOrder` whose `select` matches (every listed field must match); no match =
    excluded."""
    raw_kinds = _object(f"{where}.kinds", data["kinds"])
    order = _idents(f"{where}.kindOrder", data["kindOrder"])
    if set(order) != set(raw_kinds):
        raise CookoutModesError(
            f"{where}.kindOrder: must list exactly the kinds {sorted(raw_kinds)}"
        )

    rules = _object(f"{where}.fillingRules", data["fillingRules"])
    _expect_keys(
        f"{where}.fillingRules",
        rules,
        {
            "excludeCategories",
            "excludeFamilies",
            "excludeRoleCategories",
            "excludeIds",
            "includeIds",
        },
    )
    category_ids = {c.id for c in bank.categories}
    exclude_categories = _str_set(f"{where}.fillingRules", rules, "excludeCategories")
    exclude_ids = _str_set(f"{where}.fillingRules", rules, "excludeIds")
    include_ids = _str_set(f"{where}.fillingRules", rules, "includeIds")
    exclude_families: set[tuple[str, str]] = set()
    for category, families in _object(
        f"{where}.fillingRules.excludeFamilies", rules["excludeFamilies"]
    ).items():
        for family in _idents(f"{where}.fillingRules.excludeFamilies.{category}", families):
            exclude_families.add((category, family))
    exclude_role_categories: set[tuple[str, str]] = set()
    for n, pair in enumerate(
        _list(f"{where}.fillingRules.excludeRoleCategories", rules["excludeRoleCategories"])
    ):
        items = _list(f"{where}.fillingRules.excludeRoleCategories[{n}]", pair)
        if len(items) != 2 or any(not isinstance(i, str) for i in items):
            raise CookoutModesError(
                f"{where}.fillingRules.excludeRoleCategories[{n}]: [role, category]"
            )
        role, category = cast("list[str]", items)
        if role not in ROLES:
            raise CookoutModesError(
                f"{where}.fillingRules.excludeRoleCategories[{n}]: unknown role {role!r}"
            )
        exclude_role_categories.add((role, category))
    if bank.ingredients:
        unknown_categories = (
            exclude_categories
            | {c for c, _ in exclude_families}
            | {c for _, c in exclude_role_categories}
        ) - category_ids
        if unknown_categories:
            raise CookoutModesError(
                f"{where}.fillingRules: unknown categories {sorted(unknown_categories)}"
            )
        for ingredient_id in sorted(exclude_ids | include_ids):
            if bank.ingredient(ingredient_id) is None:
                raise CookoutModesError(
                    f"{where}.fillingRules: unknown ingredient {ingredient_id!r}"
                )

    selects: dict[str, tuple[frozenset[str], frozenset[str], frozenset[str], frozenset[str]]] = {}
    meta: dict[str, tuple[str, str, FacetKey, bool]] = {}
    for kind_id, raw in raw_kinds.items():
        w = f"{where}.kinds.{kind_id}"
        _ident(w, kind_id)
        kind = _object(w, raw)
        _expect_keys(w, kind, {"label", "prompt", "facet", "chaos", "select"})
        facet = kind["facet"]
        if facet not in FACETS:
            raise CookoutModesError(f"{w}.facet: must be one of {list(FACETS)}")
        prompt = _text(f"{w}.prompt", kind["prompt"], maximum=MAX_PROMPT)
        meta[kind_id] = (
            _text(f"{w}.label", kind["label"], maximum=40),
            prompt,
            facet,
            _bool(f"{w}.chaos", kind["chaos"]),
        )
        select = _object(f"{w}.select", kind["select"])
        _expect_keys(
            f"{w}.select", select, set(), frozenset({"ids", "categories", "families", "roles"})
        )
        if not select:
            raise CookoutModesError(f"{w}.select: selects nothing")
        roles = _str_set(f"{w}.select", select, "roles")
        if roles - set(ROLES):
            raise CookoutModesError(f"{w}.select.roles: unknown roles {sorted(roles - set(ROLES))}")
        ids = _str_set(f"{w}.select", select, "ids")
        categories = _str_set(f"{w}.select", select, "categories")
        if bank.ingredients:
            for ingredient_id in sorted(ids):
                if bank.ingredient(ingredient_id) is None:
                    raise CookoutModesError(f"{w}.select.ids: unknown ingredient {ingredient_id!r}")
            if categories - category_ids:
                raise CookoutModesError(
                    f"{w}.select.categories: unknown {sorted(categories - category_ids)}"
                )
        selects[kind_id] = (ids, categories, _str_set(f"{w}.select", select, "families"), roles)

    anchor_ids: dict[str, str] = {}
    for kind_id, (ids, _c, _f, _r) in selects.items():
        for ingredient_id in ids:
            if ingredient_id in anchor_ids:
                raise CookoutModesError(
                    f"{where}: {ingredient_id!r} is listed by both "
                    f"{anchor_ids[ingredient_id]!r} and {kind_id!r}"
                )
            anchor_ids[ingredient_id] = kind_id

    def matches(kind_id: str, ingredient: Ingredient) -> bool:
        ids, categories, families, roles = selects[kind_id]
        return (
            (not ids or ingredient.id in ids)
            and (not categories or ingredient.category in categories)
            and (not families or ingredient.family in families)
            and (not roles or ingredient.role in roles)
        )

    kind_by_id: dict[str, str] = {}
    for ingredient in bank.ingredients:
        if ingredient.id in anchor_ids:
            kind_by_id[ingredient.id] = anchor_ids[ingredient.id]
            continue
        excluded = (
            ingredient.category in exclude_categories
            or (ingredient.category, ingredient.family) in exclude_families
            or (ingredient.role, ingredient.category) in exclude_role_categories
            or ingredient.id in exclude_ids
        ) and ingredient.id not in include_ids
        if excluded:
            continue
        for kind_id in order:
            if selects[kind_id][0]:
                continue  # an ids-select kind (the bread) only ever holds its listed ids
            if matches(kind_id, ingredient):
                kind_by_id[ingredient.id] = kind_id
                break

    kinds: dict[str, PickKind] = {}
    for kind_id in order:
        label, prompt, facet, chaos = meta[kind_id]
        members = sorted(
            (i for i in bank.ingredients if kind_by_id.get(i.id) == kind_id), key=lambda i: i.id
        )
        kinds[kind_id] = PickKind(kind_id, label, prompt, facet, chaos, tuple(members))
    return kinds, kind_by_id


def _mode(index: int, raw: object, bank: CookoutBank) -> CookoutMode:
    where = f"mode #{index + 1}"
    data = _object(where, raw)
    mode_id = _ident(f"{where}.id", data.get("id"))
    where = f"mode {mode_id!r}"
    plan = _object(f"{where}.plan", data.get("plan"))
    plan_type = plan.get("type")
    common = {"id", "label", "emoji", "blurb", "intro", "plan", "chef", "picture", "twists"}
    label = _text(f"{where}.label", data.get("label"), maximum=40)
    emoji = _text(f"{where}.emoji", data.get("emoji"), maximum=8)
    blurb = _text(f"{where}.blurb", data.get("blurb"), maximum=90)
    intro = tuple(
        _text(f"{where}.intro[{n}]", v, maximum=140)
        for n, v in enumerate(_list(f"{where}.intro", data.get("intro")))
    )
    if len(intro) > 3:
        raise CookoutModesError(f"{where}.intro: at most 3 lines")
    twists = _twists(f"{where}.twists", data.get("twists"))

    if plan_type == "classic":
        _expect_keys(where, data, common)
        _expect_keys(f"{where}.plan", plan, {"type"})
        kinds = _classic_kinds(bank)
        role_by_id: dict[str, str] = {i.id: i.role for i in bank.ingredients}
        return CookoutMode(
            id=mode_id,
            label=label,
            emoji=emoji,
            blurb=blurb,
            intro=intro,
            plan_type="classic",
            turns=CLASSIC_TURNS,
            picks_per_player=CLASSIC_TURNS // 2,
            kinds=kinds,
            staples=StapleRules(CLASSIC_FREE_STAPLES, CLASSIC_CAPPED_STAPLES, CLASSIC_STAPLES_CAP),
            chef=_classic_chef(f"{where}.chef", data.get("chef")),
            picture=_picture(f"{where}.picture", data.get("picture")),
            twists=twists,
            fridge_kinds=None,
            _bank=bank,
            _opening=(),
            _pairs=(),
            _closing=(),
            _kind_by_id=role_by_id,
        )
    if plan_type != "sequence":
        raise CookoutModesError(f"{where}.plan.type: must be 'classic' or 'sequence'")

    _expect_keys(
        where, data, common | {"kinds", "kindOrder", "fillingRules", "staples", "fridgeKinds"}
    )
    _expect_keys(f"{where}.plan", plan, {"type", "opening", "pairs", "closing"})
    kinds, kind_by_id = _sequence_kinds(where, data, bank)
    opening = _idents(f"{where}.plan.opening", plan["opening"], unique=False)
    pairs = _idents(f"{where}.plan.pairs", plan["pairs"], unique=False)
    closing = _idents(f"{where}.plan.closing", plan["closing"], unique=False)
    for kind_id in (*opening, *pairs, *closing):
        if kind_id not in kinds:
            raise CookoutModesError(f"{where}.plan: unknown kind {kind_id!r}")
    turns = len(opening) + 2 * len(pairs) + len(closing)
    if turns < 2 or turns % 2 or turns > 10:
        raise CookoutModesError(f"{where}.plan: {turns} turns; must be even and 2-10")
    fridge = frozenset(_idents(f"{where}.fridgeKinds", data["fridgeKinds"]))
    if not fridge <= set(kinds):
        raise CookoutModesError(f"{where}.fridgeKinds: unknown kinds {sorted(fridge - set(kinds))}")
    return CookoutMode(
        id=mode_id,
        label=label,
        emoji=emoji,
        blurb=blurb,
        intro=intro,
        plan_type="sequence",
        turns=turns,
        picks_per_player=turns // 2,
        kinds=kinds,
        staples=_staples(f"{where}.staples", data["staples"], bank),
        chef=_chef(f"{where}.chef", data.get("chef"), frozenset(kinds)),
        picture=_picture(f"{where}.picture", data.get("picture")),
        twists=twists,
        fridge_kinds=fridge,
        _bank=bank,
        _opening=opening,
        _pairs=pairs,
        _closing=closing,
        _kind_by_id=kind_by_id,
    )


def parse_cookout_modes(raw: object, bank: CookoutBank) -> CookoutModes:
    """Strictly parse an already-decoded definitions document against `bank`."""
    data = _object("modes file", raw)
    _expect_keys("modes file", data, {"version", "modes"})
    if data["version"] != MODES_VERSION:
        raise CookoutModesError(f"modes file: version must be {MODES_VERSION}")
    modes = tuple(_mode(n, m, bank) for n, m in enumerate(_list("modes", data["modes"])))
    ids = [m.id for m in modes]
    if len(set(ids)) != len(ids):
        raise CookoutModesError(
            f"modes: duplicate ids {sorted(k for k, n in Counter(ids).items() if n > 1)}"
        )
    if not modes or modes[0].id != CLASSIC_ID or modes[0].plan_type != "classic":
        raise CookoutModesError("modes: the first mode must be the Classic mode")
    return CookoutModes(modes)


def load_cookout_modes(bank: CookoutBank, path: Path | None = None) -> CookoutModes:
    """Load and strictly validate the mode definitions at `path` (default: the committed file)
    against `bank`; raises `CookoutModesError`."""
    target = path or MODES_PATH
    try:
        raw = json.loads(
            target.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CookoutModesError(f"cannot read the modes file {target}: {exc}") from exc
    return parse_cookout_modes(raw, bank)


@functools.cache
def default_modes() -> CookoutModes:
    """The shipped modes, built once per process from `default_bank()`. An EMPTY bank (the game
    is unavailable) yields Classic alone, so a process with a broken bank still answers."""
    from .cookout_game import default_bank  # lazy: cookout_game imports this module

    bank = cast(CookoutBank, default_bank())
    if not bank.ingredients:
        raw = json.loads(MODES_PATH.read_text(encoding="utf-8"))
        raw["modes"] = [m for m in raw["modes"] if m["id"] == CLASSIC_ID]
        return parse_cookout_modes(raw, bank)
    return load_cookout_modes(bank)
