"""`GET /admin/preview/{page}.html` (spec/04-server.md §4) — the draft preview render.
Moved out of `app.py` into its own router now that slice 4 adds several more route
groups (decisions/00014); no behavior change from slice 3."""

from __future__ import annotations

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

router = APIRouter()


def _build_preview_html(project: ProjectConfig, paths: ProjectPaths, slug: str) -> str:
    """The full per-request preview pipeline — synchronous/blocking (filesystem +
    git rev-parse + HTML parsing). Callers on the event loop must run this via
    `anyio.to_thread.run_sync` (spec/04 §8: "no route blocks the event loop")."""
    source = build_site_source(project, paths.repo)
    base_sha = current_sha(paths.repo)
    overlay = load_overlay(paths.draft_overlay, default_base_sha=base_sha)
    merged = merge_overlay(source, overlay)
    return render_preview_page(merged, slug)


@router.get("/admin/preview/{page}.html", response_class=HTMLResponse)
async def get_preview_page(page: str, request: Request) -> HTMLResponse:
    current_project: ProjectConfig = request.app.state.project
    current_paths: ProjectPaths = request.app.state.paths
    try:
        html = await anyio.to_thread.run_sync(
            _build_preview_html, current_project, current_paths, page
        )
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except BuildError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})
