"""Tests for `guide.build` — the chapter-assembly pipeline. Runs against the
REAL `guide/chapters/*.html` + `guide/manifest.py` (this guide's actual
content, not a synthetic fixture set) since the build's job is assembling
exactly that content correctly; a fabricated manifest would test a different
program.
"""

from __future__ import annotations

from pathlib import Path

from guide.build import _chapter_meta, _footer_nav_html, _nav_html, build
from guide.manifest import CHAPTERS, chapter_by_slug, next_chapter, previous_chapter


class TestBuild:
    def test_writes_one_file_per_chapter_plus_index_and_assets(self, tmp_path: Path) -> None:
        out = tmp_path / "dist"
        written = build(out)

        assert len(written) == len(CHAPTERS)
        for chapter in CHAPTERS:
            assert (out / f"{chapter.slug}.html").exists()
        assert (out / "index.html").exists()
        assert (out / "guide.css").exists()
        assert (out / "guide.js").exists()

    def test_index_matches_start_here(self, tmp_path: Path) -> None:
        out = tmp_path / "dist"
        build(out)

        assert (out / "index.html").read_text(encoding="utf-8") == (
            out / "start-here.html"
        ).read_text(encoding="utf-8")

    def test_every_chapter_page_embeds_its_own_fragment_content(self, tmp_path: Path) -> None:
        out = tmp_path / "dist"
        build(out)

        for chapter in CHAPTERS:
            fragment = (
                Path(__file__).parent.parent / "chapters" / f"{chapter.slug}.html"
            ).read_text(encoding="utf-8")
            page = (out / f"{chapter.slug}.html").read_text(encoding="utf-8")
            assert fragment in page

    def test_rebuilding_replaces_stale_output(self, tmp_path: Path) -> None:
        out = tmp_path / "dist"
        out.mkdir()
        stray = out / "leftover-from-a-renamed-chapter.html"
        stray.write_text("stale", encoding="utf-8")

        build(out)

        assert not stray.exists()


class TestNavHtml:
    def test_marks_the_current_chapter(self) -> None:
        nav = _nav_html("start-here")
        assert 'href="start-here.html" aria-current="page"' in nav

    def test_does_not_mark_other_chapters(self) -> None:
        nav = _nav_html("start-here")
        assert 'href="track-j.html" aria-current="page"' not in nav

    def test_every_chapter_appears_exactly_once(self) -> None:
        nav = _nav_html("start-here")
        for chapter in CHAPTERS:
            assert nav.count(f'href="{chapter.slug}.html"') == 1

    def test_groups_are_headed_but_ungrouped_chapters_are_not(self) -> None:
        nav = _nav_html("start-here")
        assert "<h2>Track P — Purdi</h2>" in nav
        assert "<h2>Appendices</h2>" in nav


class TestChapterMeta:
    def test_combines_group_and_time_estimate(self) -> None:
        chapter = chapter_by_slug("track-p-2-github")
        assert _chapter_meta(chapter) == "Track P — Purdi · 20–30 minutes"

    def test_omits_missing_time_estimate(self) -> None:
        chapter = chapter_by_slug("track-p-7-drill")
        assert _chapter_meta(chapter) == "Track P — Purdi"

    def test_empty_group_and_no_estimate_is_blank(self) -> None:
        chapter = chapter_by_slug("start-here")
        assert _chapter_meta(chapter) == ""


class TestFooterNavHtml:
    def test_first_chapter_has_no_previous_link(self) -> None:
        footer = _footer_nav_html(chapter_by_slug("start-here"))
        assert "←" not in footer

    def test_last_chapter_has_no_next_link(self) -> None:
        footer = _footer_nav_html(chapter_by_slug(CHAPTERS[-1].slug))
        assert "→" not in footer

    def test_middle_chapter_has_both(self) -> None:
        footer = _footer_nav_html(chapter_by_slug("track-p-4-cloudflare"))
        assert "←" in footer
        assert "→" in footer


class TestManifestOrdering:
    def test_next_and_previous_are_inverses(self) -> None:
        for chapter in CHAPTERS:
            nxt = next_chapter(chapter.slug)
            if nxt is not None:
                assert previous_chapter(nxt.slug) == chapter

    def test_no_duplicate_slugs(self) -> None:
        slugs = [c.slug for c in CHAPTERS]
        assert len(slugs) == len(set(slugs))
