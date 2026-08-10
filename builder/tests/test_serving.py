"""`resolve_site_path` tests (decisions/00128) — the shared extensionless-URL
resolution algorithm behind both `wixy_server/routes_public.py`'s production
resolver and `builder/cli.py`'s dev-serve handler."""

from __future__ import annotations

from pathlib import Path

from builder.serving import resolve_site_path


class TestLiteralResolution:
    def test_resolves_a_real_html_file(self, tmp_path: Path) -> None:
        (tmp_path / "about.html").write_text("hi", encoding="utf-8")
        assert resolve_site_path(tmp_path, "/about.html") == tmp_path / "about.html"

    def test_empty_path_resolves_to_index(self, tmp_path: Path) -> None:
        (tmp_path / "index.html").write_text("hi", encoding="utf-8")
        assert resolve_site_path(tmp_path, "/") == tmp_path / "index.html"

    def test_asset_resolves_directly(self, tmp_path: Path) -> None:
        (tmp_path / "site.css").write_text("body{}", encoding="utf-8")
        assert resolve_site_path(tmp_path, "/site.css") == tmp_path / "site.css"


class TestExtensionlessFallback:
    def test_extensionless_path_falls_back_to_html_file(self, tmp_path: Path) -> None:
        (tmp_path / "about.html").write_text("hi", encoding="utf-8")
        assert resolve_site_path(tmp_path, "/about") == tmp_path / "about.html"

    def test_extensionless_index_also_resolves_to_index_html(self, tmp_path: Path) -> None:
        """`/index` (in addition to `/`) resolves too — a natural consequence of the
        same rule, not special-cased (decisions/00128)."""
        (tmp_path / "index.html").write_text("hi", encoding="utf-8")
        assert resolve_site_path(tmp_path, "/index") == tmp_path / "index.html"

    def test_trailing_slash_never_falls_back(self, tmp_path: Path) -> None:
        """`/about/` stays a 404 — matches GitHub Pages, which does no directory-index
        redirect for a clean-URL page either (verified live)."""
        (tmp_path / "about.html").write_text("hi", encoding="utf-8")
        assert resolve_site_path(tmp_path, "/about/") is None

    def test_already_extensioned_miss_never_gets_a_second_extension_appended(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / "images").mkdir()
        assert resolve_site_path(tmp_path, "/images/missing.jpg") is None

    def test_genuinely_unknown_extensionless_path_is_none(self, tmp_path: Path) -> None:
        assert resolve_site_path(tmp_path, "/nope") is None

    def test_directory_with_no_matching_html_file_is_none_not_a_listing(
        self, tmp_path: Path
    ) -> None:
        """A real subdirectory (e.g. `images/`) with no sibling `images.html` must 404,
        never fall through to some directory-listing/index behavior."""
        (tmp_path / "images").mkdir()
        (tmp_path / "images" / "hero.jpg").write_text("x", encoding="utf-8")
        assert resolve_site_path(tmp_path, "/images") is None
        assert resolve_site_path(tmp_path, "/images/") is None


class TestPathTraversalGuard:
    def test_dotdot_escape_is_rejected(self, tmp_path: Path) -> None:
        build_dir = tmp_path / "build"
        build_dir.mkdir()
        (tmp_path / "secret.txt").write_text("do not serve this", encoding="utf-8")
        assert resolve_site_path(build_dir, "/../secret.txt") is None

    def test_dotdot_escape_is_rejected_even_via_the_extensionless_fallback(
        self, tmp_path: Path
    ) -> None:
        """The fallback candidate goes through the SAME guard as the literal one —
        appending `.html` must never turn a traversal attempt into a hit."""
        build_dir = tmp_path / "build"
        build_dir.mkdir()
        (tmp_path / "secret").write_text("do not serve this", encoding="utf-8")
        (tmp_path / "secret.html").write_text("do not serve this either", encoding="utf-8")
        assert resolve_site_path(build_dir, "/../secret") is None

    def test_deeper_dotdot_escape_is_rejected(self, tmp_path: Path) -> None:
        build_dir = tmp_path / "nested" / "build"
        build_dir.mkdir(parents=True)
        (tmp_path / "secret.txt").write_text("do not serve this", encoding="utf-8")
        assert resolve_site_path(build_dir, "/../../secret.txt") is None
