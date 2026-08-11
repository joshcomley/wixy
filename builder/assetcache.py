"""Content-fingerprinted URLs for the public site's shared static assets.

`site.css` / `site.js` / `theme.css` are referenced by every page under a bare,
stable filename. `wixy_server/routes_public.py` serves them `Cache-Control: public,
max-age=86400`, so a browser or CDN edge that fetched one before a publish keeps
serving those exact bytes for up to 24h afterwards — a rebuilt asset is invisible
until that cache expires. This is the same failure mode decisions/00069 already
fixed for the admin UI's `/admin/static/*` bundles (`wixy_server/staticcache.py`):
a merged, deployed change was invisible on the operator's phone until a manual hard
refresh.

The pattern applied here, mirroring 00069 exactly: once the final bytes of
`site.css`/`site.js`/`theme.css` are known (after every page is rendered and both
are copied/generated into the build output), every page's bare `href="site.css"` /
`src="site.js"` / `href="theme.css"` reference is rewritten in place to carry a
`?v=<content hash>` fingerprint. A rebuild that changes the bytes changes the hash,
so it's a NEW url — no cache layer can have a stale entry for it. `routes_public.py`
verifies a request's `?v=` value against the file's ACTUAL current hash (not merely
its presence — decisions/00130's audit round 2, F1: presence alone lets a stale
`?v=<old-hash>` replay from a page cached during a publish's propagation window get
the CURRENT bytes served back immutably under that old, now-mismatched URL, which
then poisons that URL for a year against a future publish that legitimately reverts
to the old content) before answering `immutable`; everything else (including a
request for one of these three names with no `?v=`, or one that doesn't match) keeps
the existing 24h default, unchanged.
"""

from __future__ import annotations

import hashlib
import re
import threading
from collections.abc import Iterable
from pathlib import Path

from bs4 import BeautifulSoup

_FINGERPRINT_LENGTH = 10
FINGERPRINTED_ASSET_NAMES = ("site.css", "site.js", "theme.css")

# decisions/00130 audit round 3, F4: `wixy_server/routes_public.py` calls
# `content_fingerprint` on every request that carries a `?v=` for one of these three
# assets, to VERIFY the value before granting an immutable cache header — which means
# every such request re-read-and-re-hashed the whole file, forever, even though the
# bytes only ever change on a publish. Keyed by `(mtime_ns, size)`, not just path, so
# an actual content change (which always changes at least one of those two) is never
# served a stale hash. Bounded in size by the number of distinct paths ever fingerprint-
# checked — in practice just the handful of `FINGERPRINTED_ASSET_NAMES` files per
# project, never attacker-influenced (the cache key is the resolved server-side path,
# not anything in the request).
_fingerprint_cache: dict[Path, tuple[tuple[int, int], str]] = {}
_fingerprint_cache_lock = threading.Lock()

# `(?<![\w-])` rejects a match whose preceding character is alphanumeric/underscore/
# hyphen — i.e. requires "href="/"src=" to start a real attribute (preceded by
# whitespace or a tag-opening "<"), not merely appear as the tail of a longer
# attribute name like "data-href=" or "aria-src=" (decisions/00130 audit round 2, F3:
# the original pattern had no such guard and silently rewrote `data-href="site.css"`
# too — harmless in this codebase today only because `data-wx-href` values are always
# content key paths, never literally one of these filenames, but the code's own
# guarantee was stronger than what it actually did).
_ATTR_START = r"(?<![\w-])"


def content_fingerprint(path: Path) -> str:
    """Short content hash for a static asset — changes iff the file's bytes change.
    Memoized by `(mtime_ns, size)` (decisions/00130 audit round 3, F4) — a cache hit
    skips the file read entirely, so repeated verification requests for an unchanged
    file cost one `stat()`, not a full read + sha256 every time."""
    stat = path.stat()
    stat_key = (stat.st_mtime_ns, stat.st_size)
    with _fingerprint_cache_lock:
        cached = _fingerprint_cache.get(path)
    if cached is not None and cached[0] == stat_key:
        return cached[1]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:_FINGERPRINT_LENGTH]
    with _fingerprint_cache_lock:
        _fingerprint_cache[path] = (stat_key, digest)
    return digest


def fingerprint_asset_references(out_dir: Path) -> dict[str, str]:
    """Rewrite every `href="<name>"` / `src="<name>"` reference to `...?v=<hash>` across
    every `*.html` file directly under `out_dir`, for each name in
    `FINGERPRINTED_ASSET_NAMES` that actually has a file there. A name with no file
    (e.g. a project with no theme) is left bare — nothing references it either, since
    the builder only ever emits a `<link>` for a theme it actually generated.

    Attribute-anchored (`href="…"` / `src="…"` as a real attribute start, not a bare
    substring — see `_ATTR_START`) so this can never touch unrelated text that happens
    to contain an asset's filename.

    Returns the `{name: fingerprint}` map actually used, so a caller can verify (via
    `find_unfingerprinted_asset_references`) that every reference to one of these
    names was actually caught by the rewrite — a `href="/site.css"` or
    `href="./site.css"` (a leading path segment the exact-match pattern above
    deliberately does not touch) would otherwise silently ship unfingerprinted,
    reinstating the original bug with no build-time signal (decisions/00130 audit
    round 2, F2).
    """
    fingerprints = {
        name: content_fingerprint(candidate)
        for name in FINGERPRINTED_ASSET_NAMES
        if (candidate := out_dir / name).is_file()
    }
    if not fingerprints:
        return fingerprints
    for html_path in out_dir.glob("*.html"):
        text = html_path.read_text(encoding="utf-8")
        rewritten = text
        for name, fingerprint in fingerprints.items():
            pattern = re.compile(rf'{_ATTR_START}((?:href|src)=)"{re.escape(name)}"')
            rewritten = pattern.sub(rf'\1"{name}?v={fingerprint}"', rewritten)
        if rewritten != text:
            html_path.write_text(rewritten, encoding="utf-8", newline="\n")
    return fingerprints


def find_unfingerprinted_asset_references(
    out_dir: Path, fingerprinted_names: Iterable[str]
) -> list[tuple[str, str]]:
    """After `fingerprint_asset_references` has run, find any `<link href>` / `<script
    src>` whose value's final path segment is one of `fingerprinted_names` but carries
    no `?v=` — a reference the exact bare-string rewrite above didn't recognise (a
    leading `/` or `./` prefix, for instance) and so left silently unfingerprinted.
    Real HTML parsing (not another regex), so it isn't fooled by attribute quoting or
    ordering the way a second hand-rolled scan could be.

    Returns `(html_filename, raw_attribute_value)` pairs; empty means every
    recognisable reference is safely fingerprinted. `fingerprinted_names` should be
    exactly the keys `fingerprint_asset_references` returned for this same build — a
    name that was never fingerprinted (no file for it) isn't this check's concern.
    """
    known_names = set(fingerprinted_names)
    if not known_names:
        return []
    problems: list[tuple[str, str]] = []
    for html_path in sorted(out_dir.glob("*.html")):
        soup = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html5lib")
        for tag_name, attr in (("link", "href"), ("script", "src")):
            for tag in soup.find_all(tag_name):
                value = tag.get(attr)
                if not isinstance(value, str) or not value:
                    continue
                basename = value.split("?", 1)[0].rsplit("/", 1)[-1]
                if basename in known_names and "?v=" not in value:
                    problems.append((html_path.name, value))
    return problems
