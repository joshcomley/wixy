#!/usr/bin/env python3
"""Candidate generator for the Cookout `byproducts` list (audit F4, senior ruling).

The scan lets a multi-word bank product through when a dish supplies the foods it is made from
(mushroom sauce from mushrooms, garlic butter from garlic and butter). That list is CURATED
(`tooling/cookout/src/byproducts.json`, copied into the bank by `build_bank.py`); this tool prints
every candidate the bank could add and the difference against the committed list, so a regenerated
bank shows its new candidates for review:

    python tooling/cookout/byproducts.py            # new candidates + stale entries
    python tooling/cookout/byproducts.py --all      # every candidate

Candidate rule: a bank name or alias of 2+ words that ends in a BYPRODUCT_HEADS word, whose leading
non-modifier words are head nouns of other bank items. A human then applies the curation rule:
a cook makes it in the kitchen from its sources (plus water, salt, pepper and pan liquids) by
cooking, juicing, rendering, puréeing, reducing, infusing or mixing, and the sources name every
food that defines it. Sauces named after what they are served with, bottled/fermented/branded
condiments, pressed or milled products (nut oils and butters, flours, starches, date/palm/icing
sugar) and bottled seasoning blends are excluded.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from wixy_server.livechat.cookout_bank import (  # noqa: E402
    BYPRODUCT_HEADS,
    CARRIER_HEADS,
    HEAD_MODIFIERS,
    CookoutBank,
    load_cookout_bank,
    tokenise,
)

LIST = Path(__file__).resolve().parent / "src" / "byproducts.json"


def candidates(bank: CookoutBank) -> dict[str, list[str]]:
    """Every candidate phrase -> proposed sources (the leading phrase, plus the carrier)."""
    heads: set[str] = set()
    for ingredient in bank.ingredients:
        for name in (ingredient.name, *ingredient.aliases):
            heads |= bank._name_heads(name)
    out: dict[str, list[str]] = {}
    for ingredient in bank.ingredients:
        for name in (ingredient.name, *ingredient.aliases):
            words = tokenise(name)
            if len(words) < 2 or words[-1] not in BYPRODUCT_HEADS:
                continue
            if bank._dictionary.get(words) != ("ingredient", ingredient.id):
                continue
            lead = list(words[:-1])
            while lead and lead[0] in HEAD_MODIFIERS:
                lead.pop(0)
            if not lead or not all(t in heads or t in HEAD_MODIFIERS or t == "and" for t in lead):
                continue
            sources = [" ".join(lead)]
            if words[-1] in CARRIER_HEADS:
                sources.append(words[-1])
            out[" ".join(words)] = sources
    return out


def main() -> int:
    bank = load_cookout_bank()
    cand = candidates(bank)
    current: dict[str, list[str]] = (
        json.loads(LIST.read_text(encoding="utf-8")) if LIST.exists() else {}
    )
    show_all = "--all" in sys.argv
    new = {k: v for k, v in cand.items() if k not in current}
    stale = sorted(k for k in current if k not in cand)
    print(f"{len(cand)} candidates, {len(current)} curated, {len(new)} not yet reviewed")
    for key, sources in sorted(cand.items() if show_all else new.items()):
        print(f"  {key!r}: {sources}")
    if stale:
        print("curated but not generated (hand-added; check they still resolve):")
        for key in stale:
            print(f"  {key!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
