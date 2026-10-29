"""Image checking (spec/server-chat/09b §C.1-C.2): batches, neutral names, decoys, verdicts.

Pure logic plus one async orchestration function that talks to a `Runner` (the real one wraps
`cmdruns.py`; tests pass fakes). No file under a check directory is ever named after the
ingredient, so a checker cannot read the answer off a file name.
"""

from __future__ import annotations

import json
import random
import re
import shutil
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from prompts import (
    PROBLEMS,
    VERDICTS,
    CheckLine,
    check_prompt,
    parse_error_retry_prompt,
)

BATCH_REAL = 10
_FENCE = re.compile(r"\A```(?:json)?\s*\n(.*)\n```\s*\Z", re.DOTALL)


class VerdictError(ValueError):
    """A checker's answer broke the §C.1 schema."""


class VisionProofFailed(RuntimeError):
    """A model did not pass the vision proof; it must not check anything."""


class Runner(Protocol):
    async def run(
        self,
        *,
        prompt: str,
        model: str,
        provider: str,
        effort: str,
        cwd: Path,
        tool_profile: str,
        timeout_secs: int,
    ) -> str:
        """Run one chat-spawn run to completion and return its final assistant message."""
        ...


@dataclass(frozen=True, slots=True)
class CheckerModel:
    label: str  # "haiku" | "luna" | "sol" | "opus"
    provider: str
    model: str
    effort: str = "medium"


HAIKU = CheckerModel("haiku", "claude", "claude-haiku-5-5")
LUNA = CheckerModel("luna", "codex", "gpt-6-luna")
SOL = CheckerModel("sol", "codex", "gpt-6.1-sol", "high")
OPUS = CheckerModel("opus", "claude", "claude-opus-5-5", "high")


@dataclass(frozen=True, slots=True)
class Verdict:
    image: str
    seen: str
    verdict: str
    problems: tuple[str, ...]
    reason: str


@dataclass(frozen=True, slots=True)
class CheckImage:
    """A real picture awaiting a verdict (the 512 card rendition)."""

    ident: str
    name: str
    what: str
    presentation: str
    card_path: Path


@dataclass(frozen=True, slots=True)
class Decoy:
    """An already-rendered picture of one ingredient, labelled as a different one."""

    card_path: Path
    shown_name: str
    shown_what: str
    shown_presentation: str


@dataclass(slots=True)
class Batch:
    batch_id: str
    directory: Path
    lines: list[CheckLine]
    by_number: dict[str, CheckImage]
    decoy_number: str | None


def strip_json(text: str) -> object:
    """The final message must be exactly one JSON object (a ```json fence is tolerated)."""
    body = text.strip()
    fence = _FENCE.match(body)
    if fence:
        body = fence.group(1).strip()
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise VerdictError(f"the answer is not a single JSON object: {exc}") from exc


def _problems(raw: object, where: str) -> tuple[str, ...]:
    if not isinstance(raw, list) or not all(isinstance(p, str) for p in raw):
        raise VerdictError(f"{where}: problems must be a list of strings")
    bad = [p for p in raw if p not in PROBLEMS]
    if bad:
        raise VerdictError(f"{where}: unknown problems {bad}")
    return tuple(raw)


def check_verdict_rules(where: str, verdict: str, problems: tuple[str, ...], reason: str) -> None:
    """The shared §C.1 consistency rules (also used for judge stage answers)."""
    if verdict not in VERDICTS:
        raise VerdictError(f"{where}: verdict must be one of {VERDICTS}")
    if verdict == "correct":
        if problems or reason:
            raise VerdictError(f"{where}: 'correct' needs empty problems and reason")
        return
    if not 10 <= len(reason) <= 200:
        raise VerdictError(f"{where}: reason must be 10-200 characters")
    if verdict == "wrong" and not problems:
        raise VerdictError(f"{where}: 'wrong' needs at least one problem")


def parse_verdicts(text: str, numbers: Sequence[str]) -> list[Verdict]:
    """Strict §C.1 parse. Every image number present exactly once, nothing extra."""
    data = strip_json(text)
    if not isinstance(data, dict) or set(data) != {"items"} or not isinstance(data["items"], list):
        raise VerdictError('the object must be exactly {"items": [...]}')
    out: dict[str, Verdict] = {}
    for item in data["items"]:
        if not isinstance(item, dict):
            raise VerdictError("each item must be an object")
        if set(item) != {"image", "seen", "verdict", "problems", "reason"}:
            raise VerdictError(f"item keys are wrong: {sorted(item)}")
        number, seen, verdict, reason = (
            item["image"],
            item["seen"],
            item["verdict"],
            item["reason"],
        )
        if not isinstance(number, str) or number not in numbers:
            raise VerdictError(f"unknown image number {number!r}")
        if number in out:
            raise VerdictError(f"image {number} given twice")
        if not (isinstance(seen, str) and 5 <= len(seen) <= 120):
            raise VerdictError(f"image {number}: seen must be 5-120 characters")
        if not isinstance(reason, str) or not isinstance(verdict, str):
            raise VerdictError(f"image {number}: verdict and reason must be strings")
        problems = _problems(item["problems"], f"image {number}")
        check_verdict_rules(f"image {number}", verdict, problems, reason)
        out[number] = Verdict(number, seen, verdict, problems, reason)
    missing = [n for n in numbers if n not in out]
    if missing:
        raise VerdictError(f"missing images {missing}")
    return [out[n] for n in numbers]


def build_batch(
    batch_id: str,
    real: Sequence[CheckImage],
    decoy: Decoy | None,
    check_root: Path,
    rng: random.Random,
) -> Batch:
    """Copy the cards into `<check_root>/<batch_id>/` as 01.webp… with a decoy at a random spot."""
    directory = check_root / batch_id
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True)
    slots: list[CheckImage | Decoy] = list(real)
    if decoy is not None:
        slots.insert(rng.randrange(len(slots) + 1), decoy)
    lines: list[CheckLine] = []
    by_number: dict[str, CheckImage] = {}
    decoy_number: str | None = None
    for index, slot in enumerate(slots, start=1):
        number = f"{index:02d}"
        shutil.copyfile(slot.card_path, directory / f"{number}.webp")
        if isinstance(slot, Decoy):
            decoy_number = number
            lines.append(
                CheckLine(number, slot.shown_name, slot.shown_what, slot.shown_presentation)
            )
        else:
            by_number[number] = slot
            lines.append(CheckLine(number, slot.name, slot.what, slot.presentation))
    return Batch(batch_id, directory, lines, by_number, decoy_number)


def classify(verdict: str) -> str:
    """`accepted` | `regenerate` | `tiebreak` (§C.1 outcomes)."""
    return {"correct": "accepted", "wrong": "regenerate", "unclear": "tiebreak"}[verdict]


@dataclass(slots=True)
class BatchResult:
    verdicts: dict[str, Verdict] = field(default_factory=dict)  # real ident -> verdict
    decoy_caught: bool | None = None
    discarded: bool = False  # the decoy was marked correct twice: this checker is not trusted


async def run_batch(runner: Runner, model: CheckerModel, batch: Batch) -> list[Verdict]:
    """One checker run with a single parse-error retry. Raises VerdictError if both fail."""
    numbers = [ln.number for ln in batch.lines]
    prompt = check_prompt(batch.lines)
    text = await runner.run(
        prompt=prompt,
        model=model.model,
        provider=model.provider,
        effort=model.effort,
        cwd=batch.directory,
        tool_profile="replay_probe",
        timeout_secs=900,
    )
    try:
        return parse_verdicts(text, numbers)
    except VerdictError as first:
        retry = await runner.run(
            prompt=parse_error_retry_prompt(prompt, str(first)),
            model=model.model,
            provider=model.provider,
            effort=model.effort,
            cwd=batch.directory,
            tool_profile="replay_probe",
            timeout_secs=900,
        )
        return parse_verdicts(retry, numbers)


async def check_images(
    runner: Runner,
    model: CheckerModel,
    batch_id: str,
    real: Sequence[CheckImage],
    pick_decoy: Callable[[], Decoy],
    check_root: Path,
    rng: random.Random,
) -> BatchResult:
    """Check up to 10 real images with one decoy. A decoy marked `correct` discards the batch
    and re-runs it once with a fresh decoy; a second miss marks the result `discarded` (the
    caller sends the images to a different checker and logs it)."""
    result = BatchResult()
    for attempt in (1, 2):
        batch = build_batch(f"{batch_id}-{attempt}", real, pick_decoy(), check_root, rng)
        verdicts = await run_batch(runner, model, batch)
        decoy_verdict = next(v for v in verdicts if v.image == batch.decoy_number)
        result.decoy_caught = decoy_verdict.verdict != "correct"
        if result.decoy_caught:
            result.discarded = False
            result.verdicts = {
                batch.by_number[v.image].ident: v for v in verdicts if v.image in batch.by_number
            }
            return result
        result.discarded = True
    result.verdicts = {}
    return result


async def vision_proof(
    runner: Runner,
    model: CheckerModel,
    right: Sequence[CheckImage],
    decoys: Sequence[Decoy],
    check_root: Path,
    rng: random.Random,
) -> None:
    """Refuse-never-degrade: 2 obviously right + 2 obvious decoys, all four must be answered
    correctly (`correct` for the right ones, anything but `correct` for the decoys)."""
    directory = check_root / f"proof-{model.label}"
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True)
    slots: list[CheckImage | Decoy] = [*right[:2], *decoys[:2]]
    rng.shuffle(slots)
    lines: list[CheckLine] = []
    expect: dict[str, bool] = {}
    for index, slot in enumerate(slots, start=1):
        number = f"{index:02d}"
        shutil.copyfile(slot.card_path, directory / f"{number}.webp")
        if isinstance(slot, Decoy):
            lines.append(
                CheckLine(number, slot.shown_name, slot.shown_what, slot.shown_presentation)
            )
            expect[number] = False
        else:
            lines.append(CheckLine(number, slot.name, slot.what, slot.presentation))
            expect[number] = True
    try:
        text = await runner.run(
            prompt=check_prompt(lines),
            model=model.model,
            provider=model.provider,
            effort=model.effort,
            cwd=directory,
            tool_profile="replay_probe",
            timeout_secs=900,
        )
        verdicts = parse_verdicts(text, [ln.number for ln in lines])
    except VerdictError as exc:
        raise VisionProofFailed(
            f"{model.label} ({model.model}) failed the vision proof: {exc}"
        ) from exc
    wrong = [v.image for v in verdicts if (v.verdict == "correct") != expect[v.image]]
    if wrong:
        raise VisionProofFailed(
            f"{model.label} ({model.model}) failed the vision proof on images {wrong}; "
            "it will not be used and nothing falls back to an unproven model"
        )
