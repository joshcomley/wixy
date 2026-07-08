"""Per-page render orchestration — ties content + theme + nav + templates + bindings
together into one page's HTML (spec/02, spec/04 §3-4). Used identically by `build`
(publish mode) and the server's live preview (preview mode, once milestone 6 lands).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from bs4 import BeautifulSoup, Doctype, Tag

from builder.bindings import Mode, ResolveContext, apply_bindings
from builder.config import ProjectConfig
from builder.content import GLOBAL_CONTENT_NAME, content_path, load_json_object
from builder.errors import BuildError, ValidationResult
from builder.jsontypes import JsonObject
from builder.nav import build_nav, page_url
from builder.templates import (
    apply_head,
    inject_partials,
    load_partials,
    load_template,
    require_partial_markers,
)
from builder.theme import Theme, generate_fonts_url


@dataclass(frozen=True, slots=True)
class SiteSource:
    """Everything on disk the builder needs, pre-loaded once per build/serve session.

    `theme` is `None` before migration step 4 (spec/03 §3.4) creates `theme/theme.json`;
    a page's content is `{}` before step 3 creates its `content/<slug>.json` (03 §3.3).
    The builder must still produce a parity-faithful passthrough build in that
    partially-migrated state (03 §3.1: "no other change" at step 1) — see decisions/00004.
    `content_dir` (where each page's content file would live) lets `validate.py`
    distinguish "not migrated yet" (file absent) from "migrated but malformed" (file
    present but e.g. missing `meta`).
    """

    project: ProjectConfig
    pages_dir: Path
    partials_dir: Path
    theme: Theme | None
    page_contents: dict[str, JsonObject]
    global_content: JsonObject
    content_dir: Path


def _load_content_or_empty(path: Path) -> JsonObject:
    return load_json_object(path) if path.exists() else {}


def load_site_source(root: Path, project: ProjectConfig, theme: Theme | None) -> SiteSource:
    pages_dir = root / "pages"
    content_dir = root / "content"
    partials_dir = root / "partials"

    page_contents: dict[str, JsonObject] = {}
    for page_path in sorted(pages_dir.glob("*.html")):
        slug = page_path.stem
        page_contents[slug] = _load_content_or_empty(content_path(content_dir, slug))

    global_content = _load_content_or_empty(content_path(content_dir, GLOBAL_CONTENT_NAME))

    return SiteSource(
        project=project,
        pages_dir=pages_dir,
        partials_dir=partials_dir,
        theme=theme,
        page_contents=page_contents,
        global_content=global_content,
        content_dir=content_dir,
    )


def resolved_global_content(source: SiteSource) -> JsonObject:
    """`_global.json` content with the builder-computed `nav` array injected (02 §3)."""
    merged: JsonObject = dict(source.global_content)
    merged["nav"] = build_nav(source.page_contents, source.global_content)
    return merged


def _ensure_doctype(soup: BeautifulSoup) -> None:
    if not any(isinstance(node, Doctype) for node in soup.contents):
        soup.insert(0, Doctype("html"))


def _mark_nav_active(body: Tag, current_url: str) -> None:
    """Add `class="active"` to the rendered nav link matching the page being built
    (static, replaces the old client-side `data-page` comparison) — spec/03 §2.
    """
    nav_container = body.find(attrs={"data-wx-list": "@nav"})
    if not isinstance(nav_container, Tag):
        return
    for link in nav_container.find_all(attrs={"data-wx-href": True}):
        if not isinstance(link, Tag) or link.get("href") != current_url:
            continue
        classes = link.get("class") or []
        if not isinstance(classes, list):
            classes = [classes]
        if "active" not in classes:
            link["class"] = [*classes, "active"]


def render_page(
    source: SiteSource, slug: str, *, mode: Mode, sink: ValidationResult | None = None
) -> str:
    """Render one page to a full HTML document string."""
    page_content = source.page_contents.get(slug)
    if page_content is None:
        raise BuildError(f"no content file for page '{slug}'", location=slug)

    template_path = source.pages_dir / f"{slug}.html"
    if not template_path.exists():
        raise BuildError(f"no template for page '{slug}'", location=slug)

    file_label = f"pages/{slug}.html"
    soup = load_template(template_path)
    require_partial_markers(soup, file_label=file_label)

    partials = load_partials(source.partials_dir)
    inject_partials(soup, partials, file_label=file_label)

    body = soup.body
    if not isinstance(body, Tag):
        raise BuildError("template has no <body>", location=file_label)

    ctx = ResolveContext(page=page_content, glob=resolved_global_content(source))
    apply_bindings(body, ctx, mode=mode, file_label=file_label, sink=sink)
    _mark_nav_active(body, page_url(slug))

    meta_raw = page_content.get("meta")
    meta: JsonObject = meta_raw if isinstance(meta_raw, dict) else {}
    fonts_url = generate_fonts_url(source.theme) if source.theme is not None else None

    apply_head(
        soup,
        meta=meta,
        fonts_url=fonts_url,
        page_url_path=page_url(slug),
        domain=source.project.domain,
        indexable=source.project.indexable,
        file_label=file_label,
    )

    _ensure_doctype(soup)
    return str(soup)
