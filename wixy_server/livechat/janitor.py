"""Hourly best-effort cleanup (spec/server-chat/00-brief.md §7 Janitor, §10 P2b):
ages out abandoned uploads, unreferenced attachments, and diagnostic `failed/`
originals. `run_once` takes an explicit `now` (never reads the clock itself) so
tests can drive age thresholds without real sleeps; `run_forever` is the
app-lifetime loop `app.py`'s lifespan `start_soon`s.
"""

from __future__ import annotations

import logging
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

import anyio

from wixy_server.livechat.store import LiveChatStore
from wixy_server.storage import ProjectPaths

STALE_UPLOAD_AGE_S = 24 * 60 * 60.0
ORPHAN_ATTACHMENT_AGE_S = 24 * 60 * 60.0
FAILED_RETENTION_S = 7 * 24 * 60 * 60.0
SWEEP_INTERVAL_S = 60 * 60.0
SCRUB_INTERVAL_S = 2.0
SCRUB_TICK_DEADLINE_S = 1.5
_STORAGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class JanitorReport:
    stale_uploads: int
    orphan_attachments: int
    expired_failed: int


def run_once(*, store: LiveChatStore, paths: ProjectPaths, now: float) -> JanitorReport:
    stale_uploads = 0
    for upload_id in store.stale_upload_ids(older_than=now - STALE_UPLOAD_AGE_S):
        store.delete_upload(upload_id)
        cleanup_deleted_storage_once(store=store, paths=paths, only_items={("upload", upload_id)})
        stale_uploads += 1

    orphan_attachments = 0
    for att_id in store.orphan_attachment_ids(older_than=now - ORPHAN_ATTACHMENT_AGE_S):
        store.delete_attachment(att_id)
        cleanup_deleted_storage_once(store=store, paths=paths, only_items={("attachment", att_id)})
        orphan_attachments += 1

    expired_failed = 0
    if paths.server_failed.is_dir():
        for entry in paths.server_failed.iterdir():
            if not entry.is_dir():
                continue
            if now - entry.stat().st_mtime > FAILED_RETENTION_S:
                try:
                    _remove_entry(entry)
                except OSError:
                    _LOGGER.warning("could not remove expired Server chat files at %s", entry)
                expired_failed += 1

    return JanitorReport(
        stale_uploads=stale_uploads,
        orphan_attachments=orphan_attachments,
        expired_failed=expired_failed,
    )


async def run_forever(
    *, store: LiveChatStore, paths: ProjectPaths, interval_s: float = SWEEP_INTERVAL_S
) -> None:
    """Sweeps immediately on start (so a long-uptime deploy doesn't wait a full
    interval before its first sweep), then on `interval_s` cadence until the
    enclosing task group is cancelled (app shutdown)."""
    while True:

        def _sweep() -> JanitorReport:
            return run_once(store=store, paths=paths, now=time.time())

        await anyio.to_thread.run_sync(_sweep)
        await anyio.sleep(interval_s)


def scrub_once(*, store: LiveChatStore, deadline_s: float = SCRUB_TICK_DEADLINE_S) -> bool:
    """Resume the durable WAL scrub if a prior delete/wipe exceeded its deadline."""
    pending_token = store.scrub_pending_token()
    if pending_token is None:
        return False
    if not store.scrub(deadline_s=deadline_s):
        return False
    return store.clear_scrub_pending(expected_token=pending_token)


def _remove_entry(path: Path) -> None:
    """Remove one private storage entry without hiding lock or permission errors."""
    try:
        if path.is_symlink():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
    except FileNotFoundError:
        # A concurrent successful cleanup is equivalent to this one succeeding.
        return


def cleanup_deleted_storage_once(
    *,
    store: LiveChatStore,
    paths: ProjectPaths,
    only_items: set[tuple[str, str]] | None = None,
) -> bool:
    """Retry durable per-ID deletion work; keep tombstones when the OS refuses."""
    state_changes: list[tuple[str, str, bool]] = []
    for kind, storage_id, was_pending in store.deleted_storage_items():
        if only_items is not None and (kind, storage_id) not in only_items:
            continue
        if kind == "attachment":
            targets: tuple[Path, ...] = (
                paths.server_attachment_media_dir(storage_id),
                paths.server_failed_dir(storage_id),
            )
            if store.get_upload(storage_id) is None:
                targets = (*targets, paths.server_upload_dir(storage_id))
        else:
            targets = (paths.server_upload_dir(storage_id),)
        try:
            for target in targets:
                _remove_entry(target)
        except OSError:
            if not was_pending:
                state_changes.append((kind, storage_id, True))
                _LOGGER.warning(
                    "Server chat storage deletion remains pending for %s %s",
                    kind,
                    storage_id,
                    exc_info=True,
                )
        else:
            if was_pending:
                state_changes.append((kind, storage_id, False))
    store.set_deleted_storage_pending_many(state_changes)
    return store.storage_cleanup_pending()


def cleanup_unreferenced_storage_once(*, store: LiveChatStore, paths: ProjectPaths) -> bool:
    """Remove unreferenced paths, including leftovers from old delete/wipe versions."""
    token = store.pending_wipe_cleanup_token()

    failed = False

    def _remove_unreferenced(entry: Path, *, kind: str) -> None:
        nonlocal failed
        storage_id = entry.name
        if _STORAGE_ID_RE.fullmatch(storage_id):
            live = (
                store.get_attachment(storage_id)
                if kind == "attachment"
                else store.get_upload(storage_id)
            )
            if live is not None:
                return
        try:
            _remove_entry(entry)
        except OSError:
            failed = True
            _LOGGER.warning("Server chat wipe cleanup remains pending for %s", entry, exc_info=True)

    try:
        if paths.server_media.is_dir():
            for bucket in list(paths.server_media.iterdir()):
                if bucket.is_symlink() or not bucket.is_dir():
                    _remove_unreferenced(bucket, kind="attachment")
                    continue
                for entry in list(bucket.iterdir()):
                    _remove_unreferenced(entry, kind="attachment")
                if bucket.is_dir() and not any(bucket.iterdir()):
                    try:
                        bucket.rmdir()
                    except FileNotFoundError:
                        pass
                    except OSError:
                        failed = True
                        _LOGGER.warning(
                            "could not remove empty Server chat media shard %s",
                            bucket,
                            exc_info=True,
                        )

        for root, kind in (
            (paths.server_uploads, "upload"),
            (paths.server_failed, "attachment"),
        ):
            if root.is_dir():
                for entry in list(root.iterdir()):
                    _remove_unreferenced(entry, kind=kind)
    except OSError:
        failed = True
        _LOGGER.warning("could not enumerate Server chat wipe files", exc_info=True)

    if failed:
        return True
    if token is not None:
        store.clear_pending_wipe_cleanup(expected_token=token)
    return store.storage_cleanup_pending()


async def run_scrubber_forever(
    *, store: LiveChatStore, paths: ProjectPaths, interval_s: float = SCRUB_INTERVAL_S
) -> None:
    """Resume WAL and media deletion work at startup and then every two seconds."""
    while True:
        started_at = time.monotonic()
        await anyio.to_thread.run_sync(
            lambda: cleanup_deleted_storage_once(store=store, paths=paths)
        )
        await anyio.to_thread.run_sync(
            lambda: cleanup_unreferenced_storage_once(store=store, paths=paths)
        )
        await anyio.to_thread.run_sync(lambda: scrub_once(store=store))
        await anyio.sleep(max(0.0, interval_s - (time.monotonic() - started_at)))
