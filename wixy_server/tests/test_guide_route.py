"""`/admin/guide/*` serving (spec/independence/07, milestone 8) — the built
guide's `StaticFiles` mount actually serves real content. Auth-gating itself
is `test_auth_gate_integration.py`'s job (same middleware every other
`/admin/*` path gets); this file only covers the mount's own behavior.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


@pytest.fixture
def wixy_repo_root(tmp_path: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "test",
                "repo": "https://example.invalid/x.git",
                "defaultBranch": "main",
                "cmdProject": "test",
                "domain": "test.example.invalid",
                "locale": "en-GB",
                "indexable": False,
                "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
            }
        ),
        encoding="utf-8",
    )
    return root


class TestGuideMount:
    def test_start_here_page_serves_real_content(
        self, tmp_path: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin/guide/start-here.html")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Going independent" in response.text

    def test_bare_root_resolves_to_start_here(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        """`StaticFiles(html=True)` looks for `index.html` at the mount root —
        `guide.build` writes it as a copy of `start-here.html` for exactly
        this (see `guide/build.py`'s own docstring)."""
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin/guide/")
        assert response.status_code == 200
        assert "Going independent" in response.text

    def test_stylesheet_and_script_are_served(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            css = client.get("/admin/guide/guide.css")
            js = client.get("/admin/guide/guide.js")
        assert css.status_code == 200
        assert js.status_code == 200

    def test_unknown_chapter_404s(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin/guide/does-not-exist.html")
        assert response.status_code == 404

    def test_every_manifest_chapter_is_served(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        """Guards against a chapter file existing in `guide/chapters/` but
        never being built (or vice versa) — every slug `guide.manifest`
        declares must actually resolve to a real, servable page."""
        from guide.manifest import CHAPTERS

        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            for chapter in CHAPTERS:
                response = client.get(f"/admin/guide/{chapter.slug}.html")
                assert response.status_code == 200, f"{chapter.slug} did not serve"
                assert chapter.page_title in response.text
