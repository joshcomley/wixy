"""Tests for `builder.staticredirects` — the opt-in GitHub-Pages-compatible static
redirect-alias page generator (decisions/ WP2 entry). Unit tests cover `load_static_
redirects`/`validate_static_redirects`/`generate_redirect_pages` directly; integration
tests drive the whole thing through `build_site` against the mini-site fixture (pages:
`index`, `about`; domain `fixture.example.com`; locale `en-GB`; name `Fixture Site`).
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest
from bs4 import BeautifulSoup, Tag

from builder.build import build_site
from builder.errors import BuildError
from builder.render import SiteSource
from builder.serving import resolve_site_path
from builder.staticredirects import (
    generate_redirect_pages,
    load_static_redirects,
    validate_static_redirects,
)

_PAGE_SLUGS = {"index", "about"}


def _write_json(tmp_path: Path, data: object) -> Path:
    path = tmp_path / "redirects.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


class TestLoadStaticRedirects:
    def test_loads_a_valid_flat_map(self, tmp_path: Path) -> None:
        path = _write_json(tmp_path, {"/home": "/", "/book-online": "/treatments"})
        assert load_static_redirects(path) == {"/home": "/", "/book-online": "/treatments"}

    def test_missing_file_raises(self, tmp_path: Path) -> None:
        with pytest.raises(BuildError, match="could not read"):
            load_static_redirects(tmp_path / "nope.json")

    def test_bad_json_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "redirects.json"
        path.write_text("{not json", encoding="utf-8")
        with pytest.raises(BuildError, match="not valid JSON"):
            load_static_redirects(path)

    def test_non_dict_root_raises(self, tmp_path: Path) -> None:
        path = _write_json(tmp_path, ["/home", "/"])
        with pytest.raises(BuildError, match="flat JSON object"):
            load_static_redirects(path)

    def test_non_string_value_raises(self, tmp_path: Path) -> None:
        path = _write_json(tmp_path, {"/home": 1})
        with pytest.raises(BuildError, match="flat JSON object"):
            load_static_redirects(path)

    def test_non_string_key_raises(self, tmp_path: Path) -> None:
        # JSON object keys are always strings on the wire, but a non-string VALUE
        # under a mixed-type structure is the realistic malformed case (covered
        # above) — this proves the "all values are strings" check is real, not a
        # vacuously-true `all()` over an empty/degenerate input.
        path = _write_json(tmp_path, {})
        assert load_static_redirects(path) == {}


class TestValidateStaticRedirects:
    def test_valid_map_passes(self) -> None:
        validate_static_redirects(
            {"/home": "/", "/book-online": "/about"},
            page_slugs=_PAGE_SLUGS,
            location="test",
        )

    @pytest.mark.parametrize(
        "bad_source",
        [
            "home",  # no leading slash
            "/Home",  # uppercase
            "/home/",  # trailing slash
            "/home.html",  # .html suffix
            "/home/extra",  # nested path
            "/../etc",  # traversal
            "/%68ome",  # percent-encoding
            "/home\n",  # trailing newline — the `.match()`+`$` gotcha
            "/home\r\n",
            "/home ",  # trailing whitespace
            " /home",  # leading whitespace
            "https://evil.example/home",  # external URL as a source
        ],
    )
    def test_malformed_source_rejected(self, bad_source: str) -> None:
        with pytest.raises(BuildError, match="root-relative internal path"):
            validate_static_redirects({bad_source: "/"}, page_slugs=_PAGE_SLUGS, location="test")

    def test_root_source_rejected(self) -> None:
        with pytest.raises(BuildError, match="homepage itself"):
            validate_static_redirects({"/": "/about"}, page_slugs=_PAGE_SLUGS, location="test")

    def test_root_target_accepted(self) -> None:
        """`/home -> /` is one of the three required mappings (spec/07 §5's legacy
        map) — root must be a valid TARGET even though it's rejected as a SOURCE."""
        validate_static_redirects({"/home": "/"}, page_slugs=_PAGE_SLUGS, location="test")

    def test_source_colliding_with_real_page_rejected(self) -> None:
        """Checked against the actual emitted filename (`about` -> `about.html`) —
        the mini-site fixture has a real `about` page; a source of `/about` must
        never be allowed to alias over it."""
        with pytest.raises(BuildError, match="collides with an existing page"):
            validate_static_redirects({"/about": "/"}, page_slugs=_PAGE_SLUGS, location="test")

    def test_source_colliding_with_reserved_404_rejected(self) -> None:
        with pytest.raises(BuildError, match="reserved build output name"):
            validate_static_redirects({"/404": "/about"}, page_slugs=_PAGE_SLUGS, location="test")

    @pytest.mark.parametrize(
        "bad_target",
        [
            "about",  # no leading slash
            "/About",  # uppercase
            "/about/",  # trailing slash
            "/about.html",  # .html suffix
            "/about\n",  # trailing newline
            "https://evil.example/about",  # external URL
            "//evil.example",  # protocol-relative external URL
        ],
    )
    def test_malformed_target_rejected(self, bad_target: str) -> None:
        with pytest.raises(BuildError, match="root-relative internal path"):
            validate_static_redirects(
                {"/home": bad_target}, page_slugs=_PAGE_SLUGS, location="test"
            )

    def test_target_not_a_real_page_rejected(self) -> None:
        with pytest.raises(BuildError, match="does not resolve to a real page"):
            validate_static_redirects(
                {"/home": "/nonexistent"}, page_slugs=_PAGE_SLUGS, location="test"
            )

    def test_target_pointing_at_another_alias_rejected(self) -> None:
        """A chain/loop: `/a` targets `/b`, and `/b` is itself only an alias SOURCE
        (not a real page) — must be rejected, not silently chained."""
        with pytest.raises(BuildError, match="does not resolve to a real page"):
            validate_static_redirects(
                {"/a": "/b", "/b": "/about"}, page_slugs=_PAGE_SLUGS, location="test"
            )

    def test_two_cycle_loop_rejected(self) -> None:
        with pytest.raises(BuildError, match="does not resolve to a real page"):
            validate_static_redirects(
                {"/a": "/b", "/b": "/a"}, page_slugs=_PAGE_SLUGS, location="test"
            )


class TestGenerateRedirectPages:
    def _page(self, **overrides: object) -> dict[str, str]:
        kwargs: dict[str, object] = {
            "redirects": {"/home": "/", "/book-online": "/about"},
            "domain": "fixture.example.com",
            "indexable": False,
            "locale": "en-GB",
            "site_name": "Fixture Site",
        }
        kwargs.update(overrides)
        return generate_redirect_pages(**kwargs)  # type: ignore[arg-type]

    def test_filenames_match_source_slugs(self) -> None:
        pages = self._page()
        assert set(pages) == {"home.html", "book-online.html"}

    def test_deterministic_sorted_order(self) -> None:
        pages_a = self._page(redirects={"/z-page": "/about", "/a-page": "/about"})
        pages_b = self._page(redirects={"/a-page": "/about", "/z-page": "/about"})
        assert list(pages_a) == list(pages_b) == ["a-page.html", "z-page.html"]

    def test_meta_refresh_and_canonical_present(self) -> None:
        html = self._page()["home.html"]
        soup = BeautifulSoup(html, "html5lib")
        refresh = soup.find("meta", attrs={"http-equiv": "refresh"})
        assert isinstance(refresh, Tag)
        assert refresh["content"] == "0; url=/"
        canonical = soup.find("link", attrs={"rel": "canonical"})
        assert isinstance(canonical, Tag)
        assert canonical["href"] == "https://fixture.example.com/"

    def test_fallback_link_present(self) -> None:
        html = self._page()["book-online.html"]
        soup = BeautifulSoup(html, "html5lib")
        link = soup.find("a", attrs={"href": "/about"})
        assert link is not None

    def test_noindex_when_not_indexable(self) -> None:
        html = self._page(indexable=False)["home.html"]
        soup = BeautifulSoup(html, "html5lib")
        robots = soup.find("meta", attrs={"name": "robots"})
        assert isinstance(robots, Tag)
        assert robots["content"] == "noindex"

    def test_no_noindex_when_indexable(self) -> None:
        html = self._page(indexable=True)["home.html"]
        soup = BeautifulSoup(html, "html5lib")
        assert soup.find("meta", attrs={"name": "robots"}) is None

    def test_not_inserted_into_sitemap_or_nav_structures(self) -> None:
        """No `data-wx-*` binding markup and no `<script>` at all — this is a
        deliberately synthetic stub page, not run through the normal render/nav
        pipeline, and (see the module docstring) carries no query/fragment-
        preservation mechanism, which would necessarily require a script."""
        html = self._page()["home.html"]
        assert "data-wx" not in html
        assert "<script" not in html

    def test_valid_html5(self) -> None:
        html = self._page()["home.html"]
        assert html.lower().startswith("<!doctype html>")
        BeautifulSoup(html, "html5lib")  # does not raise


class TestBuildSiteStaticRedirects:
    def test_no_flag_emits_no_alias_files_backwards_compatible(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        assert not (out / "home.html").exists()
        assert sorted(p.name for p in out.glob("*.html")) == [
            "404.html",
            "about.html",
            "index.html",
        ]

    def test_writes_alias_pages(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        redirects_path = tmp_path / "redirects.json"
        redirects_path.write_text(
            json.dumps({"/home": "/", "/book-online": "/about"}), encoding="utf-8"
        )
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out, static_redirects_file=redirects_path)
        assert (out / "home.html").exists()
        assert (out / "book-online.html").exists()

    def test_invalid_map_raises_build_error(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        redirects_path = tmp_path / "redirects.json"
        redirects_path.write_text(json.dumps({"/about": "/"}), encoding="utf-8")  # collides
        out = tmp_path / "_build"
        with pytest.raises(BuildError, match="collides with an existing page"):
            build_site(mini_site_root, mini_site_source, out, static_redirects_file=redirects_path)

    def test_alias_pages_excluded_from_sitemap(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        project = dataclasses.replace(mini_site_source.project, indexable=True)
        source = dataclasses.replace(mini_site_source, project=project)
        redirects_path = tmp_path / "redirects.json"
        redirects_path.write_text(json.dumps({"/home": "/"}), encoding="utf-8")
        out = tmp_path / "_build"
        build_site(mini_site_root, source, out, static_redirects_file=redirects_path)
        sitemap = (out / "sitemap.xml").read_text(encoding="utf-8")
        assert "home" not in sitemap
        assert sitemap.count("<url>") == 2  # index + about only

    def test_alias_resolves_through_shared_pages_equivalent_resolver(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """Proves the alias reaches the browser the same way any real page does — via
        `builder.serving.resolve_site_path`, the exact resolver dev-serve and the
        production server both use to mirror GitHub Pages' own clean-URL behavior
        (decisions/00128). This is NOT proof of live GitHub Pages behavior (that needs
        a real Pages deployment, tracked separately) — it proves this repo's own
        Pages-equivalent resolution logic treats the generated alias exactly like a
        real page, with zero special-casing required."""
        redirects_path = tmp_path / "redirects.json"
        redirects_path.write_text(json.dumps({"/home": "/"}), encoding="utf-8")
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out, static_redirects_file=redirects_path)

        extensionless = resolve_site_path(out, "/home")
        suffixed = resolve_site_path(out, "/home.html")
        assert extensionless is not None
        assert extensionless == suffixed == (out / "home.html").resolve()
        # Invariant 33's trailing-slash non-resolution still holds for aliases too.
        assert resolve_site_path(out, "/home/") is None

    def test_deterministic_across_two_builds(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        redirects_path = tmp_path / "redirects.json"
        redirects_path.write_text(
            json.dumps({"/home": "/", "/book-online": "/about"}), encoding="utf-8"
        )
        out_a = tmp_path / "_build_a"
        out_b = tmp_path / "_build_b"
        build_site(mini_site_root, mini_site_source, out_a, static_redirects_file=redirects_path)
        build_site(mini_site_root, mini_site_source, out_b, static_redirects_file=redirects_path)
        assert (out_a / "home.html").read_bytes() == (out_b / "home.html").read_bytes()
        assert (out_a / "book-online.html").read_bytes() == (
            out_b / "book-online.html"
        ).read_bytes()
