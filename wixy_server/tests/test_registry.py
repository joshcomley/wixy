from __future__ import annotations

import json
from pathlib import Path

import pytest

from wixy_server.registry import UnknownProjectError, load_registry


def _write_project(projects_dir: Path, slug: str) -> None:
    projects_dir.mkdir(parents=True, exist_ok=True)
    (projects_dir / f"{slug}.json").write_text(
        json.dumps(
            {
                "slug": slug,
                "name": slug.upper(),
                "repo": f"https://example.invalid/{slug}.git",
                "defaultBranch": "main",
                "cmdProject": slug,
                "domain": f"{slug}.example.invalid",
                "locale": "en-GB",
                "indexable": False,
                "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
            }
        ),
        encoding="utf-8",
    )


class TestLoadRegistry:
    def test_loads_a_single_project(self, tmp_path: Path) -> None:
        _write_project(tmp_path / "projects", "ca")
        registry = load_registry(tmp_path)
        assert "ca" in registry
        assert registry.get("ca").slug == "ca"
        assert len(registry.all()) == 1

    def test_loads_multiple_projects(self, tmp_path: Path) -> None:
        _write_project(tmp_path / "projects", "ca")
        _write_project(tmp_path / "projects", "other")
        registry = load_registry(tmp_path)
        assert len(registry.all()) == 2
        assert "other" in registry

    def test_empty_projects_dir_raises(self, tmp_path: Path) -> None:
        (tmp_path / "projects").mkdir()
        with pytest.raises(ValueError, match="empty"):
            load_registry(tmp_path)

    def test_missing_projects_dir_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="empty"):
            load_registry(tmp_path)

    def test_unknown_slug_raises(self, tmp_path: Path) -> None:
        _write_project(tmp_path / "projects", "ca")
        registry = load_registry(tmp_path)
        with pytest.raises(UnknownProjectError):
            registry.get("nonexistent")
