"""`GET /api/admin/system/status` (spec/independence/06 §3's "in-admin System
card": last backup age with a stale banner past 48h, disk usage, last
publish, engine version/edition) — standalone-only in PRACTICE (the fleet
edition runs no `backup` service, so `backup` always reports "never run" /
`stale: true` there) but not `_require_standalone`-gated: unlike the Engine
card (an edition-specific FEATURE, spec/independence/04), a system-health
summary is meaningful on both editions — the fleet's own Wixy deployment has
disk usage and a publish history too, it just has no backup process to
report on.

One combined fetch, not four (mirrors `routes_engine.py`'s own precedent of
folding `currentSha` into its response rather than making the frontend also
call `/api/version`) — a single Settings-panel card should need exactly one
round trip.
"""

from __future__ import annotations

import shutil
from datetime import UTC, datetime
from pathlib import Path

import anyio
from fastapi import APIRouter, Request

from builder.jsontypes import JsonObject
from wixy_server.backup.status import BackupStatus, read_status
from wixy_server.ledger import read_ledger
from wixy_server.routes_version import resolve_engine_sha
from wixy_server.settings import Settings
from wixy_server.storage import ProjectPaths

router = APIRouter(prefix="/api/admin/system")

# The `backup` compose service's own fixed mount point for its status file
# (docker-compose.yml's `backup-status` volume, mounted read-only into
# `wixy` at this exact path) — a hardcoded container-path constant, the same
# convention `wixy_server.worker.settings`'s `_DEFAULT_SCRATCH_ROOT` already
# uses for its own fixed compose mount point, not an env var thread through
# `Settings` for a path that's never actually operator-configurable.
_BACKUP_STATUS_PATH = Path("/backup-status/status.json")

_STALE_AFTER_HOURS = 48


def _backup_field(now: datetime) -> JsonObject:
    status: BackupStatus | None = read_status(_BACKUP_STATUS_PATH)
    if status is None:
        # No backup has ever run (fleet edition; or a fresh standalone
        # install whose first night hasn't happened yet) — reported stale by
        # definition, never a crash or an empty-looking card.
        return {
            "lastAttemptAt": None,
            "ok": None,
            "verified": None,
            "error": None,
            "stale": True,
        }
    stale = not status.ok or not status.verified
    if not stale:
        try:
            attempted = datetime.strptime(status.attempted_at, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=UTC
            )
            age_hours = (now - attempted).total_seconds() / 3600
            stale = age_hours > _STALE_AFTER_HOURS
        except ValueError:
            stale = True
    return {
        "lastAttemptAt": status.attempted_at,
        "ok": status.ok,
        "verified": status.verified,
        "error": status.error,
        "stale": stale,
    }


def _disk_usage_field(storage_root: Path) -> JsonObject:
    usage = shutil.disk_usage(storage_root)
    return {"totalBytes": usage.total, "usedBytes": usage.used, "freeBytes": usage.free}


def _last_publish_field(paths: ProjectPaths) -> JsonObject | None:
    entries = read_ledger(paths)
    if not entries:
        return None
    latest = entries[-1]
    return {"version": latest.version, "when": latest.when}


def _build_status(
    *, wixy_repo_root: Path, paths: ProjectPaths, settings: Settings, now: datetime
) -> JsonObject:
    return {
        "backup": _backup_field(now),
        "diskUsage": _disk_usage_field(settings.storage_root),
        "lastPublish": _last_publish_field(paths),
        "engine": {"currentSha": resolve_engine_sha(wixy_repo_root), "edition": settings.edition},
    }


@router.get("/status", response_model=None)
async def get_system_status(request: Request) -> JsonObject:
    wixy_repo_root: Path = request.app.state.wixy_repo_root
    paths: ProjectPaths = request.app.state.paths
    settings: Settings = request.app.state.settings
    return await anyio.to_thread.run_sync(
        lambda: _build_status(
            wixy_repo_root=wixy_repo_root, paths=paths, settings=settings, now=datetime.now(UTC)
        )
    )
