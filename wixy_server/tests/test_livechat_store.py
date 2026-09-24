"""`LiveChatStore` (spec/server-chat/00-brief.md §4) — migrations, message
create/idempotency/paging/cursor atomicity, attachment lease claiming, uploads,
push subscriptions."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from wixy_server.livechat.models import AttachmentResult, PushSubscriptionRow, UploadRow
from wixy_server.livechat.store import LiveChatStore, UnusableAttachmentError


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


class TestMigrations:
    def test_creates_schema_lazily_on_first_use(self, store: LiveChatStore, db_path: Path) -> None:
        assert not db_path.exists()
        store.list_messages(before=None, limit=10)
        assert db_path.exists()

    def test_sets_user_version_after_migrating(self, store: LiveChatStore, db_path: Path) -> None:
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 4
        finally:
            conn.close()

    def test_v3_database_gets_pending_storage_index_in_v4(self, db_path: Path) -> None:
        store = LiveChatStore(db_path)
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("DROP INDEX idx_deleted_storage_pending")
            conn.execute("PRAGMA user_version = 3")
            conn.commit()
        finally:
            conn.close()

        upgraded = LiveChatStore(db_path)
        upgraded.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 4
            index = conn.execute(
                "SELECT sql FROM sqlite_master "
                "WHERE type = 'index' AND name = 'idx_deleted_storage_pending'"
            ).fetchone()
        finally:
            conn.close()
        assert index is not None
        assert "WHERE cleanup_pending = 1" in str(index[0])

    def test_v2_rebuild_accepts_wiped_and_preserves_event_sequence(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.executescript(
                """
                CREATE TABLE events(
                  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
                  type TEXT NOT NULL CHECK(type IN ('message','message_updated')),
                  message_seq INTEGER NOT NULL, created_at REAL NOT NULL);
                INSERT INTO events(event_seq, type, message_seq, created_at)
                  VALUES (4, 'message', 1, 10.0), (12, 'message_updated', 1, 11.0);
                DELETE FROM events WHERE event_seq = 12;
                PRAGMA user_version = 1;
                """
            )
        finally:
            conn.close()

        store = LiveChatStore(db_path)
        assert [(event.event_seq, event.type) for event in store.events_after(0)] == [
            (4, "message")
        ]

        conn = sqlite3.connect(str(db_path))
        try:
            columns = {row[1]: row[3] for row in conn.execute("PRAGMA table_info(events)")}
            assert columns["message_seq"] == 0  # nullable for the 'wiped' event
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) VALUES ('wiped', NULL, 12.0)"
            )
            assert conn.execute("SELECT MAX(event_seq) FROM events").fetchone()[0] == 13
            assert (
                conn.execute("SELECT seq FROM sqlite_sequence WHERE name = 'events'").fetchone()[0]
                == 13
            )
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 4
        finally:
            conn.close()

    def test_a_second_store_instance_sees_data_from_the_first(self, db_path: Path) -> None:
        """The store opens a fresh connection per call (module docstring) — this
        proves reopening an already-migrated db doesn't re-run/duplicate schema
        and correctly reads what a prior instance wrote (the same shape as a
        blue/green slot-swap overlap: two `LiveChatStore` objects, one file)."""
        store1 = LiveChatStore(db_path)
        store1.create_message(
            client_id="client-aaaaaaaa",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            text="hi",
            attachment_ids=(),
            now=time.time(),
        )
        store2 = LiveChatStore(db_path)
        messages, _has_more, _cursor = store2.list_messages(before=None, limit=10)
        assert [m.text for m in messages] == ["hi"]

    def test_migration_is_idempotent_across_many_connects(self, store: LiveChatStore) -> None:
        for _ in range(5):
            store.list_messages(before=None, limit=1)  # must not raise


class TestCreateMessage:
    def test_creates_and_returns_row(self, store: LiveChatStore) -> None:
        row, created = store.create_message(
            client_id="client-aaaaaaaa",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email="josh@example.com",
            text="hello",
            attachment_ids=(),
            now=1000.0,
        )
        assert created is True
        assert row.seq == 1
        assert row.client_id == "client-aaaaaaaa"
        assert row.sender == "Josh"
        assert row.text == "hello"
        assert row.created_at == 1000.0
        assert row.attachments == ()

    def test_idempotent_on_client_id(self, store: LiveChatStore) -> None:
        row1, created1 = store.create_message(
            client_id="client-aaaaaaaa",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            text="original",
            attachment_ids=(),
            now=1000.0,
        )
        row2, created2 = store.create_message(
            client_id="client-aaaaaaaa",
            sender="SomeoneElse",
            device_id="device-bbbbbbbb",
            by_email=None,
            text="a retried send must never overwrite the original",
            attachment_ids=(),
            now=2000.0,
        )
        assert created1 is True
        assert created2 is False
        assert row2.seq == row1.seq
        assert row2.text == "original"
        assert row2.sender == "Josh"

    def test_unknown_attachment_id_raises(self, store: LiveChatStore) -> None:
        with pytest.raises(UnusableAttachmentError) as exc_info:
            store.create_message(
                client_id="client-aaaaaaaa",
                sender="Josh",
                device_id="device-aaaaaaaa",
                by_email=None,
                text=None,
                attachment_ids=("does-not-exist",),
                now=1000.0,
            )
        assert exc_info.value.attachment_id == "does-not-exist"

    def test_already_attached_attachment_raises(self, store: LiveChatStore) -> None:
        att = store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        store.create_message(
            client_id="client-aaaaaaaa",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            text=None,
            attachment_ids=(att.id,),
            now=1000.0,
        )
        with pytest.raises(UnusableAttachmentError):
            store.create_message(
                client_id="client-bbbbbbbb",
                sender="Josh",
                device_id="device-aaaaaaaa",
                by_email=None,
                text=None,
                attachment_ids=(att.id,),
                now=1001.0,
            )

    def test_failed_attachment_raises(self, store: LiveChatStore) -> None:
        att = store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        claimed = store.claim_processing(owner="worker-1", now=1000.0, lease_s=120.0)
        assert claimed is not None
        store.finish_attachment(
            att_id=att.id,
            owner="worker-1",
            result=AttachmentResult(
                status="failed",
                mime=None,
                width=None,
                height=None,
                duration_s=None,
                peaks=None,
                renditions=(),
                bytes_on_disk=0,
                failure="boom",
            ),
            now=1000.0,
        )
        with pytest.raises(UnusableAttachmentError):
            store.create_message(
                client_id="client-aaaaaaaa",
                sender="Josh",
                device_id="device-aaaaaaaa",
                by_email=None,
                text=None,
                attachment_ids=(att.id,),
                now=1001.0,
            )

    def test_ready_attachment_can_be_attached(self, store: LiveChatStore) -> None:
        """A voice note sends immediately when recording stops (R9) — before its
        processing necessarily finishes, so "processing" attachments must be
        attachable too (already covered by every other test in this class)."""
        att = store.create_attachment(att_id="att-1", kind="voice", now=1000.0)
        store.claim_processing(owner="worker-1", now=1000.0, lease_s=120.0)
        store.finish_attachment(
            att_id=att.id,
            owner="worker-1",
            result=AttachmentResult(
                status="ready",
                mime="audio/mp4",
                width=None,
                height=None,
                duration_s=2.0,
                peaks=(0.1, 0.2),
                renditions=("play",),
                bytes_on_disk=1234,
                failure=None,
            ),
            now=1000.0,
        )
        row, created = store.create_message(
            client_id="client-aaaaaaaa",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            text=None,
            attachment_ids=(att.id,),
            now=1001.0,
        )
        assert created is True
        assert len(row.attachments) == 1
        assert row.attachments[0].status == "ready"
        assert row.attachments[0].peaks == (0.1, 0.2)
        assert row.attachments[0].renditions == ("play",)

    def test_attachment_ordinal_matches_input_order(self, store: LiveChatStore) -> None:
        att_a = store.create_attachment(att_id="att-a", kind="photo", now=1000.0)
        att_b = store.create_attachment(att_id="att-b", kind="photo", now=1000.0)
        row, _created = store.create_message(
            client_id="client-aaaaaaaa",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            text=None,
            attachment_ids=(att_b.id, att_a.id),
            now=1000.0,
        )
        assert [a.id for a in row.attachments] == [att_b.id, att_a.id]


class TestListMessagesAndEvents:
    def _seed(self, store: LiveChatStore, count: int) -> None:
        for i in range(count):
            store.create_message(
                client_id=f"client-{i:08d}",
                sender="Josh",
                device_id="device-aaaaaaaa",
                by_email=None,
                text=f"message {i}",
                attachment_ids=(),
                now=1000.0 + i,
            )

    def test_empty_store(self, store: LiveChatStore) -> None:
        messages, has_more, cursor = store.list_messages(before=None, limit=50)
        assert messages == []
        assert has_more is False
        assert cursor == 0

    def test_most_recent_page_is_ascending(self, store: LiveChatStore) -> None:
        self._seed(store, 5)
        messages, has_more, cursor = store.list_messages(before=None, limit=3)
        assert [m.text for m in messages] == ["message 2", "message 3", "message 4"]
        assert has_more is True
        assert cursor == 5

    def test_paging_older_with_before(self, store: LiveChatStore) -> None:
        self._seed(store, 5)
        first_page, _has_more, _cursor = store.list_messages(before=None, limit=3)
        older_page, has_more, cursor = store.list_messages(before=first_page[0].seq, limit=3)
        assert [m.text for m in older_page] == ["message 0", "message 1"]
        assert has_more is False
        assert cursor == 5  # cursor is always the CURRENT event high-water mark

    def test_cursor_reflects_events_not_just_messages(self, store: LiveChatStore) -> None:
        att = store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        store.create_message(
            client_id="client-aaaaaaaa",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            text=None,
            attachment_ids=(att.id,),
            now=1000.0,
        )
        store.claim_processing(owner="worker-1", now=1000.0, lease_s=120.0)
        store.finish_attachment(
            att_id=att.id,
            owner="worker-1",
            result=AttachmentResult(
                status="ready",
                mime="image/jpeg",
                width=10,
                height=10,
                duration_s=None,
                peaks=None,
                renditions=("full",),
                bytes_on_disk=100,
                failure=None,
            ),
            now=1001.0,
        )
        _messages, _has_more, cursor = store.list_messages(before=None, limit=50)
        # one 'message' event + one 'message_updated' event from finish_attachment
        assert cursor == 2

    def test_events_after_cursor(self, store: LiveChatStore) -> None:
        self._seed(store, 3)
        events = store.events_after(0)
        assert [e.event_seq for e in events] == [1, 2, 3]
        assert all(e.type == "message" for e in events)
        later = store.events_after(2)
        assert [e.event_seq for e in later] == [3]

    def test_get_messages_preserves_requested_order_and_skips_missing(
        self, store: LiveChatStore
    ) -> None:
        self._seed(store, 3)
        result = store.get_messages([3, 999, 1])
        assert [m.seq for m in result] == [3, 1]


class TestDeleteAndWipe:
    @staticmethod
    def _raw_database_bytes(db_path: Path) -> bytes:
        wal_path = Path(f"{db_path}-wal")
        return db_path.read_bytes() + (wal_path.read_bytes() if wal_path.exists() else b"")

    def test_delete_removes_message_attachments_and_old_events_and_is_idempotent(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        attachment = store.create_attachment(att_id="attachment-delete-1", kind="photo", now=1.0)
        store.create_upload(
            UploadRow(
                id=attachment.id,
                kind="photo",
                mime="image/jpeg",
                size_bytes=10,
                filename=None,
                by_email=None,
                created_at=1.0,
            )
        )
        message, _ = store.create_message(
            client_id="client-delete-1",
            sender="Josh",
            device_id="device-delete-1",
            by_email=None,
            text="delete-marker-7d72c84d",
            attachment_ids=(attachment.id,),
            now=2.0,
        )
        # The attachment completion event must be removed with the message too.
        store.claim_processing(owner="worker-1", now=2.0, lease_s=60.0)
        store.finish_attachment(
            att_id=attachment.id,
            owner="worker-1",
            result=AttachmentResult(
                status="ready",
                mime="image/jpeg",
                width=1,
                height=1,
                duration_s=None,
                peaks=None,
                renditions=("full",),
                bytes_on_disk=10,
                failure=None,
            ),
            now=3.0,
        )

        assert store.delete_message(seq=message.seq, now=4.0) == [attachment.id]
        assert store.scrub(deadline_s=10.0)
        assert store.get_messages([message.seq]) == []
        assert store.get_attachment(attachment.id) is None
        assert store.get_upload(attachment.id) is None
        events = store.events_after(0)
        assert [(event.type, event.message_seq) for event in events] == [
            ("message_deleted", message.seq)
        ]
        assert store.delete_message(seq=message.seq, now=5.0) == []
        assert store.scrub(deadline_s=10.0)
        assert store.events_after(0) == events
        assert b"delete-marker-7d72c84d" not in self._raw_database_bytes(db_path)

    def test_wipe_clears_content_keeps_push_and_never_reuses_sequences(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        attachment = store.create_attachment(att_id="attachment-wipe-1", kind="voice", now=1.0)
        store.create_upload(
            UploadRow(
                id=attachment.id,
                kind="voice",
                mime="audio/webm",
                size_bytes=30,
                filename="note.webm",
                by_email=None,
                created_at=1.0,
            )
        )
        store.create_upload(
            UploadRow(
                id="pending-upload-1",
                kind="video",
                mime="video/mp4",
                size_bytes=40,
                filename="clip.mp4",
                by_email=None,
                created_at=1.0,
            )
        )
        store.create_message(
            client_id="client-wipe-1",
            sender="Josh",
            device_id="device-wipe-1",
            by_email=None,
            text="wipe-marker-5121b943",
            attachment_ids=(attachment.id,),
            now=2.0,
        )
        last_seq = store.create_message(
            client_id="client-wipe-2",
            sender="Purdy",
            device_id="device-wipe-2",
            by_email=None,
            text="second message",
            attachment_ids=(),
            now=3.0,
        )[0].seq
        store.upsert_push_subscription(
            PushSubscriptionRow(
                device_id="device-wipe-1",
                sender="Josh",
                endpoint="https://push.example/subscription-1",
                p256dh="public-key",
                auth="auth-secret",
                created_at=1.0,
                last_ok_at=None,
                consecutive_failures=0,
            )
        )
        _messages, _has_more, old_cursor = store.list_messages(before=None, limit=10)

        attachment_ids, upload_ids = store.wipe(now=4.0)
        assert store.scrub(deadline_s=10.0)

        assert attachment_ids == [attachment.id]
        assert upload_ids == [attachment.id, "pending-upload-1"]
        assert store.list_messages(before=None, limit=10) == ([], False, old_cursor + 1)
        assert store.get_attachment(attachment.id) is None
        assert store.get_upload("pending-upload-1") is None
        assert store.list_push_subscriptions()[0].device_id == "device-wipe-1"
        assert [(event.type, event.message_seq) for event in store.events_after(old_cursor)] == [
            ("wiped", None)
        ]
        next_message, _ = store.create_message(
            client_id="client-wipe-3",
            sender="Josh",
            device_id="device-wipe-1",
            by_email=None,
            text="after wipe",
            attachment_ids=(),
            now=5.0,
        )
        assert next_message.seq > last_seq
        assert b"wipe-marker-5121b943" not in self._raw_database_bytes(db_path)

    def test_delete_persists_pending_scrub_until_reader_releases_old_wal_snapshot(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        message, _ = store.create_message(
            client_id="client-delete-reader",
            sender="Josh",
            device_id="device-delete-reader",
            by_email=None,
            text="delete-reader-marker-1e4c",
            attachment_ids=(),
            now=1.0,
        )
        reader = sqlite3.connect(str(db_path), isolation_level=None)
        reader.execute("BEGIN")
        assert (
            reader.execute("SELECT text FROM messages").fetchone()[0] == "delete-reader-marker-1e4c"
        )
        try:
            store.delete_message(seq=message.seq, now=2.0)
            assert not store.scrub(deadline_s=0.1)
            pending_token = store.mark_scrub_pending()
            assert store.scrub_pending()
            assert b"delete-reader-marker-1e4c" in self._raw_database_bytes(db_path)
        finally:
            reader.close()

        assert store.scrub(deadline_s=10.0)
        assert store.clear_scrub_pending(expected_token=pending_token)
        assert not store.scrub_pending()
        assert b"delete-reader-marker-1e4c" not in self._raw_database_bytes(db_path)

    def test_wipe_persists_pending_scrub_until_reader_releases_old_wal_snapshot(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.create_message(
            client_id="client-wipe-reader",
            sender="Josh",
            device_id="device-wipe-reader",
            by_email=None,
            text="wipe-reader-marker-37bc",
            attachment_ids=(),
            now=1.0,
        )
        reader = sqlite3.connect(str(db_path), isolation_level=None)
        reader.execute("BEGIN")
        assert (
            reader.execute("SELECT text FROM messages").fetchone()[0] == "wipe-reader-marker-37bc"
        )
        try:
            store.wipe(now=2.0)
            assert not store.scrub(deadline_s=0.1)
            pending_token = store.mark_scrub_pending()
            assert store.scrub_pending()
            assert b"wipe-reader-marker-37bc" in self._raw_database_bytes(db_path)
        finally:
            reader.close()

        assert store.scrub(deadline_s=10.0)
        assert store.clear_scrub_pending(expected_token=pending_token)
        assert b"wipe-reader-marker-37bc" not in self._raw_database_bytes(db_path)

    def test_complete_passive_checkpoint_can_leave_deleted_text_in_wal(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path), isolation_level=None)
        conn.execute("PRAGMA journal_mode = WAL")
        message, _ = store.create_message(
            client_id="client-passive-characterization",
            sender="Josh",
            device_id="device-passive-characterization",
            by_email=None,
            text="passive-wal-marker-2e18",
            attachment_ids=(),
            now=1.0,
        )
        store.delete_message(seq=message.seq, now=2.0)
        try:
            busy, log_frames, checkpointed_frames = conn.execute(
                "PRAGMA wal_checkpoint(PASSIVE)"
            ).fetchone()
            assert busy == 0
            assert checkpointed_frames == log_frames
            assert b"passive-wal-marker-2e18" in self._raw_database_bytes(db_path)
            assert store.scrub(deadline_s=10.0)
            assert b"passive-wal-marker-2e18" not in self._raw_database_bytes(db_path)
        finally:
            conn.close()

    def test_read_methods_leave_no_snapshot_blocking_a_truncate_checkpoint(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.create_message(
            client_id="client-reader-invariant",
            sender="Josh",
            device_id="device-reader-invariant",
            by_email=None,
            text="short-lived read",
            attachment_ids=(),
            now=1.0,
        )
        store.list_messages(before=None, limit=10)
        store.events_after(0)
        store.get_messages([1])
        conn = sqlite3.connect(str(db_path), isolation_level=None)
        try:
            conn.execute("PRAGMA busy_timeout = 0")
            busy, _log_frames, _checkpointed_frames = conn.execute(
                "PRAGMA wal_checkpoint(TRUNCATE)"
            ).fetchone()
            assert busy == 0
        finally:
            conn.close()

    def test_every_store_connection_enables_secure_delete(self, store: LiveChatStore) -> None:
        conn = store._connect()
        try:
            assert conn.execute("PRAGMA secure_delete").fetchone()[0] == 1
        finally:
            conn.close()

    def test_upload_promotion_cannot_create_an_attachment_after_wipe(
        self, store: LiveChatStore
    ) -> None:
        upload_id = "c" * 32
        store.create_upload(
            UploadRow(
                id=upload_id,
                kind="photo",
                mime="image/jpeg",
                size_bytes=1,
                filename=None,
                by_email=None,
                created_at=1.0,
            )
        )
        store.wipe(now=2.0)

        assert store.create_attachment_from_upload(att_id=upload_id, kind="photo", now=3.0) is None
        assert store.get_attachment(upload_id) is None


class TestAttachmentLeasing:
    def test_claim_processing_returns_none_when_nothing_pending(self, store: LiveChatStore) -> None:
        assert store.claim_processing(owner="worker-1", now=1000.0, lease_s=60.0) is None

    def test_claim_then_a_second_worker_cannot_claim_the_same_row(
        self, store: LiveChatStore
    ) -> None:
        store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        first = store.claim_processing(owner="worker-1", now=1000.0, lease_s=60.0)
        assert first is not None
        second = store.claim_processing(owner="worker-2", now=1001.0, lease_s=60.0)
        assert second is None  # the lease hasn't expired yet

    def test_an_expired_lease_can_be_reclaimed(self, store: LiveChatStore) -> None:
        store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        store.claim_processing(owner="worker-1", now=1000.0, lease_s=60.0)
        reclaimed = store.claim_processing(owner="worker-2", now=1062.0, lease_s=60.0)
        assert reclaimed is not None
        assert reclaimed.lease_owner == "worker-2"

    def test_renew_lease_extends_expiry_and_reports_success(self, store: LiveChatStore) -> None:
        store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        store.claim_processing(owner="worker-1", now=1000.0, lease_s=60.0)
        assert store.renew_lease(att_id="att-1", owner="worker-1", now=1050.0, lease_s=60.0) is True
        att = store.get_attachment("att-1")
        assert att is not None
        assert att.lease_expires_at == 1110.0

    def test_renew_lease_fails_for_the_wrong_owner(self, store: LiveChatStore) -> None:
        store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        store.claim_processing(owner="worker-1", now=1000.0, lease_s=60.0)
        assert (
            store.renew_lease(att_id="att-1", owner="worker-2", now=1050.0, lease_s=60.0) is False
        )

    def test_finish_attachment_is_a_no_op_for_a_stolen_lease(self, store: LiveChatStore) -> None:
        store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        store.claim_processing(owner="worker-1", now=1000.0, lease_s=60.0)
        store.claim_processing(owner="worker-2", now=1062.0, lease_s=60.0)  # steals it
        store.finish_attachment(
            att_id="att-1",
            owner="worker-1",  # the ORIGINAL (now-stale) owner
            result=AttachmentResult(
                status="ready",
                mime="image/jpeg",
                width=1,
                height=1,
                duration_s=None,
                peaks=None,
                renditions=("full",),
                bytes_on_disk=1,
                failure=None,
            ),
            now=1063.0,
        )
        att = store.get_attachment("att-1")
        assert att is not None
        assert att.status == "processing"  # untouched by the stale finish

    def test_finish_attachment_on_a_row_that_no_longer_exists_is_a_noop(
        self, store: LiveChatStore
    ) -> None:
        """spec/server-chat/00-brief.md §17.1/§17.2 amendment A1 item 4: "finish_
        attachment on a missing row -> a no-op with no event" — the future delete/
        wipe race (P8), where the row can vanish out from under an in-flight media
        processing job. Must not raise."""
        store.finish_attachment(
            att_id="never-existed",
            owner="worker-1",
            result=AttachmentResult(
                status="ready",
                mime="image/jpeg",
                width=1,
                height=1,
                duration_s=None,
                peaks=None,
                renditions=("full",),
                bytes_on_disk=1,
                failure=None,
            ),
            now=1000.0,
        )  # must not raise
        assert store.events_after(0) == []

    def test_media_bytes_used_sums_ready_and_processing(self, store: LiveChatStore) -> None:
        store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        store.claim_processing(owner="w", now=1000.0, lease_s=60.0)
        store.finish_attachment(
            att_id="att-1",
            owner="w",
            result=AttachmentResult(
                status="ready",
                mime="image/jpeg",
                width=1,
                height=1,
                duration_s=None,
                peaks=None,
                renditions=("full",),
                bytes_on_disk=500,
                failure=None,
            ),
            now=1001.0,
        )
        assert store.media_bytes_used() == 500

    def test_orphan_attachment_ids_finds_unreferenced_old_attachments(
        self, store: LiveChatStore
    ) -> None:
        store.create_attachment(att_id="old", kind="photo", now=1000.0)
        store.create_attachment(att_id="new", kind="photo", now=2000.0)
        orphans = store.orphan_attachment_ids(older_than=1500.0)
        assert orphans == ["old"]

    def test_delete_attachment(self, store: LiveChatStore) -> None:
        store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        store.delete_attachment("att-1")
        assert store.get_attachment("att-1") is None


class TestUploads:
    def test_create_get_delete_round_trip(self, store: LiveChatStore) -> None:
        row = UploadRow(
            id="upload-1",
            kind="video",
            mime="video/mp4",
            size_bytes=1000,
            filename="clip.mp4",
            by_email="josh@example.com",
            created_at=1000.0,
        )
        store.create_upload(row)
        fetched = store.get_upload("upload-1")
        assert fetched == row
        store.delete_upload("upload-1")
        assert store.get_upload("upload-1") is None

    def test_stale_upload_ids(self, store: LiveChatStore) -> None:
        store.create_upload(
            UploadRow(
                id="old",
                kind="photo",
                mime="image/jpeg",
                size_bytes=1,
                filename=None,
                by_email=None,
                created_at=1000.0,
            )
        )
        store.create_upload(
            UploadRow(
                id="new",
                kind="photo",
                mime="image/jpeg",
                size_bytes=1,
                filename=None,
                by_email=None,
                created_at=2000.0,
            )
        )
        assert store.stale_upload_ids(older_than=1500.0) == ["old"]

    def test_pending_upload_bytes(self, store: LiveChatStore) -> None:
        store.create_upload(
            UploadRow(
                id="a",
                kind="photo",
                mime="image/jpeg",
                size_bytes=100,
                filename=None,
                by_email=None,
                created_at=1000.0,
            )
        )
        store.create_upload(
            UploadRow(
                id="b",
                kind="photo",
                mime="image/jpeg",
                size_bytes=250,
                filename=None,
                by_email=None,
                created_at=1000.0,
            )
        )
        assert store.pending_upload_bytes() == 350


class TestPushSubscriptions:
    def _row(self, device_id: str = "device-aaaaaaaa") -> PushSubscriptionRow:
        return PushSubscriptionRow(
            device_id=device_id,
            sender="Josh",
            endpoint=f"https://push.example/{device_id}",
            p256dh="p256dh-key",
            auth="auth-key",
            created_at=1000.0,
            last_ok_at=None,
            consecutive_failures=0,
        )

    def test_upsert_then_get(self, store: LiveChatStore) -> None:
        store.upsert_push_subscription(self._row())
        fetched = store.get_push_subscription("device-aaaaaaaa")
        assert fetched == self._row()

    def test_upsert_replaces_existing_row_for_same_device(self, store: LiveChatStore) -> None:
        store.upsert_push_subscription(self._row())
        updated = PushSubscriptionRow(
            device_id="device-aaaaaaaa",
            sender="Josh",
            endpoint="https://push.example/new",
            p256dh="new-key",
            auth="new-auth",
            created_at=2000.0,
            last_ok_at=None,
            consecutive_failures=0,
        )
        store.upsert_push_subscription(updated)
        assert store.get_push_subscription("device-aaaaaaaa") == updated
        assert len(store.list_push_subscriptions()) == 1

    def test_delete(self, store: LiveChatStore) -> None:
        store.upsert_push_subscription(self._row())
        store.delete_push_subscription("device-aaaaaaaa")
        assert store.get_push_subscription("device-aaaaaaaa") is None

    def test_record_push_result_ok_resets_failures(self, store: LiveChatStore) -> None:
        store.upsert_push_subscription(self._row())
        store.record_push_result(device_id="device-aaaaaaaa", ok=False, now=1001.0)
        store.record_push_result(device_id="device-aaaaaaaa", ok=False, now=1002.0)
        store.record_push_result(device_id="device-aaaaaaaa", ok=True, now=1003.0)
        fetched = store.get_push_subscription("device-aaaaaaaa")
        assert fetched is not None
        assert fetched.consecutive_failures == 0
        assert fetched.last_ok_at == 1003.0

    def test_record_push_result_failure_increments(self, store: LiveChatStore) -> None:
        store.upsert_push_subscription(self._row())
        store.record_push_result(device_id="device-aaaaaaaa", ok=False, now=1001.0)
        store.record_push_result(device_id="device-aaaaaaaa", ok=False, now=1002.0)
        fetched = store.get_push_subscription("device-aaaaaaaa")
        assert fetched is not None
        assert fetched.consecutive_failures == 2
