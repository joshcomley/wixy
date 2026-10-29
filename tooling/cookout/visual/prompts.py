"""Fixed prompt texts for the Cookout picture tooling (spec/server-chat/09b §B.2, §B.5, §C).

Only `{visual}` (and the per-image labels) vary; everything else is server-owned text. Nothing
here ever contains chat content: the tooling is offline and reads only the bank and catalogue.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass

IMAGE_PROMPT_TEMPLATE = (
    "Studio food photograph of a single ingredient: {visual}. Centred and fully in frame with a "
    "little space around it, on a plain seamless warm off-white background, soft even daylight "
    "from the upper left, a faint natural shadow beneath, true-to-life colour and texture, sharp "
    "focus throughout. Nothing else in the picture: no other foods, no garnish, no props, no "
    "cutlery, no cutting board, no hands or people, no packaging, no labels, no text, no logos, "
    "no watermark."
)

PROBLEMS = (
    "wrong_food",
    "wrong_form",
    "other_foods",
    "text_or_logo",
    "packaging",
    "hands_or_people",
    "props_or_scene",
    "distorted",
    "other",
)
VERDICTS = ("correct", "wrong", "unclear")


def image_prompt(visual: str) -> str:
    return IMAGE_PROMPT_TEMPLATE.format(visual=visual.strip().rstrip("."))


def prompt_hash(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True, slots=True)
class CheckLine:
    """One image to judge: the neutral file number and what it should show."""

    number: str  # "01" … "11"
    name: str
    what: str
    presentation: str


_CHECK_RULES = (
    "You are checking AI-generated food pictures. Open each image with your file-viewing tool "
    "(the files are in the current folder, named 01.webp, 02.webp and so on). For each image, "
    "judge whether it is a faithful, recognisable picture of the ingredient described, and "
    "whether it follows the style rules: one ingredient only (several pieces of the same thing "
    "are fine), no other foods or garnish, no text, labels, logos or packaging, no hands or "
    "people, no props, and nothing distorted. For ingredients that look like others (white "
    "powders, oils, similar leaves), 'correct' means consistent with this ingredient, not "
    "uniquely identifiable from the picture. First describe what you see, then give the verdict."
)

_VERDICT_SCHEMA = (
    "Answer with exactly one JSON object and nothing else, in this shape:\n"
    '{"items": [{"image": "07", "seen": "<5-120 chars: what you see>", '
    '"verdict": "correct|wrong|unclear", "problems": [], "reason": ""}]}\n'
    f"problems may only contain: {', '.join(PROBLEMS)}. 'correct' needs problems [] and reason "
    "''. 'wrong' needs at least one problem and a reason of 10-200 characters. 'unclear' needs a "
    "reason of 10-200 characters. Include every image number exactly once."
)


def check_prompt(lines: Sequence[CheckLine]) -> str:
    body = "\n".join(
        f"Image {ln.number}: should show {ln.name} — {ln.what} (presentation: {ln.presentation})"
        for ln in lines
    )
    return f"{_CHECK_RULES}\n\n{body}\n\n{_VERDICT_SCHEMA}"


def parse_error_retry_prompt(original: str, error: str) -> str:
    return (
        f"{original}\n\nYour previous answer could not be accepted: {error}\n"
        "Answer again with the single JSON object only."
    )


def proof_prompt(lines: Sequence[CheckLine]) -> str:
    """The vision proof uses the identical prompt; only the images are chosen to be obvious."""
    return check_prompt(lines)


def review_stage_prompt(rows: Sequence[tuple[str, str, str, str, str]]) -> str:
    """Calibration judge stage 2. rows: (image, checker verdict, problems, reason, own verdict)."""
    body = "\n".join(
        f"Image {n}: checker said {verdict}; problems: {problems or 'none'}; reason: "
        f"{reason or 'none'}. You said earlier: {own}."
        for n, verdict, problems, reason, own in rows
    )
    return (
        "You judged these pictures earlier. A checker model has now given its own verdicts. Look "
        "at each image again and decide whether the checker was right.\n\n"
        f"{body}\n\n"
        'Answer with exactly one JSON object: {"items": [{"image": "07", "checkerRight": true, '
        '"finalVerdict": "correct|wrong|unclear", "finalProblems": [], "reason": ""}]}. '
        f"finalProblems may only contain: {', '.join(PROBLEMS)}; empty for 'correct', at least "
        "one for 'wrong'. Include every image exactly once."
    )


def reconcile_prompt(rows: Sequence[tuple[str, str, str, str, str, str]]) -> str:
    """Stage 3. rows: (image, own verdict, own problems, own reason, other verdict, other text)."""
    body = "\n".join(
        f"Image {n}: you said {own} ({own_p or 'none'}; {own_r or 'no reason'}); the other judge "
        f"said {other} ({other_text})"
        for n, own, own_p, own_r, other, other_text in rows
    )
    return (
        "You and another judge disagree on these pictures. Look at each image again, consider "
        "the other judge's answer and give your last verdict.\n\n"
        f"{body}\n\n"
        'Answer with exactly one JSON object: {"items": [{"image": "07", "finalVerdict": '
        '"correct|wrong|unclear", "finalProblems": [], "reason": ""}]}. Same rules for '
        "finalProblems as before. Include every image exactly once."
    )


def visual_rewrite_prompt(
    entries: Sequence[tuple[str, str, str, str, Sequence[str]]],
) -> str:
    """Attempt-3 rewrite. entries: (id, name, what, old visual, every checker reason so far)."""
    body = "\n\n".join(
        f"id: {i}\nname: {name}\nwhat: {what}\nold description: {old}\nchecker reasons: "
        + ("; ".join(reasons) or "none")
        for i, name, what, old, reasons in entries
    )
    return (
        "A text-to-image model keeps failing to draw these ingredients correctly. For each, write "
        "a clearer, more concrete picture description (30-260 characters): one ingredient, as a "
        "shopper would see it raw or as bought, lying directly on a plain background. Liquids, "
        "pastes and powders go in a plain unlabelled vessel. Never mention brands, text, labels, "
        "packaging, hands, people, cutlery, garnish, other foods or scenes.\n\n"
        f"{body}\n\n"
        'Answer with exactly one JSON object: {"items": [{"id": "...", "visual": "..."}]}.'
    )


def opus_review_prompt(
    ident: str, name: str, what: str, attempts: Sequence[tuple[int, str, str]]
) -> str:
    """Review queue. attempts: (attempt number, file name, checker verdict/reason text)."""
    body = "\n".join(f"Attempt {n}: file {fname} — {text}" for n, fname, text in attempts)
    return (
        f"Four (or more) AI-generated pictures of '{name}' ({what}) each failed an automatic "
        "check. Open each file with your file-viewing tool and look at it. If one of them is "
        "in fact a faithful, clean picture of the ingredient, choose it. Otherwise supply a new, "
        "clearer picture description for two final attempts.\n\n"
        f"{body}\n\n"
        'Answer with exactly one JSON object: {"choose": <attempt number or null>, "visual": '
        '"<new description of 30-260 characters or null>", "reason": "<why>"}.'
    )
