"""The Cookout ingredient bank and draw engine (workspace 00058, spec/server-chat/09-cookout.md §2).

The bank ships in the repo as `cookout_ingredients.json` beside this module: roughly three thousand
genuine ingredients in 15 categories, each with a culinary `role` (what the pair draw schedules
on), a `family` (near-variants that must never be offered together) and a `rarity`. Like the
Adventure Time destination bank it is STATIC content: it lives in the repo, not in `server.db`,
and names nothing about anyone, so delete/wipe never touch it. What a round offered and picked is
stored as immutable snapshots in the round's own tables.

`load_cookout_bank` is STRICT: a typo in a committed bank is a broken asset, so every key, bound
and identifier rule is checked and an unknown key is refused. `load_cookout_bank_or_empty` is what
`create_app` calls: a missing or malformed bank must not stop the whole app starting, so it logs
the reason and returns an empty bank (the game is then unavailable, chat lives). CI's
`test_cookout_bank.py` and `tooling/cookout/validate_bank.py` keep the shipped file honest.

Staples are the cupboard items every concept may use for free: `water`, `salt` and `black-pepper`
are never offered as picks; the other five are ALSO ordinary bank entries (same ids), so "sugar"
or "butter" can be offered and picked.

Two engines live on the bank: `draw_pair` (§2.3, the server-authoritative pair draw) and
`find_contraband_ingredients` (§3.2, the deterministic food-word scan of generated prose).
"""

from __future__ import annotations

import json
import logging
import random
import re
import secrets
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

_LOGGER = logging.getLogger(__name__)

BANK_PATH = Path(__file__).with_name("cookout_ingredients.json")
BANK_VERSION = 1

RoleKey = Literal["base", "protein", "produce", "accent"]
RarityKey = Literal["everyday", "uncommon", "exotic"]
RarityMode = Literal["normal", "exotic"]

ROLES: tuple[RoleKey, ...] = ("base", "protein", "produce", "accent")
RARITIES: tuple[RarityKey, ...] = ("everyday", "uncommon", "exotic")
RARITY_WEIGHTS: Mapping[RarityKey, int] = {"everyday": 8, "uncommon": 3, "exotic": 1}
ROLE_SCHEDULE: tuple[RoleKey, RoleKey, RoleKey, RoleKey, RoleKey] = (
    "base",
    "protein",
    "produce",
    "produce",
    "accent",
)
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
NON_SEASONING_STAPLES = frozenset(
    {"butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk"}
)
STAPLE_SHORT_FORMS: Mapping[str, str] = {
    "butter": "butter",
    "flour": "plain-flour",
    "oil": "cooking-oil",
    "sugar": "granulated-sugar",
    "milk": "milk",
}
"""Bare words a cook says for a non-seasoning staple; the manifest pass (§3.2 pass 2) reads them."""
FORBIDDEN_STOP_WORDS = frozenset(
    {
        "butter", "flour", "milk", "oil", "sugar", "salt", "pepper",
        "stock", "broth", "juice", "spirit", "grain", "grains", "sweet", "spread", "seasoning",
        "paste", "root", "bread",
    }
)  # fmt: skip

FORBIDDEN_CULINARY_WORDS = frozenset(
    {"butter", "flour", "milk", "oil", "sugar", "salt", "pepper", "water"}
)
"""A culinary word is ordinary cooking language ("crisp", "juices", "gravy"), never a food the
operator would call 'added'; a staple word or an ingredient's own exact name can never be one."""

IGNORED_PHRASES: tuple[tuple[str, ...], ...] = (
    ("date", "night"),
    ("dab", "of"),
    ("dabs", "of"),
    ("a", "dab"),
    ("wafer", "thin"),
    ("grit",),
)
"""Fixed phrases the scan never reads as a food: "date night" is an evening out, not the fruit;
"a dab of", "wafer-thin" and a bare "grit" are a measure, an adjective and a speck, not the
fish, the biscuit or grits."""

MIN_INGREDIENTS = 2500
MAX_INGREDIENTS = 4000
MIN_PER_ROLE = 200
MAX_STOP_WORDS = 200
MAX_CULINARY_WORDS = 120

_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_MAX_ID = 64
_MAX_NAME = 70
_MAX_FAMILY = 48
_MAX_BLURB = 90
_MAX_ALIASES = 4

_SYSTEM_RNG = secrets.SystemRandom()


def fold(text: str) -> str:
    """Case- and accent-folded form used for every uniqueness check."""
    decomposed = unicodedata.normalize("NFKC", text)
    decomposed = unicodedata.normalize("NFKD", decomposed)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def tokenise(text: str) -> tuple[str, ...]:
    """Folded word tokens: accents and case gone, apostrophes dropped ("bird's" -> "birds")."""
    return tuple(_TOKEN_RE.findall(fold(text).replace("'", "").replace("’", "")))


class CookoutBankError(ValueError):
    """The ingredient bank does not satisfy the schema. The message names the entry."""


class CookoutExhaustedError(Exception):
    """No feasible offer pair exists for the turn's role (spec §2.3); the server answers
    `409 exhausted` without charging a skip or touching the round."""


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
    role: RoleKey
    family: str
    rarity: RarityKey
    blurb: str

    def to_snapshot(self) -> dict[str, str]:
        """The immutable offer snapshot stored in `cookout_turns.offers` (§2.3 rule 5)."""
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "emoji": self.emoji,
            "family": self.family,
            "blurb": self.blurb,
        }


# A dictionary hit is (kind, key): an ingredient entry, a staple (a free seasoning, or the bare
# word for a non-seasoning one), or a family (the bare food word "bacon" for "Streaky bacon").
_Entity = tuple[str, str]


def _plural_variants(tokens: tuple[str, ...]) -> list[tuple[str, ...]]:
    """Naive singular/plural spellings of the last word, so "mangoes" and "mango" both read as the
    food (no stemming beyond this: the scan is a dictionary, not a language model)."""
    if not tokens:
        return []
    head, last = tokens[:-1], tokens[-1]
    forms: set[str] = set()
    if last.endswith("ies") and len(last) > 4:
        forms.add(last[:-3] + "y")
        forms.add(last[:-3] + "i")
    if last.endswith("es") and len(last) > 3:
        forms.add(last[:-2])
    if last.endswith("s") and len(last) > 3:
        forms.add(last[:-1])
    forms.add(last + "s")
    if last.endswith(("o", "s", "x", "ch", "sh")):
        forms.add(last + "es")
    if last.endswith("i") and len(last) > 3:
        forms.add(last[:-1] + "ies")
    if last.endswith("y") and len(last) > 3:
        forms.add(last[:-1] + "ies")
    forms.discard(last)
    return [(*head, f) for f in forms]


@dataclass(frozen=True, slots=True)
class CookoutBank:
    categories: tuple[Category, ...]
    staples: tuple[Staple, ...]
    ingredients: tuple[Ingredient, ...]
    stop_words: frozenset[str] = frozenset()
    culinary_words: frozenset[str] = frozenset()
    _by_id: Mapping[str, Ingredient] = field(init=False, repr=False, compare=False)
    _staples_by_id: Mapping[str, Staple] = field(init=False, repr=False, compare=False)
    _by_role: Mapping[str, tuple[Ingredient, ...]] = field(init=False, repr=False, compare=False)
    _dictionary: Mapping[tuple[str, ...], _Entity] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_by_id", {i.id: i for i in self.ingredients})
        object.__setattr__(self, "_staples_by_id", {s.id: s for s in self.staples})
        object.__setattr__(
            self,
            "_by_role",
            {role: tuple(i for i in self.ingredients if i.role == role) for role in ROLES},
        )
        dictionary: dict[tuple[str, ...], _Entity] = {}
        variants: list[tuple[tuple[str, ...], _Entity]] = []

        def add(text: str, entity: _Entity) -> None:
            tokens = tokenise(text)
            if not tokens:
                return
            dictionary.setdefault(tokens, entity)
            variants.extend((v, entity) for v in _plural_variants(tokens))

        for ingredient in self.ingredients:
            entity: _Entity = ("ingredient", ingredient.id)
            add(ingredient.name, entity)
            for alias in ingredient.aliases:
                add(alias, entity)
        for staple in self.staples:
            if staple.id in UNPICKABLE_STAPLES:
                add(staple.name, ("staple", staple.id))
        # "Salt and pepper": the bare word is the free seasoning, whatever other peppers exist.
        dictionary[("pepper",)] = ("staple", "black-pepper")
        for key, entity in variants:
            dictionary.setdefault(key, entity)
        for short, staple_id in STAPLE_SHORT_FORMS.items():
            dictionary.setdefault((short,), ("staple", staple_id))
        # A family word ("bacon" for "Streaky bacon") is a food word only when it is the tail of
        # a member's own name; slug artefacts ("baked", "beef-aged") are never read from prose.
        for family in sorted({i.family for i in self.ingredients}):
            tokens = tokenise(family)
            if not tokens:
                continue
            if any(
                len(name) >= len(tokens) and name[-len(tokens) :] == tokens
                for name in (tokenise(i.name) for i in self.ingredients if i.family == family)
            ):
                dictionary.setdefault(tokens, ("family", family))
                for variant in _plural_variants(tokens):
                    dictionary.setdefault(variant, ("family", family))
        object.__setattr__(self, "_dictionary", dictionary)

    @staticmethod
    def empty() -> CookoutBank:
        """What a missing or malformed bank degrades to: the game is unavailable."""
        return CookoutBank(categories=(), staples=(), ingredients=())

    def ingredient(self, ingredient_id: str) -> Ingredient | None:
        return self._by_id.get(ingredient_id)

    def staple(self, staple_id: str) -> Staple | None:
        return self._staples_by_id.get(staple_id)

    @property
    def staple_ids(self) -> tuple[str, ...]:
        return tuple(s.id for s in self.staples)

    def by_role(self, role: str) -> tuple[Ingredient, ...]:
        return self._by_role.get(role, ())

    # -- the pair draw (spec §2.3) --------------------------------------------------------------

    def shuffle_role_schedule(
        self, rng: random.Random | None = None, *, first_role: RoleKey | None = None
    ) -> tuple[RoleKey, RoleKey, RoleKey, RoleKey, RoleKey]:
        """The round's culinary-role schedule: one base, one protein, two produce, one accent in a
        shuffled order. Role `schedule[(turn - 1) // 2]` serves turns 2k+1 and 2k+2 alike, so both
        players get the same five opportunities. `first_role` (fridge raid, twist T6) swaps the
        first occurrence of that role into index 0 after the ordinary shuffle."""
        generator = rng or _SYSTEM_RNG
        roles = list(ROLE_SCHEDULE)
        generator.shuffle(roles)
        if first_role is not None:
            at = roles.index(first_role)
            roles[0], roles[at] = roles[at], roles[0]
        a, b, c, d, e = roles
        return (a, b, c, d, e)

    def draw_pair(
        self,
        *,
        role: RoleKey,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        player_offered_categories: Sequence[str],
        rng: random.Random | None = None,
        rarity_mode: RarityMode = "normal",
    ) -> tuple[Ingredient, Ingredient]:
        """Draw the two options of one offer for `role`.

        HARD (never relaxed): no id already offered this round (`seen_ids`), no family already
        picked (`picked_families`), two different categories, two different families, and at least
        one option whose own entry is `everyday`. SOFT: families already offered this round
        (`offered_families`) are avoided while a feasible pairing exists without them. Feasibility
        is decided BEFORE the least-shown tie-break, so the category choice can never strand the
        pair. `player_offered_categories` is the category of every option already shown to the
        active player this round (skips included). No feasible pair at all raises
        `CookoutExhaustedError`.

        `rarity_mode="exotic"` (chaos shelf, twist T12) restricts the candidates to `exotic`
        entries and replaces "at least one everyday" with "both exotic"; every other rule and
        preference is unchanged.
        """
        generator = rng or _SYSTEM_RNG
        exotic = rarity_mode == "exotic"
        eligible = [
            i
            for i in self.by_role(role)
            if i.id not in seen_ids
            and i.family not in picked_families
            and (not exotic or i.rarity == "exotic")
        ]
        for pool in (
            [i for i in eligible if i.family not in offered_families],
            eligible,
        ):
            grouped = _group(pool)
            feasible = _feasible_first_options(grouped, need_everyday=not exotic)
            if feasible:
                break
        else:
            raise CookoutExhaustedError(f"no feasible {role} pair remains")

        counts = Counter(player_offered_categories)
        lowest = min(counts[c] for c in feasible)
        cat_a = generator.choice(sorted(c for c in feasible if counts[c] == lowest))
        fam_a = generator.choice(sorted(feasible[cat_a]))
        first_tier = [e for e in grouped[cat_a][fam_a] if exotic or e.rarity == "everyday"]
        option_one = generator.choice(sorted(first_tier, key=lambda e: e.id))
        counts[cat_a] += 1
        partners = [c for c in grouped if c != cat_a and _has_other_family(grouped[c], fam_a)]
        lowest_partner = min(counts[c] for c in partners)
        cat_b = generator.choice(sorted(c for c in partners if counts[c] == lowest_partner))

        by_tier: dict[RarityKey, dict[str, list[Ingredient]]] = {}
        for family, entries in grouped[cat_b].items():
            if family == fam_a:
                continue
            for entry in entries:
                by_tier.setdefault(entry.rarity, {}).setdefault(family, []).append(entry)
        tiers = [t for t in RARITIES if t in by_tier]
        tier = generator.choices(tiers, weights=[RARITY_WEIGHTS[t] for t in tiers])[0]
        fam_b = generator.choice(sorted(by_tier[tier]))
        option_two = generator.choice(sorted(by_tier[tier][fam_b], key=lambda e: e.id))

        if generator.random() < 0.5:
            return (option_two, option_one)
        return (option_one, option_two)

    def draw_replacement(
        self,
        *,
        role: RoleKey,
        keep_id: str,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        player_offered_categories: Sequence[str],
        rarity_mode: RarityMode = "normal",
        rng: random.Random | None = None,
    ) -> Ingredient:
        """One fresh option for `role` that keeps the pair with `keep_id` legal (partner veto, T8).

        HARD: unseen, family not picked, and a different category AND family from the kept option.
        `"normal"`: when the kept option is not `everyday` the replacement must be, otherwise the
        usual 8:3:1 tiers; `"exotic"` (the live pair is a chaos pair): exotic only. SOFT: families
        already offered are avoided while any candidate exists without them. The active player's
        least-shown category wins, then a uniform family, then entry. Nothing feasible raises
        `CookoutExhaustedError`.
        """
        keep = self._by_id.get(keep_id)
        if keep is None:
            raise CookoutBankError(f"unknown ingredient {keep_id!r}")
        generator = rng or _SYSTEM_RNG
        exotic = rarity_mode == "exotic"
        must_be_everyday = not exotic and keep.rarity != "everyday"
        eligible = [
            i
            for i in self.by_role(role)
            if i.id not in seen_ids
            and i.family not in picked_families
            and i.category != keep.category
            and i.family != keep.family
            and (
                i.rarity == "exotic" if exotic else (i.rarity == "everyday" or not must_be_everyday)
            )
        ]
        pool = [i for i in eligible if i.family not in offered_families] or eligible
        if not pool:
            raise CookoutExhaustedError(f"no feasible {role} replacement remains")
        by_tier: dict[RarityKey, list[Ingredient]] = {}
        for entry in pool:
            by_tier.setdefault(entry.rarity, []).append(entry)
        tiers = [t for t in RARITIES if t in by_tier]
        weights = [RARITY_WEIGHTS[t] for t in tiers]
        tier = generator.choices(tiers, weights=weights)[0]
        counts = Counter(player_offered_categories)
        categories = {e.category for e in by_tier[tier]}
        lowest = min(counts[c] for c in categories)
        category = generator.choice(sorted(c for c in categories if counts[c] == lowest))
        in_category = [e for e in by_tier[tier] if e.category == category]
        family = generator.choice(sorted({e.family for e in in_category}))
        return generator.choice(
            sorted((e for e in in_category if e.family == family), key=lambda e: e.id)
        )

    def draw_wildcard(
        self,
        *,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        basket_categories: AbstractSet[str],
        rng: random.Random | None = None,
    ) -> Ingredient:
        """The surprise eleventh ingredient behind the cloche (T5): any role, never `everyday` (it
        is a dare), never one of the five pickable staples, never seen, never from a picked family.
        Tiers `uncommon : exotic = 1 : 1` among those available. SOFT preferences, relaxed in
        order: a category the basket does not hold yet, then a family not yet offered. Nothing
        feasible raises `CookoutExhaustedError`."""
        generator = rng or _SYSTEM_RNG
        eligible = [
            i
            for i in self.ingredients
            if i.rarity != "everyday"
            and i.id not in seen_ids
            and i.id not in NON_SEASONING_STAPLES
            and i.family not in picked_families
        ]
        pool: list[Ingredient] = []
        for fresh_category, fresh_family in ((True, True), (False, True), (False, False)):
            pool = [
                i
                for i in eligible
                if (not fresh_category or i.category not in basket_categories)
                and (not fresh_family or i.family not in offered_families)
            ]
            if pool:
                break
        if not pool:
            raise CookoutExhaustedError("no feasible wildcard remains")
        tiers = [t for t in ("uncommon", "exotic") if any(e.rarity == t for e in pool)]
        tier = generator.choice(tiers)
        in_tier = [e for e in pool if e.rarity == tier]
        family = generator.choice(sorted({e.family for e in in_tier}))
        return generator.choice(
            sorted((e for e in in_tier if e.family == family), key=lambda e: e.id)
        )

    # -- bank search and food-word helpers (twists) ---------------------------------------------

    def search(self, query: str, *, limit: int = 20) -> tuple[Ingredient, ...]:
        """Fridge-raid search: an ingredient matches when every query token is a prefix of some
        token of its name, or of one of its aliases. Ranked exact name, name prefix, other name
        match, alias match, then rarity (`everyday` first), then name."""
        wanted = tokenise(query)
        if not wanted or limit <= 0:
            return ()
        phrase = " ".join(wanted)
        ranked: list[tuple[int, int, str, str, Ingredient]] = []
        for ingredient in self.ingredients:
            name_tokens = tokenise(ingredient.name)
            if _all_prefixes(wanted, name_tokens):
                joined = " ".join(name_tokens)
                rank = 0 if joined == phrase else 1 if joined.startswith(phrase) else 2
            elif any(_all_prefixes(wanted, tokenise(a)) for a in ingredient.aliases):
                rank = 3
            else:
                continue
            rarity = RARITIES.index(ingredient.rarity)
            ranked.append((rank, rarity, fold(ingredient.name), ingredient.id, ingredient))
        ranked.sort(key=lambda r: r[:4])
        return tuple(r[4] for r in ranked[:limit])

    def _covered_tokens(
        self, ingredient_ids: AbstractSet[str], staple_ids: AbstractSet[str]
    ) -> frozenset[str]:
        """Every word (and its simple singular/plural) in the names and aliases of the given picks
        and staples: the words a cook may use bare for something the dish does use ("oil" for
        vegetable oil, "mushroom" for dried mixed mushrooms)."""
        names: list[str] = []
        for ingredient_id in ingredient_ids:
            entry = self._by_id.get(ingredient_id)
            if entry is not None:
                names.extend((entry.name, *entry.aliases))
        for staple_id in staple_ids:
            staple = self._staples_by_id.get(staple_id)
            if staple is not None:
                names.append(staple.name)
        words: set[str] = set()
        for name in names:
            for token in tokenise(name):
                words.add(token)
                words.update(v[0] for v in _plural_variants((token,)))
        return frozenset(words)

    def mentions(self, text: str, ingredient_id: str) -> bool:
        """True when `text` names that ingredient by name, alias or plural, its bare family word or
        (for a pickable staple) the staple's bare short form. Longest-first span recognition; no
        stop word, family exemption or declared-staple allowance applies."""
        ingredient = self._by_id.get(ingredient_id)
        for (kind, key), span in _spans(_without_ignored(tokenise(text)), self._dictionary):
            if key == ingredient_id and kind in ("ingredient", "staple"):
                return True
            if (
                kind == "family"
                and ingredient is not None
                and key == ingredient.family
                and not (len(span) == 1 and span[0] in self.culinary_words)
            ):
                return True
        return False

    def food_free_tokens(self, text: str) -> tuple[str, ...]:
        """The folded tokens of `text` left after removing every recognised food span, so a food
        such as "baking powder" is never read as a technique or vessel word."""
        tokens = tokenise(text)
        kept: list[str] = []
        i = 0
        for _entity, span in _spans(tokens, self._dictionary):
            while tokens[i : i + len(span)] != span:
                kept.append(tokens[i])
                i += 1
            i += len(span)
        kept.extend(tokens[i:])
        return tuple(kept)

    # -- the contraband scan (spec §3.2) --------------------------------------------------------

    def find_contraband_ingredients(
        self,
        text: str,
        *,
        allowed_ingredient_ids: AbstractSet[str],
        allowed_staple_ids: AbstractSet[str],
        omitted_ingredient_ids: AbstractSet[str] = frozenset(),
        allow_omitted_mentions: bool = False,
    ) -> list[str]:
        """Foods named in `text` that the concept/recipe may not name, as bank display names in
        order of first appearance (so the repair run can be told the exact words).

        The dictionary is every ingredient name and alias (with simple plurals) plus the free
        seasonings; matching is word-boundary, case- and accent-folded, and the LONGEST span wins
        before anything is judged ("peanut butter" is one food, not "butter"). A span is judged
        once and consumes its words; an allowed compound protects only its own interior.

        A span whose words all come from the names and aliases of the used picks and declared
        staples, or from stop/culinary words (at least one from the former), is a cook's shorthand
        or a by-product of what the dish uses and is never contraband; a bare culinary word
        ("crisp", "juices", "gravy") is never read as a food at all.

        Pass 1 (dictionary): a hit is allowed when it is a used pick (`allowed_ingredient_ids`) or
        shares a family with one, a free seasoning, a declared staple (`allowed_staple_ids`), or a
        bare stop word. Pass 2 (manifest, never softened by stop words or families): any mention of
        an omitted basket item, and any undeclared non-seasoning staple (including the bare words
        butter/flour/oil/sugar/milk). `allow_omitted_mentions=True` is the `omitted[].reason`
        mode: the omitted items count as allowed and pass 2 is off.
        """
        allowed_ids = set(allowed_ingredient_ids)
        if allow_omitted_mentions:
            allowed_ids |= set(omitted_ingredient_ids)
        allowed_families = {
            entry.family for i in allowed_ids if (entry := self._by_id.get(i)) is not None
        }
        declared_staples = set(allowed_staple_ids) | UNPICKABLE_STAPLES
        omitted = set(omitted_ingredient_ids)
        covered = self._covered_tokens(
            allowed_ids, {sid for sid in declared_staples if sid not in UNPICKABLE_STAPLES}
        )
        plain = self.stop_words | self.culinary_words
        found: list[str] = []

        def is_exact_omitted(entity: _Entity, tokens: tuple[str, ...]) -> bool:
            """An omitted pick named in full (its own multi-word name or alias) is never
            shorthand; a bare shared word is."""
            kind, key = entity
            if allow_omitted_mentions or kind != "ingredient" or key not in omitted:
                return False
            return len(tokens) > 1 and key not in allowed_ids

        def report(entity: _Entity) -> None:
            kind, key = entity
            name = key.replace("-", " ")
            if kind == "ingredient":
                found_ingredient = self._by_id.get(key)
                name = found_ingredient.name if found_ingredient is not None else key
            elif kind == "staple":
                found_staple = self._staples_by_id.get(key)
                name = found_staple.name if found_staple is not None else key
            if name not in found:
                found.append(name)

        for entity, tokens in _spans(_without_ignored(tokenise(text)), self._dictionary):
            kind, key = entity
            is_omitted_hit = kind == "ingredient" and key in omitted and not allow_omitted_mentions
            if len(tokens) == 1 and tokens[0] in self.stop_words and not is_omitted_hit:
                continue
            if len(tokens) == 1 and tokens[0] in self.culinary_words:
                continue
            if (
                not is_exact_omitted(entity, tokens)
                and any(t in covered for t in tokens)
                and all(t in covered or t in plain for t in tokens)
            ):
                # Built only from words of what the dish uses and ordinary cooking language
                # ("oil" for vegetable oil, "mushroom sauce" from dried mushrooms).
                continue
            if kind == "ingredient":
                is_staple = key in NON_SEASONING_STAPLES
                if not allow_omitted_mentions and key in omitted:
                    report(entity)
                elif key in allowed_ids or (is_staple and key in declared_staples):
                    continue
                elif self._by_id[key].family in allowed_families and not is_staple:
                    continue
                else:
                    report(entity)
            elif kind == "staple":
                if key not in UNPICKABLE_STAPLES and key not in declared_staples:
                    if key not in allowed_ids:
                        report(entity)
            elif key not in allowed_families:
                report(entity)
        return found


def _without_ignored(tokens: tuple[str, ...]) -> tuple[str, ...]:
    kept: list[str] = []
    i = 0
    while i < len(tokens):
        for phrase in IGNORED_PHRASES:
            if tokens[i : i + len(phrase)] == phrase:
                i += len(phrase)
                break
        else:
            kept.append(tokens[i])
            i += 1
    return tuple(kept)


def _spans(
    tokens: tuple[str, ...], dictionary: Mapping[tuple[str, ...], _Entity]
) -> list[tuple[_Entity, tuple[str, ...]]]:
    """Left-to-right longest-first recognition: each hit consumes its tokens."""
    longest = max((len(k) for k in dictionary), default=0)
    hits: list[tuple[_Entity, tuple[str, ...]]] = []
    i = 0
    while i < len(tokens):
        for length in range(min(longest, len(tokens) - i), 0, -1):
            span = tokens[i : i + length]
            entity = dictionary.get(span)
            if entity is not None:
                hits.append((entity, span))
                i += length
                break
        else:
            i += 1
    return hits


def _group(pool: Sequence[Ingredient]) -> dict[str, dict[str, list[Ingredient]]]:
    grouped: dict[str, dict[str, list[Ingredient]]] = {}
    for entry in pool:
        grouped.setdefault(entry.category, {}).setdefault(entry.family, []).append(entry)
    return grouped


def _has_other_family(families: Mapping[str, list[Ingredient]], family: str) -> bool:
    return any(f != family for f in families)


def _all_prefixes(wanted: tuple[str, ...], tokens: tuple[str, ...]) -> bool:
    return all(any(t.startswith(w) for t in tokens) for w in wanted)


def _feasible_first_options(
    grouped: Mapping[str, Mapping[str, list[Ingredient]]],
    *,
    need_everyday: bool = True,
) -> dict[str, list[str]]:
    """For each category that can supply the guaranteed-everyday option (any entry when
    `need_everyday` is False, i.e. an all-exotic pool): the families that have such an entry AND
    leave a valid partner (another category with a different family)."""
    feasible: dict[str, list[str]] = {}
    for category, families in grouped.items():
        usable = [
            family
            for family, entries in families.items()
            if (not need_everyday or any(e.rarity == "everyday" for e in entries))
            and any(c != category and _has_other_family(grouped[c], family) for c in grouped)
        ]
        if usable:
            feasible[category] = usable
    return feasible


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


def _stop_words(raw: object) -> frozenset[str]:
    if not isinstance(raw, list) or len(raw) > MAX_STOP_WORDS:
        raise CookoutBankError(f"stopWords must be a list of at most {MAX_STOP_WORDS}")
    words: list[str] = []
    for index, word in enumerate(raw):
        text = _text(f"stopWord #{index + 1}", word, maximum=30)
        if text != fold(text) or len(tokenise(text)) != 1:
            raise CookoutBankError(f"stopWord {text!r}: must be one lowercase word")
        if text in FORBIDDEN_STOP_WORDS:
            raise CookoutBankError(f"stopWord {text!r}: a staple food name is never a stop word")
        words.append(text)
    if len(set(words)) != len(words):
        raise CookoutBankError("stopWords: duplicates")
    return frozenset(words)


def _culinary_words(raw: object, stop_words: frozenset[str]) -> frozenset[str]:
    if not isinstance(raw, list) or len(raw) > MAX_CULINARY_WORDS:
        raise CookoutBankError(f"culinaryWords must be a list of at most {MAX_CULINARY_WORDS}")
    words: list[str] = []
    for index, word in enumerate(raw):
        text = _text(f"culinaryWord #{index + 1}", word, maximum=30)
        if text != fold(text) or len(tokenise(text)) != 1:
            raise CookoutBankError(f"culinaryWord {text!r}: must be one lowercase word")
        if text in FORBIDDEN_CULINARY_WORDS:
            raise CookoutBankError(f"culinaryWord {text!r}: a staple is never a culinary word")
        if text in stop_words:
            raise CookoutBankError(f"culinaryWord {text!r}: already a stop word")
        words.append(text)
    if len(set(words)) != len(words):
        raise CookoutBankError("culinaryWords: duplicates")
    return frozenset(words)


def parse_cookout_bank(raw: object) -> CookoutBank:
    """Validate an already-decoded bank document and build the typed bank."""
    if not isinstance(raw, dict):
        raise CookoutBankError("the bank must be a JSON object")
    _expect_keys(
        "bank",
        raw,
        {
            "version",
            "generated",
            "categories",
            "staples",
            "stopWords",
            "culinaryWords",
            "ingredients",
        },
    )
    if raw["version"] != BANK_VERSION or isinstance(raw["version"], bool):
        raise CookoutBankError(f"bank version must be {BANK_VERSION}")
    generated = raw["generated"]
    if not isinstance(generated, str) or not _DATE_RE.fullmatch(generated):
        raise CookoutBankError("bank generated must be a YYYY-MM-DD date")
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
    stop_words = _stop_words(raw["stopWords"])
    culinary_words = _culinary_words(raw["culinaryWords"], stop_words)

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
    food_words = {
        t[0] for i in ingredients for n in (i.name, *i.aliases) if len(t := tokenise(n)) == 1
    }
    for word in sorted(culinary_words & food_words):
        raise CookoutBankError(f"culinaryWord {word!r} is a food word (an ingredient's own name)")
    food_words |= {i.family for i in ingredients}
    for word in sorted(stop_words & food_words):
        raise CookoutBankError(f"stopWord {word!r} is a food word (an ingredient name or family)")
    for role in ROLES:
        if sum(1 for i in ingredients if i.role == role) < MIN_PER_ROLE:
            raise CookoutBankError(f"role {role} has fewer than {MIN_PER_ROLE} ingredients")
    return CookoutBank(
        categories=categories,
        staples=staples,
        ingredients=ingredients,
        stop_words=stop_words,
        culinary_words=culinary_words,
    )


def load_cookout_bank(path: Path | None = None) -> CookoutBank:
    """Load and strictly validate the bank at `path`; raises `CookoutBankError`."""
    target = path or BANK_PATH
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CookoutBankError(f"cannot read the bank {target}: {exc}") from exc
    return parse_cookout_bank(raw)


def load_cookout_bank_or_empty(path: Path | None = None) -> CookoutBank:
    """What `create_app` uses: a broken bank is logged and replaced by an empty one so the rest of
    Server chat still starts; the game is then unavailable (`bank.ingredients` is empty)."""
    try:
        return load_cookout_bank(path)
    except CookoutBankError:
        _LOGGER.exception("Cookout ingredient bank unusable — the game is DISABLED")
        return CookoutBank.empty()
