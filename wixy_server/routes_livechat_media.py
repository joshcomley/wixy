"""`/api/admin/server/{uploads,media}/*` — the server-chat chunked-upload and
signed-media routes (spec/server-chat/00-brief.md §5.5/§5.6, P2b). Every route
except `GET /media/*` (which uses a signed query string instead — an
`<img>`/`<video>`/`<audio>` element can't send a custom header) calls
`require_server_token` first, same convention as `routes_livechat.py`.
"""

from __future__ import annotations

import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import anyio
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from builder.jsontypes import JsonObject
from wixy_server.livechat import uploads
from wixy_server.livechat.grants import GRANT_ID_RE, GRANT_IDLE_EXPIRY_S
from wixy_server.livechat.models import AttachmentRow, UploadRow, attachment_json
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import MediaSigner, require_server_token, verify_media_signature
from wixy_server.settings import Settings
from wixy_server.storage import ProjectPaths

router = APIRouter(prefix="/api/admin/server")

# ---------------------------------------------------------------------------
# POST /uploads (§5.5) — init.
# ---------------------------------------------------------------------------


class InitUploadIn(BaseModel):
    kind: Literal["photo", "video", "voice"]
    mimeType: str
    sizeBytes: int = Field(ge=1)
    filename: str | None = None


@router.post("/uploads", response_model=None)
async def init_upload(body: InitUploadIn, request: Request) -> JSONResponse:
    auth = await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    paths: ProjectPaths = request.app.state.paths
    settings: Settings = request.app.state.settings
    media_available: bool = request.app.state.livechat_media_available

    def _init() -> uploads.InitResult:
        return uploads.init_upload(
            store=store,
            kind=body.kind,
            mime_type=body.mimeType,
            size_bytes=body.sizeBytes,
            filename=body.filename,
            by_email=auth.email or None,
            chunk_bytes=settings.server_upload_chunk_bytes,
            quota_bytes=settings.server_media_quota_bytes,
            min_free_bytes=settings.server_min_free_bytes,
            media_available=media_available,
            disk_check_path=paths.root,
            now=time.time(),
        )

    try:
        result = await anyio.to_thread.run_sync(_init)
    except uploads.MediaUnavailableError:
        return JSONResponse(status_code=503, content={"error": "media_unavailable"})
    except uploads.UnsupportedTypeError:
        return JSONResponse(status_code=415, content={"error": "unsupported_type"})
    except uploads.TooLargeError as exc:
        return JSONResponse(
            status_code=413, content={"error": "too_large", "maxBytes": exc.max_bytes}
        )
    except uploads.StorageFullError:
        return JSONResponse(status_code=507, content={"error": "storage_full"})

    return JSONResponse(
        status_code=201,
        content={
            "uploadId": result.upload_id,
            "chunkBytes": result.chunk_bytes,
            "maxBytes": result.max_bytes,
        },
    )


# ---------------------------------------------------------------------------
# PUT /uploads/{id}/chunks/{index} (§5.5).
# ---------------------------------------------------------------------------


@router.put("/uploads/{upload_id}/chunks/{index}", response_model=None)
async def put_chunk(upload_id: str, index: int, request: Request) -> Response:
    await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    paths: ProjectPaths = request.app.state.paths
    settings: Settings = request.app.state.settings

    def _get_upload() -> UploadRow | None:
        return store.get_upload(upload_id)

    upload = await anyio.to_thread.run_sync(_get_upload)
    if upload is None:
        raise HTTPException(status_code=404, detail="unknown upload")

    try:
        uploads.validate_chunk_index(index, upload.size_bytes, settings.server_upload_chunk_bytes)
    except uploads.InvalidChunkIndexError:
        raise HTTPException(status_code=422, detail="chunk index out of range") from None

    try:
        data = await uploads.read_capped(request.stream(), cap=settings.server_upload_chunk_bytes)
    except uploads.ChunkTooLargeError as exc:
        return JSONResponse(
            status_code=413, content={"error": "too_large", "maxBytes": exc.chunk_bytes}
        )

    upload_dir = paths.server_upload_dir(upload_id)

    def _write() -> None:
        uploads.write_chunk(upload_dir, index, data)

    # Keep the filesystem write and its post-write row check in one shielded
    # operation. A disconnect after the write must not skip the cleanup check.
    with anyio.CancelScope(shield=True):
        write_error: OSError | None = None
        try:
            await anyio.to_thread.run_sync(_write)
        except OSError as exc:
            # A concurrent delete/wipe may remove upload_dir mid-write; on
            # Windows this raises PermissionError rather than letting the
            # write raise nothing and simply vanish. Fall through to the
            # same row check below instead of letting the raw exception
            # skip it — that check is what decides "benign race" vs.
            # "genuine error", not the write's own exception type.
            write_error = exc
        upload_still_open = await anyio.to_thread.run_sync(lambda: store.get_upload(upload_id))
        if upload_still_open is None:
            attachment_exists = await anyio.to_thread.run_sync(
                lambda: store.get_attachment(upload_id) is not None
            )
            if not attachment_exists:
                await anyio.to_thread.run_sync(
                    lambda: uploads.cleanup_deleted_upload(
                        store=store, paths=paths, upload_id=upload_id
                    )
                )
            raise HTTPException(status_code=404, detail="unknown upload") from write_error
        if write_error is not None:
            raise write_error
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# POST /uploads/{id}/complete (§5.5).
# ---------------------------------------------------------------------------


@router.post("/uploads/{upload_id}/complete", response_model=None)
async def complete_upload(upload_id: str, request: Request) -> JSONResponse:
    auth = await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    paths: ProjectPaths = request.app.state.paths
    settings: Settings = request.app.state.settings
    secret: bytes = request.app.state.livechat_secret

    def _assemble() -> AttachmentRow:
        return uploads.assemble(
            store=store,
            paths=paths,
            upload_id=upload_id,
            chunk_bytes=settings.server_upload_chunk_bytes,
            now=time.time(),
        )

    try:
        attachment = await anyio.to_thread.run_sync(_assemble)
    except uploads.UnknownUploadError:
        raise HTTPException(status_code=404, detail="unknown upload") from None
    except uploads.IncompleteUploadError as exc:
        return JSONResponse(
            status_code=409, content={"error": "incomplete", "missing": exc.missing}
        )
    except uploads.SizeMismatchError:
        return JSONResponse(status_code=422, content={"error": "size_mismatch"})

    signer = MediaSigner.for_auth(secret, auth)
    return JSONResponse(
        status_code=202, content={"attachment": attachment_json(attachment, signer)}
    )


# ---------------------------------------------------------------------------
# DELETE /uploads/{id} (§5.5).
# ---------------------------------------------------------------------------


@router.delete("/uploads/{upload_id}", response_model=None)
async def delete_upload(upload_id: str, request: Request) -> Response:
    await require_server_token(request)
    store: LiveChatStore = request.app.state.livechat_store
    paths: ProjectPaths = request.app.state.paths

    def _cancel() -> None:
        uploads.cancel_upload(store=store, paths=paths, upload_id=upload_id)

    await anyio.to_thread.run_sync(_cancel)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# GET /media/{attId}/{rendition} (§5.6).
# ---------------------------------------------------------------------------

_ATTACHMENT_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# Each rendition name maps to the possible filenames P2a's processing.py can
# have written for it (§7: alpha photos use PNG renditions, opaque PNG/static
# GIF keep lossless full images, and animated GIF keeps its original bytes).
_RENDITION_FILENAMES: dict[str, tuple[str, ...]] = {
    "full": ("full.jpg", "full.png", "full.gif"),
    "thumb": ("thumb.png", "thumb.jpg"),
    "play": ("play.mp4", "play.m4a"),
    "poster": ("poster.jpg",),
}

_MEDIA_TYPE_BY_SUFFIX: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".m4a": "audio/mp4",
}


def _resolve_rendition_path(paths: ProjectPaths, att_id: str, rendition: str) -> Path | None:
    media_dir = paths.server_attachment_media_dir(att_id)
    for filename in _RENDITION_FILENAMES.get(rendition, ()):
        candidate = media_dir / filename
        if candidate.is_file():
            return candidate
    return None


_DOWNLOAD_EXTENSION_BY_MIME: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
}


def download_filename(att: AttachmentRow, rendition: str) -> str:
    """The name a saved copy gets: `wixy-<UTC date>-<UTC time>-<first 8 of the id>[-<rendition>]
    .<ext>` — sortable, unique, and carrying nothing but what the file already is (the sender's
    original filename is never stored). ASCII only, so it is safe in a header as-is."""
    stamp = datetime.fromtimestamp(att.created_at, tz=UTC).strftime("%Y%m%d-%H%M%S")
    extension = _DOWNLOAD_EXTENSION_BY_MIME.get(
        att.mime or "", ".jpg" if att.kind == "photo" else ".mp4"
    )
    # A still rendition (thumb/poster) is always a JPEG or PNG, never the original's container.
    if rendition in ("thumb", "poster"):
        suffix = f"-{rendition}"
        extension = ".jpg" if att.mime != "image/png" or rendition == "poster" else ".png"
    else:
        suffix = ""
    return f"wixy-{stamp}-{att.id[:8]}{suffix}{extension}"


@router.get("/media/{att_id}/{rendition}", response_model=None)
async def get_media(
    att_id: str,
    rendition: str,
    request: Request,
    exp: int,
    sig: str,
    g: str | None = None,
    dl: int = 0,
) -> Response:
    # §2: "IDs are validated as 32 hex characters" — checked before the
    # signature math even runs, as cheap defense in depth (a forged/tampered id
    # can never pass `verify_media_signature` anyway, since it's covered by the
    # HMAC, but this fails a malformed id fast without touching the filesystem).
    if not _ATTACHMENT_ID_RE.match(att_id) or rendition not in _RENDITION_FILENAMES:
        raise HTTPException(status_code=404)
    # A `g` of the wrong shape can never match a real signature (it's part of the HMAC
    # message), but reject it here so a malformed value never reaches the grant lookup below.
    if g is not None and not GRANT_ID_RE.fullmatch(g):
        raise HTTPException(status_code=403)

    secret: bytes = request.app.state.livechat_secret
    access_email = getattr(request.state, "access_email", None) or ""
    store: LiveChatStore = request.app.state.livechat_store
    if not verify_media_signature(
        secret,
        attachment_id=att_id,
        rendition=rendition,
        exp=exp,
        email=access_email,
        signature=sig,
        now=time.time(),
        grant_id=g,
    ):
        raise HTTPException(status_code=403)
    bound_grant_id = g
    if bound_grant_id is not None:
        # §9 (audit F4): a bound media URL re-checks grant liveness on every fetch, the same
        # way a bound token does — otherwise a link handed out before "Sign out other
        # devices" would keep loading for the rest of its 12h `exp`.
        live = await anyio.to_thread.run_sync(
            lambda: store.is_device_grant_live(
                grant_id=bound_grant_id,
                email=access_email,
                now=time.time(),
                max_idle_s=GRANT_IDLE_EXPIRY_S,
            )
        )
        if not live:
            raise HTTPException(status_code=403)

    paths: ProjectPaths = request.app.state.paths
    attachment = await anyio.to_thread.run_sync(lambda: store.get_attachment(att_id))
    if attachment is None:
        # Deletion is authoritative even if Windows could not unlink an open
        # rendition yet; the durable cleanup worker will retry the file removal.
        raise HTTPException(status_code=404)

    is_vo = await anyio.to_thread.run_sync(lambda: store.is_attachment_view_once(att_id))
    if is_vo:
        raise HTTPException(status_code=404)

    def _resolve() -> Path | None:
        return _resolve_rendition_path(paths, att_id, rendition)

    path = await anyio.to_thread.run_sync(_resolve)
    if path is None:
        raise HTTPException(status_code=404)

    # `dl=1` (the gallery's save links) only changes how the browser treats the bytes — save,
    # not show — so it is deliberately NOT part of the signature: it grants nothing `inline`
    # does not already.
    disposition = "inline"
    if dl == 1:
        disposition = f'attachment; filename="{download_filename(attachment, rendition)}"'
    return FileResponse(
        path,
        media_type=_MEDIA_TYPE_BY_SUFFIX.get(path.suffix, "application/octet-stream"),
        headers={
            "Cache-Control": "private, no-cache",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": disposition,
        },
    )


# ---------------------------------------------------------------------------
# GET /gallery — the media history (workspace 00046).
# ---------------------------------------------------------------------------

_GALLERY_CURSOR_RE = re.compile(r"^(\d+)\.(\d+)$")
_GALLERY_MAX_LIMIT = 200


def gallery_item_json(att: AttachmentRow, signer: MediaSigner) -> JsonObject:
    """One gallery tile: the ordinary attachment wire shape (`urls` carries the freshly signed
    renditions) plus its place in history (`seq`/`ordinal` — also the cursor and the device's
    "last downloaded" mark), when it was sent, and the one link that saves the original: the
    photo's `full` or the video's `play`, with `dl=1` and the name it will be saved under."""
    item = attachment_json(att, signer)
    original = "full" if att.kind == "photo" else "play"
    download_url: str | None = None
    if original in att.renditions:
        download_url = signer.url_for(att.id, original) + "&dl=1"
    item["seq"] = att.message_seq
    item["ordinal"] = att.ordinal
    item["createdAt"] = att.created_at
    item["downloadUrl"] = download_url
    item["filename"] = download_filename(att, original)
    return item


@router.get("/gallery", response_model=None)
async def get_gallery(request: Request, before: str | None = None, limit: int = 100) -> JsonObject:
    """Every photo and video in the chat, newest first, a page at a time. `before` is the
    previous page's last `"<seq>.<ordinal>"`. View-once media and the would-you-rather
    round's generated pictures never appear (`LiveChatStore.list_gallery`)."""
    auth = await require_server_token(request)
    if not (1 <= limit <= _GALLERY_MAX_LIMIT):
        raise HTTPException(
            status_code=422, detail=f"limit must be between 1 and {_GALLERY_MAX_LIMIT}"
        )
    cursor: tuple[int, int] | None = None
    if before is not None:
        match = _GALLERY_CURSOR_RE.match(before)
        if match is None:
            raise HTTPException(status_code=422, detail="before must look like 12.0")
        cursor = (int(match.group(1)), int(match.group(2)))
    store: LiveChatStore = request.app.state.livechat_store
    signer = MediaSigner.for_auth(request.app.state.livechat_secret, auth)
    rows, has_more = await anyio.to_thread.run_sync(
        lambda: store.list_gallery(before=cursor, limit=limit)
    )
    return {"items": [gallery_item_json(att, signer) for att in rows], "hasMore": has_more}
