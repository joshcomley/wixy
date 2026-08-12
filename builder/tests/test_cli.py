"""CLI tests: `python -m builder build|validate|serve` (spec/09-work-plan.md milestone 2).

`serve`'s handler is exercised with a real HTTP request against an OS-assigned port (0)
— the original concern about port-collision flakiness (a hardcoded/default port) doesn't
apply once the OS picks the port, so `TestServeCommand` below tests it for real rather
than only through the pure-function-level `builder/tests/test_serving.py` coverage.
"""

from __future__ import annotations

import functools
import http.client
import http.server
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from bs4 import BeautifulSoup, Tag

from builder.build import build_site
from builder.cli import _CleanUrlHandler, main
from builder.render import SiteSource


class TestValidateCommand:
    def test_validate_ok_exit_code(
        self, mini_site_root: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        project = str(mini_site_root.parent / "project.json")
        code = main(["validate", "--root", str(mini_site_root), "--project", project])
        assert code == 0
        assert "validate: OK" in capsys.readouterr().out

    def test_validate_json_output(
        self, mini_site_root: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        project = str(mini_site_root.parent / "project.json")
        code = main(["validate", "--root", str(mini_site_root), "--project", project, "--json"])
        assert code == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload == {"ok": True, "errors": []}

    def test_validate_reports_error_and_nonzero_exit(
        self, tmp_path: Path, mini_site_root: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        root = tmp_path / "broken-site"
        (root / "pages").mkdir(parents=True)
        (root / "content").mkdir()
        (root / "partials").mkdir()
        (root / "theme").mkdir()
        (root / "pages" / "index.html").write_text(
            "<!DOCTYPE html><html><head><title>x</title></head>"
            "<body><!-- wx:partial header -->"
            '<h1 data-wx="hero.title">x</h1>'
            "<!-- wx:partial footer --><!-- wx:partial booking-modal --></body></html>",
            encoding="utf-8",
        )
        (root / "content" / "index.json").write_text('{"meta": {"title": "T"}}', encoding="utf-8")
        (root / "content" / "_global.json").write_text("{}", encoding="utf-8")
        (root / "theme" / "theme.json").write_text(
            '{"colors": {}, "shadow": "", "fonts": {'
            '"serif": {"family": "X", "weights": [], "italics": false}, '
            '"sans": {"family": "Y", "weights": [], "italics": false}, '
            '"script": {"family": "Z", "weights": [], "italics": false}}}',
            encoding="utf-8",
        )
        for name in ("header", "footer", "booking-modal"):
            (root / "partials" / f"{name}.html").write_text("<div></div>", encoding="utf-8")

        project = str(mini_site_root.parent / "project.json")
        code = main(["validate", "--root", str(root), "--project", project, "--json"])
        assert code == 1
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is False
        assert any(e["key"] == "hero.title" for e in payload["errors"])


class TestBuildCommand:
    def test_build_writes_output(self, mini_site_root: Path, tmp_path: Path) -> None:
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        code = main(
            ["build", "--root", str(mini_site_root), "--project", project, "--out", str(out)]
        )
        assert code == 0
        assert (out / "index.html").exists()
        assert (out / "about.html").exists()
        assert (out / "theme.css").exists()

    def test_build_omitted_overrides_preserve_registry_defaults(
        self, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """The fixture registry is domain=fixture.example.com, indexable=false — with no
        --domain/--indexable flags, build must behave exactly as before this feature."""
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        code = main(
            ["build", "--root", str(mini_site_root), "--project", project, "--out", str(out)]
        )
        assert code == 0
        robots = (out / "robots.txt").read_text(encoding="utf-8")
        assert robots == "User-agent: *\nAllow: /\n"
        assert not (out / "sitemap.xml").exists()
        soup = BeautifulSoup((out / "index.html").read_text(encoding="utf-8"), "html5lib")
        robots_meta = soup.find("meta", attrs={"name": "robots"})
        assert isinstance(robots_meta, Tag)
        assert robots_meta["content"] == "noindex"

    def test_build_domain_and_indexable_overrides_applied(
        self, mini_site_root: Path, tmp_path: Path
    ) -> None:
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        code = main(
            [
                "build",
                "--root",
                str(mini_site_root),
                "--project",
                project,
                "--out",
                str(out),
                "--domain",
                "example.org",
                "--indexable",
                "true",
            ]
        )
        assert code == 0

        robots = (out / "robots.txt").read_text(encoding="utf-8")
        assert robots == "User-agent: *\nAllow: /\nSitemap: https://example.org/sitemap.xml\n"

        sitemap = (out / "sitemap.xml").read_text(encoding="utf-8")
        assert "https://example.org/" in sitemap

        soup = BeautifulSoup((out / "index.html").read_text(encoding="utf-8"), "html5lib")
        assert soup.find("meta", attrs={"name": "robots"}) is None
        canonical = soup.find("link", attrs={"rel": "canonical"})
        assert isinstance(canonical, Tag)
        assert canonical["href"] == "https://example.org/"

    def test_build_indexable_false_override_still_omits_sitemap(
        self, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """Exercises the explicit-false override path (not just the omitted-flag default),
        alongside a --domain override, to prove the two flags are independent."""
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        code = main(
            [
                "build",
                "--root",
                str(mini_site_root),
                "--project",
                project,
                "--out",
                str(out),
                "--domain",
                "example.org",
                "--indexable",
                "false",
            ]
        )
        assert code == 0
        robots = (out / "robots.txt").read_text(encoding="utf-8")
        assert robots == "User-agent: *\nAllow: /\n"
        assert not (out / "sitemap.xml").exists()

        soup = BeautifulSoup((out / "index.html").read_text(encoding="utf-8"), "html5lib")
        canonical = soup.find("link", attrs={"rel": "canonical"})
        assert isinstance(canonical, Tag)
        assert canonical["href"] == "https://example.org/"

    def test_build_static_redirects_file_writes_alias_pages(
        self, mini_site_root: Path, tmp_path: Path
    ) -> None:
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        redirects_path = tmp_path / "redirects.json"
        redirects_path.write_text(json.dumps({"/home": "/"}), encoding="utf-8")
        code = main(
            [
                "build",
                "--root",
                str(mini_site_root),
                "--project",
                project,
                "--out",
                str(out),
                "--static-redirects-file",
                str(redirects_path),
            ]
        )
        assert code == 0
        assert (out / "home.html").exists()

    def test_build_omitted_static_redirects_file_writes_none(
        self, mini_site_root: Path, tmp_path: Path
    ) -> None:
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        code = main(
            ["build", "--root", str(mini_site_root), "--project", project, "--out", str(out)]
        )
        assert code == 0
        assert not (out / "home.html").exists()
        assert sorted(p.name for p in out.glob("*.html")) == [
            "404.html",
            "about.html",
            "index.html",
        ]


class TestServeCommand:
    """`_CleanUrlHandler` (decisions/00128) mirrors the production resolver
    (`wixy_server/routes_public.py`) via the same shared `resolve_site_path`
    (`builder/tests/test_serving.py` has the exhaustive algorithm-level coverage) —
    these tests prove the stdlib `http.server` wiring around it actually behaves that
    way for a real request."""

    @contextmanager
    def _serve(self, out: Path) -> Iterator[int]:
        handler = functools.partial(_CleanUrlHandler, directory=str(out))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_address[1]
        finally:
            server.shutdown()
            thread.join(timeout=5)

    def _get(self, port: int, path: str) -> tuple[int, bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request("GET", path)
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def test_extensionless_path_serves_the_html_file(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "out"
        build_site(mini_site_root, mini_site_source, out)
        with self._serve(out) as port:
            status, body = self._get(port, "/about")
        assert status == 200
        assert b"About the fixture" in body

    def test_html_suffixed_path_still_works(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "out"
        build_site(mini_site_root, mini_site_source, out)
        with self._serve(out) as port:
            status, body = self._get(port, "/about.html")
        assert status == 200
        assert b"About the fixture" in body

    def test_trailing_slash_page_path_is_404_not_a_redirect_or_listing(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "out"
        build_site(mini_site_root, mini_site_source, out)
        with self._serve(out) as port:
            status, _body = self._get(port, "/about/")
        assert status == 404

    def test_real_subdirectory_with_no_matching_page_is_404_not_a_listing(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """`images/` is a real subdirectory in the build output with no
        `images.html` — must 404, never a directory listing (decisions/00128; this is
        exactly the case `SimpleHTTPRequestHandler`'s inherited directory handling
        would NOT 404 if `_CleanUrlHandler` only patched the extensionless fallback on
        top of it instead of fully replacing resolution)."""
        out = tmp_path / "out"
        build_site(mini_site_root, mini_site_source, out)
        with self._serve(out) as port:
            status, _body = self._get(port, "/images")
        assert status == 404
        with self._serve(out) as port:
            status, _body = self._get(port, "/images/")
        assert status == 404

    def test_asset_still_serves_directly(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "out"
        build_site(mini_site_root, mini_site_source, out)
        with self._serve(out) as port:
            status, body = self._get(port, "/site.css")
        assert status == 200
        assert body  # non-empty; content itself is covered by build tests

    def test_extensionless_path_with_query_string_still_resolves(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """`self.path` on a real `http.server` request includes the raw query string
        (unlike FastAPI's route params, which never do) — `_CleanUrlHandler` must strip
        it before resolving, not just when matching the literal `.html` file."""
        out = tmp_path / "out"
        build_site(mini_site_root, mini_site_source, out)
        with self._serve(out) as port:
            status, body = self._get(port, "/about?utm_source=test")
        assert status == 200
        assert b"About the fixture" in body
