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


class TestEnvOverrides:
    """spec/independence/01 §2.2: WIXY_SITE_REPO/WIXY_DOMAIN/WIXY_INDEXABLE layer over
    the committed projects/*.json, process environment only."""

    @pytest.fixture(autouse=True)
    def _clean_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for key in ("WIXY_SITE_REPO", "WIXY_DOMAIN", "WIXY_INDEXABLE"):
            monkeypatch.delenv(key, raising=False)

    def test_no_overrides_leaves_config_unchanged(self, tmp_path: Path) -> None:
        _write_project(tmp_path / "projects", "ca")
        registry = load_registry(tmp_path)
        cfg = registry.get("ca")
        assert cfg.repo == "https://example.invalid/ca.git"
        assert cfg.domain == "ca.example.invalid"
        assert cfg.indexable is False

    def test_site_repo_override(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        _write_project(tmp_path / "projects", "ca")
        monkeypatch.setenv("WIXY_SITE_REPO", "git@github.com:cottage-aesthetics/site.git")
        registry = load_registry(tmp_path)
        assert registry.get("ca").repo == "git@github.com:cottage-aesthetics/site.git"

    def test_domain_override(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        _write_project(tmp_path / "projects", "ca")
        monkeypatch.setenv("WIXY_DOMAIN", "www.cottageaesthetics.co.uk")
        registry = load_registry(tmp_path)
        assert registry.get("ca").domain == "www.cottageaesthetics.co.uk"

    def test_indexable_override_true(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        _write_project(tmp_path / "projects", "ca")  # committed indexable: false
        monkeypatch.setenv("WIXY_INDEXABLE", "1")
        registry = load_registry(tmp_path)
        assert registry.get("ca").indexable is True

    def test_indexable_override_false_is_explicit_not_just_absence(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_INDEXABLE", "0")
        _write_project(tmp_path / "projects", "ca")
        registry = load_registry(tmp_path)
        assert registry.get("ca").indexable is False

    def test_other_fields_untouched_by_overrides(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _write_project(tmp_path / "projects", "ca")
        monkeypatch.setenv("WIXY_DOMAIN", "www.cottageaesthetics.co.uk")
        registry = load_registry(tmp_path)
        cfg = registry.get("ca")
        assert cfg.slug == "ca"
        assert cfg.name == "CA"
        assert cfg.repo == "https://example.invalid/ca.git"
