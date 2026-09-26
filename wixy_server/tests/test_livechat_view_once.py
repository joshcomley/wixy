"""`LiveChatStore` and route tests for view-once media and tease reveal
(spec/server-chat/06-view-once-media.md).

Tests cover:
- Schema migration to v11 (messages.view_once_s, view_tease, view_claim_id,
  view_claimed_at, view_claim_email, idx_messages_view_claimed, attachments.view_once_renditions),
  and the v12 rename of that column from view_spotlight to view_tease (decisions/00172).
- Invariant 52: No ordinary link may ever exist for a view-once item.
- Send route: POST /api/admin/server/messages/view-once (validation, not_ready, idempotency).
- Claim route: POST /api/admin/server/messages/{seq}/view-once/open
  (404, 403 own_message, concurrency race, 409).
- Content route: GET /api/admin/server/messages/{seq}/view-once/content
  (headers, 410, broken vs complete download erasure).
- Backstop: contained loop erases claims older than 600 s.
"""

from __future__ import annotations

import concurrent.futures
import io
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

import anyio
import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from wixy_server.app import create_app
from wixy_server.livechat.janitor import (
    cleanup_expired_view_once_messages,
    run_view_once_backstop_forever,
)
from wixy_server.livechat.models import (
    message_json,
    reply_to_json,
)
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import _LATEST_SCHEMA_VERSION, LiveChatStore
from wixy_server.livechat.tokens import sign_media_url
from wixy_server.storage import ProjectPaths
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

TEST_PIN = "1234"
TEST_APP_KEY = "test-livechat"
UNLOCK_GUARD_HEADERS = {
    "X-Wixy-Server-Unlock": "1",
    "Content-Type": "application/json",
}


def _git(cmd: list[str], cwd: Path) -> None:
    import subprocess

    subprocess.run(["git", *cmd], cwd=cwd, check=True, capture_output=True)


def _raw_db(store: LiveChatStore) -> bytes:
    db = store._db_path
    wal = Path(f"{db}-wal")
    return db.read_bytes() + (wal.read_bytes() if wal.exists() else b"")


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "README.md").write_text("hi\n", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


@pytest.fixture
def wixy_repo_root(tmp_path: Path, origin_repo: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "test",
                "repo": str(origin_repo),
                "defaultBranch": "main",
                "cmdProject": "test",
                "domain": "test.example.invalid",
                "locale": "en-GB",
                "indexable": False,
                "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
            }
        ),
        encoding="utf-8",
    )
    _git(["init", "--initial-branch=main"], root)
    _git(["config", "user.email", "test@example.com"], root)
    _git(["config", "user.name", "Test"], root)
    _git(["add", "."], root)
    _git(["commit", "-m", "engine commit"], root)
    return root


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture
def fake_cmd_state() -> FakeCmdState:
    state = FakeCmdState()
    state.register_pin_app(TEST_APP_KEY, TEST_PIN, lockout_after=5, lockout_seconds=60.0)
    return state


@pytest.fixture
def pin_verifier(fake_cmd_state: FakeCmdState) -> CmdPinVerifier:
    fake_app = create_fake_cmd_app(fake_cmd_state)
    return CmdPinVerifier(app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app))


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


def _form_style_json(pin: str) -> bytes:
    return json.dumps({"pin": pin}).encode("utf-8")


def _message_exists(store: LiveChatStore, seq: int) -> bool:
    with store._read_txn() as conn:
        return conn.execute("SELECT 1 FROM messages WHERE seq = ?", (seq,)).fetchone() is not None


def _unlocked_client(
    storage_root: Path,
    wixy_repo_root: Path,
    pin_verifier: CmdPinVerifier,
    email: str = "editor@example.com",
) -> tuple[TestClient, dict[str, str]]:
    app = create_app(
        storage_root=storage_root,
        wixy_repo_root=wixy_repo_root,
        pin_verifier=pin_verifier,
        transcriber=AsyncMock(),
    )
    client = TestClient(app, cookies={"CF_Authorization": "dummy"})
    client.__enter__()
    token_resp = client.post(
        "/api/admin/server/unlock",
        content=_form_style_json(TEST_PIN),
        headers={
            **UNLOCK_GUARD_HEADERS,
            "Sec-Fetch-Site": "same-origin",
            "CF-Access-Authenticated-User-Email": email,
        },
    )
    assert token_resp.status_code == 200, token_resp.text
    token = token_resp.json()["token"]
    headers = {
        "X-Wixy-Server-Token": token,
        "CF-Access-Authenticated-User-Email": email,
    }
    return client, headers


def _create_ready_photo(
    client: TestClient,
    headers: dict[str, str],
) -> tuple[str, bytes]:
    buf = io.BytesIO()
    Image.new("RGB", (30, 20), "blue").save(buf, format="JPEG")
    data = buf.getvalue()
    init_resp = client.post(
        "/api/admin/server/uploads",
        json={"kind": "photo", "mimeType": "image/jpeg", "sizeBytes": len(data)},
        headers=headers,
    )
    assert init_resp.status_code == 201, init_resp.text
    upload_id = init_resp.json()["uploadId"]
    put_resp = client.put(
        f"/api/admin/server/uploads/{upload_id}/chunks/0",
        content=data,
        headers={**headers, "Content-Type": "application/octet-stream"},
    )
    assert put_resp.status_code == 204
    comp_resp = client.post(f"/api/admin/server/uploads/{upload_id}/complete", headers=headers)
    assert comp_resp.status_code == 202

    store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        row = store.get_attachment(upload_id)
        if row is not None and row.status == "ready":
            return upload_id, data
        time.sleep(0.02)
    raise AssertionError("Attachment never became ready")


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
    def test_migrates_to_latest_schema_and_creates_view_once_columns(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == _LATEST_SCHEMA_VERSION
            assert _LATEST_SCHEMA_VERSION >= 11

            msg_cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
            assert "view_once_s" in msg_cols
            assert "view_tease" in msg_cols
            assert "view_claim_id" in msg_cols
            assert "view_claimed_at" in msg_cols
            assert "view_claim_email" in msg_cols

            att_cols = {row[1] for row in conn.execute("PRAGMA table_info(attachments)").fetchall()}
            assert "view_once_renditions" in att_cols

            index_row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'index' "
                "AND name = 'idx_messages_view_claimed'"
            ).fetchone()
            assert index_row is not None
            assert "view_claimed_at" in index_row[0]
            assert "WHERE view_claimed_at IS NOT NULL" in index_row[0]
        finally:
            conn.close()

    def test_check_constraints_on_messages(self, store: LiveChatStore, db_path: Path) -> None:
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            # view_once_s can only be NULL or 0, 2, 5, 30
            for valid_s in (None, 0, 2, 5, 30):
                conn.execute(
                    "INSERT INTO messages (client_id, sender, device_id, created_at, view_once_s) "
                    "VALUES (?, 'Josh', 'dev1', 1.0, ?)",
                    (f"client-{valid_s}", valid_s),
                )

            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO messages (client_id, sender, device_id, created_at, view_once_s) "
                    "VALUES ('client-invalid-s', 'Josh', 'dev1', 1.0, 10)"
                )

            # view_tease can only be 0 or 1
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO messages "
                    "(client_id, sender, device_id, created_at, view_tease) "
                    "VALUES ('client-invalid-tease', 'Josh', 'dev1', 1.0, 2)"
                )
        finally:
            conn.close()

    def test_migrates_v11_database_renames_spotlight_column_to_tease(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        """A database already fully migrated under the OLD `view_spotlight` name
        (schema v11) upgrades cleanly to v12: the column is RENAMED (not dropped
        and recreated — no data loss), and SQLite's RENAME COLUMN (3.25+) rewrites
        the column's own CHECK constraint text so it still fires under the new
        name (decisions/00172 — a pure rename, no behavior change)."""
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("ALTER TABLE messages RENAME COLUMN view_tease TO view_spotlight")
            conn.execute("PRAGMA user_version = 11")
            conn.commit()
        finally:
            conn.close()

        upgraded = LiveChatStore(db_path)
        upgraded.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == _LATEST_SCHEMA_VERSION
            assert _LATEST_SCHEMA_VERSION >= 12

            msg_cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
            assert "view_tease" in msg_cols
            assert "view_spotlight" not in msg_cols

            table_sql = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
            ).fetchone()[0]
            assert "view_spotlight" not in table_sql
            assert "CHECK(view_tease IN (0, 1))" in table_sql

            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO messages "
                    "(client_id, sender, device_id, created_at, view_tease) "
                    "VALUES ('client-invalid-tease-post-rename', 'Josh', 'dev1', 1.0, 2)"
                )
        finally:
            conn.close()


class TestViewOnceNoLinksInvariant:
    def test_view_once_attachment_has_empty_urls_and_no_quote_thumb(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        now = time.time()
        with store._write_txn() as conn:
            conn.execute(
                "INSERT INTO attachments "
                "(id, kind, status, mime, width, height, renditions, created_at, updated_at) "
                "VALUES ('att1', 'photo', 'ready', 'image/jpeg', 100, 100, '[\"full\"]', ?, ?)",
                (now, now),
            )
        msg, _ = store.create_view_once_message(
            client_id="client-vo-1",
            sender="Josh",
            device_id="device-1",
            by_email="josh@example.com",
            attachment_id="att1",
            duration_s=5,
            tease=False,
            now=now,
        )

        # Attachment renditions in DB must now be '[]' and view_once_renditions set
        conn = sqlite3.connect(str(db_path))
        try:
            row = conn.execute(
                "SELECT renditions, view_once_renditions FROM attachments WHERE id = 'att1'"
            ).fetchone()
            assert row[0] == "[]"
            assert json.loads(row[1]) == ["full"]
        finally:
            conn.close()

        # attachment_json mints urls: {}
        signer = _FakeSigner()
        msg_wire = message_json(msg, signer)
        attachments_wire = cast(list[dict[str, Any]], msg_wire["attachments"])
        assert attachments_wire[0]["urls"] == {}
        assert msg_wire["viewOnce"] == {"durationS": 5, "tease": False, "spotlight": False}

        # Item-10 quote of a view-once message produces thumbUrl: None
        quote_wire = reply_to_json(msg, signer)
        assert quote_wire is not None
        assert quote_wire["media"] is not None
        media = cast(dict[str, Any], quote_wire["media"])
        assert media["thumbUrl"] is None
        assert media["kind"] == "photo"
        assert media.get("viewOnce") is True

    def test_old_style_serializer_mints_no_urls(self, store: LiveChatStore) -> None:
        """Old-style serializer that iterates over row.renditions directly mints nothing."""
        now = time.time()
        with store._write_txn() as conn:
            conn.execute(
                "INSERT INTO attachments "
                "(id, kind, status, mime, renditions, created_at, updated_at) "
                "VALUES ('att2', 'photo', 'ready', 'image/jpeg', '[\"full\", \"thumb\"]', ?, ?)",
                (now, now),
            )
        msg, _ = store.create_view_once_message(
            client_id="client-vo-2",
            sender="Josh",
            device_id="device-1",
            by_email="josh@example.com",
            attachment_id="att2",
            duration_s=None,
            tease=True,
            now=now,
        )
        att = msg.attachments[0]
        # An old-style serializer loop:
        old_urls = {r: f"https://example.invalid/{att.id}/{r}" for r in att.renditions}
        assert old_urls == {}
        assert msg.view_once_s == 0
        assert msg.view_tease == 1

    def test_signed_media_url_minted_before_send_returns_404_after_send(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, _ = _create_ready_photo(client, headers)
            secret: bytes = client.app.state.livechat_secret  # type: ignore[attr-defined]
            exp = int(time.time()) + 3600
            sig = sign_media_url(secret, attachment_id=att_id, rendition="full", exp=exp, email="")
            # Before view-once send, ordinary media route answers 200
            res = client.get(f"/api/admin/server/media/{att_id}/full?exp={exp}&sig={sig}")
            assert res.status_code == 200

            # Send as view-once
            send_res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-send-vo-1",
                    "sender": "Josh",
                    "deviceId": "device-client-1",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert send_res.status_code == 201

            # After view-once send, ordinary media route MUST answer 404
            res_after = client.get(f"/api/admin/server/media/{att_id}/full?exp={exp}&sig={sig}")
            assert res_after.status_code == 404
        finally:
            client.__exit__(None, None, None)


class TestSendRoute:
    def test_validation_matrix(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, _ = _create_ready_photo(client, headers)

            # Bad clientId
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "short",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Bad durationS
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-12345",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 10,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Bad attachmentId (not 32 hex)
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-12345",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": "not-a-hex-id",
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Bad sender
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-12345",
                    "sender": "\x00bad",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Bad replyToSeq
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-12345",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                    "replyToSeq": -1,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Bad deviceId (<8 chars)
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-12345",
                    "sender": "Josh",
                    "deviceId": "short",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Bad deviceId (>64 chars)
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-12345",
                    "sender": "Josh",
                    "deviceId": "d" * 65,
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Tease on a video attachment
            now = time.time()
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            with store._write_txn() as conn:
                conn.execute(
                    "INSERT INTO attachments "
                    "(id, kind, status, mime, renditions, created_at, updated_at) "
                    "VALUES ('att-video-val-001', 'video', 'ready', 'video/mp4', "
                    "'[\"play\"]', ?, ?)",
                    (now, now),
                )
                conn.execute(
                    "INSERT INTO attachments "
                    "(id, kind, status, mime, renditions, created_at, updated_at) "
                    "VALUES ('att-voice-val-001', 'voice', 'ready', 'audio/mp4', "
                    "'[\"play\"]', ?, ?)",
                    (now, now),
                )

            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-tease-video",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": "att-video-val-001",
                    "durationS": 5,
                    "tease": True,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Voice-kind attachment
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-voice-vo",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": "att-voice-val-001",
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Unknown attachment ID
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-unknown-att",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": "9" * 32,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"

            # Already-used attachment
            res_used_first = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-used-first",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res_used_first.status_code == 201

            res_used_second = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-used-second",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res_used_second.status_code == 422
            assert res_used_second.json()["error"] == "invalid"
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize("invalid_val", [True, False, "7", 1.0, 0, -1, 2**63])
    def test_reply_to_seq_invalid_values(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        invalid_val: Any,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, _ = _create_ready_photo(client, headers)
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-replyto-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                    "replyToSeq": invalid_val,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"
        finally:
            client.__exit__(None, None, None)

    def test_reply_to_seq_valid_existing_and_missing(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            ord_res = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "client-ord-1",
                    "sender": "Alice",
                    "deviceId": "device-1234",
                    "text": "Hello world",
                },
                headers=headers,
            )
            assert ord_res.status_code == 201
            target_seq = ord_res.json()["message"]["seq"]

            att_id1, _ = _create_ready_photo(client, headers)
            vo_res1 = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-vo-reply-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id1,
                    "durationS": 5,
                    "tease": False,
                    "replyToSeq": target_seq,
                },
                headers=headers,
            )
            assert vo_res1.status_code == 201
            body1 = vo_res1.json()["message"]
            assert body1["replyTo"] is not None
            assert body1["replyTo"]["seq"] == target_seq
            assert body1["replyTo"]["sender"] == "Alice"
            assert body1["replyTo"]["text"] == "Hello world"

            att_id2, _ = _create_ready_photo(client, headers)
            vo_res2 = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-vo-reply-2",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id2,
                    "durationS": 5,
                    "tease": False,
                    "replyToSeq": 999999,
                },
                headers=headers,
            )
            assert vo_res2.status_code == 201
            body2 = vo_res2.json()["message"]
            assert body2["replyTo"] is None
        finally:
            client.__exit__(None, None, None)

    def test_not_ready_returns_422_not_ready(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            now = time.time()
            att_id = "a" * 32
            with store._write_txn() as conn:
                conn.execute(
                    "INSERT INTO attachments "
                    "(id, kind, status, mime, created_at, updated_at) "
                    "VALUES (?, 'photo', 'processing', 'image/jpeg', ?, ?)",
                    (att_id, now, now),
                )
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-not-ready-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json() == {"error": "not_ready"}
        finally:
            client.__exit__(None, None, None)

    def test_failed_attachment_returns_422_invalid(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            now = time.time()
            att_id = "f" * 32
            with store._write_txn() as conn:
                conn.execute(
                    "INSERT INTO attachments "
                    "(id, kind, status, mime, created_at, updated_at) "
                    "VALUES (?, 'photo', 'failed', 'image/jpeg', ?, ?)",
                    (att_id, now, now),
                )
            res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-failed-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=headers,
            )
            assert res.status_code == 422
            assert res.json()["error"] == "invalid"
        finally:
            client.__exit__(None, None, None)

    def test_idempotent_send_returns_200(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, _ = _create_ready_photo(client, headers)
            payload = {
                "clientId": "client-idempotent-1",
                "sender": "Josh",
                "deviceId": "device-1234",
                "attachmentId": att_id,
                "durationS": 30,
                "tease": True,
            }
            res1 = client.post(
                "/api/admin/server/messages/view-once", json=payload, headers=headers
            )
            assert res1.status_code == 201
            data1 = res1.json()["message"]
            assert data1["viewOnce"] == {"durationS": 30, "tease": True, "spotlight": True}

            # Second send with same clientId returns 200 and same message
            res2 = client.post(
                "/api/admin/server/messages/view-once", json=payload, headers=headers
            )
            assert res2.status_code == 200
            assert res2.json()["message"]["seq"] == data1["seq"]
        finally:
            client.__exit__(None, None, None)

    def test_stale_tab_sending_the_old_spotlight_key_still_gets_a_tease(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """TRANSITIONAL (decisions/00172, remove with the alias after 2026-10-27): a browser
        tab loaded before the spotlight -> tease rename still sends `spotlight`. Ignoring it
        would send the photo with Tease OFF, i.e. the recipient sees the FULL picture the
        sender meant to tease. The old key must therefore still switch Tease on."""
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            for name, legacy_value in (("on", True), ("off", False)):
                att_id, _ = _create_ready_photo(client, headers)
                res = client.post(
                    "/api/admin/server/messages/view-once",
                    json={
                        "clientId": f"client-stale-{name}-1",
                        "sender": "Josh",
                        "deviceId": "device-1234",
                        "attachmentId": att_id,
                        "durationS": 5,
                        "spotlight": legacy_value,
                    },
                    headers=headers,
                )
                assert res.status_code == 201
                assert res.json()["message"]["viewOnce"] == {
                    "durationS": 5,
                    "tease": legacy_value,
                    "spotlight": legacy_value,
                }
        finally:
            client.__exit__(None, None, None)


class TestClaimRoute:
    def test_claim_404_for_unknown_or_plain_message(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            # Unknown seq
            res = client.post(
                "/api/admin/server/messages/99999/view-once/open",
                json={"claimId": "a" * 32, "sender": "Alice"},
                headers=headers,
            )
            assert res.status_code == 404

            # Plain message (not view-once)
            send_res = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "client-plain-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "text": "hi",
                },
                headers=headers,
            )
            plain_seq = send_res.json()["message"]["seq"]
            res2 = client.post(
                f"/api/admin/server/messages/{plain_seq}/view-once/open",
                json={"claimId": "a" * 32, "sender": "Alice"},
                headers=headers,
            )
            assert res2.status_code == 404
        finally:
            client.__exit__(None, None, None)

    def test_claim_403_for_sender_own_identity(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="sender@example.com"
        )
        try:
            att_id, _ = _create_ready_photo(client, headers)
            send_res = client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-own-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 2,
                    "tease": False,
                },
                headers=headers,
            )
            seq = send_res.json()["message"]["seq"]

            # Same email -> 403 own_message
            res = client.post(
                f"/api/admin/server/messages/{seq}/view-once/open",
                json={"claimId": "b" * 32, "sender": "Anyone"},
                headers=headers,
            )
            assert res.status_code == 403
            assert res.json() == {"error": "own_message"}

            # Same sender name when email is blank/different -> 403
            client_no_email, headers_no_email = _unlocked_client(
                storage_root, wixy_repo_root, pin_verifier, email=""
            )
            try:
                res_name = client_no_email.post(
                    f"/api/admin/server/messages/{seq}/view-once/open",
                    json={"claimId": "b" * 32, "sender": "  josh  "},
                    headers=headers_no_email,
                )
                assert res_name.status_code == 403
                assert res_name.json() == {"error": "own_message"}
            finally:
                client_no_email.__exit__(None, None, None)
        finally:
            client.__exit__(None, None, None)

    def test_claim_403_for_sender_nfd_vs_nfc_name(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """Item 13: own-message check folds like reactor_key (NFC-normalise, trim, casefold)."""
        import unicodedata

        nfc_name = unicodedata.normalize("NFC", "Zoë")
        nfd_name = unicodedata.normalize("NFD", "Zoë")
        assert nfc_name != nfd_name

        sender_client, sender_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email=""
        )
        recip_client, recip_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email=""
        )
        try:
            att_id, _ = _create_ready_photo(sender_client, sender_headers)
            send_res = sender_client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-nfc-1",
                    "sender": nfc_name,
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 2,
                    "tease": False,
                },
                headers=sender_headers,
            )
            assert send_res.status_code == 201
            seq = send_res.json()["message"]["seq"]

            # Claim from another device with NFD version of same name -> 403 own_message
            claim_res = recip_client.post(
                f"/api/admin/server/messages/{seq}/view-once/open",
                json={"claimId": "c" * 32, "sender": f"  {nfd_name}  "},
                headers=recip_headers,
            )
            assert claim_res.status_code == 403
            assert claim_res.json() == {"error": "own_message"}
        finally:
            sender_client.__exit__(None, None, None)
            recip_client.__exit__(None, None, None)

    def test_claim_200_for_recipient_idempotent_retry_and_409_conflict(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        sender_client, sender_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="sender@example.com"
        )
        recipient_client, recipient_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="recipient@example.com"
        )
        try:
            att_id, _ = _create_ready_photo(sender_client, sender_headers)
            send_res = sender_client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-claim-test-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=sender_headers,
            )
            seq = send_res.json()["message"]["seq"]

            claim_id = "c" * 32
            # Recipient claims -> 200
            open_res = recipient_client.post(
                f"/api/admin/server/messages/{seq}/view-once/open",
                json={"claimId": claim_id, "sender": "Recipient"},
                headers=recipient_headers,
            )
            assert open_res.status_code == 200
            assert open_res.json() == {
                "durationS": 5,
                "tease": False,
                "spotlight": False,
                "kind": "photo",
                "mime": "image/jpeg",
            }

            # Retry with same claimId & email -> 200 again
            retry_res = recipient_client.post(
                f"/api/admin/server/messages/{seq}/view-once/open",
                json={"claimId": claim_id, "sender": "Recipient"},
                headers=recipient_headers,
            )
            assert retry_res.status_code == 200
            assert retry_res.json() == open_res.json()

            # Different claimId -> 409 already_opened
            conflict_res = recipient_client.post(
                f"/api/admin/server/messages/{seq}/view-once/open",
                json={"claimId": "d" * 32, "sender": "Recipient"},
                headers=recipient_headers,
            )
            assert conflict_res.status_code == 409
            assert conflict_res.json() == {"error": "already_opened"}
        finally:
            sender_client.__exit__(None, None, None)
            recipient_client.__exit__(None, None, None)

    def test_concurrent_claims_through_two_store_connections(self, db_path: Path) -> None:
        """Two concurrent claims through two store connections -> exactly one 200 and one 409."""
        store1 = LiveChatStore(db_path)
        store2 = LiveChatStore(db_path)
        now = time.time()
        with store1._write_txn() as conn:
            conn.execute(
                "INSERT INTO attachments "
                "(id, kind, status, mime, renditions, created_at, updated_at) "
                "VALUES ('att-conc', 'photo', 'ready', 'image/jpeg', '[\"full\"]', ?, ?)",
                (now, now),
            )
        msg, _ = store1.create_view_once_message(
            client_id="client-conc-1",
            sender="Josh",
            device_id="dev1",
            by_email="josh@example.com",
            attachment_id="att-conc",
            duration_s=5,
            tease=False,
            now=now,
        )

        claim1 = "1" * 32
        claim2 = "2" * 32

        def _do_claim(s: LiveChatStore, cid: str) -> str:
            outcome, _, _ = s.claim_view_once(
                seq=msg.seq,
                claim_id=cid,
                email="alice@example.com",
                sender="Alice",
                now=time.time(),
            )
            return outcome

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            fut1 = executor.submit(_do_claim, store1, claim1)
            fut2 = executor.submit(_do_claim, store2, claim2)
            outcomes = {fut1.result(), fut2.result()}

        assert outcomes == {"ok", "already_opened"}


class TestContentRoute:
    def test_content_headers_forbidden_and_410_expired(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        sender_client, sender_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="sender@example.com"
        )
        recip_client, recip_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="recip@example.com"
        )
        try:
            att_id, _ = _create_ready_photo(sender_client, sender_headers)
            send_res = sender_client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-content-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=sender_headers,
            )
            seq = send_res.json()["message"]["seq"]
            claim_id = "e" * 32
            open_res = recip_client.post(
                f"/api/admin/server/messages/{seq}/view-once/open",
                json={"claimId": claim_id, "sender": "Recip"},
                headers=recip_headers,
            )
            assert open_res.status_code == 200

            # Missing claim header -> 403 forbidden
            res_missing_header = recip_client.get(
                f"/api/admin/server/messages/{seq}/view-once/content",
                headers=recip_headers,
            )
            assert res_missing_header.status_code == 403
            assert res_missing_header.json() == {"error": "forbidden"}

            # Invalid claim header -> 403 forbidden
            res_bad_header = recip_client.get(
                f"/api/admin/server/messages/{seq}/view-once/content",
                headers={**recip_headers, "X-Wixy-View-Claim": "short"},
            )
            assert res_bad_header.status_code == 403
            assert res_bad_header.json() == {"error": "forbidden"}

            # Wrong claim header -> 403 forbidden
            res_wrong_claim = recip_client.get(
                f"/api/admin/server/messages/{seq}/view-once/content",
                headers={**recip_headers, "X-Wixy-View-Claim": "f" * 32},
            )
            assert res_wrong_claim.status_code == 403
            assert res_wrong_claim.json() == {"error": "forbidden"}

            # Missing / unknown message seq -> 404 not_found
            res_missing_msg = recip_client.get(
                "/api/admin/server/messages/999999/view-once/content",
                headers={**recip_headers, "X-Wixy-View-Claim": claim_id},
            )
            assert res_missing_msg.status_code == 404
            assert res_missing_msg.json() == {"error": "not_found"}

            # Invalid message seq <= 0 -> 404 not_found
            res_invalid_seq = recip_client.get(
                "/api/admin/server/messages/0/view-once/content",
                headers={**recip_headers, "X-Wixy-View-Claim": claim_id},
            )
            assert res_invalid_seq.status_code == 404
            assert res_invalid_seq.json() == {"error": "not_found"}

            # Wrong user email -> 403 forbidden
            other_client, other_headers = _unlocked_client(
                storage_root, wixy_repo_root, pin_verifier, email="other@example.com"
            )
            try:
                res_wrong_email = other_client.get(
                    f"/api/admin/server/messages/{seq}/view-once/content",
                    headers={**other_headers, "X-Wixy-View-Claim": claim_id},
                )
                assert res_wrong_email.status_code == 403
                assert res_wrong_email.json() == {"error": "forbidden"}
            finally:
                other_client.__exit__(None, None, None)

            # Expired claim (> 600s) -> 410
            store: LiveChatStore = recip_client.app.state.livechat_store  # type: ignore[attr-defined]
            with store._write_txn() as conn:
                conn.execute(
                    "UPDATE messages SET view_claimed_at = ? WHERE seq = ?",
                    (time.time() - 601.0, seq),
                )
            res_expired = recip_client.get(
                f"/api/admin/server/messages/{seq}/view-once/content",
                headers={**recip_headers, "X-Wixy-View-Claim": claim_id},
            )
            assert res_expired.status_code == 410
            assert res_expired.json() == {"error": "expired"}
        finally:
            sender_client.__exit__(None, None, None)
            recip_client.__exit__(None, None, None)

    def test_broken_download_erases_nothing_and_retry_succeeds(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        sender_client, sender_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="sender@example.com"
        )
        recip_client, recip_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="recip@example.com"
        )
        try:
            att_id, original_bytes = _create_ready_photo(sender_client, sender_headers)
            paths: ProjectPaths = sender_client.app.state.paths  # type: ignore[attr-defined]
            media_file = paths.server_attachment_media_dir(att_id) / "full.jpg"
            media_file.write_bytes(b"X" * (128 * 1024))
            send_res = sender_client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-broken-dl-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=sender_headers,
            )
            seq = send_res.json()["message"]["seq"]
            claim_id = "0" * 32
            assert (
                recip_client.post(
                    f"/api/admin/server/messages/{seq}/view-once/open",
                    json={"claimId": claim_id, "sender": "Recip"},
                    headers=recip_headers,
                ).status_code
                == 200
            )

            # Simulate a broken download: read fails mid-stream with a connection reset
            orig_open_file = anyio.open_file
            should_fail = True

            class _BrokenFile:
                def __init__(self, real_file: Any) -> None:
                    self._real_file = real_file
                    self._chunks_read = 0

                async def read(self, size: int) -> bytes:
                    if should_fail and self._chunks_read >= 1:
                        raise ConnectionResetError("Connection reset by peer")
                    data = await self._real_file.read(size)
                    self._chunks_read += 1
                    return cast(bytes, data)

                async def __aenter__(self) -> _BrokenFile:
                    await self._real_file.__aenter__()
                    return self

                async def __aexit__(self, *args: Any) -> None:
                    await self._real_file.__aexit__(*args)

            async def _broken_open_file(p: Any, mode: Any = "rb") -> Any:
                real = await orig_open_file(p, mode)
                return _BrokenFile(real)

            monkeypatch.setattr(anyio, "open_file", _broken_open_file)
            try:
                recip_client.get(
                    f"/api/admin/server/messages/{seq}/view-once/content",
                    headers={**recip_headers, "X-Wixy-View-Claim": claim_id},
                )
            except Exception:
                pass
            finally:
                should_fail = False

            # Give event loop a moment
            time.sleep(0.1)

            # Assert message was NOT erased!
            store: LiveChatStore = recip_client.app.state.livechat_store  # type: ignore[attr-defined]
            assert _message_exists(store, seq), "Message should NOT be erased on broken download"

            # Full download retry succeeds!
            res_full = recip_client.get(
                f"/api/admin/server/messages/{seq}/view-once/content",
                headers={**recip_headers, "X-Wixy-View-Claim": claim_id},
            )
            assert res_full.status_code == 200
            assert len(res_full.content) > 0

            # Wait for background task erasure
            deadline = time.monotonic() + 5.0
            erased = False
            while time.monotonic() < deadline:
                if not _message_exists(store, seq):
                    erased = True
                    break
                time.sleep(0.05)
            assert erased, "Message should be erased after complete download"
        finally:
            sender_client.__exit__(None, None, None)
            recip_client.__exit__(None, None, None)

    def test_complete_download_erases_message_files_and_prevents_reopen(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        sender_client, sender_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="sender@example.com"
        )
        recip_client, recip_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="recip@example.com"
        )
        try:
            att_id, _ = _create_ready_photo(sender_client, sender_headers)
            paths: ProjectPaths = sender_client.app.state.paths  # type: ignore[attr-defined]
            full_file = paths.server_attachment_media_dir(att_id) / "full.jpg"
            expected_bytes = full_file.read_bytes()

            send_res = sender_client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-complete-dl-1",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                    "attachmentId": att_id,
                    "durationS": 2,
                    "tease": False,
                },
                headers=sender_headers,
            )
            seq = send_res.json()["message"]["seq"]
            claim_id = "1" * 32
            recip_client.post(
                f"/api/admin/server/messages/{seq}/view-once/open",
                json={"claimId": claim_id, "sender": "Recip"},
                headers=recip_headers,
            )

            # Complete download
            res = recip_client.get(
                f"/api/admin/server/messages/{seq}/view-once/content",
                headers={**recip_headers, "X-Wixy-View-Claim": claim_id},
            )
            assert res.status_code == 200
            assert res.headers["cache-control"] == "no-store"
            assert res.headers["x-content-type-options"] == "nosniff"
            assert res.content == expected_bytes

            store: LiveChatStore = recip_client.app.state.livechat_store  # type: ignore[attr-defined]
            deadline = time.monotonic() + 5.0
            erased = False
            while time.monotonic() < deadline:
                if not _message_exists(store, seq):
                    erased = True
                    break
                time.sleep(0.05)
            assert erased

            from wixy_server.livechat import janitor as livechat_janitor

            livechat_janitor.cleanup_deleted_storage_once(store=store, paths=paths)
            livechat_janitor.scrub_once(store=store, deadline_s=30.0)

            assert not paths.server_attachment_media_dir(att_id).exists()
            assert claim_id.encode("utf-8") not in _raw_db(store)

            # Second open attempt -> 404
            open_res_after = recip_client.post(
                f"/api/admin/server/messages/{seq}/view-once/open",
                json={"claimId": claim_id, "sender": "Recip"},
                headers=recip_headers,
            )
            assert open_res_after.status_code == 404

            # Second content request -> 404
            content_res_after = recip_client.get(
                f"/api/admin/server/messages/{seq}/view-once/content",
                headers={**recip_headers, "X-Wixy-View-Claim": claim_id},
            )
            assert content_res_after.status_code == 404

            # Assert message_deleted event is present in store events
            events = store.events_after(0, limit=100)
            deleted_events = [
                e for e in events if e.type == "message_deleted" and e.message_seq == seq
            ]
            assert len(deleted_events) == 1
        finally:
            sender_client.__exit__(None, None, None)
            recip_client.__exit__(None, None, None)

    def test_content_route_404_if_rendition_not_in_view_once_renditions(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        sender_client, sender_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="sender@example.com"
        )
        recip_client, recip_headers = _unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, email="recip@example.com"
        )
        try:
            store: LiveChatStore = sender_client.app.state.livechat_store  # type: ignore[attr-defined]
            att_id, _ = _create_ready_photo(sender_client, sender_headers)
            send_res = sender_client.post(
                "/api/admin/server/messages/view-once",
                json={
                    "clientId": "client-vo-no-rendition",
                    "sender": "Sender",
                    "deviceId": "dev-1234",
                    "attachmentId": att_id,
                    "durationS": 5,
                    "tease": False,
                },
                headers=sender_headers,
            )
            assert send_res.status_code == 201
            seq = send_res.json()["message"]["seq"]
            claim_id = "f" * 32
            open_res = recip_client.post(
                f"/api/admin/server/messages/{seq}/view-once/open",
                json={"claimId": claim_id, "sender": "Recip"},
                headers=recip_headers,
            )
            assert open_res.status_code == 200

            # Tamper view_once_renditions in DB so "full" is missing
            with store._write_txn() as conn:
                conn.execute(
                    "UPDATE attachments SET view_once_renditions = '[\"thumb\"]' WHERE id = ?",
                    (att_id,),
                )

            content_res = recip_client.get(
                f"/api/admin/server/messages/{seq}/view-once/content",
                headers={**recip_headers, "X-Wixy-View-Claim": claim_id},
            )
            assert content_res.status_code == 404
            assert _message_exists(store, seq)
        finally:
            sender_client.__exit__(None, None, None)
            recip_client.__exit__(None, None, None)


class TestBackstop:
    def test_backstop_loop_erases_claims_older_than_600s(
        self, tmp_path: Path, store: LiveChatStore
    ) -> None:
        store.list_messages(before=None, limit=1)
        paths = ProjectPaths(slug="test", root=tmp_path)
        paths.server_media.mkdir(parents=True, exist_ok=True)
        now = time.time()

        with store._write_txn() as conn:
            conn.execute(
                "INSERT INTO attachments "
                "(id, kind, status, mime, renditions, created_at, updated_at) "
                "VALUES ('att-backstop', 'photo', 'ready', 'image/jpeg', '[\"full\"]', ?, ?)",
                (now, now),
            )
        msg, _ = store.create_view_once_message(
            client_id="client-backstop-1",
            sender="Josh",
            device_id="dev1",
            by_email="josh@example.com",
            attachment_id="att-backstop",
            duration_s=5,
            tease=False,
            now=now,
        )

        # Claim it
        claim_id = "9" * 32
        store.claim_view_once(
            seq=msg.seq,
            claim_id=claim_id,
            email="alice@example.com",
            sender="Alice",
            now=now - 605.0,  # Claimed 605 seconds ago!
        )

        # Clean expired view-once messages
        erased_seqs = cleanup_expired_view_once_messages(store=store, paths=paths, now=now)
        assert msg.seq in erased_seqs
        assert not _message_exists(store, msg.seq)

        # Verify event was recorded
        events = store.events_after(0, limit=100)
        assert any(e.type == "message_deleted" and e.message_seq == msg.seq for e in events)

    @pytest.mark.anyio
    async def test_backstop_calls_notifier_on_event_loop_thread(
        self, tmp_path: Path, store: LiveChatStore
    ) -> None:
        loop_thread_id = threading.get_ident()
        published_thread_ids: list[int] = []

        class RecordingNotifier:
            def publish(self) -> None:
                published_thread_ids.append(threading.get_ident())

        paths = ProjectPaths(slug="test", root=tmp_path)
        paths.server_media.mkdir(parents=True, exist_ok=True)
        now = time.time()

        # 1. No expired claims -> publish NOT called
        notifier = RecordingNotifier()
        with anyio.move_on_after(0.05):
            await run_view_once_backstop_forever(
                store=store, paths=paths, notifier=cast(Any, notifier), interval_s=100.0
            )
        assert published_thread_ids == []

        # 2. Add an expired claim (>600s)
        with store._write_txn() as conn:
            conn.execute(
                "INSERT INTO attachments "
                "(id, kind, status, mime, renditions, created_at, updated_at) "
                "VALUES ('att-backstop-async', 'photo', 'ready', 'image/jpeg', '[\"full\"]', ?, ?)",
                (now, now),
            )
        msg, _ = store.create_view_once_message(
            client_id="client-backstop-async",
            sender="Josh",
            device_id="dev1",
            by_email="josh@example.com",
            attachment_id="att-backstop-async",
            duration_s=5,
            tease=False,
            now=now,
        )
        store.claim_view_once(
            seq=msg.seq,
            claim_id="8" * 32,
            email="bob@example.com",
            sender="Bob",
            now=now - 605.0,
        )

        with anyio.move_on_after(0.05):
            await run_view_once_backstop_forever(
                store=store, paths=paths, notifier=cast(Any, notifier), interval_s=100.0
            )

        assert len(published_thread_ids) == 1
        assert published_thread_ids[0] == loop_thread_id

    @pytest.mark.anyio
    async def test_run_view_once_backstop_forever_startup_pass(
        self, tmp_path: Path, store: LiveChatStore
    ) -> None:
        """Startup pass runs immediately, erases claims older than 600s,
        and preserves fresh claims."""
        published_count = 0

        class RecordingNotifier:
            def publish(self) -> None:
                nonlocal published_count
                published_count += 1

        paths = ProjectPaths(slug="test", root=tmp_path)
        paths.server_media.mkdir(parents=True, exist_ok=True)
        now = time.time()

        with store._write_txn() as conn:
            conn.execute(
                "INSERT INTO attachments "
                "(id, kind, status, mime, renditions, created_at, updated_at) "
                "VALUES ('att-backstop-exp', 'photo', 'ready', 'image/jpeg', '[\"full\"]', ?, ?)",
                (now, now),
            )
            conn.execute(
                "INSERT INTO attachments "
                "(id, kind, status, mime, renditions, created_at, updated_at) "
                "VALUES ('att-backstop-fresh', 'photo', 'ready', 'image/jpeg', '[\"full\"]', ?, ?)",
                (now, now),
            )

        msg_expired, _ = store.create_view_once_message(
            client_id="client-backstop-exp",
            sender="Josh",
            device_id="dev1",
            by_email="josh@example.com",
            attachment_id="att-backstop-exp",
            duration_s=5,
            tease=False,
            now=now,
        )
        msg_fresh, _ = store.create_view_once_message(
            client_id="client-backstop-fresh",
            sender="Josh",
            device_id="dev1",
            by_email="josh@example.com",
            attachment_id="att-backstop-fresh",
            duration_s=5,
            tease=False,
            now=now,
        )

        # Claim expired (>600s ago)
        store.claim_view_once(
            seq=msg_expired.seq,
            claim_id="e" * 32,
            email="alice@example.com",
            sender="Alice",
            now=now - 605.0,
        )
        # Claim fresh (10s ago)
        store.claim_view_once(
            seq=msg_fresh.seq,
            claim_id="f" * 32,
            email="bob@example.com",
            sender="Bob",
            now=now - 10.0,
        )

        notifier = RecordingNotifier()
        with anyio.move_on_after(0.1):
            await run_view_once_backstop_forever(
                store=store, paths=paths, notifier=cast(Any, notifier), interval_s=0.05
            )

        assert not _message_exists(store, msg_expired.seq)
        assert _message_exists(store, msg_fresh.seq)
        assert published_count >= 1
