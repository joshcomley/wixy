#!/usr/bin/env python3
"""Cookout ingredient-bank validator (workspace 00058, ruling 12).

Stdlib only, fully typed. Used two ways:

* CLI     ``python tooling/cookout/validate_bank.py [bank.json]`` prints one problem per line and
          exits 1 if there are any (defaults to the committed bank).
* import  ``validate(path) -> list[str]`` (empty list = valid), used by
          ``wixy_server/tests/test_cookout_bank.py``; also ``summary(path)``.

It checks everything the strict loader checks, but reports EVERY problem instead of the first,
plus bank-wide sanity the loader leaves to CI: category and role coverage and size, the rarity
mix, and a heuristic near-duplicate report (names that differ only by plural or punctuation).
"""

from __future__ import annotations

import json
import random
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_bank import CATEGORIES  # noqa: E402
from normalise_names import PHRASES, PROPER_NOUNS  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
BANK = REPO / "wixy_server" / "livechat" / "cookout_ingredients.json"

CATEGORY_IDS = [
    "meat-poultry", "fish-seafood", "vegetables", "fungi", "fruit", "dairy-eggs",
    "grains-bakery", "legumes-nuts-seeds", "herbs-aromatics", "spices-seasonings",
    "oils-fats-condiments", "sauces-stocks-fermented", "sweet-baking", "prepared-pantry",
    "drinks-alcohol",
]  # fmt: skip
STAPLES = {
    "water": False, "salt": False, "black-pepper": False, "butter": True,
    "plain-flour": True, "cooking-oil": True, "granulated-sugar": True, "milk": True,
}  # fmt: skip
ROLES = ("base", "protein", "produce", "accent")
RARITIES = ("everyday", "uncommon", "exotic")
MIN_TOTAL, MAX_TOTAL = 2500, 4000
MIN_PER_ROLE = 200
MIN_EVERYDAY_FAMILIES = 30
MIN_CATEGORIES_PER_ROLE = 2
MAX_CATEGORY_SHARE = 0.25
SIMULATED_ROUNDS = 500
MANDATORY_WORDS = ("toast", "sugar", "parsley", "beef", "cream")
FORBIDDEN_STOP_WORDS = ("butter", "flour", "milk", "oil", "sugar", "salt", "pepper")
RARITY_BANDS = {"everyday": (0.35, 0.62), "uncommon": (0.25, 0.48), "exotic": (0.07, 0.25)}

ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def _squash(name: str) -> str:
    """Name with punctuation/spacing removed and a trailing plural stripped (duplicate heuristic)."""
    key = re.sub(r"[^a-z0-9]", "", fold(name))
    for suffix in ("ies", "es", "s"):
        if key.endswith(suffix) and len(key) > len(suffix) + 3:
            return key[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return key


def _case_problems(where: str, name: str) -> list[str]:
    """Names are sentence case: only the first word and listed proper nouns carry capitals."""
    if name in PHRASES.values():
        return []
    bad = [
        w
        for w in name.split(" ")[1:]
        if w not in PROPER_NOUNS and not w.isupper() and w != w.lower()
    ]
    if bad:
        return [f"{where}: name {name!r} is not sentence case (capitalised: {bad})"]
    return []


def _is_text(value: object, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and value == value.strip()
        and len(value) <= maximum
        and not CONTROL_RE.search(value)
    )


def validate(path: Path = BANK) -> list[str]:
    problems: list[str] = []
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"cannot read {path}: {exc}"]
    keys = {"version", "generated", "categories", "staples", "stopWords", "ingredients"}
    if not isinstance(doc, dict) or set(doc) != keys:
        return [f"top level must be an object with exactly {sorted(keys)}"]
    if doc["version"] != 1:
        problems.append("version must be 1")

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(doc["generated"])):
        problems.append("generated must be a YYYY-MM-DD date")
    expected = [{"id": i, "name": n, "emoji": e} for i, n, e in CATEGORIES]
    if doc["categories"] != expected:
        problems.append(f"categories must be exactly {expected}")
    stop_words = doc["stopWords"]
    if not isinstance(stop_words, list) or not all(
        isinstance(w, str) and w == fold(w) and re.fullmatch(r"[a-z0-9]+", w) for w in stop_words
    ):
        problems.append("stopWords must be a list of single lowercase words")
    else:
        if len(set(stop_words)) != len(stop_words):
            problems.append("stopWords has duplicates")
        for word in FORBIDDEN_STOP_WORDS:
            if word in stop_words:
                problems.append(f"stopWords contains the staple food name {word!r}")

    staples = doc["staples"]
    got = {s.get("id"): s.get("pickable") for s in staples if isinstance(s, dict)}
    if got != STAPLES or [s.get("id") for s in staples] != list(STAPLES):
        problems.append(f"staples must be exactly {STAPLES} in order, got {got}")
    staple_names = {s.get("id"): s.get("name") for s in staples if isinstance(s, dict)}

    items = doc["ingredients"]
    if not MIN_TOTAL <= len(items) <= MAX_TOTAL:
        problems.append(f"{len(items)} ingredients; must be {MIN_TOTAL}-{MAX_TOTAL}")
    seen_ids: set[str] = set()
    names: dict[str, str] = {}
    squashed: dict[str, str] = {}
    by_id: dict[str, dict[str, object]] = {}
    for index, item in enumerate(items):
        where = f"ingredient #{index + 1}"
        if not isinstance(item, dict):
            problems.append(f"{where}: not an object")
            continue
        keys = {"id", "name", "aliases", "category", "role", "family", "rarity", "blurb"}
        if set(item) != keys:
            problems.append(f"{where}: keys must be {sorted(keys)}, got {sorted(item)}")
            continue
        iid = item["id"]
        if not (isinstance(iid, str) and ID_RE.fullmatch(iid) and 2 <= len(iid) <= 64):
            problems.append(f"{where}: bad id {iid!r}")
            continue
        where = f"ingredient {iid}"
        if iid in seen_ids:
            problems.append(f"{where}: duplicate id")
        seen_ids.add(iid)
        by_id[iid] = item
        if not _is_text(item["name"], 70):
            problems.append(f"{where}: bad name")
        else:
            key = fold(str(item["name"]))
            if key in names:
                problems.append(f"{where}: name {item['name']!r} duplicates {names[key]!r}")
            names[key] = iid
            sq = _squash(str(item["name"]))
            if sq in squashed and squashed[sq] != iid:
                problems.append(
                    f"{where}: near-duplicate of {squashed[sq]!r} (plural/punctuation only)"
                )
            squashed.setdefault(sq, iid)
        if _is_text(item["name"], 70):
            problems.extend(_case_problems(where, str(item["name"])))
        if item["category"] not in CATEGORY_IDS:
            problems.append(f"{where}: unknown category {item['category']!r}")
        if item["role"] not in ROLES:
            problems.append(f"{where}: bad role {item['role']!r}")
        if item["rarity"] not in RARITIES:
            problems.append(f"{where}: bad rarity {item['rarity']!r}")
        fam = item["family"]
        if not (isinstance(fam, str) and ID_RE.fullmatch(fam) and 2 <= len(fam) <= 48):
            problems.append(f"{where}: bad family {fam!r}")
        if not _is_text(item["blurb"], 90):
            problems.append(f"{where}: bad blurb (1-90 plain chars)")
        elif re.search(r"[<>*_`#|]", str(item["blurb"])):
            problems.append(f"{where}: blurb contains markup")
        elif str(item["blurb"]).endswith(".") or not str(item["blurb"])[0].isupper():
            problems.append(f"{where}: blurb must start capitalised and have no trailing full stop")
        al = item["aliases"]
        if not isinstance(al, list) or len(al) > 4 or not all(_is_text(a, 70) for a in al):
            problems.append(f"{where}: aliases must be 0-4 trimmed strings")
    for item in by_id.values():
        al = item["aliases"]
        if not isinstance(al, list):
            continue
        for alias in al:
            owner = names.setdefault(fold(str(alias)), str(item["id"]))
            if owner != item["id"]:
                problems.append(f"ingredient {item['id']}: alias {alias!r} collides with {owner!r}")

    for sid, pickable in STAPLES.items():
        if not pickable:
            if sid in by_id:
                problems.append(f"staple {sid} must not be an ingredient")
        elif sid not in by_id:
            problems.append(f"pickable staple {sid} missing from ingredients")
        elif by_id[sid]["name"] != staple_names.get(sid):
            problems.append(f"pickable staple {sid}: ingredient name differs from staple name")

    total = max(len(items), 1)
    roles = Counter(str(i.get("role")) for i in by_id.values())
    cats = Counter(str(i.get("category")) for i in by_id.values())
    rars = Counter(str(i.get("rarity")) for i in by_id.values())
    for role in ROLES:
        if roles[role] < MIN_PER_ROLE:
            problems.append(f"role {role}: {roles[role]} ingredients, need >= {MIN_PER_ROLE}")
        in_role = [i for i in by_id.values() if i.get("role") == role]
        families = {i["family"] for i in in_role if i.get("rarity") == "everyday"}
        if len(families) < MIN_EVERYDAY_FAMILIES:
            problems.append(f"role {role}: {len(families)} everyday families, need >= 30")
        if len({i["category"] for i in in_role}) < MIN_CATEGORIES_PER_ROLE:
            problems.append(f"role {role}: spans fewer than {MIN_CATEGORIES_PER_ROLE} categories")
    for cat in CATEGORY_IDS:
        if cats[cat] == 0:
            problems.append(f"category {cat}: empty")
        if cats[cat] / total > MAX_CATEGORY_SHARE:
            problems.append(f"category {cat}: more than {MAX_CATEGORY_SHARE:.0%} of the bank")
    words = {w for i in by_id.values() for w in re.findall(r"[a-z]+", fold(str(i["name"])))}
    for word in MANDATORY_WORDS:
        if word not in words:
            problems.append(f"no ingredient named with the operator example {word!r}")
    for rarity, (low, high) in RARITY_BANDS.items():
        share = rars[rarity] / total
        if not low <= share <= high:
            problems.append(f"rarity {rarity}: {share:.1%} outside {low:.0%}-{high:.0%}")
    if not problems:
        problems.extend(simulate_rounds(path))
    return problems


def simulate_rounds(path: Path, rounds: int = SIMULATED_ROUNDS) -> list[str]:
    """500 maximum-skip rounds (10 turns x 3 offers = 30 pairs) through the real draw; EVERY emitted
    pair is checked against the hard rules, not merely 'no exception'."""
    from wixy_server.livechat.cookout_bank import (
        CookoutExhaustedError,
        load_cookout_bank,
    )

    bank = load_cookout_bank(path)
    rng = random.Random(20261028)
    problems: list[str] = []
    for round_no in range(rounds):
        schedule = bank.shuffle_role_schedule(rng)
        seen: set[str] = set()
        offered_families: set[str] = set()
        picked_families: set[str] = set()
        shown: dict[int, list[str]] = {1: [], 2: []}
        for turn in range(1, 11):
            player = 1 if turn % 2 else 2
            role = schedule[(turn - 1) // 2]
            for offer in range(3):
                where = f"simulated round {round_no} turn {turn} offer {offer}"
                try:
                    pair = bank.draw_pair(
                        role=role,
                        seen_ids=seen,
                        picked_families=picked_families,
                        offered_families=offered_families,
                        player_offered_categories=shown[player],
                        rng=rng,
                    )
                except CookoutExhaustedError as exc:
                    problems.append(f"{where}: exhausted ({exc})")
                    return problems
                one, two = pair
                if one.role != role or two.role != role:
                    problems.append(f"{where}: option outside role {role}")
                if one.category == two.category:
                    problems.append(f"{where}: same category {one.category}")
                if one.family == two.family:
                    problems.append(f"{where}: same family {one.family}")
                if "everyday" not in (one.rarity, two.rarity):
                    problems.append(f"{where}: no everyday option")
                for option in pair:
                    if option.id in seen:
                        problems.append(f"{where}: repeated id {option.id}")
                    if option.family in picked_families:
                        problems.append(f"{where}: picked family {option.family} offered again")
                seen.update(o.id for o in pair)
                offered_families.update(o.family for o in pair)
                shown[player].extend(o.category for o in pair)
                if len(problems) > 20:
                    return problems
            picked_families.add(pair[rng.randrange(2)].family)
    return problems


def summary(path: Path = BANK) -> str:
    doc = json.loads(path.read_text(encoding="utf-8"))
    items = doc["ingredients"]
    lines = [f"{len(items)} ingredients"]
    for label in ("category", "role", "rarity"):
        counts = Counter(i[label] for i in items)
        lines.append(f"{label}: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else BANK
    problems = validate(path)
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
