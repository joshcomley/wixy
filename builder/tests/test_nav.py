"""Nav derivation tests (spec/02-content-model.md §3)."""

from __future__ import annotations

from builder.jsontypes import JsonObject
from builder.nav import build_nav, page_url


class TestPageUrl:
    def test_index_maps_to_root(self) -> None:
        assert page_url("index") == "/"

    def test_other_pages_map_to_html_files(self) -> None:
        assert page_url("about") == "/about.html"


class TestBuildNav:
    def test_orders_by_nav_order(self) -> None:
        pages: dict[str, JsonObject] = {
            "about": {"meta": {"inNav": True, "navOrder": 20, "navLabel": "About"}},
            "index": {"meta": {"inNav": True, "navOrder": 10, "navLabel": "Home"}},
        }
        nav = build_nav(pages, {})
        assert nav == [
            {"label": "Home", "href": "/"},
            {"label": "About", "href": "/about.html"},
        ]

    def test_excludes_pages_not_in_nav(self) -> None:
        pages: dict[str, JsonObject] = {
            "policies": {"meta": {"inNav": False, "navOrder": 5}},
            "index": {"meta": {"inNav": True, "navOrder": 10, "navLabel": "Home"}},
        }
        nav = build_nav(pages, {})
        assert nav == [{"label": "Home", "href": "/"}]

    def test_falls_back_to_slug_when_no_nav_label(self) -> None:
        pages: dict[str, JsonObject] = {"faq": {"meta": {"inNav": True, "navOrder": 1}}}
        nav = build_nav(pages, {})
        assert nav == [{"label": "faq", "href": "/faq.html"}]

    def test_appends_nav_extra(self) -> None:
        pages: dict[str, JsonObject] = {}
        global_content: JsonObject = {
            "navExtra": [{"label": "External", "href": "https://example.com"}]
        }
        nav = build_nav(pages, global_content)
        assert nav == [{"label": "External", "href": "https://example.com"}]

    def test_malformed_nav_extra_entries_are_skipped(self) -> None:
        global_content: JsonObject = {"navExtra": [{"label": "Bad, no href"}, "not-an-object"]}
        nav = build_nav({}, global_content)
        assert nav == []

    def test_pages_missing_meta_are_ignored(self) -> None:
        pages: dict[str, JsonObject] = {"broken": {}}
        assert build_nav(pages, {}) == []
