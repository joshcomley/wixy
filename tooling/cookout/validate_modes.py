#!/usr/bin/env python3
"""Cookout game-mode validator (workspace 00058, spec/server-chat/09c-cookout-modes.md §8.1).

Stdlib only, fully typed. Used two ways:

* CLI     ``python tooling/cookout/validate_modes.py [modes.json]`` prints one problem per line and
          exits 1 if there are any (defaults to the committed file); ``--summary`` prints the pool
          sizes; ``--rounds N`` sets the simulation size (default 300; the test runs 2,000).
* import  ``validate(path, rounds=...) -> list[str]`` (empty list = valid), used by
          ``wixy_server/tests/test_cookout_modes.py``; also ``summary(path)``.

It runs the strict loader (schema, unknown keys, bad ids, unknown kinds, even turns, prompt
length) and then reports EVERY pool, classification, text and draw problem instead of the first:
the pool-size thresholds that guarantee no real round can run out of offers are validator rules, so
a future bank or list edit that thins a pool fails CI instead of failing a game.
"""

from __future__ import annotations

import argparse
import inspect
import random
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from wixy_server.livechat.cookout_ai import NO_OVEN_TECHNIQUES, TECHNIQUES  # noqa: E402
from wixy_server.livechat.cookout_bank import (  # noqa: E402
    STAPLE_IDS,
    CookoutBank,
    CookoutBankError,
    CookoutExhaustedError,
    Ingredient,
    load_cookout_bank,
)
from wixy_server.livechat.cookout_modes import (  # noqa: E402
    MAX_PROMPT,
    MODES_PATH,
    CookoutMode,
    CookoutModesError,
    PickKind,
    load_cookout_modes,
)

SIMULATED_ROUNDS = 300
ANCHOR_MIN_ITEMS = 40
ANCHOR_MIN_FAMILIES = 10
ANCHOR_MIN_EVERYDAY_FAMILIES = 8
CHEESE_MIN_ITEMS = 120
CHEESE_MIN_EVERYDAY_FAMILIES = 12
FILLING_MIN_ITEMS = 300
FILLING_MIN_CATEGORIES = 3
CHAOS_MIN_EXOTIC = 20
CHAOS_MIN_GROUPS = 2
MIN_BUILDS = 6  # three distinct builds must remain under the no-oven challenge
SIMULATION_SKIPS = 2


def _groups(kind: PickKind, items: list[Ingredient]) -> int:
    if kind.facet == "family":
        return len({i.family for i in items})
    return len({i.category for i in items})


def _pool_problems(mode: CookoutMode, bank: CookoutBank) -> list[str]:
    problems: list[str] = []
    anchor = mode.chef.anchor_kind
    classified: Counter[str] = Counter()
    for ingredient in bank.ingredients:
        owner = mode.kind_of(ingredient.id)
        if owner is not None:
            classified[ingredient.id] += 1
            if ingredient.id not in {c.id for c in mode.kinds[owner].candidates}:
                problems.append(
                    f"{mode.id}: {ingredient.id} is classified {owner} but not a candidate"
                )
    for kind in mode.kinds.values():
        for ingredient in kind.candidates:
            if mode.kind_of(ingredient.id) != kind.id:
                problems.append(
                    f"{mode.id}: {ingredient.id} is in {kind.id} but classified otherwise"
                )
    for sid in STAPLE_IDS:
        found = mode.kind_of(sid)
        if found is not None:
            problems.append(f"{mode.id}: the staple {sid} is offered as a {found}")
    ids = [c.id for k in mode.kinds.values() for c in k.candidates]
    for ingredient_id, n in Counter(ids).items():
        if n > 1:
            problems.append(f"{mode.id}: {ingredient_id} is in {n} kinds")

    for kind in mode.kinds.values():
        items = list(kind.candidates)
        where = f"{mode.id}.{kind.id}"
        if kind.id == anchor:
            families = {i.family for i in items}
            everyday = {i.family for i in items if i.rarity == "everyday"}
            if len(items) < ANCHOR_MIN_ITEMS:
                problems.append(f"{where}: {len(items)} items; need >= {ANCHOR_MIN_ITEMS}")
            if len(families) < ANCHOR_MIN_FAMILIES:
                problems.append(f"{where}: {len(families)} families; need >= {ANCHOR_MIN_FAMILIES}")
            if len(everyday) < ANCHOR_MIN_EVERYDAY_FAMILIES:
                problems.append(
                    f"{where}: {len(everyday)} families with an everyday entry; "
                    f"need >= {ANCHOR_MIN_EVERYDAY_FAMILIES}"
                )
            for i in items:
                if i.category != "grains-bakery":
                    problems.append(f"{where}: {i.id} is in {i.category}, not grains-bakery")
        elif kind.id == "cheese":
            everyday = {i.family for i in items if i.rarity == "everyday"}
            if len(items) < CHEESE_MIN_ITEMS:
                problems.append(f"{where}: {len(items)} items; need >= {CHEESE_MIN_ITEMS}")
            if len(everyday) < CHEESE_MIN_EVERYDAY_FAMILIES:
                problems.append(
                    f"{where}: {len(everyday)} families with an everyday entry; "
                    f"need >= {CHEESE_MIN_EVERYDAY_FAMILIES}"
                )
        else:
            categories = {i.category for i in items}
            if len(items) < FILLING_MIN_ITEMS:
                problems.append(f"{where}: {len(items)} items; need >= {FILLING_MIN_ITEMS}")
            if len(categories) < FILLING_MIN_CATEGORIES:
                problems.append(
                    f"{where}: {len(categories)} categories; need >= {FILLING_MIN_CATEGORIES}"
                )
        if kind.chaos:
            exotic = [i for i in items if i.rarity == "exotic"]
            if len(exotic) < CHAOS_MIN_EXOTIC:
                problems.append(
                    f"{where}: {len(exotic)} exotic items; chaos needs >= {CHAOS_MIN_EXOTIC}"
                )
            if _groups(kind, exotic) < CHAOS_MIN_GROUPS:
                problems.append(
                    f"{where}: exotic items span < {CHAOS_MIN_GROUPS} {kind.facet} groups"
                )
        if len(kind.prompt) > MAX_PROMPT:
            problems.append(f"{where}: prompt {kind.prompt!r} is over {MAX_PROMPT} characters")
        for field_name, text in (("label", kind.label), ("prompt", kind.prompt)):
            if not text.isprintable() or any(c in text for c in "<>&{}"):
                problems.append(f"{where}: {field_name} {text!r} must be plain text")
    return problems


def _text_problems(mode: CookoutMode, bank: CookoutBank) -> list[str]:
    """The mode's server text names no bank food (bread and its own staples excepted), so a prompt
    or picture can never add an unpicked food (§3.6, §8.1)."""
    problems: list[str] = []
    chef, picture = mode.chef, mode.picture
    if chef.format == "classic":
        return problems
    anchor = chef.anchor_kind
    bread_ids = {i.id for i in mode.kinds[anchor].candidates} if anchor else set()
    staples = set(mode.staples.free | mode.staples.capped)
    texts: dict[str, str] = {
        "conceptText": chef.concept_text or "",
        "recipeText": chef.recipe_text or "",
        "styleLine": chef.style_line or "",
        "template": picture.template or "",
        "defaultPresentation": picture.default_presentation or "",
    }
    for build in chef.builds:
        texts[f"build {build.id} promptPhrase"] = build.prompt_phrase
        texts[f"build {build.id} picturePhrase"] = build.picture_phrase
    for name, text in texts.items():
        found = bank.find_contraband_ingredients(
            text, allowed_ingredient_ids=bread_ids, allowed_staple_ids=staples
        )
        if found:
            problems.append(f"{mode.id}: {name} names foods {found}")
    concept_fields = {"bread", "bread_id", "n", "each", "best", "build_list"}
    recipe_fields = {"build_label", "build_phrase"}
    template_fields = {"title", "bread", "build_phrase", "fillings", "presentation"}
    for name, text, allowed in (
        ("conceptText", texts["conceptText"], concept_fields),
        ("recipeText", texts["recipeText"], recipe_fields),
        ("template", texts["template"], template_fields),
    ):
        problems.extend(_placeholder_problems(mode.id, name, text, allowed))
    return problems


def _placeholder_problems(mode_id: str, name: str, text: str, allowed: set[str]) -> list[str]:
    import string

    used: set[str] = set()
    try:
        for _lit, field, _spec, _conv in string.Formatter().parse(text):
            if field is not None:
                used.add(field)
    except ValueError as exc:
        return [f"{mode_id}: {name} is not a valid format string ({exc})"]
    problems = [
        f"{mode_id}: {name} uses unknown placeholder {{{f}}}" for f in sorted(used - allowed)
    ]
    problems += [
        f"{mode_id}: {name} never uses the placeholder {{{f}}}" for f in sorted(allowed - used)
    ]
    return problems


def _chef_problems(mode: CookoutMode) -> list[str]:
    problems: list[str] = []
    chef = mode.chef
    if chef.format == "classic":
        return problems
    for build in chef.builds:
        if build.technique not in TECHNIQUES:
            problems.append(
                f"{mode.id}: build {build.id} has unknown technique {build.technique!r}"
            )
        if build.uses_oven != (build.technique in NO_OVEN_TECHNIQUES):
            problems.append(f"{mode.id}: build {build.id} usesOven disagrees with its technique")
    if len(chef.builds) < MIN_BUILDS:
        problems.append(f"{mode.id}: {len(chef.builds)} builds; need >= {MIN_BUILDS}")
    if sum(1 for b in chef.builds if not b.uses_oven) < 3:
        problems.append(f"{mode.id}: fewer than three builds work without an oven")
    if not mode.fridge_kinds:
        problems.append(f"{mode.id}: fridgeKinds is empty")
    if chef.anchor_kind and chef.anchor_kind not in mode.kinds:
        problems.append(f"{mode.id}: anchorKind {chef.anchor_kind!r} is not a kind")
    capped_over = mode.staples.cap > len(mode.staples.capped)
    if capped_over:
        problems.append(f"{mode.id}: staple cap {mode.staples.cap} exceeds the capped staples")
    return problems


# -- the draw simulation (§8.1) -----------------------------------------------------------------


def _supports_kind_draw(bank: CookoutBank) -> bool:
    return "candidates" in inspect.signature(bank.draw_pair).parameters


def _simulate_round(mode: CookoutMode, bank: CookoutBank, seed: int) -> list[str]:
    """One maximum-skip round: every turn offers, skips twice, and picks; each player uses the chaos
    shelf on a random filling turn; one offer is vetoed; a wildcard and a rescue swap are drawn.
    Every emitted pair or replacement is checked against the mode's rules."""
    rng = random.Random(seed)
    problems: list[str] = []
    schedule = mode.build_schedule(rng)
    seen: set[str] = set()
    picked_families: set[str] = set()
    offered_families: set[str] = set()
    picked_ids: list[str] = []
    shown: dict[tuple[int, str], list[str]] = {}
    chaos_turn = {
        p: rng.choice(
            [
                t
                for t in range(p, mode.turns + 1, 2)
                if mode.kinds[mode.kind_for_turn(schedule, t)].chaos
            ]
            or [0]
        )
        for p in (1, 2)
    }
    veto_turn = rng.randint(1, mode.turns)
    tag = f"{mode.id} seed {seed}"

    def facet_key(kind: PickKind, item: Ingredient) -> str:
        return item.family if kind.facet == "family" else item.category

    def check_pair(
        kind: PickKind, pair: tuple[Ingredient, ...], *, exotic: bool, what: str
    ) -> None:
        members = {c.id for c in kind.candidates}
        for item in pair:
            if item.id not in members:
                problems.append(f"{tag}: {what} offered {item.id}, not a {kind.id}")
            if item.id in seen:
                problems.append(f"{tag}: {what} repeated {item.id}")
            if item.family in picked_families:
                problems.append(f"{tag}: {what} offered picked family {item.family}")
        if len(pair) == 2:
            a, b = pair
            if a.family == b.family:
                problems.append(f"{tag}: {what} paired one family {a.family}")
            if kind.facet == "category" and a.category == b.category:
                problems.append(f"{tag}: {what} paired one category {a.category}")
            if exotic and not all(i.rarity == "exotic" for i in pair):
                problems.append(f"{tag}: {what} chaos pair is not both exotic")
            if not exotic and not any(i.rarity == "everyday" for i in pair):
                problems.append(f"{tag}: {what} has no everyday option")

    def draw(kind: PickKind, player: int, *, exotic: bool) -> tuple[Ingredient, Ingredient]:
        history = shown.setdefault((player, kind.facet), [])
        pair = bank.draw_pair(
            role=kind.id,  # type: ignore[arg-type]
            seen_ids=seen,
            picked_families=picked_families,
            offered_families=offered_families,
            player_offered_categories=history,
            rng=rng,
            rarity_mode="exotic" if exotic else "normal",
            candidates=kind.candidates,
            facet=kind.facet,
        )
        check_pair(kind, pair, exotic=exotic, what=f"turn {len(picked_ids) + 1} offer")
        for item in pair:
            seen.add(item.id)
            offered_families.add(item.family)
            history.append(facet_key(kind, item))
        return pair

    try:
        for turn in range(1, mode.turns + 1):
            kind = mode.kinds[mode.kind_for_turn(schedule, turn)]
            player = 1 if turn % 2 else 2
            exotic = turn == chaos_turn[player]
            pair = draw(kind, player, exotic=exotic)
            for _ in range(SIMULATION_SKIPS):
                pair = draw(kind, player, exotic=exotic)
            if turn == veto_turn:
                keep = pair[0]
                history = shown.setdefault((player, kind.facet), [])
                replacement = bank.draw_replacement(
                    role=kind.id,  # type: ignore[arg-type]
                    keep_id=keep.id,
                    seen_ids=seen,
                    picked_families=picked_families,
                    offered_families=offered_families,
                    player_offered_categories=history,
                    rarity_mode="exotic" if exotic else "normal",
                    rng=rng,
                    candidates=kind.candidates,
                    facet=kind.facet,
                )
                check_pair(kind, (keep, replacement), exotic=exotic, what=f"turn {turn} veto")
                seen.add(replacement.id)
                offered_families.add(replacement.family)
                history.append(facet_key(kind, replacement))
                pair = (keep, replacement)
            choice = rng.choice(pair)
            picked_ids.append(choice.id)
            picked_families.add(choice.family)
        # The wildcard cloche (T5), then a rescue swap of a random basket item (T1).
        wild = bank.draw_wildcard(
            seen_ids=seen,
            picked_families=picked_families,
            offered_families=offered_families,
            basket_categories={bank_item(bank, i).category for i in picked_ids},
            rng=rng,
            candidates=mode.filling_candidates(),
        )
        anchor = mode.chef.anchor_kind
        if mode.kind_of(wild.id) is None or mode.kind_of(wild.id) == anchor:
            problems.append(f"{tag}: wildcard {wild.id} is not a filling")
        if wild.id in seen:
            problems.append(f"{tag}: wildcard repeated {wild.id}")
        seen.add(wild.id)
        target = bank_item(bank, rng.choice(picked_ids))
        swap_kind = mode.kinds[mode.kind_of(target.id) or ""]
        picked_families.discard(target.family)
        pair = draw(swap_kind, 1, exotic=False)
        if all(i.family == target.family for i in pair):
            problems.append(f"{tag}: rescue swap re-offered the swapped-out family")
    except CookoutExhaustedError as exc:
        problems.append(f"{tag}: exhausted ({exc})")
    return problems


def bank_item(bank: CookoutBank, ingredient_id: str) -> Ingredient:
    found = bank.ingredient(ingredient_id)
    if found is None:  # pragma: no cover - ids come from the bank
        raise CookoutBankError(f"unknown ingredient {ingredient_id!r}")
    return found


def simulate(mode: CookoutMode, bank: CookoutBank, rounds: int = SIMULATED_ROUNDS) -> list[str]:
    if mode.plan_type == "classic":
        return []
    if not _supports_kind_draw(bank):
        return []  # TODO(M1 step 3): removed once cookout_bank gains candidates/facet (A.2)
    problems: list[str] = []
    for seed in range(rounds):
        problems.extend(_simulate_round(mode, bank, seed))
        if len(problems) > 30:
            problems.append("... stopping after 30 problems")
            break
    return problems


def validate(
    path: Path | None = None,
    rounds: int = SIMULATED_ROUNDS,
    bank: CookoutBank | None = None,
) -> list[str]:
    """Every problem with the modes file at `path` (default: the committed one); empty = valid."""
    try:
        the_bank = bank or load_cookout_bank()
        modes = load_cookout_modes(the_bank, path)
    except (CookoutBankError, CookoutModesError) as exc:
        return [str(exc)]
    problems: list[str] = []
    for mode in modes.modes:
        if mode.plan_type == "classic":
            continue
        problems += _pool_problems(mode, the_bank)
        problems += _chef_problems(mode)
        problems += _text_problems(mode, the_bank)
        problems += simulate(mode, the_bank, rounds)
    return problems


def summary(path: Path | None = None) -> str:
    bank = load_cookout_bank()
    modes = load_cookout_modes(bank, path)
    lines: list[str] = []
    for mode in modes.modes:
        lines.append(f"{mode.id}: {mode.turns} turns, {mode.picks_per_player} picks each")
        for kind in mode.kinds.values():
            items = kind.candidates
            lines.append(
                f"  {kind.id}: {len(items)} items, {len({i.family for i in items})} families, "
                f"{len({i.category for i in items})} categories, "
                f"{sum(1 for i in items if i.rarity == 'everyday')} everyday, "
                f"{sum(1 for i in items if i.rarity == 'exotic')} exotic"
            )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=Path, default=MODES_PATH)
    parser.add_argument("--summary", action="store_true")
    parser.add_argument("--rounds", type=int, default=SIMULATED_ROUNDS)
    args = parser.parse_args(argv)
    if args.summary:
        print(summary(args.path))
    problems = validate(args.path, args.rounds)
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
