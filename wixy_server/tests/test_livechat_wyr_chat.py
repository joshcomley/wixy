# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The would-you-rather game chat (schema v16): a message sent from inside a round's game tab is an
ordinary message in the main chat plus a `wyr_chat` association naming the round. Store behaviour,
erasure (message delete, anchor delete, wipe), the v15 -> v16 migration, the `wyrSeq` request field
and the `wyrRef` wire field."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from wixy_server.livechat.models import message_json
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import (
    _LATEST_SCHEMA_VERSION,
    LiveChatStore,
    WyrRoundNotFoundError,
)
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)
from wixy_server.tests.test_livechat_wyr import (  # noqa: F401 - fixtures/helpers re-exported
    BASE,
    _client,
    _create,
    _pool_off_by_default,
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


def _round(store: LiveChatStore, client_id: str = "wyr-chat-round-1") -> int:
    message, _ = store.create_wyr_round(
        images_pending=False,
        client_id=client_id,
        sender="Josh",
        device_id="device-1",
        by_email=None,
        question_id="q0001",
        now=10.0,
    )
    return message.seq


def _say(store: LiveChatStore, client_id: str, anchor: int | None, text: str = "hi") -> Any:
    return store.create_message(
        client_id=client_id,
        sender="Rose",
        device_id="device-2",
        by_email=None,
        text=text,
        attachment_ids=[],
        wyr_anchor_seq=anchor,
        now=20.0,
    )


def _count(db_path: Path, table: str) -> int:
    conn = sqlite3.connect(str(db_path))
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    finally:
        conn.close()


class TestStore:
    def test_a_game_chat_message_is_ordinary_plus_its_round(self, store: LiveChatStore) -> None:
        anchor = _round(store)
        sent, created = _say(store, "game-msg-0001", anchor)
        assert created is True
        assert sent.wyr_ref == anchor
        assert sent.text == "hi" and sent.wyr is None
        assert message_json(sent, _Signer())["wyrRef"] == anchor

        ordinary, _ = _say(store, "plain-msg-0001", None)
        assert ordinary.wyr_ref is None
        assert message_json(ordinary, _Signer())["wyrRef"] is None

        listed, _more, _cursor = store.list_messages(before=None, limit=10)
        assert {m.seq: m.wyr_ref for m in listed} == {
            anchor: None,
            sent.seq: anchor,
            ordinary.seq: None,
        }
        assert [m.wyr_ref for m in store.get_messages([sent.seq, ordinary.seq])] == [anchor, None]

    def test_the_anchor_message_itself_is_not_game_chat(self, store: LiveChatStore) -> None:
        anchor = _round(store)
        [row] = store.get_messages([anchor])
        assert row.wyr is not None and row.wyr_ref is None

    def test_replay_is_idempotent_and_keeps_the_association(self, store: LiveChatStore) -> None:
        anchor = _round(store)
        first, created = _say(store, "game-msg-replay", anchor)
        again, created_again = _say(store, "game-msg-replay", anchor)
        assert created is True and created_again is False
        assert again.seq == first.seq and again.wyr_ref == anchor

    def test_an_unknown_round_is_refused_and_creates_nothing(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        with pytest.raises(WyrRoundNotFoundError):
            _say(store, "game-msg-nowhere", 999)
        assert _count(db_path, "messages") == 0
        assert _count(db_path, "wyr_chat") == 0

    def test_an_ordinary_message_is_not_a_round_anchor(self, store: LiveChatStore) -> None:
        plain, _ = _say(store, "plain-anchor-1", None)
        with pytest.raises(WyrRoundNotFoundError):
            _say(store, "game-msg-plain", plain.seq)

    def test_a_skipped_round_still_has_a_chat(self, store: LiveChatStore) -> None:
        anchor = _round(store)
        store.vote_wyr(
            voter_email=None,
            anchor_seq=anchor,
            voter_key="rose",
            voter_name="Rose",
            vote="skip",
            now=11.0,
        )
        assert _say(store, "game-msg-skipped", anchor)[0].wyr_ref == anchor

    def test_deleting_a_message_removes_its_association(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        anchor = _round(store)
        sent, _ = _say(store, "game-msg-del-1", anchor)
        _say(store, "game-msg-del-2", anchor)
        assert _count(db_path, "wyr_chat") == 2
        store.delete_message(seq=sent.seq, now=30.0)
        assert _count(db_path, "wyr_chat") == 1

    def test_deleting_the_round_keeps_the_messages_in_the_main_chat(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        anchor = _round(store)
        sent, _ = _say(store, "game-msg-keep-1", anchor)
        store.delete_message(seq=anchor, now=30.0)
        assert _count(db_path, "wyr_chat") == 0
        [survivor] = store.get_messages([sent.seq])
        assert survivor.text == "hi" and survivor.wyr_ref is None

    def test_wipe_erases_the_associations(self, store: LiveChatStore, db_path: Path) -> None:
        anchor = _round(store)
        _say(store, "game-msg-wipe-1", anchor)
        store.wipe(now=40.0)
        assert _count(db_path, "wyr_chat") == 0
        assert _count(db_path, "messages") == 0


class TestMigration:
    def _make_v15(self, db_path: Path) -> int:
        """A real v15 database: everything but the v16 objects, with a round and a message."""
        store = LiveChatStore(db_path)
        anchor = _round(store)
        _say(store, "old-message-0001", None)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("DROP INDEX idx_wyr_chat_anchor")
            conn.execute("DROP TABLE wyr_chat")
            conn.execute("PRAGMA user_version = 15")
            conn.commit()
        finally:
            conn.close()
        return anchor

    def test_a_v15_database_gains_the_table_and_keeps_everything(self, db_path: Path) -> None:
        anchor = self._make_v15(db_path)
        migrated = LiveChatStore(db_path)
        migrated.list_messages(before=None, limit=1)  # the schema is brought up on first use
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == _LATEST_SCHEMA_VERSION
            assert _LATEST_SCHEMA_VERSION >= 16
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
            assert {"wyr_chat", "idx_wyr_chat_anchor", "wyr_rounds"} <= tables
        finally:
            conn.close()
        rows = migrated.list_messages(before=None, limit=10)[0]
        assert len(rows) == 2 and all(m.wyr_ref is None for m in rows)
        assert migrated.get_wyr_round(anchor_seq=anchor) is not None
        assert _say(migrated, "new-game-msg-01", anchor)[0].wyr_ref == anchor

    def test_migration_is_idempotent(self, db_path: Path) -> None:
        self._make_v15(db_path)
        LiveChatStore(db_path)
        again = LiveChatStore(db_path)  # a second open must be a clean no-op
        assert len(again.list_messages(before=None, limit=10)[0]) == 2

    def test_v15_tables_are_untouched_by_v16(self, db_path: Path) -> None:
        self._make_v15(db_path)

        def columns() -> list[str]:
            conn = sqlite3.connect(str(db_path))
            try:
                return [r[1] for r in conn.execute("PRAGMA table_info(wyr_rounds)")]
            finally:
                conn.close()

        before = columns()
        LiveChatStore(db_path)
        assert columns() == before


class TestRoutes:
    def _send(self, client: Any, headers: dict[str, str], cid: str, **extra: Any) -> Any:
        body = {"clientId": cid, "sender": "Rose", "deviceId": "device-1234", "text": "hello"}
        body.update(extra)
        return client.post(f"{BASE}/messages", json=body, headers=headers)

    def test_wyr_seq_marks_the_message_and_it_stays_in_the_main_chat(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, None, "a@example.com")
        try:
            seq = _create(client, h, "wyr-chat-route-1").json()["message"]["seq"]
            sent = self._send(client, h, "game-chat-route-1", wyrSeq=seq)
            assert sent.status_code == 201, sent.text
            assert sent.json()["message"]["wyrRef"] == seq

            replay = self._send(client, h, "game-chat-route-1", wyrSeq=seq)
            assert replay.status_code == 200
            assert replay.json()["message"]["seq"] == sent.json()["message"]["seq"]

            plain = self._send(client, h, "plain-chat-route-1")
            assert plain.status_code == 201 and plain.json()["message"]["wyrRef"] is None

            history = client.get(f"{BASE}/messages?limit=20", headers=h).json()["messages"]
            assert all("wyrRef" in m for m in history)
            refs = {m["seq"]: m["wyrRef"] for m in history}
            assert refs[sent.json()["message"]["seq"]] == seq
            assert refs[plain.json()["message"]["seq"]] is None
            assert refs[seq] is None  # the round's own message is not game chat
        finally:
            client.__exit__(None, None, None)

    def test_an_unknown_round_is_404_and_bad_shapes_are_422(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, None, "a@example.com")
        try:
            missing = self._send(client, h, "game-chat-route-2", wyrSeq=99999)
            assert missing.status_code == 404 and missing.json() == {"error": "not_found"}
            history = client.get(f"{BASE}/messages?limit=20", headers=h).json()["messages"]
            assert history == []  # nothing was created
            bad_values: list[Any] = [0, -1, True, "7", 2**63, 1.5, []]
            for bad in bad_values:
                response = self._send(client, h, "game-chat-route-3", wyrSeq=bad)
                assert response.status_code == 422, (bad, response.text)
                assert response.json()["error"] == "invalid"
        finally:
            client.__exit__(None, None, None)

    def test_game_chat_needs_a_token(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _h = _client(storage_root, wixy_repo_root, pin_verifier, None, "a@example.com")
        try:
            body = {
                "clientId": "game-chat-route-4",
                "sender": "Rose",
                "deviceId": "device-1234",
                "text": "x",
                "wyrSeq": 1,
            }
            assert client.post(f"{BASE}/messages", json=body).status_code in (401, 403)
        finally:
            client.__exit__(None, None, None)

    def test_deleting_the_round_over_the_route_leaves_the_messages(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, None, "a@example.com")
        try:
            seq = _create(client, h, "wyr-chat-route-5").json()["message"]["seq"]
            sent = self._send(client, h, "game-chat-route-5", wyrSeq=seq).json()["message"]
            assert client.delete(f"{BASE}/messages/{seq}", headers=h).status_code in (200, 202, 204)
            history = client.get(f"{BASE}/messages?limit=20", headers=h).json()["messages"]
            [left] = [m for m in history if m["seq"] == sent["seq"]]
            assert left["wyrRef"] is None and left["text"] == "hello"
        finally:
            client.__exit__(None, None, None)
