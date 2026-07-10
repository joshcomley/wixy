from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from builder.config import MediaConfig, ProjectConfig
from builder.content import dotted_get
from builder.jsontypes import JsonObject, JsonValue
from builder.render import SiteSource
from builder.theme import FontSpec, Theme
from wixy_server.merged_content import merge_overlay
from wixy_server.overlay import PageAdd, SetOp, add_page, apply_patch, delete_page, empty_overlay


def _at(content: JsonObject, path: str) -> JsonValue:
    """`dotted_get` unwrapped for assertions — `JsonValue` is a recursive union mypy
    can't narrow through chained subscripting, same reasoning as builder/tests/
    test_validate.py's own docstring."""
    found, value = dotted_get(content, path)
    assert found, f"path '{path}' not found"
    return value


@pytest.fixture
def project() -> ProjectConfig:
    return ProjectConfig(
        slug="ca",
        name="Cottage Aesthetics",
        repo="https://example.invalid/ca.git",
        default_branch="main",
        cmd_project="ca",
        domain="ca.example.invalid",
        locale="en-GB",
        indexable=False,
        media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
    )


@pytest.fixture
def source(project: ProjectConfig, tmp_path: Path) -> SiteSource:
    index_content: JsonObject = {
        "meta": {"title": "Home"},
        "hero": {"title": "Original Title", "tag": "Original tag"},
        "treatments": {"cards": [{"title": "Original Card"}]},
    }
    global_content: JsonObject = {"phone": "01234 000000", "brand": {"line1": "Cottage"}}
    theme = Theme(
        colors={"clay": "#OLD"},
        shadow="0 1px 2px black",
        fonts={"serif": FontSpec(family="Old Font", weights=["400"], italics=False)},
    )
    return SiteSource(
        project=project,
        pages_dir=tmp_path / "pages",
        partials_dir=tmp_path / "partials",
        theme=theme,
        page_contents={"index": index_content},
        global_content=global_content,
        content_dir=tmp_path / "content",
    )


class TestMergeOverlay:
    def test_empty_overlay_leaves_content_unchanged(self, source: SiteSource) -> None:
        merged = merge_overlay(source, empty_overlay("abc123"))
        assert merged.page_contents == source.page_contents
        assert merged.global_content == source.global_content
        assert merged.theme == source.theme

    def test_scalar_page_op_overrides_that_key_only(self, source: SiteSource) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="New Title")],
            by="editor",
            now="t1",
        )
        merged = merge_overlay(source, overlay)
        assert _at(merged.page_contents["index"], "hero.title") == "New Title"
        assert _at(merged.page_contents["index"], "hero.tag") == "Original tag"

    def test_collection_op_replaces_the_whole_array(self, source: SiteSource) -> None:
        new_cards: JsonValue = [{"title": "A"}, {"title": "B"}]
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="treatments.cards", value=new_cards)],
            by="editor",
            now="t1",
        )
        merged = merge_overlay(source, overlay)
        assert _at(merged.page_contents["index"], "treatments.cards") == new_cards

    def test_global_op_overrides_global_content(self, source: SiteSource) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="_global", path="phone", value="07401 562 462")],
            by="editor",
            now="t1",
        )
        merged = merge_overlay(source, overlay)
        assert merged.global_content["phone"] == "07401 562 462"
        assert merged.global_content["brand"] == {"line1": "Cottage"}

    def test_theme_op_overrides_a_color(self, source: SiteSource) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="theme", path="colors.clay", value="#NEW")],
            by="editor",
            now="t1",
        )
        merged = merge_overlay(source, overlay)
        assert merged.theme is not None
        assert merged.theme.colors["clay"] == "#NEW"
        assert source.theme is not None
        assert merged.theme.shadow == source.theme.shadow

    def test_theme_op_is_a_noop_when_theme_not_yet_migrated(
        self, project: ProjectConfig, tmp_path: Path
    ) -> None:
        source_no_theme = SiteSource(
            project=project,
            pages_dir=tmp_path / "pages",
            partials_dir=tmp_path / "partials",
            theme=None,
            page_contents={"index": {"meta": {"title": "Home"}}},
            global_content={},
            content_dir=tmp_path / "content",
        )
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="theme", path="colors.clay", value="#NEW")],
            by="editor",
            now="t1",
        )
        merged = merge_overlay(source_no_theme, overlay)
        assert merged.theme is None

    def test_op_targeting_unknown_page_slug_is_skipped_not_raised(self, source: SiteSource) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="deleted-page", path="hero.title", value="X")],
            by="editor",
            now="t1",
        )
        merged = merge_overlay(source, overlay)  # must not raise
        assert "deleted-page" not in merged.page_contents

    def test_does_not_mutate_the_original_source(self, source: SiteSource) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="New Title")],
            by="editor",
            now="t1",
        )
        merge_overlay(source, overlay)
        assert _at(source.page_contents["index"], "hero.title") == "Original Title"

    def test_upstream_only_key_flows_through_untouched(self, source: SiteSource) -> None:
        """A key nobody has drafted keeps whatever the checkout currently has —
        this is what makes AI-lane upstream edits appear in preview automatically
        (spec/02 §8)."""
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="Drafted Title")],
            by="editor",
            now="t1",
        )
        merged = merge_overlay(source, overlay)
        assert _at(merged.page_contents["index"], "hero.tag") == "Original tag"


class TestMergeOverlayPageOps:
    def test_a_page_added_via_duplicate_is_seeded_from_its_source_page(
        self, source: SiteSource
    ) -> None:
        overlay = add_page(
            empty_overlay("abc123"),
            0,
            from_slug="index",
            slug="index-copy",
            nav_label="Index Copy",
            by="editor",
            now="t1",
        )
        merged = merge_overlay(source, overlay)
        assert "index-copy" in merged.page_contents
        assert _at(merged.page_contents["index-copy"], "hero.title") == "Original Title"
        assert _at(merged.page_contents["index-copy"], "meta.navLabel") == "Index Copy"
        # the SOURCE page is untouched by duplicating it
        found, _ = dotted_get(merged.page_contents["index"], "meta.navLabel")
        assert not found

    def test_a_page_added_from_an_unknown_source_slug_is_skipped_not_raised(
        self, source: SiteSource
    ) -> None:
        overlay = add_page(
            empty_overlay("abc123"),
            0,
            from_slug="does-not-exist",
            slug="new-page",
            nav_label="New",
            by="editor",
            now="t1",
        )
        merged = merge_overlay(source, overlay)  # must not raise
        assert "new-page" not in merged.page_contents

    def test_a_page_added_never_overwrites_an_existing_slug(self, source: SiteSource) -> None:
        # Defensive: the route validates this can't happen, but merge_overlay
        # itself should never let a page-add clobber real, already-published
        # content for a slug that happens to collide.
        overlay = dataclasses.replace(
            empty_overlay("abc123"), pages_added=(PageAdd(slug="index", from_slug="index"),)
        )
        merged = merge_overlay(source, overlay)
        assert merged.page_contents["index"] == source.page_contents["index"]

    def test_a_page_staged_for_deletion_still_renders_normally(self, source: SiteSource) -> None:
        overlay = delete_page(empty_overlay("abc123"), 0, "index")
        merged = merge_overlay(source, overlay)
        # spec/04 §5: deletion "takes effect at publish" — the draft view is
        # unaffected until then.
        assert merged.page_contents["index"] == source.page_contents["index"]
