"""The rules that decide whether a photo shows a LOCAL DISH (Adventure Time holiday pack, spec
server-chat/08 4.3b, Inv 56). Pure functions, no I/O.

A wrong photo is worse than none, and dish names are exactly the words that collide with things
that are not food: measured 2026-10-28 on a real Kotor pack, "Buzara" (a shellfish stew) is, on
English Wikipedia, a genus of MOTHS — both the article's other images and a title-only Commons
match returned moth photos. So a dish's picture is accepted only when TWO independent signals agree:

- the picture's own TITLE contains a significant token of the dish name (accent-folded, at least 4
  letters, not a generic word), and
- the picture's own Commons description or categories (or, for a Wikipedia lead image, the
  article's short description / first sentence) mention food or drink.

Neither alone is enough: a moth photo is titled "Buzara ...jpg" but categorised "Moths of Africa"; a
photo of a fish market is categorised "Fish markets" but not titled for the stew.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Final

FOOD_TERMS: Final = (
    # the spec's own list
    "dish",
    "food",
    "cuisine",
    "bread",
    "pastry",
    "cake",
    "dessert",
    "cheese",
    "ham",
    "sausage",
    "meat",
    "fish",
    "seafood",
    "soup",
    "stew",
    "rice",
    "pasta",
    "sauce",
    "wine",
    "beer",
    "drink",
    "beverage",
    "liqueur",
    "spirit",
    "coffee",
    "tea",
    "snack",
    # what a Commons category or a Wikipedia short description says about a real dish
    "meal",
    "recipe",
    "delicacy",
    "specialty",
    "speciality",
    "pie",
    "tart",
    "strudel",
    "pudding",
    "doughnut",
    "donut",
    "cookie",
    "biscuit",
    "pancake",
    "waffle",
    "dumpling",
    "noodle",
    "risotto",
    "pizza",
    "dough",
    "flatbread",
    "broth",
    "salad",
    "dip",
    "spread",
    "honey",
    "butter",
    "cream",
    "yoghurt",
    "yogurt",
    "milk",
    "egg",
    "bacon",
    "beef",
    "pork",
    "lamb",
    "mutton",
    "veal",
    "chicken",
    "duck",
    "goose",
    "steak",
    "kebab",
    "burger",
    "sandwich",
    "grill",
    "roast",
    "shellfish",
    "mussel",
    "oyster",
    "clam",
    "shrimp",
    "prawn",
    "crab",
    "lobster",
    "squid",
    "octopus",
    "cuttlefish",
    "anchovy",
    "sardine",
    "tuna",
    "trout",
    "carp",
    "vegetable",
    "fruit",
    "olive oil",
    "bean",
    "potato",
    "polenta",
    "cornmeal",
    "flour",
    "chocolate",
    "candy",
    "confectionery",
    "ice cream",
    "brandy",
    "rakia",
    "rakija",
    "vodka",
    "whisky",
    "whiskey",
    "cocktail",
    "juice",
    "cider",
    "mead",
    "schnapps",
    "grappa",
    "gastronomy",
    "culinary",
    "cooking",
    "cooked",
    "baked",
    "fried",
    "cured",
)
"""Words that mark a description or a category as food or drink (matched as whole words, optionally
plural). Deliberately NOT here: words as often a place as a food ("port", "jam", "sweet")."""

_FOOD_RE: Final = re.compile(
    r"\b(?:"
    + "|".join(re.escape(term) for term in sorted(FOOD_TERMS, key=len, reverse=True))
    + r")(?:s|es)?\b",
    re.IGNORECASE,
)

GENERIC_DISH_WORDS: Final = frozenset(
    {
        "with",
        "and",
        "the",
        "from",
        "style",
        "traditional",
        "local",
        "fresh",
        "homemade",
        "home",
        "made",
        "dish",
        "food",
        "cuisine",
        "black",
        "white",
        "red",
        "green",
        "yellow",
        "brown",
        "smoked",
        "dried",
        "fried",
        "grilled",
        "baked",
        "roasted",
        "stuffed",
        "cooked",
        "salted",
        "sweet",
        "hot",
        "cold",
        "mixed",
    }
)
"""Words that name a colour or a method rather than the dish: a file titled for "Black Mountain"
must not match "Black risotto"."""

DEMONYMS: Final = frozenset(
    {
        "american",
        "british",
        "chinese",
        "czech",
        "danish",
        "dutch",
        "english",
        "filipino",
        "finnish",
        "flemish",
        "french",
        "german",
        "hungarian",
        "icelandic",
        "indian",
        "irish",
        "japanese",
        "korean",
        "malay",
        "mexican",
        "polish",
        "scottish",
        "spanish",
        "swedish",
        "swiss",
        "thai",
        "turkish",
        "vietnamese",
        "welsh",
    }
)
"""Nationality adjectives whose spelling does not share a stem with the country's name, so the
place-stem rule (`place_tokens` + `_same_stem`) cannot catch them ("French"/"France",
"Spanish"/"Spain"). Regular ones ("Montenegrin"/"Montenegro", "Dalmatian"/"Dalmatia",
"Portuguese"/"Portugal", "Greek"/"Greece") are caught by the stem rule against the pack's own
destination and unit names instead of being listed here."""

_FOLD_EXTRA: Final = str.maketrans(
    {"đ": "d", "ł": "l", "ø": "o", "æ": "ae", "œ": "oe", "ß": "ss", "ı": "i", "ð": "d", "þ": "th"}
)
_PAREN_RE: Final = re.compile(r"[\(\[\{][^\)\]\}]*[\)\]\}]")
_WORD_RE: Final = re.compile(r"[a-z]+")
_SENTENCE_END_RE: Final = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])")
MIN_TOKEN_LETTERS: Final = 4
_FIRST_SENTENCE_MAX: Final = 400


def fold(text: str) -> str:
    """`text` lower-cased with accents removed (`Ćevapčići` -> `cevapcici`, `Đurđevak` ->
    `durdevak`), so a name and a file title compare the way a person reads them."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return stripped.translate(_FOLD_EXTRA)


def has_food_term(text: str | None) -> bool:
    """Whether `text` mentions food or drink."""
    return bool(text) and _FOOD_RE.search(text or "") is not None


def first_sentence(text: str | None) -> str:
    """The first sentence of a Wikipedia extract (cut at 400 characters at most)."""
    if not text:
        return ""
    head = text.strip()[: _FIRST_SENTENCE_MAX * 4]
    return _SENTENCE_END_RE.split(head, maxsplit=1)[0][:_FIRST_SENTENCE_MAX]


def summary_reads_as_food(description: object, extract: object) -> bool:
    """Whether a Wikipedia summary says its article is about food or drink: its short
    `description` or the first sentence of its `extract` passes the food-term check."""
    desc = description if isinstance(description, str) else ""
    lead = first_sentence(extract if isinstance(extract, str) else "")
    return has_food_term(desc) or has_food_term(lead)


def dish_search_name(name: str) -> str:
    """The part of a dish's name worth searching for: the parenthetical gloss
    (`Njeguški pršut (Njeguši smoked ham)`) is dropped."""
    plain = _PAREN_RE.sub(" ", name)
    plain = " ".join(plain.split())
    return plain or " ".join(name.split())


def place_tokens(*places: str | None) -> tuple[str, ...]:
    """The accent-folded words (at least 4 letters) of the pack's place names — the destination,
    its region, the unit — which must never count as naming a dish."""
    words: list[str] = []
    for place in places:
        if place:
            words += _WORD_RE.findall(fold(place))
    return tuple(w for w in dict.fromkeys(words) if len(w) >= MIN_TOKEN_LETTERS)


def _same_stem(a: str, b: str) -> bool:
    """Whether two words are the same place word in different forms: they share a prefix of at
    least 4 letters that is at most 3 letters short of the shorter word ("montenegrin" /
    "montenegro", "dalmatian" / "dalmatia", "greek" / "greece", "lisbon" / "lisbon")."""
    shared = 0
    for x, y in zip(a, b, strict=False):
        if x != y:
            break
        shared += 1
    return shared >= max(MIN_TOKEN_LETTERS, min(len(a), len(b)) - 3)


def dish_tokens(*names: str | None, places: Iterable[str] = ()) -> tuple[str, ...]:
    """The significant, accent-folded tokens of a dish's names — its menu name and its Wikipedia
    title: at least 4 letters, not a generic colour/method word, not a nationality, and not a
    form of one of `places` (see `place_tokens`). There is deliberately NO fallback: a dish whose
    name has no significant token ("Montenegrin smoked ham") gets no Commons search at all and
    stays text-only, because the title check is then only a place or a cooking method and the
    food-term check alone is fooled by any photo of the place that mentions a food (spec 4.3b: a
    wrong photo is worse than none)."""
    words: list[str] = []
    for name in names:
        if name:
            words += _WORD_RE.findall(fold(dish_search_name(name)))
    place_words = tuple(places)
    return tuple(
        w
        for w in dict.fromkeys(words)
        if len(w) >= MIN_TOKEN_LETTERS
        and w not in GENERIC_DISH_WORDS
        and w not in DEMONYMS
        and not any(_same_stem(w, p) for p in place_words)
    )


def title_names_dish(title: str, tokens: Iterable[str]) -> bool:
    """Whether a Commons file title (`File:Crnogorske priganice 1.jpg`) contains a dish token, as
    a word or the start of one (`priganice` in `priganice`, `risotto` in `risottos`)."""
    name = title.removeprefix("File:")
    if "." in name:
        name = name.rsplit(".", 1)[0]
    title_words = _WORD_RE.findall(fold(name))
    for token in tokens:
        for word in title_words:
            if word.startswith(token) or (
                len(word) >= MIN_TOKEN_LETTERS + 1 and token.startswith(word)
            ):
                return True
    return False
