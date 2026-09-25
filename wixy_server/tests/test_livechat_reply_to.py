"""`LiveChatStore` — round 2 ruling item 10 (spec/server-chat/04-round2-rulings.md,
ITEM 10 — REPLY TO A MESSAGE): the `reply_to_seq` schema, `create_message`'s
target resolution/idempotency, `list_messages`/`get_messages`'s one-level quote
resolution, `finish_attachment`'s quote-freshness cascade, and erasure (Inv 40,
Inv 46: a reply stores only a seq, and the quote vanishes with the original)."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, cast

import pytest

from wixy_server.livechat.models import AttachmentResult, message_json
from wixy_server.livechat.store import LiveChatStore

# A scrub the test expects to SUCCEED gets a generous deadline: success returns as soon as the WAL
# is truncated, so the number is only ever spent by a machine stall (decision 00159).
_SCRUB_SUCCESS_DEADLINE_S = 30.0


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


class _FakeSigner:
    def url_for(self, attachment_id: str, rendition: str) -> str:
        return f"https://example.invalid/media/{attachment_id}/{rendition}"


class TestSchemaMigration:
    def test_migrates_to_v10_and_creates_the_partial_reply_index(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 10
            index_row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'index' "
                "AND name = 'idx_messages_reply_to'"
            ).fetchone()
            assert index_row is not None
            assert "reply_to_seq" in index_row[0]
            assert "WHERE reply_to_seq IS NOT NULL" in index_row[0]
            columns = {row[1] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
            assert "reply_to_seq" in columns
        finally:
            conn.close()

    def test_foreign_keys_are_enforced_so_set_null_actually_fires(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            # A brand-new connection defaults foreign_keys OFF (SQLite's own
            # default) — this only proves OUR connections turn it on, matching
            # `_connect()`'s `PRAGMA foreign_keys = ON`.
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute("PRAGMA foreign_keys = ON")
                conn.execute(
                    "INSERT INTO messages "
                    "(client_id, sender, device_id, text, created_at, reply_to_seq) "
                    "VALUES ('orphan-ref', 'Josh', 'device-1', 'x', 1.0, 999999)"
                )
        finally:
            conn.close()


class TestCreateMessageReplyTo:
    def test_reply_to_an_existing_message_resolves_the_target_one_level(
        self, store: LiveChatStore
    ) -> None:
        target, _ = store.create_message(
            client_id="client-target-1",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="original message",
            attachment_ids=(),
            now=1.0,
        )
        reply, created = store.create_message(
            client_id="client-reply-1",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="a reply",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=2.0,
        )
        assert created
        assert reply.reply_to_seq == target.seq
        assert reply.reply_to is not None
        assert reply.reply_to.seq == target.seq
        assert reply.reply_to.text == "original message"
        # §(3): one level only — the target's OWN reply_to is never resolved.
        assert reply.reply_to.reply_to is None

    def test_reply_to_an_unknown_seq_sends_as_a_plain_message_never_500(
        self, store: LiveChatStore
    ) -> None:
        message, created = store.create_message(
            client_id="client-dangling-1",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="dangling",
            attachment_ids=(),
            reply_to_seq=999999,
            now=1.0,
        )
        assert created
        assert message.reply_to_seq is None
        assert message.reply_to is None

    def test_reply_to_a_target_already_deleted_sends_as_a_plain_message(
        self, store: LiveChatStore
    ) -> None:
        """§(3): 'If it is missing (deleted in the meantime, or never existed),
        store NULL and send it as a plain message (201). That is exactly what
        would have happened had the delete landed a moment later.'"""
        target, _ = store.create_message(
            client_id="client-target-2",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="will be gone",
            attachment_ids=(),
            now=1.0,
        )
        store.delete_message(seq=target.seq, now=2.0)
        message, created = store.create_message(
            client_id="client-reply-2",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="too late",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=3.0,
        )
        assert created
        assert message.reply_to_seq is None
        assert message.reply_to is None

    def test_replaying_the_same_client_id_returns_the_stored_reply_unchanged(
        self, store: LiveChatStore
    ) -> None:
        target, _ = store.create_message(
            client_id="client-target-3",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="original",
            attachment_ids=(),
            now=1.0,
        )
        first, created_first = store.create_message(
            client_id="client-reply-3",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="reply text",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=2.0,
        )
        second, created_second = store.create_message(
            client_id="client-reply-3",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="reply text",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=2.0,
        )
        assert created_first
        assert not created_second
        assert second.seq == first.seq
        assert second.reply_to_seq == target.seq

    def test_an_ordinary_message_has_no_reply_to(self, store: LiveChatStore) -> None:
        message, _ = store.create_message(
            client_id="client-plain-1",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="just a message",
            attachment_ids=(),
            now=1.0,
        )
        assert message.reply_to_seq is None
        assert message.reply_to is None


class TestListAndGetMessagesResolveTargets:
    def test_list_messages_resolves_a_target_outside_the_returned_page(
        self, store: LiveChatStore
    ) -> None:
        target, _ = store.create_message(
            client_id="client-page-target",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="paged off already",
            attachment_ids=(),
            now=1.0,
        )
        for i in range(5):
            store.create_message(
                client_id=f"client-filler-{i}",
                sender="Josh",
                device_id="device-1",
                by_email=None,
                text=f"filler {i}",
                attachment_ids=(),
                now=2.0 + i,
            )
        reply, _ = store.create_message(
            client_id="client-page-reply",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="quoting the old one",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=10.0,
        )
        messages, _has_more, _cursor = store.list_messages(before=None, limit=3)
        by_seq = {m.seq: m for m in messages}
        assert target.seq not in by_seq  # confirms it really did page off
        assert reply.seq in by_seq
        resolved = by_seq[reply.seq]
        assert resolved.reply_to is not None
        assert resolved.reply_to.seq == target.seq
        assert resolved.reply_to.text == "paged off already"

    def test_get_messages_resolves_targets_too(self, store: LiveChatStore) -> None:
        target, _ = store.create_message(
            client_id="client-get-target",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="target text",
            attachment_ids=(),
            now=1.0,
        )
        reply, _ = store.create_message(
            client_id="client-get-reply",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="reply text",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=2.0,
        )
        [resolved] = store.get_messages([reply.seq])
        assert resolved.reply_to is not None
        assert resolved.reply_to.text == "target text"

    def test_two_replies_to_the_same_target_in_one_page_share_one_lookup(
        self, store: LiveChatStore
    ) -> None:
        """Not directly observable from the return value, but a regression guard
        against re-introducing a per-row N+1 query: both resolve correctly even
        when the target is deduped internally."""
        target, _ = store.create_message(
            client_id="client-shared-target",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="shared target",
            attachment_ids=(),
            now=1.0,
        )
        reply_a, _ = store.create_message(
            client_id="client-shared-a",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="reply a",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=2.0,
        )
        reply_b, _ = store.create_message(
            client_id="client-shared-b",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="reply b",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=3.0,
        )
        messages, _has_more, _cursor = store.list_messages(before=None, limit=10)
        by_seq = {m.seq: m for m in messages}
        reply_a_target = by_seq[reply_a.seq].reply_to
        reply_b_target = by_seq[reply_b.seq].reply_to
        assert reply_a_target is not None
        assert reply_b_target is not None
        assert reply_a_target.text == "shared target"
        assert reply_b_target.text == "shared target"


class TestReplyErasure:
    """Inv 40/Inv 46: a reply stores only the target's seq, never a copy — so
    deleting or wiping the target erases its words everywhere, quotes included,
    with no chat-visible tombstone."""

    @staticmethod
    def _raw_database_bytes(db_path: Path) -> bytes:
        wal_path = Path(f"{db_path}-wal")
        return db_path.read_bytes() + (wal_path.read_bytes() if wal_path.exists() else b"")

    def test_deleting_the_target_nulls_the_reply_and_scrubs_the_sentinel(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        target, _ = store.create_message(
            client_id="client-erasure-target",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="erasure-marker-9f2c11",
            attachment_ids=(),
            now=1.0,
        )
        reply, _ = store.create_message(
            client_id="client-erasure-reply",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="quoting it",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=2.0,
        )
        # Hold a second connection open so the delete's WAL isn't truncated
        # for free by SQLite closing the only connection — the same pattern
        # `TestDeleteAndWipe` uses in test_livechat_store.py.
        second_connection = sqlite3.connect(str(db_path), isolation_level=None)
        second_connection.execute("SELECT 1")
        try:
            store.delete_message(seq=target.seq, now=3.0)
            assert store.scrub(deadline_s=_SCRUB_SUCCESS_DEADLINE_S)
            [reloaded] = store.get_messages([reply.seq])
            assert reloaded.reply_to_seq is None
            assert reloaded.reply_to is None
            assert reloaded.text == "quoting it"  # the reply itself survives
            assert b"erasure-marker-9f2c11" not in self._raw_database_bytes(db_path)
        finally:
            second_connection.close()

    def test_wipe_nulls_every_reply_and_scrubs_the_sentinel(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        target, _ = store.create_message(
            client_id="client-wipe-target",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="wipe-reply-marker-4a7e02",
            attachment_ids=(),
            now=1.0,
        )
        store.create_message(
            client_id="client-wipe-reply",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="quoting it",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=2.0,
        )
        second_connection = sqlite3.connect(str(db_path), isolation_level=None)
        second_connection.execute("SELECT 1")
        try:
            store.wipe(now=3.0)
            assert store.scrub(deadline_s=_SCRUB_SUCCESS_DEADLINE_S)
            messages, _has_more, _cursor = store.list_messages(before=None, limit=10)
            assert messages == []
            assert b"wipe-reply-marker-4a7e02" not in self._raw_database_bytes(db_path)
        finally:
            second_connection.close()

    def test_a_bare_delete_from_an_older_process_still_nulls_the_reply(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        """§(2): 'Blue/green overlap: an older slot process ignores the column
        on read and inserts NULL on write. Its hard delete still nulls the
        replies, because the action lives in the schema, not in code.' Simulated
        here with a bare `DELETE FROM messages WHERE seq = ?` on a raw
        connection that knows nothing about `reply_to_seq` — exactly what
        `_delete_message` did before this feature existed."""
        target, _ = store.create_message(
            client_id="client-bare-target",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="bare delete target",
            attachment_ids=(),
            now=1.0,
        )
        reply, _ = store.create_message(
            client_id="client-bare-reply",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="quoting it",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=2.0,
        )
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("DELETE FROM messages WHERE seq = ?", (target.seq,))
            conn.commit()
        finally:
            conn.close()
        [reloaded] = store.get_messages([reply.seq])
        assert reloaded.reply_to_seq is None
        assert reloaded.text == "quoting it"


class TestQuoteFreshnessOnAttachmentFinish:
    def test_finishing_the_targets_attachment_emits_message_updated_for_every_reply(
        self, store: LiveChatStore
    ) -> None:
        attachment = store.create_attachment(att_id="a" * 32, kind="video", now=1.0)
        target, _ = store.create_message(
            client_id="client-quote-target",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text=None,
            attachment_ids=(attachment.id,),
            now=2.0,
        )
        reply, _ = store.create_message(
            client_id="client-quote-reply",
            sender="Purdi",
            device_id="device-2",
            by_email=None,
            text="quoting the video",
            attachment_ids=(),
            reply_to_seq=target.seq,
            now=3.0,
        )
        other, _ = store.create_message(
            client_id="client-quote-other",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="unrelated",
            attachment_ids=(),
            now=4.0,
        )
        cursor_before = max(event.event_seq for event in store.events_after(0))

        store.claim_processing(owner="worker-1", now=5.0, lease_s=60.0)
        store.finish_attachment(
            att_id=attachment.id,
            owner="worker-1",
            result=AttachmentResult(
                status="ready",
                mime="video/mp4",
                width=100,
                height=100,
                duration_s=12.5,
                peaks=None,
                renditions=("play", "poster"),
                bytes_on_disk=999,
                failure=None,
            ),
            now=6.0,
        )
        new_events = store.events_after(cursor_before)
        updated_seqs = {e.message_seq for e in new_events if e.type == "message_updated"}
        assert updated_seqs == {target.seq, reply.seq}
        assert other.seq not in updated_seqs

        [reloaded_reply] = store.get_messages([reply.seq])
        wire = message_json(reloaded_reply, _FakeSigner())
        reply_to = cast("dict[str, Any]", wire["replyTo"])
        media = cast("dict[str, Any]", reply_to["media"])
        assert media["kind"] == "video"
        assert media["durationS"] == 12.5
        assert media["thumbUrl"] is not None

    def test_finishing_an_attachment_with_no_replies_emits_only_its_own_update(
        self, store: LiveChatStore
    ) -> None:
        attachment = store.create_attachment(att_id="b" * 32, kind="photo", now=1.0)
        target, _ = store.create_message(
            client_id="client-lonely-target",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text=None,
            attachment_ids=(attachment.id,),
            now=2.0,
        )
        cursor_before = max(event.event_seq for event in store.events_after(0))
        store.claim_processing(owner="worker-1", now=3.0, lease_s=60.0)
        store.finish_attachment(
            att_id=attachment.id,
            owner="worker-1",
            result=AttachmentResult(
                status="ready",
                mime="image/jpeg",
                width=10,
                height=10,
                duration_s=None,
                peaks=None,
                renditions=("full", "thumb"),
                bytes_on_disk=100,
                failure=None,
            ),
            now=4.0,
        )
        new_events = store.events_after(cursor_before)
        assert [(e.type, e.message_seq) for e in new_events] == [("message_updated", target.seq)]
