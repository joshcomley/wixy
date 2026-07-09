"""`/api/admin/*` — the M6 subset only: `state`, `content/{page}`, `draft` (PATCH +
DELETE), `media` (list). Publish/restore/pages-ops/chat are M9/M7/M10 — not built here
(spec/04 §8's full table has more rows; those are out of scope until their milestone).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import anyio
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from builder.bindings_map import bindings_map_to_dict, extract_bindings_map
from builder.config import ProjectConfig
from builder.errors import BuildError
from builder.jsontypes import JsonObject, JsonValue
from wixy_server.checkout import CheckoutError, UpstreamCommit, commits_ahead, current_sha
from wixy_server.live_pointer import load_live_pointer
from wixy_server.merged_content import merge_overlay
from wixy_server.overlay import (
    DiscardOp,
    Overlay,
    PatchOp,
    RevConflictError,
    SetOp,
    apply_patch,
    discard_all,
    load_overlay,
    save_overlay,
)
from wixy_server.site_source import build_site_source
from wixy_server.storage import ProjectPaths
from wixy_server.watcher import WatcherStatus

router = APIRouter(prefix="/api/admin")

_DEV_BYPASS_AUTHOR = "editor"


def _current_author(request: Request) -> str:
    """The CF Access-verified identity for this request (`wixy_server.auth` stashes
    it on `request.state` after a successful verify), or a fixed placeholder when
    `WIXY_DEV_NO_AUTH` bypassed verification entirely (there's no real identity to
    report then)."""
    email = getattr(request.state, "access_email", None)
    return email if isinstance(email, str) else _DEV_BYPASS_AUTHOR


def _load_overlay_for(paths: ProjectPaths) -> Overlay:
    base_sha = current_sha(paths.repo)
    return load_overlay(paths.draft_overlay, default_base_sha=base_sha)


# ---------------------------------------------------------------------------
# GET /api/admin/state
# ---------------------------------------------------------------------------


def _last_modified_for_page(overlay: Overlay, slug: str) -> str | None:
    """The newest draft-op timestamp touching this page (spec/05 §2's pages-panel
    "last-modified" column) — `None` if the page has no draft edits. There's no
    other last-modified signal until milestone 9's publish ledger exists; op
    timestamps are `datetime.now(UTC).isoformat()` (routes_admin_api.patch_draft),
    a consistently-offset ISO 8601 string, so plain max() sorts correctly."""
    prefix = f"{slug}:"
    timestamps = [op.ts for key, op in overlay.ops.items() if key.startswith(prefix)]
    return max(timestamps) if timestamps else None


def _build_state(
    project: ProjectConfig, paths: ProjectPaths, watcher_status: WatcherStatus
) -> JsonObject:
    source = build_site_source(project, paths.repo)
    overlay = _load_overlay_for(paths)
    merged = merge_overlay(source, overlay)

    pages: list[JsonValue] = [
        {
            "slug": slug,
            "meta": content.get("meta", {}),
            "lastModified": _last_modified_for_page(overlay, slug),
        }
        for slug, content in sorted(merged.page_contents.items())
    ]

    live_pointer = load_live_pointer(paths)
    live: JsonValue = (
        {"version": live_pointer.version, "sha": live_pointer.sha}
        if live_pointer is not None
        else None
    )

    ahead: list[UpstreamCommit] = (
        commits_ahead(paths.repo, live_pointer.sha) if live_pointer is not None else []
    )
    upstream: JsonObject = {
        "aheadOfPublished": [
            {"sha": c.sha, "subject": c.subject, "author": c.author, "when": c.when} for c in ahead
        ],
        "fetchedAt": (
            watcher_status.fetched_at.isoformat() if watcher_status.fetched_at is not None else None
        ),
    }

    return {
        "project": {"slug": project.slug, "name": project.name, "domain": project.domain},
        "pages": pages,
        "draft": {"rev": overlay.rev, "opCount": len(overlay.ops)},
        "live": live,
        "upstream": upstream,
        "publishJob": None,  # milestone 9 — publish pipeline doesn't exist yet
        "chats": [],  # milestone 10 — AI chat doesn't exist yet
    }


@router.get("/state", response_model=None)
async def get_state(request: Request) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    watcher_status: WatcherStatus = request.app.state.watcher_status
    try:
        return await anyio.to_thread.run_sync(_build_state, project, paths, watcher_status)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# GET /api/admin/content/{page}
# ---------------------------------------------------------------------------


def _build_content(project: ProjectConfig, paths: ProjectPaths, slug: str) -> JsonObject:
    source = build_site_source(project, paths.repo)
    overlay = _load_overlay_for(paths)
    merged = merge_overlay(source, overlay)
    content = merged.page_contents.get(slug)
    if content is None:
        raise BuildError(f"no content for page '{slug}'", location=slug)
    bindings = extract_bindings_map(merged, slug)
    return {"content": content, "bindings": bindings_map_to_dict(bindings)}


@router.get("/content/{page}", response_model=None)
async def get_content(page: str, request: Request) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    try:
        return await anyio.to_thread.run_sync(_build_content, project, paths, page)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except BuildError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# PATCH + DELETE /api/admin/draft
# ---------------------------------------------------------------------------


class DraftOpIn(BaseModel):
    file: str
    path: str
    value: Any = None
    discard: bool = False


class DraftPatchIn(BaseModel):
    expectedRev: int
    ops: list[DraftOpIn]


def _to_patch_op(op_in: DraftOpIn) -> PatchOp:
    if op_in.discard:
        return DiscardOp(file=op_in.file, path=op_in.path)
    return SetOp(file=op_in.file, path=op_in.path, value=op_in.value)


def _apply_draft_patch(paths: ProjectPaths, body: DraftPatchIn, *, by: str, now: str) -> int:
    overlay = _load_overlay_for(paths)
    ops = [_to_patch_op(op_in) for op_in in body.ops]
    new_overlay = apply_patch(overlay, body.expectedRev, ops, by=by, now=now)
    save_overlay(paths.draft_overlay, new_overlay)
    return new_overlay.rev


@router.patch("/draft")
async def patch_draft(body: DraftPatchIn, request: Request) -> dict[str, int]:
    paths: ProjectPaths = request.app.state.paths
    by = _current_author(request)
    now = datetime.now(UTC).isoformat()

    def _apply() -> int:
        return _apply_draft_patch(paths, body, by=by, now=now)

    try:
        rev = await anyio.to_thread.run_sync(_apply)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RevConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"expected rev {exc.expected}, overlay is at rev {exc.actual}",
        ) from exc
    return {"rev": rev}


def _discard_draft(paths: ProjectPaths) -> int:
    overlay = _load_overlay_for(paths)
    new_overlay = discard_all(overlay)
    save_overlay(paths.draft_overlay, new_overlay)
    if paths.draft_media.is_dir():
        for staged in paths.draft_media.iterdir():
            if staged.is_file():
                staged.unlink()
    return new_overlay.rev


@router.delete("/draft")
async def delete_draft(request: Request) -> dict[str, int]:
    paths: ProjectPaths = request.app.state.paths
    try:
        rev = await anyio.to_thread.run_sync(_discard_draft, paths)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"rev": rev}


# ---------------------------------------------------------------------------
# GET /api/admin/media (list only — upload/delete are milestone 8)
# ---------------------------------------------------------------------------


def _list_media(paths: ProjectPaths) -> list[JsonValue]:
    items: list[JsonValue] = []
    images_dir = paths.repo / "images"
    if images_dir.is_dir():
        for entry in sorted(images_dir.iterdir(), key=lambda p: p.name):
            if entry.is_file():
                items.append({"name": entry.name, "url": f"/images/{entry.name}", "source": "repo"})
    if paths.draft_media.is_dir():
        for entry in sorted(paths.draft_media.iterdir(), key=lambda p: p.name):
            if entry.is_file():
                items.append(
                    {
                        "name": entry.name,
                        "url": f"/admin/draft-media/{entry.name}",
                        "source": "draft",
                    }
                )
    return items


@router.get("/media", response_model=None)
async def get_media(request: Request) -> JsonObject:
    paths: ProjectPaths = request.app.state.paths
    items = await anyio.to_thread.run_sync(_list_media, paths)
    return {"media": items}
