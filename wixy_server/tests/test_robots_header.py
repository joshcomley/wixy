"""`X-Robots-Tag: noindex` middleware tests (decisions/00137, docs/ai/invariants.md
Inv 37) — the non-HTML sibling of WP1's per-page HTML `noindex` meta
(`test_routes_public.py`'s `TestPublishedSite`/`TestRedirects` cover the rest of
public serving; this file is scoped to the header alone)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.robots_header import _should_tag_noindex
from wixy_server.storage import ProjectPaths, project_paths


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


def _project_json(slug: str, *, indexable: bool) -> str:
    return json.dumps(
        {
            "slug": slug,
            "name": slug,
            "repo": "https://example.invalid/unused.git",
            "defaultBranch": "main",
            "cmdProject": slug,
            "domain": f"{slug}.example.invalid",
            "locale": "en-GB",
            "indexable": indexable,
            "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
        }
    )


def _wixy_repo_root(tmp_path: Path, *, indexable: bool) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        _project_json("test", indexable=indexable), encoding="utf-8"
    )
    return root


def _publish_build_with_image(paths: ProjectPaths, sha: str, version: int) -> Path:
    build_dir = paths.build_dir(sha)
    (build_dir / "images").mkdir(parents=True)
    (build_dir / "images" / "photo.jpg").write_bytes(b"not a real jpeg, just some bytes")
    (build_dir / "index.html").write_text("<html><body>Home</body></html>", encoding="utf-8")
    (build_dir / "404.html").write_text("<html><body>Not found</body></html>", encoding="utf-8")
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.live_json.write_text(
        json.dumps({"sha": sha, "version": version, "buildDir": f"builds/{sha}"}),
        encoding="utf-8",
    )
    return build_dir


class TestShouldTagNoindex:
    """Pure-function coverage of the path allowlist itself — exhaustive, no app/HTTP
    machinery needed (same testability pattern `routes_public._resolve_within_build_dir`
    and `auth.is_admin_path` already use in this codebase)."""

    @pytest.mark.parametrize(
        "path",
        ["/images/photo.jpg", "/images/gallery/a.png", "/api/version", "/api/version/notes"],
    )
    def test_public_non_html_paths_match(self, path: str) -> None:
        assert _should_tag_noindex(path) is True

    @pytest.mark.parametrize(
        "path",
        [
            "/",
            "/about.html",
            "/about",
            "/site.css",
            "/admin",
            "/admin/pages",
            "/api/admin/state",
            "/api/admin/media",
            "/internal/ready",
            "/internal/warmup",
            "/healthz",
            "/api/version/",  # trailing slash: exact-match only, never prefix
            "/images",  # no trailing slash: not inside the images/ tree
            "/api/versions",  # must not prefix-match past the exact JSON paths
            "/api/versionish",  # a sibling name that merely starts the same way
            "/api/version/notes/extra",  # nothing past the two literal paths matches
            "/api/version-old",  # another near-miss the allowlist must reject
        ],
    )
    def test_everything_else_does_not_match(self, path: str) -> None:
        assert _should_tag_noindex(path) is False

    def test_query_string_never_reaches_the_classifier(self) -> None:
        """`request.url.path` never includes the query string (it's a separate
        `request.url.query` attribute in Starlette) — this just documents that a
        query string can't perturb the allowlist match either way."""
        assert _should_tag_noindex("/api/version") is True
        assert _should_tag_noindex("/images/photo.jpg") is True


class TestNonIndexableProject:
    """`indexable: false` (staging's own config, decisions/00135) — the header must
    appear on exactly the non-HTML public surface an HTML `noindex` meta can't reach."""

    def test_media_gets_noindex_header(self, tmp_path: Path) -> None:
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=False)
        paths = project_paths(storage_root, "test")
        _publish_build_with_image(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/images/photo.jpg")
        assert response.status_code == 200
        assert response.headers["x-robots-tag"] == "noindex"

    def test_api_version_gets_noindex_header(self, tmp_path: Path) -> None:
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=False)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version")
        assert response.status_code == 200
        assert response.headers["x-robots-tag"] == "noindex"

    def test_api_version_notes_gets_noindex_header(self, tmp_path: Path) -> None:
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=False)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version/notes")
        assert response.status_code == 200
        assert response.headers["x-robots-tag"] == "noindex"

    def test_html_page_does_not_get_the_header(self, tmp_path: Path) -> None:
        """HTML pages already carry their own per-page `noindex` meta (WP1,
        decisions/00135) — this header is deliberately not duplicated onto them."""
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=False)
        paths = project_paths(storage_root, "test")
        _publish_build_with_image(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/")
        assert response.status_code == 200
        assert "x-robots-tag" not in response.headers

    def test_admin_shell_does_not_get_the_header(self, tmp_path: Path) -> None:
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=False)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/admin")
        assert response.status_code == 200
        assert "x-robots-tag" not in response.headers

    def test_healthz_does_not_get_the_header(self, tmp_path: Path) -> None:
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=False)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/healthz")
        assert response.status_code == 200
        assert "x-robots-tag" not in response.headers

    def test_missing_image_still_gets_the_header_on_its_404(self, tmp_path: Path) -> None:
        """Deliberate, documented choice (`build_robots_header_middleware`'s own
        docstring): classification is by request PATH alone, never by the response's
        actual status/content-type. A 404 for a path inside `/images/` is still a URL
        nothing should index, so tagging it here is correct, not an oversight."""
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=False)
        paths = project_paths(storage_root, "test")
        _publish_build_with_image(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/images/does-not-exist.jpg")
        assert response.status_code == 404
        assert response.headers["x-robots-tag"] == "noindex"

    def test_media_query_string_does_not_affect_the_header(self, tmp_path: Path) -> None:
        """A `?v=<fingerprint>` cache-busting query string (decisions/00130) must not
        perturb classification — `request.url.path` never includes it."""
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=False)
        paths = project_paths(storage_root, "test")
        _publish_build_with_image(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/images/photo.jpg?v=abc123")
        assert response.status_code == 200
        assert response.headers["x-robots-tag"] == "noindex"


class TestIndexableProject:
    """`indexable: true` (the public `cottageaesthetics.co.uk` build) must be
    completely unaffected — no header anywhere, regardless of path."""

    def test_media_does_not_get_the_header(self, tmp_path: Path) -> None:
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=True)
        paths = project_paths(storage_root, "test")
        _publish_build_with_image(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/images/photo.jpg")
        assert response.status_code == 200
        assert "x-robots-tag" not in response.headers

    def test_api_version_does_not_get_the_header(self, tmp_path: Path) -> None:
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=True)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version")
        assert response.status_code == 200
        assert "x-robots-tag" not in response.headers

    def test_api_version_notes_does_not_get_the_header(self, tmp_path: Path) -> None:
        storage_root = tmp_path / "storage"
        wixy_repo_root = _wixy_repo_root(tmp_path, indexable=True)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version/notes")
        assert response.status_code == 200
        assert "x-robots-tag" not in response.headers
