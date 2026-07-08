"""The fixed v1 collection-key -> schema mapping (spec/02-content-model.md §6/§10).

This is content-MODEL knowledge — part of the normative 02 contract every consumer
(builder/editor/API/AI agent) programs against — not Cottage-Aesthetics business data;
see decisions/00002 for why this is hardcoded rather than made per-project-configurable
in v1. Two shapes don't fit the flat "one dotted path per file" table below and are
handled as special cases in `validate.py`: `treatments.json`'s `sections[].cards` (a
list of sections, each itself carrying a `cards` list) and `_global.json`'s `footer.*`
(an object whose exact column names aren't fixed by the spec — 02 §3's own example
literally writes `"footer": {"…": "columns/links as lists"}` — so every list found
nested under `footer` is validated against the same link-item shape).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class CollectionRule:
    """`page` is a content-file slug or `_global`; `path` is the dotted array path within it."""

    page: str
    path: str
    schema: str


COLLECTION_RULES: tuple[CollectionRule, ...] = (
    CollectionRule(page="_global", path="hours", schema="hours"),
    CollectionRule(page="_global", path="navExtra", schema="nav-extra"),
    CollectionRule(page="index", path="treatments.cards", schema="treatment-card"),
    CollectionRule(page="treatments", path="rx.items", schema="rx-item"),
    CollectionRule(page="gallery", path="gallery.sliders", schema="gallery-slider"),
    CollectionRule(page="gallery", path="gallery.tiles", schema="gallery-tile"),
    CollectionRule(page="reviews", path="reviews.items", schema="reviews-item"),
)

TREATMENTS_SECTIONS_PATH = "sections"
FOOTER_KEY = "footer"
