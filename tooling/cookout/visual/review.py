"""Opus review queue for persistent image failures (spec/server-chat/09b §B.5).

After attempt 4 fails, Opus sees all four attempts with every checker verdict and either chooses
one the checker was too strict about, or supplies a new `visual` for two final attempts (5, 6).
Decisions are committed in `image_review.json`, so a re-run never re-litigates them.
"""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from check import VerdictError, strip_json

REVIEW_PATH = Path(__file__).with_name("image_review.json")
VISUAL_MIN, VISUAL_MAX = 30, 260


@dataclass(frozen=True, slots=True)
class ReviewDecision:
    choose: int | None  # accept this attempt (1..attempts)
    visual: str | None  # or retry with this description (attempts 5 and 6)
    reason: str


def parse_review(text: str, attempts: int) -> ReviewDecision:
    """Strict `{"choose": 1..N | null, "visual": "…" | null, "reason": "…"}`. Exactly one of
    `choose` / `visual` must be set: Opus either accepts an attempt or asks for a retry."""
    data = strip_json(text)
    if not isinstance(data, dict) or set(data) != {"choose", "visual", "reason"}:
        raise VerdictError('the object must be exactly {"choose", "visual", "reason"}')
    choose, visual, reason = data["choose"], data["visual"], data["reason"]
    if choose is not None and (
        isinstance(choose, bool) or not isinstance(choose, int) or not 1 <= choose <= attempts
    ):
        raise VerdictError(f"choose must be null or an attempt number 1..{attempts}")
    if visual is not None and not (
        isinstance(visual, str) and VISUAL_MIN <= len(visual) <= VISUAL_MAX
    ):
        raise VerdictError(f"visual must be null or {VISUAL_MIN}-{VISUAL_MAX} characters")
    if (choose is None) == (visual is None):
        raise VerdictError("set exactly one of choose and visual")
    if not isinstance(reason, str) or not reason.strip():
        raise VerdictError("reason is required")
    return ReviewDecision(choose, visual, reason.strip())


def load_decisions(path: Path = REVIEW_PATH) -> dict[str, dict[str, object]]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path} must be a JSON object")
    return raw


def already_decided(ident: str, decisions: Mapping[str, object]) -> bool:
    return ident in decisions


def record_decision(
    ident: str,
    decision: str,
    attempt: int | None,
    reason: str,
    path: Path = REVIEW_PATH,
) -> None:
    """decision: `accepted` | `retry` | `pictureless`. Written atomically, sorted, LF."""
    if decision not in ("accepted", "retry", "pictureless"):
        raise ValueError(f"unknown decision {decision!r}")
    decisions = load_decisions(path)
    decisions[ident] = {
        "decision": decision,
        "attempt": attempt,
        "reason": reason,
        "at": int(time.time()),
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(decisions, sort_keys=True, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    tmp.replace(path)
