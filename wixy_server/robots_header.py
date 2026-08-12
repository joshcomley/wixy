"""`X-Robots-Tag: noindex` for a non-indexable project's public non-HTML surface
(decisions/00137, docs/ai/invariants.md Inv 37) — the non-HTML sibling of WP1's
per-page HTML `<meta name="robots" content="noindex">` (`builder/templates.py:
apply_head`, decisions/00135).

Google's robots-meta-tag mechanism only reads an HTML `<meta>` tag or an HTTP
response header; it can never observe a `<meta>` tag inside a non-HTML response
body, so an image or a JSON endpoint has no HTML page to carry one. Since PR #199/
decisions/00135 switched non-indexable `robots.txt` from `Disallow: /` to `Allow: /`
(so the HTML `noindex` meta is itself observable), crawling is now open to every
other path on a non-indexable host too — this header closes that gap for the two
kinds of public non-HTML response a non-indexable project actually serves:
published media (`/images/*`) and the public JSON version endpoints (`/api/version`,
`/api/version/notes` — both public by design, Inv 12).

Deliberately narrow, never a blanket "every non-HTML route" middleware: `/admin*`,
`/api/admin*` (already CF-Access-gated) and `/internal/*`, `/healthz` (already 404 to
any externally-headered request, Inv 12) never get this header regardless of
`indexable` — excluded by `_should_tag_noindex` itself, not left to the caller, so a
future addition to `_NOINDEX_JSON_PATHS` can't accidentally widen past that boundary.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import Request
from starlette.responses import Response

from wixy_server.auth import is_admin_path

CallNext = Callable[[Request], Awaitable[Response]]
Middleware = Callable[[Request, CallNext], Awaitable[Response]]

_NOINDEX_JSON_PATHS = frozenset({"/api/version", "/api/version/notes"})


def _should_tag_noindex(path: str) -> bool:
    """True only for the public, non-HTML paths an HTML `noindex` meta tag can't
    reach: published media under `/images/` and the public version JSON endpoints.
    `/admin*`/`/api/admin*`/`/internal/*`/`/healthz` are excluded here, unconditionally
    — the caller never has to remember to exclude them itself."""
    if is_admin_path(path):
        return False
    if path == "/healthz" or path == "/internal" or path.startswith("/internal/"):
        return False
    return path.startswith("/images/") or path in _NOINDEX_JSON_PATHS


def build_robots_header_middleware(*, indexable: bool) -> Middleware:
    """Registered unconditionally in `create_app` (same "construct always, branch on
    config" posture as every other per-project piece of `app.py`) — a pure pass-through
    when `indexable` is `True`, so the public `cottageaesthetics.co.uk` build is never
    touched by this at all.

    Classification is by REQUEST PATH alone (`request.url.path`, never the response
    object) — deliberately, not accidentally: the header is tagged even on a 404/405
    for a path that matches (e.g. a missing `/images/*` file, which falls through to
    the generic 404 page). That is still correct — nothing at that URL should be
    indexed either way — and staying path-only keeps the contract simple: it never has
    to special-case a resolved file's actual content-type or a route's status code."""

    async def middleware(request: Request, call_next: CallNext) -> Response:
        response = await call_next(request)
        if not indexable and _should_tag_noindex(request.url.path):
            response.headers["X-Robots-Tag"] = "noindex"
        return response

    return middleware
