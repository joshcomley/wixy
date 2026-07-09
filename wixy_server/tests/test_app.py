"""End-to-end tests for the first Wixy FastAPI app (spec/04 §4), against a real local
git origin repo + a tmp_path-backed Storage root — never the production
D:\\Servers\\Wixy\\Storage default (that doesn't exist until milestone 11's install).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app

_INDEX_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<h1 data-wx="hero.title">placeholder</h1>
<div data-wx-if="hero.showBanner"><p data-wx="hero.banner">placeholder</p></div>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""

_PARTIAL_HTML = "<body></body>\n"


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """This file exercises the preview render pipeline, not CF Access auth — that's
    `test_auth.py` (the verification logic) and `test_routes_auth_gate.py` (the
    middleware wired into a real app)'s job. Bypass the gate here so these tests keep
    testing exactly one thing each."""
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _project_json(slug: str, repo: str) -> str:
    return json.dumps(
        {
            "slug": slug,
            "name": slug,
            "repo": repo,
            "defaultBranch": "main",
            "cmdProject": slug,
            "domain": f"{slug}.example.invalid",
            "locale": "en-GB",
            "indexable": False,
            "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
        }
    )


def _write_site_repo(repo_dir: Path, *, with_theme: bool = False) -> None:
    (repo_dir / "pages").mkdir(parents=True)
    (repo_dir / "partials").mkdir()
    (repo_dir / "content").mkdir()
    (repo_dir / "pages" / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (repo_dir / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (repo_dir / "content" / "index.json").write_text(
        json.dumps(
            {
                "meta": {"title": "Home"},
                "hero": {
                    "title": "Original Title",
                    "showBanner": False,
                    "banner": "Hidden banner",
                },
            }
        ),
        encoding="utf-8",
    )
    (repo_dir / "content" / "_global.json").write_text("{}", encoding="utf-8")
    if with_theme:
        (repo_dir / "theme").mkdir()
        (repo_dir / "theme" / "theme.json").write_text(
            json.dumps(
                {
                    "colors": {"clay": "#B26E4A"},
                    "shadow": "0 1px 2px black",
                    "fonts": {
                        "serif": {"family": "Cormorant", "weights": ["400"], "italics": False}
                    },
                }
            ),
            encoding="utf-8",
        )


def _init_repo(repo_dir: Path, *, with_theme: bool = False) -> None:
    repo_dir.mkdir(parents=True, exist_ok=True)
    _git(["init", "--initial-branch=main"], repo_dir)
    _git(["config", "user.email", "test@example.com"], repo_dir)
    _git(["config", "user.name", "Test"], repo_dir)
    _write_site_repo(repo_dir, with_theme=with_theme)
    _git(["add", "."], repo_dir)
    _git(["commit", "-m", "initial"], repo_dir)


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    _init_repo(origin)
    return origin


def _wixy_repo_root(tmp_path: Path, name: str, slug: str, repo: str) -> Path:
    root = tmp_path / name
    (root / "projects").mkdir(parents=True)
    (root / "projects" / f"{slug}.json").write_text(_project_json(slug, repo), encoding="utf-8")
    return root


@pytest.fixture
def wixy_repo_root(tmp_path: Path, origin_repo: Path) -> Path:
    return _wixy_repo_root(tmp_path, "wixy-repo", "test", str(origin_repo))


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


class TestPreviewRoute:
    def test_renders_page_end_to_end(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin/preview/index.html")
        assert response.status_code == 200
        assert "Original Title" in response.text
        assert response.headers["cache-control"] == "no-store"

    def test_preview_mode_retains_hidden_section(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin/preview/index.html")
        assert "Hidden banner" in response.text
        assert 'data-wx-hidden="1"' in response.text

    def test_editor_assets_injected(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin/preview/index.html")
        assert "/admin/static/editor/editor.js" in response.text
        assert "/admin/static/editor/editor.css" in response.text
        assert 'id="wx-bindings"' in response.text

    def test_unknown_page_is_404(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin/preview/does-not-exist.html")
        assert response.status_code == 404

    def test_draft_overlay_is_respected(self, storage_root: Path, wixy_repo_root: Path) -> None:
        """A PATCH'd overlay op must win over the repo's own content — the whole
        point of the draft preview (spec/02 §8)."""
        overlay_path = storage_root / "projects" / "test" / "draft" / "overlay.json"
        overlay_path.parent.mkdir(parents=True)
        overlay_path.write_text(
            json.dumps(
                {
                    "rev": 1,
                    "baseSha": "0" * 40,
                    "ops": {
                        "index:hero.title": {
                            "value": "Drafted Title",
                            "ts": "2026-01-01T00:00:00Z",
                            "by": "editor",
                        }
                    },
                    "pages": {"added": [], "deleted": []},
                }
            ),
            encoding="utf-8",
        )
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin/preview/index.html")
        assert "Drafted Title" in response.text
        assert "Original Title" not in response.text

    def test_theme_present_in_repo_does_not_crash_render(
        self, tmp_path: Path, storage_root: Path
    ) -> None:
        origin = tmp_path / "origin-with-theme"
        _init_repo(origin, with_theme=True)
        wixy_repo_root = _wixy_repo_root(tmp_path, "wixy-repo-theme", "test", str(origin))

        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin/preview/index.html")
        assert response.status_code == 200
        assert "fonts.googleapis.com" in response.text


class TestCreateAppProjectCountAssertion:
    def test_raises_when_registry_has_more_than_one_project(self, tmp_path: Path) -> None:
        wixy_repo_root = tmp_path / "wixy-repo"
        (wixy_repo_root / "projects").mkdir(parents=True)
        for slug in ("a", "b"):
            (wixy_repo_root / "projects" / f"{slug}.json").write_text(
                _project_json(slug, "https://example.invalid/x.git"), encoding="utf-8"
            )
        with pytest.raises(RuntimeError, match="exactly one"):
            create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
