"""The Wixy FastAPI app (spec/04-server.md). Milestone 6's final slice (slice 4 of the
PR train, decisions/00010) wires: public serving (§3), CF Access JWT (§9), the
`/api/admin/state|content|draft|media(list)` subset (§8), `/internal/*` + `/healthz`
(§9-10), `/api/version` (§9/07 §1), and a minimal instant-render admin shell (§5). See
decisions/00014 for this slice's design choices. Slice 3's preview route
(`GET /admin/preview/{page}.html`) now lives in `wixy_server/routes_preview`.
"""

from __future__ import annotations

import functools
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import httpx
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from wixy_server.auth import JwksCache, build_admin_auth_middleware, jwks_url
from wixy_server.registry import load_registry
from wixy_server.routes_admin_api import router as admin_api_router
from wixy_server.routes_internal import router as internal_router
from wixy_server.routes_preview import router as preview_router
from wixy_server.routes_public import router as public_router
from wixy_server.routes_version import router as version_router
from wixy_server.settings import load_settings
from wixy_server.storage import ensure_project_dirs, project_paths
from wixy_server.watcher import DEFAULT_INTERVAL_S, WatcherStatus, fetch_once, watch_upstream

_STATIC_DIR = Path(__file__).parent / "static"
_ADMIN_SHELL_HTML = (_STATIC_DIR / "admin_shell.html").read_text(encoding="utf-8")


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
    watcher_status = WatcherStatus()

    jwks = JwksCache(
        fetch=functools.partial(_fetch_jwks, settings.cf_access_team_domain),
    )
    admin_auth = build_admin_auth_middleware(
        dev_no_auth=settings.dev_no_auth,
        jwks=jwks,
        audience=settings.cf_access_aud,
        team_domain=settings.cf_access_team_domain,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Best-effort initial bootstrap (fetch_once already swallows CheckoutError) —
        # spec/04 §3's "never crash" posture applies here too: a transient network
        # failure at startup shouldn't prevent the process from coming up; the
        # background watcher keeps retrying, and request-serving routes report
        # 503/CheckoutError until the checkout exists.
        await anyio.to_thread.run_sync(fetch_once, project, paths, watcher_status)

        async def _run_watcher() -> None:
            await watch_upstream(
                project, paths, interval_s=watcher_interval_s, status=watcher_status
            )

        async with anyio.create_task_group() as tg:
            tg.start_soon(_run_watcher)
            yield
            tg.cancel_scope.cancel()

    app = FastAPI(lifespan=lifespan)
    app.state.project = project
    app.state.paths = paths
    app.state.settings = settings
    app.state.watcher_status = watcher_status
    app.state.wixy_repo_root = wixy_repo_root

    app.middleware("http")(admin_auth)

    # Registration order matters: more specific routes/mounts first, the public
    # catch-all (`GET /{path:path}`) last, or it would shadow everything above it.
    app.include_router(internal_router)
    app.include_router(version_router)
    app.include_router(preview_router)
    app.include_router(admin_api_router)

    @app.get("/admin", response_class=HTMLResponse, include_in_schema=False)
    @app.get("/admin/", response_class=HTMLResponse, include_in_schema=False)
    async def get_admin_shell() -> HTMLResponse:
        """Bare instant-render shell (spec/05 §1) — paints immediately, no server-side
        data dependency; the real admin-ui panels are milestone 7's job. Routing is
        entirely client-side hash fragments (`#/pages`, `#/edit/<page>`, …), so every
        `/admin` sub-route the browser might deep-link to is this same document."""
        return HTMLResponse(content=_ADMIN_SHELL_HTML)

    app.mount("/admin/static", StaticFiles(directory=_STATIC_DIR), name="admin-static")
    # Serves whatever `_save_upload`/`_media_item` (routes_admin_api.py) construct as
    # a staged upload's `url` (`/admin/draft-media/<hash8>-<slug>.<ext>`) — `paths.
    # draft_media` already exists by now (`ensure_project_dirs` above), and staying
    # per-project (not the fixed `_STATIC_DIR` `/admin/static` uses) is correct since
    # each app instance serves exactly one project (spec/04 §1). Without this mount a
    # freshly uploaded/staged image is correctly listed by `GET /api/admin/media` and
    # correctly targeted by an `<img src>`, but 404s the moment anything actually
    # fetches it — found by driving a real browser through the upload/replace flow,
    # not by any of this milestone's existing unit tests (they mock the API and never
    # fetch the constructed URL).
    app.mount("/admin/draft-media", StaticFiles(directory=paths.draft_media), name="draft-media")

    app.include_router(public_router)

    return app


def _fetch_jwks(team_domain: str) -> dict[str, object]:
    response = httpx.get(jwks_url(team_domain), timeout=10.0)
    response.raise_for_status()
    data: dict[str, object] = response.json()
    return data
