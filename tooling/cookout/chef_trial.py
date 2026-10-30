"""Real-run chef trial for Cookout (round 2, spec/server-chat/09-cookout.md section 3.2).

Draws N random baskets with the REAL bank and draw engine (about a quarter with twists), runs the
REAL concepts job through cmd (`CmdChatClient`, the production prompt builders and validators,
the subscription bucket, sequential with the production spawn gap and repair budget), and records
for each basket whether the chef was accepted on attempt 1..4 or failed, with every violation.
Then it banks a recipe from the first accepted concept of the first R baskets the same way.

Usage (run from the repo root, with cmd's portal and chats services reachable):

    python tooling/cookout/chef_trial.py --baskets 40 --recipes 10 --seed 1 --out triad/cookout/r2

Writes `chef-trial.json` (everything, incl. raw answers) and `chef-trial.md` (the report).
Needs real cmd runs: a basket costs 1-4 subscription chat runs. Never touches the Anthropic API.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from wixy_server.cmdchat import CmdChatClient, CmdChatError  # noqa: E402
from wixy_server.livechat import cookout_ai as ai  # noqa: E402
from wixy_server.livechat.cookout_bank import (  # noqa: E402
    ROLES,
    CookoutBank,
    Ingredient,
    load_cookout_bank,
)
from wixy_server.livechat.cookout_twists import (  # noqa: E402
    CHALLENGE_IDS,
    STYLE_IDS,
)

SPAWN_GAP_S = 5.0
POLL_S = 8.0


@dataclass(slots=True)
class Basket:
    index: int
    ids: list[str]
    twists: ai.ConceptTwists
    kinds: list[str]


@dataclass(slots=True)
class Outcome:
    index: int
    kind: str  # "concepts" | "recipe"
    twists: list[str]
    accepted_on: int | None = None  # 1-based attempt number, None = failed
    attempts: list[dict[str, Any]] = field(default_factory=list)
    value: dict[str, Any] | None = None
    error: str | None = None


def draw_basket(bank: CookoutBank, rng: random.Random, index: int, with_twists: bool) -> Basket:
    """A ten-pick basket from the real draw engine (two players picking at random), plus, when
    `with_twists`, a random mix of style, challenge, stars, wildcard and a swap generation."""
    schedule = bank.shuffle_role_schedule(rng)
    seen: set[str] = set()
    picked_families: set[str] = set()
    offered_families: set[str] = set()
    offered_categories: list[list[str]] = [[], []]
    basket: list[Ingredient] = []
    for turn in range(10):
        role = schedule[turn // 2]
        player = turn % 2
        pair = bank.draw_pair(
            role=role,
            seen_ids=seen,
            picked_families=picked_families,
            offered_families=offered_families,
            player_offered_categories=offered_categories[player],
            rng=rng,
        )
        for option in pair:
            seen.add(option.id)
            offered_families.add(option.family)
            offered_categories[player].append(option.category)
        chosen = rng.choice(pair)
        picked_families.add(chosen.family)
        basket.append(chosen)

    kinds: list[str] = []
    style: str | None = None
    challenge: str | None = None
    stars: frozenset[str] = frozenset()
    wildcard: str | None = None
    forbidden: frozenset[str] = frozenset()
    if with_twists:
        if rng.random() < 0.6:
            style = rng.choice(STYLE_IDS)
            kinds.append(f"style:{style}")
        if rng.random() < 0.6:
            challenge = rng.choice(CHALLENGE_IDS)
            kinds.append(f"challenge:{challenge}")
        if rng.random() < 0.5:
            stars = frozenset(i.id for i in rng.sample(basket, 2))
            kinds.append("stars")
        if rng.random() < 0.4:
            wild = bank.draw_wildcard(
                seen_ids=seen,
                picked_families=picked_families,
                offered_families=offered_families,
                basket_categories={i.category for i in basket},
                rng=rng,
            )
            basket.append(wild)
            wildcard = wild.id
            kinds.append("wildcard")
        if rng.random() < 0.4:
            out = rng.choice([i for i in basket if i.id not in stars and i.id != wildcard])
            role = next(r for r in ROLES if out.role == r)
            fresh = bank.draw_replacement(
                role=role,
                keep_id=rng.choice([i for i in basket if i.id != out.id]).id,
                seen_ids={i.id for i in basket} | seen,
                picked_families={i.family for i in basket},
                offered_families=offered_families,
                player_offered_categories=[],
                rng=rng,
            )
            basket = [fresh if i.id == out.id else i for i in basket]
            forbidden = frozenset({out.id})
            kinds.append("swap")
        if not kinds:  # ask for twists, get at least one
            style = rng.choice(STYLE_IDS)
            kinds.append(f"style:{style}")
    twists = ai.ConceptTwists(
        star_ids=stars,
        wildcard_id=wildcard,
        style=style,
        challenge=challenge,
        forbidden_ids=forbidden,
    )
    return Basket(index=index, ids=[i.id for i in basket], twists=twists, kinds=kinds)


class Trial:
    def __init__(self, bank: CookoutBank, work_dir: Path) -> None:
        self.bank = bank
        self.client = CmdChatClient()
        self.cwd = work_dir
        self._last_spawn = 0.0

    async def close(self) -> None:
        await self.client.aclose()

    async def _run_once(self, caller: str, prompt: str) -> tuple[str, str]:
        wait = SPAWN_GAP_S - (time.monotonic() - self._last_spawn)
        if wait > 0:
            await asyncio.sleep(wait)
        run = await self.client.spawn_run(
            caller=caller,
            prompt=prompt,
            model=ai.MODEL,
            effort=ai.EFFORT,
            cwd=self.cwd.as_posix(),
            timeout_secs=ai.RUN_TIMEOUT_S,
            disallowed_tools=list(ai.DISALLOWED_TOOLS),
        )
        self._last_spawn = time.monotonic()
        deadline = time.monotonic() + ai.RUN_TIMEOUT_S + 120
        while time.monotonic() < deadline:
            await asyncio.sleep(POLL_S)
            state = await self.client.get_run(run.run_id)
            if state.status == "completed":
                return state.status, state.response_text or ""
            if state.status in ("error", "timeout", "cancelled"):
                return state.status, state.response_text or ""
        return "timeout", ""

    async def drive(
        self, caller: str, prompt: str, parse: Any, outcome: Outcome
    ) -> dict[str, Any] | None:
        """The production loop: the run, then up to MAX_REPAIRS repairs naming the violations."""
        current = prompt
        for attempt in range(1, ai.MAX_REPAIRS + 2):
            try:
                status, text = await self._run_once(caller, current)
            except CmdChatError as exc:
                outcome.attempts.append(
                    {"attempt": attempt, "status": "cmd-error", "error": str(exc)}
                )
                outcome.error = f"cmd error: {exc}"
                return None
            if status != "completed":
                outcome.attempts.append({"attempt": attempt, "status": status})
                if status == "error" and attempt == 1:
                    continue  # production retries one early run error
                outcome.error = f"run ended {status}"
                return None
            parsed = parse(text)
            outcome.attempts.append(
                {
                    "attempt": attempt,
                    "status": "ok" if parsed.value is not None else "rejected",
                    "violations": list(parsed.violations),
                    "answer": text,
                }
            )
            if parsed.value is not None:
                outcome.accepted_on = attempt
                return dict(parsed.value)
            current = prompt + ai.build_repair_suffix(parsed.violations)
        outcome.error = "rejected after every repair"
        return None

    async def concepts(self, basket: Basket) -> Outcome:
        outcome = Outcome(basket.index, "concepts", basket.kinds)
        payload = ai.basket_payload(self.bank, basket.ids, twists=basket.twists)
        assert payload is not None
        forbidden_names = [
            ai.display_name(self.bank, i)
            for i in ai.known_forbidden(self.bank, basket.twists.forbidden_ids)
        ]
        prompt = ai.build_concepts_prompt(payload, forbidden_names=forbidden_names)

        def parse(text: str) -> ai.Parsed:
            return ai.parse_concepts(
                text, bank=self.bank, picked_ids=basket.ids, twists=basket.twists
            )

        outcome.value = await self.drive(ai.CONCEPTS_CALLER, prompt, parse, outcome)
        return outcome

    async def recipe(self, basket: Basket, concept: dict[str, Any]) -> Outcome:
        outcome = Outcome(basket.index, "recipe", basket.kinds)
        rt = ai.RecipeTwists(
            star_ids=basket.twists.star_ids,
            style=basket.twists.style,
            challenge=basket.twists.challenge,
            forbidden_ids=basket.twists.forbidden_ids,
        )
        manifest = ai.concept_manifest(concept, self.bank, forbidden_ids=rt.forbidden_ids)
        prompt = ai.build_recipe_prompt(concept, manifest, twists=rt)

        def parse(text: str) -> ai.Parsed:
            return ai.parse_recipe(text, bank=self.bank, concept=concept, twists=rt)

        outcome.value = await self.drive(ai.RECIPE_CALLER, prompt, parse, outcome)
        return outcome


def summarise(outcomes: list[Outcome]) -> dict[str, Any]:
    total = len(outcomes)
    accepted = [o for o in outcomes if o.accepted_on is not None]
    first = [o for o in accepted if o.accepted_on == 1]
    by_attempt = {n: sum(1 for o in accepted if o.accepted_on == n) for n in range(1, 5)}
    return {
        "total": total,
        "accepted": len(accepted),
        "accepted_first_attempt": len(first),
        "by_attempt": by_attempt,
        "failed": [o.index for o in outcomes if o.accepted_on is None],
    }


def render_markdown(
    seed: int, concepts: list[Outcome], recipes: list[Outcome], baskets: dict[int, Basket]
) -> str:
    lines = ["# Cookout chef trial (round 2)", ""]
    lines.append(
        f"Seed {seed}. Real cmd runs: model `{ai.MODEL}`, effort `{ai.EFFORT}`, production prompts "
        f"and validators, up to {ai.MAX_REPAIRS} repairs per job."
    )
    for title, outs in (("Concepts", concepts), ("Bank-it recipes", recipes)):
        s = summarise(outs)
        lines += ["", f"## {title}", ""]
        lines.append(
            f"- accepted: **{s['accepted']} of {s['total']}**; on the first attempt: "
            f"**{s['accepted_first_attempt']}**; by attempt: {s['by_attempt']}; "
            f"failed: {s['failed']}"
        )
        lines += [
            "",
            "| # | twists | accepted on | first-attempt violations |",
            "|---|---|---|---|",
        ]
        for o in outs:
            first_violations = ""
            if o.attempts and o.attempts[0].get("status") == "rejected":
                first_violations = "; ".join(o.attempts[0]["violations"][:4]).replace("|", "/")
            kinds = ", ".join(o.twists) or "none"
            lines.append(
                f"| {o.index} | {kinds} | {o.accepted_on or 'FAILED'} | {first_violations} |"
            )
        lines += ["", "### Every rejection (all attempts)", ""]
        for o in outs:
            for a in o.attempts:
                if a.get("status") == "rejected":
                    lines.append(f"- basket {o.index} attempt {a['attempt']}:")
                    lines.extend(f"  - {v}" for v in a["violations"])
    lines += ["", "## Baskets", ""]
    for index, b in sorted(baskets.items()):
        names = ", ".join(sorted(b.ids))
        lines.append(f"- {index}: {names}")
    return "\n".join(lines) + "\n"


async def main_async(args: argparse.Namespace) -> int:
    bank = load_cookout_bank()
    rng = random.Random(args.seed)
    twist_slots = set(rng.sample(range(args.baskets), max(1, args.baskets // 4)))
    baskets = [draw_basket(bank, rng, i, i in twist_slots) for i in range(args.baskets)]
    if args.only:
        wanted_ids = {int(x) for x in args.only.split(",")}
        baskets = [b for b in baskets if b.index in wanted_ids]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="cookout-trial-"))
    trial = Trial(bank, work)
    concepts: list[Outcome] = []
    recipes: list[Outcome] = []
    by_index = {b.index: b for b in baskets}

    def dump() -> None:
        payload = {
            "seed": args.seed,
            "concepts": [asdict(o) for o in concepts],
            "recipes": [asdict(o) for o in recipes],
            "baskets": {i: {"ids": b.ids, "twists": b.kinds} for i, b in by_index.items()},
        }
        (out_dir / "chef-trial.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")
        (out_dir / "chef-trial.md").write_text(
            render_markdown(args.seed, concepts, recipes, by_index), encoding="utf-8"
        )

    try:
        for basket in baskets:
            outcome = await trial.concepts(basket)
            concepts.append(outcome)
            print(
                f"basket {basket.index}: concepts "
                f"{'accepted on ' + str(outcome.accepted_on) if outcome.accepted_on else 'FAILED'} "
                f"({', '.join(basket.kinds) or 'no twists'})",
                flush=True,
            )
            dump()
        wanted = args.recipes
        for outcome in concepts:
            if wanted <= 0:
                break
            if outcome.value is None:
                continue
            concept = outcome.value["concepts"][0]
            result = await trial.recipe(by_index[outcome.index], concept)
            recipes.append(result)
            wanted -= 1
            print(
                f"basket {outcome.index}: recipe "
                f"{'accepted on ' + str(result.accepted_on) if result.accepted_on else 'FAILED'}",
                flush=True,
            )
            dump()
    finally:
        await trial.close()
        dump()
    sc, sr = summarise(concepts), summarise(recipes)
    print(json.dumps({"concepts": sc, "recipes": sr}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baskets", type=int, default=40)
    parser.add_argument("--recipes", type=int, default=10)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--only", default="", help="re-run only these basket indexes (same seed)")
    parser.add_argument("--out", default="triad/cookout/r2")
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
