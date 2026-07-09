from __future__ import annotations

from pathlib import Path

import pytest

from builder.jsontypes import JsonValue
from wixy_server.overlay import (
    DiscardOp,
    RevConflictError,
    SetOp,
    apply_patch,
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
