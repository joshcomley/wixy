"""Public serving tests (spec/04 §3) — a real build dir on disk + a real `live.json`,
via `TestClient` against a full app (never the production Storage default)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.routes_public import _resolve_within_build_dir
from wixy_server.storage import ProjectPaths, project_paths


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


def _project_json(slug: str) -> str:
    return json.dumps(
        {
            "slug": slug,
            "name": slug,
            "repo": "https://example.invalid/unused.git",
            "defaultBranch": "main",
            "cmdProject": slug,
            "domain": f"{slug}.example.invalid",
            "locale": "en-GB",
            "indexable": False,
            "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
        }
    )


@pytest.fixture
def wixy_repo_root(tmp_path: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(_project_json("test"), encoding="utf-8")
    return root


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture
def paths(storage_root: Path) -> ProjectPaths:
    return project_paths(storage_root, "test")


def _publish_build(paths: ProjectPaths, sha: str, version: int) -> Path:
    """Write a build dir + `live.json` directly, bypassing the (not-yet-built,
    milestone 9) publisher — exactly what public serving needs to have something to
    read."""
    build_dir = paths.build_dir(sha)
    build_dir.mkdir(parents=True)
    (build_dir / "index.html").write_text("<html><body>Home</body></html>", encoding="utf-8")
    (build_dir / "about.html").write_text("<html><body>About</body></html>", encoding="utf-8")
    (build_dir / "site.css").write_text("body{color:red}", encoding="utf-8")
    (build_dir / "404.html").write_text("<html><body>Not found</body></html>", encoding="utf-8")
    secret_dir = build_dir.parent.parent  # paths.root — outside the build dir entirely
    (secret_dir / "secret.txt").write_text("do not serve this", encoding="utf-8")
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.live_json.write_text(
        json.dumps({"sha": sha, "version": version, "buildDir": f"builds/{sha}"}),
        encoding="utf-8",
    )
    return build_dir


class TestNoLivePointerYet:
    def test_root_returns_503(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/")
        assert response.status_code == 503

    def test_any_path_returns_503(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/about.html")
        assert response.status_code == 503


class TestPublishedSite:
    def test_root_serves_index(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        _publish_build(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/")
        assert response.status_code == 200
        assert "Home" in response.text
        assert response.headers["cache-control"] == "public, max-age=300"

    def test_named_page_served(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        _publish_build(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/about.html")
        assert response.status_code == 200
        assert "About" in response.text

    def test_asset_gets_long_cache_control(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        _publish_build(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/site.css")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "public, max-age=86400"

    def test_unknown_path_serves_404_page_with_404_status(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        _publish_build(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/does-not-exist.html")
        assert response.status_code == 404
        assert "Not found" in response.text

    def test_path_traversal_via_http_never_serves_the_escaped_file(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        """Best-effort HTTP-level check — httpx/browsers often normalize a literal
        `..` client-side before the request is even sent, so the authoritative test of
        the guard itself is `TestResolveWithinBuildDir` below (direct, unaffected by
        client-side URL normalization)."""
        _publish_build(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/../secret.txt")
        assert "do not serve this" not in response.text

    def test_head_request_succeeds(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        _publish_build(paths, "a" * 40, 1)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.head("/")
        assert response.status_code == 200


class TestResolveWithinBuildDir:
    """Direct tests of the path-traversal guard itself — not subject to any HTTP
    client's own URL normalization, unlike a request made through `TestClient`."""

    def test_resolves_a_real_file(self, tmp_path: Path) -> None:
        build_dir = tmp_path / "build"
        build_dir.mkdir()
        (build_dir / "about.html").write_text("hi", encoding="utf-8")
        assert _resolve_within_build_dir(build_dir, "/about.html") == build_dir / "about.html"

    def test_empty_path_resolves_to_index(self, tmp_path: Path) -> None:
        build_dir = tmp_path / "build"
        build_dir.mkdir()
        (build_dir / "index.html").write_text("hi", encoding="utf-8")
        assert _resolve_within_build_dir(build_dir, "/") == build_dir / "index.html"

    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        build_dir = tmp_path / "build"
        build_dir.mkdir()
        assert _resolve_within_build_dir(build_dir, "/nope.html") is None

    def test_dotdot_escape_is_rejected(self, tmp_path: Path) -> None:
        build_dir = tmp_path / "build"
        build_dir.mkdir()
        (tmp_path / "secret.txt").write_text("do not serve this", encoding="utf-8")
        assert _resolve_within_build_dir(build_dir, "/../secret.txt") is None

    def test_deeper_dotdot_escape_is_rejected(self, tmp_path: Path) -> None:
        build_dir = tmp_path / "nested" / "build"
        build_dir.mkdir(parents=True)
        (tmp_path / "secret.txt").write_text("do not serve this", encoding="utf-8")
        assert _resolve_within_build_dir(build_dir, "/../../secret.txt") is None

    def test_encoded_looking_but_literal_dotdot_segment_is_rejected(self, tmp_path: Path) -> None:
        """A path with a `..` segment buried after real-looking directory names."""
        build_dir = tmp_path / "build"
        (build_dir / "images").mkdir(parents=True)
        (tmp_path / "secret.txt").write_text("do not serve this", encoding="utf-8")
        assert _resolve_within_build_dir(build_dir, "/images/../../secret.txt") is None
