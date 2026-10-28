"""Cookout twist catalogues (local stand-in for X1's module, spec 09a §3.3). NOT committed by X3."""

from __future__ import annotations

import random
import secrets
from dataclasses import dataclass
from typing import Literal

StyleId = Literal[
    "cosy-pub",
    "street-food",
    "posh-tasting",
    "breakfast-for-dinner",
    "date-night-bistro",
    "takeaway-at-home",
    "picnic",
    "campfire",
]
ChallengeId = Literal["one-pan", "no-oven", "thirty-minutes", "six-steps"]


@dataclass(frozen=True, slots=True)
class Style:
    id: StyleId
    label: str
    emoji: str
    blurb: str
    concept_directive: str
    picture_phrase: str


@dataclass(frozen=True, slots=True)
class Challenge:
    id: ChallengeId
    label: str
    emoji: str
    blurb: str
    concept_directive: str
    recipe_directive: str


STYLES: tuple[Style, ...] = (
    Style(
        "cosy-pub",
        "Cosy pub",
        "🍺",
        "Hearty plates by the fire",
        "Cook it like a cosy country pub: hearty, generous, comforting plates you would order by a log fire.",
        "served in a cosy country pub on a worn wooden table, warm lamplight",
    ),
    Style(
        "street-food",
        "Street food",
        "🌯",
        "Bold, messy market-stall food",
        "Cook it like late-night street food from a market stall: bold, messy, handheld or served in a paper tray.",
        "served street-food style in a paper tray at a night market, neon evening light",
    ),
    Style(
        "posh-tasting",
        "Posh tasting menu",
        "🥂",
        "Tiny, fancy, very serious plates",
        "Cook it as a posh restaurant tasting menu: refined techniques, careful plating and small, elegant portions with a sense of theatre.",
        "precise fine-dining plating on a large white plate, soft restaurant lighting",
    ),
    Style(
        "breakfast-for-dinner",
        "Breakfast for dinner",
        "🥞",
        "Morning comfort at night",
        "Cook it as breakfast for dinner: the comforting shapes of a morning meal, served as a satisfying evening supper.",
        "served as a cosy breakfast-for-dinner meal on a kitchen table, warm evening light",
    ),
    Style(
        "date-night-bistro",
        "Date-night bistro",
        "🕯️",
        "Candlelit and a little indulgent",
        "Cook it like a candlelit neighbourhood bistro on a romantic evening: classic, confident and a little indulgent.",
        "served on a small bistro table by candlelight, intimate warm light",
    ),
    Style(
        "takeaway-at-home",
        "Takeaway at home",
        "🥡",
        "Your Friday-night favourite, homemade",
        "Cook it as a homemade version of a Friday-night takeaway: punchy, saucy and made to be eaten from the sofa.",
        "served in takeaway-style boxes on a low lounge table, cosy evening light",
    ),
    Style(
        "picnic",
        "Picnic",
        "🧺",
        "Packs up and travels well",
        "Cook it for a picnic: dishes that travel well, taste good at room temperature and can be shared from a blanket.",
        "served picnic-style on a checked blanket outdoors, bright natural daylight",
    ),
    Style(
        "campfire",
        "Campfire cookout",
        "🔥",
        "Smoky, rustic, outdoorsy",
        "Cook it like a campfire cookout: rustic and smoky, cooked over live fire or in one sturdy pot, eaten outdoors at dusk.",
        "served rustic-style in a cast-iron pan beside a campfire, glowing dusk light",
    ),
)
CHALLENGES: tuple[Challenge, ...] = (
    Challenge(
        "one-pan",
        "One pan only",
        "🍳",
        "Everything in a single pan",
        "KITCHEN CHALLENGE - one pan only: every dish must be cooked start to finish in a single pan, pot or tray. Bowls for preparation are fine.",
        "KITCHEN CHALLENGE - one pan only: list exactly one cooking vessel in cookware and never use or mention a second one.",
    ),
    Challenge(
        "no-oven",
        "No oven",
        "🚫",
        "Hob, grill or no heat at all",
        "KITCHEN CHALLENGE - no oven: nothing may be roasted or baked in an oven; use the hob, a grill or no heat at all.",
        "KITCHEN CHALLENGE - no oven: never use, preheat or mention an oven, and never roast or bake.",
    ),
    Challenge(
        "thirty-minutes",
        "Ready in 30 minutes",
        "⏱️",
        "First chop to table in half an hour",
        "KITCHEN CHALLENGE - ready in thirty minutes: each dish must go from first chop to table in 30 minutes or less, preparation included.",
        "KITCHEN CHALLENGE - ready in thirty minutes: prepMinutes plus cookMinutes must be 30 or less.",
    ),
    Challenge(
        "six-steps",
        "Six steps or fewer",
        "📝",
        "A short, simple method",
        "KITCHEN CHALLENGE - six steps or fewer: the full method must fit in at most six short steps.",
        "KITCHEN CHALLENGE - six steps or fewer: write at most six steps.",
    ),
)
STYLE_IDS: tuple[StyleId, ...] = tuple(s.id for s in STYLES)
CHALLENGE_IDS: tuple[ChallengeId, ...] = tuple(c.id for c in CHALLENGES)
NO_OVEN_WORDS: frozenset[str] = frozenset(
    {"oven", "ovens", "preheat", "preheated", "roast", "roasted", "roasting"}
    | {"bake", "baked", "baking", "traybake"}
)
COOKING_VESSEL_WORDS: tuple[tuple[str, ...], ...] = (
    ("frying", "pan"),
    ("saucepan",),
    ("skillet",),
    ("wok",),
    ("pot",),
    ("casserole",),
    ("roasting", "tin"),
    ("baking", "tray"),
    ("tray",),
    ("griddle",),
    ("oven",),
)


def style_by_id(style_id: str) -> Style | None:
    return next((s for s in STYLES if s.id == style_id), None)


def challenge_by_id(challenge_id: str) -> Challenge | None:
    return next((c for c in CHALLENGES if c.id == challenge_id), None)


def spin_style(rng: random.Random | None = None) -> StyleId:
    return (rng or secrets.SystemRandom()).choice(STYLE_IDS)
