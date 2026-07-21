"""The static-asset cache contract (decisions/00069).

The admin shell + the preview's injected editor assets are static files that CHANGE
whenever the TS bundles are rebuilt and redeployed, but Starlette's StaticFiles only
emits ETag/Last-Modified — no Cache-Control — so browsers apply heuristic caching
(RFC 7234 §4.2.2) and can keep serving a stale bundle for days after a deploy. That
bit in production: a merged + deployed admin-ui change was invisible on the
operator's phone until a manual hard refresh.

The contract these tests pin:
- every `/admin/static/*` URL referenced from served HTML carries a `?v=<content
  hash>` fingerprint, so a rebuilt bundle is a NEW URL no cache layer (browser, CF
  edge) can have a stale entry for;
- the static mount answers fingerprinted requests `immutable` (the bytes behind a
  given `?v=` never change) while unfingerprinted requests keep the default
  ETag/Last-Modified behaviour;
- the admin shell itself is `Cache-Control: no-cache`, so a new deploy's new
  fingerprints are picked up on the next navigation.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.preview import EDITOR_SCRIPT_PATH, EDITOR_STYLESHEET_PATH
from wixy_server.staticcache import content_fingerprint, fingerprinted_url

_STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

_INDEX_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<h1 data-wx="hero.title">placeholder</h1>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""

_PARTIAL_HTML = "<body></body>\n"


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same bypass as test_app.py — auth is test_auth.py/test_routes_auth_gate.py's
    job; these tests exercise exactly the cache contract."""
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


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


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    origin.mkdir(parents=True)
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "pages").mkdir()
    (origin / "partials").mkdir()
    (origin / "content").mkdir()
    (origin / "pages" / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (origin / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (origin / "content" / "index.json").write_text(
        json.dumps({"meta": {"title": "Home"}, "hero": {"title": "T"}}), encoding="utf-8"
    )
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


@pytest.fixture
def wixy_repo_root(tmp_path: Path, origin_repo: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        _project_json("test", str(origin_repo)), encoding="utf-8"
    )
    return root


@pytest.fixture
def client(tmp_path: Path, wixy_repo_root: Path) -> Iterator[TestClient]:
    app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
    with TestClient(app) as test_client:
        yield test_client


class TestFingerprintedUrl:
    def test_appends_content_hash_query(self, tmp_path: Path) -> None:
        asset = tmp_path / "a.css"
        asset.write_text("body{}", encoding="utf-8")
        expected = hashlib.sha256(b"body{}").hexdigest()[:10]
        assert fingerprinted_url("/admin/static/admin/admin.css", asset) == (
            f"/admin/static/admin/admin.css?v={expected}"
        )

    def test_hash_tracks_content(self, tmp_path: Path) -> None:
        asset = tmp_path / "a.css"
        asset.write_text("one", encoding="utf-8")
        first = fingerprinted_url("/x/a.css", asset)
        asset.write_text("two", encoding="utf-8")
        assert fingerprinted_url("/x/a.css", asset) != first

    def test_missing_file_falls_back_to_bare_path(self, tmp_path: Path) -> None:
        assert fingerprinted_url("/x/missing.css", tmp_path / "missing.css") == "/x/missing.css"

    def test_content_fingerprint_is_short_and_stable(self, tmp_path: Path) -> None:
        asset = tmp_path / "a.js"
        asset.write_bytes(b"abc")
        assert content_fingerprint(asset) == content_fingerprint(asset)
        assert len(content_fingerprint(asset)) == 10


class TestAdminShellCache:
    def test_shell_is_no_cache(self, client: TestClient) -> None:
        response = client.get("/admin")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache"

    def test_shell_bundles_are_fingerprinted(self, client: TestClient) -> None:
        text = client.get("/admin").text
        css_fp = content_fingerprint(_STATIC_DIR / "admin" / "admin.css")
        js_fp = content_fingerprint(_STATIC_DIR / "admin" / "admin.js")
        assert f'href="/admin/static/admin/admin.css?v={css_fp}"' in text
        assert f'src="/admin/static/admin/admin.js?v={js_fp}"' in text

    def test_every_static_reference_in_shell_is_fingerprinted(self, client: TestClient) -> None:
        """The invariant by construction: no `src`/`href` into /admin/static may go
        out bare, or the stale-bundle bug returns through whatever was just added."""
        text = client.get("/admin").text
        refs = re.findall(r'(?:src|href)="(/admin/static/[^"]+)"', text)
        assert refs, "expected the shell to reference at least one /admin/static asset"
        bare = [ref for ref in refs if "?v=" not in ref]
        assert bare == [], f"unfingerprinted admin asset references: {bare}"


class TestStaticMountCache:
    def test_fingerprinted_request_is_immutable(self, client: TestClient) -> None:
        response = client.get("/admin/static/admin/admin.css?v=anything")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


class TestAdminDeepLinks:
    """SPA deep links (decisions/00087): the admin routes on PROPER PATHS now
    (`/admin/edit/<page>`, `/admin/settings/appearance`, …), not hash fragments —
    so every panel path must serve the same shell document (the client router
    parses the path), while the real asset mounts keep winning their prefixes."""

    @pytest.mark.parametrize(
        "path",
        [
            "/admin/pages",
            "/admin/edit/index",
            "/admin/theme",
            "/admin/media",
            "/admin/chat",
            "/admin/chat/conv-123",
            "/admin/history",
            "/admin/settings",
            "/admin/settings/appearance",
        ],
    )
    def test_deep_link_serves_the_shell(self, client: TestClient, path: str) -> None:
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache"
        assert '<div id="wx-shell">' in response.text

    def test_deep_link_shell_assets_are_fingerprinted(self, client: TestClient) -> None:
        """The Inv 22 invariant must hold on deep links too — same document, same
        fingerprinting, or a hard refresh on a deep link could pull stale bundles."""
        text = client.get("/admin/edit/index").text
        refs = re.findall(r'(?:src|href)="(/admin/static/[^"]+)"', text)
        assert refs, "expected the shell to reference at least one /admin/static asset"
        assert all("?v=" in ref for ref in refs)

    def test_mounts_still_win_over_the_deep_link_catch_all(self, client: TestClient) -> None:
        """Registration order is the guard: /admin/static, /admin/guide and the
        draft-media mounts resolve to their mounts, never to the shell."""
        assert client.get("/admin/static/admin/admin.css?v=x").status_code == 200
        guide = client.get("/admin/guide/")
        assert guide.status_code == 200
        assert '<div id="wx-shell">' not in guide.text

    def test_unfingerprinted_request_keeps_default_behaviour(self, client: TestClient) -> None:
        response = client.get("/admin/static/admin/admin.css")
        assert response.status_code == 200
        assert "immutable" not in response.headers.get("cache-control", "")


class TestPreviewEditorAssets:
    def test_editor_paths_carry_fingerprints(self) -> None:
        js_fp = content_fingerprint(_STATIC_DIR / "editor" / "editor.js")
        css_fp = content_fingerprint(_STATIC_DIR / "editor" / "editor.css")
        assert EDITOR_SCRIPT_PATH == f"/admin/static/editor/editor.js?v={js_fp}"
        assert EDITOR_STYLESHEET_PATH == f"/admin/static/editor/editor.css?v={css_fp}"

    def test_preview_injects_fingerprinted_editor_urls(self, client: TestClient) -> None:
        text = client.get("/admin/preview/index.html").text
        assert EDITOR_SCRIPT_PATH in text
        assert EDITOR_STYLESHEET_PATH in text
        assert "?v=" in EDITOR_SCRIPT_PATH
