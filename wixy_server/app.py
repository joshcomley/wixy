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
from datetime import UTC, datetime
from pathlib import Path

import anyio
import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from wixy_server.ai.anthropic_backend import AnthropicAIBackend
from wixy_server.ai.backend import AIBackend, CmdAIBackend
from wixy_server.auth import JwksCache, build_admin_auth_middleware, jwks_url
from wixy_server.bootstrap import bootstrap_if_needed
from wixy_server.chats import ChatRuntimeEntry
from wixy_server.cmdchat import CmdChatClient
from wixy_server.github import GitHubClient
from wixy_server.publisher import PublishJob
from wixy_server.redirects import load_redirects
from wixy_server.registry import load_registry
from wixy_server.routes_admin_api import router as admin_api_router
from wixy_server.routes_ai import router as ai_router
from wixy_server.routes_chat import StreamTiming
from wixy_server.routes_chat import router as chat_router
from wixy_server.routes_engine import EngineStatusCache
from wixy_server.routes_engine import router as engine_router
from wixy_server.routes_internal import router as internal_router
from wixy_server.routes_preview import DEFAULT_PREVIEW_STALENESS_THRESHOLD_S
from wixy_server.routes_preview import router as preview_router
from wixy_server.routes_public import router as public_router
from wixy_server.routes_system import router as system_router
from wixy_server.routes_version import router as version_router
from wixy_server.routes_versions import router as versions_router
from wixy_server.settings import load_settings
from wixy_server.storage import ensure_project_dirs, project_paths
from wixy_server.watcher import DEFAULT_INTERVAL_S, WatcherStatus, fetch_once, watch_upstream

_STATIC_DIR = Path(__file__).parent / "static"
_ADMIN_SHELL_HTML = (_STATIC_DIR / "admin_shell.html").read_text(encoding="utf-8")
# Uxer MCP compliance-bridge integration (slice 7, decisions/00050). `Uxer/`
# is gitignored (cloned + `npm run build` locally per UXER-INTEGRATION.md's
# "Web Application Integration" section) and won't exist on a fresh checkout
# or the deployed slot unless someone's explicitly built it there — this is
# an AI/MCP-tooling-only surface gated behind `?uxer=` client-side (see
# admin_shell.html), so a missing bundle just means the overlay never
# activates, not a broken app.
_REPO_ROOT = Path(__file__).parent.parent
_UXER_DIST_DIR = _REPO_ROOT / "Uxer" / "web" / "dist"
_UXER_STYLE_PATH = _REPO_ROOT / "uxer-style.json"
_UXER_WEB_PORT_PATH = _REPO_ROOT / ".uxer-web-port"


def create_app(
    *,
    storage_root: Path,
    wixy_repo_root: Path,
    watcher_interval_s: float = DEFAULT_INTERVAL_S,
    preview_staleness_threshold_s: float = DEFAULT_PREVIEW_STALENESS_THRESHOLD_S,
    cmdchat_client: CmdChatClient | None = None,
    chat_stream_timing: StreamTiming | None = None,
    github_client: GitHubClient | None = None,
    ai_backend: AIBackend | None = None,
) -> FastAPI:
    """Build the Wixy FastAPI app for one project.

    `storage_root` is the Storage tree root (spec/04 §2) — tests always pass a
    `tmp_path`-backed one; the real production default only exists from milestone 11's
    install onward. `wixy_repo_root` is the wixy repo checkout this process runs from
    (where `projects/*.json` lives, spec/04 §1) — milestone 11's launcher resolves this
    for real; this function never guesses a default for either path. `cmdchat_client`
    defaults to a real `CmdChatClient()` (localhost cmd, spec/06 §1) — overridable so
    the E2E fixture server can point it at a fake cmd instead (milestone 10 slice 5).
    Wrapped in `CmdAIBackend`, one of two backend candidates `app.state.ai_backend`
    (spec/independence/05 §1) is picked from — `settings.ai_backend` (`WIXY_AI_BACKEND`)
    chooses `cmd` vs `anthropic` unless the `ai_backend` PARAMETER below overrides that
    choice outright. `cmdchat_client` itself stays its own separate override point
    (every existing test constructs a fake-cmd-pointed `CmdChatClient` this way;
    wrapping it internally means none of them need to change for this extraction).
    `chat_stream_timing` defaults to spec/06 §1's own numbers (1.2s poll, 10s offline
    retry, 15s transcript-lag grace) — overridable so tests don't have to wait out
    real multi-second intervals to exercise the stream's timing-dependent branches.
    `github_client` defaults to a real `GitHubClient(pat=settings.engine_pat)`
    (spec/independence/04 §2) — overridable so tests point `routes_engine.py` at a
    fake GitHub double instead, same reason `cmdchat_client` is. Constructed
    unconditionally (even on the fleet edition, where `engine_pat` is empty and
    `_require_standalone` 404s before ever touching it) — same posture `cmdchat_client`
    already takes, no per-edition branching needed. `ai_backend` (the parameter)
    overrides `settings.ai_backend`'s choice entirely — tests that want to exercise
    `AnthropicAIBackend` specifically pass one pointed at a fake worker
    (`wixy_server.tests.fake_worker`), same reasoning as every override above; both
    concrete backends are still constructed unconditionally below (same "no
    per-edition branching, everything closes uniformly at shutdown" posture as
    `gh_client`), only WHICH ONE gets exposed on `app.state` branches.
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
    publish_job: PublishJob | None = None
    chat_client = cmdchat_client if cmdchat_client is not None else CmdChatClient()
    if ai_backend is not None:
        resolved_ai_backend: AIBackend = ai_backend
    elif settings.ai_backend == "anthropic":
        resolved_ai_backend = AnthropicAIBackend()
    else:
        resolved_ai_backend = CmdAIBackend(chat_client, cmd_project=project.cmd_project)
    chat_runtime: dict[str, ChatRuntimeEntry] = {}
    stream_timing = chat_stream_timing if chat_stream_timing is not None else StreamTiming()
    gh_client = (
        github_client if github_client is not None else GitHubClient(pat=settings.engine_pat)
    )

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
        # Best-effort initial fetch (fetch_once already swallows CheckoutError) —
        # spec/04 §3's "never crash" posture applies here too: a transient network
        # failure at startup shouldn't prevent the process from coming up; the
        # background watcher keeps retrying, and request-serving routes report
        # 503/CheckoutError until the checkout exists.
        await anyio.to_thread.run_sync(fetch_once, project, paths, watcher_status)
        # The server's own "publish zero" (spec/07 §1: "the server also
        # self-bootstraps this way on first startup") — a no-op once live.json
        # exists (every startup after the first), and equally a no-op if the fetch
        # just above never got a checkout on disk at all (bootstrap_if_needed does
        # no git I/O of its own, see its own docstring).
        await anyio.to_thread.run_sync(
            bootstrap_if_needed, project, paths, datetime.now(UTC).isoformat()
        )

        async def _run_watcher() -> None:
            await watch_upstream(
                project, paths, interval_s=watcher_interval_s, status=watcher_status
            )

        try:
            async with anyio.create_task_group() as tg:
                # Exposed on `app.state` so route handlers (milestone 10's chat
                # provisioning tracker, `routes_chat.py`) can spawn app-lifetime
                # background work of their own — same task group the watcher
                # itself runs in, cancelled together at shutdown below.
                _app.state.background_tasks = tg
                tg.start_soon(_run_watcher)
                yield
                tg.cancel_scope.cancel()
        finally:
            await chat_client.aclose()
            await gh_client.aclose()
            # `CmdAIBackend.aclose()` is just a passthrough to `chat_client`
            # (already closed above) — closing it again would double-close
            # that same underlying httpx client, so only close
            # `resolved_ai_backend` itself when it's a genuinely SEPARATE
            # resource (AnthropicAIBackend's own httpx client, or an injected
            # override neither of the two concrete types above).
            if not isinstance(resolved_ai_backend, CmdAIBackend):
                await resolved_ai_backend.aclose()

    app = FastAPI(lifespan=lifespan)
    app.state.project = project
    app.state.paths = paths
    app.state.settings = settings
    app.state.watcher_status = watcher_status
    app.state.preview_staleness_threshold_s = preview_staleness_threshold_s
    app.state.publish_job = publish_job
    app.state.wixy_repo_root = wixy_repo_root
    app.state.cmdchat_client = chat_client
    app.state.ai_backend = resolved_ai_backend
    app.state.chat_runtime = chat_runtime
    app.state.chat_stream_timing = stream_timing
    app.state.github_client = gh_client
    app.state.redirects = load_redirects()
    app.state.engine_status_cache = EngineStatusCache()

    app.middleware("http")(admin_auth)

    # Registration order matters: more specific routes/mounts first, the public
    # catch-all (`GET /{path:path}`) last, or it would shadow everything above it.
    app.include_router(internal_router)
    app.include_router(version_router)
    app.include_router(preview_router)
    app.include_router(admin_api_router)
    app.include_router(chat_router)
    app.include_router(engine_router)
    app.include_router(ai_router)
    app.include_router(system_router)
    app.include_router(versions_router)

    @app.get("/admin", response_class=HTMLResponse, include_in_schema=False)
    @app.get("/admin/", response_class=HTMLResponse, include_in_schema=False)
    async def get_admin_shell() -> HTMLResponse:
        """Bare instant-render shell (spec/05 §1) — paints immediately, no server-side
        data dependency; the real admin-ui panels are milestone 7's job. Routing is
        entirely client-side hash fragments (`#/pages`, `#/edit/<page>`, …), so every
        `/admin` sub-route the browser might deep-link to is this same document."""
        return HTMLResponse(content=_ADMIN_SHELL_HTML)

    @app.get("/uxer-style.json", include_in_schema=False)
    async def uxer_style() -> FileResponse:
        """Uxer MCP compliance-bridge design tokens (slice 7, decisions/00050) —
        a fixed, protocol-level path Uxer's own browser module and MCP server
        look for by convention, not something wixy renames the way the static
        asset mount below is namespaced under /admin/static."""
        return FileResponse(_UXER_STYLE_PATH)

    @app.get("/.uxer-web-port", include_in_schema=False)
    async def uxer_web_port() -> HTMLResponse:
        """Uxer bridge auto-discovery — the MCP server's WebSocket port, if one
        is running locally. Absent outside an active `ui_launch`/MCP session,
        which is expected — the bridge just fails to connect, same as any
        other optional dev-tooling endpoint would."""
        if _UXER_WEB_PORT_PATH.exists():
            return HTMLResponse(_UXER_WEB_PORT_PATH.read_text(encoding="utf-8").strip())
        return HTMLResponse("0", status_code=404)

    # Mount BEFORE /admin/static (more specific path first, per Uxer's own
    # doc) so /admin/static/uxer/... resolves here rather than falling
    # through to the broader static mount below.
    if not _UXER_DIST_DIR.exists():
        _UXER_DIST_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/admin/static/uxer", StaticFiles(directory=_UXER_DIST_DIR), name="uxer-static")

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
