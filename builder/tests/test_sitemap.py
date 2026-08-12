"""`robots.txt` / `sitemap.xml` generation tests (spec/02-content-model.md §7,
decisions/00135). Direct unit coverage of `generate_robots_txt`/`generate_sitemap_xml` —
the full-build integration assertions (robots.txt on disk, sitemap.xml presence/absence
alongside the per-page `noindex` meta) live in `test_build.py`/`test_cli.py`.
"""

from __future__ import annotations

from builder.sitemap import generate_robots_txt, generate_sitemap_xml


class TestGenerateRobotsTxt:
    def test_non_indexable_allows_crawling(self) -> None:
        """A blocked page's `noindex` meta is unobservable to a crawler that can't fetch
        it (decisions/00135) — non-indexable robots.txt must not disallow `/`."""
        robots = generate_robots_txt(domain="ca.cinnamons.uk", indexable=False)
        assert "Disallow" not in robots
        assert "Allow: /" in robots

    def test_non_indexable_omits_sitemap_directive(self) -> None:
        robots = generate_robots_txt(domain="ca.cinnamons.uk", indexable=False)
        assert "Sitemap:" not in robots

    def test_non_indexable_exact_bytes(self) -> None:
        assert (
            generate_robots_txt(domain="ca.cinnamons.uk", indexable=False)
            == "User-agent: *\nAllow: /\n"
        )

    def test_indexable_allows_crawling_and_advertises_sitemap(self) -> None:
        robots = generate_robots_txt(domain="cottageaesthetics.co.uk", indexable=True)
        assert "Disallow" not in robots
        assert "Allow: /" in robots
        assert "Sitemap: https://cottageaesthetics.co.uk/sitemap.xml" in robots

    def test_indexable_exact_bytes(self) -> None:
        assert (
            generate_robots_txt(domain="cottageaesthetics.co.uk", indexable=True)
            == "User-agent: *\nAllow: /\nSitemap: https://cottageaesthetics.co.uk/sitemap.xml\n"
        )


class TestGenerateSitemapXml:
    def test_sorts_by_slug_and_emits_page_urls(self) -> None:
        """Sorts the SLUG strings (Inv 4), not the resulting URL paths — "about" sorts
        before "index" alphabetically even though "index" emits the shorter "/"."""
        xml = generate_sitemap_xml(domain="example.com", slugs=["treatments", "about", "index"])
        assert xml.index("<loc>https://example.com/about</loc>") < xml.index(
            "<loc>https://example.com/</loc>"
        )
        assert xml.index("<loc>https://example.com/</loc>") < xml.index(
            "<loc>https://example.com/treatments</loc>"
        )

    def test_empty_slugs_still_valid_urlset(self) -> None:
        xml = generate_sitemap_xml(domain="example.com", slugs=[])
        assert xml.startswith('<?xml version="1.0" encoding="UTF-8"?>\n')
        assert "<urlset" in xml
        assert "</urlset>" in xml
