"""Content JSON I/O + dotted-path tests (spec/02-content-model.md §2-3)."""

from __future__ import annotations

from pathlib import Path

from builder.content import dotted_get, dotted_set, scan_image_refs, write_json_canonical
from builder.jsontypes import JsonObject


class TestDottedGet:
    def test_nested_path(self) -> None:
        assert dotted_get({"a": {"b": {"c": 1}}}, "a.b.c") == (True, 1)

    def test_top_level_key(self) -> None:
        assert dotted_get({"a": 1}, "a") == (True, 1)

    def test_empty_path_returns_whole_value(self) -> None:
        assert dotted_get({"a": 1}, "") == (True, {"a": 1})

    def test_missing_intermediate_key(self) -> None:
        assert dotted_get({"a": {}}, "a.b.c") == (False, None)

    def test_path_through_non_dict(self) -> None:
        assert dotted_get({"a": "x"}, "a.b") == (False, None)


class TestDottedSet:
    def test_creates_intermediate_dicts(self) -> None:
        data: JsonObject = {}
        dotted_set(data, "a.b.c", 1)
        assert data == {"a": {"b": {"c": 1}}}

    def test_overwrites_existing_leaf(self) -> None:
        data: JsonObject = {"a": {"b": 1}}
        dotted_set(data, "a.b", 2)
        assert data == {"a": {"b": 2}}

    def test_top_level_key(self) -> None:
        data: JsonObject = {}
        dotted_set(data, "x", "y")
        assert data == {"x": "y"}


class TestCanonicalWrite:
    def test_sorts_keys_and_uses_2_space_indent(self, tmp_path: Path) -> None:
        path = tmp_path / "out.json"
        write_json_canonical(path, {"b": 1, "a": 2})
        text = path.read_text(encoding="utf-8")
        assert text == '{\n  "a": 2,\n  "b": 1\n}\n'

    def test_idempotent_rewrite_is_byte_identical(self, tmp_path: Path) -> None:
        path = tmp_path / "out.json"
        data: JsonObject = {"z": [1, 2, {"y": "x"}], "a": "café"}
        write_json_canonical(path, data)
        first = path.read_bytes()
        write_json_canonical(path, data)
        second = path.read_bytes()
        assert first == second

    def test_writes_utf8_without_escaping(self, tmp_path: Path) -> None:
        path = tmp_path / "out.json"
        write_json_canonical(path, {"a": "café"})
        assert "café" in path.read_text(encoding="utf-8")


class TestScanImageRefs:
    def test_finds_top_level_image_object(self) -> None:
        found = scan_image_refs({"hero": {"src": "images/x.jpg", "alt": "X"}})
        assert found == [("hero", "images/x.jpg")]

    def test_finds_image_objects_inside_lists(self) -> None:
        found = scan_image_refs({"items": [{"src": "images/a.jpg", "alt": "A"}]})
        assert found == [("items[0]", "images/a.jpg")]

    def test_ignores_dicts_without_alt(self) -> None:
        found = scan_image_refs({"x": {"src": "images/a.jpg"}})
        assert found == []

    def test_no_images_returns_empty(self) -> None:
        assert scan_image_refs({"a": "b", "c": [1, 2, 3]}) == []
