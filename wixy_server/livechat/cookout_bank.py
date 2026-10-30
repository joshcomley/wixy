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
from functools import cache
from pathlib import Path
from typing import Literal

_LOGGER = logging.getLogger(__name__)

BANK_PATH = Path(__file__).with_name("cookout_ingredients.json")
BANK_VERSION = 1

RoleKey = Literal["base", "protein", "produce", "accent"]
RarityKey = Literal["everyday", "uncommon", "exotic"]
RarityMode = Literal["normal", "exotic"]
Facet = Literal["category", "family"]

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
    ("tea", "towel"),
)
"""Fixed phrases the scan never reads as a food: "date night" is an evening out, not the fruit;
"a dab of", "wafer-thin" and a bare "grit" are a measure, an adjective and a speck, not the
fish, the biscuit or grits."""

HEAD_MODIFIERS = frozenset(
    {
        "dried", "frozen", "tinned", "smoked", "cured", "salted", "whole", "fresh", "ground",
        "minced", "sliced", "diced", "cooked", "roast", "roasted", "raw", "mixed", "wild", "baby",
        "sea", "salt", "ready", "canned", "pickled", "baked", "fried", "grilled", "breaded",
        "battered",
        "potted", "jellied", "spiced", "marinated", "sweet", "sour", "hot", "cold", "red", "white",
        "black", "green", "yellow", "brown", "dark", "light", "king", "giant", "great", "large",
        "small", "streaky", "back", "lean", "free", "organic", "british", "scottish", "cut",
    }
)  # fmt: skip
"""Leading words of meat and fish names that are modifiers, not the food. A phrase is also never
shorthand for a pick through these words alone ("brown sauce" from brown crab, "white sauce" from
white bread): its head food noun has to be covered (round 2 audit F2)."""

# Words that make a bare culinary by-product word the cook's own shorthand for a pick
# ("pastry" for a pie, pasty, quiche, tart, samosa or wellington that was picked).
IMPLIED_WORDS: Mapping[str, frozenset[str]] = {
    "pie": frozenset({"pastry"}),
    "pies": frozenset({"pastry"}),
    "pasty": frozenset({"pastry"}),
    "pasties": frozenset({"pastry"}),
    "quiche": frozenset({"pastry"}),
    "tart": frozenset({"pastry"}),
    "tartlet": frozenset({"pastry"}),
    "samosa": frozenset({"pastry"}),
    "samosas": frozenset({"pastry"}),
    "wellington": frozenset({"pastry"}),
    "turnover": frozenset({"pastry"}),
}

RAW_EGG_FORMS = frozenset(
    {
        "omelette", "frittata", "beaten", "poached", "scrambled", "boiled", "fried",
        "yolk", "yolks", "white", "whites", "soft", "hard",
    }
)  # fmt: skip
"""Forms of a raw or whole egg pick that a cook names bare ("a poached egg", "the yolk")."""

PASTA_SHAPE_FAMILIES = frozenset(
    {"tube-pasta", "spiral-pasta", "elbow-pasta", "long-pasta", "thin-long-pasta", "soup-pasta"}
)
"""Pasta-shape families that a generic picked pasta ("lentil pasta") may be shaped as."""

BARE_ONLY_WORDS = frozenset({"fish", "sage", "onion"})
"""Words a pick allows only when they stand alone ("the fish juices", "a sage and onion crumb"):
never inside a longer food span ("fish sauce", "onion rings") and never as a shorthand source."""

BYPRODUCT_HEADS = frozenset(
    {
        "sauce", "stock", "broth", "gravy", "jus", "juice", "fat", "glaze", "puree", "purée",
        "coulis", "compote", "salsa", "pesto", "syrup", "jam", "jelly", "curd", "dressing",
        "marinade", "paste", "butter", "oil", "sugar", "mayonnaise", "yoghurt",
    }
)  # fmt: skip
"""The last word a curated by-product may end in (audit F4). Deliberately NOT here: cream, water,
wrap, bake, pie, mix, granules, flour, milk, salt, vinegar, spread, crisps, soup, starch, meal, so
salad cream, water chestnut, spinach wrap, steak bake, pork pie, stuffing mix, gravy granules,
soda water and rose water can never be whitelisted, even by mistake."""

CARRIER_HEADS = frozenset({"butter", "oil", "sugar", "mayonnaise", "yoghurt"})
"""By-products whose last word is a carrier the dish must itself supply ("garlic butter" needs
butter picked or declared)."""

MAX_BYPRODUCTS = 250

KITCHEN_SOURCES = frozenset({"sugar", "butter", "egg", "milk", "oil"})
"""Co-ingredients a by-product may name as a source although its name does not ("strawberry jam"
needs sugar, "lemon curd" egg and butter, "bread sauce" milk): the only sources not in the key."""

SKIPPABLE_WORDS = HEAD_MODIFIERS | frozenset(
    {"chopped", "peeled", "pitted", "halved", "crushed", "shredded", "grated"}
)
"""Words a pick-run may step over between matched words of a name ("sliced white bread" for
"gluten-free white bread")."""

CUT_FORM_WORDS = frozenset(
    {
        "granules", "powder", "flakes", "slices", "slice", "chunks", "pieces", "cubes", "strips",
        "wedges", "segments", "mince", "minced", "fillet", "fillets", "steak", "steaks", "chop",
        "chops", "breast", "breasts", "thigh", "thighs", "leg", "legs", "wing", "wings", "joint",
        "loin", "rump", "shoulder", "belly", "cutlet", "cutlets", "escalope", "escalopes", "chump",
        "rack", "shank", "shanks", "haunch", "drumstick", "drumsticks", "tenderloin", "sirloin",
        "ribeye", "brisket", "neck", "cheek", "cheeks", "liver", "livers", "kidney", "kidneys",
        "heart", "tail", "tails", "puree", "purée", "mash", "halves", "quarters", "florets",
        "cloves", "clove", "dough", "sprigs", "sprig", "stalks", "stalk", "stems", "bulbs", "bulb",
        "heads", "pods", "spice", "spices",
    }
)  # fmt: skip
"""Cut and form words at the end of a name: the food behind them ("onion" in dried onion granules,
"chicken" in chicken breast) is still a head noun of the pick."""

CONTAINER_WORDS = frozenset(
    {
        "pot", "pots", "jar", "jars", "tin", "tins", "pack", "packet", "tub", "bottle", "sachet",
        "pouch", "pouches", "bag", "tray", "whole",
    }
)  # fmt: skip
"""Trailing pack words that are not part of the food ("beef stock pot" -> beef stock)."""

NOT_BARE_PREFIXES = frozenset({"sea", "bone", "water", "chocolate"})
"""A leading word that makes the name a different food from its last word: sea cucumber is not a
cucumber, bone marrow is not marrow (round 2 audit F2)."""

SHAPE_WORDS = frozenset({"ring", "rings"})
"""Cut or shape words ("pineapple rings") that never make a second food of a picked one."""

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
    byproducts: Mapping[tuple[str, ...], tuple[tuple[str, ...], ...]] = field(default_factory=dict)
    _by_id: Mapping[str, Ingredient] = field(init=False, repr=False, compare=False)
    _staples_by_id: Mapping[str, Staple] = field(init=False, repr=False, compare=False)
    _by_role: Mapping[str, tuple[Ingredient, ...]] = field(init=False, repr=False, compare=False)
    _dictionary: Mapping[tuple[str, ...], _Entity] = field(init=False, repr=False, compare=False)
    _food_heads: frozenset[str] = field(init=False, repr=False, compare=False)
    _byproduct_lookup: Mapping[tuple[str, ...], tuple[tuple[str, ...], ...]] = field(
        init=False, repr=False, compare=False
    )

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
        # "brown sugar" for "Light soft brown sugar": the last two words of a longer name that
        # ends in a staple word are a food phrase of their own (review L3).
        for ingredient in self.ingredients:
            words = tokenise(ingredient.name)
            if len(words) >= 3 and words[-1] in STAPLE_SHORT_FORMS and len(words[-2]) >= 3:
                dictionary.setdefault(words[-2:], ("ingredient", ingredient.id))
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
        object.__setattr__(self, "_food_heads", self._meat_fish_heads())
        lookup: dict[tuple[str, ...], tuple[tuple[str, ...], ...]] = {}
        for key, sources in self.byproducts.items():
            lookup.setdefault(key, sources)
            for variant in _plural_variants(key):
                lookup.setdefault(variant, sources)
        object.__setattr__(self, "_byproduct_lookup", lookup)

    def _meat_fish_heads(self) -> frozenset[str]:
        """The leading word of three or more meat, poultry or fish names that is not a modifier
        ("chicken", "beef", "pork", "salmon"): the foods a chef names bare before a culinary word
        ("chicken broth") without the dictionary ever seeing a one-word entry for them."""
        counts: Counter[str] = Counter()
        for ingredient in self.ingredients:
            if ingredient.category in ("meat-poultry", "fish-seafood"):
                words = tokenise(ingredient.name)
                if words:
                    counts[words[0]] += 1
        heads = {w for w, n in counts.items() if n >= 3 and len(w) >= 3} - HEAD_MODIFIERS
        heads.update(v[0] for w in list(heads) for v in _plural_variants((w,)))
        return frozenset(heads)

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
        candidates: Sequence[Ingredient] | None = None,
        facet: Facet = "category",
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

        `candidates` replaces the role's pool (a game mode's pick kind). `facet="family"` swaps
        the variety axis: the two options need only come from two different families (no category
        rule) and `player_offered_categories` then carries the families already shown to the
        active player. The defaults are the Classic draw, unchanged.
        """
        generator = rng or _SYSTEM_RNG
        exotic = rarity_mode == "exotic"
        eligible = [
            i
            for i in (self.by_role(role) if candidates is None else candidates)
            if i.id not in seen_ids
            and i.family not in picked_families
            and (not exotic or i.rarity == "exotic")
        ]
        for pool in (
            [i for i in eligible if i.family not in offered_families],
            eligible,
        ):
            grouped = _group(pool, by_family=facet == "family")
            feasible = _feasible_first_options(
                grouped, need_everyday=not exotic, same_group_partner=facet == "family"
            )
            if feasible:
                break
        else:
            raise CookoutExhaustedError(f"no feasible {role} pair remains")

        if facet == "family":
            return self._draw_family_pair(
                grouped, player_offered_categories, generator, exotic=exotic
            )

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

    @staticmethod
    def _draw_family_pair(
        grouped: Mapping[str, Mapping[str, list[Ingredient]]],
        shown_families: Sequence[str],
        generator: random.Random,
        *,
        exotic: bool,
    ) -> tuple[Ingredient, Ingredient]:
        """The `facet="family"` pair: `grouped` is the single group `""` of family -> entries
        (`_group(by_family=True)`). The least-shown family leads with an `everyday` entry (any
        entry when `exotic`), then the least-shown other family supplies the weighted second
        option."""
        families = grouped[""]
        counts = Counter(shown_families)
        first_ok = sorted(
            _feasible_first_options(grouped, need_everyday=not exotic, same_group_partner=True)[""]
        )
        lowest = min(counts[f] for f in first_ok)
        fam_a = generator.choice([f for f in first_ok if counts[f] == lowest])
        first_tier = [e for e in families[fam_a] if exotic or e.rarity == "everyday"]
        option_one = generator.choice(sorted(first_tier, key=lambda e: e.id))
        counts[fam_a] += 1
        partners = sorted(f for f in families if f != fam_a)
        lowest_partner = min(counts[f] for f in partners)
        fam_b = generator.choice([f for f in partners if counts[f] == lowest_partner])
        by_tier: dict[RarityKey, list[Ingredient]] = {}
        for entry in families[fam_b]:
            by_tier.setdefault(entry.rarity, []).append(entry)
        tiers = [t for t in RARITIES if t in by_tier]
        tier = generator.choices(tiers, weights=[RARITY_WEIGHTS[t] for t in tiers])[0]
        option_two = generator.choice(sorted(by_tier[tier], key=lambda e: e.id))
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
        candidates: Sequence[Ingredient] | None = None,
        facet: Facet = "category",
    ) -> Ingredient:
        """One fresh option for `role` that keeps the pair with `keep_id` legal (partner veto, T8).

        HARD: unseen, family not picked, and a different category AND family from the kept option.
        `"normal"`: when the kept option is not `everyday` the replacement must be, otherwise the
        usual 8:3:1 tiers; `"exotic"` (the live pair is a chaos pair): exotic only. SOFT: families
        already offered are avoided while any candidate exists without them. The active player's
        least-shown category wins, then a uniform family, then entry. Nothing feasible raises
        `CookoutExhaustedError`.

        `candidates` replaces the role's pool. With `facet="family"` only the family must differ
        from the kept option, and the least-shown tie-break counts families instead of categories
        (`player_offered_categories` then carries families).
        """
        keep = self._by_id.get(keep_id)
        if keep is None:
            raise CookoutBankError(f"unknown ingredient {keep_id!r}")
        generator = rng or _SYSTEM_RNG
        exotic = rarity_mode == "exotic"
        must_be_everyday = not exotic and keep.rarity != "everyday"
        eligible = [
            i
            for i in (self.by_role(role) if candidates is None else candidates)
            if i.id not in seen_ids
            and i.family not in picked_families
            and (facet == "family" or i.category != keep.category)
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
        if facet == "family":
            shown = {e.family for e in by_tier[tier]}
            least = min(counts[f] for f in shown)
            family = generator.choice(sorted(f for f in shown if counts[f] == least))
            return generator.choice(
                sorted((e for e in by_tier[tier] if e.family == family), key=lambda e: e.id)
            )
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
        candidates: Sequence[Ingredient] | None = None,
    ) -> Ingredient:
        """The surprise eleventh ingredient behind the cloche (T5): any role, never `everyday` (it
        is a dare), never one of the five pickable staples, never seen, never from a picked family.
        Tiers `uncommon : exotic = 1 : 1` among those available. SOFT preferences, relaxed in
        order: a category the basket does not hold yet, then a family not yet offered. Nothing
        feasible raises `CookoutExhaustedError`. `candidates` replaces the whole bank as the pool
        (a game mode's filling kinds)."""
        generator = rng or _SYSTEM_RNG
        eligible = [
            i
            for i in (self.ingredients if candidates is None else candidates)
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

    def search(
        self,
        query: str,
        *,
        limit: int = 20,
        candidates: Sequence[Ingredient] | None = None,
    ) -> tuple[Ingredient, ...]:
        """Fridge-raid search: an ingredient matches when every query token is a prefix of some
        token of its name, or of one of its aliases. Ranked exact name, name prefix, other name
        match, alias match, then rarity (`everyday` first), then name. `candidates` replaces the
        whole bank as the searched pool."""
        wanted = tokenise(query)
        if not wanted or limit <= 0:
            return ()
        phrase = " ".join(wanted)
        ranked: list[tuple[int, int, str, str, Ingredient]] = []
        for ingredient in self.ingredients if candidates is None else candidates:
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

    @staticmethod
    def _name_words(name: str) -> list[str]:
        return list(_trimmed_words(name))

    def _pick_run(
        self,
        span: tuple[str, ...],
        names: list[tuple[str, Ingredient | None]],
        *,
        with_implied: bool,
    ) -> str | None:
        """The name of a pick or staple whose words contain `span` as an order-preserving run that
        may skip only modifier words and holds a head noun of that name (audit F4, rule A): the
        pick's own name written short. The one place a multi-word span is judged against what
        the dish uses; no word of the span is ever discarded except a pick's implied words."""
        for name, entry in names:
            core = span
            if with_implied:
                implied = self._implied_words(name, entry) - BARE_ONLY_WORDS
                core = tuple(t for t in span if t not in implied)
            if not core:
                continue
            heads = self._name_heads(name)
            if not any(t in heads for t in core if t not in HEAD_MODIFIERS):
                continue
            if _subseq(core, self._name_words(name)):
                return name
        return None

    def _byproduct_satisfied(
        self,
        key: tuple[str, ...],
        names: list[tuple[str, Ingredient | None]],
        animals: AbstractSet[str],
    ) -> str | None:
        """Why the curated by-product `key` is made from what the dish uses, or None: every
        source phrase must be a pick-run (no implied words) or, for one word, the first word of a
        used meat or fish pick ("pork" from pork collar for pork bone broth)."""
        sources = self._byproduct_lookup.get(key)
        if sources is None:
            return None
        satisfied: list[str] = []
        for source in sources:
            by = self._pick_run(
                source, [n for n in names if _fits_source(source, n[0])], with_implied=False
            )
            if by is None and len(source) == 1 and source[0] in animals:
                by = source[0]
            if by is None:
                return None
            satisfied.append(by)
        return "; ".join(satisfied)

    def _multi_word_pass(
        self,
        tokens: tuple[str, ...],
        kind: str,
        names: list[tuple[str, Ingredient | None]],
        animals: AbstractSet[str],
        canonical: tuple[str, ...] = (),
    ) -> str | None:
        """Why a multi-word span is not contraband, or None. Rule A (the pick written short, a
        trailing ring/rings shape allowed) or rule B (a curated by-product whose sources the dish
        supplies); the same-family and pasta-shape exemptions are applied by the caller."""
        judged = tokens[:-1] if len(tokens) > 1 and tokens[-1] in SHAPE_WORDS else tokens
        if any(t not in HEAD_MODIFIERS for t in judged):
            run = self._pick_run(judged, names, with_implied=True)
            if run is not None:
                return f"ring-shape({run})" if judged != tokens else f"pick-run({run})"
        if kind == "ingredient":
            # The span as written, then the bank's own name for the product it is an alias of
            # ("garlic dip" is the listed "garlic sauce").
            for written in (tokens, canonical):
                key = written
                while len(key) > 1 and key[-1] in CONTAINER_WORDS:
                    key = key[:-1]
                by = self._byproduct_satisfied(key, names, animals) if key else None
                if by is not None:
                    return f"byproduct({' '.join(key)}, {by})"
        return None

    def _picked_occurrences(
        self, tokens: tuple[str, ...], ingredient_ids: AbstractSet[str]
    ) -> list[tuple[int, int]]:
        """Where the used picks' own multi-word names/aliases (and plurals) stand in `tokens`."""
        wanted: set[tuple[str, ...]] = set()
        for ingredient_id in ingredient_ids:
            entry = self._by_id.get(ingredient_id)
            if entry is None:
                continue
            for name in (entry.name, *entry.aliases):
                words = tokenise(name)
                if len(words) > 1:
                    wanted.add(words)
                    wanted.update(_plural_variants(words))
                    # A chef's own shortening of a pick's name ("pepperoni pizza" for frozen
                    # pepperoni pizza): its two-or-more-word starts and ends are the pick too.
                    for size in range(2, len(words)):
                        for part in (words[:size], words[-size:]):
                            wanted.add(part)
                            wanted.update(_plural_variants(part))
        found: list[tuple[int, int]] = []
        for words in wanted:
            for start in range(len(tokens) - len(words) + 1):
                if tokens[start : start + len(words)] == words:
                    found.append((start, start + len(words)))
        return found

    def _covered_tokens(
        self, ingredient_ids: AbstractSet[str], staple_ids: AbstractSet[str]
    ) -> frozenset[str]:
        """Every word (and its simple singular/plural) in the names and aliases of the given picks
        and staples: the words a cook may use bare for something the dish does use ("oil" for
        vegetable oil, "mushroom" for dried mixed mushrooms)."""
        names = self._pick_names(ingredient_ids, staple_ids)
        words: set[str] = set()
        for name, extra in names:
            words.update(self._name_heads(name))
            words.update(self._implied_words(name, extra))
        return frozenset(words)

    def _name_heads(self, name: str) -> frozenset[str]:
        return _head_nouns(name)

    def _pick_names(
        self, ingredient_ids: AbstractSet[str], staple_ids: AbstractSet[str]
    ) -> list[tuple[str, Ingredient | None]]:
        names: list[tuple[str, Ingredient | None]] = []
        for ingredient_id in ingredient_ids:
            entry = self._by_id.get(ingredient_id)
            if entry is not None:
                names.extend((n, entry) for n in (entry.name, *entry.aliases))
        for staple_id in staple_ids:
            staple = self._staples_by_id.get(staple_id)
            if staple is not None:
                names.append((staple.name, None))
        return names

    @staticmethod
    def _implied_words(name: str, entry: Ingredient | None) -> frozenset[str]:
        return _implied_for(name, entry)

    def mentions(self, text: str, ingredient_id: str) -> bool:
        """True when `text` names that ingredient by name, alias or plural, its bare family word or
        (for a pickable staple) the staple's bare short form. Longest-first span recognition; no
        stop word, family exemption or declared-staple allowance applies."""
        ingredient = self._by_id.get(ingredient_id)
        for clause in _clauses(text):
            for (kind, key), span in _spans(_without_ignored(tokenise(clause)), self._dictionary):
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
        kept: list[str] = []
        for clause in _clauses(text):
            tokens = tokenise(clause)
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
        reasons: list[tuple[str, str]] | None = None,
    ) -> list[str]:
        """The contraband scan (see `_find_in_clause`), run clause by clause: a food span never
        crosses a comma, full stop, semicolon, colon, bracket or spaced dash ("Prepare the Lemon,
        Salt and Black pepper" is three foods, not "Lemon salt")."""
        found: list[str] = []
        for clause in _clauses(text):
            for name in self._find_in_clause(
                clause,
                allowed_ingredient_ids=allowed_ingredient_ids,
                allowed_staple_ids=allowed_staple_ids,
                omitted_ingredient_ids=omitted_ingredient_ids,
                allow_omitted_mentions=allow_omitted_mentions,
                reasons=reasons,
            ):
                if name not in found:
                    found.append(name)
        return found

    def _find_in_clause(
        self,
        text: str,
        *,
        allowed_ingredient_ids: AbstractSet[str],
        allowed_staple_ids: AbstractSet[str],
        omitted_ingredient_ids: AbstractSet[str] = frozenset(),
        allow_omitted_mentions: bool = False,
        reasons: list[tuple[str, str]] | None = None,
    ) -> list[str]:
        """Foods named in `text` that the concept/recipe may not name, as bank display names in
        order of first appearance (so the repair run can be told the exact words).

        The dictionary is every ingredient name and alias (with simple plurals) plus the free
        seasonings; matching is word-boundary, case- and accent-folded, and the LONGEST span wins
        before anything is judged ("peanut butter" is one food, not "butter"). A span is judged
        once and consumes its words; an allowed compound protects only its own interior.

        A multi-word bank product that is not a used pick passes only as (A) the pick's own name
        written short (an order-preserving run of one name, skipping only modifier words), (B) an
        entry of the curated `byproducts` list whose sources the dish supplies, (C) the same-family
        exemption or (D) a shape of a generic picked pasta; no word of the span is ever discarded
        (audit F4). A bare culinary word ("crisp", "juices", "gravy") is never read as a food at
        all. `reasons`, when given, collects (phrase, why) for every span that passed.

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
        plain = self.stop_words | self.culinary_words | SHAPE_WORDS
        generic_pasta = any(
            (entry := self._by_id.get(i)) is not None
            and tokenise(entry.name)[-1:] == ("pasta",)
            and entry.family not in PASTA_SHAPE_FAMILIES
            for i in allowed_ids - omitted
        )
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

        used_names = self._pick_names(
            allowed_ids, {sid for sid in declared_staples if sid not in UNPICKABLE_STAPLES}
        )
        picked_words = covered.union(
            *(
                {*tokenise(n), *(v[0] for t in tokenise(n) for v in _plural_variants((t,)))}
                for n, _ in used_names
            )
        )
        animals = {
            words[0]
            for i in allowed_ids - omitted
            if (e := self._by_id.get(i)) is not None
            and e.category in ("meat-poultry", "fish-seafood")
            and (words := tokenise(e.name))
            and words[0] in self._food_heads
        }
        text_tokens = _without_ignored(tokenise(text), picked_words)
        occurrences = self._picked_occurrences(text_tokens, allowed_ids - omitted)
        consumed: set[int] = set()

        def why(span: tuple[str, ...], reason: str) -> None:
            if reasons is not None:
                reasons.append((" ".join(span), reason))

        for entity, tokens, start in _spans_at(text_tokens, self._dictionary):
            consumed.update(range(start, start + len(tokens)))
            kind, key = entity
            end = start + len(tokens)
            if any(
                start < pe
                and ps < end
                and not (start <= ps and pe <= end)
                and not (ps <= start and end <= pe)
                for ps, pe in occurrences
            ):
                # A prep word that shares a word with a used pick's name ("diced pork" in "diced
                # pork loin chop"): the span is the pick's own name plus a modifier.
                why(tokens, "own-name-overlap")
                continue
            if len(tokens) == 1 and any(ps <= start and end <= pe for ps, pe in occurrences):
                why(tokens, "own-name")
                continue  # a word of a used pick's own (shortened) name as the chef wrote it
            is_omitted_hit = kind == "ingredient" and key in omitted and not allow_omitted_mentions
            if kind == "ingredient" and generic_pasta and not is_omitted_hit:
                hit = self._by_id.get(key)
                if hit is not None and hit.family in PASTA_SHAPE_FAMILIES:
                    # A shape named for a picked generic pasta ("small shapes such as penne").
                    why(tokens, "pasta-shape")
                    continue
            if len(tokens) == 1 and tokens[0] in self.stop_words and not is_omitted_hit:
                why(tokens, "stop-word")
                continue
            if len(tokens) == 1 and tokens[0] in self.culinary_words:
                why(tokens, "culinary-word")
                continue
            if not is_exact_omitted(entity, tokens):
                if len(tokens) == 1:
                    if tokens[0] in covered:
                        why(tokens, "covered-word")
                        continue
                else:
                    canonical = tokenise(self._by_id[key].name) if kind == "ingredient" else ()
                    passed = self._multi_word_pass(tokens, kind, used_names, animals, canonical)
                    if passed is not None:
                        why(tokens, passed)
                        continue
            if kind == "ingredient":
                is_staple = key in NON_SEASONING_STAPLES
                if not allow_omitted_mentions and key in omitted:
                    report(entity)
                elif key in allowed_ids or (is_staple and key in declared_staples):
                    why(tokens, "pick")
                    continue
                elif self._by_id[key].family in allowed_families and not is_staple:
                    why(tokens, "family")
                    continue
                else:
                    report(entity)
            elif kind == "staple":
                if key not in UNPICKABLE_STAPLES and key not in declared_staples:
                    if key not in allowed_ids:
                        report(entity)
                else:
                    why(tokens, "staple")
            elif key not in allowed_families:
                report(entity)
            else:
                why(tokens, "family")
        # A food word straight before a culinary word ("chicken broth") must itself be a pick.
        for index, token in enumerate(text_tokens):
            if index == 0 or token not in self.culinary_words or index - 1 in consumed:
                continue
            head = text_tokens[index - 1]
            if head in self._food_heads and head not in covered and head not in plain:
                if head not in found:
                    found.append(head)
        return found


@cache
def _head_nouns(name: str) -> frozenset[str]:
    """The head food noun of a name or alias (its last word, past trailing stop words such as
    "pot" or "sauce"), singular and plural: "squash" for butternut squash, "shallot" for
    banana shallot. A leading modifier ("banana", "carrot" in carrot juice) is never a head, so
    it is not a bare word the dish may use (round 2 audit F2)."""
    parts = tokenise(name)
    end = len(parts)
    while end > 1 and (parts[end - 1] in CONTAINER_WORDS or parts[end - 1] in SHAPE_WORDS):
        end -= 1
    if end > 1 and parts[end - 2] in NOT_BARE_PREFIXES:
        return frozenset()  # "sea cucumber", "bone marrow": not the bare food
    head = [parts[end - 1]]
    while end > 1 and parts[end - 1] in CUT_FORM_WORDS:
        end -= 1  # "dried onion granules", "lamb chump chop": the food stands behind the cut
        head.append(parts[end - 1])
    heads = set(head)
    for token in head:
        heads.update(v[0] for v in _plural_variants((token,)))
    return frozenset(heads)


@cache
def _implied_for(name: str, entry: Ingredient | None) -> frozenset[str]:
    """Words a cook uses bare for a pick without them being a second food: pastry for a pie,
    omelette or a poached egg for a raw egg, "sage and onion" for stuffing mix, "fish" for a
    pick the bank describes as a fish."""
    parts = tokenise(name)
    words: set[str] = set()
    for token in parts:
        words.update(IMPLIED_WORDS.get(token, ()))
    if parts[-2:] in (("sausage", "roll"), ("sausage", "rolls")):
        words.add("pastry")
    if entry is not None:
        if entry.family == "egg" and ("egg" in parts or "eggs" in parts):
            words.update(RAW_EGG_FORMS)  # only a raw egg (family egg): not cured, curried, boiled
        if entry.family == "stuffing":
            words.update({"sage", "onion"})
        if entry.category == "fish-seafood" and "fish" in tokenise(entry.blurb):
            words.add("fish")
    return frozenset(words)


@cache
def _trimmed_words(name: str) -> tuple[str, ...]:
    """A name's words with trailing pack words dropped ("beef stock pot" -> beef stock)."""
    words = list(tokenise(name))
    while len(words) > 1 and words[-1] in CONTAINER_WORDS:
        words.pop()
    return tuple(words)


NUT_BUTTER_WORDS = frozenset(
    {"almond", "peanut", "pecan", "cashew", "hazelnut", "cocoa", "shea", "walnut", "pistachio",
     "macadamia", "sesame", "sunflower", "seed", "nut", "apple", "butternut"}
)  # fmt: skip


def _fits_source(source: tuple[str, ...], name: str) -> bool:
    """Pecan, peanut or cocoa butter is no dairy butter: the carrier "butter" of a by-product
    (garlic butter, brown butter) is never supplied by a nut or seed butter."""
    if source != ("butter",):
        return True
    words = tokenise(name)
    return not (len(words) > 1 and words[-1] == "butter" and words[-2] in NUT_BUTTER_WORDS)


def _subseq(core: tuple[str, ...], words: list[str]) -> bool:
    """`core` is an order-preserving run of `words` that may skip only SKIPPABLE_WORDS between its
    matched words; its last word may be the singular or plural of the name's."""
    last = len(core) - 1
    last_forms = {core[last], *(v[0] for v in _plural_variants((core[last],)))}

    def hits(index: int, word: str) -> bool:
        return word in last_forms if index == last else word == core[index]

    for first, word in enumerate(words):
        if not hits(0, word):
            continue
        matched = 1
        if matched == len(core):
            return True
        for later in words[first + 1 :]:
            if hits(matched, later):
                matched += 1
                if matched == len(core):
                    return True
            elif later not in SKIPPABLE_WORDS:
                break
    return False


_CRISPS_SUBJECTS = frozenset(
    {
        "it", "they", "skin", "skins", "edges", "edge", "fat", "top", "crust", "surface",
        "exterior", "which", "that", "this", "outside", "base", "bottom",
    }
)  # fmt: skip
_CRISPS_VERB_AFTER = frozenset({"up", "until", "well"})
_CRISPS_CONJUNCTIONS = frozenset({"until", "till", "as", "once", "when", "so", "that"})


def _crisps_is_verb(
    tokens: tuple[str, ...], index: int, picked_words: AbstractSet[str] = frozenset()
) -> bool:
    """ "the skin crisps", "it crisps up", "so it catches and crisps" read the verb; everything
    else ("with crisps", "sprinkle crisps over", "crisps on top") reads the food. A verb needs a
    subject just before it, or is followed by up/until/well after one (round 2, review M1)."""
    before = tokens[index - 1] if index > 0 else ""
    after = tokens[index + 1] if index + 1 < len(tokens) else ""
    if before in _CRISPS_SUBJECTS:
        return True
    if before in picked_words and (
        after == "up"
        or (
            (after in _CRISPS_VERB_AFTER or after == "" or after.endswith("ly"))
            and any(t in _CRISPS_CONJUNCTIONS for t in tokens[max(0, index - 3) : index])
        )
    ):
        return True  # a picked food as the subject: "until the chicken crisps"
    if before in ("and", "then") and any(t in _CRISPS_SUBJECTS for t in tokens[:index]):
        return True
    return before in ("so", "that", "until", "till", "as", "once", "when") and after in (
        _CRISPS_VERB_AFTER | {""}
    )


_CLAUSE_BREAK_RE = re.compile(r"[,.;:!?()\[\]{}—–\n]|\s[-‐-‒]+\s")


def _clauses(text: str) -> list[str]:
    """`text` split at punctuation a food name never spans (hyphens inside words stay)."""
    return [part for part in _CLAUSE_BREAK_RE.split(text) if part.strip()]


def _without_ignored(
    tokens: tuple[str, ...], picked_words: AbstractSet[str] = frozenset()
) -> tuple[str, ...]:
    kept: list[str] = []
    i = 0
    while i < len(tokens):
        if tokens[i] == "crisps" and _crisps_is_verb(tokens, i, picked_words):
            i += 1
            continue
        for phrase in IGNORED_PHRASES:
            if tokens[i : i + len(phrase)] == phrase:
                i += len(phrase)
                break
        else:
            kept.append(tokens[i])
            i += 1
    return tuple(kept)


def _spans_at(
    tokens: tuple[str, ...], dictionary: Mapping[tuple[str, ...], _Entity]
) -> list[tuple[_Entity, tuple[str, ...], int]]:
    """Left-to-right longest-first recognition: each hit consumes its tokens (with its start)."""
    longest = max((len(k) for k in dictionary), default=0)
    hits: list[tuple[_Entity, tuple[str, ...], int]] = []
    i = 0
    while i < len(tokens):
        for length in range(min(longest, len(tokens) - i), 0, -1):
            span = tokens[i : i + length]
            entity = dictionary.get(span)
            if entity is not None:
                hits.append((entity, span, i))
                i += length
                break
        else:
            i += 1
    return hits


def _spans(
    tokens: tuple[str, ...], dictionary: Mapping[tuple[str, ...], _Entity]
) -> list[tuple[_Entity, tuple[str, ...]]]:
    return [(entity, span) for entity, span, _start in _spans_at(tokens, dictionary)]


def _group(
    pool: Sequence[Ingredient], *, by_family: bool = False
) -> dict[str, dict[str, list[Ingredient]]]:
    """category -> family -> entries; with `by_family` (the family facet) one group `""` holds
    every family, so the category rule never applies."""
    grouped: dict[str, dict[str, list[Ingredient]]] = {}
    for entry in pool:
        group = "" if by_family else entry.category
        grouped.setdefault(group, {}).setdefault(entry.family, []).append(entry)
    return grouped


def _has_other_family(families: Mapping[str, list[Ingredient]], family: str) -> bool:
    return any(f != family for f in families)


def _all_prefixes(wanted: tuple[str, ...], tokens: tuple[str, ...]) -> bool:
    return all(any(t.startswith(w) for t in tokens) for w in wanted)


def _feasible_first_options(
    grouped: Mapping[str, Mapping[str, list[Ingredient]]],
    *,
    need_everyday: bool = True,
    same_group_partner: bool = False,
) -> dict[str, list[str]]:
    """For each category that can supply the guaranteed-everyday option (any entry when
    `need_everyday` is False, i.e. an all-exotic pool): the families that have such an entry AND
    leave a valid partner (another category with a different family). `same_group_partner` (the
    family facet, one group) lets the partner come from the group itself."""
    feasible: dict[str, list[str]] = {}
    for category, families in grouped.items():
        usable = [
            family
            for family, entries in families.items()
            if (not need_everyday or any(e.rarity == "everyday" for e in entries))
            and any(
                (same_group_partner or c != category) and _has_other_family(grouped[c], family)
                for c in grouped
            )
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


def _byproducts(raw: object) -> dict[tuple[str, ...], tuple[tuple[str, ...], ...]]:
    """Shape check of the `byproducts` object: folded multi-word keys, lists of source phrases."""
    if not isinstance(raw, dict) or len(raw) > MAX_BYPRODUCTS:
        raise CookoutBankError(f"byproducts must be an object of at most {MAX_BYPRODUCTS} entries")
    out: dict[tuple[str, ...], tuple[tuple[str, ...], ...]] = {}
    for phrase, sources in raw.items():
        if not isinstance(phrase, str) or not isinstance(sources, list) or not sources:
            raise CookoutBankError(f"byproduct {phrase!r}: needs a non-empty list of sources")
        tokens = tokenise(phrase)
        if phrase != " ".join(tokens) or len(tokens) < 2:
            raise CookoutBankError(f"byproduct {phrase!r}: must be 2+ lowercase folded words")
        parsed: list[tuple[str, ...]] = []
        for source in sources:
            if not isinstance(source, str) or not tokenise(source):
                raise CookoutBankError(f"byproduct {phrase!r}: bad source {source!r}")
            if source != " ".join(tokenise(source)):
                raise CookoutBankError(f"byproduct {phrase!r}: source {source!r} is not folded")
            parsed.append(tokenise(source))
        if len(set(parsed)) != len(parsed):
            raise CookoutBankError(f"byproduct {phrase!r}: duplicate sources")
        out[tokens] = tuple(parsed)
    return out


def _validate_byproducts(bank: CookoutBank) -> None:
    """The closed rules for the curated by-product list (audit F4): every entry is a bank product
    ending in a by-product head, whose sources are phrases of the key that some bank name can
    supply, and which names its carrier (butter, oil...) among them."""
    all_names: list[tuple[str, Ingredient | None]] = [
        (n, i) for i in bank.ingredients for n in (i.name, *i.aliases)
    ]
    for key, sources in bank.byproducts.items():
        label = " ".join(key)
        entity = bank._dictionary.get(key)
        if entity is None or entity[0] != "ingredient" or entity[1] in STAPLE_IDS:
            raise CookoutBankError(f"byproduct {label!r}: not a bank ingredient (or is a staple)")
        if key[-1] not in BYPRODUCT_HEADS:
            raise CookoutBankError(f"byproduct {label!r}: may not end in {key[-1]!r}")
        for source in sources:
            joined = " ".join(source)
            if not _contains_run(key, source) and joined not in KITCHEN_SOURCES:
                raise CookoutBankError(f"byproduct {label!r}: source {joined!r} is not in the key")
            if all(t in HEAD_MODIFIERS for t in source):
                raise CookoutBankError(f"byproduct {label!r}: source {joined!r} is only modifiers")
            if bank._pick_run(source, all_names, with_implied=False) is None:
                raise CookoutBankError(f"byproduct {label!r}: no bank name supplies {joined!r}")
        if key[-1] in CARRIER_HEADS and not any(key[-1] in source for source in sources):
            raise CookoutBankError(f"byproduct {label!r}: must list {key[-1]!r} as a source")


def _contains_run(key: tuple[str, ...], source: tuple[str, ...]) -> bool:
    return any(key[i : i + len(source)] == source for i in range(len(key) - len(source) + 1))


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
            "byproducts",
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
    bank = CookoutBank(
        categories=categories,
        staples=staples,
        ingredients=ingredients,
        stop_words=stop_words,
        culinary_words=culinary_words,
        byproducts=_byproducts(raw["byproducts"]),
    )
    _validate_byproducts(bank)
    return bank


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
