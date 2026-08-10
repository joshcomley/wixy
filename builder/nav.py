"""Nav derivation (spec/02-content-model.md §3). `@nav` is never stored — the builder
computes it from each page's `meta.inNav`/`meta.navOrder` plus `_global.json.navExtra`
and injects it into the resolved global content before validation/rendering, so
`data-wx-list="@nav"` resolves like any other key.
"""

from __future__ import annotations

from builder.jsontypes import JsonObject, JsonValue


def page_url(slug: str) -> str:
    """The home page's slug is `index` everywhere; its published URL is `/` (02 §3).

    Every other page's URL is extensionless (`/<slug>`, no `.html`) — decisions/00128
    supersedes spec/02 §3's original `/<slug>.html` convention. The build still writes
    `<slug>.html` files to disk (`build.py`); both `wixy_server`'s public route and
    GitHub Pages itself resolve the extensionless form to that file with no redirect
    (`builder.serving.resolve_site_path`), so the old `.html`-suffixed URL keeps
    working too — this function only controls what the engine *emits* (nav hrefs,
    canonical/og:url, sitemap `<loc>`), never what it *accepts*.
    """
    return "/" if slug == "index" else f"/{slug}"


def build_nav(page_contents: dict[str, JsonObject], global_content: JsonObject) -> list[JsonValue]:
    """Pages with `meta.inNav: true`, ordered by `meta.navOrder`, then `navExtra` items."""
    entries: list[tuple[int, str, JsonObject]] = []
    for slug, content in page_contents.items():
        meta = content.get("meta")
        if not isinstance(meta, dict) or not meta.get("inNav"):
            continue
        nav_order_raw = meta.get("navOrder", 0)
        nav_order = nav_order_raw if isinstance(nav_order_raw, int) else 0
        label_raw = meta.get("navLabel")
        label = label_raw if isinstance(label_raw, str) else slug
        entries.append((nav_order, slug, {"label": label, "href": page_url(slug)}))
    entries.sort(key=lambda e: (e[0], e[1]))
    nav_items: list[JsonValue] = [item for _, _, item in entries]

    extra = global_content.get("navExtra", [])
    if isinstance(extra, list):
        for entry in extra:
            if (
                isinstance(entry, dict)
                and isinstance(entry.get("label"), str)
                and isinstance(entry.get("href"), str)
            ):
                nav_items.append({"label": entry["label"], "href": entry["href"]})
    return nav_items
