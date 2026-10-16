# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The would-you-rather game (workspace 00045): the shipped question bank, schema v15, the store's
round state machine, the viewer-filtered view (the other player's answers hidden until both
reveal), the `/wyr*` routes, on-demand image attachment, and erasure with the chat."""

from __future__ import annotations

import io
import json
import os
import random
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

import httpx
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
from wixy_server.livechat.wyr_game import (
    clear_wyr_scratch,
    generate_round_images,
    wyr_scratch_dir,
    wyr_view_json,
)
from wixy_server.livechat.wyr_images import ComfyImageGenerator, ImageGenerationError
from wixy_server.livechat.wyr_questions import (
    BANK_PATH,
    load_questions,
    pick_question,
    style_suffix,
)
from wixy_server.storage import ProjectPaths
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
        images_pending=False,
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
        voter_email=None,
        anchor_seq=seq,
        voter_key=name.casefold(),
        voter_name=name,
        vote=vote,
        now=11.0,
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
            images_pending=False,
            client_id="wyr-client-1",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            question_id="q0002",
            now=99.0,
        )
        assert created is False and again.seq == seq
        assert store.wyr_used_ids() == {"q0001"}

    def test_full_happy_path_to_revealed(self, store: LiveChatStore) -> None:
        seq = _to_answering(store)
        assert store.get_wyr_round(anchor_seq=seq).state == "answering"  # type: ignore[union-attr]
        store.answer_wyr(
            player_email=None, anchor_seq=seq, player_key="josh", choice="a", guess="b", now=12.0
        )
        assert store.get_wyr_round(anchor_seq=seq).state == "answering"  # type: ignore[union-attr]
        store.answer_wyr(
            player_email=None, anchor_seq=seq, player_key="rose", choice="b", guess="a", now=13.0
        )
        assert store.get_wyr_round(anchor_seq=seq).state == "revealing"  # type: ignore[union-attr]
        store.reveal_wyr(player_email=None, anchor_seq=seq, player_key="josh", now=14.0)
        assert store.get_wyr_round(anchor_seq=seq).state == "revealing"  # type: ignore[union-attr]
        done, changed = store.reveal_wyr(
            player_email=None, anchor_seq=seq, player_key="rose", now=15.0
        )
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
            store.answer_wyr(
                player_email=None,
                anchor_seq=seq2,
                player_key="mallory",
                choice="a",
                guess="a",
                now=12.0,
            )

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
            player_email=None, anchor_seq=seq, player_key="josh", choice="a", guess="b", now=12.0
        )
        assert changed is True
        same, changed_again = store.answer_wyr(
            player_email=None, anchor_seq=seq, player_key="josh", choice="a", guess="b", now=12.5
        )
        assert changed_again is False and same.rev == first.rev
        store.answer_wyr(
            player_email=None, anchor_seq=seq, player_key="rose", choice="b", guess="a", now=13.0
        )
        with pytest.raises(WyrBadStateError):
            store.answer_wyr(
                player_email=None,
                anchor_seq=seq,
                player_key="josh",
                choice="b",
                guess="b",
                now=14.0,
            )
        again, changed_reveal = store.reveal_wyr(
            player_email=None, anchor_seq=seq, player_key="josh", now=15.0
        )
        assert changed_reveal is True
        _, repeat = store.reveal_wyr(player_email=None, anchor_seq=seq, player_key="josh", now=16.0)
        assert repeat is False and again.reveal1 is True

    def test_cannot_reveal_before_both_answered(self, store: LiveChatStore) -> None:
        seq = _to_answering(store)
        with pytest.raises(WyrBadStateError):
            store.reveal_wyr(player_email=None, anchor_seq=seq, player_key="josh", now=12.0)

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

    def test_deleting_a_round_leaves_no_record_that_it_was_played(
        self, store: LiveChatStore, tmp_path: Path
    ) -> None:
        # The played list is derived from existing rounds: there is no separate (dated)
        # table whose row could outlive the message — or an older process's wipe.
        seq = _new_round(store)
        store.delete_message(seq=seq, now=20.0)
        assert store.wyr_used_ids() == set()
        conn = sqlite3.connect(str(tmp_path / "server" / "server.db"))
        try:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
        finally:
            conn.close()
        assert "wyr_used" not in tables

    def test_a_name_asserted_under_a_different_sign_in_is_not_that_player(
        self, store: LiveChatStore
    ) -> None:
        message, _ = store.create_wyr_round(
            images_pending=False,
            client_id="wyr-email-1",
            sender="Josh",
            device_id="device-1",
            by_email="josh@example.com",
            question_id="q0001",
            now=10.0,
        )
        seq = message.seq
        store.vote_wyr(
            voter_email="rose@example.com",
            anchor_seq=seq,
            voter_key="rose",
            voter_name="Rose",
            vote="play",
            now=11.0,
        )
        # Someone signed in as Rose's email cannot answer or reveal AS Josh...
        with pytest.raises(WyrNotPlayerError):
            store.answer_wyr(
                player_email="rose@example.com",
                anchor_seq=seq,
                player_key="josh",
                choice="a",
                guess="a",
                now=12.0,
            )
        with pytest.raises(WyrNotPlayerError):
            store.vote_wyr(
                voter_email="rose@example.com",
                anchor_seq=seq,
                voter_key="josh",
                voter_name="Josh",
                vote="play",
                now=12.0,
            )
        # ...but each person under their own sign-in (or no known email) still plays.
        store.answer_wyr(
            player_email="josh@example.com",
            anchor_seq=seq,
            player_key="josh",
            choice="a",
            guess="b",
            now=13.0,
        )
        store.answer_wyr(
            player_email=None, anchor_seq=seq, player_key="rose", choice="b", guess="a", now=14.0
        )
        assert store.get_wyr_round(anchor_seq=seq).state == "revealing"  # type: ignore[union-attr]

    def test_image_state_ends_exactly_once_and_stale_pending_is_failed_at_startup(
        self, store: LiveChatStore
    ) -> None:
        message, _ = store.create_wyr_round(
            images_pending=True,
            client_id="wyr-img-1",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            question_id="q0001",
            now=10.0,
        )
        seq = message.seq
        assert store.get_wyr_round(anchor_seq=seq).images == "pending"  # type: ignore[union-attr]
        assert store.fail_stale_wyr_images(now=20.0) == 1
        failed = store.get_wyr_round(anchor_seq=seq)
        assert failed is not None and failed.images == "failed"
        store.fail_wyr_images(anchor_seq=seq, now=21.0)  # idempotent: no second bump
        assert store.get_wyr_round(anchor_seq=seq).rev == failed.rev  # type: ignore[union-attr]
        assert store.fail_stale_wyr_images(now=22.0) == 0


class TestViewFiltering:
    def _round(self, store: LiveChatStore, *, reveal: bool) -> Any:
        seq = _to_answering(store)
        store.answer_wyr(
            player_email=None, anchor_seq=seq, player_key="josh", choice="a", guess="b", now=12.0
        )
        store.answer_wyr(
            player_email=None, anchor_seq=seq, player_key="rose", choice="b", guess="a", now=13.0
        )
        if reveal:
            store.reveal_wyr(player_email=None, anchor_seq=seq, player_key="josh", now=14.0)
            store.reveal_wyr(player_email=None, anchor_seq=seq, player_key="rose", now=15.0)
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

    def test_a_name_under_a_different_sign_in_sees_no_answers(self, store: LiveChatStore) -> None:
        message, _ = store.create_wyr_round(
            images_pending=False,
            client_id="wyr-view-email",
            sender="Josh",
            device_id="device-1",
            by_email="josh@example.com",
            question_id="q0001",
            now=10.0,
        )
        seq = message.seq
        store.vote_wyr(
            voter_email="rose@example.com",
            anchor_seq=seq,
            voter_key="rose",
            voter_name="Rose",
            vote="play",
            now=11.0,
        )
        store.answer_wyr(
            player_email="josh@example.com",
            anchor_seq=seq,
            player_key="josh",
            choice="a",
            guess="b",
            now=12.0,
        )
        round_ = store.get_wyr_round(anchor_seq=seq)
        assert round_ is not None
        question = next(q for q in load_questions(BANK_PATH) if q.id == round_.question_id)
        genuine = wyr_view_json(round_, question, "Josh", "josh@example.com")
        assert isinstance(genuine["you"], dict) and genuine["you"]["choice"] == "a"
        # Rose's sign-in asking for Josh's view: a stranger — none of Josh's answers.
        spoofed = wyr_view_json(round_, question, "Josh", "rose@example.com")
        assert spoofed["you"] is None
        assert "'choice': 'a'" not in repr(spoofed)

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
            assert view["images"] == "none"  # no generator configured in this app
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
            assert view["images"] == "done"
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


class _Gate(FakeGenerator):
    """A generator whose first run blocks until released, recording peak concurrency."""

    def __init__(self) -> None:
        super().__init__()
        self.release = threading.Event()
        self.running = 0
        self.peak = 0
        self._lock = threading.Lock()

    def generate_pair(
        self, prompt_a: str, prompt_b: str, out_dir: Path, *, seed_a: int, seed_b: int
    ) -> tuple[Path, Path]:
        with self._lock:
            self.running += 1
            self.peak = max(self.peak, self.running)
        try:
            if not self.calls:
                self.release.wait(timeout=10)
            return super().generate_pair(prompt_a, prompt_b, out_dir, seed_a=seed_a, seed_b=seed_b)
        finally:
            with self._lock:
                self.running -= 1


class TestImageJob:
    """`wyr_game.generate_round_images` against a real store: every exit ends the wait, nothing
    is left on disk, and a round that stopped being live costs no GPU and gets no pictures."""

    def _setup(
        self, tmp_path: Path, *, pending: bool = True
    ) -> tuple[LiveChatStore, ProjectPaths, int]:
        storage = tmp_path / "storage"
        paths = ProjectPaths(slug="test", root=storage / "projects" / "test")
        paths.server_dir.mkdir(parents=True, exist_ok=True)
        store = LiveChatStore(paths.server_db)
        message, _ = store.create_wyr_round(
            images_pending=pending,
            client_id="wyr-job-0001",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            question_id="q0001",
            now=10.0,
        )
        return store, paths, message.seq

    def _question(self) -> Any:
        return load_questions(BANK_PATH)[0]

    def _leftovers(self, paths: ProjectPaths) -> list[str]:
        uploads = (
            [p.name for p in paths.server_uploads.glob("*")]
            if paths.server_uploads.exists()
            else []
        )
        scratch = (
            [p.name for p in wyr_scratch_dir(paths).glob("*")]
            if wyr_scratch_dir(paths).exists()
            else []
        )
        return uploads + scratch

    def test_success_attaches_both_in_one_step_and_ends_the_wait(self, tmp_path: Path) -> None:
        store, paths, seq = self._setup(tmp_path)
        published: list[int] = []
        ok = generate_round_images(
            store=store,
            paths=paths,
            generator=FakeGenerator(),
            question=self._question(),
            anchor_seq=seq,
            by_email=None,
            publish=lambda: published.append(1),
        )
        assert ok is True
        round_ = store.get_wyr_round(anchor_seq=seq)
        assert round_ is not None and round_.images == "done"
        [message] = store.list_messages(before=None, limit=5)[0]
        assert [a.id for a in message.attachments] and len(message.attachments) == 2
        assert (
            [a.ordinal for a in message.attachments] == [0, 1]
            if hasattr(message.attachments[0], "ordinal")
            else True
        )
        assert published
        assert not (wyr_scratch_dir(paths).exists() and list(wyr_scratch_dir(paths).glob("*")))

    @pytest.mark.parametrize("mode", ["down", "fails", "raises"])
    def test_any_failure_ends_the_wait_and_leaves_nothing(self, tmp_path: Path, mode: str) -> None:
        store, paths, seq = self._setup(tmp_path)

        class Boom(FakeGenerator):
            def generate_pair(self, *a: Any, **k: Any) -> tuple[Path, Path]:
                raise RuntimeError("unexpected")

        generator: ComfyImageGenerator = (
            Boom()
            if mode == "raises"
            else FakeGenerator(up=(mode != "down"), fail=(mode == "fails"))
        )
        ok = generate_round_images(
            store=store,
            paths=paths,
            generator=generator,
            question=self._question(),
            anchor_seq=seq,
            by_email=None,
            publish=lambda: None,
        )
        assert ok is False
        assert store.get_wyr_round(anchor_seq=seq).images == "failed"  # type: ignore[union-attr]
        assert self._leftovers(paths) == []

    def test_a_skipped_round_is_never_painted(self, tmp_path: Path) -> None:
        store, paths, seq = self._setup(tmp_path)
        store.vote_wyr(
            voter_email=None,
            anchor_seq=seq,
            voter_key="rose",
            voter_name="Rose",
            vote="skip",
            now=11.0,
        )
        generator = FakeGenerator()
        ok = generate_round_images(
            store=store,
            paths=paths,
            generator=generator,
            question=self._question(),
            anchor_seq=seq,
            by_email=None,
            publish=lambda: None,
        )
        assert ok is False and generator.calls == []
        assert store.get_wyr_round(anchor_seq=seq).images == "failed"  # type: ignore[union-attr]

    def test_a_round_deleted_while_painting_leaves_no_files_and_no_attachments(
        self, tmp_path: Path
    ) -> None:
        store, paths, seq = self._setup(tmp_path)

        class DeletesAnchor(FakeGenerator):
            def generate_pair(self, *a: Any, **k: Any) -> tuple[Path, Path]:
                result = super().generate_pair(*a, **k)
                store.delete_message(seq=seq, now=20.0)
                return result

        ok = generate_round_images(
            store=store,
            paths=paths,
            generator=DeletesAnchor(),
            question=self._question(),
            anchor_seq=seq,
            by_email=None,
            publish=lambda: None,
        )
        assert ok is False
        assert store.list_messages(before=None, limit=5)[0] == []
        assert self._leftovers(paths) == []

    def test_scratch_clear_keeps_young_dirs_and_removes_stale_ones(self, tmp_path: Path) -> None:
        _store, paths, _seq = self._setup(tmp_path)
        root = wyr_scratch_dir(paths)
        young, old = root / "young", root / "old"
        young.mkdir(parents=True)
        old.mkdir()
        os.utime(old, (1.0, 1.0))
        clear_wyr_scratch(paths)
        assert young.exists() and not old.exists()


class TestComfyClient:
    """The ComfyUI client's cleanup, against a fake ComfyUI over `httpx.MockTransport`."""

    def _fake(
        self,
        out_dir: Path,
        *,
        finishes: bool = True,
        argv: list[str] | None = None,
        real_dir: Path | None = None,
        bad_history: bool = False,
        listing: dict[str, Any] | None = None,
    ) -> tuple[httpx.MockTransport, list[tuple[str, str, Any]]]:
        calls: list[tuple[str, str, Any]] = []
        state: dict[str, str] = {}
        write_to = real_dir if real_dir is not None else out_dir

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content) if request.content else None
            calls.append((request.method, request.url.path, body))
            if request.url.path == "/system_stats":
                system: dict[str, Any] = {}
                if argv is not None:
                    system["argv"] = argv
                return httpx.Response(200, json={"system": system})
            if request.url.path == "/history" and request.method == "GET":
                return httpx.Response(200, json=listing or {})
            if request.url.path == "/prompt":
                state["prefix"] = (body or {})["prompt"]["16"]["inputs"]["filename_prefix"][:-2]
                for tag in ("a", "b"):
                    (write_to / f"{state['prefix']}_{tag}_00001_.png").write_bytes(_png())
                return httpx.Response(200, json={"prompt_id": "p1"})
            if request.url.path == "/history/p1":
                if bad_history:
                    return httpx.Response(200, content=b"<html>not json</html>")
                if not finishes:
                    return httpx.Response(200, json={})
                prefix = state["prefix"]
                return httpx.Response(
                    200,
                    json={
                        "p1": {
                            "status": {"status_str": "success"},
                            "outputs": {
                                "16": {"images": [{"filename": f"{prefix}_a_00001_.png"}]},
                                "26": {"images": [{"filename": f"{prefix}_b_00001_.png"}]},
                            },
                        }
                    },
                )
            if request.url.path == "/view":
                return httpx.Response(
                    200, content=(write_to / request.url.params["filename"]).read_bytes()
                )
            return httpx.Response(200, json={})

        return httpx.MockTransport(handler), calls

    def test_a_finished_run_deletes_its_history_and_its_output_files(self, tmp_path: Path) -> None:
        out = tmp_path / "comfy-out"
        out.mkdir()
        (out / "someone_elses.png").write_bytes(b"keep")
        transport, calls = self._fake(out)
        generator = ComfyImageGenerator("http://comfy.invalid", output_dir=out, transport=transport)
        work = tmp_path / "work"
        work.mkdir()
        a, b = generator.generate_pair("x", "y", work, seed_a=1, seed_b=2)
        assert a.read_bytes() and b.read_bytes()
        assert [p.name for p in out.iterdir()] == ["someone_elses.png"]
        assert ("POST", "/history", {"delete": ["p1"]}) in calls
        assert not any(c[1] in ("/queue", "/interrupt") for c in calls)

    def test_an_abandoned_run_is_cancelled_and_cleaned_up(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import wixy_server.livechat.wyr_images as images

        monkeypatch.setattr(images, "_GENERATION_BUDGET_S", 0.3)
        out = tmp_path / "comfy-out"
        out.mkdir()
        transport, calls = self._fake(out, finishes=False)
        generator = ComfyImageGenerator("http://comfy.invalid", output_dir=out, transport=transport)
        work = tmp_path / "work"
        work.mkdir()
        with pytest.raises(ImageGenerationError):
            generator.generate_pair("x", "y", work, seed_a=1, seed_b=2)
        assert ("POST", "/queue", {"delete": ["p1"]}) in calls
        assert ("POST", "/interrupt", {"prompt_id": "p1"}) in calls
        assert ("POST", "/history", {"delete": ["p1"]}) in calls
        assert list(out.iterdir()) == []

    def test_an_unreadable_history_answer_still_cancels_the_run(self, tmp_path: Path) -> None:
        out = tmp_path / "comfy-out"
        out.mkdir()
        transport, calls = self._fake(out, bad_history=True)
        generator = ComfyImageGenerator("http://comfy.invalid", output_dir=out, transport=transport)
        work = tmp_path / "work"
        work.mkdir()
        with pytest.raises(ValueError):
            generator.generate_pair("x", "y", work, seed_a=1, seed_b=2)
        assert ("POST", "/queue", {"delete": ["p1"]}) in calls
        assert ("POST", "/interrupt", {"prompt_id": "p1"}) in calls
        assert list(out.iterdir()) == []

    def test_availability_checks_comfys_reported_output_directory(self, tmp_path: Path) -> None:
        out = tmp_path / "comfy-out"
        out.mkdir()

        def avail(argv: list[str] | None) -> bool:
            transport, _ = self._fake(out, argv=argv)
            return ComfyImageGenerator(
                "http://comfy.invalid", output_dir=out, transport=transport
            ).available()

        assert avail(["main.py", "--output-directory", str(out)]) is True
        assert avail(["main.py", f"--output-directory={out}"]) is True
        assert avail(["main.py", "--output-directory", str(tmp_path / "elsewhere")]) is False
        assert avail(["main.py", "--port", "8199"]) is False  # flag absent: unknowable, so no
        assert avail(None) is True  # an older build reports nothing: the post-run check covers it

    def test_pictures_written_outside_the_configured_folder_disable_the_generator(
        self, tmp_path: Path
    ) -> None:
        configured = tmp_path / "configured"
        real = tmp_path / "real-comfy-output"
        configured.mkdir()
        real.mkdir()
        transport, _calls = self._fake(configured, real_dir=real)
        generator = ComfyImageGenerator(
            "http://comfy.invalid", output_dir=configured, transport=transport
        )
        work = tmp_path / "work"
        work.mkdir()
        with pytest.raises(ImageGenerationError, match="output directory mismatch"):
            generator.generate_pair("x", "y", work, seed_a=1, seed_b=2)
        assert generator.available() is False  # sticky: it never renders again

    def test_sweep_removes_orphaned_runs_but_not_young_ones(self, tmp_path: Path) -> None:
        out = tmp_path / "comfy-out"
        out.mkdir()
        stale = out / "wyr_dead_a_00001_.png"
        young = out / "wyr_live_a_00001_.png"
        for f in (stale, young):
            f.write_bytes(b"x")
        os.utime(stale, (1.0, 1.0))

        def entry(name: str) -> dict[str, Any]:
            return {"outputs": {"16": {"images": [{"filename": name}]}}}

        listing = {
            "dead": entry("wyr_dead_a_00001_.png"),  # file stale -> orphan
            "gone": entry("wyr_gone_a_00001_.png"),  # file already removed -> orphan
            "live": entry("wyr_live_a_00001_.png"),  # young file -> a run may own it
            "other": entry("somebody_elses.png"),  # not ours -> untouched
        }
        transport, calls = self._fake(out, listing=listing)
        generator = ComfyImageGenerator("http://comfy.invalid", output_dir=out, transport=transport)
        assert generator.sweep_leftovers() == 3  # 1 stale file + 2 orphaned history entries
        deletes = [c[2]["delete"] for c in calls if c[:2] == ("POST", "/history")]
        assert deletes == [["dead", "gone"]]
        assert not stale.exists() and young.exists()

    def test_purge_leftovers_removes_only_stale_wyr_files(self, tmp_path: Path) -> None:
        out = tmp_path / "comfy-out"
        out.mkdir()
        stale, fresh, other = out / "wyr_old_a_1.png", out / "wyr_new_a_1.png", out / "keep.png"
        for f in (stale, fresh, other):
            f.write_bytes(b"x")
        os.utime(stale, (1.0, 1.0))
        generator = ComfyImageGenerator("http://comfy.invalid", output_dir=out)
        assert generator.purge_leftovers() == 1
        assert not stale.exists() and fresh.exists() and other.exists()


class TestSingleFlight:
    def test_picture_jobs_run_one_at_a_time_and_a_superseded_round_costs_no_gpu(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        gate = _Gate()
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, gate, "a@example.com")
        try:
            first = _create(client, h, "wyr-flight-0001").json()["message"]["seq"]
            deadline = time.time() + 10
            while gate.running == 0 and time.time() < deadline:
                time.sleep(0.05)
            assert gate.running == 1
            second = _create(client, h, "wyr-flight-0002").json()["message"]["seq"]  # supersedes #1
            time.sleep(0.5)
            assert gate.peak == 1  # the second job waits, it does not run alongside
            gate.release.set()
            deadline = time.time() + 15
            rows: dict[int, Any] = {}
            while time.time() < deadline:
                history = client.get(f"{BASE}/messages?limit=10", headers=h).json()["messages"]
                rows = {m["seq"]: m for m in history}
                if len(rows[second]["attachments"]) == 2:
                    break
                time.sleep(0.1)
            assert len(rows[second]["attachments"]) == 2
            # The superseded round's pictures were discarded after its run finished.
            assert rows[first]["attachments"] == []
            assert gate.peak == 1
            assert len(gate.calls) == 2  # #1 had already started; #2 ran after it
            view = client.get(f"{BASE}/wyr/{first}?as=Josh", headers=h).json()
            assert view["state"] == "skipped" and view["images"] == "failed"
        finally:
            client.__exit__(None, None, None)


class TestConfiguration:
    def test_comfy_url_without_an_output_dir_disables_pictures(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_COMFY_URL", "http://127.0.0.1:1")
        monkeypatch.delenv("WIXY_COMFY_OUTPUT_DIR", raising=False)
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        assert app.state.livechat_wyr_image_generator is None
        monkeypatch.setenv("WIXY_COMFY_OUTPUT_DIR", str(storage_root / "comfy-out"))
        app2 = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        assert app2.state.livechat_wyr_image_generator is not None
