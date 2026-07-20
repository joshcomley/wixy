"""Content-fingerprinted URLs + cache headers for the committed frontend bundles.

The admin shell and the preview's injected editor assets are static files that
CHANGE whenever the TS bundles are rebuilt and redeployed, but Starlette's
StaticFiles only emits ETag/Last-Modified — no Cache-Control — so browsers apply
heuristic caching (RFC 7234 §4.2.2, a fraction of the file's age) and can keep
serving a stale bundle for days after a deploy. That bit in production
(decisions/00069): a merged, deployed admin-ui change was invisible on the
operator's phone until a manual hard refresh.

The pattern applied here:

- every `/admin/static/*` URL referenced from served HTML carries a
  `?v=<content hash>` fingerprint, so a rebuilt bundle is a NEW URL no cache
  layer (browser, CF edge) can have a stale entry for;
- the static mount answers fingerprinted requests `immutable` — the bytes
  behind a given `?v=` never change — while unfingerprinted requests keep
  StaticFiles' default ETag/Last-Modified behaviour;
- the admin shell itself is served `Cache-Control: no-cache` (app.py), so a new
  deploy's new fingerprints are picked up on the next navigation.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

_FINGERPRINT_LENGTH = 10
_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"


def content_fingerprint(path: Path) -> str:
    """Short content hash for a static asset — changes iff the file's bytes change."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:_FINGERPRINT_LENGTH]


def fingerprinted_url(base_url_path: str, file_path: Path) -> str:
    """`base_url_path?v=<content hash of file_path>`.

    A missing file yields the bare path (no fingerprint): the app must still
    start (a broken checkout has bigger problems than caching), just without
    the cache-busting guarantee for that asset.
    """
    try:
        fingerprint = content_fingerprint(file_path)
    except OSError:
        return base_url_path
    return f"{base_url_path}?v={fingerprint}"


class FingerprintedStaticFiles(StaticFiles):
    """StaticFiles that marks fingerprinted (`?v=…`) responses immutable.

    The fingerprint guarantees the bytes behind that exact URL+query never
    change (a rebuild changes the hash and therefore the URL), so a year-long
    immutable cache is safe. Requests without the query get StaticFiles'
    default headers — unchanged behaviour for every existing caller.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 200 and b"v=" in scope["query_string"]:
            response.headers["Cache-Control"] = _IMMUTABLE_CACHE_CONTROL
        return response
