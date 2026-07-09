"""`/api/admin/state|content|draft|media` tests (spec/04 §8's M6 subset + milestone
8's media upload/delete, spec/02 §9)."""

from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from wixy_server.app import create_app
from wixy_server.publisher import PublishJob
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
_INDEX_HTML_WITH_IMAGE = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<h1 data-wx="hero.title">placeholder</h1>
<div data-wx-bg="hero.bg" style="">bg</div>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""


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


def _write_theme(repo_dir: Path) -> None:
    (repo_dir / "theme").mkdir(parents=True)
    (repo_dir / "theme" / "theme.json").write_text(
        json.dumps(
            {
                "colors": {"cream": "#F1E8D9", "coffee": "#3E312A"},
                "shadow": "0 18px 44px rgba(62,49,42,.14)",
                "fonts": {
                    "serif": {
                        "family": "Cormorant Garamond",
                        "weights": ["400", "600"],
                        "italics": True,
                    },
                    "sans": {"family": "Jost", "weights": ["300", "400"], "italics": False},
                },
            }
        ),
        encoding="utf-8",
    )


def _write_project_registry(root: Path, repo: Path) -> None:
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "Test",
                "repo": str(repo),
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
    _write_project_registry(root, origin_repo)
    return root


@pytest.fixture
def origin_repo_with_theme(tmp_path: Path) -> Path:
    origin = tmp_path / "origin-themed"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    _write_site_repo(origin)
    _write_theme(origin)
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


@pytest.fixture
def wixy_repo_root_themed(tmp_path: Path, origin_repo_with_theme: Path) -> Path:
    root = tmp_path / "wixy-repo-themed"
    _write_project_registry(root, origin_repo_with_theme)
    return root


@pytest.fixture
def bare_origin_repo(tmp_path: Path) -> Path:
    """A genuine bare repo (spec/08 §1), unlike `origin_repo` above — the publish
    tests below actually PUSH into this origin, and a normal (non-bare) repo
    refuses a push into its own currently-checked-out branch."""
    bare_dir = tmp_path / "origin.git"
    bare_dir.mkdir(parents=True)
    _git(["init", "--bare", "--initial-branch=main"], bare_dir)

    seed = tmp_path / "seed"
    _git(["clone", str(bare_dir), str(seed)], tmp_path)
    _git(["config", "user.email", "seed@example.com"], seed)
    _git(["config", "user.name", "Seed"], seed)
    _write_site_repo(seed)
    _git(["add", "."], seed)
    _git(["commit", "-m", "initial"], seed)
    _git(["push", "origin", "main"], seed)
    return bare_dir


@pytest.fixture
def wixy_repo_root_bare(tmp_path: Path, bare_origin_repo: Path) -> Path:
    root = tmp_path / "wixy-repo-bare"
    _write_project_registry(root, bare_origin_repo)
    return root


@pytest.fixture
def wixy_repo_root_with_image_binding(tmp_path: Path) -> Path:
    """A single-page repo with a real `data-wx-bg` binding — the base `origin_repo`
    fixture has no image binding at all, needed for the publish-preview validate
    tests below (a genuinely missing image, and a staged-but-unpublished one)."""
    origin = tmp_path / "origin-img"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "pages").mkdir(parents=True)
    (origin / "partials").mkdir()
    (origin / "content").mkdir()
    (origin / "images").mkdir()
    (origin / "pages" / "index.html").write_text(_INDEX_HTML_WITH_IMAGE, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (origin / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (origin / "content" / "index.json").write_text(
        json.dumps(
            {
                "meta": {"title": "Home", "navLabel": "Home", "inNav": True, "navOrder": 10},
                "hero": {
                    "title": "Original Title",
                    "bg": {"src": "images/hero.jpg", "alt": "hero"},
                },
            }
        ),
        encoding="utf-8",
    )
    (origin / "content" / "_global.json").write_text("{}", encoding="utf-8")
    (origin / "images" / "hero.jpg").write_bytes(b"fake-jpeg-bytes")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)

    root = tmp_path / "wixy-repo-img"
    _write_project_registry(root, origin)
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


class TestGetTheme:
    def test_returns_the_merged_theme(
        self, storage_root: Path, wixy_repo_root_themed: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_themed)
        with TestClient(app) as client:
            response = client.get("/api/admin/theme")
        assert response.status_code == 200
        theme = response.json()["theme"]
        assert theme["colors"]["cream"] == "#F1E8D9"
        assert theme["shadow"].startswith("0 18px")
        assert theme["fonts"]["serif"]["family"] == "Cormorant Garamond"
        assert theme["fonts"]["serif"]["italics"] is True
        assert theme["fonts"]["sans"]["weights"] == ["300", "400"]

    def test_theme_reflects_a_drafted_overlay_op(
        self, storage_root: Path, wixy_repo_root_themed: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_themed)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "theme", "path": "colors.cream", "value": "#FFFFFF"}],
                },
            )
            response = client.get("/api/admin/theme")
        assert response.json()["theme"]["colors"]["cream"] == "#FFFFFF"
        # An untouched key survives the merge unchanged.
        assert response.json()["theme"]["colors"]["coffee"] == "#3E312A"

    def test_a_discarded_op_reverts_to_the_checkout_value(
        self, storage_root: Path, wixy_repo_root_themed: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_themed)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "theme", "path": "colors.cream", "value": "#FFFFFF"}],
                },
            )
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 1,
                    "ops": [{"file": "theme", "path": "colors.cream", "discard": True}],
                },
            )
            response = client.get("/api/admin/theme")
        assert response.json()["theme"]["colors"]["cream"] == "#F1E8D9"

    def test_missing_theme_is_404(self, storage_root: Path, wixy_repo_root: Path) -> None:
        # `wixy_repo_root` (unlike `wixy_repo_root_themed`) points at a repo with no
        # `theme/theme.json` — the pre-migration-step-4 state (decisions/00004).
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/theme")
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


def _find_media(items: list[dict[str, object]], name: str) -> dict[str, object]:
    for item in items:
        if item["name"] == name:
            return item
    raise AssertionError(f"no media item named {name!r} in {items!r}")


class TestGetMedia:
    def test_lists_repo_images(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/media")
        assert response.status_code == 200
        item = _find_media(response.json()["media"], "hero.jpg")
        assert item["url"] == "/images/hero.jpg"
        assert item["source"] == "repo"
        assert item["sizeBytes"] == len(b"fake-jpeg-bytes")
        assert item["width"] is None  # the fixture's own bytes aren't a real image
        assert item["references"] == []

    def test_lists_staged_draft_media_too(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        paths.draft_media.mkdir(parents=True)
        (paths.draft_media / "abc12345-new.jpg").write_bytes(b"staged")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/media")
        item = _find_media(response.json()["media"], "abc12345-new.jpg")
        assert item["url"] == "/admin/draft-media/abc12345-new.jpg"
        assert item["source"] == "draft"

    def test_reports_real_dimensions_for_a_real_image(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        paths.draft_media.mkdir(parents=True)
        buf = io.BytesIO()
        Image.new("RGB", (40, 30), "red").save(buf, format="JPEG")
        (paths.draft_media / "real.jpg").write_bytes(buf.getvalue())
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/media")
        item = _find_media(response.json()["media"], "real.jpg")
        assert (item["width"], item["height"]) == (40, 30)

    def test_reports_references_for_an_image_used_by_content(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [
                        {
                            "file": "index",
                            "path": "hero.bg",
                            "value": {"src": "images/hero.jpg", "alt": "Hero"},
                        }
                    ],
                },
            )
            response = client.get("/api/admin/media")
        item = _find_media(response.json()["media"], "hero.jpg")
        assert item["references"] == ["index:hero"]


class TestUploadMedia:
    def _jpeg_bytes(self, size: tuple[int, int] = (500, 300)) -> bytes:
        buf = io.BytesIO()
        Image.new("RGB", size, "blue").save(buf, format="JPEG")
        return buf.getvalue()

    def test_uploads_and_stages_a_processed_image(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/media",
                files={"file": ("My Photo.jpg", self._jpeg_bytes(), "image/jpeg")},
            )
        assert response.status_code == 200
        body = response.json()
        assert body["source"] == "draft"
        assert body["name"].endswith("-my-photo.jpg")
        assert body["url"] == f"/admin/draft-media/{body['name']}"
        assert (paths.draft_media / body["name"]).is_file()

    def test_the_returned_url_is_actually_servable(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        # A real gap found by driving a real browser through the upload/replace
        # flow (decisions/00022): `body["url"]` was constructed and pointed at a
        # real file on disk, but NOTHING served `/admin/draft-media/{name}` at
        # all — this asserts the round trip, not just the URL string + on-disk
        # file existing separately (which `test_uploads_and_stages_a_processed_
        # image` above already covered and would NOT have caught this).
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            upload_response = client.post(
                "/api/admin/media",
                files={"file": ("photo.jpg", self._jpeg_bytes(), "image/jpeg")},
            )
            url = upload_response.json()["url"]
            asset_response = client.get(url)
        assert asset_response.status_code == 200
        # A real, decodable JPEG of the uploaded size — not just "some bytes came
        # back" — proves the served content is the actual processed upload.
        served_image = Image.open(io.BytesIO(asset_response.content))
        assert served_image.format == "JPEG"
        assert served_image.size == (500, 300)

    def test_resizes_to_the_project_configured_limit(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        # the wixy_repo_root fixture's projects/test.json sets maxLongSidePx=2000;
        # upload something bigger.
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/media",
                files={"file": ("big.jpg", self._jpeg_bytes((3000, 1500)), "image/jpeg")},
            )
        body = response.json()
        assert max(body["width"], body["height"]) == 2000

    def test_rejects_an_svg_upload(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/media",
                files={"file": ("icon.svg", b"<svg></svg>", "image/svg+xml")},
            )
        assert response.status_code == 422

    def test_rejects_an_oversized_upload(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/media",
                files={
                    "file": ("big.jpg", b"x" * (15 * 1024 * 1024 + 1), "image/jpeg"),
                },
            )
        assert response.status_code == 422

    def test_uploaded_media_then_appears_in_the_list(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            upload_response = client.post(
                "/api/admin/media",
                files={"file": ("new.jpg", self._jpeg_bytes(), "image/jpeg")},
            )
            list_response = client.get("/api/admin/media")
        name = upload_response.json()["name"]
        assert any(item["name"] == name for item in list_response.json()["media"])


class TestDeleteMedia:
    def test_deletes_an_unreferenced_staged_upload(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        paths.draft_media.mkdir(parents=True)
        (paths.draft_media / "unused.jpg").write_bytes(b"staged")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.delete("/api/admin/media/unused.jpg")
        assert response.status_code == 200
        assert response.json() == {"deleted": True}
        assert not (paths.draft_media / "unused.jpg").exists()

    def test_404s_for_an_unknown_name(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.delete("/api/admin/media/does-not-exist.jpg")
        assert response.status_code == 404

    def test_404s_for_a_repo_image_deletion_is_out_of_scope_this_milestone(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        # decisions/00015 decision 3's exact reasoning applied to media: deleting
        # an already-PUBLISHED repo image needs milestone 9's publish-time
        # materialization contract, which doesn't exist yet — this route only
        # ever looks in draft_media/, so a repo filename naturally 404s.
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.delete("/api/admin/media/hero.jpg")
        assert response.status_code == 404

    def test_409s_for_a_referenced_staged_upload(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        paths.draft_media.mkdir(parents=True)
        (paths.draft_media / "used.jpg").write_bytes(b"staged")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [
                        {
                            "file": "index",
                            "path": "hero.bg",
                            "value": {"src": "/admin/draft-media/used.jpg", "alt": ""},
                        }
                    ],
                },
            )
            response = client.delete("/api/admin/media/used.jpg")
        assert response.status_code == 409
        assert (paths.draft_media / "used.jpg").exists()

    # A path-traversal segment like ".." never reaches this route at all via a
    # normal HTTP client — httpx (this test file's own TestClient) normalizes it
    # out of the URL before sending, same as a browser would; FastAPI's routing
    # doesn't even match a request that would need it. That's not a green light
    # to drop the server-side guard (media.py's own delete_draft_media) — it's
    # defense-in-depth against a raw/non-normalizing client — but it means this
    # class of input has to be tested directly against that function
    # (test_media.py), not through the HTTP layer, which can't reproduce it.


def _current_rev(client: TestClient) -> int:
    result: int = client.get("/api/admin/state").json()["draft"]["rev"]
    return result


class TestPostPublish:
    def test_publishes_and_returns_the_new_version(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "Published Title"}],
                },
            )
            response = client.post(
                "/api/admin/publish",
                json={"message": "test publish", "expectedRev": _current_rev(client)},
            )
        assert response.status_code == 200
        body = response.json()
        assert body["version"] == 1
        assert isinstance(body["sha"], str) and len(body["sha"]) == 40

    def test_a_stale_expected_rev_is_409_and_does_not_stick_the_job(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            stale_response = client.post(
                "/api/admin/publish",
                json={"message": "test", "expectedRev": 99},
            )
            assert stale_response.status_code == 409
            # A rev-conflict must not leave a permanently-"running" job stuck on
            # app.state (run_publish's own contract: the job never "started" for
            # this case) — a subsequent, correctly-revved publish must still go
            # through rather than 409-locking forever.
            good_response = client.post(
                "/api/admin/publish",
                json={"message": "test", "expectedRev": _current_rev(client)},
            )
        assert good_response.status_code == 200

    def test_a_second_request_while_one_is_running_gets_409(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            app.state.publish_job = PublishJob(id="already-running", stage="building")
            response = client.post(
                "/api/admin/publish",
                json={"message": "test", "expectedRev": 0},
            )
        assert response.status_code == 409
        assert "already-running" in response.json()["detail"]

    def test_a_pipeline_failure_is_502_with_the_error_in_the_body(
        self, storage_root: Path, tmp_path: Path
    ) -> None:
        # A repo path that was never git-inited — `ensure_checkout` fails cleanly
        # with `CheckoutError`, which `run_publish` wraps as `PublishError` (a
        # real, reproducible pipeline failure without a multi-clone race setup).
        broken_repo_root = tmp_path / "wixy-repo-broken"
        _write_project_registry(broken_repo_root, tmp_path / "no-such-origin")
        app = create_app(storage_root=storage_root, wixy_repo_root=broken_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/publish",
                json={"message": "test", "expectedRev": 0},
            )
        assert response.status_code == 502
        assert "detail" in response.json()

    def test_get_state_reflects_the_finished_job(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.post(
                "/api/admin/publish",
                json={"message": "test", "expectedRev": _current_rev(client)},
            )
            state = client.get("/api/admin/state").json()
        assert state["publishJob"]["stage"] == "done"
        assert state["publishJob"]["version"] == 1


class TestPublishStream:
    def test_with_no_job_emits_a_null_stage_event_and_closes(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/publish/stream")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert 'data: {"stage": null}' in response.text

    def test_with_a_finished_job_emits_its_terminal_state(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            app.state.publish_job = PublishJob(
                id="job-1", stage="done", version=3, log=["published as version 3"]
            )
            response = client.get("/api/admin/publish/stream")
        assert response.status_code == 200
        assert '"stage": "done"' in response.text
        assert '"version": 3' in response.text


class TestGetPublishes:
    def test_empty_when_nothing_ever_published(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/publishes")
        assert response.status_code == 200
        assert response.json() == {"publishes": []}

    def test_lists_newest_first_and_marks_the_live_one(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "V1"}],
                },
            )
            client.post(
                "/api/admin/publish",
                json={"message": "first", "expectedRev": _current_rev(client)},
            )
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "V2"}],
                },
            )
            client.post(
                "/api/admin/publish",
                json={"message": "second", "expectedRev": _current_rev(client)},
            )
            response = client.get("/api/admin/publishes")
        body = response.json()["publishes"]
        assert [p["version"] for p in body] == [2, 1]
        assert body[0]["live"] is True
        assert body[1]["live"] is False
        assert body[0]["message"] == "second"

    def test_limit_caps_the_returned_count(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "V1"}],
                },
            )
            client.post(
                "/api/admin/publish",
                json={"message": "first", "expectedRev": _current_rev(client)},
            )
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "V2"}],
                },
            )
            client.post(
                "/api/admin/publish",
                json={"message": "second", "expectedRev": _current_rev(client)},
            )
            response = client.get("/api/admin/publishes?limit=1")
        body = response.json()["publishes"]
        assert len(body) == 1
        assert body[0]["version"] == 2


class TestGetPublishPreview:
    def test_a_text_op_is_diffed_with_old_and_new_values(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "New Title"}],
                },
            )
            response = client.get("/api/admin/publish/preview")
        assert response.status_code == 200
        body = response.json()
        entries = body["changes"]["index"]
        assert entries == [
            {"key": "hero.title", "kind": "text", "old": "Original Title", "new": "New Title"}
        ]
        assert body["validate"] == {"ok": True, "errors": []}

    def test_a_theme_op_is_diffed_with_kind_theme(
        self, storage_root: Path, wixy_repo_root_themed: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_themed)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "theme", "path": "colors.cream", "value": "#FFFFFF"}],
                },
            )
            response = client.get("/api/admin/publish/preview")
        body = response.json()
        assert body["changes"]["theme"] == [
            {"key": "colors.cream", "kind": "theme", "old": "#F1E8D9", "new": "#FFFFFF"}
        ]

    def test_no_draft_ops_is_an_empty_diff(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/publish/preview")
        assert response.status_code == 200
        assert response.json() == {"changes": {}, "validate": {"ok": True, "errors": []}}

    def test_a_genuinely_missing_image_is_a_validate_error(
        self, storage_root: Path, wixy_repo_root_with_image_binding: Path
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root_with_image_binding
        )
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [
                        {
                            "file": "index",
                            "path": "hero.bg",
                            "value": {"src": "images/does-not-exist.jpg", "alt": "x"},
                        }
                    ],
                },
            )
            response = client.get("/api/admin/publish/preview")
        body = response.json()
        assert body["validate"]["ok"] is False
        assert any(e["code"] == "missing-image" for e in body["validate"]["errors"])

    def test_a_staged_unpublished_image_is_not_a_false_positive_validate_error(
        self,
        storage_root: Path,
        wixy_repo_root_with_image_binding: Path,
        paths: ProjectPaths,
    ) -> None:
        # The exact gap `_staged_image_keys` exists to close (decisions/00025):
        # a draft upload that's staged but not yet published/copied into
        # `images/` must NOT trip `validate_site`'s image-existence check just
        # because it isn't sitting in `paths.repo/images/` yet.
        paths.draft_media.mkdir(parents=True)
        (paths.draft_media / "abc12345-new.jpg").write_bytes(b"staged")
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root_with_image_binding
        )
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [
                        {
                            "file": "index",
                            "path": "hero.bg",
                            "value": {"src": "/admin/draft-media/abc12345-new.jpg", "alt": "New"},
                        }
                    ],
                },
            )
            response = client.get("/api/admin/publish/preview")
        body = response.json()
        assert body["validate"] == {"ok": True, "errors": []}
        entry = body["changes"]["index"][0]
        assert entry["kind"] == "bg"


class TestPostRestore:
    def test_restores_and_returns_the_new_version(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "V1"}],
                },
            )
            client.post(
                "/api/admin/publish", json={"message": "first", "expectedRev": _current_rev(client)}
            )
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "V2"}],
                },
            )
            client.post(
                "/api/admin/publish",
                json={"message": "second", "expectedRev": _current_rev(client)},
            )
            response = client.post("/api/admin/restore", json={"version": 1})
        assert response.status_code == 200
        body = response.json()
        assert body["version"] == 3
        assert body["of"] == 1

    def test_the_draft_reflects_the_restored_content_afterward(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "V1"}],
                },
            )
            client.post(
                "/api/admin/publish", json={"message": "first", "expectedRev": _current_rev(client)}
            )
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "V2"}],
                },
            )
            client.post(
                "/api/admin/publish",
                json={"message": "second", "expectedRev": _current_rev(client)},
            )
            client.post("/api/admin/restore", json={"version": 1})
            content = client.get("/api/admin/content/index").json()["content"]
        assert content["hero"]["title"] == "V1"

    def test_unknown_version_is_422(self, storage_root: Path, wixy_repo_root_bare: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            response = client.post("/api/admin/restore", json={"version": 99})
        assert response.status_code == 422

    def test_409s_while_a_publish_is_running(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.post(
                "/api/admin/publish", json={"message": "first", "expectedRev": _current_rev(client)}
            )
            app.state.publish_job = PublishJob(id="already-running", stage="building")
            response = client.post("/api/admin/restore", json={"version": 1})
        assert response.status_code == 409


class TestGetVersionAsset:
    def test_serves_an_archived_page_faithfully(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "Archived Title"}],
                },
            )
            client.post(
                "/api/admin/publish", json={"message": "first", "expectedRev": _current_rev(client)}
            )
            response = client.get("/admin/versions/1/index.html")
        assert response.status_code == 200
        assert "Archived Title" in response.text

    def test_404s_for_an_unknown_version(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            response = client.get("/admin/versions/99/index.html")
        assert response.status_code == 404

    def test_404s_for_an_unknown_page_within_a_real_version(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.post(
                "/api/admin/publish", json={"message": "first", "expectedRev": _current_rev(client)}
            )
            response = client.get("/admin/versions/1/does-not-exist.html")
        assert response.status_code == 404

    def test_a_version_still_present_on_disk_is_served_without_rebuilding(
        self, storage_root: Path, wixy_repo_root_bare: Path, paths: ProjectPaths
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.post(
                "/api/admin/publish", json={"message": "first", "expectedRev": _current_rev(client)}
            )
            response = client.get("/admin/versions/1/index.html")
        assert response.status_code == 200
        assert "Original Title" in response.text
