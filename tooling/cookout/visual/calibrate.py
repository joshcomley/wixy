"""The calibration spot check (spec/server-chat/09b §C.3): sampling, judge stages, scoring.

Pure functions over plain data so the whole rule can be unit-tested with no model, network or
GPU. `run_calibration` (async) drives the stages through a `check.Runner`.
"""

from __future__ import annotations

import json
import random
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
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
    strip_json,
    vision_proof,
)
from prompts import (
    PROBLEMS,
    check_prompt,
    parse_error_retry_prompt,
    reconcile_prompt,
    review_stage_prompt,
)

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
    if verdict not in ("wrong", "unclear"):
        raise VerdictError(f"{where}: finalVerdict must be correct, wrong or unclear")
    if verdict == "wrong" and not problems:
        raise VerdictError(f"{where}: 'wrong' needs at least one finalProblems entry")
    # The judge's `reason` is free text (the 10-200 character rule is the checker's, §C.1).


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
    judge_right: Mapping[str, Mapping[str, int]] | None = None,
) -> str:
    """The plain-English Markdown report: the answer first, then a table, then the detail.
    `agreement` has `total`, `blind` (judges agreed before seeing the checker) and `final`
    (judges agreed at the end); `judge_right[checker][judge]` counts the checker's verdicts that
    match that judge's own final verdict."""
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
        "The bar a checker had to clear: at most 2 mistakes in its 50 pictures (a mistake is a "
        "wrong picture let through, a fine picture rejected, or one the two judges could not "
        "settle), no wrong food let through, and every planted wrong picture caught.",
        "",
        "| Checker | Right | Mistakes | Wrong food let through | Fine picture rejected | "
        "Judges could not agree | Planted wrong pictures caught | Met the bar |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for s in scores:
        lines.append(
            f"| {s.label.title()} | {s.right} of {s.total} | {s.errors} | "
            f"{s.wrong_food_false_accepts} | {s.false_rejects} | {s.unresolved} | "
            f"{s.decoys_caught} of {s.decoys_total} | {'yes' if s.qualifies else 'no'} |"
        )
    lines += ["", f"Random seed for the 100 pictures: {seed}.", ""]
    total = agreement.get("total", 0)
    lines.append(
        f"How firm the answer key is: the two judges (Sol and Opus) gave the same verdict on "
        f"{agreement.get('blind', 0)} of {total} pictures before seeing any checker, and on "
        f"{agreement.get('final', 0)} of {total} at the end."
    )
    if judge_right:
        lines += ["", "How often each checker matched each judge's own final verdict:", ""]
        lines += [
            f"- {label.title()}: {counts.get('sol', 0)} of {by[label].total} against Sol, "
            f"{counts.get('opus', 0)} of {by[label].total} against Opus."
            for label, counts in judge_right.items()
            if label in by
        ]
    lines += ["", "## Verdict tables (checker down, answer key across)", ""]
    columns = ("correct", "wrong", "unclear", "unresolved")
    for s in scores:
        lines += [
            f"**{s.label.title()}**",
            "",
            "| Checker said | " + " | ".join(columns) + " |",
            "|---|" + "---|" * len(columns),
        ]
        for said in ("correct", "wrong", "unclear"):
            row = s.table.get(said, {})
            lines.append(f"| {said} | " + " | ".join(str(row.get(c, 0)) for c in columns) + " |")
        lines.append("")
    if by and all(s.false_accepts == 0 and s.false_rejects == 0 for s in scores):
        lines.append(
            "The sample held few wrong pictures, so the planted wrong pictures are the better "
            "measure of whether a checker catches mistakes."
        )
    lines += ["", "## Where the checker and the judges differed", ""]
    lines += [f"- {d}" for d in disagreements] or ["- None."]
    return "\n".join(lines) + "\n"


@dataclass(slots=True)
class Calibration:
    seed: int
    scores: list[CheckerScore]
    choice: str | None
    report: str
    detail: list[dict[str, object]] = field(default_factory=list)


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
    try:
        return parse_judge_final(text, numbers, with_checker_right=with_checker_right)
    except VerdictError as first:  # one retry quoting the error, like the checker runs
        retry = await runner.run(
            prompt=parse_error_retry_prompt(prompt, str(first)),
            model=model.model,
            provider=model.provider,
            effort=model.effort,
            cwd=cwd,
            tool_profile="replay_probe",
            timeout_secs=1800,
        )
        return parse_judge_final(retry, numbers, with_checker_right=with_checker_right)


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
    agreement = {
        "total": len(names),
        "blind": sum(1 for i in names if blind["sol"][i].verdict == blind["opus"][i].verdict),
        "final": sum(1 for t in truths.values() if t.resolved),
    }
    judge_right = {
        label: {
            judge: sum(
                1
                for i, v in checks.items()
                if v.verdict == finals[judge][i].verdict
                or (v.verdict != "correct" and finals[judge][i].verdict != "correct")
            )
            for judge in ("sol", "opus")
        }
        for label, checks in verdicts.items()
    }
    report = render_report(
        seed,
        scores,
        choice,
        disagreement_lines(names, all_checks, truths, finals["sol"], finals["opus"]),
        agreement,
        judge_right,
    )
    cal_dir = work / "calibration"
    save_json(cal_dir / "scores.json", [asdict(s) | {"errors": s.errors} for s in scores])
    for label, check_rows in (("luna", verdicts["luna"]), ("haiku", verdicts["haiku"])):
        save_jsonl(cal_dir / f"checks-{label}.jsonl", check_rows)
    for label, blind_rows in blind.items():
        save_jsonl(cal_dir / f"judge-{label}-blind.jsonl", blind_rows)
    for label, final_rows in finals.items():
        save_jsonl(cal_dir / f"judge-{label}-final.jsonl", final_rows)
    detail: list[dict[str, object]] = []
    for ident in names:
        v, t = all_checks[ident], truths[ident]
        detail.append(
            {
                "name": names[ident],
                "checker": "luna" if ident in verdicts["luna"] else "haiku",
                "checker verdict": f"{v.verdict} {', '.join(v.problems)} {v.reason}".strip(),
                "Sol": f"{finals['sol'][ident].verdict} {finals['sol'][ident].reason}".strip(),
                "Opus": f"{finals['opus'][ident].verdict} {finals['opus'][ident].reason}".strip(),
                "ident": ident,
                "disagree": not (t.resolved and t.verdict == v.verdict),
            }
        )
    return Calibration(seed, scores, choice, report, detail)


# --- raw files, HTML report and the command line ---------------------------------------------


def save_jsonl(path: Path, rows: Mapping[str, object]) -> None:
    """One line per image id: the raw answers behind a score, for anyone who wants to audit it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        for ident in sorted(rows):
            row = rows[ident]
            data = row.__dict__ if hasattr(row, "__dict__") else _slots_dict(row)
            fh.write(json.dumps({"id": ident, **data}, sort_keys=True) + "\n")


def _slots_dict(obj: object) -> dict[str, object]:
    return {name: getattr(obj, name) for name in getattr(type(obj), "__slots__", ())}


def render_html(
    title: str,
    answer_line: str,
    rows: Sequence[Mapping[str, object]],
) -> str:
    """The report page: the answer first, then each of the 100 pictures as a 160 px thumbnail
    (inlined, so the file stands alone) with every verdict and reason; disagreements first."""
    import base64
    import html

    def cell(row: Mapping[str, object]) -> str:
        thumb = row.get("thumb")
        img = ""
        if isinstance(thumb, bytes):
            img = (
                '<img width="160" height="160" alt="" src="data:image/webp;base64,'
                + base64.b64encode(thumb).decode("ascii")
                + '">'
            )
        lines = "".join(
            f"<div><b>{html.escape(str(k))}</b>: {html.escape(str(v))}</div>"
            for k, v in row.items()
            if k not in ("thumb", "disagree")
        )
        cls = "dis" if row.get("disagree") else ""
        return f'<section class="{cls}">{img}<div>{lines}</div></section>'

    ordered = sorted(rows, key=lambda r: (not r.get("disagree"), str(r.get("name"))))
    body = "\n".join(cell(r) for r in ordered)
    return (
        "<!doctype html><html lang=en-GB><meta charset=utf-8>"
        '<meta name=viewport content="width=device-width,initial-scale=1">'
        f"<title>{html.escape(title)}</title>"
        "<style>body{font:16px system-ui;margin:16px;max-width:60rem}"
        "section{display:flex;gap:12px;flex-wrap:wrap;border-bottom:1px solid #8884;"
        "padding:8px 0}section.dis{background:#fd02}"
        "section>div{flex:1 1 14rem;min-width:0;overflow-wrap:anywhere;font-size:14px}"
        "</style>"
        f"<h1>{html.escape(title)}</h1><p>{html.escape(answer_line)}</p>{body}"
    )


def pilot_first_attempts(
    journal_state_rows: Mapping[str, Mapping[str, object]],
    first_attempt_ids: Sequence[str],
) -> list[str]:
    """Ids that have a first-attempt picture (before any regeneration)."""
    return [i for i in first_attempt_ids if i in journal_state_rows]


def main(argv: Sequence[str] | None = None) -> int:
    """`calibrate.py run`: draw 100 first-attempt pilot pictures, prove the checkers can see,
    check, judge, score, write the report. Needs the live fleet and a finished pilot."""
    import argparse
    import asyncio
    import secrets
    import sys

    repo = Path(__file__).resolve().parents[3]
    for p in (str(repo), str(Path(__file__).resolve().parent)):
        if p not in sys.path:
            sys.path.insert(0, p)
    import images as im

    from tooling.cookout.visual import cmdruns

    parser = argparse.ArgumentParser(prog="calibrate.py")
    parser.add_argument("--work-dir", default=None)
    parser.add_argument(
        "--catalogue", default=str(repo / "wixy_server" / "livechat" / "cookout_catalogue.json")
    )
    parser.add_argument("--out-dir", default=str(repo / "triad" / "cookout" / "r2"))
    args = parser.parse_args(argv)
    work = im.WorkDir(Path(args.work_dir) if args.work_dir else im.default_work_dir())
    subjects = im.load_subjects(Path(args.catalogue))
    plan = json.loads(work.plan.read_text("utf-8"))

    first: list[str] = []
    for ident in plan["pilot"]:
        attempts = work.read_attempts(ident)
        if attempts and attempts[0]["attempt"] == 1 and work.card(ident, 1).exists():
            first.append(ident)
    cal_dir = work.root / "calibration"
    saved = cal_dir / "sample.json"
    if (
        saved.exists()
    ):  # a restarted run reuses its sample (never redrawn) so journalled runs resume
        record = json.loads(saved.read_text("utf-8"))
        seed, for_luna, for_haiku = int(record["seed"]), record["luna"], record["haiku"]
    else:
        seed = secrets.randbits(32)
        for_luna, for_haiku = draw_sample(first, seed)
        save_json(saved, {"seed": seed, "luna": for_luna, "haiku": for_haiku})

    def to_image(ident: str) -> CheckImage:
        s = subjects[ident]
        return CheckImage(ident, s.name, s.what, s.presentation, work.card(ident, 1))

    pool = cmdruns.RunPool(
        client=cmdruns.real_client(), journal=cmdruns.Journal(work.images / "runs.jsonl")
    )
    runner = im.PoolRunner(pool, cmdruns.RunSpec, cmdruns.Model)
    rng = random.Random(seed)
    cards = {i: work.card(i, 1) for i in first}
    pick = im.pick_decoy_factory(subjects, lambda: cards, rng)
    decoys = [pick() for _ in range(4)]
    right = [to_image(i) for i in for_luna[:2]]

    async def go() -> Calibration:
        await prove_checkers(runner, right, decoys, work.root, rng)
        return await run_calibration(
            runner,
            [to_image(i) for i in for_luna],
            [to_image(i) for i in for_haiku],
            pick,
            work.root,
            seed,
            rng,
        )

    result = asyncio.run(go())
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "image-calibration.md").write_text(result.report, encoding="utf-8", newline="\n")
    rows = [
        {
            **{k: v for k, v in d.items() if k != "ident"},
            "thumb": work.thumb(str(d["ident"]), 1).read_bytes()
            if work.thumb(str(d["ident"]), 1).exists()
            else None,
        }
        for d in result.detail
    ]
    first_line = result.report.split("\n\n")[1] if "\n\n" in result.report else ""
    (out / "image-calibration.html").write_text(
        render_html("Cookout picture checking: calibration", first_line, rows),
        encoding="utf-8",
        newline="\n",
    )
    print(result.choice or "no checker qualified: ask the operator")
    return 0 if result.choice else 3


if __name__ == "__main__":
    raise SystemExit(main())
