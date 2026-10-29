"""The Cookout ingredient catalogue: per ingredient, the plain "what it is" line, the picture
description, how it is normally seen, and 2-3 fun facts (spec/server-chat/09b §A).

Committed data (`cookout_catalogue.json`), written by `tooling/cookout/visual/catalogue.py`
and read here. The loader is strict about everything it can check on one entry alone; what
needs the bank (every id present, a current `nameKey`, the presentation/category rule, other
ingredient names inside `visual`) is checked by `tooling/cookout/visual/validate_catalogue.py`,
which shares this module's per-entry rules (`entry_problems`) so the two never drift.

Both ways of loading are total at runtime: `load_cookout_catalogue_or_empty` logs and returns an
empty catalogue for a missing or broken file, so a damaged data file can never take the game
down (the UI falls back to the bank's `blurb`, and a picture-less tile).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import unicodedata
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, cast, get_args

_LOGGER = logging.getLogger(__name__)

CATALOGUE_PATH = Path(__file__).with_name("cookout_catalogue.json")
CATALOGUE_VERSION = 1

Presentation = Literal[
    "whole", "cut", "heap", "bunch", "bowl", "jar", "bottle", "glass", "plate", "portion"
]
PRESENTATIONS: Final = frozenset(get_args(Presentation))
VESSELS: Final = frozenset({"bowl", "jar", "bottle", "glass"})
"""Presentations that put the ingredient in a plain vessel (spec §A.1)."""
NATURAL_FORMS: Final = frozenset({"whole", "cut"})

WHAT_LENGTH: Final = (10, 72)
VISUAL_LENGTH: Final = (30, 260)
FACT_LENGTH: Final = (25, 150)
MAX_FACTS: Final = 3

_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_NAME_KEY_RE = re.compile(r"^[0-9a-f]{16}$")
_HTML_URL_RE = re.compile(r"[<>]|https?:|www\.|\.(?:com|co\.uk|org|net)\b", re.IGNORECASE)
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# The words the visual may not contain (spec §A.1). "label" is allowed only in "unlabelled"
# (a different word, so it never matches) and "without a label".
_VISUAL_FORBIDDEN: Final = (
    re.compile(r"\bbrand(?:s|ed)?\b"),
    re.compile(r"\blogos?\b"),
    re.compile(r"\blabel(?:s|led)?\b"),
    re.compile(r"\bpack(?:et|ets|age|aged|aging)?\b"),
    re.compile(r"\btins? of\b"),
    re.compile(r"\bcans? of\b"),
    re.compile(r"\bhands?\b"),
    re.compile(r"\b(?:person|people)\b"),
    re.compile(r"\bforks?\b"),
    re.compile(r"\bknife\b|\bknives\b"),
    re.compile(r"\bspoons?\b"),
    re.compile(r"\bgarnish(?:ed|es)?\b"),
)
_WITHOUT_A_LABEL = re.compile(r"\bwithout (?:a |any )?labels?\b")

# Honest-fact rules (spec §A.2): no health or nutrition claims. Word forms, not substrings, so
# "secure" and "cured ham" (meat curing is how it is made, not a medical claim) are fine.
_FACT_FORBIDDEN: Final = (
    re.compile(r"\bcures?\b"),
    re.compile(r"\bprevent(?:s|ed|ing|ion)?\b"),
    re.compile(r"\bboost(?:s|ed|ing)?\b"),
    re.compile(r"\bimmune\b|\bimmunity\b"),
    re.compile(r"\bdetox\w*"),
    re.compile(r"\bcancers?\b"),
    re.compile(r"\bheal(?:s|ed|ing)?\b"),
    re.compile(r"\bsuper-?foods?\b"),
    re.compile(r"\bantioxidants?\b"),
    re.compile(r"\bcalor(?:ie|ies|ic)\b"),
    re.compile(r"\bvitamins?\b"),
    re.compile(r"\bprotein-rich\b"),
)
_NUMERAL_GROUP = re.compile(r"\d+(?:[.,]\d+)*")
_YEAR = re.compile(r"^(?:1\d{3}|20\d{2})$")  # 1000-2099: a year, the one numeral allowed free


class CatalogueError(ValueError):
    """The catalogue file is not a valid catalogue; the message names the first problem."""


def fold(text: str) -> str:
    """Case-folded, accent-free text for forbidden-word and name matching."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def name_key(name: str, aliases: Sequence[str], category: str) -> str:
    """The staleness key of a bank entry (spec §A.1): if the entry is renamed, re-aliased or
    recategorised, its catalogue entry is stale and the validator fails."""
    text = name + "\x1f" + "\x1f".join(aliases) + "\x1f" + category
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True, slots=True)
class CatalogueEntry:
    id: str
    what: str
    visual: str
    presentation: Presentation
    facts: tuple[str, ...]
    name_key: str


class Catalogue:
    """The loaded catalogue: lookup by ingredient id."""

    def __init__(
        self,
        entries: Mapping[str, CatalogueEntry] | None = None,
        *,
        version: int = CATALOGUE_VERSION,
        bank_version: int = 1,
        generated: int = 0,
    ) -> None:
        self.version = version
        self.bank_version = bank_version
        self.generated = generated
        self._entries: Mapping[str, CatalogueEntry] = dict(entries or {})

    def get(self, ingredient_id: str) -> CatalogueEntry | None:
        return self._entries.get(ingredient_id)

    def __len__(self) -> int:
        return len(self._entries)

    def __contains__(self, ingredient_id: object) -> bool:
        return ingredient_id in self._entries

    def __iter__(self) -> Iterator[str]:
        return iter(self._entries)


def _bad_text(text: str) -> str | None:
    """Why a line of text is unusable on screen (HTML, URL, emoji, control characters), or None."""
    if _CONTROL_RE.search(text):
        return "contains a control character"
    if _HTML_URL_RE.search(text):
        return "contains HTML or a URL"
    for ch in text:
        code = ord(ch)
        if (
            code >= 0x1F000
            or 0x2190 <= code <= 0x27BF
            or 0x2B00 <= code <= 0x2BFF
            or code == 0xFE0F
            or unicodedata.category(ch) in ("So", "Cs", "Co")
        ):
            return "contains an emoji or symbol"
    if text != text.strip() or "  " in text:
        return "has stray whitespace"
    return None


def _length_problem(label: str, text: str, bounds: tuple[int, int]) -> str | None:
    low, high = bounds
    if not low <= len(text) <= high:
        return f"{label} is {len(text)} characters (must be {low}-{high})"
    return None


def visual_problems(visual: str) -> list[str]:
    """The mechanical rules for a picture description (spec §A.1)."""
    problems: list[str] = []
    if (p := _length_problem("visual", visual, VISUAL_LENGTH)) is not None:
        problems.append(p)
    if (p := _bad_text(visual)) is not None:
        problems.append(f"visual {p}")
    folded = _WITHOUT_A_LABEL.sub("", fold(visual))
    for pattern in _VISUAL_FORBIDDEN:
        hit = pattern.search(folded)
        if hit is not None:
            problems.append(f"visual uses the forbidden word {hit.group(0)!r}")
    return problems


def fact_problems(fact: str) -> list[str]:
    """The mechanical rules for one fun fact (spec §A.2)."""
    problems: list[str] = []
    if (p := _length_problem("fact", fact, FACT_LENGTH)) is not None:
        problems.append(p)
    if (p := _bad_text(fact)) is not None:
        problems.append(f"fact {p}")
    folded = fold(fact)
    for pattern in _FACT_FORBIDDEN:
        hit = pattern.search(folded)
        if hit is not None:
            problems.append(f"fact uses the forbidden word {hit.group(0)!r}")
    numerals = [m for m in _NUMERAL_GROUP.findall(fact) if not _YEAR.match(m)]
    if len(numerals) > 1:
        problems.append(f"fact has {len(numerals)} numbers ({', '.join(numerals)}); at most one")
    return problems


def entry_problems(ingredient_id: str, raw: object) -> list[str]:
    """Every problem with one raw catalogue entry that can be found without the bank. Problems
    are prefixed with the id."""
    where = f"{ingredient_id}:"
    if not _ID_RE.match(ingredient_id) or len(ingredient_id) > 64:
        return [f"{where} malformed id"]
    if not isinstance(raw, dict):
        return [f"{where} entry must be an object"]
    problems: list[str] = []
    expected = {"what", "visual", "presentation", "facts", "nameKey", "source"}
    extra = sorted(set(raw) - expected)
    missing = sorted(expected - set(raw))
    if extra:
        problems.append(f"{where} unknown keys {extra}")
    if missing:
        problems.append(f"{where} missing keys {missing}")
        return problems

    what, visual = raw["what"], raw["visual"]
    if not isinstance(what, str):
        problems.append(f"{where} what must be a string")
    else:
        if (p := _length_problem("what", what, WHAT_LENGTH)) is not None:
            problems.append(f"{where} {p}")
        if (p := _bad_text(what)) is not None:
            problems.append(f"{where} what {p}")
    if not isinstance(visual, str):
        problems.append(f"{where} visual must be a string")
    else:
        problems.extend(f"{where} {p}" for p in visual_problems(visual))

    if raw["presentation"] not in PRESENTATIONS:
        problems.append(f"{where} unknown presentation {raw['presentation']!r}")

    facts = raw["facts"]
    if not isinstance(facts, list) or not all(isinstance(f, str) for f in facts):
        problems.append(f"{where} facts must be a list of strings")
    else:
        if len(facts) > MAX_FACTS:
            problems.append(f"{where} has {len(facts)} facts (at most {MAX_FACTS})")
        if len(set(facts)) != len(facts):
            problems.append(f"{where} repeats a fact")
        for fact in facts:
            problems.extend(f"{where} {p}" for p in fact_problems(fact))

    key = raw["nameKey"]
    if not isinstance(key, str) or not _NAME_KEY_RE.match(key):
        problems.append(f"{where} nameKey must be 16 lowercase hex characters")

    source = raw["source"]
    if not isinstance(source, dict):
        problems.append(f"{where} source must be an object")
    else:
        # `visualBy`/`visualAt` are optional: the image tooling rewrote this visual (spec §B.5).
        allowed = {"author", "factCheck", "at", "visualBy", "visualAt"}
        if set(source) - allowed or not {"author", "factCheck", "at"} <= set(source):
            problems.append(f"{where} source keys must be author, factCheck, at (+ visualBy/At)")
        else:
            for k in ("author", "factCheck", "visualBy"):
                if k in source and not (isinstance(source[k], str) and source[k]):
                    problems.append(f"{where} source.{k} must be a non-empty string")
            for k in ("at", "visualAt"):
                if k in source and (
                    not isinstance(source[k], int) or isinstance(source[k], bool) or source[k] < 0
                ):
                    problems.append(f"{where} source.{k} must be an epoch-seconds integer")
    return problems


def parse_cookout_catalogue(raw: object) -> Catalogue:
    if not isinstance(raw, dict):
        raise CatalogueError("catalogue must be a JSON object")
    if set(raw) != {"version", "bankVersion", "generated", "items"}:
        raise CatalogueError(f"unexpected top-level keys {sorted(raw)}")
    version, bank_version, generated, items = (
        raw["version"],
        raw["bankVersion"],
        raw["generated"],
        raw["items"],
    )
    if version != CATALOGUE_VERSION:
        raise CatalogueError(f"unsupported catalogue version {version!r}")
    for label, value in (("bankVersion", bank_version), ("generated", generated)):
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise CatalogueError(f"{label} must be a non-negative integer")
    if not isinstance(items, dict):
        raise CatalogueError("items must be an object")
    entries: dict[str, CatalogueEntry] = {}
    for ingredient_id, item in items.items():
        problems = entry_problems(ingredient_id, item)
        if problems:
            raise CatalogueError(problems[0])
        assert isinstance(item, dict)
        entries[ingredient_id] = CatalogueEntry(
            id=ingredient_id,
            what=item["what"],
            visual=item["visual"],
            presentation=cast(Presentation, item["presentation"]),
            facts=tuple(item["facts"]),
            name_key=item["nameKey"],
        )
    return Catalogue(
        entries,
        version=version,
        bank_version=cast(int, bank_version),
        generated=cast(int, generated),
    )


def load_cookout_catalogue(path: Path | None = None) -> Catalogue:
    target = CATALOGUE_PATH if path is None else path
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CatalogueError(f"cannot read catalogue {target}: {exc}") from exc
    return parse_cookout_catalogue(raw)


def load_cookout_catalogue_or_empty(path: Path | None = None) -> Catalogue:
    """Never raises: a missing or broken file logs and yields an empty catalogue."""
    try:
        return load_cookout_catalogue(path)
    except CatalogueError as exc:
        _LOGGER.error("cookout: catalogue unavailable, using none: %s", exc)
        return Catalogue()
