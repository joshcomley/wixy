"""A minimal JSON-Schema-subset validator: `type`/`required`/`properties`/
`additionalProperties`/`items`/`enum`/`pattern`. Sufficient for `builder/schemas/*.json`
(spec/02-content-model.md §10) without pulling in an external JSON Schema dependency not
in the milestone-1 dependency list — see decisions/00002.

`builder/schemas/*.json` are genuine (valid) JSON Schema documents; this module simply
implements only the vocabulary subset they actually use, with error messages shaped for
our `file:key` reporting convention rather than a generic library's format.
"""

from __future__ import annotations

import re

from builder.jsontypes import JsonObject, JsonValue

_TYPE_MAP: dict[str, type | tuple[type, ...]] = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "number": (int, float),
    "integer": int,
}


def validate_against_schema(
    value: JsonValue, schema: JsonObject, *, path: str = "$", skip_pattern: bool = False
) -> list[str]:
    """Return human-readable error strings (empty list = valid).

    `skip_pattern` omits the `pattern` check everywhere in the tree — used by the
    draft-write gate (`wixy_server/draft_validate.py`) to enforce shape (type/
    required/properties/additionalProperties) without also enforcing content
    constraints like "non-blank", so an in-progress edit (e.g. a freshly added,
    not-yet-filled-in list item) stays a valid DRAFT state; full-schema
    enforcement (including `pattern`) remains publish-time only, in
    `builder.validate`, which never passes this flag.
    """
    errors: list[str] = []
    _check(value, schema, path, errors, skip_pattern=skip_pattern)
    return errors


def _check(
    value: JsonValue, schema: JsonObject, path: str, errors: list[str], *, skip_pattern: bool
) -> None:
    expected_type = schema.get("type")
    if isinstance(expected_type, str):
        py_type = _TYPE_MAP.get(expected_type)
        if expected_type in ("integer", "number") and isinstance(value, bool):
            errors.append(f"{path}: expected {expected_type}, got boolean")
            return
        if py_type is not None and not isinstance(value, py_type):
            errors.append(f"{path}: expected {expected_type}, got {type(value).__name__}")
            return

    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        errors.append(f"{path}: value {value!r} not in allowed set {enum!r}")

    pattern = schema.get("pattern")
    if (
        not skip_pattern
        and isinstance(pattern, str)
        and isinstance(value, str)
        and re.fullmatch(pattern, value) is None
    ):
        errors.append(f"{path}: '{value}' does not match pattern {pattern!r}")

    if isinstance(value, dict):
        required = schema.get("required")
        if isinstance(required, list):
            for key in required:
                if isinstance(key, str) and key not in value:
                    errors.append(f"{path}: missing required property '{key}'")
        properties = schema.get("properties")
        if isinstance(properties, dict):
            for key, sub_value in value.items():
                sub_schema = properties.get(key)
                if isinstance(sub_schema, dict):
                    _check(
                        sub_value, sub_schema, f"{path}.{key}", errors, skip_pattern=skip_pattern
                    )
            if schema.get("additionalProperties") is False:
                for key in value:
                    if key not in properties:
                        errors.append(f"{path}: unexpected property '{key}'")

    if isinstance(value, list):
        items_schema = schema.get("items")
        if isinstance(items_schema, dict):
            for index, item in enumerate(value):
                _check(item, items_schema, f"{path}[{index}]", errors, skip_pattern=skip_pattern)
