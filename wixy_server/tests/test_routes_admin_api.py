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
def wixy_repo_root_with_global_list(tmp_path: Path) -> Path:
    """A repo whose INDEX page (only) binds a GLOBAL list
    (`data-wx-list="@hours"`, the CA site's opening-hours shape — bound there
    and on contact, deliberately NOT on about, so the preview's `_global` kind
    bucket must union across pages rather than copy the first). Two
    reconciliations under test: the bindings map keys it `@hours` (the `@`
    global-scope marker) while draft ops address it as `_global:hours`, and the
    first-alphabetical page (about) doesn't bind it at all. Either miss reports
    kind "text" and the admin UI renders the whole array as raw JSON (operator
    report, 2026-07-21)."""
    origin = tmp_path / "origin-globallist"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    _write_site_repo(origin)
    (origin / "pages" / "index.html").write_text(
        """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<h1 data-wx="hero.title">placeholder</h1>
<ul data-wx-list="@hours">
  <li data-wx-list-item><span data-wx=".day">d</span><span data-wx=".value">v</span></li>
</ul>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
""",
        encoding="utf-8",
    )
    (origin / "content" / "_global.json").write_text(
        json.dumps({"hours": [{"day": "Monday", "value": "10:00 – 19:00", "closed": False}]}),
        encoding="utf-8",
    )
    _git(["add", "."], origin)
    _git(["commit", "-m", "add global hours list binding"], origin)
    root = tmp_path / "wixy-repo-globallist"
    _write_project_registry(root, origin)
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
    def test_shape_with_no_draft_and_auto_bootstrapped_live(
        self, storage_root: Path, wixy_repo_root: Path, origin_repo: Path
    ) -> None:
        """A fresh app with a real, buildable site repo self-bootstraps to a real
        "version 0" live pointer at startup (spec/07 §1) — there's no reachable
        production state where pages are known but `live` stays null forever (the
        bootstrap runs synchronously in the app's own lifespan, before any request
        can be served), so this asserts the bootstrapped shape rather than a null
        one."""
        head_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=origin_repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
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
        assert body["live"] == {"version": 0, "sha": head_sha}
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


_HOURS_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<ul data-wx-list="@hours">
  <li data-wx-list-item><span data-wx=".day">Day</span><span data-wx=".value">Value</span></li>
</ul>
<a data-wx-href="@phoneHref">call</a>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""

_CARDS_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<div data-wx-list="treatments.cards">
  <div data-wx-list-item><h3 data-wx=".title">T</h3><img data-wx-img=".img" src="" alt=""></div>
</div>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""


@pytest.fixture
def origin_repo_bindings(tmp_path: Path) -> Path:
    """The base fixture site PLUS an @hours global list + @phoneHref global href
    (contact.html) and a nested treatments.cards list with an img leaf
    (treatments.html) — the shapes the kind-aware draft-write sanitize resolves."""
    origin = tmp_path / "origin-bindings"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    _write_site_repo(origin)
    (origin / "pages" / "contact.html").write_text(_HOURS_HTML, encoding="utf-8")
    (origin / "pages" / "treatments.html").write_text(_CARDS_HTML, encoding="utf-8")
    (origin / "content" / "contact.json").write_text(
        json.dumps(
            {"meta": {"title": "Contact", "navLabel": "Contact", "inNav": True, "navOrder": 30}}
        ),
        encoding="utf-8",
    )
    (origin / "content" / "treatments.json").write_text(
        json.dumps(
            {
                "meta": {
                    "title": "Treatments",
                    "navLabel": "Treatments",
                    "inNav": True,
                    "navOrder": 40,
                }
            }
        ),
        encoding="utf-8",
    )
    (origin / "content" / "_global.json").write_text(
        json.dumps(
            {"phoneHref": "tel:+441onal", "hours": [{"day": "Monday", "value": "10:00 – 19:00"}]}
        ),
        encoding="utf-8",
    )
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


@pytest.fixture
def wixy_repo_root_bindings(tmp_path: Path, origin_repo_bindings: Path) -> Path:
    root = tmp_path / "wixy-repo-bindings"
    _write_project_registry(root, origin_repo_bindings)
    return root


def _overlay_op_value(paths: ProjectPaths, key: str) -> object:
    data = json.loads(paths.draft_overlay.read_text(encoding="utf-8"))
    return data["ops"][key]["value"]


class TestPatchDraftSanitize:
    """spec/04 §9: draft writes are sanitized — kind-aware, so only text-kind
    string leaves pass through sanitize_rich_lite (decisions/00074)."""

    def test_text_kind_value_is_sanitized_on_write(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
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
                            "path": "hero.title",
                            "value": "New <script>alert(1)</script><strong>bold</strong> & such",
                        }
                    ],
                },
            )
        assert (
            _overlay_op_value(paths, "index:hero.title") == "New <strong>bold</strong> &amp; such"
        )

    def test_href_kind_value_passes_through_unsanitized(
        self, storage_root: Path, wixy_repo_root_bindings: Path, paths: ProjectPaths
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bindings)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [
                        {
                            "file": "_global",
                            "path": "phoneHref",
                            "value": "https://x.test/call?a=1&b=2",
                        }
                    ],
                },
            )
        # an HTML sanitizer would entity-escape the `&` and corrupt the URL
        assert _overlay_op_value(paths, "_global:phoneHref") == "https://x.test/call?a=1&b=2"

    def test_global_list_text_leaves_sanitized_via_cross_page_lookup(
        self, storage_root: Path, wixy_repo_root_bindings: Path, paths: ProjectPaths
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bindings)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [
                        {
                            "file": "_global",
                            "path": "hours",
                            "value": [
                                {"day": "Monday", "value": "10:00 <script>x</script>– 19:00"},
                                {"day": "Tuesday", "value": "11:00 – 16:00"},
                            ],
                        }
                    ],
                },
            )
        assert _overlay_op_value(paths, "_global:hours") == [
            {"day": "Monday", "value": "10:00 – 19:00"},
            {"day": "Tuesday", "value": "11:00 – 16:00"},
        ]

    def test_nested_list_sanitizes_text_but_not_img_leaves(
        self, storage_root: Path, wixy_repo_root_bindings: Path, paths: ProjectPaths
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bindings)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [
                        {
                            "file": "treatments",
                            "path": "treatments.cards",
                            "value": [
                                {
                                    "title": "Botox <em>plus</em> <script>bad</script>",
                                    "img": {"src": "i.jpg?a=1&b=2", "alt": "R&D"},
                                }
                            ],
                        }
                    ],
                },
            )
        assert _overlay_op_value(paths, "treatments:treatments.cards") == [
            {"title": "Botox <em>plus</em> ", "img": {"src": "i.jpg?a=1&b=2", "alt": "R&D"}}
        ]

    def test_unbound_path_passes_through_verbatim(
        self, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "meta.title", "value": "A & <b>B</b>"}],
                },
            )
        assert _overlay_op_value(paths, "index:meta.title") == "A & <b>B</b>"


def _tiny_jpeg() -> bytes:
    img = Image.new("RGB", (8, 8), (30, 60, 90))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


class TestPageThumbnails:
    def test_get_is_404_when_absent(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/pages/index/thumbnail")
        assert response.status_code == 404

    def test_put_then_get_round_trips_a_jpeg(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            put = client.put(
                "/api/admin/pages/index/thumbnail",
                content=_tiny_jpeg(),
                headers={"Content-Type": "image/jpeg"},
            )
            assert put.status_code == 200
            get = client.get("/api/admin/pages/index/thumbnail")
        assert get.status_code == 200
        assert get.headers["content-type"] == "image/jpeg"
        assert get.headers["cache-control"] == "no-cache"
        assert get.content.startswith(bytes([0xFF, 0xD8]))  # JPEG magic

    def test_put_rejects_non_image_bytes(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.put(
                "/api/admin/pages/index/thumbnail",
                content=b"definitely not a jpeg",
                headers={"Content-Type": "image/jpeg"},
            )
        assert response.status_code == 422

    def test_put_rejects_oversize(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.put(
                "/api/admin/pages/index/thumbnail",
                content=bytes([0xFF]) * (2 * 1024 * 1024 + 1),
                headers={"Content-Type": "image/jpeg"},
            )
        assert response.status_code == 422


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
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "Real change"}],
                },
            )
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
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "index", "path": "hero.title", "value": "Real change"}],
                },
            )
            client.post(
                "/api/admin/publish",
                json={"message": "test", "expectedRev": _current_rev(client)},
            )
            state = client.get("/api/admin/state").json()
        assert state["publishJob"]["stage"] == "done"
        assert state["publishJob"]["version"] == 1

    def test_an_empty_draft_with_nothing_upstream_is_a_422_not_a_noop_version(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        """decisions/00071 — publishing with no staged changes AND no upstream
        commits to merge records a version that changes nothing (the live SHA
        stays the same), which read as a broken/mysterious history entry. The
        route refuses it instead; the review drawer disables Publish in the
        same situation."""
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/publish",
                json={"message": "test", "expectedRev": _current_rev(client)},
            )
            ledger = client.get("/api/admin/publishes").json()["publishes"]
        assert response.status_code == 422
        assert "nothing to publish" in response.json()["detail"]
        # No no-op version was recorded: still just the bootstrap entry.
        assert [p["version"] for p in ledger] == [0]

    def test_an_empty_draft_with_upstream_commits_pending_publishes(
        self, storage_root: Path, wixy_repo_root_bare: Path, tmp_path: Path
    ) -> None:
        """The flip side of the 422 guard (decisions/00071): an empty draft is
        exactly right when upstream (AI-lane) commits are waiting to merge —
        that publish is the designed 'upstream riding through' case and must
        NOT be refused."""
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            # An upstream commit lands at origin after the app's bootstrap.
            work = tmp_path / "upstream-work"
            _git(["clone", str(tmp_path / "origin.git"), str(work)], tmp_path)
            _git(["config", "user.email", "ai@example.com"], work)
            _git(["config", "user.name", "AI"], work)
            index_json = work / "content" / "index.json"
            content = json.loads(index_json.read_text(encoding="utf-8"))
            content["hero"]["title"] = "Upstream Title"
            index_json.write_text(json.dumps(content), encoding="utf-8")
            _git(["add", "."], work)
            _git(["commit", "-m", "AI: retitle"], work)
            _git(["push", "origin", "main"], work)

            response = client.post(
                "/api/admin/publish",
                json={"message": "merge upstream", "expectedRev": _current_rev(client)},
            )
        assert response.status_code == 200
        assert response.json()["version"] == 1


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
    def test_only_the_auto_bootstrap_entry_when_nothing_ever_published(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        """A real, buildable site repo self-bootstraps to a real "version 0" ledger
        entry at startup (spec/07 §1) — see `TestGetState`'s own bootstrapped-live
        test for the same reasoning."""
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/publishes")
        assert response.status_code == 200
        body = response.json()["publishes"]
        assert len(body) == 1
        assert body[0]["version"] == 0
        assert body[0]["source"] == "bootstrap"
        assert body[0]["message"] == "bootstrap"
        assert body[0]["live"] is True

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
        # [2, 1, 0]: the two real publishes, newest first, plus the auto-bootstrap
        # "version 0" entry (spec/07 §1) trailing at the end — oldest, never live once
        # a real publish exists.
        assert [p["version"] for p in body] == [2, 1, 0]
        assert body[0]["live"] is True
        assert body[1]["live"] is False
        assert body[2]["live"] is False
        assert body[0]["message"] == "second"
        assert body[2]["source"] == "bootstrap"

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


def _publish_via_api(client: TestClient, path: str, value: str, message: str) -> None:
    client.patch(
        "/api/admin/draft",
        json={
            "expectedRev": _current_rev(client),
            "ops": [{"file": "index", "path": path, "value": value}],
        },
    )
    client.post(
        "/api/admin/publish",
        json={"message": message, "expectedRev": _current_rev(client)},
    )


class TestGetPublishVersionDiff:
    def test_diffs_a_publish_against_the_previous_version(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            _publish_via_api(client, "hero.title", "V1", "first")
            _publish_via_api(client, "hero.title", "V2", "second")
            response = client.get("/api/admin/publishes/2/diff")
        assert response.status_code == 200
        body = response.json()
        assert body["version"] == 2
        assert body["of"] == 1
        assert body["changes"] == {
            "index": [{"key": "hero.title", "kind": "text", "old": "V1", "new": "V2"}]
        }

    def test_unknown_version_is_a_404(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/publishes/99/diff")
        assert response.status_code == 404
        assert response.json()["detail"] == "no such version: 99"


class TestGetPublishPreview:
    def test_op_count_covers_content_ops_and_staged_page_ops(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        """The review drawer disables Publish when there's nothing to ship
        (decisions/00071) — `opCount` is its signal, and it must count staged
        page deletions too, since those produce no `changes` entries."""
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            assert client.get("/api/admin/publish/preview").json()["opCount"] == 0
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [
                        {"file": "index", "path": "hero.title", "value": "One"},
                        {"file": "index", "path": "meta.title", "value": "Two"},
                    ],
                },
            )
            assert client.get("/api/admin/publish/preview").json()["opCount"] == 2
            # Discard, then stage ONLY a page deletion.
            client.delete("/api/admin/draft")
            client.post(
                "/api/admin/pages/delete",
                json={"slug": "about", "expectedRev": _current_rev(client)},
            )
            preview = client.get("/api/admin/publish/preview").json()
        assert preview["changes"] == {}
        assert preview["opCount"] == 1

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

    def test_a_global_list_op_reports_kind_list(
        self, storage_root: Path, wixy_repo_root_with_global_list: Path
    ) -> None:
        """The drawer's readable list diff (added/removed/changed item lines
        instead of a raw JSON dump) hinges on the kind reaching the client as
        "list" — which only happens when the `@hours` bindings-map key is
        reconciled with the op's `hours` path (decisions/00081)."""
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_with_global_list)
        with TestClient(app) as client:
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [
                        {
                            "file": "_global",
                            "path": "hours",
                            "value": [{"day": "Monday", "value": "9:00 – 17:00", "closed": False}],
                        }
                    ],
                },
            )
            response = client.get("/api/admin/publish/preview")
        assert response.status_code == 200
        entries = response.json()["changes"]["_global"]
        assert len(entries) == 1
        assert entries[0]["key"] == "hours"
        assert entries[0]["kind"] == "list"

    def test_no_draft_ops_is_an_empty_diff(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/publish/preview")
        assert response.status_code == 200
        assert response.json() == {
            "changes": {},
            "opCount": 0,
            "validate": {"ok": True, "errors": []},
        }

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
            response = client.get("/admin/versions/1/does-not-exist.html")
        assert response.status_code == 404

    def test_a_version_still_present_on_disk_is_served_without_rebuilding(
        self, storage_root: Path, wixy_repo_root_bare: Path, paths: ProjectPaths
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            # The archived build must keep the initial content — stage the
            # required change (decisions/00071: empty publishes are refused)
            # on a DIFFERENT page so index.html still says "Original Title".
            client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": _current_rev(client),
                    "ops": [{"file": "about", "path": "intro.body", "value": "Changed about"}],
                },
            )
            client.post(
                "/api/admin/publish", json={"message": "first", "expectedRev": _current_rev(client)}
            )
            response = client.get("/admin/versions/1/index.html")
        assert response.status_code == 200
        assert "Original Title" in response.text


def _find_page(pages: list[dict[str, object]], slug: str) -> dict[str, object]:
    for page in pages:
        if page["slug"] == slug:
            return page
    raise AssertionError(f"no page named {slug!r} in {pages!r}")


def _meta(page: dict[str, object]) -> dict[str, object]:
    meta = page["meta"]
    assert isinstance(meta, dict)
    return meta


class TestPostPagesDuplicate:
    def test_duplicates_and_the_new_page_appears_in_state(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/pages/duplicate",
                json={"from": "about", "slug": "contact", "navLabel": "Contact", "expectedRev": 0},
            )
            assert response.status_code == 200
            assert response.json() == {"rev": 1}
            state = client.get("/api/admin/state").json()
        page = _find_page(state["pages"], "contact")
        assert _meta(page)["navLabel"] == "Contact"
        assert page["editable"] is False  # no template on disk until publish
        assert page["pendingDelete"] is False

    def test_the_source_pages_content_is_copied_into_the_new_page(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            client.post(
                "/api/admin/pages/duplicate",
                json={"from": "about", "slug": "contact", "navLabel": "Contact", "expectedRev": 0},
            )
            # GET /content/<slug> also works via extract_bindings_map's own
            # template lookup - but that legitimately 404s (no template on
            # disk yet), so this asserts via /state's merged meta instead,
            # matching what the pages panel actually reads.
            state = client.get("/api/admin/state").json()
        page = _find_page(state["pages"], "contact")
        assert _meta(page)["title"] == "About"  # copied from about.json

    def test_unknown_from_slug_is_404(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/pages/duplicate",
                json={
                    "from": "does-not-exist",
                    "slug": "contact",
                    "navLabel": "Contact",
                    "expectedRev": 0,
                },
            )
        assert response.status_code == 404

    def test_a_slug_that_already_exists_is_422(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/pages/duplicate",
                json={"from": "about", "slug": "index", "navLabel": "Home", "expectedRev": 0},
            )
        assert response.status_code == 422

    def test_an_invalid_slug_format_is_422(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/pages/duplicate",
                json={
                    "from": "about",
                    "slug": "Contact Page",
                    "navLabel": "Contact",
                    "expectedRev": 0,
                },
            )
        assert response.status_code == 422

    def test_a_stale_rev_is_409(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/pages/duplicate",
                json={"from": "about", "slug": "contact", "navLabel": "Contact", "expectedRev": 99},
            )
        assert response.status_code == 409


class TestPostPagesDelete:
    def test_stages_deletion_and_the_page_still_appears_pending(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/pages/delete", json={"slug": "about", "expectedRev": 0}
            )
            assert response.status_code == 200
            assert response.json() == {"rev": 1}
            state = client.get("/api/admin/state").json()
        page = _find_page(state["pages"], "about")
        assert page["pendingDelete"] is True

    def test_unknown_slug_is_404(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/pages/delete", json={"slug": "does-not-exist", "expectedRev": 0}
            )
        assert response.status_code == 404

    def test_a_stale_rev_is_409(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/pages/delete", json={"slug": "about", "expectedRev": 99}
            )
        assert response.status_code == 409

    def test_deletion_actually_takes_effect_at_publish(
        self, storage_root: Path, wixy_repo_root_bare: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root_bare)
        with TestClient(app) as client:
            client.post("/api/admin/pages/delete", json={"slug": "about", "expectedRev": 0})
            publish_response = client.post(
                "/api/admin/publish", json={"message": "delete about", "expectedRev": 1}
            )
            assert publish_response.status_code == 200
            state = client.get("/api/admin/state").json()
        assert not any(p["slug"] == "about" for p in state["pages"])


class TestTreeReadConsistency:
    """Regression for the Edit-button latch incident (2026-07-19): a state read
    racing a working-tree mutation (watcher fast-forward / publish materialize)
    could observe a template mid-replacement, report `editable: false`, and the
    shell cached that snapshot. Fix = the process-wide tree lock (`treelock.py`)
    held by every tree mutation AND every tree read: a state request issued
    while a mutation holds the lock must block until the tree is whole again,
    so no snapshot ever reports a real page uneditable."""

    def test_state_never_observes_a_template_mid_replacement(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        import threading
        import time

        from wixy_server.treelock import tree_lock

        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            template: Path = app.state.paths.repo / "pages" / "about.html"
            assert template.exists()
            saved = template.read_bytes()
            window_open = threading.Event()

            def mutate() -> None:
                # The exact shape of a real mutation: the template is transiently
                # absent while the tree lock is held (ensure_checkout and the
                # publisher's materialize/commit steps hold this same lock).
                with tree_lock():
                    template.unlink()
                    window_open.set()
                    time.sleep(0.6)
                    template.write_bytes(saved)

            mutator = threading.Thread(target=mutate)
            mutator.start()
            try:
                assert window_open.wait(timeout=5.0)
                response = client.get("/api/admin/state")
                assert response.status_code == 200
                editable = {p["slug"]: p["editable"] for p in response.json()["pages"]}
                assert editable.get("about") is True, (
                    "state observed the checkout mid-mutation — the tree lock is "
                    f"not protecting reads (editable map: {editable})"
                )
            finally:
                mutator.join(timeout=10.0)
            assert template.exists()
