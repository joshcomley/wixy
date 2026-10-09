# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""Canvas messages (the Server chat header's ... menu): a text-less, attachment-less message
flagged `canvas`, which the client renders as a big blank drawing surface. Schema v14, the store
method, the wire flag, and `POST /messages/canvas`."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from wixy_server.livechat.models import message_json
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


class _Signer:
    def url_for(self, attachment_id: str, rendition: str) -> str:
        return f"https://example.invalid/{attachment_id}/{rendition}"


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


class TestStore:
    def test_schema_has_the_canvas_column_defaulting_to_zero(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == _LATEST_SCHEMA_VERSION
            assert _LATEST_SCHEMA_VERSION >= 14
            info = {row[1]: row for row in conn.execute("PRAGMA table_info(messages)")}
            assert "canvas" in info
            assert info["canvas"][4] == "0"
        finally:
            conn.close()

    def test_a_v13_database_gains_the_column_and_keeps_its_messages_ordinary(
        self, db_path: Path
    ) -> None:
        LiveChatStore(db_path).list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                "INSERT INTO messages (client_id, sender, device_id, text, created_at) "
                "VALUES ('old-message-1', 'Josh', 'device-1', 'hi', 1.0)"
            )
            conn.execute("ALTER TABLE messages DROP COLUMN canvas")
            conn.execute("PRAGMA user_version = 13")
            conn.commit()
        finally:
            conn.close()
        migrated = LiveChatStore(db_path)
        messages, _has_more, _cursor = migrated.list_messages(before=None, limit=10)
        [old] = messages
        assert old.canvas == 0

    def test_create_canvas_message_is_flagged_empty_and_idempotent(
        self, store: LiveChatStore
    ) -> None:
        first, created = store.create_canvas_message(
            client_id="canvas-client-1",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            now=10.0,
        )
        assert created is True
        assert first.canvas == 1
        assert first.text is None
        assert first.attachments == ()
        again, created_again = store.create_canvas_message(
            client_id="canvas-client-1",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            now=20.0,
        )
        assert created_again is False
        assert again.seq == first.seq
        assert message_json(first, _Signer())["canvas"] is True

    def test_ordinary_messages_serialize_canvas_false(self, store: LiveChatStore) -> None:
        message, _ = store.create_message(
            client_id="plain-client-1",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="hello",
            attachment_ids=[],
            now=10.0,
        )
        assert message_json(message, _Signer())["canvas"] is False


class TestRoute:
    def test_send_validate_and_idempotent_replay(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            body = {"clientId": "canvas-route-1", "sender": "Josh", "deviceId": "device-1234"}
            first = client.post("/api/admin/server/messages/canvas", json=body, headers=headers)
            assert first.status_code == 201, first.text
            message = first.json()["message"]
            assert message["canvas"] is True
            assert message["text"] is None
            assert message["attachments"] == []

            replay = client.post("/api/admin/server/messages/canvas", json=body, headers=headers)
            assert replay.status_code == 200
            assert replay.json()["message"]["seq"] == message["seq"]

            bad_client = client.post(
                "/api/admin/server/messages/canvas",
                json={**body, "clientId": "short"},
                headers=headers,
            )
            assert bad_client.status_code == 422
            bad_sender = client.post(
                "/api/admin/server/messages/canvas",
                json={**body, "clientId": "canvas-route-2", "sender": "  "},
                headers=headers,
            )
            assert bad_sender.status_code == 422
            extra = client.post(
                "/api/admin/server/messages/canvas",
                json={**body, "clientId": "canvas-route-3", "text": "x"},
                headers=headers,
            )
            assert extra.status_code == 422

            history = client.get("/api/admin/server/messages?limit=10", headers=headers)
            assert history.status_code == 200
            assert any(m["canvas"] for m in history.json()["messages"])
        finally:
            client.__exit__(None, None, None)

    def test_requires_a_token(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/messages/canvas",
                json={"clientId": "canvas-route-9", "sender": "Josh", "deviceId": "device-1234"},
            )
            assert response.status_code in (401, 403)
        finally:
            client.__exit__(None, None, None)
