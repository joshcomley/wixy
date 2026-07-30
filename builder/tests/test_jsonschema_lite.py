"""Tests for the minimal JSON-Schema-subset validator (spec/02-content-model.md §10)."""

from __future__ import annotations

from pathlib import Path

from builder.content import load_json_object
from builder.jsonschema_lite import validate_against_schema
from builder.jsontypes import JsonObject

_SCHEMAS_DIR = Path(__file__).parent.parent / "schemas"


class TestTypeChecking:
    def test_valid_object_no_errors(self) -> None:
        schema: JsonObject = {
            "type": "object",
            "required": ["a"],
            "properties": {"a": {"type": "string"}},
        }
        assert validate_against_schema({"a": "x"}, schema) == []

    def test_wrong_type_reported(self) -> None:
        schema: JsonObject = {"type": "string"}
        errors = validate_against_schema(123, schema)
        assert len(errors) == 1
        assert "expected string" in errors[0]

    def test_boolean_rejected_for_integer_type(self) -> None:
        schema: JsonObject = {"type": "integer"}
        errors = validate_against_schema(True, schema)
        assert len(errors) == 1


class TestRequiredAndProperties:
    def test_missing_required_property_reported(self) -> None:
        schema: JsonObject = {"type": "object", "required": ["a", "b"], "properties": {}}
        errors = validate_against_schema({"a": 1}, schema)
        assert any("missing required property 'b'" in e for e in errors)

    def test_nested_property_errors_have_dotted_path(self) -> None:
        schema: JsonObject = {
            "type": "object",
            "properties": {"child": {"type": "object", "required": ["x"]}},
        }
        errors = validate_against_schema({"child": {}}, schema)
        assert any("$.child" in e for e in errors)

    def test_additional_properties_false_rejects_extras(self) -> None:
        schema: JsonObject = {
            "type": "object",
            "properties": {"a": {"type": "string"}},
            "additionalProperties": False,
        }
        errors = validate_against_schema({"a": "x", "b": "y"}, schema)
        assert any("unexpected property 'b'" in e for e in errors)


class TestArrayItems:
    def test_each_item_validated(self) -> None:
        schema: JsonObject = {"type": "array", "items": {"type": "string"}}
        errors = validate_against_schema(["a", 1, "c"], schema)
        assert len(errors) == 1
        assert "$[1]" in errors[0]


class TestEnumAndPattern:
    def test_enum_violation_reported(self) -> None:
        schema: JsonObject = {"enum": ["a", "b"]}
        errors = validate_against_schema("c", schema)
        assert len(errors) == 1

    def test_pattern_violation_reported(self) -> None:
        schema: JsonObject = {"type": "string", "pattern": r"^#[0-9A-Fa-f]{6}$"}
        assert validate_against_schema("#FFFFFF", schema) == []
        assert len(validate_against_schema("not-a-color", schema)) == 1

    def test_skip_pattern_omits_the_pattern_check_but_keeps_type_and_required(self) -> None:
        """decisions/00095: the draft-write gate structurally validates a
        collection item WITHOUT enforcing `pattern` (an in-progress, freshly
        added item stays a valid draft state) — but every other check still
        applies."""
        schema: JsonObject = {
            "type": "object",
            "required": ["a"],
            "properties": {"a": {"type": "string", "pattern": r"^#[0-9A-Fa-f]{6}$"}},
        }
        assert validate_against_schema({"a": "not-a-color"}, schema, skip_pattern=True) == []
        assert validate_against_schema({"a": "not-a-color"}, schema, skip_pattern=False) != []
        # required/type still enforced under skip_pattern.
        assert validate_against_schema({}, schema, skip_pattern=True) != []
        assert validate_against_schema({"a": 5}, schema, skip_pattern=True) != []

    def test_skip_pattern_applies_recursively_through_nested_objects(self) -> None:
        schema: JsonObject = {
            "type": "object",
            "properties": {
                "child": {
                    "type": "object",
                    "properties": {"x": {"type": "string", "pattern": r"\S"}},
                }
            },
        }
        assert validate_against_schema({"child": {"x": ""}}, schema, skip_pattern=True) == []
        assert validate_against_schema({"child": {"x": ""}}, schema, skip_pattern=False) != []


class TestRealSchemaFiles:
    def test_treatment_card_schema_accepts_well_formed_card(self) -> None:
        schema = load_json_object(_SCHEMAS_DIR / "treatment-card.schema.json")
        card: JsonObject = {
            "meta": "Skin health",
            "title": "Microneedling",
            "price": "From £30",
            "body": "Stimulates collagen.",
            "course": "",
            "book": True,
        }
        assert validate_against_schema(card, schema) == []

    def test_treatment_card_schema_rejects_missing_book(self) -> None:
        schema = load_json_object(_SCHEMAS_DIR / "treatment-card.schema.json")
        card: JsonObject = {"meta": "x", "title": "x", "price": "x", "body": "x", "course": ""}
        errors = validate_against_schema(card, schema)
        assert any("book" in e for e in errors)

    def test_gallery_slider_schema_rejects_a_blank_image_src(self) -> None:
        """decisions/00095: a blank before/after src is a publish-blocking
        problem (this pattern), but only at FULL validate — the draft-write
        gate's structural check (skip_pattern=True) deliberately still lets a
        freshly-added, not-yet-filled-in item through as a valid draft state."""
        schema = load_json_object(_SCHEMAS_DIR / "gallery-slider.schema.json")
        item: JsonObject = {
            "cat": "lips",
            "title": "New",
            "sub": "",
            "before": {"src": "", "alt": ""},
            "after": {"src": "images/x.jpg", "alt": ""},
        }
        assert any("before.src" in e for e in validate_against_schema(item, schema))
        assert validate_against_schema(item, schema, skip_pattern=True) == []

    def test_gallery_slider_schema_accepts_a_real_image_src(self) -> None:
        schema = load_json_object(_SCHEMAS_DIR / "gallery-slider.schema.json")
        item: JsonObject = {
            "cat": "lips",
            "title": "Lip Enhancement",
            "sub": "Dermal filler",
            "before": {"src": "images/before.jpg", "alt": "before"},
            "after": {"src": "images/after.jpg", "alt": "after"},
        }
        assert validate_against_schema(item, schema) == []

    def test_gallery_tile_schema_rejects_a_blank_image_src(self) -> None:
        schema = load_json_object(_SCHEMAS_DIR / "gallery-tile.schema.json")
        item: JsonObject = {"cat": "lips", "title": "New", "img": {"src": "", "alt": ""}}
        assert any("img.src" in e for e in validate_against_schema(item, schema))
        assert validate_against_schema(item, schema, skip_pattern=True) == []
