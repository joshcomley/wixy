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
answers any `?v=`-carrying request `immutable`; unfingerprinted requests (the
transitional window before a stale cached HTML page itself revalidates, at most one
HTML cache lifetime later) keep the existing 24h default, unchanged.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

_FINGERPRINT_LENGTH = 10
FINGERPRINTED_ASSET_NAMES = ("site.css", "site.js", "theme.css")


def content_fingerprint(path: Path) -> str:
    """Short content hash for a static asset — changes iff the file's bytes change."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:_FINGERPRINT_LENGTH]


def fingerprint_asset_references(out_dir: Path) -> None:
    """Rewrite every `href="<name>"` / `src="<name>"` reference to `...?v=<hash>` across
    every `*.html` file directly under `out_dir`, for each name in
    `FINGERPRINTED_ASSET_NAMES` that actually has a file there. A name with no file
    (e.g. a project with no theme) is left bare — nothing references it either, since
    the builder only ever emits a `<link>` for a theme it actually generated.

    Attribute-anchored (`href="…"` / `src="…"`, not a bare substring) so this can never
    touch unrelated text that happens to equal an asset's filename.
    """
    fingerprints = {
        name: content_fingerprint(candidate)
        for name in FINGERPRINTED_ASSET_NAMES
        if (candidate := out_dir / name).is_file()
    }
    if not fingerprints:
        return
    for html_path in out_dir.glob("*.html"):
        text = html_path.read_text(encoding="utf-8")
        rewritten = text
        for name, fingerprint in fingerprints.items():
            pattern = re.compile(rf'((?:href|src)=)"{re.escape(name)}"')
            rewritten = pattern.sub(rf'\1"{name}?v={fingerprint}"', rewritten)
        if rewritten != text:
            html_path.write_text(rewritten, encoding="utf-8", newline="\n")
