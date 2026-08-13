"""Full-site build tests: output tree, post-build self-check, determinism (04 §5 step 4,
08 §1's determinism test).
"""

from __future__ import annotations

import copy
import dataclasses
import shutil
from pathlib import Path

import pytest

from builder.assetcache import content_fingerprint
from builder.build import build_site, hash_output_tree
from builder.content import dotted_set
from builder.errors import BuildError
from builder.jsontypes import JsonObject
from builder.render import SiteSource, load_site_source


def _copy_mini_site(mini_site_root: Path, tmp_path: Path) -> Path:
    """A writable copy of the mini-site fixture -- `mini_site_root` itself is the real,
    shared fixtures directory on disk and must never be mutated by a test."""
    edited_root = tmp_path / "edited-site"
    edited_root.mkdir()
    for item in mini_site_root.iterdir():
        if item.is_dir():
            shutil.copytree(item, edited_root / item.name)
        else:
            edited_root.joinpath(item.name).write_bytes(item.read_bytes())
    return edited_root


class TestBuildSite:
    def test_writes_every_page(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        assert (out / "index.html").exists()
        assert (out / "about.html").exists()

    def test_writes_theme_css_and_static_assets(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        assert (out / "theme.css").read_text(encoding="utf-8").startswith(":root{")
        assert (out / "site.css").exists()
        assert (out / "site.js").exists()
        assert (out / "images" / "hero.jpg").exists()
        assert (out / "images" / "icon.jpg").exists()

    def test_robots_allows_crawling_when_not_indexable(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """A non-indexable build must not crawl-block `/` (decisions/00135) — Google can
        only observe a page's `noindex` meta by fetching it, so staging stays crawlable
        with no `Sitemap:` directive and no sitemap.xml, and relies on the per-page
        `noindex` (asserted separately below) to keep it out of results."""
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        robots = (out / "robots.txt").read_text(encoding="utf-8")
        assert robots == "User-agent: *\nAllow: /\n"
        assert "Disallow" not in robots
        assert not (out / "sitemap.xml").exists()

    def test_sitemap_written_when_indexable(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        project = dataclasses.replace(mini_site_source.project, indexable=True)
        source = dataclasses.replace(mini_site_source, project=project)
        out = tmp_path / "_build"
        build_site(mini_site_root, source, out)
        sitemap = (out / "sitemap.xml").read_text(encoding="utf-8")
        assert "<loc>https://fixture.example.com/</loc>" in sitemap
        robots = (out / "robots.txt").read_text(encoding="utf-8")
        assert "Sitemap:" in robots
        assert "Disallow" not in robots

    def test_favicon_ico_copied_when_present(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """decisions/00139: closes the WP0-audited `/favicon.ico` 404 -- a tiny, generic,
        project-agnostic root-passthrough allowlist, not a Cottage-Aesthetics special case."""
        edited_root = _copy_mini_site(mini_site_root, tmp_path)
        (edited_root / "favicon.ico").write_bytes(b"fake-ico-bytes")
        out = tmp_path / "_build"
        build_site(edited_root, mini_site_source, out)
        assert (out / "favicon.ico").read_bytes() == b"fake-ico-bytes"

    def test_favicon_ico_absent_when_not_authored(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        assert not (out / "favicon.ico").exists()

    def test_structured_data_absent_on_non_indexable_build(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """The fixture's own default (`indexable: false`) — Inv 35's own "staging emits
        nothing" precedent applies to the JSON-LD graph too."""
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        index_html = (out / "index.html").read_text(encoding="utf-8")
        assert "application/ld+json" not in index_html

    def test_structured_data_website_only_when_indexable_with_no_business_block(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        project = dataclasses.replace(mini_site_source.project, indexable=True)
        source = dataclasses.replace(mini_site_source, project=project)
        out = tmp_path / "_build"
        build_site(mini_site_root, source, out)
        index_html = (out / "index.html").read_text(encoding="utf-8")
        assert '"@type": "WebSite"' in index_html
        assert "LocalBusiness" not in index_html
        assert "DaySpa" not in index_html

    def test_structured_data_includes_local_business_when_business_block_present(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        project = dataclasses.replace(mini_site_source.project, indexable=True)
        global_content: JsonObject = {
            **mini_site_source.global_content,
            "business": {"types": ["DaySpa"]},
        }
        source = dataclasses.replace(
            mini_site_source, project=project, global_content=global_content
        )
        out = tmp_path / "_build"
        build_site(mini_site_root, source, out)
        index_html = (out / "index.html").read_text(encoding="utf-8")
        assert '"@type": "DaySpa"' in index_html
        # the fixture's own hours[] (checked above) parses cleanly under the real grammar
        assert "openingHoursSpecification" in index_html

    def test_structured_data_never_appears_on_a_non_home_page(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        project = dataclasses.replace(mini_site_source.project, indexable=True)
        global_content: JsonObject = {
            **mini_site_source.global_content,
            "business": {"types": ["DaySpa"]},
        }
        source = dataclasses.replace(
            mini_site_source, project=project, global_content=global_content
        )
        out = tmp_path / "_build"
        build_site(mini_site_root, source, out)
        about_html = (out / "about.html").read_text(encoding="utf-8")
        assert "application/ld+json" not in about_html

    def test_writes_a_styled_404_page(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        html = (out / "404.html").read_text(encoding="utf-8")
        assert "Page not found" in html
        assert '<meta name="robots" content="noindex">' in html
        # mini_site_source has a theme — references are fingerprinted (see
        # TestAssetFingerprinting below), not bare.
        theme_fp = content_fingerprint(out / "theme.css")
        site_fp = content_fingerprint(out / "site.css")
        assert f'href="theme.css?v={theme_fp}"' in html
        assert f'href="site.css?v={site_fp}"' in html

    def test_404_page_stays_noindex_even_when_project_is_indexable(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """`_generate_404_html` takes no `indexable` input by design — a 404 page must
        never be indexed regardless of the site's overall indexability, and it's now the
        sole exclusion signal for this one always-crawlable path (decisions/00135)."""
        project = dataclasses.replace(mini_site_source.project, indexable=True)
        source = dataclasses.replace(mini_site_source, project=project)
        out = tmp_path / "_build"
        build_site(mini_site_root, source, out)
        html = (out / "404.html").read_text(encoding="utf-8")
        assert '<meta name="robots" content="noindex">' in html

    def test_404_page_omits_theme_link_when_no_theme(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        source = dataclasses.replace(mini_site_source, theme=None)
        out = tmp_path / "_build"
        build_site(mini_site_root, source, out)
        html = (out / "404.html").read_text(encoding="utf-8")
        assert 'href="theme.css"' not in html

    def test_clears_stale_output_dir(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "_build"
        out.mkdir()
        (out / "stale.html").write_text("old", encoding="utf-8")
        build_site(mini_site_root, mini_site_source, out)
        assert not (out / "stale.html").exists()

    def test_missing_referenced_image_fails_self_check(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        index: JsonObject = copy.deepcopy(mini_site_source.page_contents["index"])
        dotted_set(index, "hero.bg.src", "images/ghost.jpg")
        source = dataclasses.replace(
            mini_site_source, page_contents={**mini_site_source.page_contents, "index": index}
        )
        out = tmp_path / "_build"
        with pytest.raises(BuildError):
            build_site(mini_site_root, source, out)


class TestAssetFingerprinting:
    """decisions/00130: build_site wires builder.assetcache in end-to-end."""

    def test_index_page_references_are_fingerprinted(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        html = (out / "index.html").read_text(encoding="utf-8")
        css_fp = content_fingerprint(out / "site.css")
        assert f'href="site.css?v={css_fp}"' in html
        # the page also links an absolute, external Google Fonts stylesheet
        # (theme-generated, unrelated to this site's own assets) — exactly one `?v=`
        # in the whole page confirms that external URL's own query string was never
        # touched by the fingerprinting rewrite.
        assert "fonts.googleapis.com" in html
        assert html.count("?v=") == 1

    def test_changing_site_css_changes_its_url_on_every_page(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out1 = tmp_path / "build1"
        build_site(mini_site_root, mini_site_source, out1)
        index1 = (out1 / "index.html").read_text(encoding="utf-8")
        about1 = (out1 / "about.html").read_text(encoding="utf-8")

        edited_root = tmp_path / "edited-site"
        edited_root.mkdir()
        for item in mini_site_root.iterdir():
            if item.is_dir():
                shutil.copytree(item, edited_root / item.name)
            else:
                edited_root.joinpath(item.name).write_bytes(item.read_bytes())
        (edited_root / "site.css").write_text("body{color:blue}", encoding="utf-8")

        out2 = tmp_path / "build2"
        build_site(edited_root, mini_site_source, out2)
        index2 = (out2 / "index.html").read_text(encoding="utf-8")
        about2 = (out2 / "about.html").read_text(encoding="utf-8")

        assert index1 != index2
        assert about1 != about2

    def test_leading_slash_asset_reference_fails_the_build(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """decisions/00130 audit round 2, F2: a template written with `href="/site.css"`
        instead of the bare `href="site.css"` the rewrite matches must fail the build
        loudly, not ship silently unfingerprinted — the exact invisibility that made the
        original production incident cost hours."""
        edited_root = tmp_path / "edited-site"
        edited_root.mkdir()
        for item in mini_site_root.iterdir():
            if item.is_dir():
                shutil.copytree(item, edited_root / item.name)
            else:
                edited_root.joinpath(item.name).write_bytes(item.read_bytes())
        index_page = edited_root / "pages" / "index.html"
        index_page.write_text(
            index_page.read_text(encoding="utf-8").replace('href="site.css"', 'href="/site.css"'),
            encoding="utf-8",
        )
        # `SiteSource.pages_dir` is fixed at load time (render_page reads the template
        # fresh from THERE, not from whatever `root` build_site is later called with) —
        # mini_site_source still points at the ORIGINAL, unedited fixture directory, so
        # a fresh load from edited_root is required for the edited template to matter.
        edited_source = load_site_source(
            edited_root, mini_site_source.project, mini_site_source.theme
        )

        out = tmp_path / "_build"
        with pytest.raises(BuildError):
            build_site(edited_root, edited_source, out)


class TestDeterminism:
    def test_two_builds_are_byte_identical(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out1 = tmp_path / "build1"
        out2 = tmp_path / "build2"
        build_site(mini_site_root, mini_site_source, out1)
        build_site(mini_site_root, mini_site_source, out2)
        assert hash_output_tree(out1) == hash_output_tree(out2)

    def test_different_content_hashes_differently(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out1 = tmp_path / "build1"
        build_site(mini_site_root, mini_site_source, out1)

        index: JsonObject = copy.deepcopy(mini_site_source.page_contents["index"])
        dotted_set(index, "hero.title", "A different title")
        source2 = dataclasses.replace(
            mini_site_source, page_contents={**mini_site_source.page_contents, "index": index}
        )
        out2 = tmp_path / "build2"
        build_site(mini_site_root, source2, out2)
        assert hash_output_tree(out1) != hash_output_tree(out2)
