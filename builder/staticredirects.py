"""Static redirect-alias pages, for hosts that cannot serve a real HTTP redirect —
GitHub Pages, chiefly (spec/07-hosting-deploy.md, decisions/ WP2 entry). Generates a
minimal HTML page per legacy source path that meta-refreshes and canonicals to a
current site page, so a retired URL still lands a visitor (and a crawler) on the right
content.

Named "static redirect" throughout, never "301" or "redirect" alone, on purpose: this
is NOT an HTTP redirect. GitHub Pages cannot serve one; see Google's own documented
distinction (https://developers.google.com/search/docs/crawling-indexing/301-redirects).
`wixy_server/redirects.py` is the real, server-side 301 facility for hosts that CAN
redirect (the fleet's own Wixy deployment, a future standalone edition) — a materially
different mechanism with its own module, not reused here: beyond the shared "is this a
flat string-to-string JSON object" shape check, the two validate against unrelated
rules (this module's traversal/collision/loop/slug-shape checks have no server-side
analogue), and `builder` takes no dependency on `wixy_server` (the reverse is the only
allowed import direction — `builder` stays importable standalone).

Opt-in only (`builder/cli.py`'s `--static-redirects-file`, `build_site`'s
`static_redirects_file` keyword): a build given no redirects file emits no alias files
at all and behaves exactly as before this feature existed.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

from builder.errors import BuildError

RedirectMap = dict[str, str]

# One shared lexical grammar for both source and target: root ("/") or a single
# path segment, lowercase-and-digits-and-hyphens only — matching the page-slug charset
# this engine already uses (spec/02-content-model.md §7: "Slugs are [a-z0-9-]+"), plus
# the bare-root shape `page_url("index")` emits. No scheme/authority/query/fragment,
# no nested path. Checked with `fullmatch`, never `match`+`^...$`: in Python, `$`
# matches immediately before a trailing `\n`, so `re.match(r"^/home$", "/home\n")`
# would WRONGLY succeed — a value containing a character outside the allowed charset
# sneaking past an apparently-anchored check (confirmed empirically: `.match()` lets
# a trailing-newline variant through; `.fullmatch()` correctly rejects it). Deliberately
# a REJECT, not a normalize: an uppercase, percent-encoded, whitespace-padded, or
# nested-path form fails this match outright rather than being silently coerced into a
# "clean" one, which could otherwise let a crafted value evade the collision/traversal
# checks below by construction (e.g. `%2e%2e`, `/Home`, or a trailing `\n` never
# reaching the string-equality checks that assume an already-canonical form).
_PATH_RE = re.compile(r"/(?:[a-z0-9-]+)?")


def _is_valid_path(value: str) -> bool:
    return _PATH_RE.fullmatch(value) is not None


# Reserved build-output basenames a redirect source must never collide with, beyond
# the real page slugs checked separately. `404` is the only same-EXTENSION collision
# risk today (`build.py` always writes `404.html`) — `site`/`theme`/`robots`/`sitemap`
# as bare alias slugs are harmless (they'd collide only with `site.css`/`theme.css`/
# `robots.txt`/`sitemap.xml`, a different extension, hence a different filename).
_RESERVED_SLUGS = frozenset({"404"})


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """`object_pairs_hook` for `json.loads` — the stdlib JSON decoder silently keeps
    only the LAST occurrence of a duplicate object key (confirmed empirically:
    `json.loads('{"/home": "/", "/home": "/contact"}')` returns `{"/home": "/contact"}`
    with no warning), which is exactly the kind of silent-surprise behavior this
    module's strict-reject/no-normalization contract (Inv 36) exists to rule out — a
    copy-paste duplicate in the redirects file should be a build error, not a quiet
    last-wins."""
    seen: set[str] = set()
    for key, _ in pairs:
        if key in seen:
            raise ValueError(f"duplicate key {key!r}")
        seen.add(key)
    return dict(pairs)


def load_static_redirects(path: Path) -> RedirectMap:
    """Reads a static-redirect JSON map (`{"/old-path": "/new-path", ...}`) — shape
    only; `validate_static_redirects` below checks it against the actual site.

    Raises `BuildError` (fatal — this is operator-supplied deployment config, the same
    fail-fast severity `wixy_server.redirects.load_redirects` gives its own config
    file) on anything not a flat string-to-string JSON object with no duplicate keys.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise BuildError(f"could not read: {exc}", location=str(path)) from exc
    try:
        data = json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except json.JSONDecodeError as exc:
        raise BuildError(f"not valid JSON: {exc}", location=str(path)) from exc
    except ValueError as exc:
        raise BuildError(f"redirects map has a {exc}", location=str(path)) from exc
    if not isinstance(data, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in data.items()
    ):
        raise BuildError(
            "must be a flat JSON object mapping string paths to string paths",
            location=str(path),
        )
    return data


def validate_static_redirects(
    redirects: RedirectMap, *, page_slugs: set[str], location: str
) -> None:
    """Validates an already-loaded map against the site's real pages.

    `page_slugs` is every real page slug this build knows about
    (`SiteSource.page_contents.keys()` — `"index"` included, representing `/`).

    Raises `BuildError` (fatal) on the first problem found, `location`-tagged (the
    redirects file's own path) so the error names the config, not just "somewhere in
    the build". Checked per entry, in order: source shape, source-is-not-root
    (aliasing FROM the homepage makes no sense — it already exists), source/real-page
    collision (checked against the exact `<slug>.html` filename the build would emit,
    so this also catches a source that would collide with a real page's own output
    file, not merely its content-model slug), source/reserved-name collision, target
    shape, target resolves to a real page. That last check alone also rules out chains
    and loops — an alias source can never itself be a valid target, since it's already
    been proven disjoint from every real page slug by the two collision checks just
    before it, so "target must be a real page slug" and "target must not be another
    alias" are the same rule.
    """
    for source, target in redirects.items():
        if not _is_valid_path(source):
            raise BuildError(
                f"redirect source {source!r} must be a root-relative internal path "
                "matching /[a-z0-9-]+ — no scheme/authority/query/fragment, no "
                "trailing slash, no .html suffix, no nested path, no traversal, no "
                "percent-encoding, uppercase, or trailing whitespace/newline "
                "(rejected outright, never normalized)",
                location=location,
            )
        if source == "/":
            raise BuildError(
                'redirect source "/" is the homepage itself — it already exists '
                "and cannot be aliased from",
                location=location,
            )
        source_slug = source[1:]
        if f"{source_slug}.html" in {f"{s}.html" for s in page_slugs}:
            raise BuildError(
                f"redirect source {source!r} would emit {source_slug}.html, which "
                "collides with an existing page's own output file — a static "
                "redirect alias must never shadow real content",
                location=location,
            )
        if source_slug in _RESERVED_SLUGS:
            raise BuildError(
                f"redirect source {source!r} collides with a reserved build output name",
                location=location,
            )
        if not _is_valid_path(target):
            raise BuildError(
                f"redirect target {target!r} (for source {source!r}) must be a "
                'root-relative internal path matching /[a-z0-9-]+ (or exactly "/") '
                "— external URLs are rejected; this facility redirects to CURRENT "
                "pages on THIS site only",
                location=location,
            )
        target_slug = "index" if target == "/" else target[1:]
        if target_slug not in page_slugs:
            raise BuildError(
                f"redirect target {target!r} (for source {source!r}) does not resolve "
                "to a real page — either a typo, or it points at another alias source "
                "(chains/loops are rejected; every target must be a real page)",
                location=location,
            )


def generate_redirect_pages(
    redirects: RedirectMap,
    *,
    domain: str,
    indexable: bool,
    locale: str,
    site_name: str,
) -> dict[str, str]:
    """Returns `{"<slug>.html": "<full html>", ...}` for the caller to write into the
    build output directory (same directory every real page's `<slug>.html` lands in —
    this is what makes the alias resolve through the exact same extensionless-URL path
    as a real page: `builder.serving.resolve_site_path` doesn't distinguish how a file
    got there). Deterministic: iterates `sorted(redirects)`, never raw dict/JSON order.

    Each page is a zero-delay `meta http-equiv="refresh"`, a `<link rel="canonical">`
    to the absolute target URL, and a plain-language fallback with a real crawlable
    `<a href>` — works with JavaScript disabled (the refresh meta tag doesn't need JS
    either; the fallback text+link is belt-and-braces for a UA that honors neither).
    Carries `noindex` when the build itself is non-indexable, mirroring every other
    page (spec/02 §7) — an indexable build leaves it off so the canonical tag can do
    its equity-passing job, the entire point of this facility on the public site.

    No query string or URL fragment from the original request reaches the target: this
    is deliberately deterministic, script-free HTML for RETIRED-PATH equivalence, not
    a general redirect proxy — the old Wix marketing URLs this exists for carry no
    known, mapped query/fragment semantics worth preserving, so nothing here reads or
    forwards `location.search`/`location.hash`. Both interpolation sites (the meta
    refresh's `url=` and the fallback `<a href>`) derive from the SAME validated
    `target` string and are HTML-escaped independently at their own call site, rather
    than sharing one pre-escaped value — `target` is already constrained by
    `validate_static_redirects` to the same root-or-single-segment grammar as
    `_PATH_RE`, so nothing here actually needs escaping in practice, but each site
    escapes anyway rather than assuming a future relaxation of that constraint stays
    safe by accident.
    """
    pages: dict[str, str] = {}
    for source in sorted(redirects):
        target = redirects[source]
        absolute_target = f"https://{domain}{target}"
        noindex_meta = '<meta name="robots" content="noindex">\n' if not indexable else ""
        html_out = (
            "<!DOCTYPE html>\n"
            f'<html lang="{html.escape(locale)}">\n'
            "<head>\n"
            '<meta charset="utf-8">\n'
            f'<meta http-equiv="refresh" content="0; url={html.escape(target)}">\n'
            f'<link rel="canonical" href="{html.escape(absolute_target)}">\n'
            f"{noindex_meta}"
            f"<title>Redirecting… — {html.escape(site_name)}</title>\n"
            "</head>\n"
            "<body>\n"
            "<p>This page has moved. If you are not redirected automatically, "
            f'<a href="{html.escape(target)}">follow this link</a>.</p>\n'
            "</body>\n"
            "</html>\n"
        )
        pages[f"{source[1:]}.html"] = html_out
    return pages
