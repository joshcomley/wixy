# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The would-you-rather game (workspace 00045): the shipped question bank, schema v15, the store's
round state machine, the viewer-filtered view (the other player's answers hidden until both
reveal), the `/wyr*` routes, on-demand image attachment, and erasure with the chat."""

from __future__ import annotations

import io
import random
import sqlite3
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from wixy_server.app import create_app
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import (
    _LATEST_SCHEMA_VERSION,
    LiveChatStore,
    WyrBadStateError,
    WyrNotPlayerError,
    WyrRoundFullError,
    WyrRoundNotFoundError,
)
from wixy_server.livechat.wyr_game import wyr_view_json
from wixy_server.livechat.wyr_images import ComfyImageGenerator, ImageGenerationError
from wixy_server.livechat.wyr_questions import (
    BANK_PATH,
    load_questions,
    pick_question,
    style_suffix,
)
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    TEST_PIN,
    UNLOCK_GUARD_HEADERS,
    _dev_no_auth,
    _form_style_json,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)

BASE = "/api/admin/server"


@pytest.fixture
def store(tmp_path: Path) -> LiveChatStore:
    return LiveChatStore(tmp_path / "server" / "server.db")


def _new_round(store: LiveChatStore, client_id: str = "wyr-client-1", sender: str = "Josh") -> int:
    message, created = store.create_wyr_round(
        client_id=client_id,
        sender=sender,
        device_id="device-1",
        by_email=None,
        question_id="q0001",
        now=10.0,
    )
    assert created is True
    return message.seq


def _vote(store: LiveChatStore, seq: int, name: str, vote: Any = "play") -> Any:
    return store.vote_wyr(
        anchor_seq=seq, voter_key=name.casefold(), voter_name=name, vote=vote, now=11.0
    )


def _to_answering(store: LiveChatStore) -> int:
    seq = _new_round(store)
    _vote(store, seq, "Rose")
    return seq


class TestBank:
    def test_the_shipped_bank_is_large_valid_and_unique(self) -> None:
        questions = load_questions(BANK_PATH)
        assert len(questions) >= 2000
        assert len({q.id for q in questions}) == len(questions)
        for q in questions:
            assert q.a.strip() and q.b.strip() and q.a.casefold() != q.b.casefold()
            assert len(q.image_a) >= 30 and len(q.image_b) >= 30
        # No two questions offer the same pair of options (in either order).
        pairs = {frozenset((q.a.casefold().strip(), q.b.casefold().strip())) for q in questions}
        assert len(pairs) == len(questions)

    def test_the_bank_spans_many_categories(self) -> None:
        categories = {q.category for q in load_questions(BANK_PATH)}
        assert len(categories) >= 8
        assert all(style_suffix(c).startswith(",") for c in categories)

    def test_a_missing_or_malformed_bank_loads_empty_instead_of_crashing(
        self, tmp_path: Path
    ) -> None:
        assert load_questions(tmp_path / "nope.json") == ()
        bad = tmp_path / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        assert load_questions(bad) == ()
        bad.write_text('{"questions": [{"id": "x"}]}', encoding="utf-8")
        assert load_questions(bad) == ()

    def test_pick_avoids_played_questions_until_the_bank_is_exhausted(self) -> None:
        questions = load_questions(BANK_PATH)[:5]
        rng = random.Random(1)
        used = {q.id for q in questions[:4]}
        for _ in range(20):
            picked = pick_question(questions, used, rng)
            assert picked is not None and picked.id == questions[4].id
        everything = {q.id for q in questions}
        assert pick_question(questions, everything, rng) is not None
        assert pick_question((), set(), rng) is None


class TestSchema:
    def test_v15_creates_the_tables_and_cascade_removes_a_round_with_its_message(
        self, store: LiveChatStore, tmp_path: Path
    ) -> None:
        seq = _new_round(store)
        assert _LATEST_SCHEMA_VERSION >= 15
        assert store.get_wyr_round(anchor_seq=seq) is not None
        assert "q0001" in store.wyr_used_ids()
        store.delete_message(seq=seq, now=20.0)
        assert store.get_wyr_round(anchor_seq=seq) is None
        conn = sqlite3.connect(str(tmp_path / "server" / "server.db"))
        try:
            assert conn.execute("SELECT COUNT(*) FROM wyr_rounds").fetchone()[0] == 0
        finally:
            conn.close()

    def test_a_v14_database_gains_the_tables(self, tmp_path: Path) -> None:
        db = tmp_path / "server" / "server.db"
        LiveChatStore(db).list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db))
        try:
            conn.execute("DROP TABLE wyr_rounds")
            conn.execute("DROP TABLE wyr_used")
            conn.execute("PRAGMA user_version = 14")
            conn.commit()
        finally:
            conn.close()
        migrated = LiveChatStore(db)
        seq = _new_round(migrated)
        assert migrated.get_wyr_round(anchor_seq=seq) is not None


class TestStateMachine:
    def test_creator_is_player_one_and_has_already_voted_play(self, store: LiveChatStore) -> None:
        seq = _new_round(store)
        round_ = store.get_wyr_round(anchor_seq=seq)
        assert round_ is not None
        assert (round_.state, round_.player1_name, round_.vote1) == ("voting", "Josh", "play")
        [message] = store.list_messages(before=None, limit=5)[0]
        assert message.wyr is not None and message.wyr.state == "voting"
        assert message.text is None and message.attachments == ()

    def test_create_is_idempotent_on_client_id(self, store: LiveChatStore) -> None:
        seq = _new_round(store)
        again, created = store.create_wyr_round(
            client_id="wyr-client-1",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            question_id="q0002",
            now=99.0,
        )
        assert created is False and again.seq == seq
        assert "q0002" not in store.wyr_used_ids()

    def test_full_happy_path_to_revealed(self, store: LiveChatStore) -> None:
        seq = _to_answering(store)
        assert store.get_wyr_round(anchor_seq=seq).state == "answering"  # type: ignore[union-attr]
        store.answer_wyr(anchor_seq=seq, player_key="josh", choice="a", guess="b", now=12.0)
        assert store.get_wyr_round(anchor_seq=seq).state == "answering"  # type: ignore[union-attr]
        store.answer_wyr(anchor_seq=seq, player_key="rose", choice="b", guess="a", now=13.0)
        assert store.get_wyr_round(anchor_seq=seq).state == "revealing"  # type: ignore[union-attr]
        store.reveal_wyr(anchor_seq=seq, player_key="josh", now=14.0)
        assert store.get_wyr_round(anchor_seq=seq).state == "revealing"  # type: ignore[union-attr]
        done, changed = store.reveal_wyr(anchor_seq=seq, player_key="rose", now=15.0)
        assert changed is True and done.state == "revealed"

    def test_any_skip_vote_skips_the_round(self, store: LiveChatStore) -> None:
        seq = _new_round(store)
        round_, _ = _vote(store, seq, "Rose", "skip")
        assert round_.state == "skipped"
        with pytest.raises(WyrBadStateError):
            _vote(store, seq, "Rose", "play")

    def test_a_third_person_cannot_join_and_a_stranger_cannot_answer(
        self, store: LiveChatStore
    ) -> None:
        seq = _to_answering(store)
        with pytest.raises(WyrBadStateError):
            _vote(store, seq, "Mallory")
        seq2 = _new_round(store, client_id="wyr-client-2")
        _vote(store, seq2, "Rose")
        with pytest.raises(WyrNotPlayerError):
            store.answer_wyr(anchor_seq=seq2, player_key="mallory", choice="a", guess="a", now=12.0)

    def test_a_third_identity_voting_on_a_full_round_is_refused(
        self, store: LiveChatStore, tmp_path: Path
    ) -> None:
        # Both slots taken while still `voting` (only reachable through a stored state, e.g. a
        # second player slotted by an earlier build): the third voter gets `WyrRoundFullError`.
        seq = _new_round(store)
        conn = sqlite3.connect(str(tmp_path / "server" / "server.db"))
        try:
            conn.execute(
                "UPDATE wyr_rounds SET player2_key = 'rose', player2_name = 'Rose' "
                "WHERE anchor_message_seq = ?",
                (seq,),
            )
            conn.commit()
        finally:
            conn.close()
        with pytest.raises(WyrRoundFullError):
            _vote(store, seq, "Mallory")

    def test_retries_are_idempotent_and_answers_lock_at_reveal(self, store: LiveChatStore) -> None:
        seq = _to_answering(store)
        first, changed = store.answer_wyr(
            anchor_seq=seq, player_key="josh", choice="a", guess="b", now=12.0
        )
        assert changed is True
        same, changed_again = store.answer_wyr(
            anchor_seq=seq, player_key="josh", choice="a", guess="b", now=12.5
        )
        assert changed_again is False and same.rev == first.rev
        store.answer_wyr(anchor_seq=seq, player_key="rose", choice="b", guess="a", now=13.0)
        with pytest.raises(WyrBadStateError):
            store.answer_wyr(anchor_seq=seq, player_key="josh", choice="b", guess="b", now=14.0)
        again, changed_reveal = store.reveal_wyr(anchor_seq=seq, player_key="josh", now=15.0)
        assert changed_reveal is True
        _, repeat = store.reveal_wyr(anchor_seq=seq, player_key="josh", now=16.0)
        assert repeat is False and again.reveal1 is True

    def test_cannot_reveal_before_both_answered(self, store: LiveChatStore) -> None:
        seq = _to_answering(store)
        with pytest.raises(WyrBadStateError):
            store.reveal_wyr(anchor_seq=seq, player_key="josh", now=12.0)

    def test_unknown_round(self, store: LiveChatStore) -> None:
        with pytest.raises(WyrRoundNotFoundError):
            _vote(store, 999, "Josh")
        assert store.get_wyr_round(anchor_seq=999) is None

    def test_starting_a_new_round_supersedes_the_open_one(self, store: LiveChatStore) -> None:
        old = _to_answering(store)
        _new_round(store, client_id="wyr-client-2")
        assert store.get_wyr_round(anchor_seq=old).state == "skipped"  # type: ignore[union-attr]

    def test_wipe_erases_rounds_and_the_played_list(self, store: LiveChatStore) -> None:
        seq = _to_answering(store)
        assert "q0001" in store.wyr_used_ids()
        store.wipe(now=30.0)
        assert store.get_wyr_round(anchor_seq=seq) is None
        assert store.wyr_used_ids() == set()


class TestViewFiltering:
    def _round(self, store: LiveChatStore, *, reveal: bool) -> Any:
        seq = _to_answering(store)
        store.answer_wyr(anchor_seq=seq, player_key="josh", choice="a", guess="b", now=12.0)
        store.answer_wyr(anchor_seq=seq, player_key="rose", choice="b", guess="a", now=13.0)
        if reveal:
            store.reveal_wyr(anchor_seq=seq, player_key="josh", now=14.0)
            store.reveal_wyr(anchor_seq=seq, player_key="rose", now=15.0)
        return store.get_wyr_round(anchor_seq=seq)

    def test_the_other_players_answers_are_hidden_until_both_reveal(
        self, store: LiveChatStore
    ) -> None:
        round_ = self._round(store, reveal=False)
        questions = load_questions(BANK_PATH)
        question = next(q for q in questions if q.id == round_.question_id)
        view = wyr_view_json(round_, question, "Josh")
        assert view["result"] is None
        assert view["you"] == {
            "slot": 1,
            "vote": "play",
            "choice": "a",
            "guess": "b",
            "revealed": False,
        }
        text = repr(view)
        assert "'choice': 'b'" not in text and "'guess': 'a'" not in text
        stranger = wyr_view_json(round_, question, "Nobody")
        assert stranger["you"] is None and stranger["result"] is None
        assert "'choice'" not in repr(stranger)

    def test_after_both_reveal_everyone_sees_the_result(self, store: LiveChatStore) -> None:
        round_ = self._round(store, reveal=True)
        question = next(q for q in load_questions(BANK_PATH) if q.id == round_.question_id)
        view = wyr_view_json(round_, question, "Rose")
        result = view["result"]
        assert result == {
            "players": [
                {"name": "Josh", "choice": "a", "guess": "b"},
                {"name": "Rose", "choice": "b", "guess": "a"},
            ],
            "guessed": [True, True],
            "agree": False,
        }


def _png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), "teal").save(buf, format="PNG")
    return buf.getvalue()


class FakeGenerator(ComfyImageGenerator):
    def __init__(self, *, up: bool = True, fail: bool = False) -> None:
        super().__init__("http://unused.invalid")
        self.up = up
        self.fail = fail
        self.calls: list[tuple[str, str]] = []

    def available(self) -> bool:
        return self.up

    def generate_pair(
        self, prompt_a: str, prompt_b: str, out_dir: Path, *, seed_a: int, seed_b: int
    ) -> tuple[Path, Path]:
        self.calls.append((prompt_a, prompt_b))
        if self.fail:
            raise ImageGenerationError("boom")
        a, b = out_dir / "a.png", out_dir / "b.png"
        a.write_bytes(_png())
        b.write_bytes(_png())
        return a, b


def _client(
    storage_root: Path,
    wixy_repo_root: Path,
    pin_verifier: CmdPinVerifier,
    generator: ComfyImageGenerator | None,
    email: str,
) -> tuple[TestClient, dict[str, str]]:
    from unittest.mock import AsyncMock

    app = create_app(
        storage_root=storage_root,
        wixy_repo_root=wixy_repo_root,
        pin_verifier=pin_verifier,
        transcriber=AsyncMock(),
        image_generator=generator,
    )
    client = TestClient(app, cookies={"CF_Authorization": "dummy"})
    client.__enter__()
    resp = client.post(
        f"{BASE}/unlock",
        content=_form_style_json(TEST_PIN),
        headers={
            **UNLOCK_GUARD_HEADERS,
            "Sec-Fetch-Site": "same-origin",
            "CF-Access-Authenticated-User-Email": email,
        },
    )
    assert resp.status_code == 200, resp.text
    return client, {
        "X-Wixy-Server-Token": resp.json()["token"],
        "CF-Access-Authenticated-User-Email": email,
    }


def _create(client: TestClient, headers: dict[str, str], cid: str, sender: str = "Josh") -> Any:
    return client.post(
        f"{BASE}/wyr",
        json={"clientId": cid, "sender": sender, "deviceId": "device-1234"},
        headers=headers,
    )


def _post(client: TestClient, headers: dict[str, str], path: str, **body: Any) -> Any:
    return client.post(f"{BASE}{path}", json=body, headers=headers)


class TestRoutes:
    def test_full_two_player_flow_hides_then_reveals(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, None, "a@example.com")
        try:
            created = _create(client, h, "wyr-route-0001")
            assert created.status_code == 201, created.text
            message = created.json()["message"]
            assert message["wyr"] == {"state": "voting", "rev": 1}
            seq = message["seq"]

            view = client.get(f"{BASE}/wyr/{seq}?as=Josh", headers=h).json()
            assert view["state"] == "voting" and view["question"]["a"] and view["question"]["b"]
            assert view["images"] is False  # no generator configured in this app
            assert view["you"]["vote"] == "play" and view["result"] is None

            voted = _post(client, h, f"/wyr/{seq}/vote", sender="Rose", vote="play")
            assert voted.status_code == 200 and voted.json()["state"] == "answering"

            mine = _post(client, h, f"/wyr/{seq}/answer", sender="Josh", choice="a", guess="b")
            assert mine.status_code == 200
            theirs = _post(client, h, f"/wyr/{seq}/answer", sender="Rose", choice="b", guess="a")
            assert theirs.json()["state"] == "revealing"
            # Before both reveal, Josh's view of the round carries none of Rose's answers.
            josh_view = client.get(f"{BASE}/wyr/{seq}?as=Josh", headers=h).json()
            assert josh_view["result"] is None
            assert josh_view["you"]["choice"] == "a"

            first = _post(client, h, f"/wyr/{seq}/reveal", sender="Josh")
            assert first.json()["state"] == "revealing" and first.json()["result"] is None
            second = _post(client, h, f"/wyr/{seq}/reveal", sender="Rose")
            body = second.json()
            assert body["state"] == "revealed"
            assert body["result"]["guessed"] == [True, True]

            history = client.get(f"{BASE}/messages?limit=10", headers=h).json()["messages"]
            [round_message] = [m for m in history if m["wyr"] is not None]
            assert round_message["wyr"]["state"] == "revealed"
        finally:
            client.__exit__(None, None, None)

    def test_errors_and_validation(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, None, "a@example.com")
        try:
            assert _create(client, h, "short").status_code == 422
            assert _create(client, h, "wyr-route-0002", sender="  ").status_code == 422
            seq = _create(client, h, "wyr-route-0003").json()["message"]["seq"]
            assert client.get(f"{BASE}/wyr/99999?as=Josh", headers=h).status_code == 404
            assert (
                _post(client, h, "/wyr/99999/vote", sender="Rose", vote="play").status_code == 404
            )
            assert (
                _post(client, h, f"/wyr/{seq}/vote", sender="Rose", vote="maybe").status_code == 422
            )
            early = _post(client, h, f"/wyr/{seq}/answer", sender="Josh", choice="a", guess="a")
            assert early.status_code == 409 and early.json() == {"error": "bad_state"}
            _post(client, h, f"/wyr/{seq}/vote", sender="Rose", vote="play")
            stranger = _post(client, h, f"/wyr/{seq}/answer", sender="Eve", choice="a", guess="a")
            assert stranger.status_code == 409 and stranger.json() == {"error": "not_player"}
            third = _post(client, h, f"/wyr/{seq}/vote", sender="Eve", vote="play")
            assert third.status_code == 409
            assert third.json()["error"] in ("bad_state", "full")
        finally:
            client.__exit__(None, None, None)

    def test_requires_a_token(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _h = _client(storage_root, wixy_repo_root, pin_verifier, None, "a@example.com")
        try:
            body = {"clientId": "wyr-route-0009", "sender": "Josh", "deviceId": "device-1234"}
            assert client.post(f"{BASE}/wyr", json=body).status_code in (401, 403)
            assert client.get(f"{BASE}/wyr/1?as=Josh").status_code in (401, 403)
        finally:
            client.__exit__(None, None, None)

    def test_images_are_painted_on_demand_and_attached_in_order(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        generator = FakeGenerator()
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, generator, "a@example.com")
        try:
            created = _create(client, h, "wyr-route-0010")
            assert created.status_code == 201
            # Nothing was painted ahead of time: the round starts with no pictures.
            assert created.json()["message"]["attachments"] == []
            seq = created.json()["message"]["seq"]
            deadline = time.time() + 15
            attachments: list[dict[str, Any]] = []
            while time.time() < deadline:
                history = client.get(f"{BASE}/messages?limit=10", headers=h).json()["messages"]
                [row] = [m for m in history if m["seq"] == seq]
                attachments = row["attachments"]
                if len(attachments) == 2:
                    break
                time.sleep(0.1)
            assert len(attachments) == 2
            assert len(generator.calls) == 1
            prompt_a, prompt_b = generator.calls[0]
            view = client.get(f"{BASE}/wyr/{seq}?as=Josh", headers=h).json()
            assert view["images"] is True
            assert view["question"]["id"]
            assert prompt_a.endswith(style_suffix(view["question"]["category"]))
            assert prompt_a != prompt_b
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize("mode", ["down", "fails"])
    def test_a_missing_or_failing_generator_leaves_a_text_only_round(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        mode: str,
    ) -> None:
        generator = FakeGenerator(up=(mode != "down"), fail=(mode == "fails"))
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, generator, "a@example.com")
        try:
            created = _create(client, h, "wyr-route-0011")
            assert created.status_code == 201
            seq = created.json()["message"]["seq"]
            time.sleep(1.0)
            history = client.get(f"{BASE}/messages?limit=10", headers=h).json()["messages"]
            [row] = [m for m in history if m["seq"] == seq]
            assert row["attachments"] == []
            play = _post(client, h, f"/wyr/{seq}/vote", sender="Rose", vote="play")
            assert play.json()["state"] == "answering"
        finally:
            client.__exit__(None, None, None)

    def test_deleting_the_message_erases_the_round_and_its_pictures(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, h = _client(
            storage_root, wixy_repo_root, pin_verifier, FakeGenerator(), "a@example.com"
        )
        try:
            seq = _create(client, h, "wyr-route-0012").json()["message"]["seq"]
            deadline = time.time() + 15
            while time.time() < deadline:
                rows = client.get(f"{BASE}/messages?limit=10", headers=h).json()["messages"]
                [row] = [m for m in rows if m["seq"] == seq]
                if len(row["attachments"]) == 2:
                    break
                time.sleep(0.1)
            assert len(row["attachments"]) == 2
            gone = client.delete(f"{BASE}/messages/{seq}", headers=h)
            assert gone.status_code in (200, 202, 204)
            assert client.get(f"{BASE}/wyr/{seq}?as=Josh", headers=h).status_code == 404
        finally:
            client.__exit__(None, None, None)
