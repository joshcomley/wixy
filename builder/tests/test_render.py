"""Per-page render integration tests against the fixture mini-site (spec/02, 04 §3-4)."""

from __future__ import annotations

from bs4 import BeautifulSoup, Tag

from builder.render import SiteSource, render_page


class TestPartialInjection:
    def test_header_and_footer_injected(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        assert "<header>" in html
        assert "<footer>" in html
        assert "booking-modal" in html
        assert "wx:partial" not in html

    def test_partial_bindings_resolve(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        assert "Fixture" in html  # @brand.line1
        assert "01234 567890" in html  # @phone


class TestNavActiveState:
    def test_current_page_link_marked_active(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        links = soup.select("nav a")
        by_href = {a["href"]: a for a in links}
        assert by_href["/"]["class"] == ["active"]
        assert "class" not in by_href["/about.html"].attrs or by_href["/about.html"].get(
            "class"
        ) != ["active"]

    def test_other_page_marks_its_own_link_active(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "about", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        links = {a["href"]: a for a in soup.select("nav a")}
        assert links["/about.html"]["class"] == ["active"]


class TestHeadInjection:
    def test_title_and_description(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        assert soup.title is not None
        assert soup.title.text == "Home — Fixture"
        desc = soup.find("meta", attrs={"name": "description"})
        assert isinstance(desc, Tag)
        assert desc["content"] == "A fixture home page for builder tests."

    def test_og_tags_present(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        og_title = soup.find("meta", attrs={"property": "og:title"})
        og_image = soup.find("meta", attrs={"property": "og:image"})
        assert isinstance(og_title, Tag)
        assert isinstance(og_image, Tag)
        assert og_title["content"] == "Home — Fixture"
        assert og_image["content"] == "https://fixture.example.com/images/hero.jpg"

    def test_fonts_link_generated_and_replaces_placeholder(
        self, mini_site_source: SiteSource
    ) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        assert "fonts.googleapis.com/css2?family=Cormorant" in html
        assert "family=Old" not in html  # the placeholder link's stale href is gone

    def test_noindex_meta_present_when_not_indexable(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        robots = soup.find("meta", attrs={"name": "robots"})
        assert isinstance(robots, Tag)
        assert robots["content"] == "noindex"

    def test_doctype_present(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        assert html.lower().startswith("<!doctype html>")


class TestPreviewVsPublishMode:
    def test_publish_mode_removes_falsy_section(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "about", mode="publish")
        assert "You should not see this" not in html

    def test_preview_mode_retains_falsy_section_hidden(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "about", mode="preview")
        assert "You should not see this" in html
        assert 'data-wx-hidden="1"' in html


class TestCollectionRendering:
    def test_showcase_items_rendered_with_nested_tags(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        items = soup.select("ul.showcase > li")
        assert len(items) == 2
        first_tags = [li.string for li in items[0].select("ul.tags li")]
        assert first_tags == ["Popular", "New"]
        second_tags = items[1].select("ul.tags li")
        assert second_tags == []

    def test_book_enquire_pattern_per_item(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        items = soup.select("ul.showcase > li")
        # item one: book=true -> only the Book link survives
        item_one_links = {a.string: a["href"] for a in items[0].find_all("a")}
        assert item_one_links == {"Book": "/about.html#one"}
        # item two: book=false -> only the Enquire link survives
        item_two_links = {a.string: a["href"] for a in items[1].find_all("a")}
        assert item_two_links == {"Enquire": "/about.html#enquire"}
