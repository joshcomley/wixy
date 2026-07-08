"""The rich-lite HTML sanitizer (spec/02-content-model.md §5).

Allowlist: `a[href,target,rel,class]`, `em`, `strong`, `br`, `span[class]`. `class` values
on `a`/`span` are restricted to a fixed allowlist (v1: `js-book` only — the FAQ answer's
booking-modal trigger link). `href` must be http(s)/mailto/tel/relative. Applied on every
draft write server-side (04 §9) and — belt-and-braces, since it's idempotent — on every
render here, so hand-authored migration content is held to the same bar as editor input.
"""

from __future__ import annotations

import nh3

_TAGS = {"a", "em", "strong", "br", "span"}
_ATTRIBUTES: dict[str, set[str]] = {
    "a": {"href", "target"},
    "span": set(),
    "em": set(),
    "strong": set(),
    "br": set(),
}
_ALLOWED_CLASSES: dict[str, set[str]] = {
    "a": {"js-book"},
    "span": {"js-book"},
}
_URL_SCHEMES = {"http", "https", "mailto", "tel"}
_CLEAN_CONTENT_TAGS = {"script", "style", "iframe", "object", "embed", "noscript"}


def sanitize_rich_lite(html: str) -> str:
    """Sanitize an HTML fragment to the rich-lite allowlist. Idempotent."""
    return nh3.clean(
        html,
        tags=_TAGS,
        attributes=_ATTRIBUTES,
        allowed_classes=_ALLOWED_CLASSES,
        url_schemes=_URL_SCHEMES,
        clean_content_tags=_CLEAN_CONTENT_TAGS,
    )


def is_already_clean(html: str) -> bool:
    """True iff `html` sanitizes to itself (spec/02 §10's validate rule)."""
    return sanitize_rich_lite(html) == html
