"""The draft-write gate (decisions/00095) — normalize + structural validate."""

from __future__ import annotations

from pathlib import Path

import pytest

from builder.jsontypes import JsonObject
from wixy_server.draft_validate import DraftValidationError, check_structural, normalize_set_ops
from wixy_server.overlay import SetOp
from wixy_server.storage import ProjectPaths, ensure_project_dirs, project_paths


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    p = project_paths(tmp_path / "storage", "test")
    ensure_project_dirs(p)
    (p.repo / "images").mkdir(parents=True)
    return p


class TestNormalizeSetOps:
    def test_rewrites_a_leading_slash_repo_image_src_when_the_file_exists(
        self, paths: ProjectPaths
    ) -> None:
        (paths.repo / "images" / "hero.jpg").write_bytes(b"x")
        ops = [
            SetOp(
                file="gallery",
                path="meta.ogImage",
                value={"src": "/images/hero.jpg", "alt": "Hero"},
            )
        ]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value == {"src": "images/hero.jpg", "alt": "Hero"}

    def test_leaves_a_leading_slash_src_alone_when_the_file_does_not_exist(
        self, paths: ProjectPaths
    ) -> None:
        # Never invent a reference to a file that isn't there — that's a real
        # validate-time (missing-image) error to surface, not paper over.
        ops = [
            SetOp(file="gallery", path="meta.ogImage", value={"src": "/images/nope.jpg", "alt": ""})
        ]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value == {"src": "/images/nope.jpg", "alt": ""}

    def test_leaves_a_still_staged_draft_media_src_untouched(self, paths: ProjectPaths) -> None:
        # The upload is sitting in draft/media waiting to be published — the
        # `/admin/draft-media/` form is exactly right and must survive.
        (paths.draft_media / "abc12345-x.jpg").write_bytes(b"x")
        ops = [
            SetOp(
                file="gallery",
                path="meta.ogImage",
                value={"src": "/admin/draft-media/abc12345-x.jpg", "alt": ""},
            )
        ]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value == {"src": "/admin/draft-media/abc12345-x.jpg", "alt": ""}

    def test_leaves_a_draft_media_src_that_resolves_nowhere_untouched(
        self, paths: ProjectPaths
    ) -> None:
        # No staged copy, no published image either — never invent a reference;
        # this is a real missing-image error for validate to surface.
        ops = [
            SetOp(
                file="gallery",
                path="meta.ogImage",
                value={"src": "/admin/draft-media/abc12345-gone.jpg", "alt": ""},
            )
        ]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value == {"src": "/admin/draft-media/abc12345-gone.jpg", "alt": ""}

    def test_repoints_an_already_published_draft_media_src_at_its_published_image(
        self, paths: ProjectPaths
    ) -> None:
        """decisions/00115 — the 2026-08-03 production shape: publish copied the
        staged upload into the repo and deleted the staged copy, then a client
        holding a pre-publish array wrote the dead `/admin/draft-media/` src
        back into the draft. The same file IS there, under its published name."""
        (paths.repo / "images" / "cc9f64c7-img-1721-aligned.jpg").write_bytes(b"x")
        ops = [
            SetOp(
                file="gallery",
                path="meta.ogImage",
                value={"src": "/admin/draft-media/cc9f64c7-img-1721-aligned.jpg", "alt": "Img"},
            )
        ]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value == {"src": "images/cc9f64c7-img-1721-aligned.jpg", "alt": "Img"}

    def test_collapses_a_whole_value_nbsp_character_to_empty_string(
        self, paths: ProjectPaths
    ) -> None:
        ops = [SetOp(file="index", path="hero.title", value=" ")]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value == ""

    def test_collapses_the_literal_nbsp_entity_text_to_empty_string(
        self, paths: ProjectPaths
    ) -> None:
        # nh3's sanitize pass re-serializes a bare U+00A0 as this literal text
        # (verified empirically) — a value that round-tripped through it must
        # be treated the same as the raw character.
        ops = [SetOp(file="index", path="hero.title", value="&nbsp;")]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value == ""

    def test_does_not_touch_real_text_merely_containing_whitespace(
        self, paths: ProjectPaths
    ) -> None:
        ops = [SetOp(file="index", path="hero.title", value="  Lip Enhancement  ")]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value == "  Lip Enhancement  "

    def test_normalizes_recursively_through_a_whole_array_op(self, paths: ProjectPaths) -> None:
        (paths.repo / "images" / "after.jpg").write_bytes(b"x")
        ops = [
            SetOp(
                file="gallery",
                path="gallery.sliders",
                value=[
                    {
                        "cat": "lips",
                        "title": "&nbsp;",
                        "sub": " ",
                        "before": {"src": "", "alt": ""},
                        "after": {"src": "/images/after.jpg", "alt": "&nbsp;"},
                    }
                ],
            )
        ]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value == [
            {
                "cat": "lips",
                "title": "",
                "sub": "",
                "before": {"src": "", "alt": ""},
                "after": {"src": "images/after.jpg", "alt": ""},
            }
        ]

    def test_passes_non_string_leaves_through_unchanged(self, paths: ProjectPaths) -> None:
        ops = [SetOp(file="about", path="meta.inNav", value=True)]

        [normalized] = normalize_set_ops(ops, paths)

        assert normalized.value is True


class TestCheckStructural:
    def _slider(self, **overrides: JsonObject | str) -> JsonObject:
        base: JsonObject = {
            "cat": "lips",
            "title": "Lip Enhancement",
            "sub": "Dermal filler",
            "before": {"src": "images/before.jpg", "alt": ""},
            "after": {"src": "images/after.jpg", "alt": ""},
        }
        base.update(overrides)
        return base

    def test_accepts_a_well_formed_collection_op(self) -> None:
        ops = [SetOp(file="gallery", path="gallery.sliders", value=[self._slider()])]
        check_structural(ops)  # does not raise

    def test_ignores_an_op_targeting_an_unknown_path(self) -> None:
        ops = [SetOp(file="index", path="hero.title", value="anything at all")]
        check_structural(ops)  # not a known collection — no check applies

    def test_rejects_a_missing_required_property(self) -> None:
        # The exact shape of the 2026-07-28 incident: every item missing `cat`.
        slider = self._slider()
        del slider["cat"]
        ops = [SetOp(file="gallery", path="gallery.sliders", value=[slider])]

        with pytest.raises(DraftValidationError) as exc_info:
            check_structural(ops)
        assert "gallery:gallery.sliders" in exc_info.value.summary
        assert any("cat" in detail for detail in exc_info.value.details)

    def test_rejects_an_unexpected_property(self) -> None:
        ops = [
            SetOp(
                file="gallery",
                path="gallery.sliders",
                value=[self._slider(extra="not allowed")],
            )
        ]
        with pytest.raises(DraftValidationError):
            check_structural(ops)

    def test_rejects_a_non_array_value(self) -> None:
        ops = [SetOp(file="gallery", path="gallery.sliders", value={"not": "a list"})]
        with pytest.raises(DraftValidationError):
            check_structural(ops)

    def test_allows_blank_strings_pattern_is_publish_time_only(self) -> None:
        # decisions/00095: an in-progress, freshly-added-but-not-yet-filled-in
        # item (blank title/sub/src, all still valid STRINGS) must stay a valid
        # DRAFT state — only builder.validate (publish time) enforces `pattern`
        # (the non-blank-src guard, builder/schemas/gallery-slider.schema.json).
        ops = [
            SetOp(
                file="gallery",
                path="gallery.sliders",
                value=[self._slider(title="", sub="", before={"src": "", "alt": ""})],
            )
        ]
        check_structural(ops)  # does not raise

    def test_rejects_a_treatments_section_card_missing_a_required_field(self) -> None:
        card: JsonObject = {
            "meta": "Popular",
            "title": "Anti-Wrinkle",
            "price": "£150",
            "body": "Body copy",
            "course": False,
            # "book" deliberately omitted
        }
        ops = [
            SetOp(
                file="treatments",
                path="sections",
                value=[{"heading": "Injectables", "cards": [card]}],
            )
        ]
        with pytest.raises(DraftValidationError) as exc_info:
            check_structural(ops)
        assert any("book" in detail for detail in exc_info.value.details)

    def test_accepts_a_treatments_section_with_no_cards_key_yet(self) -> None:
        # No fixed schema exists for a section itself (builder.validate doesn't
        # check one either, only .cards when present) — an in-progress section
        # with no cards key yet is not a structural violation at draft time.
        ops = [SetOp(file="treatments", path="sections", value=[{"heading": "New section"}])]
        check_structural(ops)  # does not raise

    def test_rejects_a_footer_column_link_missing_href(self) -> None:
        ops = [
            SetOp(
                file="_global",
                path="footer.explore",
                value=[{"label": "About"}],  # missing href
            )
        ]
        with pytest.raises(DraftValidationError) as exc_info:
            check_structural(ops)
        assert "_global:footer.explore" in exc_info.value.summary

    def test_accepts_a_well_formed_footer_column(self) -> None:
        ops = [
            SetOp(
                file="_global",
                path="footer.visit",
                value=[{"label": "About", "href": "/about.html"}],
            )
        ]
        check_structural(ops)  # does not raise

    def test_a_batch_with_one_bad_op_among_good_ones_still_raises(self) -> None:
        bad_slider = self._slider()
        del bad_slider["cat"]
        ops = [
            SetOp(file="index", path="hero.title", value="Fine"),
            SetOp(file="gallery", path="gallery.sliders", value=[bad_slider]),
        ]
        with pytest.raises(DraftValidationError):
            check_structural(ops)
