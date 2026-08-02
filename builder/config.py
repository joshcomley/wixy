"""Project registry loader (spec/04-server.md §1)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from builder.content import load_json_object
from builder.jsontypes import JsonObject, JsonValue

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class MediaConfig:
    max_long_side_px: int
    jpeg_quality: int


AdminFieldKind = Literal["image", "text", "choice"]

_ADMIN_FIELD_KINDS: tuple[AdminFieldKind, ...] = ("image", "text", "choice")


@dataclass(frozen=True, slots=True)
class AdminFieldOption:
    """A `choice`-kind `AdminField`'s one selectable value (spec: 3a)."""

    value: str
    label: str


@dataclass(frozen=True, slots=True)
class AdminField:
    """One editable property of a collection item — `key` is the item's JSON
    property name, `kind` picks the panel control (`image` -> media picker,
    `text` -> inline input, `choice` -> a `<select>` from `options`)."""

    key: str
    kind: AdminFieldKind
    label: str
    options: tuple[AdminFieldOption, ...] = ()


@dataclass(frozen=True, slots=True)
class AdminCollection:
    """A single array in the section's page content the panel manages as a
    whole — `path` is its dotted content path (e.g. `gallery.sliders`),
    `schema` names the `builder/schemas/<schema>.schema.json` a new item must
    satisfy (spec: 3a). `align_aspect` is the optional `(w, h)` of the frame a
    two-image item is displayed in (from the registry's `alignAspect` "W:H")
    — when present and the collection has ≥2 `image` fields, the panel offers
    the before/after aligner for its cards (decisions/00111)."""

    path: str
    label: str
    item_noun: str
    schema: str
    fields: tuple[AdminField, ...] = ()
    align_aspect: tuple[int, int] | None = None


@dataclass(frozen=True, slots=True)
class AdminSection:
    """One registry-configured admin nav entry + management screen (Inv 1 —
    no site literals in engine code; `ca.json` declares the actual "Before &
    After" section, the engine only renders whatever sections a project
    declares)."""

    id: str
    nav_label: str
    title: str
    description: str
    page: str
    collections: tuple[AdminCollection, ...] = ()


def _as_int(value: JsonValue, default: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return default


def _req_str(raw: JsonObject, key: str) -> str | None:
    """A required string field — `None` (not a silent default) so the
    caller can tell "field missing/wrong type" apart from "field present and
    empty," and skip the whole malformed entry rather than admit a
    half-valid one."""
    value = raw.get(key)
    return value if isinstance(value, str) else None


def _parse_admin_field_options(raw: JsonValue) -> tuple[AdminFieldOption, ...]:
    if not isinstance(raw, list):
        return ()
    options: list[AdminFieldOption] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        value = _req_str(item, "value")
        label = _req_str(item, "label")
        if value is None or label is None:
            continue
        options.append(AdminFieldOption(value=value, label=label))
    return tuple(options)


def _parse_admin_field(raw: JsonValue) -> AdminField | None:
    if not isinstance(raw, dict):
        return None
    key = _req_str(raw, "key")
    label = _req_str(raw, "label")
    kind = raw.get("kind")
    if key is None or label is None or kind not in _ADMIN_FIELD_KINDS:
        return None
    return AdminField(
        key=key, kind=kind, label=label, options=_parse_admin_field_options(raw.get("options", []))
    )


def _parse_admin_fields(raw: JsonValue) -> tuple[AdminField, ...]:
    if not isinstance(raw, list):
        return ()
    fields: list[AdminField] = []
    for item in raw:
        field = _parse_admin_field(item)
        if field is None:
            logger.warning("adminSections: skipping malformed field: %r", item)
            continue
        fields.append(field)
    return tuple(fields)


def _parse_align_aspect(raw: JsonValue) -> tuple[int, int] | None:
    """The optional `alignAspect` "W:H" on a collection (e.g. "640:360" — the
    frame its photo pairs are displayed in, for the aligner, decisions/00111).
    Malformed reads as None (aligner simply not offered) with a warning, the
    same skip-don't-crash posture as the other adminSections parsing."""
    if raw is None:
        return None
    if not isinstance(raw, str):
        logger.warning("adminSections: ignoring non-string alignAspect: %r", raw)
        return None
    parts = raw.split(":")
    if len(parts) != 2:
        logger.warning("adminSections: ignoring malformed alignAspect (want 'W:H'): %r", raw)
        return None
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError:
        logger.warning("adminSections: ignoring non-numeric alignAspect: %r", raw)
        return None
    if width <= 0 or height <= 0:
        logger.warning("adminSections: ignoring non-positive alignAspect: %r", raw)
        return None
    return (width, height)


def _parse_admin_collection(raw: JsonValue) -> AdminCollection | None:
    if not isinstance(raw, dict):
        return None
    path = _req_str(raw, "path")
    label = _req_str(raw, "label")
    item_noun = _req_str(raw, "itemNoun")
    schema = _req_str(raw, "schema")
    if path is None or label is None or item_noun is None or schema is None:
        return None
    return AdminCollection(
        path=path,
        label=label,
        item_noun=item_noun,
        schema=schema,
        fields=_parse_admin_fields(raw.get("fields", [])),
        align_aspect=_parse_align_aspect(raw.get("alignAspect")),
    )


def _parse_admin_collections(raw: JsonValue) -> tuple[AdminCollection, ...]:
    if not isinstance(raw, list):
        return ()
    collections: list[AdminCollection] = []
    for item in raw:
        collection = _parse_admin_collection(item)
        if collection is None:
            logger.warning("adminSections: skipping malformed collection: %r", item)
            continue
        collections.append(collection)
    return tuple(collections)


def _parse_admin_section(raw: JsonValue) -> AdminSection | None:
    if not isinstance(raw, dict):
        return None
    section_id = _req_str(raw, "id")
    nav_label = _req_str(raw, "navLabel")
    title = _req_str(raw, "title")
    description = _req_str(raw, "description")
    page = _req_str(raw, "page")
    if (
        section_id is None
        or nav_label is None
        or title is None
        or description is None
        or page is None
    ):
        return None
    return AdminSection(
        id=section_id,
        nav_label=nav_label,
        title=title,
        description=description,
        page=page,
        collections=_parse_admin_collections(raw.get("collections", [])),
    )


def _parse_admin_sections(data: JsonObject) -> tuple[AdminSection, ...]:
    raw = data.get("adminSections", [])
    if not isinstance(raw, list):
        return ()
    sections: list[AdminSection] = []
    for item in raw:
        section = _parse_admin_section(item)
        if section is None:
            logger.warning("adminSections: skipping malformed section: %r", item)
            continue
        sections.append(section)
    return tuple(sections)


@dataclass(frozen=True, slots=True)
class ProjectConfig:
    slug: str
    name: str
    repo: str
    default_branch: str
    cmd_project: str
    domain: str
    locale: str
    indexable: bool
    media: MediaConfig
    admin_sections: tuple[AdminSection, ...] = ()


def load_project_config(path: Path) -> ProjectConfig:
    data = load_json_object(path)

    def _str(key: str, default: str = "") -> str:
        value = data.get(key, default)
        return value if isinstance(value, str) else default

    media_raw = data.get("media", {})
    if not isinstance(media_raw, dict):
        media_raw = {}
    media = MediaConfig(
        max_long_side_px=_as_int(media_raw.get("maxLongSidePx"), 2000),
        jpeg_quality=_as_int(media_raw.get("jpegQuality"), 85),
    )

    return ProjectConfig(
        slug=_str("slug"),
        name=_str("name"),
        repo=_str("repo"),
        default_branch=_str("defaultBranch", "main"),
        cmd_project=_str("cmdProject"),
        domain=_str("domain"),
        locale=_str("locale", "en-GB"),
        indexable=bool(data.get("indexable", False)),
        media=media,
        admin_sections=_parse_admin_sections(data),
    )


def load_all_projects(projects_dir: Path) -> dict[str, ProjectConfig]:
    """Load every `projects/*.json` (04 §1) — v1 runs one, but nothing may assume that."""
    projects: dict[str, ProjectConfig] = {}
    for path in sorted(projects_dir.glob("*.json")):
        cfg = load_project_config(path)
        projects[cfg.slug] = cfg
    return projects
