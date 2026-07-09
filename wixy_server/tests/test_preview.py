from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from bs4 import BeautifulSoup, Tag

from builder.config import MediaConfig, ProjectConfig
from builder.jsontypes import JsonObject
from builder.render import SiteSource
from wixy_server.preview import (
    BINDINGS_SCRIPT_ID,
    EDITOR_SCRIPT_PATH,
    EDITOR_STYLESHEET_PATH,
    render_preview_page,
)


@pytest.fixture
def project() -> ProjectConfig:
    return ProjectConfig(
        slug="test",
        name="Test",
        repo="https://example.invalid/test.git",
        default_branch="main",
        cmd_project="test",
        domain="test.example.invalid",
        locale="en-GB",
        indexable=False,
        media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
    )


def _write_source(
    tmp_path: Path, project: ProjectConfig, body_html: str, page_content: JsonObject
) -> SiteSource:
    pages_dir = tmp_path / "pages"
    partials_dir = tmp_path / "partials"
    pages_dir.mkdir()
    partials_dir.mkdir()
    for name in ("header", "footer", "booking-modal"):
        (partials_dir / f"{name}.html").write_text("<body></body>\n", encoding="utf-8")
    (pages_dir / "index.html").write_text(
        "<!DOCTYPE html><html><head><title>placeholder</title></head>"
        "<body>"
        "<!-- wx:partial header -->"
        f"{body_html}"
        "<!-- wx:partial footer -->"
        "<!-- wx:partial booking-modal -->"
        "</body></html>\n",
        encoding="utf-8",
    )
    return SiteSource(
        project=project,
        pages_dir=pages_dir,
        partials_dir=partials_dir,
        theme=None,
        page_contents={"index": page_content},
        global_content={},
        content_dir=tmp_path / "content",
    )


class TestRenderPreviewPage:
    def test_renders_page_content(self, tmp_path: Path, project: ProjectConfig) -> None:
        source = _write_source(
            tmp_path,
            project,
            '<h1 data-wx="hero.title">placeholder</h1>',
            {"meta": {"title": "T"}, "hero": {"title": "Hello there"}},
        )
        html = render_preview_page(source, "index")
        assert "Hello there" in html

    def test_preview_mode_used_not_publish(self, tmp_path: Path, project: ProjectConfig) -> None:
        """A falsy `data-wx-if` branch must survive, hidden — proof this calls
        `render_page(mode="preview")`, not publish mode (spec/02 §2, 04 §4)."""
        source = _write_source(
            tmp_path,
            project,
            '<div data-wx-if="hero.showBanner"><p data-wx="hero.banner">placeholder</p></div>',
            {"meta": {}, "hero": {"showBanner": False, "banner": "Should stay, hidden"}},
        )
        html = render_preview_page(source, "index")
        assert "Should stay, hidden" in html
        assert 'data-wx-hidden="1"' in html

    def test_editor_stylesheet_injected_in_head(
        self, tmp_path: Path, project: ProjectConfig
    ) -> None:
        source = _write_source(
            tmp_path,
            project,
            '<h1 data-wx="hero.title">x</h1>',
            {"meta": {}, "hero": {"title": "X"}},
        )
        html = render_preview_page(source, "index")
        soup = BeautifulSoup(html, "html5lib")
        head = soup.head
        assert isinstance(head, Tag)
        link = head.find("link", attrs={"href": EDITOR_STYLESHEET_PATH})
        assert isinstance(link, Tag)
        assert link["rel"] == ["stylesheet"]

    def test_bindings_script_and_editor_script_appended_in_order(
        self, tmp_path: Path, project: ProjectConfig
    ) -> None:
        source = _write_source(
            tmp_path,
            project,
            '<h1 data-wx="hero.title">x</h1>',
            {"meta": {}, "hero": {"title": "X"}},
        )
        html = render_preview_page(source, "index")
        soup = BeautifulSoup(html, "html5lib")
        body = soup.body
        assert isinstance(body, Tag)
        scripts = body.find_all("script")
        assert len(scripts) == 2
        bindings_tag, editor_tag = scripts
        assert bindings_tag.get("id") == BINDINGS_SCRIPT_ID
        assert bindings_tag.get("type") == "application/json"
        assert editor_tag.get("src") == EDITOR_SCRIPT_PATH

    def test_bindings_script_content_matches_extracted_map(
        self, tmp_path: Path, project: ProjectConfig
    ) -> None:
        source = _write_source(
            tmp_path,
            project,
            '<h1 data-wx="hero.title">x</h1><a data-wx-href="hero.ctaHref">y</a>',
            {"meta": {}, "hero": {"title": "X", "ctaHref": "/z"}},
        )
        html = render_preview_page(source, "index")
        soup = BeautifulSoup(html, "html5lib")
        bindings_tag = soup.find("script", attrs={"id": BINDINGS_SCRIPT_ID})
        assert isinstance(bindings_tag, Tag)
        data = json.loads(bindings_tag.string or "")
        assert data["page"] == "index"
        by_key = {(f["key"], f["kind"]) for f in data["fields"]}
        assert by_key == {("hero.title", "text"), ("hero.ctaHref", "href")}

    def test_key_containing_script_close_tag_is_escaped_safely(
        self, tmp_path: Path, project: ProjectConfig
    ) -> None:
        """A `data-wx` key value containing a literal `</script>` must not be able to
        prematurely close the injected bindings <script> tag."""
        dangerous_key = "hero.title</script><script>alert(1)</script>"
        source = _write_source(
            tmp_path,
            project,
            f'<h1 data-wx="{dangerous_key}">x</h1>',
            {"meta": {}, "hero": {"title</script><script>alert(1)</script>": "X"}},
        )
        html = render_preview_page(source, "index")
        # No unescaped "</script" may appear anywhere except the two real closing
        # </script> tags this module itself injects.
        assert len(re.findall(r"</script", html, flags=re.IGNORECASE)) == 2
        soup = BeautifulSoup(html, "html5lib")
        bindings_tag = soup.find("script", attrs={"id": BINDINGS_SCRIPT_ID})
        assert isinstance(bindings_tag, Tag)
        data = json.loads(bindings_tag.string or "")
        assert data["fields"][0]["key"] == dangerous_key
