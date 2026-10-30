#!/usr/bin/env python3
"""Reason-recorded differential and full invariant sweep for the Cookout prose scan (audit F4).

    python tooling/cookout/f4_differential.py gen cases.json            # 3000 random baskets
    python tooling/cookout/f4_differential.py run cases.json out.json   # scan with THIS tree
    python tooling/cookout/f4_differential.py report cases.json pre.json tip.json new.json out.md
    python tooling/cookout/f4_differential.py invariant                 # every bank product x pick

`run` is executed once per tree (the pre-round-2 scan, the previous tip, this branch) with
PYTHONPATH pointing at that tree; only this branch records `reasons`. `report` classes every
newly accepted phrase BY THE REASON THE SCAN GAVE (pick, covered-word, pick-run(N),
byproduct(key, by), family, pasta-shape, ring-shape): a phrase with no reason is a defect, a
pick-run or by-product is listed for a human to read. Every phrase newly flagged is classed as a
distinct product or, when it ends in a by-product head, a curation-gap candidate.
"""

from __future__ import annotations

import json
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
sys.path.append(str(REPO))  # PYTHONPATH picks the tree under test
STAPLES = ["butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk"]


def gen(out: str, baskets: int = 3000, seed: int = 2026) -> None:
    from wixy_server.livechat.cookout_bank import load_cookout_bank, tokenise

    bank = load_cookout_bank()
    rng = random.Random(seed)
    ings = list(bank.ingredients)
    by_tok: dict[str, list[Any]] = defaultdict(list)
    for ing in ings:
        for tok in set(tokenise(ing.name)):
            by_tok[tok].append(ing)
    cases = []
    for _ in range(baskets):
        picks = rng.sample(ings, 10)
        ids = [p.id for p in picks]
        phrases: set[str] = set()
        for pick in picks:
            pool = [x for t in tokenise(pick.name) for x in by_tok.get(t, []) if x.id not in ids]
            for x in rng.sample(pool, min(8, len(pool))):
                phrases.add(x.name)
        for x in rng.sample([i for i in ings if i.id not in ids], 15):
            phrases.add(x.name)
        cases.append({"picks": ids, "staples": rng.sample(STAPLES, 2), "phrases": sorted(phrases)})
    Path(out).write_text(json.dumps(cases), encoding="utf-8")
    print(f"{len(cases)} baskets, {sum(len(c['phrases']) for c in cases)} phrases")


def run(cases_path: str, out: str) -> None:
    from wixy_server.livechat.cookout_bank import load_cookout_bank

    bank = load_cookout_bank()
    ids = {i.id for i in bank.ingredients}
    results: list[dict[str, Any]] = []
    for case in json.loads(Path(cases_path).read_text(encoding="utf-8")):
        picks = {p for p in case["picks"] if p in ids}
        row: dict[str, Any] = {}
        for phrase in case["phrases"]:
            reasons: list[tuple[str, str]] = []
            kwargs: dict[str, Any] = {
                "allowed_ingredient_ids": picks,
                "allowed_staple_ids": set(case["staples"]),
            }
            try:
                flagged = bank.find_contraband_ingredients(
                    "serve with " + phrase, reasons=reasons, **kwargs
                )
            except TypeError:  # an older tree without `reasons`
                flagged = bank.find_contraband_ingredients("serve with " + phrase, **kwargs)
            row[phrase] = [flagged, reasons]
        results.append(row)
    Path(out).write_text(json.dumps(results), encoding="utf-8")


def report(cases_path: str, pre_path: str, tip_path: str, new_path: str, out: str) -> None:
    from wixy_server.livechat.cookout_bank import BYPRODUCT_HEADS, load_cookout_bank, tokenise

    listed = {" ".join(k) for k in load_cookout_bank().byproducts}

    cases = json.loads(Path(cases_path).read_text(encoding="utf-8"))
    pre, tip, new = (
        json.loads(Path(p).read_text(encoding="utf-8")) for p in (pre_path, tip_path, new_path)
    )
    lines = ["# Audit F4 differential (reason-recorded)", ""]
    for label, base in (("the scan before round 2", pre), ("the previous tip (2a20ccd1)", tip)):
        accepted: dict[str, list[str]] = defaultdict(list)
        flagged: Counter[str] = Counter()
        missing: list[str] = []
        for case, was_row, now_row in zip(cases, base, new, strict=True):
            for phrase in case["phrases"]:
                was, now = was_row[phrase][0], now_row[phrase][0]
                if was and not now:
                    span = " ".join(tokenise(phrase))
                    why = [r for r in now_row[phrase][1] if r[0] == span]
                    reason = why[-1][1] if why else ""
                    if not reason:
                        missing.append(phrase)
                    accepted[phrase].append(reason or "NO REASON")
                if not was and now:
                    flagged[phrase] += 1
        kinds: Counter[str] = Counter(rs[0].split("(")[0] for rs in accepted.values())
        lines += [
            f"## Against {label}",
            "",
            f"Newly accepted: {len(accepted)} distinct phrases by reason: {dict(kinds)}.",
            f"Accepted with no recorded reason (defects): {len(missing)}.",
            f"Newly flagged: {len(flagged)} distinct phrases.",
            "",
        ]
        by_reason: dict[str, list[str]] = defaultdict(list)
        for phrase, rs in sorted(accepted.items()):
            by_reason[rs[0].split("(")[0]].append(f"{phrase} [{rs[0]}] x{len(rs)}")
        for kind, items in sorted(by_reason.items()):
            lines += [f"### Newly accepted - {kind} ({len(items)})", ""]
            lines += [f"- {i}" for i in items] + [""]
        gaps, unsupplied, distinct = [], [], []
        for phrase in sorted(flagged):
            toks = tokenise(phrase)
            if len(toks) > 1 and toks[-1] in BYPRODUCT_HEADS:
                (unsupplied if " ".join(toks) in listed else gaps).append(phrase)
            else:
                distinct.append(phrase)
        lines += [
            f"### Newly flagged - listed by-products whose sources the basket lacked ({len(unsupplied)})",
            "",
        ]
        lines += ["; ".join(unsupplied), ""]
        lines += [
            f"### Newly flagged - by-product-shaped phrases NOT on the list: read each for a curation gap ({len(gaps)})",
            "",
        ]
        lines += [f"- {p}" for p in gaps] + [""]
        lines += [f"### Newly flagged - distinct products ({len(distinct)})", ""]
        lines += ["; ".join(distinct), ""]
    Path(out).write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:14]))


def invariant() -> None:
    from wixy_server.livechat.cookout_bank import (
        CONTAINER_WORDS,
        PASTA_SHAPE_FAMILIES,
        load_cookout_bank,
        tokenise,
    )

    bank = load_cookout_bank()
    by_word: dict[str, set[str]] = defaultdict(set)
    for ing in bank.ingredients:
        for word in {w for n in (ing.name, *ing.aliases) for w in tokenise(n)}:
            by_word[word].add(ing.id)
    start = time.time()
    scans = 0
    leaks: dict[str, str] = {}
    for ing in bank.ingredients:
        for name in (ing.name, *ing.aliases):
            words = tokenise(name)
            if len(words) < 2 or bank._dictionary.get(words) != ("ingredient", ing.id):
                continue
            trimmed = words
            while len(trimmed) > 1 and trimmed[-1] in CONTAINER_WORDS:
                trimmed = trimmed[:-1]
            if trimmed in bank._byproduct_lookup:
                continue
            others = set().union(*(by_word[w] for w in set(words))) - {ing.id}
            for pid in sorted(others):
                pick = bank.ingredient(pid)
                assert pick is not None
                if pick.family == ing.family:
                    continue
                if bank._pick_run(words, bank._pick_names({pid}, set()), with_implied=True):
                    continue
                scans += 1
                if not bank.find_contraband_ingredients(
                    "serve with " + name, allowed_ingredient_ids={pid}, allowed_staple_ids=set()
                ):
                    leaks.setdefault(name, pid)
    print(f"{scans} scans in {time.time() - start:.0f}s; leaking phrases: {len(leaks)}")
    for name, pid in sorted(leaks.items()):
        shape = bank._by_id[pid].family in PASTA_SHAPE_FAMILIES
        print(f"  {name} via {pid}{' (pasta)' if shape else ''}")


if __name__ == "__main__":
    mode, *args = sys.argv[1:]
    {"gen": gen, "run": run, "report": report, "invariant": invariant}[mode](*args)
