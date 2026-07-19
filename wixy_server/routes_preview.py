"""`GET /admin/preview/{page}.html` (spec/04-server.md §4) — the draft preview render.
Moved out of `app.py` into its own router now that slice 4 adds several more route
groups (decisions/00014); no behavior change from slice 3.

spec/04 §7 also assigns this route the upstream watcher's on-demand trigger:
"fetch origin ... immediately before preview loads after >10s staleness" — this is
what's SUPPOSED to make an AI-lane merge show up in the draft preview promptly,
rather than waiting for the periodic 60s tick. That half was never actually built
(only the periodic loop and the always-fetch-before-publish existed) until milestone
9 slice 5's own E2E 6 needed exactly this to make an upstream commit observable
within a test's timeframe — decisions/00030."""

from __future__ import annotations

from datetime import UTC, datetime

import anyio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from builder.config import ProjectConfig
from builder.errors import BuildError
from wixy_server.checkout import CheckoutError, current_sha
from wixy_server.merged_content import merge_overlay
from wixy_server.overlay import load_overlay
from wixy_server.preview import render_preview_page
from wixy_server.site_source import build_site_source
from wixy_server.storage import ProjectPaths
from wixy_server.treelock import tree_lock
from wixy_server.watcher import WatcherStatus, fetch_once

router = APIRouter()

# `create_app`'s own default — a real project's threshold. Overridable per-app
# (mirroring `watcher_interval_s`'s existing pattern) so the E2E fixture server
# can tune it near-zero for a deterministic, fast "upstream commit becomes
# visible" test rather than a real 10+s sleep — decisions/00030.
DEFAULT_PREVIEW_STALENESS_THRESHOLD_S = 10.0


def _watcher_status_is_stale(status: WatcherStatus, threshold_s: float) -> bool:
    if status.fetched_at is None:
        return True
    age_s = (datetime.now(UTC) - status.fetched_at).total_seconds()
    return age_s > threshold_s


def _build_preview_html(project: ProjectConfig, paths: ProjectPaths, slug: str) -> str:
    """The full per-request preview pipeline — synchronous/blocking (filesystem +
    git rev-parse + HTML parsing). Callers on the event loop must run this via
    `anyio.to_thread.run_sync` (spec/04 §8: "no route blocks the event loop")."""
    with tree_lock():  # read-consistency vs watcher/publish mutations (treelock.py)
        source = build_site_source(project, paths.repo)
        base_sha = current_sha(paths.repo)
        overlay = load_overlay(paths.draft_overlay, default_base_sha=base_sha)
        merged = merge_overlay(source, overlay)
    return render_preview_page(merged, slug)


@router.get("/admin/preview/{page}.html", response_class=HTMLResponse)
async def get_preview_page(page: str, request: Request) -> HTMLResponse:
    current_project: ProjectConfig = request.app.state.project
    current_paths: ProjectPaths = request.app.state.paths
    watcher_status: WatcherStatus = request.app.state.watcher_status
    staleness_threshold_s: float = request.app.state.preview_staleness_threshold_s
    if _watcher_status_is_stale(watcher_status, staleness_threshold_s):
        # Best-effort — `fetch_once` already degrades gracefully on its own
        # (network failure, or a publish holding the checkout) and this route's
        # job is to serve a preview either way, not to surface fetch health.
        await anyio.to_thread.run_sync(fetch_once, current_project, current_paths, watcher_status)
    try:
        html = await anyio.to_thread.run_sync(
            _build_preview_html, current_project, current_paths, page
        )
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except BuildError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})
