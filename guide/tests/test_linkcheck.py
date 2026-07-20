"""Tests for `guide.linkcheck`'s pure link-extraction logic — `check_url`/
`run`'s own live-network behavior is exactly what the real CI job exercises
against the real internet (spec/independence/07 §3); a unit test hitting
real external URLs would be exactly the kind of flaky, network-dependent
test this repo's own testing conventions avoid.
"""

from __future__ import annotations

from pathlib import Path

from guide.linkcheck import collect_all_links, external_links


class TestExternalLinks:
    def test_finds_http_and_https_links(self) -> None:
        html = '<a href="https://example.com">x</a> <a href="http://example.org">y</a>'
        assert external_links(html) == {"https://example.com", "http://example.org"}

    def test_ignores_relative_links(self) -> None:
        html = '<a href="track-j.html">next</a> <a href="/admin/guide/">root</a>'
        assert external_links(html) == set()

    def test_ignores_non_href_urls_and_mailto(self) -> None:
        html = '<a href="mailto:hi@example.com">email</a>'
        assert external_links(html) == set()

    def test_deduplicates_the_same_url_within_one_page(self) -> None:
        html = '<a href="https://example.com">a</a> <a href="https://example.com">b</a>'
        assert external_links(html) == {"https://example.com"}

    def test_no_links_returns_empty_set(self) -> None:
        assert external_links("<p>no links here</p>") == set()


class TestCollectAllLinks:
    def test_maps_a_url_to_every_referencing_page(self, tmp_path: Path) -> None:
        (tmp_path / "a.html").write_text('<a href="https://shared.example">x</a>', encoding="utf-8")
        (tmp_path / "b.html").write_text('<a href="https://shared.example">y</a>', encoding="utf-8")
        (tmp_path / "c.html").write_text('<a href="https://only-c.example">z</a>', encoding="utf-8")

        by_url = collect_all_links(tmp_path)

        assert {p.name for p in by_url["https://shared.example"]} == {"a.html", "b.html"}
        assert {p.name for p in by_url["https://only-c.example"]} == {"c.html"}

    def test_empty_directory_returns_empty_map(self, tmp_path: Path) -> None:
        assert collect_all_links(tmp_path) == {}

    def test_ignores_non_html_files(self, tmp_path: Path) -> None:
        (tmp_path / "guide.css").write_text("/* not html */", encoding="utf-8")
        assert collect_all_links(tmp_path) == {}
