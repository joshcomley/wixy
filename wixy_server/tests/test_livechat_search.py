# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The chat's Search screen (decisions/00208): how typed words match stored text, the excerpt a
result shows, the store's scan, `POST /messages/search`, and `GET /messages?around=` / `after=`,
which make going to an old message one request however old it is."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.search import (
    SNIPPET_CHARS,
    excerpt,
    fold,
    matches_all,
    query_words,
)
from wixy_server.livechat.store import LiveChatStore
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
        client_id=f"search-client-{n:04d}",
        sender="Josh",
        device_id="device-1234",
        by_email=None,
        text=text,
        attachment_ids=[],
        now=float(n),
    )
    return message.seq


def _add_transcript(db_path: Path, seq: int, text: str | None, status: str = "done") -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "INSERT INTO attachments(id, kind, status, message_seq, ordinal, mime, renditions, "
            "created_at, updated_at) VALUES (?, 'voice', 'ready', ?, 0, 'audio/webm', '[]', 1, 1)",
            (f"att-{seq}", seq),
        )
        conn.execute(
            "INSERT INTO attachment_transcripts(attachment_id, status, text, created_at, "
            "updated_at) VALUES (?, ?, ?, 1, 1)",
            (f"att-{seq}", status, text),
        )
        conn.commit()
    finally:
        conn.close()


def _find(store: LiveChatStore, query: str) -> list[int]:
    hits, _has_more, _total = store.search_messages(
        words=query_words(query), before=None, only=None, limit=100
    )
    return [hit.seq for hit in hits]


class TestMatching:
    @pytest.mark.parametrize(
        ("query", "text"),
        [
            ("dinner", "Dinner at eight"),
            ("DINNER", "dinner at eight"),
            ("din", "dinner at eight"),
            ("eight dinner", "dinner at eight"),
            ("cafe", "the café on the corner"),
            ("café", "the cafe on the corner"),
            ("cafe", "the café on the corner"),
            ("don't", "I don’t know"),
            ("don’t", "I don't know"),
            ("strasse", "Hauptstraße 4"),
            ("❤", "love you ❤️"),
            ("❤️", "love you ❤"),
            ("🎉", "party 🎉 time"),
        ],
    )
    def test_finds(self, query: str, text: str) -> None:
        assert matches_all(fold(text), query_words(query))

    @pytest.mark.parametrize(
        ("query", "text"),
        [("dinner lunch", "dinner at eight"), ("dinners", "dinner"), ("cafes", "café")],
    )
    def test_needs_every_word(self, query: str, text: str) -> None:
        assert not matches_all(fold(text), query_words(query))

    def test_nothing_searchable_typed(self) -> None:
        assert query_words("   ") == ()
        assert query_words("️") == ()

    def test_repeated_words_count_once(self) -> None:
        assert query_words("Dinner dinner DINNER") == ("dinner",)


class TestExcerpt:
    def _marked(self, text: str, query: str) -> list[str]:
        return [part.text for part in excerpt(text, query_words(query)).parts if part.match]

    def test_short_text_is_whole_with_words_marked(self) -> None:
        found = excerpt("see you at dinner", query_words("dinner"))
        assert [(part.text, part.match) for part in found.parts] == [
            ("see you at ", False),
            ("dinner", True),
        ]
        assert found.matched == ("dinner",)

    def test_marks_the_message_as_written(self) -> None:
        assert self._marked("Dinner at the CAFÉ", "cafe dinner") == ["Dinner", "CAFÉ"]

    def test_an_accent_stored_separately_stays_with_its_letter(self) -> None:
        assert self._marked("the café is open", "cafe") == ["café"]

    def test_positions_survive_characters_that_fold_longer_or_vanish(self) -> None:
        # ß folds to two characters and the selector to none; emoji sit outside the BMP.
        assert self._marked("🎉 Straße ❤️ dinner", "dinner") == ["dinner"]
        assert self._marked("Straße dinner", "strasse") == ["Straße"]

    def test_a_character_folding_to_several_is_marked_whole(self) -> None:
        assert self._marked("\ufb01ne", "f") == ["\ufb01"]
        assert self._marked("Straße", "stras") == ["Straß"]
        assert excerpt("\ufb01ne", query_words("f")).matched == ("\ufb01",)

    def test_a_cut_never_splits_a_joined_emoji(self) -> None:
        family = "\U0001f468\u200d\U0001f469\u200d\U0001f467"
        text = ("x" * 136) + family + "tail"
        joined = "".join(part.text for part in excerpt(text, query_words("xxx")).parts)
        assert family in joined
        text = "y" * 37 + family + "needle"
        opened = excerpt(text, query_words("needle")).parts[1].text
        assert not opened.startswith("\u200d")

    def test_long_text_is_cut_around_the_first_match_on_a_word_boundary(self) -> None:
        text = ("word " * 60) + "needle" + (" more" * 60)
        found = excerpt(text, query_words("needle"))
        assert found.parts[0].text == "…"
        assert found.parts[1].text.startswith("word ")
        assert found.parts[-1].text == "…"
        assert "needle" in [part.text for part in found.parts if part.match]
        assert sum(len(part.text) for part in found.parts if part.text != "…") <= SNIPPET_CHARS

    def test_a_match_beyond_the_window_is_not_marked_but_is_still_reported(self) -> None:
        text = "alpha " + ("x" * 400) + " omega"
        found = excerpt(text, query_words("alpha omega"))
        assert [part.text for part in found.parts if part.match] == ["alpha"]
        assert found.matched == ("alpha", "omega")

    def test_overlapping_words_merge(self) -> None:
        assert self._marked("the dinnertime", "dinner time dinnertime") == ["dinnertime"]


class TestStore:
    def test_newest_first_with_paging_and_a_whole_chat_total(self, store: LiveChatStore) -> None:
        seqs = [_send(store, n, f"dinner {n}") for n in range(1, 6)]
        _send(store, 6, "unrelated")
        first, has_more, total = store.search_messages(
            words=query_words("dinner"), before=None, only=None, limit=2
        )
        assert [hit.seq for hit in first] == [seqs[4], seqs[3]]
        assert has_more is True
        assert total == 5
        rest, has_more, total = store.search_messages(
            words=query_words("dinner"), before=seqs[3], only=None, limit=10
        )
        assert [hit.seq for hit in rest] == [seqs[2], seqs[1], seqs[0]]
        assert has_more is False
        assert total == 5

    def test_finds_a_voice_note_by_its_transcript(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        voice = _send(store, 1, None)
        _add_transcript(db_path, voice, "pick up the Milk please")
        hits, _more, _total = store.search_messages(
            words=query_words("milk"), before=None, only=None, limit=10
        )
        assert [(hit.seq, hit.source) for hit in hits] == [(voice, "transcript")]

    def test_a_message_found_by_its_own_words_is_not_shown_by_its_transcript(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        seq = _send(store, 1, "milk note")
        _add_transcript(db_path, seq, "milk in the transcript")
        hits, _more, total = store.search_messages(
            words=query_words("milk"), before=None, only=None, limit=10
        )
        assert [(hit.seq, hit.source) for hit in hits] == [(seq, "text")]
        assert total == 1

    @pytest.mark.parametrize("status", ["pending", "failed"])
    def test_an_unfinished_transcript_is_not_searched(
        self, store: LiveChatStore, db_path: Path, status: str
    ) -> None:
        seq = _send(store, 1, None)
        _add_transcript(db_path, seq, "milk", status=status)
        assert _find(store, "milk") == []

    def test_a_view_once_message_is_never_found(self, store: LiveChatStore, db_path: Path) -> None:
        with_text = _send(store, 1, "secret milk")
        with_voice = _send(store, 2, None)
        _add_transcript(db_path, with_voice, "secret milk")
        assert sorted(_find(store, "milk")) == [with_text, with_voice]
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("UPDATE messages SET view_once_s = 5")
            conn.commit()
        finally:
            conn.close()
        assert _find(store, "milk") == []

    def test_delete_and_wipe_are_seen_at_once(self, store: LiveChatStore, db_path: Path) -> None:
        gone = _send(store, 1, "milk one")
        voice = _send(store, 2, None)
        _add_transcript(db_path, voice, "milk two")
        keep = _send(store, 3, "milk three")
        store.delete_message(seq=gone, now=10.0)
        store.delete_message(seq=voice, now=10.0)
        assert _find(store, "milk") == [keep]
        store.wipe(now=11.0)
        assert _find(store, "milk") == []

    def test_search_adds_no_table_holding_a_copy_of_the_chat(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        """Inv 46's raw-byte erasure proof covers the rows that exist today; a new table would
        escape it silently, so its absence is pinned."""
        _send(store, 1, "milk")
        conn = sqlite3.connect(str(db_path))
        try:
            names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master")}
        finally:
            conn.close()
        assert not [name for name in names if "fts" in name.lower() or "search" in name.lower()]

    def test_only_answers_about_one_message_and_still_counts_the_chat(
        self, store: LiveChatStore
    ) -> None:
        first = _send(store, 1, "milk one")
        second = _send(store, 2, "milk two")
        plain = _send(store, 3, "plain")
        hits, has_more, total = store.search_messages(
            words=query_words("milk"), before=None, only=first, limit=10
        )
        assert [hit.seq for hit in hits] == [first]
        assert (has_more, total) == (False, 2)
        hits, _more, total = store.search_messages(
            words=query_words("milk"), before=None, only=plain, limit=10
        )
        assert hits == []
        assert total == 2
        assert second != first

    def test_nothing_searchable_finds_nothing(self, store: LiveChatStore) -> None:
        _send(store, 1, "anything")
        assert store.search_messages(words=(), before=None, only=None, limit=10) == ([], False, 0)


class TestNeighbourhood:
    def test_around_gives_the_message_with_its_neighbours_either_side(
        self, store: LiveChatStore
    ) -> None:
        seqs = [_send(store, n, f"m{n}") for n in range(1, 21)]
        rows, has_older, has_newer, _cursor = store.list_messages_around(seq=seqs[9], limit=6)
        assert [row.seq for row in rows] == seqs[6:12]
        assert (has_older, has_newer) == (True, True)

    def test_around_near_the_ends_says_nothing_lies_beyond(self, store: LiveChatStore) -> None:
        seqs = [_send(store, n, f"m{n}") for n in range(1, 5)]
        rows, has_older, has_newer, _cursor = store.list_messages_around(seq=seqs[0], limit=50)
        assert [row.seq for row in rows] == seqs
        assert (has_older, has_newer) == (False, False)

    def test_around_a_deleted_message_leaves_it_out(self, store: LiveChatStore) -> None:
        seqs = [_send(store, n, f"m{n}") for n in range(1, 6)]
        store.delete_message(seq=seqs[2], now=10.0)
        rows, _older, _newer, _cursor = store.list_messages_around(seq=seqs[2], limit=50)
        assert [row.seq for row in rows] == [seqs[0], seqs[1], seqs[3], seqs[4]]

    def test_after_pages_forward(self, store: LiveChatStore) -> None:
        seqs = [_send(store, n, f"m{n}") for n in range(1, 8)]
        rows, has_older, has_newer, _cursor = store.list_messages_after(after=seqs[1], limit=3)
        assert [row.seq for row in rows] == seqs[2:5]
        assert (has_older, has_newer) == (True, True)
        rows, _older, has_newer, _cursor = store.list_messages_after(after=seqs[4], limit=3)
        assert [row.seq for row in rows] == seqs[5:]
        assert has_newer is False

    def test_after_the_end_is_empty(self, store: LiveChatStore) -> None:
        seqs = [_send(store, n, f"m{n}") for n in range(1, 3)]
        rows, has_older, has_newer, _cursor = store.list_messages_after(after=seqs[1], limit=3)
        assert rows == []
        assert (has_older, has_newer) == (False, False)


class TestRoute:
    def test_searches_in_the_request_body_and_is_never_cached(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            for n, text in enumerate(["plain", "Dinner at eight", "the secretword dinner"]):
                response = client.post(
                    "/api/admin/server/messages",
                    json={
                        "clientId": f"route-search-{n:04d}",
                        "sender": "Josh",
                        "deviceId": "device-1234",
                        "text": text,
                    },
                    headers=headers,
                )
                assert response.status_code == 201, response.text

            with caplog.at_level(logging.DEBUG):
                found = client.post(
                    "/api/admin/server/messages/search",
                    json={"q": "secretword"},
                    headers=headers,
                )
            assert found.status_code == 200, found.text
            assert found.headers["cache-control"] == "no-store"
            assert not [r for r in caplog.records if "secretword" in r.getMessage()]

            page = client.post(
                "/api/admin/server/messages/search",
                json={"q": "dinner", "limit": 1},
                headers=headers,
            ).json()
            assert page["total"] == 2
            assert page["hasMore"] is True
            assert page["results"][0]["source"] == "text"
            assert page["results"][0]["sender"] == "Josh"
            assert page["results"][0]["parts"] == [
                {"text": "the secretword ", "match": False},
                {"text": "dinner", "match": True},
            ]
            assert page["results"][0]["matched"] == ["dinner"]

            older = client.post(
                "/api/admin/server/messages/search",
                json={"q": "dinner", "before": page["results"][0]["seq"]},
                headers=headers,
            ).json()
            assert older["hasMore"] is False
            assert older["results"][0]["matched"] == ["Dinner"]

            only = client.post(
                "/api/admin/server/messages/search",
                json={"q": "dinner", "only": older["results"][0]["seq"]},
                headers=headers,
            ).json()
            assert [hit["seq"] for hit in only["results"]] == [older["results"][0]["seq"]]
            assert only["total"] == 2
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        "body",
        [{"q": ""}, {"q": "x" * 201}, {"q": "x", "limit": 0}, {"q": "x", "limit": 101}],
    )
    def test_validates(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        body: dict[str, object],
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post("/api/admin/server/messages/search", json=body, headers=headers)
            assert response.status_code == 422
        finally:
            client.__exit__(None, None, None)

    def test_requires_a_token(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post("/api/admin/server/messages/search", json={"q": "x"})
            assert response.status_code in (401, 403)
        finally:
            client.__exit__(None, None, None)

    def test_history_around_and_after(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        base = "/api/admin/server/messages"
        try:
            seqs = []
            for n in range(5):
                response = client.post(
                    base,
                    json={
                        "clientId": f"route-around-{n:04d}",
                        "sender": "Josh",
                        "deviceId": "device-1234",
                        "text": f"m{n}",
                    },
                    headers=headers,
                )
                seqs.append(response.json()["message"]["seq"])
            around = client.get(f"{base}?around={seqs[2]}&limit=2", headers=headers).json()
            assert [m["seq"] for m in around["messages"]] == seqs[1:3]
            assert (around["hasMore"], around["hasNewer"]) == (True, True)
            assert "cursor" in around

            after = client.get(f"{base}?after={seqs[2]}&limit=50", headers=headers).json()
            assert [m["seq"] for m in after["messages"]] == seqs[3:]
            assert (after["hasMore"], after["hasNewer"]) == (True, False)

            # An ordinary page is unchanged.
            assert "hasNewer" not in client.get(base, headers=headers).json()
            for bad in (
                f"?around={seqs[2]}&limit=101",
                f"?after={seqs[2]}&limit=0",
                f"?around={seqs[2]}&after={seqs[2]}",
                f"?before={seqs[2]}&around={seqs[2]}",
            ):
                assert client.get(f"{base}{bad}", headers=headers).status_code == 422, bad
        finally:
            client.__exit__(None, None, None)
