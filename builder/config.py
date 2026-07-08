"""Project registry loader (spec/04-server.md §1)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from builder.content import load_json_object
from builder.jsontypes import JsonValue


@dataclass(frozen=True, slots=True)
class MediaConfig:
    max_long_side_px: int
    jpeg_quality: int


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


def _as_int(value: JsonValue, default: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return default


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
    )


def load_all_projects(projects_dir: Path) -> dict[str, ProjectConfig]:
    """Load every `projects/*.json` (04 §1) — v1 runs one, but nothing may assume that."""
    projects: dict[str, ProjectConfig] = {}
    for path in sorted(projects_dir.glob("*.json")):
        cfg = load_project_config(path)
        projects[cfg.slug] = cfg
    return projects
