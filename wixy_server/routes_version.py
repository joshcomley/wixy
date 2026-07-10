"""`GET /api/version` (spec/04-server.md §9, spec/07-hosting-deploy.md §1) — public by
design (fleet deploy-awareness; Slots smoke probes match `commit.sha_full` against the
engine repo's HEAD as the anti-stale gate). NOT gated by CF Access — it must stay
reachable even before any Access app is provisioned."""

from __future__ import annotations

from pathlib import Path

import anyio
from fastapi import APIRouter, Request

from wixy_server.checkout import current_sha
from wixy_server.live_pointer import load_live_pointer
from wixy_server.settings import Settings
from wixy_server.storage import ProjectPaths

router = APIRouter()


def _build_version(
    wixy_repo_root: Path, paths: ProjectPaths, slot: str | None
) -> dict[str, object]:
    # `current_sha` is a plain "git rev-parse HEAD in this directory" primitive — reused
    # here for the ENGINE repo's own HEAD, not the site checkout it was written for.
    engine_sha = current_sha(wixy_repo_root)
    live_pointer = load_live_pointer(paths)
    return {
        "commit": {"sha_full": engine_sha},
        "slot": slot,  # WIXY_SLOT, set by launcher.py from active.txt (spec/07 §1)
        "version": live_pointer.version if live_pointer is not None else None,
    }


@router.get("/api/version")
async def get_version(request: Request) -> dict[str, object]:
    wixy_repo_root: Path = request.app.state.wixy_repo_root
    paths: ProjectPaths = request.app.state.paths
    settings: Settings = request.app.state.settings
    return await anyio.to_thread.run_sync(_build_version, wixy_repo_root, paths, settings.slot)
