"""Public site serving (spec/04-server.md §3): files from `live.json`'s build dir,
resolved fresh per request via the atomic pointer (no server restart after a publish —
there's no in-process cache to invalidate, see `live_pointer`'s own docstring).

Registered LAST in `app.py` — `GET /{path:path}` is a catch-all and must never shadow
`/admin*`, `/api/*`, `/internal/*`, `/healthz`, or the `/admin/static` mount.

Also serves the redirects facility (spec/independence/01 §2.2, 03 §2): a request path
found in `app.state.redirects` gets a 301 before any file resolution is attempted, so
it applies even when there's no live pointer yet (a pure URL-routing decision, not a
publish-state one).

Clean URLs (decisions/00128): `_resolve_within_build_dir` resolves an extensionless
path (`/about`) to `about.html` with no redirect, matching GitHub Pages' own behavior —
see `builder.serving.resolve_site_path`, the shared implementation this and the dev
server (`builder/cli.py:cmd_serve`) both delegate to.
"""

from __future__ import annotations

from pathlib import Path

import anyio
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse, Response

from builder.serving import resolve_site_path
from wixy_server.live_pointer import LivePointer, load_live_pointer
from wixy_server.redirects import RedirectMap, resolve_redirect
from wixy_server.storage import ProjectPaths

router = APIRouter()

_HTML_CACHE_CONTROL = "public, max-age=300"
_ASSET_CACHE_CONTROL = "public, max-age=86400"
_FINGERPRINTED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"


def _resolve_within_build_dir(build_dir: Path, request_path: str) -> Path | None:
    """Thin name-preserving wrapper — see `builder.serving.resolve_site_path` for the
    actual algorithm (shared with the dev server) and its docstring for the resolution
    contract (extensionless fallback + path-traversal guard)."""
    return resolve_site_path(build_dir, request_path)


def _cache_control_for(path: Path, *, fingerprinted: bool) -> str:
    """`fingerprinted` (a `?v=` query param present) means this exact URL's bytes can
    never change (builder/assetcache.py: a rebuild changes the hash, hence the URL) —
    safe to cache for a year. Without it, `site.css`/`site.js`/`theme.css` keep the
    same 24h default as any other asset; that only ever serves a transitional request
    from a stale HTML page in the (at most 300s) window before it itself revalidates
    and picks up the new fingerprinted references — decisions/00130."""
    if path.suffix == ".html":
        return _HTML_CACHE_CONTROL
    if fingerprinted:
        return _FINGERPRINTED_ASSET_CACHE_CONTROL
    return _ASSET_CACHE_CONTROL


def _load_pointer(paths: ProjectPaths) -> LivePointer | None:
    return load_live_pointer(paths)


async def _serve(
    paths: ProjectPaths, redirects: RedirectMap, request_path: str, *, fingerprinted: bool
) -> Response:
    target = resolve_redirect(redirects, request_path)
    if target is not None:
        return RedirectResponse(target, status_code=301)

    pointer = await anyio.to_thread.run_sync(_load_pointer, paths)
    if pointer is None:
        # spec/04 §3: no live.json yet (pre-bootstrap) -> plain 503, never a crash.
        return PlainTextResponse("Site not yet published", status_code=503)

    resolved = await anyio.to_thread.run_sync(
        _resolve_within_build_dir, pointer.build_dir, request_path
    )
    if resolved is not None:
        cache_control = _cache_control_for(resolved, fingerprinted=fingerprinted)
        return FileResponse(resolved, headers={"Cache-Control": cache_control})

    not_found = await anyio.to_thread.run_sync(
        _resolve_within_build_dir, pointer.build_dir, "/404.html"
    )
    if not_found is not None:
        return FileResponse(not_found, status_code=404, headers={"Cache-Control": "no-store"})
    return PlainTextResponse("Not found", status_code=404)


@router.api_route("/", methods=["GET", "HEAD"])
async def get_root(request: Request) -> Response:
    """`@router.get` alone does NOT add HEAD support (spec/04 §3: "HEAD supported") —
    FastAPI/Starlette only auto-derives HEAD from a GET route when you register both
    explicitly via `api_route`/`methods=`, it isn't implicit."""
    paths: ProjectPaths = request.app.state.paths
    redirects: RedirectMap = request.app.state.redirects
    return await _serve(paths, redirects, "/", fingerprinted="v" in request.query_params)


@router.api_route("/{path:path}", methods=["GET", "HEAD"])
async def get_path(path: str, request: Request) -> Response:
    paths: ProjectPaths = request.app.state.paths
    redirects: RedirectMap = request.app.state.redirects
    return await _serve(paths, redirects, f"/{path}", fingerprinted="v" in request.query_params)
