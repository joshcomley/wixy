# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The "Links" view (workspace 00052): the link detector, the stored `messages.has_link` index
(schema v18) with its one-off backfill and its settle pass for rows an older process inserted,
the store's paged listing, and `GET /messages/links`."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from wixy_server.livechat.links import text_has_link
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import _LATEST_SCHEMA_VERSION, LiveChatStore
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    _unlocked_client,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


def _send(store: LiveChatStore, n: int, text: str | None) -> int:
    message, _created = store.create_message(
        client_id=f"links-client-{n:04d}",
        sender="Josh",
        device_id="device-1234",
        by_email=None,
        text=text,
        attachment_ids=[],
        now=float(n),
    )
    return message.seq


class TestDetector:
    @pytest.mark.parametrize(
        "text",
        [
            "https://example.com",
            "look at http://example.com/a?b=1 later",
            "HTTPS://EXAMPLE.COM",
            "(see https://example.com/x).",
            "two\nlines https://a.b",
        ],
    )
    def test_detects_web_links(self, text: str) -> None:
        assert text_has_link(text) is True

    @pytest.mark.parametrize(
        "text",
        [None, "", "no link here", "example.com", "www.example.com", "ftp://example.com", "xhttps"],
    )
    def test_ignores_everything_else(self, text: str | None) -> None:
        assert text_has_link(text) is False


class TestIndex:
    def test_new_messages_are_indexed_on_insert(self, store: LiveChatStore, db_path: Path) -> None:
        with_link = _send(store, 1, "go to https://example.com")
        without = _send(store, 2, "hello")
        conn = sqlite3.connect(str(db_path))
        try:
            rows = dict(conn.execute("SELECT seq, has_link FROM messages"))
        finally:
            conn.close()
        assert rows == {with_link: 1, without: 0}
        assert _LATEST_SCHEMA_VERSION >= 18

    def test_a_v17_database_is_backfilled_by_the_migration(self, db_path: Path) -> None:
        LiveChatStore(db_path).list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.executemany(
                "INSERT INTO messages (client_id, sender, device_id, text, created_at) "
                "VALUES (?, 'Josh', 'device-1', ?, ?)",
                [
                    ("old-link-0001", "see https://example.com", 1.0),
                    ("old-text-0002", "plain words", 2.0),
                    ("old-none-0003", None, 3.0),
                ],
            )
            conn.execute("DROP INDEX idx_messages_has_link")
            conn.execute("DROP INDEX idx_messages_link_pending")
            conn.execute("ALTER TABLE messages DROP COLUMN has_link")
            conn.execute("PRAGMA user_version = 17")
            conn.commit()
        finally:
            conn.close()

        migrated = LiveChatStore(db_path)
        messages, has_more = migrated.list_link_messages(before=None, limit=10)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == _LATEST_SCHEMA_VERSION
            flags = [row[0] for row in conn.execute("SELECT has_link FROM messages ORDER BY seq")]
        finally:
            conn.close()
        assert flags == [1, 0, 0]
        assert [m.text for m in messages] == ["see https://example.com"]
        assert has_more is False

    def test_rows_inserted_without_the_flag_are_settled_before_listing(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        # What a process older than schema 18 does during a blue/green overlap.
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                "INSERT INTO messages (client_id, sender, device_id, text, created_at) "
                "VALUES ('overlap-0001', 'Josh', 'device-1', 'late https://example.com', 5.0)"
            )
            conn.commit()
        finally:
            conn.close()
        messages, _has_more = store.list_link_messages(before=None, limit=10)
        assert [m.text for m in messages] == ["late https://example.com"]
        assert store.index_pending_links() == 0


class TestListing:
    def test_only_link_messages_newest_page_first_and_paged_by_before(
        self, store: LiveChatStore
    ) -> None:
        link_seqs = [_send(store, n, f"link {n} https://example.com/{n}") for n in (1, 3, 5, 7)]
        _send(store, 2, "plain")
        _send(store, 4, None)

        page, has_more = store.list_link_messages(before=None, limit=2)
        assert [m.seq for m in page] == link_seqs[2:]  # ascending within the page
        assert has_more is True

        older, has_more = store.list_link_messages(before=page[0].seq, limit=2)
        assert [m.seq for m in older] == link_seqs[:2]
        assert has_more is False

    def test_a_deleted_message_leaves_the_listing(self, store: LiveChatStore) -> None:
        keep = _send(store, 1, "https://keep.example")
        gone = _send(store, 2, "https://gone.example")
        store.delete_message(seq=gone, now=10.0)
        page, _has_more = store.list_link_messages(before=None, limit=10)
        assert [m.seq for m in page] == [keep]


class TestRoute:
    def test_lists_link_messages_and_validates_limit(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            for n, text in enumerate(["plain", "a https://one.example", "b https://two.example"]):
                response = client.post(
                    "/api/admin/server/messages",
                    json={
                        "clientId": f"route-links-{n:04d}",
                        "sender": "Josh",
                        "deviceId": "device-1234",
                        "text": text,
                    },
                    headers=headers,
                )
                assert response.status_code == 201, response.text

            first = client.get("/api/admin/server/messages/links?limit=1", headers=headers)
            assert first.status_code == 200, first.text
            body = first.json()
            assert [m["text"] for m in body["messages"]] == ["b https://two.example"]
            assert body["hasMore"] is True

            second = client.get(
                f"/api/admin/server/messages/links?limit=5&before={body['messages'][0]['seq']}",
                headers=headers,
            )
            assert [m["text"] for m in second.json()["messages"]] == ["a https://one.example"]
            assert second.json()["hasMore"] is False

            assert (
                client.get("/api/admin/server/messages/links?limit=0", headers=headers).status_code
                == 422
            )
        finally:
            client.__exit__(None, None, None)

    def test_requires_a_token(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            assert client.get("/api/admin/server/messages/links").status_code in (401, 403)
        finally:
            client.__exit__(None, None, None)
