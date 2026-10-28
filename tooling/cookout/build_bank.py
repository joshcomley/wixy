#!/usr/bin/env python3
"""Compile the hand-authored Cookout ingredient sources into `cookout_ingredients.json`.

Sources: `tooling/cookout/src/<category-id>.txt`, one ingredient per line:

    Name | alias; alias | role | family | rarity | blurb

`#` lines and blank lines are ignored. The id is derived from the name (accents folded, kebab-case).
Stdlib only. `--check FILE...` lints source files without writing anything.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
OUT = HERE.parents[1] / "wixy_server" / "livechat" / "cookout_ingredients.json"

CATEGORIES = [
    ("meat-poultry", "Meat & Poultry", "🥩"),
    ("fish-seafood", "Fish & Seafood", "🐟"),
    ("vegetables", "Vegetables & Greens", "🥦"),
    ("fungi", "Mushrooms & Fungi", "🍄"),
    ("fruit", "Fruit & Citrus", "🍋"),
    ("dairy-eggs", "Dairy, Cream & Eggs", "🧀"),
    ("grains-bakery", "Bread, Pasta & Grains", "🍞"),
    ("legumes-nuts-seeds", "Beans, Nuts & Seeds", "🥜"),
    ("herbs-aromatics", "Fresh Herbs & Aromatics", "🌿"),
    ("spices-seasonings", "Spices & Chilis", "🌶️"),
    ("oils-fats-condiments", "Oils, Fats & Condiments", "🫒"),
    ("sauces-stocks-fermented", "Sauces, Pastes & Pickles", "🫙"),
    ("sweet-baking", "Sweet, Sugar & Baking", "🍯"),
    ("prepared-pantry", "Prepared & Comfort Pantry", "🥫"),
    ("drinks-alcohol", "Splash, Brews & Infusions", "☕"),
]
STAPLES = [
    ("water", "Water", False),
    ("salt", "Salt", False),
    ("black-pepper", "Black pepper", False),
    ("butter", "Butter", True),
    ("plain-flour", "Plain flour", True),
    ("cooking-oil", "Cooking oil", True),
    ("granulated-sugar", "Granulated sugar", True),
    ("milk", "Milk", True),
]
GENERATED = "2026-10-28"
STOP_WORDS = [
    "bake", "board", "bowl", "crust", "dish", "dough", "filling", "garnish",
    "glaze", "grill", "jar", "layer", "marinade", "meal", "oven", "pan", "pie", "plate", "pot",
    "roast", "salad", "sandwich", "sauce", "skillet", "soup", "stew", "topping", "tray", "wok",
    "wrap", "water", "coating",
]  # fmt: skip
ROLES = {"base", "protein", "produce", "accent"}
RARITIES = {"everyday", "uncommon", "exotic"}
KEBAB = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")


def fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", fold(name)).strip("-")


def parse_file(path: Path, problems: list[str]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    category = path.stem
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        where = f"{path.name}:{number}"
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 6:
            problems.append(f"{where}: expected 6 '|'-separated fields, got {len(parts)}")
            continue
        name, aliases_raw, role, family, rarity, blurb = parts
        aliases = [a.strip() for a in aliases_raw.split(";") if a.strip()]
        if role not in ROLES:
            problems.append(f"{where}: bad role {role!r}")
        if rarity not in RARITIES:
            problems.append(f"{where}: bad rarity {rarity!r}")
        if not KEBAB.fullmatch(family) or not 2 <= len(family) <= 48:
            problems.append(f"{where}: bad family {family!r}")
        if not name or len(name) > 70:
            problems.append(f"{where}: bad name {name!r}")
        if not blurb or len(blurb) > 90:
            problems.append(f"{where}: blurb must be 1-90 chars ({len(blurb)})")
        if len(aliases) > 4:
            problems.append(f"{where}: more than 4 aliases")
        rows.append(
            {
                "id": slug(name),
                "name": name,
                "aliases": aliases,
                "category": category,
                "role": role,
                "family": family,
                "rarity": rarity,
                "blurb": blurb,
            }
        )
    return rows


def lint(rows: list[dict[str, object]], problems: list[str]) -> None:
    ids: dict[str, str] = {}
    names: dict[str, str] = {}
    for row in rows:
        rid = str(row["id"])
        if not KEBAB.fullmatch(rid) or not 2 <= len(rid) <= 64:
            problems.append(f"bad id {rid!r} (from {row['name']!r})")
        if rid in ids:
            problems.append(f"duplicate id {rid!r} ({ids[rid]} / {row['category']})")
        ids[rid] = str(row["category"])
        key = fold(str(row["name"]))
        if key in names:
            problems.append(f"duplicate name {row['name']!r}")
        names[key] = rid
    for row in rows:
        for alias in row["aliases"]:  # type: ignore[attr-defined]
            key = fold(str(alias))
            if key in names and names[key] != row["id"]:
                problems.append(
                    f"alias {alias!r} of {row['id']} collides with name of {names[key]}"
                )
            names.setdefault(key, str(row["id"]))
    for sid, _name, _pickable in STAPLES:
        if sid in ("water", "salt", "black-pepper"):
            if sid in ids:
                problems.append(f"unpickable staple {sid!r} must not be an ingredient")
        elif sid not in ids:
            problems.append(f"pickable staple {sid!r} missing from ingredients")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", nargs="*", help="lint just these source files")
    args = parser.parse_args()
    problems: list[str] = []
    if args.check is not None:
        rows: list[dict[str, object]] = []
        for f in args.check:
            rows.extend(parse_file(Path(f), problems))
        # staple completeness only applies to the full build
        before = len(problems)
        lint(rows, problems)
        problems[before:] = [p for p in problems[before:] if "staple" not in p]
        for p in problems:
            print(p)
        print(f"{len(rows)} rows, {len(problems)} problems")
        return 1 if problems else 0
    rows = []
    cat_ids = {c[0] for c in CATEGORIES}
    for path in sorted(SRC.glob("*.txt")):
        if path.stem not in cat_ids:
            problems.append(f"{path.name}: unknown category")
            continue
        rows.extend(parse_file(path, problems))
    lint(rows, problems)
    if problems:
        print("\n".join(problems))
        return 1
    order = {c[0]: i for i, c in enumerate(CATEGORIES)}
    rows.sort(key=lambda r: (order[str(r["category"])], str(r["name"]).casefold()))
    doc = {
        "version": 1,
        "generated": GENERATED,
        "categories": [{"id": i, "name": n, "emoji": e} for i, n, e in CATEGORIES],
        "staples": [{"id": i, "name": n, "pickable": p} for i, n, p in STAPLES],
        "stopWords": STOP_WORDS,
        "ingredients": rows,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} ingredients to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
