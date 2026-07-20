"""Assembles the guide's chapter fragments (`guide/chapters/*.html`) into full
pages via the shared chrome template (`guide/templates/chrome.html`), writing
output into `wixy_server/static/guide/` — the SAME "committed build output,
CI checks for drift" convention `admin-ui`/`editor` already use (this repo's
own CLAUDE.md), just a pure-Python assembly step instead of an esbuild bundle,
since the guide is plain content, not compiled TypeScript (spec/independence/
07 §1: "zero JS frameworks").

Marker-comment substitution (`<!--GUIDE:X-->`), the SAME idiom `builder.
templates`'s own `<!-- wx:partial ... -->` uses for the SITE's own templates
— deliberately not reused directly (that module resolves `data-wx-*`
bindings against page content JSON, a different problem entirely), but the
same "HTML comments as template markers, no new templating dependency"
convention this repo already established.

Run via `python -m guide` from the repo root (see `guide/__main__.py` for the
CLI entrypoint — kept separate from this module so `python -m guide` never
double-imports `build` under two names, a real `RuntimeWarning` hit and fixed
during this milestone). Also the mechanism behind "buildable to a standalone
folder she can keep anywhere" (spec's own words) — `--out <dir>` writes
anywhere, not just the served location.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from guide.manifest import CHAPTERS, Chapter, next_chapter, previous_chapter

_GUIDE_ROOT = Path(__file__).parent
DEFAULT_OUT = _GUIDE_ROOT.parent / "wixy_server" / "static" / "guide"


def _nav_html(current_slug: str) -> str:
    groups: list[tuple[str, list[Chapter]]] = []
    for chapter in CHAPTERS:
        if groups and groups[-1][0] == chapter.group:
            groups[-1][1].append(chapter)
        else:
            groups.append((chapter.group, [chapter]))

    parts: list[str] = []
    for group_name, chapters in groups:
        parts.append('<div class="guide-nav-group">')
        if group_name:
            parts.append(f"<h2>{group_name}</h2>")
        parts.append("<ul>")
        for chapter in chapters:
            current = ' aria-current="page"' if chapter.slug == current_slug else ""
            parts.append(f'<li><a href="{chapter.slug}.html"{current}>{chapter.nav_title}</a></li>')
        parts.append("</ul></div>")
    return "\n".join(parts)


def _chapter_meta(chapter: Chapter) -> str:
    pieces = [p for p in (chapter.group or None, chapter.time_estimate) if p]
    return " · ".join(pieces)


def _footer_nav_html(chapter: Chapter) -> str:
    prev_chapter = previous_chapter(chapter.slug)
    next_ch = next_chapter(chapter.slug)
    left = (
        f'<a href="{prev_chapter.slug}.html">← {prev_chapter.nav_title}</a>'
        if prev_chapter is not None
        else "<span></span>"
    )
    right = (
        f'<a href="{next_ch.slug}.html">{next_ch.nav_title} →</a>' if next_ch is not None else ""
    )
    return f"{left}\n{right}"


def _render_chapter(chrome: str, chapter: Chapter) -> str:
    fragment_path = _GUIDE_ROOT / "chapters" / f"{chapter.slug}.html"
    content = fragment_path.read_text(encoding="utf-8")
    page = chrome
    page = page.replace("<!--GUIDE:TITLE-->", chapter.page_title)
    page = page.replace("<!--GUIDE:NAV-->", _nav_html(chapter.slug))
    page = page.replace("<!--GUIDE:CHAPTER_META-->", _chapter_meta(chapter))
    page = page.replace("<!--GUIDE:CONTENT-->", content)
    page = page.replace("<!--GUIDE:FOOTER_NAV-->", _footer_nav_html(chapter))
    return page


def build(out_dir: Path = DEFAULT_OUT) -> list[Path]:
    """Writes every chapter page + static assets into `out_dir`, returning the
    list of chapter HTML paths written (the linkcheck script's own input)."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    chrome = (_GUIDE_ROOT / "templates" / "chrome.html").read_text(encoding="utf-8")

    written: list[Path] = []
    for chapter in CHAPTERS:
        page_html = _render_chapter(chrome, chapter)
        dest = out_dir / f"{chapter.slug}.html"
        dest.write_text(page_html, encoding="utf-8", newline="\n")
        written.append(dest)

    # `StaticFiles(html=True)` looks for `index.html` at the mount root —
    # the guide's own landing page IS "start here", just also reachable at
    # the bare `/admin/guide/` URL.
    (out_dir / "index.html").write_text(
        (out_dir / "start-here.html").read_text(encoding="utf-8"), encoding="utf-8", newline="\n"
    )

    shutil.copy2(_GUIDE_ROOT / "assets" / "guide.css", out_dir / "guide.css")
    shutil.copy2(_GUIDE_ROOT / "assets" / "guide.js", out_dir / "guide.js")

    return written
