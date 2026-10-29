#!/usr/bin/env python3
"""Cookout ingredient-catalogue validator (spec/server-chat/09b §A.4).

Stdlib only, fully typed. Used two ways:

* CLI     ``python tooling/cookout/visual/validate_catalogue.py [--allow-partial] [catalogue.json]``
          prints one problem per line and exits 1 if there are any.
* import  ``validate(...) -> list[str]`` (empty = valid), used by
          ``wixy_server/tests/test_cookout_catalogue_data.py``.

It runs the loader's per-entry rules (``cookout_catalogue.entry_problems``, shared so the two never
drift) and adds everything that needs the bank: every pickable ingredient plus the three free
seasonings present exactly once with a current ``nameKey``, no unknown ids, the presentation /
category rule, the "no other ingredient's name after 'with'" rule, no fact repeated across entries,
and facts waivers only for listed ids.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from collections.abc import Mapping
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from wixy_server.livechat.cookout_bank import load_cookout_bank  # noqa: E402
from wixy_server.livechat.cookout_catalogue import (  # noqa: E402
    CATALOGUE_PATH,
    NATURAL_FORMS,
    SEASONING_SUBJECT_IDS,
    VESSELS,
    CatalogueSubject,
    entry_problems,
    fold,
    name_key,
    subjects,
)

BANK_PATH = REPO / "wixy_server" / "livechat" / "cookout_ingredients.json"
WAIVERS_PATH = Path(__file__).with_name("facts_waivers.json")

VESSEL_CATEGORIES = frozenset({"oils-fats-condiments", "sauces-stocks-fermented", "drinks-alcohol"})
_NATURAL_WORDS = re.compile(
    r"\b(?:whole|piece|pod|pods|stick|sticks|root|bulb|honeycomb|comb|block|bar|slab|wedge|chunk|loaf)\b"
)
_ARTICLES = frozenset({"a", "an", "the", "some", "its", "one", "two", "several", "each", "no"})
_WORD = re.compile(r"[a-z0-9']+")


def load_bank_items(bank_path: Path = BANK_PATH) -> dict[str, CatalogueSubject]:
    """Every catalogue subject by id: the bank's pickable ingredients, then the three seasonings."""
    return {subject.id: subject for subject in subjects(load_cookout_bank(bank_path))}


def load_waivers(path: Path = WAIVERS_PATH) -> dict[str, str]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def other_ingredient_after_with(
    visual: str, own: CatalogueSubject, names: Mapping[str, str]
) -> str | None:
    """The first other bank ingredient's exact name that follows the word 'with' in `visual`."""
    words = _WORD.findall(fold(visual))
    own_names = {fold(own.name), *(fold(a) for a in own.aliases)}
    for index, word in enumerate(words):
        if word != "with":
            continue
        rest = words[index + 1 :]
        while rest and rest[0] in _ARTICLES:
            rest = rest[1:]
        for length in range(min(6, len(rest)), 0, -1):
            candidate = " ".join(rest[:length])
            if candidate in names and candidate not in own_names:
                return names[candidate]
    return None


def item_problems(
    ingredient_id: str, raw: object, bank_item: CatalogueSubject, names: Mapping[str, str]
) -> list[str]:
    """Every problem with one entry: the loader's rules plus the bank-dependent ones."""
    problems = entry_problems(ingredient_id, raw)
    if not isinstance(raw, dict) or problems and any("missing keys" in p for p in problems):
        return problems
    where = f"{ingredient_id}:"
    if raw.get("nameKey") != name_key(bank_item):
        problems.append(f"{where} stale nameKey (bank entry changed; re-author it)")
    what, visual, presentation = raw.get("what"), raw.get("visual"), raw.get("presentation")
    if isinstance(what, str):
        folded_what = fold(what)
        folded_name = fold(bank_item.name)
        if folded_what.startswith(folded_name) or folded_what.removeprefix("a ").startswith(
            folded_name
        ):
            problems.append(f"{where} what repeats the ingredient name at its start")
    if isinstance(visual, str):
        other = other_ingredient_after_with(visual, bank_item, names)
        if other is not None:
            problems.append(f"{where} visual puts another ingredient ({other!r}) after 'with'")
        if bank_item.category in VESSEL_CATEGORIES and presentation not in VESSELS:
            natural = presentation in NATURAL_FORMS and _NATURAL_WORDS.search(fold(visual))
            if not natural:
                problems.append(
                    f"{where} {bank_item.category} needs presentation bowl/jar/bottle/glass "
                    f"(or whole/cut with a visual naming a whole natural form); got {presentation!r}"
                )
    return problems


def ingredient_names(items: Mapping[str, CatalogueSubject]) -> dict[str, str]:
    """Folded exact names of the pickable bank ingredients (not the seasonings) -> display name."""
    return {fold(i.name): i.name for i in items.values() if i.id not in SEASONING_SUBJECT_IDS}


def validate(
    path: Path = CATALOGUE_PATH,
    *,
    bank_path: Path = BANK_PATH,
    waivers_path: Path = WAIVERS_PATH,
    allow_partial: bool = False,
) -> list[str]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"cannot read {path}: {exc}"]
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), dict):
        return ["catalogue must be an object with an 'items' object"]
    problems: list[str] = []
    if set(raw) != {"version", "bankVersion", "generated", "items"}:
        problems.append(f"unexpected top-level keys {sorted(raw)}")
    if raw.get("version") != 1:
        problems.append(f"unsupported version {raw.get('version')!r}")
    bank = load_bank_items(bank_path)
    names = ingredient_names(bank)
    waivers = load_waivers(waivers_path)
    items: dict[str, object] = raw["items"]

    for unknown in sorted(set(items) - set(bank)):
        problems.append(f"{unknown}: not a bank ingredient or free seasoning")
    if not allow_partial:
        problems.extend(
            f"{missing}: no catalogue entry" for missing in sorted(set(bank) - set(items))
        )

    fact_counts: Counter[str] = Counter()
    for ingredient_id, entry in items.items():
        bank_item = bank.get(ingredient_id)
        if bank_item is None:
            continue
        problems.extend(item_problems(ingredient_id, entry, bank_item, names))
        facts = entry.get("facts") if isinstance(entry, dict) else None
        if isinstance(facts, list):
            fact_counts.update(f for f in set(facts) if isinstance(f, str))
            if not facts and ingredient_id not in waivers:
                problems.append(f"{ingredient_id}: no facts and no entry in facts_waivers.json")
    for fact, count in sorted(fact_counts.items()):
        if count > 1:
            problems.append(f"fact repeated across {count} entries: {fact!r}")
    for waived, reason in waivers.items():
        if waived not in bank:
            problems.append(f"facts_waivers.json: {waived!r} is not a bank id")
        if not reason.strip():
            problems.append(f"facts_waivers.json: {waived!r} has no reason")
        entry = items.get(waived)
        if isinstance(entry, dict) and entry.get("facts"):
            problems.append(f"facts_waivers.json: {waived!r} has facts, so needs no waiver")
    return problems


def summary(path: Path = CATALOGUE_PATH, *, bank_path: Path = BANK_PATH) -> str:
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = raw["items"]
    bank = load_bank_items(bank_path)
    fact_hist = Counter(len(e["facts"]) for e in items.values())
    return f"{len(items)} of {len(bank)} entries; facts per entry: " + ", ".join(
        f"{k}: {fact_hist[k]}" for k in sorted(fact_hist)
    )


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    partial = "--allow-partial" in argv
    path = Path(args[0]) if args else CATALOGUE_PATH
    problems = validate(path, allow_partial=partial)
    for problem in problems:
        print(problem)
    if problems:
        print(f"{len(problems)} problem(s)")
        return 1
    print(summary(path))
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
