"""Nav derivation (spec/02-content-model.md §3). `@nav` is never stored — the builder
computes it from each page's `meta.inNav`/`meta.navOrder` plus `_global.json.navExtra`
and injects it into the resolved global content before validation/rendering, so
`data-wx-list="@nav"` resolves like any other key.
"""

from __future__ import annotations

from builder.jsontypes import JsonObject, JsonValue


def page_url(slug: str) -> str:
    """The home page's slug is `index` everywhere; its published URL is `/` (02 §3)."""
    return "/" if slug == "index" else f"/{slug}.html"


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
