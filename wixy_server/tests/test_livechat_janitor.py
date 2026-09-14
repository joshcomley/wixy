"""`wixy_server.livechat.janitor` (spec/server-chat/00-brief.md §7 Janitor,
§10 P2b) — every age threshold driven by an explicit `now`, never a real sleep.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from wixy_server.livechat import janitor
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.uploads import init_upload
from wixy_server.storage import ProjectPaths

_DAY_S = 24 * 60 * 60.0


@pytest.fixture
def store(tmp_path: Path) -> LiveChatStore:
    return LiveChatStore(tmp_path / "server" / "server.db")


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return ProjectPaths(slug="test", root=tmp_path / "storage" / "projects" / "test")


def _ample_disk_usage(_path: str) -> tuple[int, int, int]:
    return 1_000_000_000_000, 0, 1_000_000_000_000


def _make_upload(store: LiveChatStore, paths: ProjectPaths, *, created_at: float) -> str:
    result = init_upload(
        store=store,
        kind="photo",
        mime_type="image/jpeg",
        size_bytes=10,
        filename=None,
        by_email=None,
        chunk_bytes=100,
        quota_bytes=1_000_000,
        min_free_bytes=0,
        media_available=True,
        disk_check_path=paths.root,
        now=created_at,
        disk_usage=_ample_disk_usage,
    )
    upload_dir = paths.server_upload_dir(result.upload_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    (upload_dir / "chunk-000000").write_bytes(b"1234567890")
    return result.upload_id


class TestStaleUploads:
    def test_uploads_older_than_24h_are_removed(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        now = 1_000_000.0
        old_id = _make_upload(store, paths, created_at=now - _DAY_S - 1)
        fresh_id = _make_upload(store, paths, created_at=now - 60)

        report = janitor.run_once(store=store, paths=paths, now=now)

        assert report.stale_uploads == 1
        assert store.get_upload(old_id) is None
        assert not paths.server_upload_dir(old_id).exists()
        assert store.get_upload(fresh_id) is not None
        assert paths.server_upload_dir(fresh_id).exists()


class TestOrphanAttachments:
    def test_unreferenced_attachments_older_than_24h_are_removed(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        now = 1_000_000.0
        old = store.create_attachment(att_id="a" * 32, kind="photo", now=now - _DAY_S - 1)
        fresh = store.create_attachment(att_id="b" * 32, kind="photo", now=now - 60)
        old_dir = paths.server_attachment_media_dir(old.id)
        fresh_dir = paths.server_attachment_media_dir(fresh.id)
        old_dir.mkdir(parents=True)
        fresh_dir.mkdir(parents=True)
        (old_dir / "full.jpg").write_bytes(b"x")
        (fresh_dir / "full.jpg").write_bytes(b"x")

        report = janitor.run_once(store=store, paths=paths, now=now)

        assert report.orphan_attachments == 1
        assert store.get_attachment(old.id) is None
        assert not old_dir.exists()
        assert store.get_attachment(fresh.id) is not None
        assert fresh_dir.exists()

    def test_attachments_referenced_by_a_message_are_never_orphaned(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        now = 1_000_000.0
        # A "processing"-status attachment is already referenceable by a
        # message (§4: create_message accepts status in (processing, ready)),
        # so this alone proves janitor's orphan check keys off message_seq,
        # not status.
        att = store.create_attachment(att_id="c" * 32, kind="photo", now=now - _DAY_S - 1)
        store.create_message(
            client_id="c1",
            sender="josh",
            device_id="d1",
            by_email=None,
            text=None,
            attachment_ids=[att.id],
            now=now - _DAY_S - 1,
        )

        report = janitor.run_once(store=store, paths=paths, now=now)

        assert report.orphan_attachments == 0
        assert store.get_attachment(att.id) is not None


class TestFailedRetention:
    def test_failed_entries_older_than_7_days_are_removed(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        now = 1_000_000.0
        old_dir = paths.server_failed_dir("d" * 32)
        fresh_dir = paths.server_failed_dir("e" * 32)
        old_dir.mkdir(parents=True)
        fresh_dir.mkdir(parents=True)
        (old_dir / "original.jpg").write_bytes(b"x")
        (fresh_dir / "original.jpg").write_bytes(b"x")

        seven_days_s = 7 * _DAY_S
        old_mtime = now - seven_days_s - 1
        fresh_mtime = now - 60
        os.utime(old_dir, (old_mtime, old_mtime))
        os.utime(fresh_dir, (fresh_mtime, fresh_mtime))

        report = janitor.run_once(store=store, paths=paths, now=now)

        assert report.expired_failed == 1
        assert not old_dir.exists()
        assert fresh_dir.exists()

    def test_no_failed_directory_yet_is_fine(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        report = janitor.run_once(store=store, paths=paths, now=1000.0)
        assert report.expired_failed == 0


class TestRunOnceIsIdempotent:
    def test_a_second_sweep_with_nothing_new_finds_nothing(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        now = 1_000_000.0
        _make_upload(store, paths, created_at=now - _DAY_S - 1)
        first = janitor.run_once(store=store, paths=paths, now=now)
        second = janitor.run_once(store=store, paths=paths, now=now)
        assert first.stale_uploads == 1
        assert second.stale_uploads == 0
