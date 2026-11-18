"""Chunked upload staging/assembly (spec/server-chat/00-brief.md §5.5, R11).

Every function here takes explicit collaborators (a `LiveChatStore`, `ProjectPaths`,
byte caps) rather than reading settings/app.state itself — `routes_livechat_media.py`
is the thin FastAPI layer that resolves those from `request.app.state` and maps each
exception here to its §5.5 HTTP status + body shape (mirroring how `routes_livechat.py`
maps `store.py`'s exceptions).

Storage layout (§4): `uploads/<uploadId>/chunk-000000 ... ; assembled`. The upload id
becomes the attachment id once promoted at `/complete` — there is no separate
"original file path" column on `AttachmentRow` (the frozen schema has none), so the
convention IS the pointer: a processing worker looks for its source at
`uploads/<attachmentId>/assembled`.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from pathlib import Path

from wixy_server.livechat.models import AttachmentKind, AttachmentRow, UploadRow
from wixy_server.livechat.store import LiveChatStore
from wixy_server.storage import ProjectPaths

_MiB = 1024 * 1024
_GiB = 1024 * _MiB

# `upload_id` is always server-generated via `uuid.uuid4().hex` (see `init_upload`
# below) and is never meant to reach the filesystem unvalidated: `server_upload_dir`
# is a plain path join with no normalization, so an id of ".." resolves to the
# parent `server/` directory (DB, secret.key, vapid.json, every attachment's media).
_UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{32}$")

UNSENT_IDLE_S = 20.0
"""A live upload is offered back as an "unsent voice note" only after this long without a slice
(spec/server-chat/06 §2.1), so a recording still going in another tab is never offered."""
MAX_LIVE_PER_CHAT = 2
"""spec/server-chat/07 §2: at most this many voice notes may be recorded live at once."""
LIVE_DRAIN_LEASE_OWNER = "live-drain"
LIVE_DRAIN_LEASE_S = 120.0
"""When a live note ends it turns `processing` at once, but the media queue is held off with this
lease while the live decoder drains the last slices from the assembled file (the decoder releases
it; a crash lets it lapse and the queue takes the note)."""
MAX_LIVE_CHUNK_COUNT = 100_000
"""Bound on the `chunkCount` a client may claim at `/complete` (a four-hour recording at one
slice every 15 s is 960): keeps the missing-slice scan bounded for a hostile value."""

MAX_UPLOAD_BYTES: dict[AttachmentKind, int] = {
    "photo": 30 * _MiB,
    # spec/server-chat/06 §1: a runaway guard for a recording left running (4 h at the 64 kbit/s
    # the recorder asks for is about 115 MB), not a product limit — it was 25 MiB (R11).
    "voice": 512 * _MiB,
    "video": 1 * _GiB,
}

ALLOWED_MIME_TYPES: dict[AttachmentKind, frozenset[str]] = {
    "photo": frozenset(
        {"image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"}
    ),
    "video": frozenset(
        {"video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-matroska"}
    ),
    "voice": frozenset(
        {
            "audio/webm",
            "audio/ogg",
            "audio/mp4",
            "audio/mpeg",
            "audio/aac",
            "audio/wav",
            "audio/x-m4a",
        }
    ),
}

_FAILED_EXT_BY_MIME: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/3gpp": "3gp",
    "video/x-matroska": "mkv",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-m4a": "m4a",
}


def failed_extension(mime: str | None) -> str:
    """The `.ext` in `failed/<id>/original.<ext>` (§4) — best-effort, for a
    human diagnosing a failure; never used to decide processing behavior."""
    if mime is None:
        return "bin"
    return _FAILED_EXT_BY_MIME.get(mime, "bin")


# ---------------------------------------------------------------------------
# Errors — routes_livechat_media.py maps each to its §5.5 status + body.
# ---------------------------------------------------------------------------


class UploadError(Exception):
    """Base for every upload-flow rejection."""


class MediaUnavailableError(UploadError):
    def __init__(self) -> None:
        super().__init__("ffmpeg/ffprobe/pillow-heif unavailable")


class UnsupportedTypeError(UploadError):
    def __init__(self, mime_type: str) -> None:
        super().__init__(f"unsupported declared MIME type {mime_type!r}")
        self.mime_type = mime_type


class TooLargeError(UploadError):
    def __init__(self, max_bytes: int) -> None:
        super().__init__(f"exceeds the {max_bytes}-byte cap")
        self.max_bytes = max_bytes


class StorageFullError(UploadError):
    def __init__(self) -> None:
        super().__init__("quota or free-space floor exceeded")


class UnknownUploadError(UploadError):
    def __init__(self, upload_id: str) -> None:
        super().__init__(f"unknown upload {upload_id!r}")
        self.upload_id = upload_id


def cleanup_deleted_upload(*, store: LiveChatStore, paths: ProjectPaths, upload_id: str) -> None:
    """Requeue and remove files recreated by a late write for a deleted upload."""
    if not _UPLOAD_ID_RE.fullmatch(upload_id):
        return

    store.requeue_deleted_storage_if_exists(kind="upload", storage_id=upload_id)
    from wixy_server.livechat.janitor import cleanup_deleted_storage_once

    cleanup_deleted_storage_once(store=store, paths=paths, only_items={("upload", upload_id)})


class InvalidChunkIndexError(UploadError):
    def __init__(self, index: int) -> None:
        super().__init__(f"chunk index {index} out of range")
        self.index = index


class ChunkTooLargeError(UploadError):
    def __init__(self, chunk_bytes: int) -> None:
        super().__init__(f"chunk exceeds the {chunk_bytes}-byte cap")
        self.chunk_bytes = chunk_bytes


class IncompleteUploadError(UploadError):
    def __init__(self, missing: list[int]) -> None:
        super().__init__(f"missing chunks: {missing}")
        self.missing = missing


class SizeMismatchError(UploadError):
    def __init__(self) -> None:
        super().__init__("assembled size differs from the declared size")


class OutOfOrderChunkError(UploadError):
    """A live upload was sent a slice beyond the next missing one (spec/server-chat/06 §2.1)."""

    def __init__(self, next_index: int) -> None:
        super().__init__(f"chunk is out of order; the next expected index is {next_index}")
        self.next_index = next_index


class NotLiveUploadError(UploadError):
    def __init__(self, upload_id: str) -> None:
        super().__init__(f"upload {upload_id!r} is not a live upload")
        self.upload_id = upload_id


class LiveEndedError(UploadError):
    """A slice arrived for a live upload whose recording has already ended (completed, auto-ended
    or recovered after a restart): it is not stored (spec/server-chat/07 §6.1, 409 `not_live`)."""

    def __init__(self, upload_id: str) -> None:
        super().__init__(f"live upload {upload_id!r} has already ended")
        self.upload_id = upload_id


# ---------------------------------------------------------------------------
# Init (POST /uploads)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class InitResult:
    upload_id: str
    chunk_bytes: int
    max_bytes: int
    attachment: AttachmentRow | None = None
    """Only for a `listen` init: the attachment row created with the upload (status `live`)."""


DiskUsage = Callable[[str], tuple[int, int, int]]
"""`(total, used, free)` in bytes — `shutil.disk_usage`'s own return shape,
injectable so tests can simulate a full disk without one."""


def init_upload(
    *,
    store: LiveChatStore,
    kind: AttachmentKind,
    mime_type: str,
    size_bytes: int,
    filename: str | None,
    by_email: str | None,
    chunk_bytes: int,
    quota_bytes: int,
    min_free_bytes: int,
    media_available: bool,
    disk_check_path: Path,
    now: float,
    disk_usage: DiskUsage = shutil.disk_usage,
    live: bool = False,
    device_id: str | None = None,
    listen: bool = False,
) -> InitResult:
    """§5.5's `POST /uploads`. Check order (unspecified by the frozen contract,
    chosen for cheapest-rejection-first): the systemic media-pipeline gate, then
    the declared type, then the declared size, then quota/free-space — each of
    the first three needs no DB query, so a doomed request never reaches one.

    A `live` upload (spec/server-chat/06 §2.1, voice only) declares no size — it is a recording
    still being made, uploaded slice by slice — so `size_bytes` is ignored, the row starts at
    zero, and quota/free space are checked against zero bytes here (and per slice later).

    `listen` (spec/server-chat/07 §6.1, needs `live`) also creates the attachment row at once, in
    status `live`, so the other person can hear the note while it is recorded; a chat already
    recording `MAX_LIVE_PER_CHAT` notes raises `store.TooManyLiveError`."""
    if not media_available:
        raise MediaUnavailableError()
    if mime_type not in ALLOWED_MIME_TYPES[kind]:
        raise UnsupportedTypeError(mime_type)
    if listen and not live:
        raise ValueError("listen needs a live upload")
    if live:
        if kind != "voice":
            raise ValueError("live uploads are voice only")
        if not device_id:
            raise ValueError("a live upload needs a device id")
        size_bytes = 0
    elif size_bytes < 1:
        raise ValueError("size_bytes must be positive")
    max_bytes = MAX_UPLOAD_BYTES[kind]
    if size_bytes > max_bytes:
        raise TooLargeError(max_bytes)

    used = store.media_bytes_used() + store.pending_upload_bytes()
    if used + size_bytes > quota_bytes:
        raise StorageFullError()
    _total, _used, free = disk_usage(str(disk_check_path))
    if free - size_bytes < min_free_bytes:
        raise StorageFullError()

    upload_id = uuid.uuid4().hex
    row = UploadRow(
        id=upload_id,
        kind=kind,
        mime=mime_type,
        size_bytes=size_bytes,
        filename=filename,
        by_email=by_email,
        created_at=now,
        live=live,
        device_id=device_id if live else None,
    )
    if listen:
        attachment = store.create_live_upload(row, now=now, max_live=MAX_LIVE_PER_CHAT)
        return InitResult(
            upload_id=upload_id,
            chunk_bytes=chunk_bytes,
            max_bytes=max_bytes,
            attachment=attachment,
        )
    store.create_upload(row)
    return InitResult(upload_id=upload_id, chunk_bytes=chunk_bytes, max_bytes=max_bytes)


# ---------------------------------------------------------------------------
# Chunks (PUT /uploads/{id}/chunks/{index})
# ---------------------------------------------------------------------------


def expected_chunk_count(size_bytes: int, chunk_bytes: int) -> int:
    return math.ceil(size_bytes / chunk_bytes) if size_bytes > 0 else 0


def validate_chunk_index(index: int, size_bytes: int, chunk_bytes: int) -> None:
    count = expected_chunk_count(size_bytes, chunk_bytes)
    if not (0 <= index < count):
        raise InvalidChunkIndexError(index)


async def read_capped(chunks: AsyncIterator[bytes], *, cap: int) -> bytes:
    """Reads an async byte-chunk iterator (e.g. `request.stream()`) with a hard
    running cap, raising the moment it's exceeded rather than after buffering
    the whole (oversized) body — kept as a pure function over an iterator, not
    `Request`, so it's unit-testable without a real ASGI request."""
    buffer = bytearray()
    async for piece in chunks:
        buffer.extend(piece)
        if len(buffer) > cap:
            raise ChunkTooLargeError(cap)
    return bytes(buffer)


def _chunk_path(upload_dir: Path, index: int) -> Path:
    return upload_dir / f"chunk-{index:06d}"


def write_chunk(upload_dir: Path, index: int, data: bytes) -> None:
    """Idempotent: re-PUTting the same index overwrites it (§5.5). Writes to
    `.part` then renames, so a crash mid-write never leaves a half-written
    chunk at the real name for `assemble()` to trip over."""
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = _chunk_path(upload_dir, index)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, dest)


def _contiguous_chunk_sizes(upload_dir: Path) -> list[int]:
    """Sizes of chunks 0, 1, 2, ... up to the first missing one."""
    sizes: list[int] = []
    while True:
        try:
            sizes.append(_chunk_path(upload_dir, len(sizes)).stat().st_size)
        except FileNotFoundError:
            return sizes


def prepare_live_chunk(
    *,
    store: LiveChatStore,
    upload: UploadRow,
    upload_dir: Path,
    index: int,
    data_len: int,
    quota_bytes: int,
    min_free_bytes: int,
    disk_check_path: Path,
    disk_usage: DiskUsage = shutil.disk_usage,
) -> int:
    """Admit one slice of a live upload (spec/server-chat/06 §2.1) and return the upload's
    running size once it is stored.

    The index must be the next missing one or an existing one (an idempotent re-PUT): a gap is
    `OutOfOrderChunkError`. The running total over the kind's cap is `TooLargeError`; a slice
    that would push stored media past the quota or under the free-space floor is
    `StorageFullError` — in both cases before anything is written."""
    if not upload.live:
        raise NotLiveUploadError(upload.id)
    promoted = store.get_attachment(upload.id)
    if promoted is not None and promoted.live_state is None:
        # The recording was completed (or auto-ended / recovered) and its attachment promoted: a
        # late slice must not recreate chunk files beside the assembled original.
        raise LiveEndedError(upload.id)
    if index < 0:
        raise InvalidChunkIndexError(index)
    sizes = _contiguous_chunk_sizes(upload_dir)
    if index > len(sizes):
        raise OutOfOrderChunkError(len(sizes))
    replaced = sizes[index] if index < len(sizes) else 0
    total = sum(sizes) - replaced + data_len
    max_bytes = MAX_UPLOAD_BYTES[upload.kind]
    if total > max_bytes:
        raise TooLargeError(max_bytes)
    growth = data_len - replaced
    if growth > 0:
        # `pending_upload_bytes` already counts this upload's slices stored so far.
        if store.media_bytes_used() + store.pending_upload_bytes() + growth > quota_bytes:
            raise StorageFullError()
        _total, _used, free = disk_usage(str(disk_check_path))
        if free - growth < min_free_bytes:
            raise StorageFullError()
    return total


# ---------------------------------------------------------------------------
# Complete (POST /uploads/{id}/complete)
# ---------------------------------------------------------------------------


def assemble(
    *,
    store: LiveChatStore,
    paths: ProjectPaths,
    upload_id: str,
    chunk_bytes: int,
    now: float,
    chunk_count: int | None = None,
) -> AttachmentRow:
    """Promotes a fully-chunked upload into an attachment (status `processing`),
    reusing `upload_id` as the attachment id (see module docstring). Idempotent:
    a retried `/complete` after the first one already succeeded replays the same
    attachment rather than re-assembling or erroring — same posture as
    `store.create_message`'s `clientId` replay.

    A live upload (spec/server-chat/06 §2.1) has no declared size: its chunk count is
    `chunk_count` when the client says how many it sent, otherwise every present contiguous
    chunk, and its size is whatever those chunks add up to (settled onto the row). `chunk_count`
    is ignored for an ordinary upload."""
    existing = store.get_attachment(upload_id)
    if existing is not None and existing.live_state is None:
        return existing

    upload = store.get_upload(upload_id)
    if upload is None:
        raise UnknownUploadError(upload_id)

    upload_dir = paths.server_upload_dir(upload_id)
    try:
        if upload.live:
            expected_size: int | None = None
            if chunk_count is None:
                count = len(_contiguous_chunk_sizes(upload_dir))
                missing = [0] if count == 0 else []
            else:
                count = chunk_count
                missing = [i for i in range(count) if not _chunk_path(upload_dir, i).is_file()]
        else:
            expected_size = upload.size_bytes
            count = expected_chunk_count(upload.size_bytes, chunk_bytes)
            missing = [i for i in range(count) if not _chunk_path(upload_dir, i).is_file()]
        if missing:
            if store.get_upload(upload_id) is None:
                cleanup_deleted_upload(store=store, paths=paths, upload_id=upload_id)
                raise UnknownUploadError(upload_id)
            raise IncompleteUploadError(missing)

        assembled_path = upload_dir / "assembled"
        tmp_path = upload_dir / "assembled.part"
        total = 0
        with tmp_path.open("wb") as out:
            for i in range(count):
                data = _chunk_path(upload_dir, i).read_bytes()
                out.write(data)
                total += len(data)
        if expected_size is not None and total != expected_size:
            tmp_path.unlink(missing_ok=True)
            if store.get_upload(upload_id) is None:
                cleanup_deleted_upload(store=store, paths=paths, upload_id=upload_id)
                raise UnknownUploadError(upload_id)
            raise SizeMismatchError()
        if expected_size is None and not store.set_live_upload_size(upload_id, total):
            tmp_path.unlink(missing_ok=True)
            cleanup_deleted_upload(store=store, paths=paths, upload_id=upload_id)
            raise UnknownUploadError(upload_id)
        os.replace(tmp_path, assembled_path)
        for i in range(count):
            _chunk_path(upload_dir, i).unlink(missing_ok=True)
        if upload.live:
            # A slice past the client's own `chunkCount` is not part of the recording.
            for leftover in upload_dir.glob("chunk-*"):
                leftover.unlink(missing_ok=True)
    except OSError:
        # A concurrent delete/wipe racing this assemble may remove
        # upload_dir mid-operation. On Windows that surfaces as
        # PermissionError ("Access is denied") rather than
        # FileNotFoundError when another thread is mid-rmtree on the same
        # path (janitor.py's own cleanup catches the same broad OSError for
        # the identical reason) — catching OSError here handles both
        # signatures of the same race, and the re-check below still
        # re-raises anything that isn't actually the concurrent delete
        # winning.
        if store.get_upload(upload_id) is None:
            cleanup_deleted_upload(store=store, paths=paths, upload_id=upload_id)
            raise UnknownUploadError(upload_id) from None
        raise

    if existing is not None:
        # A note that was being recorded live (spec/server-chat/07): its attachment row already
        # exists; the live phase ends here and the normal pipeline takes over. The queue is held
        # off while the live decoder drains (`LIVE_DRAIN_LEASE_*`).
        ended = store.end_live(
            upload_id, now=now, lease_owner=LIVE_DRAIN_LEASE_OWNER, lease_s=LIVE_DRAIN_LEASE_S
        )
        if ended is None:
            cleanup_deleted_upload(store=store, paths=paths, upload_id=upload_id)
            raise UnknownUploadError(upload_id)
        return ended
    attachment = store.create_attachment_from_upload(att_id=upload_id, kind=upload.kind, now=now)
    if attachment is None:
        cleanup_deleted_upload(store=store, paths=paths, upload_id=upload_id)
        raise UnknownUploadError(upload_id)
    return attachment


# ---------------------------------------------------------------------------
# Cancel (DELETE /uploads/{id})
# ---------------------------------------------------------------------------


def cancel_upload(*, store: LiveChatStore, paths: ProjectPaths, upload_id: str) -> None:
    """§5.5's `DELETE /uploads/{uploadId}` → 204, unconditionally (the frozen
    contract defines no error case). Once `/complete` has promoted the id to an
    attachment, there's nothing left here to cancel — the queue now owns the
    staged file — so this is a no-op rather than disturbing a claim in flight."""
    if not _UPLOAD_ID_RE.fullmatch(upload_id):
        return
    if store.get_attachment(upload_id) is not None:
        return
    store.delete_upload(upload_id)
    cleanup_deleted_upload(store=store, paths=paths, upload_id=upload_id)
