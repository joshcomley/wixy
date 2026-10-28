"""The Cookout twist catalogues (spec 09a section 3): ids, labels, food-free wording."""

import collections
import random
from pathlib import Path

import pytest

from wixy_server.livechat.cookout_bank import load_cookout_bank
from wixy_server.livechat.cookout_twists import (
    CHALLENGE_IDS,
    CHALLENGES,
    COOKING_VESSEL_WORDS,
    NO_OVEN_WORDS,
    STYLE_IDS,
    STYLES,
    Challenge,
    Style,
    challenge_by_id,
    spin_style,
    style_by_id,
)

BANK = load_cookout_bank(
    Path(__file__).resolve().parents[1] / "livechat" / "cookout_ingredients.json"
)


def test_ids_are_the_frozen_sets_and_unique() -> None:
    assert STYLE_IDS == (
        "cosy-pub",
        "street-food",
        "posh-tasting",
        "breakfast-for-dinner",
        "date-night-bistro",
        "takeaway-at-home",
        "picnic",
        "campfire",
    )
    assert CHALLENGE_IDS == ("one-pan", "no-oven", "thirty-minutes", "six-steps")
    assert len(set(STYLE_IDS)) == len(STYLES) == 8
    assert len(set(CHALLENGE_IDS)) == len(CHALLENGES) == 4


def test_labels_blurbs_and_emoji_are_bounded() -> None:
    entries: tuple[Style | Challenge, ...] = (*STYLES, *CHALLENGES)
    for entry in entries:
        assert 0 < len(entry.label) <= 30
        assert 0 < len(entry.blurb) <= 60
        assert entry.emoji


def test_lookup_by_id() -> None:
    for style in STYLES:
        assert style_by_id(style.id) is style
    for challenge in CHALLENGES:
        assert challenge_by_id(challenge.id) is challenge
    assert style_by_id("nope") is None and challenge_by_id("spin") is None


def _texts() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for style in STYLES:
        out.append((f"{style.id}.concept", style.concept_directive))
        out.append((f"{style.id}.picture", style.picture_phrase))
    for challenge in CHALLENGES:
        out.append((f"{challenge.id}.concept", challenge.concept_directive))
        out.append((f"{challenge.id}.recipe", challenge.recipe_directive))
    return out


@pytest.mark.parametrize(("where", "text"), _texts())
def test_every_directive_and_picture_phrase_is_food_free(where: str, text: str) -> None:
    found = BANK.find_contraband_ingredients(
        text, allowed_ingredient_ids=set(), allowed_staple_ids=set()
    )
    assert found == [], f"{where} names a food: {found}"
    assert "\n" not in text and text == text.strip()


def test_word_lists_are_lowercase_folded_tokens() -> None:
    assert all(w == w.lower() and w.isalpha() for w in NO_OVEN_WORDS)
    for phrase in COOKING_VESSEL_WORDS:
        assert all(w == w.lower() and w.isalpha() for w in phrase)


def test_spin_style_is_uniform_with_a_seeded_rng_and_always_a_catalogue_id() -> None:
    rng = random.Random(20261028)
    tally = collections.Counter(spin_style(rng) for _ in range(8000))
    assert set(tally) == set(STYLE_IDS)
    assert all(800 < n < 1200 for n in tally.values())
    assert spin_style() in STYLE_IDS
