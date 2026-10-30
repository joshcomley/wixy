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

`--mode toastie` (spec 09c §8.4) draws Toasted sandwich baskets with the real modes and bank, runs
the production prompt and validator, lists every `Parsed.signals` entry in full for a person to
read, replays the review's example phrasings (short bread names, "never an open sandwich",
"-inspired" fillings) through the real validator, and with `--pictures N` renders N accepted
concepts on hub's ComfyUI (behind the empty-queue gate) and asks the round-2 checker model (Haiku)
"is this one closed toasted sandwich, cut to show its filling, with no open sandwich and no text?"
(plus one Classic basket picture as a control that must be answered no).
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import random
import re
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
from wixy_server.livechat.cookout_modes import CookoutMode, default_modes  # noqa: E402
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
    mode_id: str = "classic"
    bread_id: str | None = None


@dataclass(slots=True)
class Outcome:
    index: int
    kind: str  # "concepts" | "recipe"
    twists: list[str]
    accepted_on: int | None = None  # 1-based attempt number, None = failed
    attempts: list[dict[str, Any]] = field(default_factory=list)
    value: dict[str, Any] | None = None
    error: str | None = None
    signals: list[str] = field(default_factory=list)  # every Parsed.signals note, all attempts


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


def _pair_for_kind(
    bank: CookoutBank,
    mode: CookoutMode,
    kind: str,
    rng: random.Random,
    seen: set[str],
    picked_families: set[str],
    offered_families: set[str],
    offered_facets: list[str],
) -> tuple[Ingredient, Ingredient]:
    """The two options of one offer for a Toasted sandwich kind: the real draw engine with the
    mode's pool and facet when the bank has the 09c arguments (A.2), else an equivalent random
    pair (two different families, at least one everyday) so the trial can run before they land."""
    spec = mode.kinds[kind]
    try:
        return bank.draw_pair(  # type: ignore[call-arg]
            role=kind,  # type: ignore[arg-type]
            seen_ids=seen,
            picked_families=picked_families,
            offered_families=offered_families,
            player_offered_categories=offered_facets,
            rng=rng,
            candidates=spec.candidates,
            facet=spec.facet,
        )
    except TypeError:
        pool = [i for i in spec.candidates if i.id not in seen and i.family not in picked_families]
        for _ in range(200):
            first, second = rng.sample(pool, 2)
            if first.family != second.family and "everyday" in (first.rarity, second.rarity):
                return first, second
        raise RuntimeError(f"cannot draw a {kind} pair") from None


def draw_toastie_basket(
    bank: CookoutBank, mode: CookoutMode, rng: random.Random, index: int, with_twists: bool
) -> Basket:
    """A Toasted sandwich basket: the mode's schedule, two players picking at random from the
    drawn pairs, plus (when `with_twists`) a random mix of style, challenge, stars, a wildcard
    from the filling pools and a rescue swap that deals the same kind."""
    schedule = mode.build_schedule(rng)
    seen: set[str] = set()
    picked_families: set[str] = set()
    offered_families: set[str] = set()
    offered: list[list[str]] = [[], []]
    basket: list[Ingredient] = []
    for turn in range(1, mode.turns + 1):
        kind = mode.kind_for_turn(schedule, turn)
        player = (turn - 1) % 2
        pair = _pair_for_kind(
            bank, mode, kind, rng, seen, picked_families, offered_families, offered[player]
        )
        for option in pair:
            seen.add(option.id)
            offered_families.add(option.family)
            facet_value = option.family if mode.kinds[kind].facet == "family" else option.category
            offered[player].append(facet_value)
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
            pool = [
                i for i in mode.filling_candidates() if i.id not in seen and i.rarity != "everyday"
            ]
            wild = rng.choice(pool)
            basket.append(wild)
            wildcard = wild.id
            kinds.append("wildcard")
        if rng.random() < 0.4:
            out = rng.choice([i for i in basket if i.id not in stars and i.id != wildcard])
            kind_out = mode.kind_of(out.id)
            if kind_out is not None:
                families = {b.family for b in basket}
                swap_pool = [
                    i
                    for i in mode.kinds[kind_out].candidates
                    if i.id not in seen and i.family not in families
                ]
                fresh = rng.choice(swap_pool)
                basket = [fresh if i.id == out.id else i for i in basket]
                forbidden = frozenset({out.id})
                kinds.append("swap")
        if not kinds:
            style = rng.choice(STYLE_IDS)
            kinds.append(f"style:{style}")
    twists = ai.ConceptTwists(
        star_ids=stars,
        wildcard_id=wildcard,
        style=style,
        challenge=challenge,
        forbidden_ids=forbidden,
    )
    bread = next((i.id for i in basket if mode.kind_of(i.id) == mode.chef.anchor_kind), None)
    return Basket(
        index=index,
        ids=[i.id for i in basket],
        twists=twists,
        kinds=kinds,
        mode_id=mode.id,
        bread_id=bread,
    )


class Trial:
    def __init__(self, bank: CookoutBank, work_dir: Path, mode: CookoutMode) -> None:
        self.bank = bank
        self.mode = mode
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

    async def run_checker(self, prompt: str, cwd: Path) -> tuple[str, str]:
        """One round-2 checker run (Haiku, file-reading tool profile) in `cwd`, which holds the
        picture to look at. Returns (status, final text)."""
        wait = SPAWN_GAP_S - (time.monotonic() - self._last_spawn)
        if wait > 0:
            await asyncio.sleep(wait)
        run = await self.client.spawn_run(
            caller="wixy-cookout-trial-picture",
            prompt=prompt,
            model="claude-haiku-5-5",
            effort="medium",
            cwd=cwd.as_posix(),
            timeout_secs=300,
            disallowed_tools=[],
            provider="claude",
            tool_profile="replay_probe",
        )
        self._last_spawn = time.monotonic()
        deadline = time.monotonic() + 300 + 120
        while time.monotonic() < deadline:
            await asyncio.sleep(POLL_S)
            state = await self.client.get_run(run.run_id)
            if state.status in ("completed", "error", "timeout", "cancelled"):
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
        prompt = ai.build_concepts_prompt(payload, mode=self.mode, forbidden_names=forbidden_names)

        def parse(text: str) -> ai.Parsed:
            parsed = ai.parse_concepts(
                text,
                bank=self.bank,
                picked_ids=basket.ids,
                mode=self.mode,
                bread_id=basket.bread_id,
                twists=basket.twists,
            )
            outcome.signals.extend(parsed.signals)
            return parsed

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
        manifest = ai.concept_manifest(
            concept, self.bank, forbidden_ids=rt.forbidden_ids, mode=self.mode
        )
        prompt = ai.build_recipe_prompt(concept, manifest, mode=self.mode, twists=rt)

        def parse(text: str) -> ai.Parsed:
            return ai.parse_recipe(text, bank=self.bank, concept=concept, mode=self.mode, twists=rt)

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


REPLAY_VARIANTS = ("short-bread-name", "never-an-open-sandwich", "inspired-filling")
"""The review's example phrasings (09c §3.4, §7): a short form of the bread's name, a description
that says "never an open sandwich", and a "-inspired" filling. Each must be ACCEPTED."""


def seeded_replays(
    bank: CookoutBank,
    mode: CookoutMode,
    concepts: list[Outcome],
    baskets: dict[int, Basket],
    want: int,
) -> list[dict[str, Any]]:
    """Take `want` accepted real answers, rewrite their three ideas with the review's phrasings and
    run each through the REAL validator: every one must still be accepted (a signal is a note,
    never a failure). Returns one record per replayed basket."""
    results: list[dict[str, Any]] = []
    for outcome in concepts:
        if len(results) >= want:
            break
        basket = baskets.get(outcome.index)
        if outcome.value is None or basket is None or basket.bread_id is None:
            continue
        value = copy.deepcopy(outcome.value)
        bread = bank.ingredient(basket.bread_id)
        assert bread is not None
        short = re.sub(r"[^A-Za-z]+", " ", bread.name).split()[0]
        edits: list[str] = []
        for concept, variant in zip(value["concepts"], REPLAY_VARIANTS, strict=True):
            filling = next(
                (
                    bank.ingredient(i)
                    for i in concept["pickedIngredientIds"]
                    if i != basket.bread_id and bank.ingredient(i) is not None
                ),
                None,
            )
            assert filling is not None
            if variant == "short-bread-name":
                concept["title"] = f"{short} toastie {concept['id']}"
            elif variant == "never-an-open-sandwich":
                concept["description"] = (
                    f"A closed {bread.name.lower()} toastie, never an open sandwich."
                )
            else:
                concept["description"] = (
                    f"A closed {bread.name.lower()} toastie with bruschetta-inspired "
                    f"{filling.name.lower()} filling."
                )
            stars = [
                n.name
                for n in (bank.ingredient(i) for i in sorted(basket.twists.star_ids))
                if n is not None and n.id != basket.bread_id
            ]
            if variant != "short-bread-name" and stars:
                # a star must still be named in the prose (only the bread is exempt, 09c §3.4)
                concept["description"] += f" Starring {', '.join(stars)}."
            edits.append(f"{concept['id']}: {variant}")
        parsed = ai.parse_concepts(
            json.dumps(value),
            bank=bank,
            picked_ids=basket.ids,
            mode=mode,
            bread_id=basket.bread_id,
            twists=basket.twists,
        )
        results.append(
            {
                "basket": outcome.index,
                "edits": edits,
                "accepted": parsed.value is not None,
                "violations": list(parsed.violations),
                "signals": list(parsed.signals),
                "concepts": [
                    {"id": c["id"], "title": c["title"], "description": c["description"]}
                    for c in value["concepts"]
                ],
            }
        )
    return results


PICTURE_QUESTION = (
    "Is this one closed toasted sandwich, cut to show its filling, with no open sandwich and no "
    "text?"
)


def _check_prompt() -> str:
    return (
        "You are checking one picture for a cooking game. Use your file-reading tool to look at "
        "the image file `1.webp` in the current working directory, then answer this question "
        f'about it: "{PICTURE_QUESTION}"\n\nReply with exactly one JSON object and nothing '
        'else: {"verdict": "yes" | "no", "seen": "what you see, in at most 25 words", '
        '"reason": "one short sentence"}'
    )


async def picture_phase(
    trial: Trial,
    mode: CookoutMode,
    concepts: list[Outcome],
    baskets: dict[int, Basket],
    count: int,
    out_dir: Path,
    seed: int,
) -> list[dict[str, Any]]:
    """Render `count` accepted concepts on hub's ComfyUI (the production picture prompt, behind
    the empty-queue gate, one at a time) and ask Haiku the picture question of each; one Classic
    picture is checked as a control that must be answered `no`."""
    from PIL import Image

    from tooling.cookout.visual.images import comfy_queue_getter, wait_for_idle
    from wixy_server.livechat.cookout_images import concept_prompts
    from wixy_server.livechat.wyr_images import ComfyImageGenerator

    env = _load_env(Path(os.environ.get("WIXY_ENV_FILE", r"D:\Servers\Wixy\Storage\.env")))
    base_url = env.get("WIXY_COMFY_URL", "http://127.0.0.1:8199")
    comfy_out = env.get("WIXY_COMFY_OUTPUT_DIR")
    if not comfy_out:
        raise RuntimeError("WIXY_COMFY_OUTPUT_DIR is not set; refusing to render")
    generator = ComfyImageGenerator(base_url, output_dir=Path(comfy_out))
    get_queue = comfy_queue_getter(base_url)
    pictures_dir = out_dir / "pictures"
    pictures_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    namer = ai.BankNamer(trial.bank)
    chosen = [o for o in concepts if o.value is not None][:count]
    records: list[dict[str, Any]] = []
    jobs: list[tuple[str, Path | None, dict[str, Any]]] = []
    for position, outcome in enumerate(chosen, start=1):
        basket = baskets[outcome.index]
        assert outcome.value is not None
        row = {
            "mode": mode.id,
            "bread_id": basket.bread_id,
            "style": basket.twists.style,
            "concepts_json": json.dumps(outcome.value),
        }
        prompts = concept_prompts(row, namer)
        assert prompts is not None
        slot = rng.choice(sorted(prompts))
        concept = next(c for c in outcome.value["concepts"] if c["id"] == slot)
        record = {
            "basket": outcome.index,
            "slot": slot,
            "title": concept["title"],
            "build": concept.get("build"),
            "prompt": prompts[slot],
        }
        jobs.append((f"{position:02d}-basket{outcome.index}-{slot}", None, record))
    work = Path(tempfile.mkdtemp(prefix="cookout-trial-pics-"))
    for name, _unused, record in jobs:
        ok = await asyncio.to_thread(wait_for_idle, get_queue, max_wait_s=6 * 3600.0)
        if not ok:
            record["error"] = "ComfyUI never went idle"
            records.append(record)
            continue
        scratch = work / "render"
        scratch.mkdir(exist_ok=True)
        try:
            paths = await asyncio.to_thread(
                generator.generate_many,
                [record["prompt"]],
                scratch,
                seeds=[rng.randrange(2**32)],
            )
        except Exception as exc:  # a render failure is a finding, not a crash
            record["error"] = f"render failed: {exc}"
            records.append(record)
            continue
        png = paths[0] if paths else None
        if png is None:
            record["error"] = "no picture produced"
            records.append(record)
            continue
        target = pictures_dir / f"{name}.webp"
        with Image.open(png) as im:
            im.convert("RGB").resize((512, 512), Image.Resampling.LANCZOS).save(
                target, "WEBP", quality=82, method=6
            )
        png.unlink(missing_ok=True)
        record["file"] = target.name
        records.append(record)
    control = ROOT / "admin-ui" / "data" / "cookout-mode-classic.webp"
    if control.exists():
        records.append(
            {
                "basket": None,
                "slot": "control",
                "title": "Classic basket tile (must be answered no)",
                "build": None,
                "prompt": "",
                "file": control.name,
                "control_source": str(control),
            }
        )
    for record in records:
        source = (
            Path(record["control_source"])
            if "control_source" in record
            else pictures_dir / record["file"]
            if "file" in record
            else None
        )
        if source is None:
            continue
        check_dir = Path(tempfile.mkdtemp(prefix="check-", dir=work))
        (check_dir / "1.webp").write_bytes(source.read_bytes())
        try:
            status, text = await trial.run_checker(_check_prompt(), check_dir)
        except CmdChatError as exc:
            record["error"] = f"checker: {exc}"
            continue
        verdict = None
        for obj in reversed(ai.json_objects(text)):
            if isinstance(obj, dict) and obj.get("verdict") in ("yes", "no"):
                verdict = obj
                break
        record["checker_status"] = status
        record["checker"] = verdict
        record["checker_raw"] = text if verdict is None else None
    return records


def _load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                out[key.strip()] = value.strip()
    return out


def _concept_text(outcome: Outcome | None, concept_id: str) -> str:
    """The title and description of concept `concept_id`, for the person reading a signal."""
    if outcome is None:
        return ""
    sources: list[Any] = []
    if outcome.value is not None:
        sources.append(outcome.value)
    for attempt in outcome.attempts:
        sources.extend(ai.json_objects(str(attempt.get("answer") or "")))
    for source in sources:
        if isinstance(source, dict):
            for concept in source.get("concepts") or []:
                if isinstance(concept, dict) and concept.get("id") == concept_id:
                    return f"{concept.get('title')!s} -- {concept.get('description')!s}"
    return ""


def render_markdown(
    seed: int,
    concepts: list[Outcome],
    recipes: list[Outcome],
    baskets: dict[int, Basket],
    *,
    mode_id: str = "classic",
    replays: list[dict[str, Any]] | None = None,
    pictures: list[dict[str, Any]] | None = None,
) -> str:
    title = (
        "Cookout chef trial (round 2)" if mode_id == "classic" else f"Cookout chef trial: {mode_id}"
    )
    lines = [f"# {title}", ""]
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
    if mode_id != "classic":
        by_index = {o.index: o for o in concepts}
        lines += ["", "## Review signals (every one is read by a person)", ""]
        signalled = [o for o in concepts if o.signals]
        if not signalled:
            lines.append("None raised.")
        for o in signalled:
            for note in o.signals:
                cid = note.split(":", 1)[0].rsplit(" ", 1)[-1]
                lines.append(f"- basket {o.index} {note}")
                lines.append(f"  - text: {_concept_text(by_index.get(o.index), cid)}")
                lines.append(
                    "  - read by hand: _(note whether it really was a closed toasted sandwich)_"
                )
        lines += ["", "## Replayed review phrasings (each must be accepted)", ""]
        for r in replays or []:
            verdict = "ACCEPTED" if r["accepted"] else "REJECTED"
            lines.append(f"- basket {r['basket']}: **{verdict}**; signals {r['signals']}")
            lines.extend(
                f"  - {c['id']}: {c['title']} -- {c['description']}" for c in r["concepts"]
            )
            lines.extend(f"  - violation: {v}" for v in r["violations"])
        lines += ["", "## Pictures (Haiku: " + PICTURE_QUESTION + ")", ""]
        for pic in pictures or []:
            checker = pic.get("checker") or {}
            lines.append(
                f"- {pic.get('file', '(none)')} basket {pic['basket']} slot {pic['slot']} "
                f"build {pic.get('build')}: **{checker.get('verdict', pic.get('error', '?'))}**"
                f" -- {checker.get('seen', '')} / {checker.get('reason', '')}"
            )
    lines += ["", "## Baskets", ""]
    for index, b in sorted(baskets.items()):
        names = ", ".join(sorted(b.ids))
        lines.append(f"- {index}: {names}")
    return "\n".join(lines) + "\n"


async def main_async(args: argparse.Namespace) -> int:
    bank = load_cookout_bank()
    mode = default_modes().mode(args.mode)
    if mode is None:
        print(f"unknown game mode {args.mode!r}", file=sys.stderr)
        return 2
    rng = random.Random(args.seed)
    twist_slots = set(rng.sample(range(args.baskets), max(1, args.baskets // 4)))
    if mode.chef.format == "single-dish":
        baskets = [
            draw_toastie_basket(bank, mode, rng, i, i in twist_slots) for i in range(args.baskets)
        ]
    else:
        baskets = [draw_basket(bank, rng, i, i in twist_slots) for i in range(args.baskets)]
    if args.only:
        wanted_ids = {int(x) for x in args.only.split(",")}
        baskets = [b for b in baskets if b.index in wanted_ids]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="cookout-trial-"))
    trial = Trial(bank, work, mode)
    concepts: list[Outcome] = []
    recipes: list[Outcome] = []
    replays: list[dict[str, Any]] = []
    pictures: list[dict[str, Any]] = []
    by_index = {b.index: b for b in baskets}

    def dump() -> None:
        payload = {
            "seed": args.seed,
            "concepts": [asdict(o) for o in concepts],
            "recipes": [asdict(o) for o in recipes],
            "baskets": {i: {"ids": b.ids, "twists": b.kinds} for i, b in by_index.items()},
            "mode": mode.id,
            "replays": replays,
            "pictures": pictures,
        }
        (out_dir / "chef-trial.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")
        (out_dir / "chef-trial.md").write_text(
            render_markdown(
                args.seed,
                concepts,
                recipes,
                by_index,
                mode_id=mode.id,
                replays=replays,
                pictures=pictures,
            ),
            encoding="utf-8",
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
        if mode.chef.format == "single-dish":
            replays.extend(seeded_replays(bank, mode, concepts, by_index, args.replays))
            dump()
            if args.pictures:
                pictures.extend(
                    await picture_phase(
                        trial, mode, concepts, by_index, args.pictures, out_dir, args.seed
                    )
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
    parser.add_argument("--mode", default="classic", help="game mode id: classic | toastie")
    parser.add_argument(
        "--replays", type=int, default=4, help="accepted answers replayed with the review phrasings"
    )
    parser.add_argument(
        "--pictures", type=int, default=0, help="accepted concepts to render and check (toastie)"
    )
    parser.add_argument("--out", default="triad/cookout/r2")
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
