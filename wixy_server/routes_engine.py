"""`/api/admin/engine/{status,update,rollback}` (spec/independence/04 §2) —
standalone-edition only: the Settings → Engine card's version/commits-behind/
changelog display and the "Get engine updates"/"Undo last update" buttons. These
routes DEPLOY PRODUCTION CODE — they sit behind the same Access+JWT gate as every
other `/api/admin/*` path (the global auth middleware, `wixy_server/auth.py`, gates
on path prefix alone, so no per-route auth code is needed here), are POST-only for
anything that triggers a workflow, and never touch the fleet edition (guarded at the
top of every handler — `settings.engine_repo` is empty there, so there is nothing
sensible to call GitHub about).

Rollback (spec/independence/04 §3) deliberately does NOT reach for docker/host-level
control from inside this process: the `wixy` container has no docker.sock mount and
no write access to `/opt/wixy/.env` (both a deliberate M3 boundary — see
decisions/00055's Fable-review trail on `watchtower`'s own docker.sock scope). Both
"update" and "rollback" instead dispatch the SAME `sync-upstream.yml` workflow with a
different `mode` input — the workflow itself tags `pre-sync` before every merge
(`.github/workflows/sync-upstream.yml`), so `mode=rollback` is just `git reset --hard
pre-sync && push --force`, flowing through the exact same PAT-authenticated,
Watchtower-polled deploy path as a normal update. `update.sh --rollback` (03 §3)
remains the separate, host-level, GH-Actions-independent escape hatch for when
Actions itself is unavailable — the two mechanisms are not the same code path and
are not expected to be.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import anyio
from fastapi import APIRouter, HTTPException, Request

from builder.jsontypes import JsonObject
from wixy_server.github import SYNC_WORKFLOW_FILE, GitHubApiError, GitHubClient
from wixy_server.routes_version import resolve_engine_sha
from wixy_server.settings import Settings

router = APIRouter(prefix="/api/admin/engine")

_STATUS_CACHE_TTL_S = 15 * 60  # spec/independence/04 §2: "commits-behind cached 15 min"


@dataclass(slots=True)
class EngineStatusCache:
    """One process-lifetime cache slot (spec: "never blocking state" — a stale or
    unreachable GitHub API must never prevent the Settings page from rendering
    something). `None` fields mean "never successfully checked yet"."""

    checked_at: float | None = None
    ahead_by: int | None = None
    changelog: list[JsonObject] | None = None


def _client_for(settings: Settings) -> GitHubClient:
    return GitHubClient(pat=settings.engine_pat)


def _require_standalone(settings: Settings) -> None:
    if settings.edition != "standalone" or not settings.engine_repo:
        # Matches "this feature doesn't exist on this edition" — not a 403 (that
        # would imply the caller COULD have permission under different
        # circumstances); the fleet edition simply has no engine-update surface.
        raise HTTPException(status_code=404, detail="the engine-update surface is standalone-only")


async def _refresh_status_cache(settings: Settings, cache: EngineStatusCache) -> None:
    async with _client_for(settings) as client:
        result = await client.compare_commits(
            settings.engine_repo, "main", _upstream_head(settings)
        )
    cache.checked_at = time.monotonic()
    cache.ahead_by = result.ahead_by
    cache.changelog = [
        {"sha": c.sha, "subject": c.subject, "author": c.author, "when": c.when}
        for c in result.commits
    ]


def _upstream_head(settings: Settings) -> str:
    # GitHub's compare API cross-fork ref form is "owner:branch" — engine_upstream
    # is stored as "owner/repo" (matching WIXY_SITE_REPO-style settings elsewhere),
    # so only the owner half is needed here (the branch is always "main", per this
    # engine's own single-branch convention throughout the independence phase).
    owner = settings.engine_upstream.split("/", 1)[0]
    return f"{owner}:main"


@router.get("/status", response_model=None)
async def get_engine_status(request: Request) -> JsonObject:
    settings: Settings = request.app.state.settings
    _require_standalone(settings)
    cache: EngineStatusCache = request.app.state.engine_status_cache

    is_stale = (
        cache.checked_at is None or (time.monotonic() - cache.checked_at) > _STATUS_CACHE_TTL_S
    )
    refresh_error: str | None = None
    if is_stale:
        try:
            await _refresh_status_cache(settings, cache)
        except GitHubApiError as exc:
            # "never blocking state": fall back to whatever's already cached
            # (possibly nothing yet) rather than erroring the whole endpoint.
            refresh_error = str(exc)

    update_run: JsonObject | None = None
    try:
        async with _client_for(settings) as client:
            run = await client.get_latest_workflow_run(settings.engine_repo, SYNC_WORKFLOW_FILE)
        if run is not None:
            update_run = {
                "status": run.status,
                "conclusion": run.conclusion,
                "htmlUrl": run.html_url,
                "createdAt": run.created_at,
            }
    except GitHubApiError as exc:
        refresh_error = refresh_error or str(exc)

    current_sha = await anyio.to_thread.run_sync(
        resolve_engine_sha, request.app.state.wixy_repo_root
    )
    return {
        "engineRepo": settings.engine_repo,
        "currentSha": current_sha,
        "commitsBehind": cache.ahead_by,
        "changelog": cache.changelog or [],
        "checkedAt": cache.checked_at,
        "stale": is_stale,
        "checkError": refresh_error,
        "updateRun": update_run,
    }


@router.post("/update", response_model=None)
async def post_engine_update(request: Request) -> JsonObject:
    settings: Settings = request.app.state.settings
    _require_standalone(settings)
    try:
        async with _client_for(settings) as client:
            await client.trigger_workflow_dispatch(
                settings.engine_repo, SYNC_WORKFLOW_FILE, inputs={"mode": "sync"}
            )
    except GitHubApiError as exc:
        raise HTTPException(status_code=502, detail=f"couldn't trigger the update: {exc}") from exc
    return {"triggered": True}


@router.post("/rollback", response_model=None)
async def post_engine_rollback(request: Request) -> JsonObject:
    settings: Settings = request.app.state.settings
    _require_standalone(settings)
    try:
        async with _client_for(settings) as client:
            await client.trigger_workflow_dispatch(
                settings.engine_repo, SYNC_WORKFLOW_FILE, inputs={"mode": "rollback"}
            )
    except GitHubApiError as exc:
        raise HTTPException(
            status_code=502, detail=f"couldn't trigger the rollback: {exc}"
        ) from exc
    return {"triggered": True}
