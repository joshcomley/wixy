"""Lease-based background worker (spec/server-chat/00-brief.md §7 Queue, §10 P2b):
turns a `processing` attachment into `ready`/`failed` by feeding P2a's pure
`processing.process()` and calling `store.finish_attachment`. Runs as one
app-lifetime `anyio` task (`run_forever`, started from `app.py`'s lifespan task
group alongside the watcher), spawning one child task per claimed attachment.

Crash-resume (§7): `store.claim_processing`'s own query — "unclaimed OR lease
expired" — already re-surfaces a row orphaned by a killed process the moment its
lease lapses. No separate recovery step exists or is needed; `run_forever`'s
ordinary claim loop IS the recovery path, on every startup.

Concurrency (§7): a video claim acquires `video_limiter` (1 slot), everything
else acquires `photo_voice_limiter` (2 slots) — chosen AFTER claiming, since
`claim_processing`'s frozen signature has no kind filter to claim selectively.
The per-attachment lease-renewal loop starts the moment a row is claimed, before
it may have to wait behind a full limiter, so a claim queued behind a busy
limiter never goes lease-stale and gets double-claimed by another worker.
"""

from __future__ import annotations

import logging
import os
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import anyio
from anyio import CapacityLimiter

from wixy_server.livechat import processing
from wixy_server.livechat.models import AttachmentResult, AttachmentRow
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.uploads import failed_extension
from wixy_server.storage import ProjectPaths

logger = logging.getLogger(__name__)

LEASE_S = 120.0
RENEW_INTERVAL_S = 30.0
_POLL_IDLE_S = 1.0


@dataclass(frozen=True, slots=True)
class QueueConfig:
    ffmpeg: str
    ffprobe: str


def _resolve_one(explicit: str, name: str) -> str | None:
    # An explicit WIXY_FFMPEG/WIXY_FFPROBE override must point at a real file —
    # a typo'd path is exactly the "operator misconfigured this" case §7 wants
    # caught at startup (a clean 503 + ERROR log), not silently accepted here
    # only to fail later, per-upload, deep inside the queue. `shutil.which`'s
    # own result never needs this check: it only ever returns paths that exist.
    if explicit:
        return explicit if Path(explicit).is_file() else None
    return shutil.which(name)


def resolve_binaries(ffmpeg_path: str, ffprobe_path: str) -> QueueConfig | None:
    """§7 Dependencies: `WIXY_FFMPEG`/`WIXY_FFPROBE` override, falling back to
    `shutil.which`. Returns `None` (never a partial config) when either binary
    can't be resolved — the caller (`app.py`) logs an ERROR and sets
    `livechat_media_available = False`; uploads 503, text chat keeps working."""
    ffmpeg = _resolve_one(ffmpeg_path, "ffmpeg")
    ffprobe = _resolve_one(ffprobe_path, "ffprobe")
    if not ffmpeg or not ffprobe:
        logger.error(
            "server-chat media pipeline unavailable: ffmpeg=%r ffprobe=%r "
            "(set WIXY_FFMPEG/WIXY_FFPROBE to an existing binary, or put them on PATH)",
            ffmpeg,
            ffprobe,
        )
        return None
    return QueueConfig(ffmpeg=ffmpeg, ffprobe=ffprobe)


def _attachment_result_for(result: processing.ProcessResult) -> AttachmentResult:
    if isinstance(result, processing.VoiceResult):
        width: int | None = None
        height: int | None = None
        duration_s: float | None = result.duration_s
        peaks: tuple[float, ...] | None = tuple(result.peaks)
    elif isinstance(result, processing.VideoResult):
        width, height = result.width, result.height
        duration_s = result.duration_s
        peaks = None
    else:
        width, height = result.width, result.height
        duration_s = None
        peaks = None
    return AttachmentResult(
        status="ready",
        mime=result.mime,
        width=width,
        height=height,
        duration_s=duration_s,
        peaks=peaks,
        renditions=tuple(result.renditions.keys()),
        bytes_on_disk=result.bytes_on_disk,
        failure=None,
    )


def _do_work(
    *,
    store: LiveChatStore,
    paths: ProjectPaths,
    config: QueueConfig,
    owner: str,
    att: AttachmentRow,
) -> bool:
    """Runs in a worker thread (via `anyio.to_thread.run_sync`): process, finish
    the attachment row, and clean up the source upload. Returns whether the
    attachment row still exists afterward — `False` means a concurrent delete/
    wipe (§17.1) removed it while this worker was busy, and the caller must
    `rmtree` the media dir it just wrote (finish_attachment on a gone row is
    already a silent no-op, but the media BYTES still need cleaning up).

    Any exception `processing.process` raises resolves the attachment to
    `failed` — including one it never anticipated (`Exception`, not just its
    own `MediaProcessingError`). Letting an unexpected error propagate instead
    would leave the row `processing` forever: its lease lapses, a later claim
    retries the SAME poisoned attachment indefinitely, and nothing behind it
    in the queue ever gets a turn. A genuinely systemic problem (disk full,
    permissions) still surfaces — every subsequent attachment fails the same
    way and gets logged, rather than one item silently blocking the whole
    queue."""
    src = paths.server_upload_dir(att.id) / "assembled"
    output_dir = paths.server_attachment_media_dir(att.id)
    failure_reason: str | None
    try:
        result = processing.process(
            att.kind, src, output_dir=output_dir, ffmpeg=config.ffmpeg, ffprobe=config.ffprobe
        )
    except processing.MediaProcessingError as exc:
        failure_reason = exc.reason
    except Exception:
        logger.exception("server-chat media queue: unexpected error processing %s", att.id)
        failure_reason = "internal_error"
    else:
        failure_reason = None

    if failure_reason is not None:
        failed_result = AttachmentResult(
            status="failed",
            mime=None,
            width=None,
            height=None,
            duration_s=None,
            peaks=None,
            renditions=(),
            bytes_on_disk=0,
            failure=failure_reason,
        )
        store.finish_attachment(att_id=att.id, owner=owner, result=failed_result, now=time.time())
        _archive_failed_original(store=store, paths=paths, att_id=att.id, src=src)
    else:
        store.finish_attachment(
            att_id=att.id, owner=owner, result=_attachment_result_for(result), now=time.time()
        )
        store.delete_upload(att.id)
        shutil.rmtree(paths.server_upload_dir(att.id), ignore_errors=True)

    return store.get_attachment(att.id) is not None


def _archive_failed_original(
    *, store: LiveChatStore, paths: ProjectPaths, att_id: str, src: Path
) -> None:
    """§4: `failed/<id>/original.<ext>`, kept 7 days for diagnosis (janitor.py
    ages it out). The upload DB row is dropped either way — its job (tracking a
    PENDING upload) is done once the attachment resolved, success or failure."""
    if src.is_file():
        upload = store.get_upload(att_id)
        ext = failed_extension(upload.mime if upload is not None else None)
        failed_dir = paths.server_failed_dir(att_id)
        failed_dir.mkdir(parents=True, exist_ok=True)
        os.replace(src, failed_dir / f"original.{ext}")
    store.delete_upload(att_id)
    shutil.rmtree(paths.server_upload_dir(att_id), ignore_errors=True)


async def _renew_loop(store: LiveChatStore, att_id: str, owner: str, stop: anyio.Event) -> None:
    while True:
        with anyio.move_on_after(RENEW_INTERVAL_S):
            await stop.wait()
        if stop.is_set():
            return

        def _renew() -> bool:
            return store.renew_lease(att_id=att_id, owner=owner, now=time.time(), lease_s=LEASE_S)

        await anyio.to_thread.run_sync(_renew)


async def _handle_claimed(
    store: LiveChatStore,
    paths: ProjectPaths,
    notifier: LiveChatNotifier,
    config: QueueConfig,
    limiter: CapacityLimiter,
    att: AttachmentRow,
    owner: str,
) -> None:
    stop_renewal = anyio.Event()
    still_exists = False
    async with anyio.create_task_group() as tg:
        tg.start_soon(_renew_loop, store, att.id, owner, stop_renewal)
        try:
            async with limiter:  # may wait here; the renewal loop above keeps
                # the lease alive throughout, not just while actually working.
                def _work() -> bool:
                    return _do_work(store=store, paths=paths, config=config, owner=owner, att=att)

                still_exists = await anyio.to_thread.run_sync(_work)
        finally:
            stop_renewal.set()
            tg.cancel_scope.cancel()

    if not still_exists:

        def _rmtree() -> None:
            shutil.rmtree(paths.server_attachment_media_dir(att.id), ignore_errors=True)

        await anyio.to_thread.run_sync(_rmtree)
        return

    notifier.publish()


async def run_forever(
    *, store: LiveChatStore, paths: ProjectPaths, notifier: LiveChatNotifier, config: QueueConfig
) -> None:
    """The app-lifetime loop `app.py`'s lifespan `start_soon`s. Never returns
    under normal operation — exits only when its enclosing task group is
    cancelled (app shutdown), the same path a crash takes, which is why no
    separate crash-resume step exists (see module docstring)."""
    photo_voice_limiter = CapacityLimiter(2)
    video_limiter = CapacityLimiter(1)
    pid = os.getpid()

    async with anyio.create_task_group() as dispatch_tg:
        while True:
            owner = f"{pid}-{uuid.uuid4().hex}"

            def _claim(owner: str = owner) -> AttachmentRow | None:
                return store.claim_processing(owner=owner, now=time.time(), lease_s=LEASE_S)

            claimed = await anyio.to_thread.run_sync(_claim)
            if claimed is None:
                await anyio.sleep(_POLL_IDLE_S)
                continue

            limiter = video_limiter if claimed.kind == "video" else photo_voice_limiter
            dispatch_tg.start_soon(
                _handle_claimed, store, paths, notifier, config, limiter, claimed, owner
            )
