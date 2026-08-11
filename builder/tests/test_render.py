"""Per-page render integration tests against the fixture mini-site (spec/02, 04 §3-4)."""

from __future__ import annotations

from pathlib import Path

from bs4 import BeautifulSoup, Tag
from PIL import Image

from builder.jsontypes import JsonObject
from builder.render import SiteSource, render_page
from builder.templates import apply_head


def _rendered_head(
    meta: JsonObject,
    *,
    site_name: str = "Fixture Site",
    site_root: Path | None = None,
) -> Tag:
    """Runs `apply_head` against a bare `<head>` and returns it for assertions — the
    same "minimal soup, call apply_head directly" shape
    `test_canonical_link_overwrites_hand_authored_href` uses, factored out for the
    social-preview-tag cases below that don't need a full mini-site render."""
    soup = BeautifulSoup("<!DOCTYPE html><html><head></head><body></body></html>", "html5lib")
    apply_head(
        soup,
        meta=meta,
        fonts_url=None,
        page_url_path="/about",
        domain="fixture.example.com",
        indexable=False,
        file_label="test",
        site_name=site_name,
        site_root=site_root,
    )
    head = soup.head
    assert isinstance(head, Tag)
    return head


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
        links = soup.select("nav.primary a")
        by_href = {a["href"]: a for a in links}
        assert by_href["/"]["class"] == ["active"]
        assert "class" not in by_href["/about"].attrs or by_href["/about"].get("class") != [
            "active"
        ]

    def test_other_page_marks_its_own_link_active(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "about", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        links = {a["href"]: a for a in soup.select("nav.primary a")}
        assert links["/about"]["class"] == ["active"]

    def test_every_nav_container_gets_its_own_active_link(
        self, mini_site_source: SiteSource
    ) -> None:
        """A page can render `@nav` more than once (e.g. desktop + mobile menu) — every
        container's matching link must be marked, not just the first one found."""
        html = render_page(mini_site_source, "about", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        for nav_class in ("primary", "mobile"):
            links = {a["href"]: a for a in soup.select(f"nav.{nav_class} a")}
            assert links["/about"]["class"] == ["active"], nav_class
            assert links["/"].get("class") != ["active"], nav_class


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

    def test_canonical_link_present_on_index(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        canonical = soup.find("link", attrs={"rel": "canonical"})
        assert isinstance(canonical, Tag)
        assert canonical["href"] == "https://fixture.example.com/"

    def test_canonical_link_present_on_non_index_page(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "about", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        canonical = soup.find("link", attrs={"rel": "canonical"})
        assert isinstance(canonical, Tag)
        assert canonical["href"] == "https://fixture.example.com/about"

    def test_canonical_link_overwrites_hand_authored_href(
        self, mini_site_source: SiteSource
    ) -> None:
        """A template-authored canonical (or one left over from a prior build) must not
        win — apply_head is the single source of truth for this tag."""
        soup = BeautifulSoup(
            '<!DOCTYPE html><html><head><link rel="canonical" href="https://stale.example/x">'
            "</head><body></body></html>",
            "html5lib",
        )
        apply_head(
            soup,
            meta={},
            fonts_url=None,
            page_url_path="/about",
            domain="fixture.example.com",
            indexable=False,
            file_label="test",
            site_name="Fixture Site",
            site_root=None,
        )
        canonicals = soup.find_all("link", attrs={"rel": "canonical"})
        assert len(canonicals) == 1
        assert canonicals[0]["href"] == "https://fixture.example.com/about"

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

    def test_og_site_name_present(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        site_name = soup.find("meta", attrs={"property": "og:site_name"})
        assert isinstance(site_name, Tag)
        assert site_name["content"] == "Fixture Site"

    def test_twitter_card_present_when_og_image(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        twitter_card = soup.find("meta", attrs={"name": "twitter:card"})
        assert isinstance(twitter_card, Tag)
        assert twitter_card["content"] == "summary_large_image"

    def test_og_image_alt_present(self, mini_site_source: SiteSource) -> None:
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        alt_tag = soup.find("meta", attrs={"property": "og:image:alt"})
        assert isinstance(alt_tag, Tag)
        assert alt_tag["content"] == "hero"

    def test_og_image_dims_absent_for_non_image_fixture_file(
        self, mini_site_source: SiteSource
    ) -> None:
        """`images/hero.jpg` in this fixture is an 11-byte ASCII placeholder (the
        literal text `"placeholder"`), not a real image — it always has been, since
        the very first builder commit (parity screenshots the RENDERED page, never
        decodes this file's bytes, so nothing else depends on it being real).
        `probe_image_size` correctly fails to sniff it and the tags are omitted —
        this doubles as an integration-level "sniff genuinely fails" case alongside
        the more targeted `tmp_path`-based ones below."""
        html = render_page(mini_site_source, "index", mode="publish")
        soup = BeautifulSoup(html, "html5lib")
        assert soup.find("meta", attrs={"property": "og:image:width"}) is None
        assert soup.find("meta", attrs={"property": "og:image:height"}) is None

    def test_no_ogimage_derived_tags_without_og_image(self) -> None:
        head = _rendered_head({})
        assert head.find("meta", attrs={"property": "og:image"}) is None
        assert head.find("meta", attrs={"name": "twitter:card"}) is None
        assert head.find("meta", attrs={"property": "og:image:alt"}) is None
        assert head.find("meta", attrs={"property": "og:image:width"}) is None
        assert head.find("meta", attrs={"property": "og:image:height"}) is None
        # og:site_name is independent of ogImage — still present.
        site_name = head.find("meta", attrs={"property": "og:site_name"})
        assert isinstance(site_name, Tag)
        assert site_name["content"] == "Fixture Site"

    def test_og_image_alt_omitted_when_blank(self) -> None:
        head = _rendered_head({"ogImage": {"src": "images/x.jpg", "alt": ""}})
        assert head.find("meta", attrs={"property": "og:image:alt"}) is None
        # og:image and twitter:card don't depend on alt text being present.
        assert isinstance(head.find("meta", attrs={"property": "og:image"}), Tag)
        assert isinstance(head.find("meta", attrs={"name": "twitter:card"}), Tag)

    def test_og_site_name_omitted_when_empty(self) -> None:
        head = _rendered_head({}, site_name="")
        assert head.find("meta", attrs={"property": "og:site_name"}) is None

    def test_og_image_dims_present_for_real_image_on_disk(self, tmp_path: Path) -> None:
        images_dir = tmp_path / "images"
        images_dir.mkdir()
        Image.new("RGB", (321, 117), (10, 20, 30)).save(images_dir / "real.jpg", "JPEG")
        head = _rendered_head(
            {"ogImage": {"src": "images/real.jpg", "alt": "x"}}, site_root=tmp_path
        )
        width = head.find("meta", attrs={"property": "og:image:width"})
        height = head.find("meta", attrs={"property": "og:image:height"})
        assert isinstance(width, Tag)
        assert isinstance(height, Tag)
        assert width["content"] == "321"
        assert height["content"] == "117"

    def test_og_image_dims_skipped_when_file_missing(self, tmp_path: Path) -> None:
        head = _rendered_head(
            {"ogImage": {"src": "images/missing.jpg", "alt": "x"}}, site_root=tmp_path
        )
        og_image = head.find("meta", attrs={"property": "og:image"})
        assert isinstance(og_image, Tag)
        assert og_image["content"] == "https://fixture.example.com/images/missing.jpg"
        assert head.find("meta", attrs={"property": "og:image:width"}) is None
        assert head.find("meta", attrs={"property": "og:image:height"}) is None

    def test_og_image_dims_skipped_when_site_root_none(self) -> None:
        head = _rendered_head({"ogImage": {"src": "images/x.jpg", "alt": "x"}}, site_root=None)
        og_image = head.find("meta", attrs={"property": "og:image"})
        assert isinstance(og_image, Tag)
        assert og_image["content"] == "https://fixture.example.com/images/x.jpg"
        assert head.find("meta", attrs={"property": "og:image:width"}) is None

    def test_og_image_dims_skipped_for_absolute_src(self, tmp_path: Path) -> None:
        """A leading-slash src still gets its (verbatim-joined) `og:image` tag —
        unchanged from today's behavior — but the width/height sniff is skipped: an
        absolute src is never a repo-relative path to resolve against `site_root`."""
        head = _rendered_head({"ogImage": {"src": "/abs.jpg", "alt": "x"}}, site_root=tmp_path)
        og_image = head.find("meta", attrs={"property": "og:image"})
        assert isinstance(og_image, Tag)
        assert og_image["content"] == "https://fixture.example.com//abs.jpg"
        assert head.find("meta", attrs={"property": "og:image:width"}) is None

    def test_og_image_dims_skipped_for_path_traversal_src(self, tmp_path: Path) -> None:
        head = _rendered_head({"ogImage": {"src": "../x.jpg", "alt": "x"}}, site_root=tmp_path)
        og_image = head.find("meta", attrs={"property": "og:image"})
        assert isinstance(og_image, Tag)
        assert og_image["content"] == "https://fixture.example.com/../x.jpg"
        assert head.find("meta", attrs={"property": "og:image:width"}) is None

    def test_og_image_dims_skipped_for_backslash_traversal_src(self, tmp_path: Path) -> None:
        head = _rendered_head(
            {"ogImage": {"src": "images\\..\\..\\secret.jpg", "alt": "x"}}, site_root=tmp_path
        )
        assert isinstance(head.find("meta", attrs={"property": "og:image"}), Tag)
        assert head.find("meta", attrs={"property": "og:image:width"}) is None

    def test_og_image_dims_skipped_for_windows_drive_letter_src(self, tmp_path: Path) -> None:
        """A `C:`-rooted src would make `site_root / src` REPLACE `site_root` entirely
        (pathlib treats a drive-rooted right-hand segment as absolute) — this must never
        let the sniff read a file outside the site checkout."""
        head = _rendered_head(
            {"ogImage": {"src": "C:\\Windows\\win.ini", "alt": "x"}}, site_root=tmp_path
        )
        assert isinstance(head.find("meta", attrs={"property": "og:image"}), Tag)
        assert head.find("meta", attrs={"property": "og:image:width"}) is None

    def test_og_image_dims_skipped_for_unc_style_src(self, tmp_path: Path) -> None:
        head = _rendered_head(
            {"ogImage": {"src": "\\\\server\\share\\x.jpg", "alt": "x"}}, site_root=tmp_path
        )
        assert isinstance(head.find("meta", attrs={"property": "og:image"}), Tag)
        assert head.find("meta", attrs={"property": "og:image:width"}) is None


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
