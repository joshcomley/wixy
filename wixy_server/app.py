"""The first Wixy FastAPI app (spec/04-server.md). Slice 3 of the M6 PR train
(decisions/00010) wires exactly one route end-to-end: `GET /admin/preview/{page}.html`
(spec/04 §4). See decisions/00013 for this slice's design choices — most notably that
the site-repo checkout is kept fresh by a background watcher (`wixy_server.watcher`,
spec/04 §7) rather than an inline fetch per request, so the <150ms render budget (§4)
is never spent on a network round trip.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse

from builder.config import ProjectConfig
from builder.errors import BuildError
from builder.render import load_site_source
from builder.theme import Theme, load_theme
from wixy_server.checkout import CheckoutError, current_sha
from wixy_server.merged_content import merge_overlay
from wixy_server.overlay import load_overlay
from wixy_server.preview import render_preview_page
from wixy_server.registry import load_registry
from wixy_server.settings import load_settings
from wixy_server.storage import ProjectPaths, ensure_project_dirs, project_paths
from wixy_server.watcher import DEFAULT_INTERVAL_S, fetch_once, watch_upstream


def _load_theme_if_present(repo_root: Path) -> Theme | None:
    theme_path = repo_root / "theme" / "theme.json"
    return load_theme(theme_path) if theme_path.exists() else None


def _build_preview_html(project: ProjectConfig, paths: ProjectPaths, slug: str) -> str:
    """The full per-request preview pipeline — synchronous/blocking (filesystem +
    git rev-parse + HTML parsing). Callers on the event loop must run this via
    `anyio.to_thread.run_sync` (spec/04 §8: "no route blocks the event loop")."""
    if not (paths.repo / ".git").exists():
        raise CheckoutError("site repo checkout is not ready yet (initial clone pending)")
    base_sha = current_sha(paths.repo)
    overlay = load_overlay(paths.draft_overlay, default_base_sha=base_sha)
    theme = _load_theme_if_present(paths.repo)
    source = load_site_source(paths.repo, project, theme)
    merged = merge_overlay(source, overlay)
    return render_preview_page(merged, slug)


def create_app(
    *,
    storage_root: Path,
    wixy_repo_root: Path,
    watcher_interval_s: float = DEFAULT_INTERVAL_S,
) -> FastAPI:
    """Build the Wixy FastAPI app for one project.

    `storage_root` is the Storage tree root (spec/04 §2) — tests always pass a
    `tmp_path`-backed one; the real production default only exists from milestone 11's
    install onward. `wixy_repo_root` is the wixy repo checkout this process runs from
    (where `projects/*.json` lives, spec/04 §1) — milestone 11's launcher resolves this
    for real; this function never guesses a default for either path.
    """
    settings = load_settings(storage_root)
    registry = load_registry(wixy_repo_root)
    projects = registry.all()
    if len(projects) != 1:
        # spec/04 §1: "v1 runs with exactly one but nothing may assume that" — read as
        # "don't hardcode a slug," not "build multi-project routing that isn't in the
        # spec's own route table" (decisions/00013). A registry with any other count is
        # a real misconfiguration for what this app can serve today.
        raise RuntimeError(
            "wixy_server.app v1 requires exactly one registered project, found "
            f"{len(projects)} ({[p.slug for p in projects]})"
        )
    project = projects[0]
    paths = project_paths(storage_root, project.slug)
    ensure_project_dirs(paths)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Best-effort initial bootstrap (fetch_once already swallows CheckoutError) —
        # spec/04 §3's "never crash" posture applies here too: a transient network
        # failure at startup shouldn't prevent the process from coming up; the
        # background watcher keeps retrying, and the preview route reports 503 until
        # the checkout exists.
        await anyio.to_thread.run_sync(fetch_once, project, paths)

        async def _run_watcher() -> None:
            await watch_upstream(project, paths, interval_s=watcher_interval_s)

        async with anyio.create_task_group() as tg:
            tg.start_soon(_run_watcher)
            yield
            tg.cancel_scope.cancel()

    app = FastAPI(lifespan=lifespan)
    app.state.project = project
    app.state.paths = paths
    app.state.settings = settings

    @app.get("/admin/preview/{page}.html", response_class=HTMLResponse)
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

    return app
