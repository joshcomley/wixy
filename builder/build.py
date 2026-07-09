"""Full-site build: renders every page + assets into an output directory, then runs the
post-build self-check (spec/04-server.md §5 step 4).
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from bs4 import BeautifulSoup

from builder.content import scan_image_refs
from builder.errors import BuildError
from builder.render import SiteSource, render_page
from builder.sitemap import generate_robots_txt, generate_sitemap_xml
from builder.theme import generate_theme_css


def build_site(root: Path, source: SiteSource, out_dir: Path) -> None:
    """Build the full site from `root` (the site repo checkout) into `out_dir`."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    for slug in source.page_contents:
        html = render_page(source, slug, mode="publish")
        out_name = "index.html" if slug == "index" else f"{slug}.html"
        (out_dir / out_name).write_text(html, encoding="utf-8", newline="\n")

    if source.theme is not None:
        (out_dir / "theme.css").write_text(
            generate_theme_css(source.theme), encoding="utf-8", newline="\n"
        )

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
