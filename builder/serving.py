"""Extensionless URL resolution (decisions/00128), shared by the dev server
(`builder/cli.py:cmd_serve`) and the production server (`wixy_server/routes_public.py`)
so the two can never drift apart (the hand-synced-pair failure mode Inv 20 already
warns about elsewhere in this codebase) — one algorithm, one set of tests.

GitHub Pages resolves `/about` to `about.html` with no redirect, and does not serve a
directory listing/index for `/about/` (verified live against a real Pages deployment).
`resolve_site_path` reproduces exactly that so wixy's own serving (dev and prod) always
agrees with what the public Pages deployment does.
"""

from __future__ import annotations

from pathlib import Path


def _resolve_literal(directory: Path, relative: str) -> Path | None:
    """`None` when `relative` doesn't name a real file under `directory`, or would
    resolve outside it (path-traversal guard) — callers serve a 404 either way, so the
    two cases don't need to be distinguished here. `directory` must already be
    resolved (`Path.resolve()`) — callers resolve it once and reuse it across calls."""
    candidate = (directory / relative).resolve()
    try:
        candidate.relative_to(directory)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def resolve_site_path(directory: Path, request_path: str) -> Path | None:
    """Map a request path to a file under `directory`, or `None` if there isn't one.

    Resolution order: (1) the literal path (`/about.html` -> `about.html`, `/` ->
    `index.html`, `/site.css` -> `site.css`); (2) if that misses AND `request_path`
    doesn't end in `/` AND its final segment has no `.`, retry with `.html` appended
    (`/about` -> `about.html`, `/index` -> `index.html`) — this is what makes clean
    URLs resolve with zero redirects. A trailing slash (`/about/`) or an
    already-extensioned miss (a genuinely missing asset like `/images/x.jpg`) never
    gets the `.html` retry, so both deliberately still 404 — matching GitHub Pages,
    which does the same (no directory-index fallback either).
    """
    directory_resolved = directory.resolve()
    relative = request_path.lstrip("/") or "index.html"
    resolved = _resolve_literal(directory_resolved, relative)
    if resolved is not None:
        return resolved
    final_segment = request_path.rsplit("/", 1)[-1]
    if request_path.endswith("/") or "." in final_segment:
        return None
    return _resolve_literal(directory_resolved, f"{relative}.html")
