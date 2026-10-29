#!/usr/bin/env python3
"""Build the Cookout ingredient catalogue with Haiku via cmd chat-spawn runs (spec 09b §A).

Commands (``python tooling/cookout/visual/catalogue.py [options] <command>``):

* ``author``     Haiku writes `what` / `visual` / `presentation` / 2-3 facts per ingredient.
* ``factcheck``  a second Haiku pass (web allowed) marks each fact true/doubtful/false; bad facts
                 are dropped; an entry left with < 2 facts goes back to ``author`` (max 2 rounds);
                 finished entries are merged into the committed JSON after every batch.
* ``build``      ``author`` and ``factcheck`` repeated until nothing is left to do.
* ``audit``      Sol checks a seeded sample of 150 facts (bar: 146 upheld); a failed audit re-queues
                 the categories with failures for the fact-check pass, with failures as examples.
* ``validate``   ``validate_catalogue.py``'s checks on the committed file.
* ``report``     writes ``triad/cookout/r2/catalogue-report.md``.
* ``status``     counts per stage.

Everything is resumable: ``<work>/catalogue/state.json`` holds the per-ingredient pipeline state
(written atomically after every batch) and ``<work>/catalogue/journal.jsonl`` the run ids (written
before polling, so a crash resumes the same run). The committed file is only ever written whole,
via temp file + replace, with sorted keys so a re-run diffs cleanly.

Offline tooling: the only inputs are the committed bank and the models' answers; no chat content.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import random
import re
import secrets
import sys
import time
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
for _p in (str(REPO), str(HERE.parent)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from tooling.cookout.visual import cmdruns  # noqa: E402
from tooling.cookout.visual import validate_catalogue as vc
from tooling.cookout.visual.cmdruns import (  # noqa: E402
    HAIKU,
    READ_ONLY_DISALLOWED,
    SOL,
    Journal,
    RunPool,
    RunSpec,
)

CATALOGUE = REPO / "wixy_server" / "livechat" / "cookout_catalogue.json"
REPORT = REPO / "triad" / "cookout" / "r2" / "catalogue-report.md"
CALLER = "wixy-cookout-catalogue"

BATCH_SIZE = 20
AUTHOR_TIMEOUT_S = 900
CHECK_TIMEOUT_S = 1200
MAX_AUTHOR_ROUNDS = 2
MAX_FAILURES = 3
MIN_FACTS = 2
AUDIT_SAMPLE = 150
AUDIT_BAR = 146
AUDIT_BATCH = 30
SHUFFLE_SEED = 58

STAGE_AUTHOR, STAGE_CHECK, STAGE_DONE, STAGE_FAILED = "author", "check", "done", "failed"


# ---------------------------------------------------------------- paths and small utilities


def default_work_dir() -> Path:
    root = Path(os.environ.get("AIM_ROOT", "D:\\"))
    return root / "Servers" / "Wixy" / "Storage" / "cookout-images" / "work"


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".tmp{os.getpid()}")
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    os.replace(temp, path)


def dump_json(value: object, *, indent: int | None = 1) -> str:
    return json.dumps(value, sort_keys=True, indent=indent, ensure_ascii=False) + "\n"


def facts_of(entry: Mapping[str, object]) -> list[str]:
    """An entry's fact strings (empty if the field is absent or malformed)."""
    facts = entry.get("facts")
    return [f for f in facts if isinstance(f, str)] if isinstance(facts, list) else []


def parse_json_object(text: str | None) -> tuple[dict[str, object] | None, str | None]:
    """The whole reply must be one JSON object (a ```json fence is tolerated, nothing else)."""
    if text is None or not text.strip():
        return None, "the reply was empty"
    body = text.strip()
    fence = re.fullmatch(r"```(?:json)?\s*\n(.*?)\n```", body, flags=re.DOTALL)
    if fence:
        body = fence.group(1).strip()
    try:
        value = json.loads(body)
    except ValueError as exc:
        return None, f"the reply is not a single JSON object ({exc})"
    if not isinstance(value, dict):
        return None, "the reply is not a JSON object"
    return value, None


def interleave(ids_by_category: Mapping[str, Sequence[str]]) -> list[str]:
    """Round-robin over the categories (each shuffled with a fixed seed): any prefix of the
    result is a stratified slice (spec §A.3)."""
    rng = random.Random(SHUFFLE_SEED)
    queues = []
    for category in sorted(ids_by_category):
        ids = list(ids_by_category[category])
        rng.shuffle(ids)
        queues.append(ids)
    out: list[str] = []
    depth = 0
    while any(depth < len(q) for q in queues):
        out.extend(q[depth] for q in queues if depth < len(q))
        depth += 1
    return out


# ---------------------------------------------------------------- the pipeline state


@dataclass
class Item:
    stage: str = STAGE_AUTHOR
    round: int = 0  # author rounds completed
    failures: int = 0
    draft: dict[str, object] | None = None
    kept: list[str] = field(default_factory=list)  # facts already verified true
    rejected: list[str] = field(default_factory=list)  # facts dropped (author: do not repeat)
    concern: str | None = None
    error: str | None = None

    def to_json(self) -> dict[str, object]:
        return {
            "stage": self.stage,
            "round": self.round,
            "failures": self.failures,
            "draft": self.draft,
            "kept": self.kept,
            "rejected": self.rejected,
            "concern": self.concern,
            "error": self.error,
        }

    @staticmethod
    def from_json(raw: Mapping[str, object]) -> Item:
        def strs(key: str) -> list[str]:
            value = raw.get(key)
            return [s for s in value if isinstance(s, str)] if isinstance(value, list) else []

        draft = raw.get("draft")
        concern, error = raw.get("concern"), raw.get("error")
        stage, rnd, failures = raw.get("stage"), raw.get("round"), raw.get("failures")
        return Item(
            stage=stage if isinstance(stage, str) else STAGE_AUTHOR,
            round=rnd if isinstance(rnd, int) else 0,
            failures=failures if isinstance(failures, int) else 0,
            draft=draft if isinstance(draft, dict) else None,
            kept=strs("kept"),
            rejected=strs("rejected"),
            concern=concern if isinstance(concern, str) else None,
            error=error if isinstance(error, str) else None,
        )


def batch_key(pass_name: str, ids: Sequence[str], items: Mapping[str, Item], tag: str = "") -> str:
    """Stable for the same logical attempt (same ids at the same round/failure counts), so a
    restart finds the journalled run."""
    basis = "|".join(f"{i}:{items[i].round}:{items[i].failures}" for i in sorted(ids)) + tag
    return f"{pass_name}-{hashlib.sha1(basis.encode()).hexdigest()[:12]}"


# ---------------------------------------------------------------- prompts and parsers

AUTHOR_RULES = """\
You are writing catalogue entries for a cooking game. Each ingredient gets a picture card: a studio
photograph, a one-line "what it is" caption, and 2-3 fun facts shown while players wait. Write for
British English readers who may never have heard of the ingredient.

For EACH ingredient below return:
- "what": 10-72 characters, one plain sentence saying what it is ("A large tropical sea crustacean
  with sweet, lobster-like meat."). Do NOT start with the ingredient's own name. No emoji, no HTML.
- "visual": 30-260 characters describing the ONE subject of the photograph, as a shopper or cook would
  see it raw or as bought: a whole lemon, a fillet of salmon, a bunch of parsley, a small heap of
  cumin seeds, a block of cheese with one wedge cut. Liquids, pastes, powders and small loose items
  go in a PLAIN vessel: "a small plain white ceramic bowl", "a plain unlabelled clear glass bottle",
  "a plain glass jar without a label", "a clear drinking glass". Prepared foods (baked beans, ramen,
  toast) are shown AS THE FOOD, served plainly in a small plain white bowl or on a plain plate, never
  as a tin, pack or branded wrapper. NEVER mention in "visual": brands, text, labels (except
  "unlabelled" / "without a label"), packaging or packets, hands, people, cutlery (fork, knife,
  spoon), garnish, other foods (never write "with" followed by another ingredient's name), scenes,
  tables or cutting boards. A cut item lies directly on the background.
- "presentation": exactly one of whole, cut, heap, bunch, bowl, jar, bottle, glass, plate, portion
  (how it is normally seen). Oils, fats, condiments, sauces, stocks, ferments, drinks and alcohol
  must be bowl, jar, bottle or glass unless the picture is a whole natural form (a whole vanilla pod,
  a honeycomb piece) and the presentation is whole or cut.
- "facts": 2-3 distinct strings of 25-150 characters. ONLY facts a food encyclopedia would state
  plainly: origin, history, how it grows or is made, how it is used around the world, the meaning of
  its name. NO health or nutrition claims or medical words (cure, prevent, boost, immune, detox,
  cancer, heal, superfood, antioxidant, calorie, vitamin, protein-rich). No precise numbers unless
  famous (at most one number in a fact; a year is fine). No "the world's most/only/first/oldest"
  claims unless iconic. No invented anecdotes, no "legend says" presented as fact, nothing about
  living people. If you are not sure a fact is true, leave it out.
- "concern": null, or a note of at most 160 characters if this does not look like a real or sensible
  ingredient.
"""

AUTHOR_SCHEMA = """\
Your FINAL message must be exactly one JSON object and nothing else (no commentary), in this shape,
with one item per ingredient, using each ingredient's "id" unchanged and covering every id given:

{"items": [{"id": "andouille-sausage",
  "what": "A smoky, coarse pork sausage from Cajun cooking in Louisiana.",
  "visual": "one whole raw andouille sausage link, dark reddish-brown smoked casing, coarse texture visible, lying in a gentle curve",
  "presentation": "whole",
  "facts": ["Andouille came to Louisiana with French settlers and became a staple of Cajun cooking.",
            "It is a key ingredient in gumbo and jambalaya."],
  "concern": null}]}
"""

CHECK_PROMPT = """\
You are a careful food fact-checker for a cooking game. Below are short "fun facts" about
ingredients. For EACH fact decide: "true" (accurate and widely documented), "doubtful" (you cannot
confirm it, it is vague, or it is probably exaggerated), or "false" (wrong). Search the web for any
fact you are not certain of; judge only the fact as written. Also mark "doubtful" any fact that is a
health or nutrition claim, an invented-sounding anecdote, or an unqualified "most/only/first/oldest"
superlative that is not iconic. Give a one-line reason (at most 200 characters) for every verdict.

Your FINAL message must be exactly one JSON object and nothing else, covering every id and every
fact index given, in this shape:

{"items": [{"id": "andouille-sausage", "facts": [
  {"index": 0, "verdict": "true", "reason": "Documented French origin and Cajun use."}]}]}
"""


def author_prompt(entries: Sequence[tuple[vc.BankItem, Item]], note: str = "") -> str:
    lines = []
    for bank_item, state in entries:
        record: dict[str, object] = {
            "id": bank_item.id,
            "name": bank_item.name,
            "aliases": list(bank_item.aliases),
            "category": bank_item.category_name,
            "role": bank_item.role,
            "blurb": bank_item.blurb,
        }
        if state.rejected or state.kept:
            record["do_not_repeat"] = state.rejected + state.kept
        if state.error:
            record["previous_attempt_problem"] = state.error
        lines.append(json.dumps(record, ensure_ascii=False))
    ingredients = "\n".join(lines)
    return (
        f'{AUTHOR_RULES}\nIf an ingredient has a "do_not_repeat" list, write facts that are NOT '
        'those, and fix any "previous_attempt_problem".\n\n'
        f"{AUTHOR_SCHEMA}\nIngredients (one JSON object per line):\n{ingredients}\n{note}"
    )


def check_prompt(
    entries: Sequence[tuple[vc.BankItem, Mapping[str, object]]], examples: Sequence[str] = ()
) -> str:
    lines = []
    for bank_item, draft in entries:
        facts = draft.get("facts")
        lines.append(
            json.dumps(
                {
                    "id": bank_item.id,
                    "ingredient": bank_item.name,
                    "facts": [
                        {"index": i, "text": t}
                        for i, t in enumerate(facts if isinstance(facts, list) else [])
                    ],
                },
                ensure_ascii=False,
            )
        )
    extra = ""
    if examples:
        shown = "\n".join(f"- {e}" for e in examples[:12])
        extra = (
            "\nA stricter reviewer recently rejected facts like these, so be tougher on the same "
            f"kind of claim:\n{shown}\n"
        )
    return (
        f"{CHECK_PROMPT}{extra}\nIngredients (one JSON object per line):\n"
        + "\n".join(lines)
        + "\n"
    )


def parse_author(
    data: Mapping[str, object],
    batch: Sequence[vc.BankItem],
    names: Mapping[str, str],
    now: int,
) -> tuple[dict[str, dict[str, object]], dict[str, str]]:
    """Per-item results: ``(accepted drafts, id -> problem)``. An id the reply omitted is a problem."""
    accepted: dict[str, dict[str, object]] = {}
    problems: dict[str, str] = {}
    by_id = {b.id: b for b in batch}
    raw_items = data.get("items")
    if not isinstance(raw_items, list):
        return {}, {b.id: "the reply has no 'items' list" for b in batch}
    seen: set[str] = set()
    for raw in raw_items:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            continue
        item_id = raw["id"]
        if item_id not in by_id:
            continue  # an id we did not ask about is ignored (and the real ids still must appear)
        if item_id in seen:
            problems[item_id] = "the id appears more than once"
            continue
        seen.add(item_id)
        problem = _author_item_problem(raw, by_id[item_id], names, now)
        if problem is None:
            accepted[item_id] = {
                k: raw[k] for k in ("what", "visual", "presentation", "facts", "concern")
            }
        else:
            problems[item_id] = problem
    for item_id in by_id:
        if item_id not in seen:
            problems.setdefault(item_id, "the reply has no item for this id")
    return accepted, problems


def _author_item_problem(
    raw: Mapping[str, object], bank_item: vc.BankItem, names: Mapping[str, str], now: int
) -> str | None:
    allowed = {"id", "what", "visual", "presentation", "facts", "concern"}
    if set(raw) - allowed or not (allowed - {"concern"}) <= set(raw):
        return f"keys must be {sorted(allowed)}"
    facts = raw["facts"]
    if not isinstance(facts, list) or not 2 <= len(facts) <= 3:
        return "facts must be a list of 2 or 3 strings"
    concern = raw.get("concern")
    if concern is not None and not (isinstance(concern, str) and len(concern) <= 160):
        return "concern must be null or a string of at most 160 characters"
    candidate = {
        "what": raw["what"],
        "visual": raw["visual"],
        "presentation": raw["presentation"],
        "facts": facts,
        "nameKey": bank_item.key,
        "source": {"author": HAIKU.model, "factCheck": HAIKU.model, "at": now},
    }
    problems = vc.item_problems(bank_item.id, candidate, bank_item, names)
    if problems:
        # keep the text after "id: " so the model is told what to fix, not our bookkeeping
        return "; ".join(p.split(": ", 1)[-1] for p in problems)[:600]
    return None


def parse_check(
    data: Mapping[str, object], batch: Mapping[str, Sequence[str]]
) -> tuple[dict[str, list[tuple[str, str]]], dict[str, str]]:
    """Per-item verdict lists ``[(verdict, reason)]`` indexed by fact, and id -> problem."""
    accepted: dict[str, list[tuple[str, str]]] = {}
    problems: dict[str, str] = {}
    raw_items = data.get("items")
    if not isinstance(raw_items, list):
        return {}, {i: "the reply has no 'items' list" for i in batch}
    by_reply: dict[str, object] = {}
    for raw in raw_items:
        if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw["id"] in batch:
            by_reply.setdefault(raw["id"], raw)
    for item_id, facts in batch.items():
        raw = by_reply.get(item_id)
        if not isinstance(raw, dict) or not isinstance(raw.get("facts"), list):
            problems[item_id] = "no verdicts returned for this id"
            continue
        verdicts: dict[int, tuple[str, str]] = {}
        bad = False
        for entry in raw["facts"]:
            if not isinstance(entry, dict):
                bad = True
                continue
            index, verdict, reason = entry.get("index"), entry.get("verdict"), entry.get("reason")
            if (
                not isinstance(index, int)
                or isinstance(index, bool)
                or verdict not in ("true", "doubtful", "false")
                or not isinstance(reason, str)
                or len(reason) > 200
                or index in verdicts
            ):
                bad = True
                continue
            verdicts[index] = (verdict, reason)
        if bad or set(verdicts) != set(range(len(facts))):
            problems[item_id] = "verdicts must cover every fact index exactly once"
            continue
        accepted[item_id] = [verdicts[i] for i in range(len(facts))]
    return accepted, problems


# ---------------------------------------------------------------- the builder


class Builder:
    def __init__(
        self,
        *,
        pool: RunPool,
        bank: Mapping[str, vc.BankItem],
        committed_path: Path,
        work_dir: Path,
        waivers_path: Path = vc.WAIVERS_PATH,
        now: Callable[[], float] = time.time,
        log: Callable[[str], None] = lambda message: print(message, flush=True),
        bank_version: int = 1,
    ) -> None:
        self.pool = pool
        self.bank = dict(bank)
        self.names = vc.ingredient_names(self.bank)
        self.committed_path = committed_path
        self.dir = work_dir / "catalogue"
        self.waivers_path = waivers_path
        self.now = now
        self.log = log
        self.bank_version = bank_version
        self.cwd = self.dir / "cwd"
        self.cwd.mkdir(parents=True, exist_ok=True)
        self.items: dict[str, Item] = {}
        self.committed: dict[str, dict[str, object]] = {}
        self.generated = 0
        self.load()

    # -- persistence

    @property
    def state_path(self) -> Path:
        return self.dir / "state.json"

    def load(self) -> None:
        if self.committed_path.exists():
            raw = json.loads(self.committed_path.read_text(encoding="utf-8"))
            items = raw.get("items", {})
            self.committed = {k: v for k, v in items.items() if isinstance(v, dict)}
            gen = raw.get("generated")
            self.generated = gen if isinstance(gen, int) else 0
        stored: dict[str, Item] = {}
        if self.state_path.exists():
            raw_state = json.loads(self.state_path.read_text(encoding="utf-8"))
            stored = {
                k: Item.from_json(v)
                for k, v in raw_state.get("items", {}).items()
                if isinstance(v, dict)
            }
        for item_id, bank_item in self.bank.items():
            entry = self.committed.get(item_id)
            state = stored.get(item_id)
            if entry is not None and entry.get("nameKey") == bank_item.key:
                if state is not None and state.stage == STAGE_CHECK:
                    self.items[item_id] = state  # a re-check queued by a failed audit
                else:
                    self.items[item_id] = Item(stage=STAGE_DONE, round=MAX_AUTHOR_ROUNDS)
            elif state is not None and not (state.stage == STAGE_DONE and entry is None):
                self.items[item_id] = state
            else:
                # new, or the bank entry changed since it was written: author it from scratch
                self.items[item_id] = Item()
        self.save_state()

    def save_state(self) -> None:
        payload = {"items": {k: v.to_json() for k, v in sorted(self.items.items())}}
        atomic_write(self.state_path, dump_json(payload, indent=None))

    def save_committed(self) -> None:
        self.generated = int(self.now())
        payload = {
            "version": 1,
            "bankVersion": self.bank_version,
            "generated": self.generated,
            "items": self.committed,
        }
        atomic_write(self.committed_path, dump_json(payload))

    # -- ordering and batching

    def ids_at(self, stage: str) -> list[str]:
        by_category: dict[str, list[str]] = defaultdict(list)
        for item_id, state in self.items.items():
            if state.stage == stage:
                by_category[self.bank[item_id].category].append(item_id)
        return interleave(by_category)

    def _resumable_batches(self, pass_name: str, stage: str) -> list[list[str]]:
        """Batches whose run the journal shows started but whose result was never used."""
        out: list[list[str]] = []
        latest: dict[str, dict[str, object]] = {}
        for record in self.pool.journal.records():
            if record.get("pass") == pass_name and isinstance(record.get("batch"), str):
                latest[str(record["batch"])] = record
        for record in latest.values():
            if record.get("status") not in cmdruns.RESUMABLE:
                continue
            ids = record.get("ids")
            if isinstance(ids, list):
                live = [
                    i
                    for i in ids
                    if isinstance(i, str) and self.items.get(i) and self.items[i].stage == stage
                ]
                if live and len(live) == len(ids):
                    out.append(live)
        return out

    def plan(
        self, pass_name: str, stage: str, limit: int | None, only: set[str] | None
    ) -> list[list[str]]:
        batches = self._resumable_batches(pass_name, stage)
        taken = {i for b in batches for i in b}
        fresh = [i for i in self.ids_at(stage) if i not in taken and (only is None or i in only)]
        if limit is not None:
            budget = max(limit - len(taken), 0)
            fresh = fresh[:budget]
        batches += [fresh[i : i + BATCH_SIZE] for i in range(0, len(fresh), BATCH_SIZE)]
        return batches

    # -- one model call returning JSON (a retry once, quoting the parse error)

    async def _ask(
        self, key: str, pass_name: str, ids: Sequence[str], spec: RunSpec
    ) -> tuple[dict[str, object] | None, str | None]:
        outcome = await self.pool.run(key, pass_name, ids, spec)
        if not outcome.ok:
            return None, f"run {outcome.status}: {outcome.error or ''}".strip()
        data, error = parse_json_object(outcome.text)
        if data is not None:
            return data, None
        retry_prompt = (
            f"{spec.prompt}\n\nYour previous reply could not be used: {error}. "
            "Reply again with exactly one JSON object and nothing else."
        )
        retry = replace(spec, prompt=retry_prompt)
        outcome = await self.pool.run(f"{key}-retry", pass_name, ids, retry)
        if not outcome.ok:
            return None, f"retry run {outcome.status}: {outcome.error or ''}".strip()
        return parse_json_object(outcome.text)

    # -- author pass

    async def author(self, *, limit: int | None = None, only: set[str] | None = None) -> int:
        batches = self.plan("author", STAGE_AUTHOR, limit, only)
        self.log(f"author: {len(batches)} batch(es)")
        await self._gather(self._author_batch(b) for b in batches)
        return len(batches)

    async def _author_batch(self, ids: list[str]) -> None:
        pairs = [(self.bank[i], self.items[i]) for i in ids]
        key = batch_key("author", ids, self.items)
        spec = RunSpec(
            caller=CALLER,
            prompt=author_prompt(pairs),
            model=HAIKU,
            effort="medium",
            cwd=self.cwd.as_posix(),
            timeout_secs=AUTHOR_TIMEOUT_S,
            tool_profile="judge",
        )
        data, error = await self._ask(key, "author", ids, spec)
        if data is None:
            problems = {i: error or "no usable reply" for i in ids}
            accepted: dict[str, dict[str, object]] = {}
        else:
            accepted, problems = parse_author(
                data, [self.bank[i] for i in ids], self.names, int(self.now())
            )
        for item_id, draft in accepted.items():
            state = self.items[item_id]
            state.draft = draft
            state.round += 1
            concern = draft.get("concern")
            state.concern = concern if isinstance(concern, str) else None
            state.stage = STAGE_CHECK
            state.error = None
        for item_id, problem in problems.items():
            state = self.items[item_id]
            state.failures += 1
            state.error = problem
            if state.failures >= MAX_FAILURES:
                state.stage = STAGE_FAILED
                self.log(f"author: {item_id} FAILED after {state.failures} attempts: {problem}")
        self.save_state()
        self.log(f"author: batch of {len(ids)}: {len(accepted)} accepted, {len(problems)} to retry")

    # -- fact-check pass

    async def factcheck(
        self,
        *,
        limit: int | None = None,
        only: set[str] | None = None,
        examples: Sequence[str] = (),
    ) -> int:
        if not examples:
            examples = self._load_examples()
        batches = self.plan("factcheck", STAGE_CHECK, limit, only)
        self.log(f"factcheck: {len(batches)} batch(es)")
        await self._gather(self._check_batch(b, examples) for b in batches)
        return len(batches)

    async def _gather(self, coroutines: Iterable[Awaitable[None]]) -> None:
        results = await asyncio.gather(*coroutines, return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                self.log(f"batch crashed (its ids stay queued): {result!r}")

    def _facts_of(self, item_id: str) -> list[str]:
        """The facts to check: the fresh draft's, or (re-check) the committed entry's."""
        state = self.items[item_id]
        if state.draft is not None and "facts" in state.draft:
            return facts_of(state.draft)
        return facts_of(self.committed.get(item_id, {}))

    async def _check_batch(self, ids: list[str], examples: Sequence[str]) -> None:
        drafts: dict[str, Mapping[str, object]] = {}
        for i in ids:
            drafts[i] = {"facts": self._facts_of(i)}
        audits = len(list(self.dir.glob("audit-*.json")))
        key = batch_key("factcheck", ids, self.items, tag=f"x{len(examples)}a{audits}")
        spec = RunSpec(
            caller=CALLER,
            prompt=check_prompt([(self.bank[i], drafts[i]) for i in ids], examples),
            model=HAIKU,
            effort="high",
            cwd=self.cwd.as_posix(),
            timeout_secs=CHECK_TIMEOUT_S,
            disallowed_tools=READ_ONLY_DISALLOWED,
        )
        data, error = await self._ask(key, "factcheck", ids, spec)
        batch_facts = {i: self._facts_of(i) for i in ids}
        if data is None:
            accepted: dict[str, list[tuple[str, str]]] = {}
            problems = {i: error or "no usable reply" for i in ids}
        else:
            accepted, problems = parse_check(data, batch_facts)
        for item_id, verdicts in accepted.items():
            self._apply_verdicts(item_id, batch_facts[item_id], verdicts)
        for item_id, problem in problems.items():
            state = self.items[item_id]
            state.failures += 1
            state.error = problem
            if state.failures >= MAX_FAILURES:
                self._finish(item_id)  # keep whatever facts are unverified out: nothing survives
                self.log(f"factcheck: {item_id} gave no usable verdicts {state.failures}x")
        self.save_state()
        self.save_committed()
        self.log(
            f"factcheck: batch of {len(ids)}: {len(accepted)} checked, {len(problems)} to retry"
        )

    def _load_examples(self) -> list[str]:
        path = self.dir / "examples.json"
        if not path.exists():
            return []
        value = json.loads(path.read_text(encoding="utf-8"))
        return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []

    def _all_committed_facts(self, except_id: str) -> set[str]:
        return {f for i, e in self.committed.items() if i != except_id for f in facts_of(e)}

    def _apply_verdicts(
        self, item_id: str, facts: Sequence[str], verdicts: Sequence[tuple[str, str]]
    ) -> None:
        state = self.items[item_id]
        taken = self._all_committed_facts(item_id)
        survivors: list[str] = []
        for fact, (verdict, reason) in zip(facts, verdicts, strict=True):
            if verdict == "true" and fact not in taken and fact not in survivors:
                survivors.append(fact)
            else:
                why = (
                    "duplicate of another entry's fact"
                    if verdict == "true"
                    else f"{verdict}: {reason}"
                )
                state.rejected.append(fact)
                self.log(f"factcheck: {item_id} dropped a fact ({why[:80]})")
        merged = (state.kept + [f for f in survivors if f not in state.kept])[:3]
        state.kept = merged
        state.error = None
        state.failures = 0
        if len(merged) >= MIN_FACTS or state.draft is None or state.round >= MAX_AUTHOR_ROUNDS:
            self._finish(item_id)
        else:
            state.stage = STAGE_AUTHOR  # back to the author with the rejected facts listed

    def _finish(self, item_id: str) -> None:
        """Write the entry as it stands: survivors only, possibly fewer than two (or none)."""
        state = self.items[item_id]
        bank_item = self.bank[item_id]
        base = state.draft or self.committed.get(item_id)
        if base is None:
            state.stage = STAGE_FAILED
            return
        entry: dict[str, object] = {
            "what": base["what"],
            "visual": base["visual"],
            "presentation": base["presentation"],
            "facts": list(state.kept),
            "nameKey": bank_item.key,
            "source": {
                "author": HAIKU.model,
                "factCheck": HAIKU.model,
                "at": int(self.now()),
            },
        }
        old = self.committed.get(item_id, {})
        old_source = old.get("source")
        if isinstance(old_source, dict):
            for extra in ("visualBy", "visualAt"):
                if extra in old_source and state.draft is None:
                    source = entry["source"]
                    assert isinstance(source, dict)
                    source[extra] = old_source[extra]
        self.committed[item_id] = entry
        state.stage = STAGE_DONE
        state.draft = None
        waivers = vc.load_waivers(self.waivers_path)
        if not state.kept:
            self._waive(item_id, "no fact survived the fact-check after the allowed author rounds")
        elif item_id in waivers:
            del waivers[item_id]
            atomic_write(self.waivers_path, dump_json(waivers))

    def _waive(self, item_id: str, reason: str) -> None:
        waivers = vc.load_waivers(self.waivers_path)
        waivers[item_id] = reason
        atomic_write(self.waivers_path, dump_json(waivers))

    # -- orchestration

    async def build(self, *, limit: int | None = None) -> None:
        only = set(self.ids_at(STAGE_AUTHOR)[:limit]) if limit is not None else None
        while True:
            authored = await self.author(only=only)
            checked = await self.factcheck(only=only)
            if not authored and not checked:
                return

    def counts(self) -> Counter[str]:
        return Counter(s.stage for s in self.items.values())

    def failed(self) -> list[str]:
        return sorted(i for i, s in self.items.items() if s.stage == STAGE_FAILED)

    # -- the Sol audit

    async def audit(self, *, seed: int | None = None) -> dict[str, object]:
        """Sol checks a seeded sample of facts across all categories (spec §A.2)."""
        used = secrets.randbits(32) if seed is None else seed
        rng = random.Random(used)
        pool_facts = [(i, f) for i, e in sorted(self.committed.items()) for f in facts_of(e)]
        sample = rng.sample(pool_facts, min(AUDIT_SAMPLE, len(pool_facts)))
        batches = [sample[i : i + AUDIT_BATCH] for i in range(0, len(sample), AUDIT_BATCH)]
        results = await asyncio.gather(
            *(self._audit_batch(n, used, b) for n, b in enumerate(batches))
        )
        verdicts = [v for r in results for v in r]
        upheld = sum(1 for v in verdicts if v["upheld"])
        failures = [v for v in verdicts if not v["upheld"]]
        outcome: dict[str, object] = {
            "seed": used,
            "sampled": len(sample),
            "judged": len(verdicts),
            "upheld": upheld,
            "bar": AUDIT_BAR,
            "passed": len(verdicts) == len(sample) and upheld >= AUDIT_BAR,
            "failures": failures,
            "at": int(self.now()),
        }
        number = len(list(self.dir.glob("audit-*.json"))) + 1
        atomic_write(self.dir / f"audit-{number}.json", dump_json(outcome))
        if not outcome["passed"]:
            self._requeue_categories(failures)
        return outcome

    async def _audit_batch(
        self, n: int, seed: int, batch: Sequence[tuple[str, str]]
    ) -> list[dict[str, object]]:
        lines = [
            json.dumps(
                {"n": i, "ingredient": self.bank[item_id].name, "fact": fact}, ensure_ascii=False
            )
            for i, (item_id, fact) in enumerate(batch)
        ]
        prompt = (
            "You are auditing fun facts shown in a cooking game. For EACH fact below, search the web "
            'as needed and decide whether it is accurate and widely documented ("upheld") or not '
            '("not_upheld": wrong, unverifiable, exaggerated, or a health claim). Give a one-line '
            "reason (at most 200 characters).\n\nYour FINAL message must be exactly one JSON object and "
            'nothing else: {"items": [{"n": 0, "verdict": "upheld", "reason": "..."}]} covering every n.\n\n'
            "Facts (one JSON object per line):\n" + "\n".join(lines) + "\n"
        )
        spec = RunSpec(
            caller=CALLER,
            prompt=prompt,
            model=SOL,
            effort="high",
            cwd=self.cwd.as_posix(),
            timeout_secs=CHECK_TIMEOUT_S,
            tool_profile="researcher",
        )
        ids = [item_id for item_id, _ in batch]
        data, error = await self._ask(f"audit-{seed}-{n}", "audit", ids, spec)
        out: list[dict[str, object]] = []
        replies: dict[int, tuple[bool, str]] = {}
        raw_items = data.get("items") if data is not None else None
        if isinstance(raw_items, list):
            for raw in raw_items:
                if (
                    isinstance(raw, dict)
                    and isinstance(raw.get("n"), int)
                    and raw.get("verdict") in ("upheld", "not_upheld")
                ):
                    reason = raw.get("reason")
                    replies.setdefault(
                        raw["n"],
                        (raw["verdict"] == "upheld", reason if isinstance(reason, str) else ""),
                    )
        for i, (item_id, fact) in enumerate(batch):
            if i not in replies:
                self.log(f"audit: no verdict for {item_id} ({error})")
                continue
            upheld, reason = replies[i]
            out.append({"id": item_id, "fact": fact, "upheld": upheld, "reason": reason})
        return out

    def _requeue_categories(self, failures: Sequence[Mapping[str, object]]) -> None:
        """Categories with a failed fact go back through the fact-check pass, failures as examples."""
        bad_categories = {self.bank[str(f["id"])].category for f in failures}
        for item_id, state in self.items.items():
            if state.stage == STAGE_DONE and self.bank[item_id].category in bad_categories:
                has_facts = bool(facts_of(self.committed.get(item_id, {})))
                state.stage = STAGE_CHECK
                state.draft = None
                state.kept = []
                state.round = MAX_AUTHOR_ROUNDS
                state.failures = 0
                if not has_facts:
                    state.stage = STAGE_DONE
        self.save_state()
        quoted = [str(f["fact"]) for f in failures]
        atomic_write(self.dir / "examples.json", dump_json(quoted))
        self.log(f"audit: re-queued categories {sorted(bad_categories)} for the fact-check pass")


# ---------------------------------------------------------------- the public API for parcel 2


def set_visual(
    catalogue_path: Path, ingredient_id: str, visual: str, by: str, *, now: int | None = None
) -> None:
    """Replace one entry's `visual` (the attempt-3 rewrite, spec §B.5), recording who and when.
    Validated before it is written; the rest of the entry is untouched."""
    raw = json.loads(catalogue_path.read_text(encoding="utf-8"))
    entry = raw["items"][ingredient_id]
    bank = vc.load_bank_items()
    updated = {**entry, "visual": visual}
    problems = vc.item_problems(
        ingredient_id, updated, bank[ingredient_id], vc.ingredient_names(bank)
    )
    if problems:
        raise ValueError("; ".join(problems))
    stamp = int(time.time()) if now is None else now
    source = dict(entry["source"])
    source["visualBy"], source["visualAt"] = by, stamp
    updated["source"] = source
    raw["items"][ingredient_id] = updated
    atomic_write(catalogue_path, dump_json(raw))


# ---------------------------------------------------------------- the report


def report_markdown(
    builder: Builder, audits: Sequence[Mapping[str, object]], journal: Journal
) -> str:
    total = len(builder.bank)
    done = sum(1 for s in builder.items.values() if s.stage == STAGE_DONE)
    failed = builder.failed()
    fact_hist = Counter(len(facts_of(e)) for e in builder.committed.values())
    one_fact = sorted(i for i, e in builder.committed.items() if len(facts_of(e)) == 1)
    waivers = vc.load_waivers(builder.waivers_path)
    concerns = {i: s.concern for i, s in sorted(builder.items.items()) if s.concern}
    runs = [r for r in journal.records() if r.get("status") == "spawned"]
    by_pass = Counter(str(r.get("pass")) for r in runs)
    last_audit = audits[-1] if audits else None
    lines = ["# Cookout ingredient catalogue: build report", ""]
    answer = f"{done} of {total} ingredients have a finished catalogue entry" + (
        f"; {len(failed)} could not be written and are listed below." if failed else "."
    )
    if last_audit:
        answer += (
            f" Sol checked {last_audit['judged']} sampled fun facts and "
            f"{last_audit['upheld']} held up (the bar is {AUDIT_BAR} of {AUDIT_SAMPLE}): "
            + (
                "passed."
                if last_audit["passed"]
                else "NOT passed; the affected categories were re-checked."
            )
        )
    else:
        answer += " The Sol fact audit has not been run yet."
    lines += [answer, "", "## What was measured", ""]
    lines += [
        f"- Entries written: {done} of {total} (the {total - 3} pickable ingredients plus the three free seasonings).",
        "- Fun facts per entry: "
        + ", ".join(f"{n} fact(s): {c}" for n, c in sorted(fact_hist.items()))
        + ".",
        "- Model runs started (by pass): "
        + ", ".join(f"{p} {n}" for p, n in sorted(by_pass.items()))
        + ".",
        f"- Entries with only one surviving fact: {len(one_fact)}.",
        f"- Entries with no fact at all (waived in `facts_waivers.json`): {len(waivers)}.",
        "",
    ]
    if audits:
        lines += ["## Sol fact audit", ""]
        for number, audit in enumerate(audits, 1):
            lines.append(
                f"- Audit {number}: {audit['upheld']} of {audit['judged']} upheld (seed {audit['seed']}); "
                + ("passed" if audit["passed"] else "failed")
            )
            failures = audit.get("failures")
            for fail in failures if isinstance(failures, list) else []:
                lines.append(f"  - not upheld, {fail['id']}: {fail['fact']!r} ({fail['reason']})")
        lines.append("")
    if failed:
        lines += (
            ["## Could not be written", ""]
            + [f"- `{i}`: {builder.items[i].error}" for i in failed]
            + [""]
        )
    if one_fact:
        lines += ["## Only one surviving fact", "", ", ".join(f"`{i}`" for i in one_fact), ""]
    if waivers:
        lines += (
            ["## Without facts (waived)", ""]
            + [f"- `{i}`: {r}" for i, r in sorted(waivers.items())]
            + [""]
        )
    if concerns:
        lines += ["## Haiku's concerns about bank entries (not acted on here)", ""]
        lines += [f"- `{i}`: {c}" for i, c in concerns.items()] + [""]
    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------- CLI


def _bank_version(path: Path) -> int:
    raw = json.loads(path.read_text(encoding="utf-8"))
    version = raw.get("version")
    return version if isinstance(version, int) else 1


def make_builder(args: argparse.Namespace) -> Builder:
    work = Path(args.work_dir) if args.work_dir else default_work_dir()
    journal = Journal(work / "catalogue" / "journal.jsonl")
    pool = RunPool(client=cmdruns.real_client(), journal=journal)
    return Builder(
        pool=pool,
        bank=vc.load_bank_items(),
        committed_path=Path(args.catalogue),
        work_dir=work,
        bank_version=_bank_version(vc.BANK_PATH),
    )


def only_ids(args: argparse.Namespace) -> set[str] | None:
    return set(args.ids.split(",")) if args.ids else None


async def run_command(args: argparse.Namespace) -> int:
    builder = make_builder(args)
    command = args.command
    if command == "status":
        for stage, count in sorted(builder.counts().items()):
            print(f"{stage}: {count}")
        return 0
    if command == "validate":
        problems = vc.validate(Path(args.catalogue), allow_partial=args.allow_partial)
        for problem in problems:
            print(problem)
        print("OK" if not problems else f"{len(problems)} problem(s)")
        return 1 if problems else 0
    try:
        if command == "author":
            await builder.author(limit=args.limit, only=only_ids(args))
        elif command == "factcheck":
            await builder.factcheck(limit=args.limit, only=only_ids(args))
        elif command == "build":
            await builder.build(limit=args.limit)
        elif command == "audit":
            outcome = await builder.audit(seed=args.seed)
            print(json.dumps({k: v for k, v in outcome.items() if k != "failures"}))
            return 0 if outcome["passed"] else 2
        elif command == "report":
            audits = [
                json.loads(p.read_text(encoding="utf-8"))
                for p in sorted(builder.dir.glob("audit-*.json"))
            ]
            atomic_write(Path(args.report), report_markdown(builder, audits, builder.pool.journal))
            print(f"wrote {args.report}")
    finally:
        client = builder.pool.client
        close = getattr(client, "aclose", None)
        if close is not None:
            await close()
    failed = builder.failed()
    if failed:
        print(f"{len(failed)} ingredient(s) failed: {', '.join(failed[:20])}")
        return 1
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--work-dir", help="work directory (default: hub's cookout-images/work)")
    parser.add_argument("--catalogue", default=str(CATALOGUE), help="the committed catalogue JSON")
    parser.add_argument("--report", default=str(REPORT))
    parser.add_argument("--limit", type=int, help="process at most this many ingredients")
    parser.add_argument("--ids", help="comma-separated ids to restrict author/factcheck to")
    parser.add_argument("--seed", type=int, help="audit sample seed (default: random, recorded)")
    parser.add_argument("--allow-partial", action="store_true")
    parser.add_argument(
        "command", choices=["author", "factcheck", "build", "audit", "validate", "report", "status"]
    )
    args = parser.parse_args(argv)
    return asyncio.run(run_command(args))


if __name__ == "__main__":
    sys.exit(main())
