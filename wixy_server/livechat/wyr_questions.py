"""The would-you-rather question bank (workspace 00045).

The bank ships in the repo as `wyr_questions.json` beside this module — ~2,000
questions written by the writer fleet and deduplicated at build time. It is STATIC
content: it lives in the repo, not in `server.db`, so delete/wipe never touch it (and
never need to — a question reveals nothing about anyone). What a couple actually
answered lives in `wyr_rounds` and is erased with the chat (Inv 54).

Each question carries the two option labels plus a scene description per option
(`image_a`/`image_b`) — the image is painted on demand when a round is shown, never
ahead of time, by `wyr_images.py`. `style_suffix` appends a per-category photography
style so the whole bank has a consistent look without every writer repeating it.
"""

from __future__ import annotations

import json
import logging
import random
from dataclasses import dataclass
from pathlib import Path

_LOGGER = logging.getLogger(__name__)

BANK_PATH = Path(__file__).with_name("wyr_questions.json")

_MIN_OPTION_LEN = 3
_MAX_OPTION_LEN = 90
_MIN_IMAGE_LEN = 30


@dataclass(frozen=True, slots=True)
class WyrQuestion:
    id: str
    category: str
    a: str
    b: str
    image_a: str
    image_b: str


# Per-category photography style appended to a question's scene descriptions before
# they go to the image generator, so all two thousand pictures share one look.
_STYLE_SUFFIXES = {
    "food-meals": ", professional food photography, warm natural light, photorealistic, high detail",
    "food-sweet": ", professional food photography, soft warm light, photorealistic, high detail",
    "travel-destinations": ", scenic travel photograph, golden light, photorealistic, high detail",
    "travel-styles": ", scenic travel photograph, natural light, photorealistic, high detail",
    "date-nights": ", warm romantic atmosphere, soft evening light, photorealistic, high detail",
    "home-interior": ", interior design magazine photograph, soft natural light, photorealistic, high detail",
    "home-garden": ", interior design magazine photograph, natural light, photorealistic, high detail",
}
_DEFAULT_STYLE = ", warm natural light, photorealistic, high detail"


def style_suffix(category: str) -> str:
    return _STYLE_SUFFIXES.get(category, _DEFAULT_STYLE)


def load_questions(path: Path = BANK_PATH) -> tuple[WyrQuestion, ...]:
    """Load and validate the bank. A missing or malformed bank is a broken asset, not
    a reason to crash the app: log and return empty — `POST /wyr` answers 503
    `game_unavailable` when the bank is empty. CI's bank test keeps the shipped file
    honest, so an empty bank in production means the file never deployed."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        _LOGGER.error("would-you-rather bank missing: %s", path)
        return ()
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        _LOGGER.exception("would-you-rather bank unreadable: %s", path)
        return ()
    questions_raw = raw.get("questions") if isinstance(raw, dict) else None
    if not isinstance(questions_raw, list):
        _LOGGER.error("would-you-rather bank has no questions list: %s", path)
        return ()
    questions: list[WyrQuestion] = []
    seen_ids: set[str] = set()
    for i, entry in enumerate(questions_raw):
        if not isinstance(entry, dict):
            _LOGGER.error("bank entry %d is not an object — skipped", i)
            continue
        try:
            q = WyrQuestion(
                id=str(entry["id"]),
                category=str(entry["category"]),
                a=str(entry["a"]),
                b=str(entry["b"]),
                image_a=str(entry["image_a"]),
                image_b=str(entry["image_b"]),
            )
        except (KeyError, TypeError, ValueError):
            _LOGGER.error("bank entry %d missing fields — skipped", i)
            continue
        if (
            q.id in seen_ids
            or not (_MIN_OPTION_LEN <= len(q.a) <= _MAX_OPTION_LEN)
            or not (_MIN_OPTION_LEN <= len(q.b) <= _MAX_OPTION_LEN)
            or len(q.image_a) < _MIN_IMAGE_LEN
            or len(q.image_b) < _MIN_IMAGE_LEN
        ):
            _LOGGER.error("bank entry %d (%s) invalid or duplicate id — skipped", i, q.id)
            continue
        seen_ids.add(q.id)
        questions.append(q)
    return tuple(questions)


def pick_question(
    questions: tuple[WyrQuestion, ...], used_ids: set[str], rng: random.Random
) -> WyrQuestion | None:
    """Pick a random question the couple has not played yet. Once the whole bank has
    been played, start over with the full bank (the caller clears `wyr_used`)."""
    if not questions:
        return None
    fresh = [q for q in questions if q.id not in used_ids]
    pool = fresh if fresh else list(questions)
    return rng.choice(pool)
