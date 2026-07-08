"""Full validate mode (spec/02-content-model.md §10) — every check, one machine-readable
result. Used by the admin API, the publisher, CI in both repos, and the AI agent.

Bindings are walked in **preview** mode (not publish): a currently-false `data-wx-if`
branch is retained (hidden), not extracted, so its bindings still get checked — the
condition could flip later, and a hidden branch's dead binding should still be caught.
"""

from __future__ import annotations

import re
from pathlib import Path

from builder.bindings import ResolveContext, apply_bindings
from builder.collections import COLLECTION_RULES, FOOTER_KEY, TREATMENTS_SECTIONS_PATH
from builder.content import dotted_get, load_json_object, scan_image_refs
from builder.errors import BuildError, ValidationResult
from builder.jsonschema_lite import validate_against_schema
from builder.jsontypes import JsonObject, JsonValue
from builder.render import SiteSource, resolved_global_content
from builder.templates import (
    inject_partials,
    load_partials,
    load_template,
    require_partial_markers,
)
from builder.theme import Theme

_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_WEIGHT_RE = re.compile(r"^[1-9]00$")
_SCHEMAS_DIR = Path(__file__).parent / "schemas"
_FONT_ROLES = ("serif", "sans", "script")


def validate_site(source: SiteSource, project_root: Path) -> ValidationResult:
    result = ValidationResult()
    _validate_pages(source, result)
    if source.theme is not None:
        _validate_theme(source.theme, result)
    _validate_collections(source, result)
    _validate_images(source, project_root, result)
    return result


def _validate_pages(source: SiteSource, result: ValidationResult) -> None:
    for slug, page_content in source.page_contents.items():
        file_label = f"pages/{slug}.html"
        template_path = source.pages_dir / f"{slug}.html"
        if not template_path.exists():
            result.add("missing-template", f"no template for page '{slug}'", file=file_label)
            continue
        try:
            soup = load_template(template_path)
            require_partial_markers(soup, file_label=file_label)
            partials = load_partials(source.partials_dir)
            inject_partials(soup, partials, file_label=file_label)
            body = soup.body
            if body is None:
                result.add("no-body", "template has no <body>", file=file_label)
                continue
            meta = page_content.get("meta")
            if not isinstance(meta, dict):
                result.add(
                    "missing-meta",
                    "page content missing a 'meta' object",
                    file=f"content/{slug}.json",
                )
            ctx = ResolveContext(page=page_content, glob=resolved_global_content(source))
            apply_bindings(body, ctx, mode="preview", file_label=file_label, sink=result)
        except BuildError as exc:
            result.add("build-error", str(exc), file=file_label)


def _validate_theme(theme: Theme, result: ValidationResult) -> None:
    for key, value in theme.colors.items():
        if not _HEX_COLOR_RE.match(value):
            result.add(
                "bad-color",
                f"theme color '{key}' is not a 6-digit hex value",
                file="theme/theme.json",
                key=f"colors.{key}",
            )
    for role, spec in theme.fonts.items():
        for weight in spec.weights:
            if not _WEIGHT_RE.match(weight):
                result.add(
                    "bad-weight",
                    f"font weight '{weight}' for '{role}' is not a known weight string",
                    file="theme/theme.json",
                    key=f"fonts.{role}.weights",
                )
    for role in _FONT_ROLES:
        if role not in theme.fonts:
            result.add(
                "missing-font-role",
                f"theme.json is missing the '{role}' font role",
                file="theme/theme.json",
                key=f"fonts.{role}",
            )


_schema_cache: dict[str, JsonObject] = {}


def _load_schema(name: str) -> JsonObject:
    if name not in _schema_cache:
        _schema_cache[name] = load_json_object(_SCHEMAS_DIR / f"{name}.schema.json")
    return _schema_cache[name]


def _validate_array(
    result: ValidationResult, items: JsonValue, schema_name: str, file_label: str, key_label: str
) -> None:
    if not isinstance(items, list):
        result.add(
            "bad-collection", f"'{key_label}' is not an array", file=file_label, key=key_label
        )
        return
    schema = _load_schema(schema_name)
    for index, item in enumerate(items):
        for message in validate_against_schema(item, schema, path=f"{key_label}[{index}]"):
            result.add("schema", message, file=file_label, key=key_label)


def _validate_collections(source: SiteSource, result: ValidationResult) -> None:
    for rule in COLLECTION_RULES:
        content = (
            source.global_content if rule.page == "_global" else source.page_contents.get(rule.page)
        )
        if content is None:
            continue
        found, value = dotted_get(content, rule.path)
        if not found:
            continue  # an actually-missing binding is reported by the binding pass
        file_label = (
            "content/_global.json" if rule.page == "_global" else f"content/{rule.page}.json"
        )
        _validate_array(result, value, rule.schema, file_label, rule.path)

    treatments = source.page_contents.get("treatments")
    if treatments is not None:
        found, sections = dotted_get(treatments, TREATMENTS_SECTIONS_PATH)
        if found and isinstance(sections, list):
            for index, section in enumerate(sections):
                if not isinstance(section, dict):
                    result.add(
                        "bad-collection",
                        f"sections[{index}] is not an object",
                        file="content/treatments.json",
                        key=f"sections[{index}]",
                    )
                    continue
                _validate_array(
                    result,
                    section.get("cards"),
                    "treatment-card",
                    "content/treatments.json",
                    f"sections[{index}].cards",
                )

    found, footer = dotted_get(source.global_content, FOOTER_KEY)
    if found and isinstance(footer, dict):
        for col_name, col_value in footer.items():
            if isinstance(col_value, list):
                _validate_array(
                    result, col_value, "footer-link", "content/_global.json", f"footer.{col_name}"
                )


def _validate_images(source: SiteSource, project_root: Path, result: ValidationResult) -> None:
    all_content: dict[str, JsonObject] = {**source.page_contents, "_global": source.global_content}
    for slug, content in all_content.items():
        file_label = "content/_global.json" if slug == "_global" else f"content/{slug}.json"
        for key_path, src in scan_image_refs(content):
            if not (project_root / src).exists():
                result.add(
                    "missing-image",
                    f"image file '{src}' does not exist",
                    file=file_label,
                    key=key_path,
                )
