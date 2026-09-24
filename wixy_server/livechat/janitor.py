"""Hourly best-effort cleanup (spec/server-chat/00-brief.md §7 Janitor, §10 P2b):
ages out abandoned uploads, unreferenced attachments, and diagnostic `failed/`
originals. `run_once` takes an explicit `now` (never reads the clock itself) so
tests can drive age thresholds without real sleeps; `run_forever` is the
app-lifetime loop `app.py`'s lifespan `start_soon`s.
"""

from __future__ import annotations

import shutil
import time
from dataclasses import dataclass

import anyio

from wixy_server.livechat.store import LiveChatStore
from wixy_server.storage import ProjectPaths

STALE_UPLOAD_AGE_S = 24 * 60 * 60.0
ORPHAN_ATTACHMENT_AGE_S = 24 * 60 * 60.0
FAILED_RETENTION_S = 7 * 24 * 60 * 60.0
SWEEP_INTERVAL_S = 60 * 60.0
SCRUB_INTERVAL_S = 2.0
SCRUB_TICK_DEADLINE_S = 1.5


@dataclass(frozen=True, slots=True)
class JanitorReport:
    stale_uploads: int
    orphan_attachments: int
    expired_failed: int


def run_once(*, store: LiveChatStore, paths: ProjectPaths, now: float) -> JanitorReport:
    stale_uploads = 0
    for upload_id in store.stale_upload_ids(older_than=now - STALE_UPLOAD_AGE_S):
        store.delete_upload(upload_id)
        shutil.rmtree(paths.server_upload_dir(upload_id), ignore_errors=True)
        stale_uploads += 1

    orphan_attachments = 0
    for att_id in store.orphan_attachment_ids(older_than=now - ORPHAN_ATTACHMENT_AGE_S):
        store.delete_attachment(att_id)
        shutil.rmtree(paths.server_attachment_media_dir(att_id), ignore_errors=True)
        orphan_attachments += 1

    expired_failed = 0
    if paths.server_failed.is_dir():
        for entry in paths.server_failed.iterdir():
            if not entry.is_dir():
                continue
            if now - entry.stat().st_mtime > FAILED_RETENTION_S:
                shutil.rmtree(entry, ignore_errors=True)
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


async def run_scrubber_forever(
    *, store: LiveChatStore, interval_s: float = SCRUB_INTERVAL_S
) -> None:
    """Resume pending scrubs immediately at startup and then every two seconds."""
    while True:
        started_at = time.monotonic()
        await anyio.to_thread.run_sync(lambda: scrub_once(store=store))
        await anyio.sleep(max(0.0, interval_s - (time.monotonic() - started_at)))
