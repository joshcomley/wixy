"""`GET /admin/versions/{n}/{path}` — archived builds, read-only (spec/04-server.md
§4: "editor NOT injected"; spec/05-editor.md §5's history panel "View" action).
Serves the WHOLE build directory (not just the requested page's own HTML) so a
viewed version renders faithfully with its own CSS/images rather than falling
through to the live site's current (possibly different) assets — spec's route
table only names the `{page}.html` case explicitly, but "serves archived builds
read-only" is a whole-build concern, not just its HTML shell. Rebuilds a pruned
build via `wixy_server.restore`'s shared worktree mechanism first.
"""

from __future__ import annotations

from pathlib import Path

import anyio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from builder.config import ProjectConfig
from wixy_server.checkout import CheckoutError
from wixy_server.ledger import find_version
from wixy_server.restore import RestoreError, ensure_build
from wixy_server.storage import ProjectPaths

router = APIRouter()


def _resolve_within_build_dir(build_dir: Path, request_path: str) -> Path | None:
    """`None` when the path doesn't correspond to a real file, or would resolve
    outside `build_dir` (path-traversal guard) — mirrors `routes_public.py`'s
    own `_resolve_within_build_dir` exactly, parameterized on an archived
    version's build dir instead of the live pointer's."""
    relative = request_path.lstrip("/") or "index.html"
    build_dir_resolved = build_dir.resolve()
    candidate = (build_dir_resolved / relative).resolve()
    try:
        candidate.relative_to(build_dir_resolved)
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    return candidate


def _load_version_asset(
    project: ProjectConfig, paths: ProjectPaths, version: int, path: str
) -> Path | None:
    entry = find_version(paths, version)
    if entry is None:
        return None
    build_dir = ensure_build(project, paths, entry.sha)
    return _resolve_within_build_dir(build_dir, path)


@router.get("/admin/versions/{n}/{path:path}", include_in_schema=False)
async def get_version_asset(n: int, path: str, request: Request) -> FileResponse:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths

    def _load() -> Path | None:
        return _load_version_asset(project, paths, n, path)

    try:
        resolved = await anyio.to_thread.run_sync(_load)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RestoreError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if resolved is None:
        raise HTTPException(status_code=404, detail=f"no such file in version {n}: {path}")
    return FileResponse(resolved)
