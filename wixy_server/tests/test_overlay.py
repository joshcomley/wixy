from __future__ import annotations

from pathlib import Path

import pytest

from builder.jsontypes import JsonValue
from wixy_server.overlay import (
    DiscardOp,
    PageAdd,
    RevConflictError,
    SetOp,
    add_page,
    apply_patch,
    delete_page,
    discard_all,
    empty_overlay,
    load_overlay,
    save_overlay,
)


class TestEmptyOverlay:
    def test_shape(self) -> None:
        overlay = empty_overlay("abc123")
        assert overlay.rev == 0
        assert overlay.base_sha == "abc123"
        assert overlay.ops == {}
        assert overlay.pages_added == ()
        assert overlay.pages_deleted == ()


class TestLoadOverlay:
    def test_missing_file_returns_empty_overlay_with_default_sha(self, tmp_path: Path) -> None:
        overlay = load_overlay(tmp_path / "overlay.json", default_base_sha="abc123")
        assert overlay == empty_overlay("abc123")

    def test_round_trips_through_save_and_load(self, tmp_path: Path) -> None:
        path = tmp_path / "overlay.json"
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [
                SetOp(file="index", path="hero.title", value="Hello"),
                SetOp(file="index", path="treatments.cards", value=[{"title": "A"}]),
                SetOp(file="_global", path="phone", value="07401 562 462"),
                SetOp(file="theme", path="colors.clay", value="#B26E4A"),
            ],
            by="editor",
            now="2026-07-09T12:00:00Z",
        )
        save_overlay(path, overlay)
        loaded = load_overlay(path, default_base_sha="should-not-be-used")
        assert loaded == overlay

    def test_save_leaves_no_tmp_file_behind(self, tmp_path: Path) -> None:
        path = tmp_path / "overlay.json"
        save_overlay(path, empty_overlay("abc123"))
        remaining = list(tmp_path.iterdir())
        assert remaining == [path]


class TestApplyPatch:
    def test_set_op_adds_a_key_and_bumps_rev(self) -> None:
        overlay = empty_overlay("abc123")
        result = apply_patch(
            overlay, 0, [SetOp(file="index", path="hero.title", value="Hi")], by="editor", now="t1"
        )
        assert result.rev == 1
        assert result.ops["index:hero.title"].value == "Hi"
        assert result.ops["index:hero.title"].by == "editor"
        assert result.ops["index:hero.title"].ts == "t1"

    def test_multiple_ops_in_one_patch_bump_rev_by_exactly_one(self) -> None:
        overlay = empty_overlay("abc123")
        result = apply_patch(
            overlay,
            0,
            [
                SetOp(file="index", path="hero.title", value="Hi"),
                SetOp(file="index", path="hero.tag", value="Tag"),
            ],
            by="editor",
            now="t1",
        )
        assert result.rev == 1
        assert len(result.ops) == 2

    def test_discard_op_removes_an_existing_key(self) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="Hi")],
            by="editor",
            now="t1",
        )
        result = apply_patch(
            overlay, 1, [DiscardOp(file="index", path="hero.title")], by="editor", now="t2"
        )
        assert result.rev == 2
        assert "index:hero.title" not in result.ops

    def test_discard_op_on_nonexistent_key_is_a_harmless_noop(self) -> None:
        overlay = empty_overlay("abc123")
        result = apply_patch(
            overlay, 0, [DiscardOp(file="index", path="never.set")], by="editor", now="t1"
        )
        assert result.rev == 1
        assert result.ops == {}

    def test_stale_rev_raises_rev_conflict_error(self) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="Hi")],
            by="editor",
            now="t1",
        )
        with pytest.raises(RevConflictError) as exc_info:
            apply_patch(
                overlay, 0, [SetOp(file="index", path="hero.tag", value="X")], by="editor", now="t2"
            )
        assert exc_info.value.expected == 0
        assert exc_info.value.actual == 1

    def test_setting_a_key_twice_overwrites_not_duplicates(self) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="First")],
            by="editor",
            now="t1",
        )
        result = apply_patch(
            overlay,
            1,
            [SetOp(file="index", path="hero.title", value="Second")],
            by="editor",
            now="t2",
        )
        assert len(result.ops) == 1
        assert result.ops["index:hero.title"].value == "Second"

    def test_collection_op_stores_the_whole_array_as_one_value(self) -> None:
        cards: JsonValue = [{"title": "A"}, {"title": "B"}]
        result = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="treatments.cards", value=cards)],
            by="editor",
            now="t1",
        )
        assert result.ops["index:treatments.cards"].value == cards

    def test_original_overlay_is_not_mutated(self) -> None:
        overlay = empty_overlay("abc123")
        apply_patch(
            overlay, 0, [SetOp(file="index", path="hero.title", value="Hi")], by="editor", now="t1"
        )
        assert overlay.ops == {}
        assert overlay.rev == 0


class TestDiscardAll:
    def test_empties_ops_and_bumps_rev(self) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="Hi")],
            by="editor",
            now="t1",
        )
        result = discard_all(overlay)
        assert result.ops == {}
        assert result.rev == overlay.rev + 1

    def test_a_stale_patch_after_discard_all_still_conflicts(self) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="Hi")],
            by="editor",
            now="t1",
        )
        discarded = discard_all(overlay)
        with pytest.raises(RevConflictError):
            apply_patch(
                discarded,
                overlay.rev,
                [SetOp(file="index", path="hero.tag", value="X")],
                by="editor",
                now="t2",
            )


class TestAddPage:
    def test_records_a_page_add_and_seeds_nav_label(self) -> None:
        result = add_page(
            empty_overlay("abc123"),
            0,
            from_slug="about",
            slug="contact",
            nav_label="Contact",
            by="editor",
            now="t1",
        )
        assert result.rev == 1
        assert result.pages_added == (PageAdd(slug="contact", from_slug="about"),)
        assert result.ops["contact:meta.navLabel"].value == "Contact"
        assert result.ops["contact:meta.navLabel"].by == "editor"

    def test_preserves_existing_ops_and_page_ops(self) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="Hi")],
            by="editor",
            now="t1",
        )
        result = add_page(
            overlay,
            1,
            from_slug="about",
            slug="contact",
            nav_label="Contact",
            by="editor",
            now="t2",
        )
        assert result.ops["index:hero.title"].value == "Hi"
        assert result.ops["contact:meta.navLabel"].value == "Contact"

    def test_multiple_adds_accumulate(self) -> None:
        overlay = add_page(
            empty_overlay("abc123"),
            0,
            from_slug="about",
            slug="contact",
            nav_label="Contact",
            by="editor",
            now="t1",
        )
        result = add_page(
            overlay, 1, from_slug="about", slug="team", nav_label="Team", by="editor", now="t2"
        )
        assert result.pages_added == (
            PageAdd(slug="contact", from_slug="about"),
            PageAdd(slug="team", from_slug="about"),
        )

    def test_stale_rev_raises_rev_conflict_error(self) -> None:
        overlay = add_page(
            empty_overlay("abc123"),
            0,
            from_slug="about",
            slug="contact",
            nav_label="Contact",
            by="editor",
            now="t1",
        )
        with pytest.raises(RevConflictError):
            add_page(
                overlay, 0, from_slug="about", slug="team", nav_label="Team", by="editor", now="t2"
            )

    def test_original_overlay_is_not_mutated(self) -> None:
        overlay = empty_overlay("abc123")
        add_page(
            overlay,
            0,
            from_slug="about",
            slug="contact",
            nav_label="Contact",
            by="editor",
            now="t1",
        )
        assert overlay.pages_added == ()
        assert overlay.rev == 0


class TestDeletePage:
    def test_stages_a_slug_for_deletion_and_bumps_rev(self) -> None:
        result = delete_page(empty_overlay("abc123"), 0, "about")
        assert result.rev == 1
        assert result.pages_deleted == ("about",)

    def test_deleting_the_same_slug_twice_does_not_duplicate_it(self) -> None:
        overlay = delete_page(empty_overlay("abc123"), 0, "about")
        result = delete_page(overlay, 1, "about")
        assert result.rev == 2  # still bumps, for consistent client rev-tracking
        assert result.pages_deleted == ("about",)

    def test_preserves_existing_ops(self) -> None:
        overlay = apply_patch(
            empty_overlay("abc123"),
            0,
            [SetOp(file="index", path="hero.title", value="Hi")],
            by="editor",
            now="t1",
        )
        result = delete_page(overlay, 1, "about")
        assert result.ops["index:hero.title"].value == "Hi"
        assert result.pages_deleted == ("about",)

    def test_stale_rev_raises_rev_conflict_error(self) -> None:
        overlay = delete_page(empty_overlay("abc123"), 0, "about")
        with pytest.raises(RevConflictError):
            delete_page(overlay, 0, "team")

    def test_original_overlay_is_not_mutated(self) -> None:
        overlay = empty_overlay("abc123")
        delete_page(overlay, 0, "about")
        assert overlay.pages_deleted == ()
        assert overlay.rev == 0
