"""Sanity checks against the REAL committed `projects/ca.json`, not a synthetic
fixture (decisions/00121). `test_config.py`'s parser tests all use their own
inline JSON, so a field's *declared* kind drifting from its *intended* kind
in the actual registry -- as happened with `gallery.sliders.sourceUrl`
shipping as "text" instead of "url" -- passes every one of them silently."""

from __future__ import annotations

from pathlib import Path

from builder.config import load_project_config

_CA_PROJECT_PATH = Path(__file__).resolve().parents[2] / "projects" / "ca.json"


def _field_kind(collection_path: str, field_key: str) -> str | None:
    config = load_project_config(_CA_PROJECT_PATH)
    for section in config.admin_sections:
        for collection in section.collections:
            if collection.path != collection_path:
                continue
            for field in collection.fields:
                if field.key == field_key:
                    return field.kind
    return None


class TestGallerySlidersRegistry:
    def test_source_url_field_is_url_kind_not_text(self) -> None:
        # decisions/00120 introduced a dedicated "url" AdminFieldKind
        # specifically so the admin renders a clickable "Open" link next to
        # the field -- "text" is a valid kind (so nothing else catches this)
        # but silently drops that affordance.
        assert _field_kind("gallery.sliders", "sourceUrl") == "url"

    def test_visible_field_is_toggle_kind(self) -> None:
        assert _field_kind("gallery.sliders", "visible") == "toggle"
