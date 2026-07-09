"""`sitemap.xml` + `robots.txt` generation (spec/02-content-model.md §7).

Indexability is a build input (project registry `indexable`): while false, `robots.txt`
disallows everything and `sitemap.xml` is omitted entirely (the head's per-page
`noindex` meta tag is handled in `templates.apply_head`).
"""

from __future__ import annotations

from xml.sax.saxutils import escape

from builder.nav import page_url


def generate_robots_txt(*, domain: str, indexable: bool) -> str:
    if not indexable:
        return "User-agent: *\nDisallow: /\n"
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
