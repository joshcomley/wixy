"""The builder must produce a parity-faithful passthrough build for a site repo that has
been moved to the `pages/`/`partials/` layout but has NO `content/*.json` and NO
`theme/theme.json` yet — exactly migration step 1's state (spec/03-site-migration.md
§3.1: "no other change"; see decisions/00004). No bindings, no meta, no theme: the
builder must gracefully do nothing rather than crash or overwrite an existing fonts link
with a font-less URL that would break rendering (and so fail the parity check it's
supposed to protect).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from builder.build import build_site
from builder.config import ProjectConfig, load_project_config
from builder.render import load_site_source, render_page
from builder.validate import validate_site

_ORIGINAL_FONTS_HREF = "https://fonts.googleapis.com/css2?family=Existing:wght@400"


@pytest.fixture
def step1_site(tmp_path: Path) -> Path:
    root = tmp_path / "site"
    (root / "pages").mkdir(parents=True)
    (root / "partials").mkdir()
    (root / "images").mkdir()
    (root / "pages" / "index.html").write_text(
        "<!DOCTYPE html>\n<html><head>\n"
        '<meta charset="utf-8">\n<title>Original Title</title>\n'
        f'<link rel="stylesheet" href="{_ORIGINAL_FONTS_HREF}">\n'
        '<link rel="stylesheet" href="site.css">\n'
        "</head>\n"
        '<body data-page="home">\n'
        "<!-- wx:partial header -->\n"
        "<main><h1>Hard-coded title, no bindings yet</h1></main>\n"
        "<!-- wx:partial footer -->\n"
        "<!-- wx:partial booking-modal -->\n"
        "</body></html>\n",
        encoding="utf-8",
    )
    for name in ("header", "footer", "booking-modal"):
        (root / "partials" / f"{name}.html").write_text("", encoding="utf-8")
    (root / "site.css").write_text("body{margin:0}", encoding="utf-8")
    return root


@pytest.fixture
def step1_project(tmp_path: Path) -> ProjectConfig:
    path = tmp_path / "project.json"
    path.write_text(
        '{"slug": "ca", "name": "CA", "repo": "x", "defaultBranch": "main", '
        '"cmdProject": "x", "domain": "ca.example.com", "locale": "en-GB", '
        '"indexable": false, "media": {"maxLongSidePx": 2000, "jpegQuality": 85}}',
        encoding="utf-8",
    )
    return load_project_config(path)


class TestNoThemeNoContent:
    def test_load_site_source_does_not_crash(
        self, step1_site: Path, step1_project: ProjectConfig
    ) -> None:
        source = load_site_source(step1_site, step1_project, theme=None)
        assert source.theme is None
        assert source.page_contents["index"] == {}
        assert source.global_content == {}

    def test_render_page_preserves_original_head(
        self, step1_site: Path, step1_project: ProjectConfig
    ) -> None:
        source = load_site_source(step1_site, step1_project, theme=None)
        html = render_page(source, "index", mode="publish")
        assert "Original Title" in html
        assert _ORIGINAL_FONTS_HREF in html
        assert "Hard-coded title, no bindings yet" in html

    def test_render_page_still_injects_empty_partials_and_marks_nav(
        self, step1_site: Path, step1_project: ProjectConfig
    ) -> None:
        source = load_site_source(step1_site, step1_project, theme=None)
        html = render_page(source, "index", mode="publish")
        assert "wx:partial" not in html

    def test_build_site_writes_output_without_theme_css(
        self, step1_site: Path, step1_project: ProjectConfig, tmp_path: Path
    ) -> None:
        source = load_site_source(step1_site, step1_project, theme=None)
        out = tmp_path / "_build"
        build_site(step1_site, source, out)
        assert (out / "index.html").exists()
        assert not (out / "theme.css").exists()
        assert _ORIGINAL_FONTS_HREF in (out / "index.html").read_text(encoding="utf-8")

    def test_validate_site_does_not_crash_and_has_no_theme_errors(
        self, step1_site: Path, step1_project: ProjectConfig
    ) -> None:
        source = load_site_source(step1_site, step1_project, theme=None)
        result = validate_site(source, step1_site)
        assert not any(e.file == "theme/theme.json" for e in result.errors)
