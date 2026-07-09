"""Full-site build tests: output tree, post-build self-check, determinism (04 §5 step 4,
08 §1's determinism test).
"""

from __future__ import annotations

import copy
import dataclasses
from pathlib import Path

import pytest

from builder.build import build_site, hash_output_tree
from builder.content import dotted_set
from builder.errors import BuildError
from builder.jsontypes import JsonObject
from builder.render import SiteSource


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

    def test_robots_disallow_when_not_indexable(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        robots = (out / "robots.txt").read_text(encoding="utf-8")
        assert "Disallow: /" in robots
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

    def test_writes_a_styled_404_page(
        self, mini_site_source: SiteSource, mini_site_root: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "_build"
        build_site(mini_site_root, mini_site_source, out)
        html = (out / "404.html").read_text(encoding="utf-8")
        assert "Page not found" in html
        assert 'href="theme.css"' in html  # mini_site_source has a theme
        assert 'href="site.css"' in html

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
