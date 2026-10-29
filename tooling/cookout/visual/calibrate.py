"""The calibration spot check (spec/server-chat/09b §C.3): sampling, judge stages, scoring.

Pure functions over plain data so the whole rule can be unit-tested with no model, network or
GPU. `run_calibration` (async) drives the stages through a `check.Runner`.
"""

from __future__ import annotations

import json
import random
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from check import (
    HAIKU,
    LUNA,
    OPUS,
    SOL,
    CheckerModel,
    CheckImage,
    Decoy,
    Runner,
    Verdict,
    VerdictError,
    check_images,
    check_verdict_rules,
    strip_json,
    vision_proof,
)
from prompts import PROBLEMS, check_prompt, reconcile_prompt, review_stage_prompt

SAMPLE_SIZE = 100
PER_CHECKER = 50
MAX_ERRORS = 2


def draw_sample(
    ids: Sequence[str], seed: int, size: int = SAMPLE_SIZE
) -> tuple[list[str], list[str]]:
    """100 random first-attempt images, then a random 50/50 split (checker A, checker B).
    Deterministic for a seed; purely random (no stratification)."""
    if len(ids) < size:
        raise ValueError(f"need at least {size} pilot images, have {len(ids)}")
    rng = random.Random(seed)
    sample = rng.sample(sorted(ids), size)
    half = size // 2
    return sample[:half], sample[half:]


@dataclass(frozen=True, slots=True)
class Final:
    """A judge's latest answer on one image (stage 2, replaced by stage 3 if it ran)."""

    verdict: str
    problems: tuple[str, ...]
    reason: str = ""


def parse_judge_final(
    text: str, numbers: Sequence[str], *, with_checker_right: bool
) -> dict[str, tuple[Final, bool | None]]:
    """Parse a stage 2 (`with_checker_right`) or stage 3 answer."""
    data = strip_json(text)
    if not isinstance(data, dict) or set(data) != {"items"} or not isinstance(data["items"], list):
        raise VerdictError('the object must be exactly {"items": [...]}')
    keys = {"image", "finalVerdict", "finalProblems", "reason"}
    if with_checker_right:
        keys.add("checkerRight")
    out: dict[str, tuple[Final, bool | None]] = {}
    for item in data["items"]:
        if not isinstance(item, dict) or set(item) != keys:
            raise VerdictError("item keys are wrong")
        number = item["image"]
        if not isinstance(number, str) or number not in numbers or number in out:
            raise VerdictError(f"bad or repeated image number {number!r}")
        problems = item["finalProblems"]
        if not isinstance(problems, list) or any(p not in PROBLEMS for p in problems):
            raise VerdictError(f"image {number}: finalProblems must use the known problem list")
        verdict, reason = item["finalVerdict"], item["reason"]
        if not isinstance(verdict, str) or not isinstance(reason, str):
            raise VerdictError(f"image {number}: verdict and reason must be strings")
        if verdict == "correct" and not reason:
            pass  # a judge may leave a reason on a correct final; only problems must be empty
        check_judge_final(f"image {number}", verdict, tuple(problems), reason)
        right = item.get("checkerRight")
        if with_checker_right and not isinstance(right, bool):
            raise VerdictError(f"image {number}: checkerRight must be true or false")
        out[number] = (
            Final(verdict, tuple(problems), reason),
            right if with_checker_right else None,
        )
    missing = [n for n in numbers if n not in out]
    if missing:
        raise VerdictError(f"missing images {missing}")
    return out


def check_judge_final(where: str, verdict: str, problems: tuple[str, ...], reason: str) -> None:
    """finalProblems: empty for `correct`, at least one for `wrong` (§C.3.4)."""
    if verdict == "correct":
        if problems:
            raise VerdictError(f"{where}: 'correct' needs empty finalProblems")
        return
    check_verdict_rules(where, verdict, problems, reason if reason else "x" * 10)


@dataclass(frozen=True, slots=True)
class Truth:
    resolved: bool
    verdict: str | None  # the agreed verdict if resolved
    problems: frozenset[str]  # union of both judges' latest finalProblems (always computed)


def truth_for(sol: Final, opus: Final) -> Truth:
    problems = frozenset(sol.problems) | frozenset(opus.problems)
    if sol.verdict == opus.verdict:
        return Truth(True, sol.verdict, problems)
    return Truth(False, None, problems)


def score_one(checker_verdict: str, truth: Truth) -> str:
    """`right` | `false_accept` | `false_reject` | `error_unresolved` per the §C.3.6 table."""
    if not truth.resolved:
        return "error_unresolved"
    t = truth.verdict
    if checker_verdict == "correct":
        return "right" if t == "correct" else "false_accept"
    if t == "correct":
        return "false_reject"  # wrong or unclear against a plainly fine picture
    return "right"  # wrong/unclear against wrong or unclear truth


@dataclass(slots=True)
class CheckerScore:
    label: str
    total: int = 0
    right: int = 0
    false_accepts: int = 0
    false_rejects: int = 0
    unresolved: int = 0
    wrong_food_false_accepts: int = 0
    decoys_caught: int = 0
    decoys_total: int = 0
    table: dict[str, dict[str, int]] = field(default_factory=dict)

    @property
    def errors(self) -> int:
        return self.false_accepts + self.false_rejects + self.unresolved

    @property
    def qualifies(self) -> bool:
        return (
            self.total > 0
            and self.errors <= MAX_ERRORS
            and self.wrong_food_false_accepts == 0
            and self.decoys_caught == self.decoys_total
        )


def score_checker(
    label: str,
    verdicts: Mapping[str, Verdict],
    truths: Mapping[str, Truth],
    *,
    decoys_caught: int,
    decoys_total: int,
) -> CheckerScore:
    """Score every one of the checker's images (total over all of them, no empty denominator)."""
    score = CheckerScore(label, decoys_caught=decoys_caught, decoys_total=decoys_total)
    for ident, verdict in verdicts.items():
        truth = truths[ident]
        outcome = score_one(verdict.verdict, truth)
        score.total += 1
        row = score.table.setdefault(verdict.verdict, {})
        column = truth.verdict if truth.resolved and truth.verdict else "unresolved"
        row[column] = row.get(column, 0) + 1
        if outcome == "right":
            score.right += 1
        elif outcome == "false_accept":
            score.false_accepts += 1
        elif outcome == "false_reject":
            score.false_rejects += 1
        else:
            score.unresolved += 1
        if verdict.verdict == "correct" and "wrong_food" in truth.problems:
            score.wrong_food_false_accepts += 1
    return score


def recommend(haiku: CheckerScore, luna: CheckerScore) -> str | None:
    """Haiku checks the full run if Haiku qualifies; otherwise Luna; otherwise None (ask)."""
    if haiku.qualifies:
        return "haiku"
    if luna.qualifies:
        return "luna"
    return None


def render_report(
    seed: int,
    scores: Sequence[CheckerScore],
    choice: str | None,
    disagreements: Sequence[str],
    agreement: Mapping[str, int],
) -> str:
    """The plain-English Markdown report: the answer first, then a table, then disagreements."""
    by = {s.label: s for s in scores}
    head = ", ".join(f"{s.label.title()} got {s.right} of {s.total} right" for s in scores)
    if choice is None:
        verdict_line = (
            "Neither checker met the bar, so checking of the full run is paused and the "
            "operator is being asked what to do."
        )
    else:
        why = "no wrong food was let through and every planted wrong picture was caught"
        verdict_line = f"We are using {choice.title()} for the rest ({why})."
    lines = [
        "# Cookout picture checking: calibration result",
        "",
        f"{head}. {verdict_line}",
        "",
        "| Checker | Right | Wrong food let through | Fine picture rejected | "
        "Judges could not agree | Planted wrong pictures caught |",
        "|---|---|---|---|---|---|",
    ]
    for s in scores:
        lines.append(
            f"| {s.label.title()} | {s.right} of {s.total} | {s.wrong_food_false_accepts} | "
            f"{s.false_rejects} | {s.unresolved} | {s.decoys_caught} of {s.decoys_total} |"
        )
    lines += ["", f"Random seed for the 100 pictures: {seed}.", ""]
    lines.append(
        "How firm the answer key is: the two judges (Sol and Opus) agreed on "
        + ", ".join(f"{v} pictures {k}" for k, v in agreement.items())
        + "."
    )
    if by and all(s.false_accepts == 0 and s.false_rejects == 0 for s in scores):
        lines.append(
            "The sample held few wrong pictures, so the planted wrong pictures are the better "
            "measure of whether a checker catches mistakes."
        )
    lines += ["", "## Disagreements", ""]
    lines += [f"- {d}" for d in disagreements] or ["- None."]
    return "\n".join(lines) + "\n"


@dataclass(slots=True)
class Calibration:
    seed: int
    scores: list[CheckerScore]
    choice: str | None
    report: str


async def run_stage(
    runner: Runner,
    model: CheckerModel,
    prompt: str,
    cwd: Path,
    numbers: Sequence[str],
    *,
    with_checker_right: bool,
) -> dict[str, tuple[Final, bool | None]]:
    text = await runner.run(
        prompt=prompt,
        model=model.model,
        provider=model.provider,
        effort=model.effort,
        cwd=cwd,
        tool_profile="replay_probe",
        timeout_secs=1800,
    )
    return parse_judge_final(text, numbers, with_checker_right=with_checker_right)


def stage2_rows(
    verdicts: Sequence[tuple[str, Verdict]], own: Mapping[str, Verdict]
) -> list[tuple[str, str, str, str, str]]:
    return [(n, v.verdict, ", ".join(v.problems), v.reason, own[n].verdict) for n, v in verdicts]


def latest_finals(
    stage2: Mapping[str, Final], stage3: Mapping[str, Final] | None
) -> dict[str, Final]:
    """A judge's latest answer per image: stage 3 replaces stage 2 (problems included)."""
    merged = dict(stage2)
    if stage3:
        merged.update(stage3)
    return merged


def reconcile_rows(
    own: Mapping[str, Final], other: Mapping[str, Final], numbers: Sequence[str]
) -> list[tuple[str, str, str, str, str, str]]:
    rows = []
    for n in numbers:
        o, t = own[n], other[n]
        rows.append(
            (
                n,
                o.verdict,
                ", ".join(o.problems),
                o.reason,
                t.verdict,
                f"{', '.join(t.problems) or 'no problems'}; {t.reason or 'no reason'}",
            )
        )
    return rows


def disagreement_lines(
    names: Mapping[str, str],
    verdicts: Mapping[str, Verdict],
    truths: Mapping[str, Truth],
    sol: Mapping[str, Final],
    opus: Mapping[str, Final],
) -> list[str]:
    lines: list[str] = []
    for ident, v in verdicts.items():
        t = truths[ident]
        if t.resolved and t.verdict == v.verdict:
            continue
        lines.append(
            f"{names.get(ident, ident)}: checker said {v.verdict}; Sol said "
            f"{sol[ident].verdict}; Opus said {opus[ident].verdict}."
        )
    return lines


def save_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", encoding="utf-8")


async def prove_checkers(
    runner: Runner,
    right: Sequence[CheckImage],
    decoys: Sequence[object],
    work: Path,
    rng: random.Random,
) -> None:
    """Both candidate checkers must pass the vision proof before checking anything."""
    from check import Decoy

    typed = [d for d in decoys if isinstance(d, Decoy)]
    for model in (HAIKU, LUNA):
        await vision_proof(runner, model, right, typed, work / "check", rng)


__all__ = [
    "HAIKU",
    "LUNA",
    "OPUS",
    "SOL",
    "Calibration",
    "CheckerScore",
    "Final",
    "Truth",
    "check_images",
    "draw_sample",
    "parse_judge_final",
    "recommend",
    "render_report",
    "reconcile_prompt",
    "review_stage_prompt",
    "score_checker",
    "score_one",
    "truth_for",
]


def _chunks[T](items: Sequence[T], size: int) -> list[list[T]]:
    return [list(items[i : i + size]) for i in range(0, len(items), size)]


async def run_calibration(
    runner: Runner,
    sample_luna: Sequence[CheckImage],
    sample_haiku: Sequence[CheckImage],
    pick_decoy: Callable[[], Decoy],
    work: Path,
    seed: int,
    rng: random.Random,
) -> Calibration:
    """Stages 0-3 and scoring. The caller has already passed the vision proofs."""
    from check import build_batch, parse_verdicts

    check_root = work / "check"
    verdicts: dict[str, dict[str, Verdict]] = {"luna": {}, "haiku": {}}
    decoy_stats: dict[str, list[int]] = {"luna": [0, 0], "haiku": [0, 0]}
    for model, sample in ((LUNA, sample_luna), (HAIKU, sample_haiku)):
        for index, chunk in enumerate(_chunks(sample, 10)):
            res = await check_images(
                runner, model, f"cal-{model.label}-{index}", chunk, pick_decoy, check_root, rng
            )
            decoy_stats[model.label][1] += 1
            if res.decoy_caught:
                decoy_stats[model.label][0] += 1
            if res.discarded:
                raise RuntimeError(
                    f"{model.label} marked a planted wrong picture correct twice in batch {index}"
                )
            verdicts[model.label].update(res.verdicts)

    everything = [*sample_luna, *sample_haiku]
    names = {img.ident: img.name for img in everything}
    blind: dict[str, dict[str, Verdict]] = {"sol": {}, "opus": {}}
    batches = []
    for index, chunk in enumerate(_chunks(everything, 10)):
        batches.append((chunk, build_batch(f"judge-{index}", chunk, None, check_root, rng)))
    for judge in (SOL, OPUS):
        for _chunk, batch in batches:
            numbers = [ln.number for ln in batch.lines]
            text = await runner.run(
                prompt=check_prompt(batch.lines),
                model=judge.model,
                provider=judge.provider,
                effort=judge.effort,
                cwd=batch.directory,
                tool_profile="replay_probe",
                timeout_secs=1800,
            )
            for v in parse_verdicts(text, numbers):
                blind[judge.label][batch.by_number[v.image].ident] = v

    all_checks = {**verdicts["luna"], **verdicts["haiku"]}
    finals: dict[str, dict[str, Final]] = {"sol": {}, "opus": {}}
    for judge in (SOL, OPUS):
        for _chunk, batch in batches:
            numbers = [ln.number for ln in batch.lines]
            ident_of = {n: img.ident for n, img in batch.by_number.items()}
            rows = stage2_rows(
                [(n, all_checks[ident_of[n]]) for n in numbers],
                {n: blind[judge.label][ident_of[n]] for n in numbers},
            )
            got = await run_stage(
                runner,
                judge,
                review_stage_prompt(rows),
                batch.directory,
                numbers,
                with_checker_right=True,
            )
            for n, (final, _right) in got.items():
                finals[judge.label][ident_of[n]] = final
    for _chunk, batch in batches:
        numbers = [ln.number for ln in batch.lines]
        ident_of = {n: img.ident for n, img in batch.by_number.items()}
        differ = [
            n
            for n in numbers
            if finals["sol"][ident_of[n]].verdict != finals["opus"][ident_of[n]].verdict
        ]
        if not differ:
            continue
        for judge, other in ((SOL, "opus"), (OPUS, "sol")):
            own = finals[judge.label]
            recon = reconcile_rows(
                {n: own[ident_of[n]] for n in differ},
                {n: finals[other][ident_of[n]] for n in differ},
                differ,
            )
            got = await run_stage(
                runner,
                judge,
                reconcile_prompt(recon),
                batch.directory,
                differ,
                with_checker_right=False,
            )
            for n, (final, _right) in got.items():
                finals[judge.label][ident_of[n]] = final

    truths = {i: truth_for(finals["sol"][i], finals["opus"][i]) for i in names}
    scores = [
        score_checker(
            m.label,
            verdicts[m.label],
            truths,
            decoys_caught=decoy_stats[m.label][0],
            decoys_total=decoy_stats[m.label][1],
        )
        for m in (HAIKU, LUNA)
    ]
    choice = recommend(scores[0], scores[1])
    agree = sum(1 for t in truths.values() if t.resolved)
    report = render_report(
        seed,
        scores,
        choice,
        disagreement_lines(names, all_checks, truths, finals["sol"], finals["opus"]),
        {"agreed on": agree, "still disagreed on": len(truths) - agree},
    )
    save_json(work / "calibration" / "scores.json", [s.__dict__ for s in scores])
    return Calibration(seed, scores, choice, report)
