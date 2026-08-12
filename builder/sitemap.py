"""`sitemap.xml` + `robots.txt` generation (spec/02-content-model.md §7).

Indexability is a build input (project registry `indexable`): while false, `robots.txt`
allows crawling with no `Sitemap:` directive and `sitemap.xml` is omitted entirely — every
page's own `noindex` meta tag (handled in `templates.apply_head`) is what actually keeps a
non-indexable build out of search results. A crawl BLOCK (`Disallow: /`) is deliberately not
used for this: Google's crawler must be able to fetch a page to see its `noindex` directive
in the first place (decisions/00135) — blocking the crawl makes the `noindex` unobservable
and can let a blocked-but-linked URL appear in results with no snippet, the opposite of the
intent. `robots.txt` is crawl control, never privacy; a publicly reachable non-indexable
build stays public, just excluded from indexing by an observable per-page signal.
"""

from __future__ import annotations

from xml.sax.saxutils import escape

from builder.nav import page_url


def generate_robots_txt(*, domain: str, indexable: bool) -> str:
    if not indexable:
        return "User-agent: *\nAllow: /\n"
    return f"User-agent: *\nAllow: /\nSitemap: https://{domain}/sitemap.xml\n"


def generate_sitemap_xml(*, domain: str, slugs: list[str]) -> str:
    entries = [
        f"  <url><loc>{escape(f'https://{domain}{page_url(slug)}')}</loc></url>"
        for slug in sorted(slugs)
    ]
    body = "\n".join(entries)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{body}\n"
        "</urlset>\n"
    )
