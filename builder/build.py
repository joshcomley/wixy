"""Full-site build: renders every page + assets into an output directory, then runs the
post-build self-check (spec/04-server.md §5 step 4).
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from bs4 import BeautifulSoup

from builder.assetcache import find_unfingerprinted_asset_references, fingerprint_asset_references
from builder.content import scan_image_refs
from builder.errors import BuildError
from builder.render import SiteSource, render_page
from builder.sitemap import generate_robots_txt, generate_sitemap_xml
from builder.staticredirects import (
    generate_redirect_pages,
    load_static_redirects,
    validate_static_redirects,
)
from builder.theme import generate_theme_css

# decisions/00140: `bindings.py:_apply_img` emits width/height attributes for a bound
# <img> whenever it can sniff real on-disk dimensions -- but HTML width/height are
# CSS *presentational hints* for the `width`/`height` properties. A site's own CSS
# rule that only constrains one axis (e.g. `img{width:100%}`, no `height` rule --
# exactly what Cottage Aesthetics' site.css does for `.about img`/`.ba-tile img`)
# lets the newly-present `height` attribute pin a hard pixel value, stretching the
# image out of its real aspect ratio -- precisely the "without distorting CSS
# layout" outcome the brief's own WP4-4B text explicitly warned against, and
# empirically confirmed against the real deployed site. `:where()` keeps this
# guard's specificity at exactly zero, so ANY real site-authored height rule
# (`.gal img{height:100%}`, `.bas-frame img{height:100%}`) still wins outright --
# this only fills the gap when a site's CSS says nothing about height at all.
# Static and theme-independent by design: kept out of `generate_theme_css` (Inv 20
# ties that function's output to a byte-identical TS port for the live theme-panel
# preview, which has nothing to do with this layout concern) and appended directly
# to the written `theme.css` file instead.
_IMG_DIMENSION_LAYOUT_GUARD_CSS = ":where(img[width][height]){height:auto}\n"


def build_site(
    root: Path,
    source: SiteSource,
    out_dir: Path,
    *,
    static_redirects_file: Path | None = None,
) -> None:
    """Build the full site from `root` (the site repo checkout) into `out_dir`.

    `static_redirects_file`, if given, points at a site-owned JSON map of legacy
    source paths to current page paths (builder/staticredirects.py, decisions/ WP2
    entry) — a build with no file given emits no alias pages at all, unchanged from
    before this parameter existed.
    """
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    for slug in source.page_contents:
        html = render_page(source, slug, mode="publish")
        out_name = "index.html" if slug == "index" else f"{slug}.html"
        (out_dir / out_name).write_text(html, encoding="utf-8", newline="\n")

    if source.theme is not None:
        theme_css = generate_theme_css(source.theme) + _IMG_DIMENSION_LAYOUT_GUARD_CSS
        (out_dir / "theme.css").write_text(theme_css, encoding="utf-8", newline="\n")

    _copy_if_exists(root / "site.css", out_dir / "site.css")
    _copy_if_exists(root / "site.js", out_dir / "site.js")
    images_src = root / "images"
    if images_src.is_dir():
        shutil.copytree(images_src, out_dir / "images")

    (out_dir / "robots.txt").write_text(
        generate_robots_txt(domain=source.project.domain, indexable=source.project.indexable),
        encoding="utf-8",
        newline="\n",
    )
    if source.project.indexable:
        sitemap = generate_sitemap_xml(
            domain=source.project.domain, slugs=list(source.page_contents)
        )
        (out_dir / "sitemap.xml").write_text(sitemap, encoding="utf-8", newline="\n")

    (out_dir / "404.html").write_text(_generate_404_html(source), encoding="utf-8", newline="\n")

    if static_redirects_file is not None:
        redirects = load_static_redirects(static_redirects_file)
        validate_static_redirects(
            redirects,
            page_slugs=set(source.page_contents),
            location=str(static_redirects_file),
        )
        for filename, page_html in generate_redirect_pages(
            redirects,
            domain=source.project.domain,
            indexable=source.project.indexable,
            locale=source.project.locale,
            site_name=source.project.name,
        ).items():
            (out_dir / filename).write_text(page_html, encoding="utf-8", newline="\n")

    fingerprints = fingerprint_asset_references(out_dir)
    unfingerprinted = find_unfingerprinted_asset_references(out_dir, fingerprints)
    if unfingerprinted:
        html_name, value = unfingerprinted[0]
        raise BuildError(
            f"post-build check: '{value}' in '{html_name}' references a fingerprinted "
            "shared asset by name but was not rewritten — builder/assetcache.py only "
            'matches an exact bare href/src (e.g. href="site.css"), not a leading-slash '
            'or relative-prefixed form (e.g. href="/site.css")',
            location=str(out_dir / html_name),
        )

    _self_check(source, out_dir)


def _generate_404_html(source: SiteSource) -> str:
    """A minimal, theme-aware 404 page (spec/04-server.md §3: "styled 404.html
    (builder emits one...)"). Not content-file-driven — there's no per-project copy to
    author here (no `content/404.json`), so unlike every other page this is a fixed,
    builder-generated template, unaffected by draft/publish content, the same way
    `robots.txt`/`sitemap.xml` are generated rather than templated."""
    theme_link = '<link rel="stylesheet" href="theme.css">\n' if source.theme is not None else ""
    return (
        "<!DOCTYPE html>\n"
        f'<html lang="{source.project.locale}">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        "<title>Page not found</title>\n"
        '<meta name="robots" content="noindex">\n'
        f"{theme_link}"
        '<link rel="stylesheet" href="site.css">\n'
        "</head>\n"
        "<body>\n"
        '<main style="text-align:center;padding:4rem 1rem;">\n'
        "<h1>Page not found</h1>\n"
        "<p>Sorry, we couldn&#8217;t find that page.</p>\n"
        '<p><a href="/">Return home</a></p>\n'
        "</main>\n"
        "</body>\n"
        "</html>\n"
    )


def _copy_if_exists(src: Path, dst: Path) -> None:
    if src.exists():
        shutil.copyfile(src, dst)


def _self_check(source: SiteSource, out_dir: Path) -> None:
    """Every page present, referenced image assets exist, HTML parses (04 §5 step 4)."""
    for slug, content in source.page_contents.items():
        out_name = "index.html" if slug == "index" else f"{slug}.html"
        path = out_dir / out_name
        if not path.exists():
            raise BuildError(
                f"post-build check: '{out_name}' was not written", location=str(out_dir)
            )
        html = path.read_text(encoding="utf-8")
        BeautifulSoup(html, "html5lib")

        for key_path, src in scan_image_refs(content):
            if not (out_dir / src).exists():
                raise BuildError(
                    f"post-build check: referenced image '{src}' is missing from the build",
                    location=f"content/{slug}.json:{key_path}",
                )


def hash_output_tree(out_dir: Path) -> str:
    """A deterministic hash of an entire built output tree (determinism test, 08 §1)."""
    hasher = hashlib.sha256()
    for path in sorted(out_dir.rglob("*")):
        if path.is_file():
            hasher.update(path.relative_to(out_dir).as_posix().encode("utf-8"))
            hasher.update(path.read_bytes())
    return hasher.hexdigest()
