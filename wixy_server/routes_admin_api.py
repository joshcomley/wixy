"""`/api/admin/*` — the M6 subset (`state`, `content/{page}`, `draft` PATCH+DELETE)
plus milestone 8's media upload/delete and milestone 9's publish/restore.
Pages-ops/chat are M7/M10 — not built here (spec/04 §8's full table has more
rows; those are out of scope until their milestone).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

import anyio
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from builder.bindings_map import bindings_map_to_dict, extract_bindings_map
from builder.config import ProjectConfig
from builder.content import GLOBAL_CONTENT_NAME, dotted_get, scan_image_refs
from builder.errors import BuildError
from builder.jsontypes import JsonObject, JsonValue
from builder.render import SiteSource
from builder.theme import theme_to_dict
from builder.validate import validate_site
from wixy_server.checkout import CheckoutError, UpstreamCommit, commits_ahead, current_sha
from wixy_server.ledger import read_ledger
from wixy_server.live_pointer import load_live_pointer
from wixy_server.media import (
    MediaNotFoundError,
    MediaReferencedError,
    MediaUploadError,
    delete_draft_media,
    image_dimensions,
    process_upload,
    scan_media_references,
)
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
from wixy_server.publisher import PublishError, PublishJob, PublishResult, run_publish
from wixy_server.restore import RestoreError, RestoreResult, run_restore
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


def _publish_job_to_dict(job: PublishJob) -> JsonObject:
    return {
        "id": job.id,
        "stage": job.stage,
        "log": list(job.log),
        "version": job.version,
        "error": job.error,
        "isRunning": job.is_running,
    }


def _build_state(
    project: ProjectConfig,
    paths: ProjectPaths,
    watcher_status: WatcherStatus,
    publish_job: PublishJob | None,
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
        "publishJob": _publish_job_to_dict(publish_job) if publish_job is not None else None,
        "chats": [],  # milestone 10 — AI chat doesn't exist yet
    }


@router.get("/state", response_model=None)
async def get_state(request: Request) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    watcher_status: WatcherStatus = request.app.state.watcher_status
    publish_job: PublishJob | None = request.app.state.publish_job
    try:
        return await anyio.to_thread.run_sync(
            _build_state, project, paths, watcher_status, publish_job
        )
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
# GET /api/admin/theme (milestone 8 slice 2)
# ---------------------------------------------------------------------------


def _build_theme(project: ProjectConfig, paths: ProjectPaths) -> JsonObject:
    source = build_site_source(project, paths.repo)
    overlay = _load_overlay_for(paths)
    merged = merge_overlay(source, overlay)
    if merged.theme is None:
        # Pre-migration-step-4 checkouts have no theme/theme.json (decisions/00004) —
        # same "missing resource -> 404" treatment as an unknown page slug above,
        # not a crash (spec/04 §3's "never a crash" posture).
        raise BuildError("project has no theme configured", location="theme")
    return {"theme": theme_to_dict(merged.theme)}


@router.get("/theme", response_model=None)
async def get_theme(request: Request) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    try:
        return await anyio.to_thread.run_sync(_build_theme, project, paths)
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
# GET/POST /api/admin/media, DELETE /api/admin/media/{name} (milestone 8)
# ---------------------------------------------------------------------------


def _merged_source(project: ProjectConfig, paths: ProjectPaths) -> SiteSource:
    source = build_site_source(project, paths.repo)
    overlay = _load_overlay_for(paths)
    return merge_overlay(source, overlay)


def _media_item(path: Path, url: str, source: str, references: dict[str, list[str]]) -> JsonObject:
    dims = image_dimensions(path)
    return {
        "name": path.name,
        "url": url,
        "source": source,
        "sizeBytes": path.stat().st_size,
        "width": dims[0] if dims is not None else None,
        "height": dims[1] if dims is not None else None,
        "references": [ref for ref in references.get(path.name, [])],
    }


def _list_media(project: ProjectConfig, paths: ProjectPaths) -> list[JsonValue]:
    references = scan_media_references(_merged_source(project, paths))
    items: list[JsonValue] = []
    images_dir = paths.repo / "images"
    if images_dir.is_dir():
        for entry in sorted(images_dir.iterdir(), key=lambda p: p.name):
            if entry.is_file():
                items.append(_media_item(entry, f"/images/{entry.name}", "repo", references))
    if paths.draft_media.is_dir():
        for entry in sorted(paths.draft_media.iterdir(), key=lambda p: p.name):
            if entry.is_file():
                items.append(
                    _media_item(entry, f"/admin/draft-media/{entry.name}", "draft", references)
                )
    return items


@router.get("/media", response_model=None)
async def get_media(request: Request) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    try:
        items = await anyio.to_thread.run_sync(_list_media, project, paths)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"media": items}


def _save_upload(
    project: ProjectConfig, paths: ProjectPaths, data: bytes, filename: str, content_type: str
) -> JsonObject:
    processed = process_upload(data, filename, content_type, project.media)
    paths.draft_media.mkdir(parents=True, exist_ok=True)
    (paths.draft_media / processed.filename).write_bytes(processed.content)
    return {
        "name": processed.filename,
        "url": f"/admin/draft-media/{processed.filename}",
        "source": "draft",
        "sizeBytes": len(processed.content),
        "width": processed.width,
        "height": processed.height,
        "references": [],  # a just-uploaded file can't be referenced by anything yet
    }


@router.post("/media", response_model=None)
async def upload_media(request: Request, file: Annotated[UploadFile, File()]) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    data = await file.read()
    filename = file.filename or "upload"
    content_type = file.content_type or ""

    def _save() -> JsonObject:
        return _save_upload(project, paths, data, filename, content_type)

    try:
        return await anyio.to_thread.run_sync(_save)
    except MediaUploadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _delete_media(project: ProjectConfig, paths: ProjectPaths, name: str) -> None:
    references = scan_media_references(_merged_source(project, paths))
    delete_draft_media(paths, name, references)


@router.delete("/media/{name}", response_model=None)
async def delete_media(name: str, request: Request) -> dict[str, bool]:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths

    def _delete() -> None:
        _delete_media(project, paths, name)

    try:
        await anyio.to_thread.run_sync(_delete)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except MediaNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except MediaReferencedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"deleted": True}


# ---------------------------------------------------------------------------
# POST /api/admin/publish, GET /api/admin/publish/stream, GET /api/admin/publishes
# (milestone 9 slice 2 — restore is slice 3, not built here)
# ---------------------------------------------------------------------------


class PublishIn(BaseModel):
    message: str
    expectedRev: int


_PUBLISH_STREAM_POLL_S = 0.25


@router.post("/publish", response_model=None)
async def start_publish(body: PublishIn, request: Request) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    previous: PublishJob | None = request.app.state.publish_job
    if previous is not None and previous.is_running:
        raise HTTPException(
            status_code=409, detail=f"a publish is already running (job {previous.id})"
        )

    job = PublishJob(id=uuid.uuid4().hex)
    request.app.state.publish_job = job
    now = datetime.now(UTC).isoformat()

    def _run() -> PublishResult:
        return run_publish(
            project,
            paths,
            message=body.message,
            expected_rev=body.expectedRev,
            now=now,
            job=job,
        )

    try:
        result = await anyio.to_thread.run_sync(_run)
    except RevConflictError as exc:
        # `run_publish`'s own contract: this is raised before the job is considered
        # to have started at all (job.stage/error untouched) — roll the app-wide
        # slot back to whatever it was, or a stale "pulling"-forever job would
        # permanently read `is_running=True` and 409-lock every future attempt.
        request.app.state.publish_job = previous
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (PublishError, CheckoutError, BuildError) as exc:
        # The pipeline ran and failed at some stage — `run_publish` has already
        # recorded `job.stage="failed"`/`job.error` before re-raising, so the job
        # object left on `app.state` already reflects this for the SSE stream /
        # `GET state`; nothing to roll back here.
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"version": result.version, "sha": result.sha}


@router.get("/publish/stream")
async def publish_stream(request: Request) -> StreamingResponse:
    app_state = request.app.state

    async def _events() -> AsyncIterator[str]:
        last_payload: str | None = None
        while True:
            job: PublishJob | None = app_state.publish_job
            if job is None:
                yield f"data: {json.dumps({'stage': None})}\n\n"
                return
            payload = json.dumps(_publish_job_to_dict(job))
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
            if not job.is_running:
                return
            await anyio.sleep(_PUBLISH_STREAM_POLL_S)

    return StreamingResponse(_events(), media_type="text/event-stream")


@router.get("/publishes", response_model=None)
async def get_publishes(request: Request, limit: int | None = None) -> JsonObject:
    paths: ProjectPaths = request.app.state.paths
    try:
        entries = await anyio.to_thread.run_sync(read_ledger, paths)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    newest_first = list(reversed(entries))
    if limit is not None:
        newest_first = newest_first[:limit]
    live_pointer = load_live_pointer(paths)
    live_version = live_pointer.version if live_pointer is not None else None
    return {
        "publishes": [
            {**entry.to_dict(), "live": entry.version == live_version} for entry in newest_first
        ]
    }


# ---------------------------------------------------------------------------
# GET /api/admin/publish/preview (milestone 9 slice 2 — the review drawer's
# draft diff + validate result, spec/05 §5's "review drawer")
# ---------------------------------------------------------------------------

_DRAFT_MEDIA_URL_PREFIX = "/admin/draft-media/"


def _binding_kind_lookup(merged: SiteSource) -> dict[str, dict[str, str]]:
    """`{file_key: {dotted_key: kind}}` for every page's own bindings, plus one
    shared `_global` entry (globals/partials are common to every page, so any
    single page's bindings map already carries every `_global` binding too —
    picked up here for free from whichever page is computed first, no extra
    `extract_bindings_map` call). `theme` keys have no bindings-map entry at
    all (spec's theme model is a separate typed thing, never walked via
    `data-wx-*` attributes) — the caller reports `"theme"` directly instead."""
    lookup: dict[str, dict[str, str]] = {}
    for slug in merged.page_contents:
        bindings = extract_bindings_map(merged, slug)
        lookup[slug] = {field.key: field.kind for field in bindings.fields}
    lookup[GLOBAL_CONTENT_NAME] = dict(lookup[sorted(lookup)[0]]) if lookup else {}
    return lookup


def _container_for(source: SiteSource, file_key: str) -> JsonValue:
    if file_key == "theme":
        return theme_to_dict(source.theme) if source.theme is not None else None
    if file_key == GLOBAL_CONTENT_NAME:
        return source.global_content
    return source.page_contents.get(file_key)


def _staged_image_keys(source: SiteSource, paths: ProjectPaths) -> set[tuple[str, str]]:
    """`(file_label, dotted_key)` pairs whose image ref points at a currently
    staged (not-yet-published) draft upload that genuinely exists on disk —
    `validate_site`'s own image-existence check (`(project_root / src).
    exists()`) always false-positives on these: `src` is `/admin/draft-media/
    <name>` and an absolute-looking rhs wins pathlib's `/` operator, discarding
    `project_root` entirely, even though the file is a perfectly legitimate
    about-to-be-published upload. Mirrors `builder.validate._validate_images`'s
    own traversal exactly, so its errors can be filtered by these same keys."""
    all_content: dict[str, JsonObject] = {**source.page_contents, "_global": source.global_content}
    keys: set[tuple[str, str]] = set()
    for slug, content in all_content.items():
        file_label = "content/_global.json" if slug == "_global" else f"content/{slug}.json"
        for key_path, src in scan_image_refs(content):
            if src.startswith(_DRAFT_MEDIA_URL_PREFIX):
                name = src[len(_DRAFT_MEDIA_URL_PREFIX) :]
                if (paths.draft_media / name).is_file():
                    keys.add((file_label, key_path))
    return keys


def _build_publish_preview(
    project: ProjectConfig, paths: ProjectPaths, overlay: Overlay
) -> JsonObject:
    old_source = build_site_source(project, paths.repo)
    merged = merge_overlay(old_source, overlay)
    kinds = _binding_kind_lookup(merged)

    changes: dict[str, list[JsonValue]] = {}
    for key in sorted(overlay.ops):
        op = overlay.ops[key]
        file_key, sep, dotted_path = key.partition(":")
        if not sep:
            continue  # malformed key (no ':') — same defensive skip merge_overlay uses
        _, old_value = dotted_get(_container_for(old_source, file_key), dotted_path)
        kind = "theme" if file_key == "theme" else kinds.get(file_key, {}).get(dotted_path, "text")
        entry: JsonObject = {"key": dotted_path, "kind": kind, "old": old_value, "new": op.value}
        changes.setdefault(file_key, []).append(entry)

    validate_result = validate_site(merged, paths.repo)
    safe_image_keys = _staged_image_keys(merged, paths)
    filtered_errors = [
        e
        for e in validate_result.errors
        if not (e.code == "missing-image" and (e.file, e.key) in safe_image_keys)
    ]

    return {
        "changes": {
            file_key: [entry for entry in entries] for file_key, entries in changes.items()
        },
        "validate": {
            "ok": not filtered_errors,
            "errors": [{k: v for k, v in e.to_dict().items()} for e in filtered_errors],
        },
    }


@router.get("/publish/preview", response_model=None)
async def get_publish_preview(request: Request) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths

    def _build() -> JsonObject:
        overlay = _load_overlay_for(paths)
        return _build_publish_preview(project, paths, overlay)

    try:
        return await anyio.to_thread.run_sync(_build)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# POST /api/admin/restore (milestone 9 slice 3)
# ---------------------------------------------------------------------------


class RestoreIn(BaseModel):
    version: int


@router.post("/restore", response_model=None)
async def post_restore(body: RestoreIn, request: Request) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    publish_job: PublishJob | None = request.app.state.publish_job
    if publish_job is not None and publish_job.is_running:
        raise HTTPException(status_code=409, detail="a publish is currently running")

    now = datetime.now(UTC).isoformat()

    def _run() -> RestoreResult:
        return run_restore(project, paths, version=body.version, now=now)

    try:
        result = await anyio.to_thread.run_sync(_run)
    except CheckoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RestoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"version": result.version, "sha": result.sha, "of": result.of}
