"""`/healthz`, `/internal/ready`, `/internal/warmup` (spec/04-server.md §9-10).

Loopback-only: the tunnel forwards EVERY path of `ca.cinnamons.uk` to this process
(the Access app only scopes `/admin*`, spec/07 §3), so without an explicit guard here
Wixy would be the first fleet service to expose its internal surface to the raw
internet. Any request carrying a Cloudflare edge header (`Cf-Ray`/`Cf-Connecting-Ip`)
gets a 404 — real loopback probes (Slots smoke, Devfleet health) never carry those.
"""

from __future__ import annotations

from datetime import UTC, datetime

import anyio
from fastapi import APIRouter, HTTPException, Request

from builder.config import ProjectConfig
from wixy_server.checkout import CheckoutError, ensure_checkout
from wixy_server.live_pointer import load_live_pointer
from wixy_server.storage import ProjectPaths
from wixy_server.watcher import WatcherStatus

router = APIRouter()

_CF_EDGE_HEADERS = ("cf-ray", "cf-connecting-ip")


def _reject_edge_traffic(request: Request) -> None:
    if any(h in request.headers for h in _CF_EDGE_HEADERS):
        raise HTTPException(status_code=404)


def _check_ready(paths: ProjectPaths) -> bool:
    """ "Pointer loaded" (spec/04 §10) means the code path that reads `live.json`
    doesn't error — NOT that a build has been published yet (spec/04 §3 explicitly
    treats "no live.json" as a real, transient, non-crashing state, not an unready
    server)."""
    load_live_pointer(paths)  # raises only on a genuine read/parse failure
    return True


@router.get("/internal/ready")
async def get_ready(request: Request) -> dict[str, bool]:
    _reject_edge_traffic(request)
    paths: ProjectPaths = request.app.state.paths
    ready = await anyio.to_thread.run_sync(_check_ready, paths)
    return {"ready": ready}


@router.get("/healthz")
async def get_healthz(request: Request) -> dict[str, bool]:
    """Alias of `/internal/ready` (spec/04 §9) — the Slots/Devfleet probe path."""
    return await get_ready(request)


def _warm(project: ProjectConfig, paths: ProjectPaths, watcher_status: WatcherStatus) -> None:
    """Unlike `fetch_once` (used by the background watcher, which must never let a
    transient fetch failure crash the loop — spec/04 §7's "degrade gracefully"),
    warmup's whole job is to report whether the pre-load actually succeeded, so this
    calls `ensure_checkout` directly and lets a genuine failure propagate as
    `CheckoutError` for the route to map to a 503."""
    load_live_pointer(paths)
    ensure_checkout(project.repo, project.default_branch, paths.repo)
    watcher_status.fetched_at = datetime.now(UTC)
    watcher_status.last_error = None


@router.post("/internal/warmup")
async def post_warmup(request: Request) -> dict[str, bool]:
    """Pre-load the live pointer + fetch the checkout once, synchronously, before
    Slots flips traffic to this slot (spec/04 §10, the fleet warmup pattern). Building
    the builder itself is already warm by the time any request can reach this route —
    every module it needs was imported at process startup, not lazily."""
    _reject_edge_traffic(request)
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    watcher_status: WatcherStatus = request.app.state.watcher_status
    try:
        await anyio.to_thread.run_sync(_warm, project, paths, watcher_status)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"warm": True}
