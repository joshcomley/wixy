""" "Try again" for failed Server-chat media (decisions/00209).

A failed attachment keeps its original under `failed/<id>/` for seven days. Putting
it back in the queue re-runs processing from that archived copy IN PLACE; success
makes the message's media appear and removes the archive, a further failure keeps
the archive (and restarts its retention clock) for another try.
"""

from __future__ import annotations

import io
import os
import time
from pathlib import Path
from typing import Any

import anyio
import pytest
from PIL import Image

from wixy_server.livechat import media_queue, processing, uploads
from wixy_server.livechat.models import (
    FAILED_ORIGINAL_RETENTION_S,
    AttachmentResult,
    attachment_retryable,
)
from wixy_server.livechat.store import LiveChatStore
from wixy_server.storage import ProjectPaths

_UNUSED_CONFIG = media_queue.QueueConfig(ffmpeg="unused", ffprobe="unused")


@pytest.fixture
def store(tmp_path: Path) -> LiveChatStore:
    return LiveChatStore(tmp_path / "server" / "server.db")


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return ProjectPaths(slug="test", root=tmp_path / "storage" / "projects" / "test")


def _jpeg_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 20), "red").save(buf, format="JPEG")
    return buf.getvalue()


def _ample_disk_usage(_path: str) -> tuple[int, int, int]:
    return 1_000_000_000_000, 0, 1_000_000_000_000


def _seed_sent_photo(store: LiveChatStore, paths: ProjectPaths, *, now: float) -> tuple[str, int]:
    data = _jpeg_bytes()
    init = uploads.init_upload(
        store=store,
        kind="photo",
        mime_type="image/jpeg",
        size_bytes=len(data),
        filename=None,
        by_email=None,
        chunk_bytes=len(data),
        quota_bytes=1_000_000_000,
        min_free_bytes=0,
        media_available=True,
        disk_check_path=paths.root,
        now=now,
        disk_usage=_ample_disk_usage,
    )
    uploads.write_chunk(paths.server_upload_dir(init.upload_id), 0, data)
    att = uploads.assemble(
        store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=len(data), now=now
    )
    message, _created = store.create_message(
        client_id=f"client-{att.id}",
        sender="Bubble",
        device_id="device-1",
        by_email=None,
        text=None,
        attachment_ids=(att.id,),
        now=now,
    )
    return att.id, message.seq


def _claim(store: LiveChatStore, att_id: str, owner: str) -> Any:
    claimed = store.claim_processing(owner=owner, now=time.time(), lease_s=120.0)
    assert claimed is not None and claimed.id == att_id
    return claimed


def _fail_once_with_timeout(
    store: LiveChatStore, paths: ProjectPaths, monkeypatch: pytest.MonkeyPatch, att_id: str
) -> None:
    """Reproduce the 2026-11-12 shape: processing gives up with `timeout`."""

    def _starved(*_args: object, **_kwargs: object) -> processing.ProcessResult:
        raise processing.MediaProcessingError("timeout", "ffmpeg exceeded 300s")

    with monkeypatch.context() as m:
        m.setattr(processing, "process", _starved)
        media_queue._do_work(
            store=store,
            paths=paths,
            config=_UNUSED_CONFIG,
            owner="first",
            att=_claim(store, att_id, "first"),
        )


class TestStoreRequeue:
    def test_requeue_turns_a_failed_attachment_back_into_processing(
        self, store: LiveChatStore, paths: ProjectPaths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        att_id, seq = _seed_sent_photo(store, paths, now=time.time())
        _fail_once_with_timeout(store, paths, monkeypatch, att_id)
        failed = store.get_attachment(att_id)
        assert failed is not None and failed.status == "failed" and failed.failure == "timeout"
        cursor = max(e.event_seq for e in store.events_after(0, limit=10_000))

        row = store.requeue_failed_attachment(att_id, now=time.time())

        assert row is not None
        assert row.status == "processing"
        assert row.failure is None and row.lease_owner is None
        # Every open chat re-renders the bubble from "Couldn't process" to "Processing…".
        new_events = store.events_after(cursor)
        assert [(e.type, e.message_seq) for e in new_events] == [("message_updated", seq)]

    def test_requeue_refuses_anything_not_failed(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        att_id, _seq = _seed_sent_photo(store, paths, now=time.time())
        assert store.requeue_failed_attachment(att_id, now=time.time()) is None  # processing
        assert store.requeue_failed_attachment("0" * 32, now=time.time()) is None  # unknown


class TestRetryFromArchive:
    def test_a_retried_attachment_processes_from_its_archived_original(
        self, store: LiveChatStore, paths: ProjectPaths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        att_id, _seq = _seed_sent_photo(store, paths, now=time.time())
        _fail_once_with_timeout(store, paths, monkeypatch, att_id)
        archived = paths.server_failed_dir(att_id) / "original.jpg"
        assert archived.is_file()
        assert not (paths.server_upload_dir(att_id) / "assembled").exists()
        assert media_queue.failed_original_path(paths, att_id) == archived

        assert store.requeue_failed_attachment(att_id, now=time.time()) is not None
        assert media_queue._do_work(
            store=store,
            paths=paths,
            config=_UNUSED_CONFIG,
            owner="second",
            att=_claim(store, att_id, "second"),
        )

        row = store.get_attachment(att_id)
        assert row is not None and row.status == "ready"
        assert (paths.server_attachment_media_dir(att_id) / "thumb.jpg").is_file()
        assert not paths.server_failed_dir(att_id).exists()  # no further use

    def test_a_retry_that_fails_again_keeps_the_archive_unrenamed(
        self, store: LiveChatStore, paths: ProjectPaths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        att_id, _seq = _seed_sent_photo(store, paths, now=time.time())
        _fail_once_with_timeout(store, paths, monkeypatch, att_id)
        archived = paths.server_failed_dir(att_id) / "original.jpg"
        original_bytes = archived.read_bytes()
        old = time.time() - 3 * 24 * 60 * 60
        os.utime(archived.parent, (old, old))

        assert store.requeue_failed_attachment(att_id, now=time.time()) is not None

        def _starved(*_args: object, **_kwargs: object) -> processing.ProcessResult:
            raise processing.MediaProcessingError("timeout", "again")

        monkeypatch.setattr(processing, "process", _starved)
        media_queue._do_work(
            store=store,
            paths=paths,
            config=_UNUSED_CONFIG,
            owner="second",
            att=_claim(store, att_id, "second"),
        )

        row = store.get_attachment(att_id)
        assert row is not None and row.status == "failed"
        assert sorted(p.name for p in archived.parent.iterdir()) == ["original.jpg"]
        assert archived.read_bytes() == original_bytes
        # The retention clock restarted, so the janitor gives it a full window again.
        assert archived.parent.stat().st_mtime > old + 24 * 60 * 60

    def test_neither_staged_nor_archived_original_fails_cleanly(
        self, store: LiveChatStore, paths: ProjectPaths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        att_id, _seq = _seed_sent_photo(store, paths, now=time.time())
        _fail_once_with_timeout(store, paths, monkeypatch, att_id)
        (paths.server_failed_dir(att_id) / "original.jpg").unlink()
        assert store.requeue_failed_attachment(att_id, now=time.time()) is not None

        media_queue._do_work(
            store=store,
            paths=paths,
            config=_UNUSED_CONFIG,
            owner="second",
            att=_claim(store, att_id, "second"),
        )

        row = store.get_attachment(att_id)
        assert row is not None and row.status == "failed"
        assert row.failure == "original_missing"


class TestRetryableFlag:
    def test_failed_within_retention_is_retryable_then_expires(
        self, store: LiveChatStore, paths: ProjectPaths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        att_id, _seq = _seed_sent_photo(store, paths, now=time.time())
        processing_row = store.get_attachment(att_id)
        assert processing_row is not None
        assert not attachment_retryable(processing_row, now=time.time())
        _fail_once_with_timeout(store, paths, monkeypatch, att_id)
        row = store.get_attachment(att_id)
        assert row is not None
        assert attachment_retryable(row, now=row.updated_at + 60)
        assert not attachment_retryable(row, now=row.updated_at + FAILED_ORIGINAL_RETENTION_S + 1)


async def _wait_for_status(store: LiveChatStore, att_id: str, status: str) -> None:
    with anyio.fail_after(20):
        while True:
            row = store.get_attachment(att_id)
            if row is not None and row.status == status:
                return
            await anyio.sleep(0.05)


def test_a_retry_before_the_archive_move_processes_the_staged_original(
    store: LiveChatStore, paths: ProjectPaths
) -> None:
    """Failed but not yet archived (the move comes right after, or Windows is holding it
    off): the staged original is still there, and a retry processes it from `uploads/`."""
    att_id, _seq = _seed_sent_photo(store, paths, now=time.time())
    claimed = _claim(store, att_id, "first")
    store.finish_attachment(
        att_id=att_id,
        owner="first",
        result=AttachmentResult(
            status="failed",
            mime=None,
            width=None,
            height=None,
            duration_s=None,
            peaks=None,
            renditions=(),
            bytes_on_disk=0,
            failure="timeout",
        ),
        now=time.time(),
    )
    assert claimed is not None
    assert (paths.server_upload_dir(att_id) / "assembled").is_file()
    assert media_queue.failed_original_path(paths, att_id) is None

    assert store.requeue_failed_attachment(att_id, now=time.time()) is not None
    assert media_queue._do_work(
        store=store,
        paths=paths,
        config=_UNUSED_CONFIG,
        owner="second",
        att=_claim(store, att_id, "second"),
    )
    row = store.get_attachment(att_id)
    assert row is not None and row.status == "ready"
