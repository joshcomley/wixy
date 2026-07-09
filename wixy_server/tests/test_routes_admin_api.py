"""`/api/admin/state|content|draft|media(list)` tests (spec/04 §8, M6's subset only)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.storage import ProjectPaths, project_paths

_INDEX_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<h1 data-wx="hero.title">placeholder</h1>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""
_ABOUT_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<p data-wx="intro.body">placeholder</p>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""
_PARTIAL_HTML = "<body></body>\n"


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _write_site_repo(repo_dir: Path) -> None:
    (repo_dir / "pages").mkdir(parents=True)
    (repo_dir / "partials").mkdir()
    (repo_dir / "content").mkdir()
    (repo_dir / "images").mkdir()
    (repo_dir / "pages" / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    (repo_dir / "pages" / "about.html").write_text(_ABOUT_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (repo_dir / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (repo_dir / "content" / "index.json").write_text(
        json.dumps(
            {
                "meta": {"title": "Home", "navLabel": "Home", "inNav": True, "navOrder": 10},
                "hero": {"title": "Original Title"},
            }
        ),
        encoding="utf-8",
    )
    (repo_dir / "content" / "about.json").write_text(
        json.dumps(
            {
                "meta": {"title": "About", "navLabel": "About", "inNav": True, "navOrder": 20},
                "intro": {"body": "About us"},
            }
        ),
        encoding="utf-8",
    )
    (repo_dir / "content" / "_global.json").write_text("{}", encoding="utf-8")
    (repo_dir / "images" / "hero.jpg").write_bytes(b"fake-jpeg-bytes")


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    _write_site_repo(origin)
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


@pytest.fixture
def wixy_repo_root(tmp_path: Path, origin_repo: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "Test",
                "repo": str(origin_repo),
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


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture
def paths(storage_root: Path) -> ProjectPaths:
    return project_paths(storage_root, "test")


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


class TestGetState:
    def test_shape_with_no_draft_and_no_publish(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/state")
        assert response.status_code == 200
        body = response.json()
        assert body["project"] == {
            "slug": "test",
            "name": "Test",
            "domain": "test.example.invalid",
        }
        slugs = {p["slug"] for p in body["pages"]}
        assert slugs == {"index", "about"}
        assert body["draft"] == {"rev": 0, "opCount": 0}
        assert body["live"] is None
        assert body["upstream"]["aheadOfPublished"] == []
        assert body["publishJob"] is None
        assert body["chats"] == []

    def test_pages_meta_reflects_content(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/state")
        by_slug = {p["slug"]: p["meta"] for p in response.json()["pages"]}
        assert by_slug["index"]["title"] == "Home"
        assert by_slug["about"]["navOrder"] == 20

    def test_pages_last_modified_is_null_with_no_draft_edits(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/state")
        by_slug = {p["slug"]: p["lastModified"] for p in response.json()["pages"]}
        assert by_slug == {"index": None, "about": None}

    def test_pages_last_modified_reflects_a_drafted_op_only_for_that_page(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "New"}],
                },
            )
            response = client.get("/api/admin/state")
        by_slug = {p["slug"]: p["lastModified"] for p in response.json()["pages"]}
        assert by_slug["index"] is not None
        assert by_slug["about"] is None

    def test_pages_last_modified_is_the_newest_op_for_that_page(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "First"}],
                },
            )
            first_state = client.get("/api/admin/state").json()
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 1,
                    "ops": [{"file": "index", "path": "hero.title", "value": "Second"}],
                },
            )
            second_state = client.get("/api/admin/state").json()
        first_ts = {p["slug"]: p["lastModified"] for p in first_state["pages"]}["index"]
        second_ts = {p["slug"]: p["lastModified"] for p in second_state["pages"]}["index"]
        assert first_ts is not None and second_ts is not None
        assert second_ts >= first_ts

    def test_draft_op_count_reflects_a_patched_overlay(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            patch_response = client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "New"}],
                },
            )
            assert patch_response.status_code == 200
            state_response = client.get("/api/admin/state")
        assert state_response.json()["draft"] == {"rev": 1, "opCount": 1}


class TestGetContent:
    def test_returns_merged_content_and_bindings(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/content/index")
        assert response.status_code == 200
        body = response.json()
        assert body["content"]["hero"]["title"] == "Original Title"
        field_keys = {(f["key"], f["kind"]) for f in body["bindings"]["fields"]}
        assert ("hero.title", "text") in field_keys

    def test_content_reflects_a_drafted_overlay_op(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "Drafted"}],
                },
            )
            response = client.get("/api/admin/content/index")
        assert response.json()["content"]["hero"]["title"] == "Drafted"

    def test_unknown_page_is_404(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/content/does-not-exist")
        assert response.status_code == 404


class TestPatchDraft:
    def test_applies_a_set_op_and_returns_new_rev(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "New Title"}],
                },
            )
        assert response.status_code == 200
        assert response.json() == {"rev": 1}

    def test_stale_rev_returns_409(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "First"}],
                },
            )
            stale_response = client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,  # stale — the overlay is now at rev 1
                    "ops": [{"file": "index", "path": "hero.title", "value": "Second"}],
                },
            )
        assert stale_response.status_code == 409

    def test_discard_op_removes_a_previously_set_key(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "Drafted"}],
                },
            )
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 1,
                    "ops": [{"file": "index", "path": "hero.title", "discard": True}],
                },
            )
            content_response = client.get("/api/admin/content/index")
        # the discard reverts to the repo's own (upstream) value
        assert content_response.json()["content"]["hero"]["title"] == "Original Title"

    def test_op_is_persisted_across_requests(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "Persisted"}],
                },
            )
        # a fresh app + fresh client against the SAME storage_root — proves the
        # overlay was actually written to disk, not just held in memory.
        app2 = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app2) as client2:
            response = client2.get("/api/admin/content/index")
        assert response.json()["content"]["hero"]["title"] == "Persisted"


class TestDeleteDraft:
    def test_discards_all_ops_and_bumps_rev(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "Drafted"}],
                },
            )
            delete_response = client.delete("/api/admin/draft")
            content_response = client.get("/api/admin/content/index")
        assert delete_response.status_code == 200
        assert delete_response.json() == {"rev": 2}
        assert content_response.json()["content"]["hero"]["title"] == "Original Title"

    def test_clears_staged_media(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        paths.draft_media.mkdir(parents=True)
        (paths.draft_media / "staged.jpg").write_bytes(b"staged")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.delete("/api/admin/draft")
        assert response.status_code == 200
        assert not (paths.draft_media / "staged.jpg").exists()


class TestGetMedia:
    def test_lists_repo_images(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/media")
        assert response.status_code == 200
        items = response.json()["media"]
        assert {"name": "hero.jpg", "url": "/images/hero.jpg", "source": "repo"} in items

    def test_lists_staged_draft_media_too(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        paths.draft_media.mkdir(parents=True)
        (paths.draft_media / "abc12345-new.jpg").write_bytes(b"staged")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/media")
        items = response.json()["media"]
        assert {
            "name": "abc12345-new.jpg",
            "url": "/admin/draft-media/abc12345-new.jpg",
            "source": "draft",
        } in items
