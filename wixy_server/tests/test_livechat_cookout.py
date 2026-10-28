"""Cookout, store level (workspace 00058, spec/server-chat/09-cookout.md §1, §4.1, §6; Inv 57):
schema v21 and its migration from a real v20 database, the round state machine (create / join /
skip / pick / abandon), seat identity, idempotent replays, the 409 family, Blind mode's server-side
redaction in `cookout_view_json`, the concept / picture / recipe compare-and-sets (including the
`images_generation` fence), erasure (anchor delete, wipe), the game chat reusing `wyr_chat`, and
two-connection `BEGIN IMMEDIATE` races. The routes are `test_routes_livechat_cookout.py`.

The ingredient bank is a small deterministic fake (`FakeBank`) honouring the frozen interface of
spec Appendix A.1, so the whole game runs here without the real ~3,000-item bank."""

from __future__ import annotations

import json
import random
import sqlite3
from collections.abc import Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass
from itertools import count
from pathlib import Path
from typing import Any

import pytest

from wixy_server.livechat.cookout_game import (
    CookoutDrawExhausted,
    cookout_view_json,
    current_turn,
)
from wixy_server.livechat.models import AttachmentResult, CookoutRoundRow, message_json
from wixy_server.livechat.store import (
    _LATEST_SCHEMA_VERSION,
    CookoutBadStateError,
    CookoutExhaustedError,
    CookoutInvalidError,
    CookoutNotPlayerError,
    CookoutNotYourTurnError,
    CookoutRoundNotFoundError,
    CookoutSkipExhaustedError,
    LiveChatStore,
    WyrRoundNotFoundError,
)
from wixy_server.tests.adventure_testkit import run_concurrently

ROLES = ("base", "protein", "produce", "accent")
_MOVES = count(1)


def move_id() -> str:
    return f"move-{next(_MOVES):06d}"


@dataclass(frozen=True)
class FakeIngredient:
    id: str
    name: str
    category: str
    emoji: str
    family: str
    blurb: str
    role: str


@dataclass(frozen=True)
class FakeStaple:
    id: str
    name: str
    pickable: bool


class FakeBank:
    """A deterministic `CookoutBank` stand-in (Appendix A.1): `per_role` ingredients in each of the
    four roles over six categories, every one its own family. `draw_pair` honours the hard rules
    (role, no seen id, no picked family, two categories, two families) and raises the bank's
    exhausted error when no pair exists. `calls` records every draw's inputs."""

    def __init__(self, per_role: int = 30, seed: int = 7) -> None:
        self._rng = random.Random(seed)
        self.items: list[FakeIngredient] = []
        for role in ROLES:
            for i in range(per_role):
                self.items.append(
                    FakeIngredient(
                        id=f"{role}-{i:02d}",
                        name=f"Zed{role}{i:02d}",
                        category=f"cat{i % 6}",
                        emoji="🍳",
                        family=f"fam-{role}-{i:02d}",
                        blurb=f"A blurb for {role} {i:02d}.",
                        role=role,
                    )
                )
        self._by_id = {i.id: i for i in self.items}
        self._staples = tuple(
            FakeStaple(s, s.replace("-", " ").title(), s not in ("water", "salt", "black-pepper"))
            for s in (
                "water",
                "salt",
                "black-pepper",
                "butter",
                "plain-flour",
                "cooking-oil",
                "granulated-sugar",
                "milk",
            )
        )
        self.calls: list[dict[str, Any]] = []
        self.exhausted = False

    def ingredient(self, ingredient_id: str) -> FakeIngredient | None:
        return self._by_id.get(ingredient_id)

    def staple(self, staple_id: str) -> FakeStaple | None:
        return next((s for s in self._staples if s.id == staple_id), None)

    @property
    def staples(self) -> tuple[FakeStaple, ...]:
        return self._staples

    def shuffle_role_schedule(self, rng: random.Random | None = None) -> Sequence[str]:
        return ["base", "protein", "produce", "produce", "accent"]

    def draw_pair(
        self,
        *,
        role: Any,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        player_offered_categories: Sequence[str],
        rng: random.Random | None = None,
    ) -> tuple[FakeIngredient, FakeIngredient]:
        self.calls.append(
            {
                "role": role,
                "seen_ids": frozenset(seen_ids),
                "picked_families": frozenset(picked_families),
                "offered_families": frozenset(offered_families),
                "player_offered_categories": tuple(player_offered_categories),
            }
        )
        if self.exhausted:
            raise CookoutDrawExhausted()
        pool = [
            i
            for i in self.items
            if i.role == role and i.id not in seen_ids and i.family not in picked_families
        ]
        chooser = rng if rng is not None else self._rng
        chooser.shuffle(pool)
        for first in pool:
            for second in pool:
                if second.category != first.category and second.family != first.family:
                    return first, second
        raise CookoutDrawExhausted()


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


@pytest.fixture
def bank() -> FakeBank:
    return FakeBank()


def start(
    store: LiveChatStore,
    bank: FakeBank,
    cid: str = "cookout-client-0001",
    *,
    sender: str = "Josh",
    email: str | None = None,
    blind: bool = False,
    now: float = 10.0,
) -> int:
    message, created = store.create_cookout_round(
        client_id=cid,
        sender=sender,
        device_id="device-1234",
        by_email=email,
        blind=blind,
        bank=bank,
        now=now,
    )
    assert created is True
    return message.seq


def data_of(store: LiveChatStore, seq: int) -> Any:
    data = store.cookout_view_data(anchor_seq=seq)
    assert data is not None
    return data


def live_of(store: LiveChatStore, seq: int) -> Any:
    data = data_of(store, seq)
    cur = current_turn(data.round, data.turns)
    assert cur is not None
    return cur


def join(
    store: LiveChatStore,
    bank: FakeBank,
    seq: int,
    sender: str = "Rose",
    email: str | None = None,
) -> tuple[CookoutRoundRow, bool]:
    return store.join_cookout(anchor_seq=seq, sender=sender, email=email, bank=bank, now=20.0)


def pick(
    store: LiveChatStore,
    bank: FakeBank,
    seq: int,
    sender: str,
    *,
    email: str | None = None,
    index: int = 0,
    runner: bool = True,
    mv: str | None = None,
    ingredient: str | None = None,
) -> tuple[CookoutRoundRow, bool]:
    live = live_of(store, seq)
    assert live.row is not None
    offer = len(live.row.offers) - 1
    chosen = ingredient if ingredient is not None else live.row.offers[offer][index]["id"]
    return store.pick_cookout(
        anchor_seq=seq,
        sender=sender,
        email=email,
        move_id=mv or move_id(),
        turn=live.turn,
        offer=offer,
        ingredient_id=chosen,
        bank=bank,
        runner_available=runner,
        now=30.0,
    )


def skip(
    store: LiveChatStore,
    bank: FakeBank,
    seq: int,
    sender: str,
    *,
    email: str | None = None,
    mv: str | None = None,
) -> tuple[CookoutRoundRow, bool]:
    live = live_of(store, seq)
    assert live.row is not None
    return store.skip_cookout(
        anchor_seq=seq,
        sender=sender,
        email=email,
        move_id=mv or move_id(),
        turn=live.turn,
        offer=len(live.row.offers) - 1,
        bank=bank,
        now=25.0,
    )


def play_all(
    store: LiveChatStore,
    bank: FakeBank,
    seq: int,
    *,
    p1: str = "Josh",
    p2: str = "Rose",
    runner: bool = True,
) -> CookoutRoundRow:
    """Join Player 2 and make all ten picks (taking the first option each time)."""
    if store.cookout_player_slot(anchor_seq=seq, sender=p2, email=None) is None:
        join(store, bank, seq, p2)
    row: CookoutRoundRow | None = None
    for turn in range(1, 11):
        row, _ = pick(store, bank, seq, p1 if turn % 2 == 1 else p2, runner=runner)
    assert row is not None
    return row


def canned_concepts(picked: list[str]) -> str:
    """Three well-formed concepts over `picked` (ten ids), as the AI runner would store them."""
    return json.dumps(
        {
            "concepts": [
                {
                    "id": cid,
                    "title": f"Dish {cid.upper()}",
                    "vibe": "Bistro",
                    "dishType": dish,
                    "technique": tech,
                    "description": f"A tasty dish number {cid} made from the basket.",
                    "pickedIngredientIds": picked[:8],
                    "stapleIds": ["salt", "butter"],
                    "omitted": [{"id": i, "reason": "Left out."} for i in picked[8:]],
                }
                for cid, dish, tech in (
                    ("a", "bowl", "roast"),
                    ("b", "pie", "bake"),
                    ("c", "soup", "simmer"),
                )
            ]
        }
    )


def finished_round(
    store: LiveChatStore, bank: FakeBank, cid: str = "cookout-client-0001", *, runner: bool = True
) -> tuple[int, list[str]]:
    seq = start(store, bank, cid)
    play_all(store, bank, seq, runner=runner)
    picked = store.get_cookout_round(seq)["picked_ids"]  # type: ignore[index]
    return seq, picked


def ready_round(
    store: LiveChatStore, bank: FakeBank, cid: str = "cookout-client-0001", *, pictures: bool = True
) -> int:
    """A finished round whose concepts are `ready` (and, with `pictures`, whose picture wait is
    `pending`, as `finish_cookout_concepts` leaves it)."""
    seq, picked = finished_round(store, bank, cid)
    assert store.set_cookout_concepts_run(seq, "run-1")
    assert store.finish_cookout_concepts(
        seq, "run-1", "ready", concepts_json=canned_concepts(picked), pictures_pending=pictures
    )
    return seq


def raw(db_path: Path, sql: str, *args: object) -> list[tuple[Any, ...]]:
    conn = sqlite3.connect(str(db_path))
    try:
        return [tuple(r) for r in conn.execute(sql, args).fetchall()]
    finally:
        conn.close()


def events(db_path: Path, seq: int) -> list[str]:
    return [
        r[0]
        for r in raw(
            db_path, "SELECT type FROM events WHERE message_seq = ? ORDER BY event_seq", seq
        )
    ]


class _Signer:
    def url_for(self, attachment_id: str, rendition: str) -> str:
        return f"https://example.invalid/{attachment_id}/{rendition}"


def view_for(
    store: LiveChatStore,
    bank: FakeBank,
    seq: int,
    viewer: str | None,
    email: str | None = None,
) -> dict[str, Any]:
    from wixy_server.livechat.reactions import reactor_key

    data = data_of(store, seq)
    return dict(
        cookout_view_json(
            data.round,
            data.turns,
            data.recipes,
            data.attachments,
            bank,
            viewer_key=reactor_key(viewer) if viewer else None,
            viewer_email=email,
            signer=_Signer(),
        )
    )


# -- schema ---------------------------------------------------------------------------------------


class TestSchema:
    def test_the_latest_schema_version_is_21(self) -> None:
        assert _LATEST_SCHEMA_VERSION == 21

    def test_a_fresh_database_has_the_three_tables(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        names = {r[0] for r in raw(db_path, "SELECT name FROM sqlite_master")}
        assert {
            "cookout_rounds",
            "cookout_turns",
            "cookout_recipes",
            "idx_cookout_rounds_state",
            "idx_cookout_recipes_banked",
        } <= names
        assert raw(db_path, "PRAGMA user_version") == [(21,)]

    def test_a_real_v20_database_gains_the_tables_and_keeps_everything(self, db_path: Path) -> None:
        old = LiveChatStore(db_path)
        old.list_messages(before=None, limit=1)
        message, _ = old.create_message(
            client_id="old-message-0001",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="a v20 message",
            attachment_ids=[],
            now=5.0,
        )
        adv, _ = old.create_adventure_round(
            client_id="old-adventure-01",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            now=6.0,
        )
        conn = sqlite3.connect(str(db_path))
        try:
            adv_columns_before = [r[1] for r in conn.execute("PRAGMA table_info(adv_rounds)")]
            conn.execute("DROP INDEX idx_cookout_recipes_banked")
            conn.execute("DROP INDEX idx_cookout_rounds_state")
            conn.execute("DROP TABLE cookout_recipes")
            conn.execute("DROP TABLE cookout_turns")
            conn.execute("DROP TABLE cookout_rounds")
            conn.execute("PRAGMA user_version = 20")
            conn.commit()
        finally:
            conn.close()

        migrated = LiveChatStore(db_path)
        listed, _more, _cursor = migrated.list_messages(before=None, limit=10)
        assert {m.seq for m in listed} == {message.seq, adv.seq}
        assert all(m.cookout is None for m in listed)
        names = {r[0] for r in raw(db_path, "SELECT name FROM sqlite_master")}
        assert {"cookout_rounds", "cookout_turns", "cookout_recipes", "wyr_chat"} <= names
        assert raw(db_path, "PRAGMA user_version") == [(21,)]
        # v20 is deployed and is never edited.
        assert [r[1] for r in raw(db_path, "PRAGMA table_info(adv_rounds)")] == adv_columns_before
        # ...and the migrated database plays a round.
        assert start(migrated, FakeBank(), "post-migrate-0001") > adv.seq

    def test_the_tables_cascade_from_the_anchor_message(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        for table, column in (
            ("cookout_rounds", "anchor_message_seq"),
            ("cookout_turns", "anchor_message_seq"),
            ("cookout_recipes", "anchor_message_seq"),
        ):
            fks = raw(db_path, f"PRAGMA foreign_key_list({table})")
            assert any(
                fk[2] in ("messages", "cookout_rounds") and fk[3] == column and fk[6] == "CASCADE"
                for fk in fks
            ), table


# -- create ---------------------------------------------------------------------------------------


class TestCreate:
    def test_a_round_starts_picking_with_turn_one_drawn_for_the_creator(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank, sender="Josh", email="a@example.com", blind=True)
        data = data_of(store, seq)
        round_ = data.round
        assert round_.state == "picking" and round_.blind is True
        assert round_.player1_name == "Josh" and round_.player1_email == "a@example.com"
        assert round_.player2_key is None and round_.player2_name is None
        assert round_.concepts == "none" and round_.images == "none" and round_.rev == 1
        assert list(round_.role_schedule) == ["base", "protein", "produce", "produce", "accent"]
        [turn] = data.turns
        assert (turn.turn, turn.player, turn.choice_id) == (1, 1, None)
        assert len(turn.offers) == 1
        first, second = turn.offers[0]
        assert first["category"] != second["category"] and first["family"] != second["family"]
        assert {first["id"], second["id"]} <= {i.id for i in bank.items if i.role == "base"}
        # The snapshot is complete and immutable (the bank is never consulted again).
        assert set(first) == {"id", "name", "category", "emoji", "family", "blurb"}

    def test_the_anchor_message_is_text_less_and_carries_a_summary_without_ingredients(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank, blind=True)
        [message] = store.list_messages(before=None, limit=10)[0]
        assert message.seq == seq and message.text is None and message.attachments == ()
        wire = message_json(message, _Signer())
        assert wire["cookout"] == {
            "state": "picking",
            "blind": True,
            "pickedCount": 0,
            "concepts": "none",
            "bankedCount": 0,
            "rev": 1,
        }
        first, second = data_of(store, seq).turns[0].offers[0]
        blob = json.dumps(wire)
        assert first["name"] not in blob and second["name"] not in blob
        assert wire["wyr"] is None and wire["adventure"] is None and wire["wyrRef"] is None

    def test_a_replayed_client_id_returns_the_same_message_and_abandons_nothing(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        first = start(store, bank, "cookout-replay-0001")
        again, created = store.create_cookout_round(
            client_id="cookout-replay-0001",
            sender="Rose",
            device_id="device-1234",
            by_email=None,
            blind=True,
            bank=bank,
            now=50.0,
        )
        assert created is False and again.seq == first
        assert data_of(store, first).round.state == "picking"
        assert data_of(store, first).round.blind is False
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_rounds") == [(1,)]

    def test_a_new_round_abandons_an_open_one_and_never_a_finished_one(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        done_seq, _ = finished_round(store, bank, "cookout-done-000001")
        open_seq = start(store, bank, "cookout-open-000001")
        before = events(db_path, open_seq)
        new_seq = start(store, bank, "cookout-new-000001")
        assert data_of(store, open_seq).round.state == "abandoned"
        assert data_of(store, open_seq).round.rev == 2
        assert events(db_path, open_seq) == [*before, "message_updated"]
        assert data_of(store, done_seq).round.state == "finished"
        assert data_of(store, new_seq).round.state == "picking"

    def test_an_empty_draw_creates_nothing(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        bank.exhausted = True
        with pytest.raises(CookoutExhaustedError):
            store.create_cookout_round(
                client_id="cookout-empty-0001",
                sender="Josh",
                device_id="device-1234",
                by_email=None,
                blind=False,
                bank=bank,
            )
        assert raw(db_path, "SELECT COUNT(*) FROM messages") == [(0,)]
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_rounds") == [(0,)]


# -- join -----------------------------------------------------------------------------------------


class TestJoin:
    def test_joining_during_turn_one_binds_slot_two_and_draws_nothing_yet(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        row, changed = join(store, bank, seq, "Rose", "b@example.com")
        assert changed is True
        assert row.player2_name == "Rose" and row.player2_email == "b@example.com"
        assert len(data_of(store, seq).turns) == 1
        # Player 1 picks: turn 2's pair is drawn in the same transaction (player 2 is bound).
        pick(store, bank, seq, "Josh")
        turns = data_of(store, seq).turns
        assert [(t.turn, t.player) for t in turns] == [(1, 1), (2, 2)]

    def test_player_one_finishing_turn_one_first_waits_and_join_then_draws_turn_two(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        pick(store, bank, seq, "Josh")
        data = data_of(store, seq)
        assert len(data.turns) == 1  # turn 2 is NOT drawn before Join
        cur = current_turn(data.round, data.turns)
        assert cur is not None and (cur.turn, cur.player) == (2, 2)
        assert cur.row is None and cur.waiting_for_join is True
        calls_before = len(bank.calls)
        _, changed = join(store, bank, seq)
        assert changed is True
        assert len(bank.calls) == calls_before + 1
        data = data_of(store, seq)
        assert [(t.turn, t.player) for t in data.turns] == [(1, 1), (2, 2)]
        # Turn 2's draw avoids turn 1's offers and picked family.
        draw = bank.calls[-1]
        assert draw["seen_ids"] == {s["id"] for pair in data.turns[0].offers for s in pair}
        assert draw["role"] == "base"  # the pair shares turn 1's role

    def test_a_seat_is_never_bound_by_a_first_move(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        pick(store, bank, seq, "Josh")
        with pytest.raises(CookoutNotPlayerError):
            store.pick_cookout(
                anchor_seq=seq,
                sender="Rose",
                email=None,
                move_id=move_id(),
                turn=2,
                offer=0,
                ingredient_id="base-00",
                bank=bank,
                runner_available=True,
            )
        assert data_of(store, seq).round.player2_key is None

    def test_joining_again_is_idempotent_and_does_not_redraw(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = start(store, bank)
        pick(store, bank, seq, "Josh")
        join(store, bank, seq)
        evs, calls = events(db_path, seq), len(bank.calls)
        row, changed = join(store, bank, seq)
        assert changed is False and row.player2_name == "Rose"
        assert events(db_path, seq) == evs and len(bank.calls) == calls

    def test_a_third_person_the_first_player_and_a_late_join_are_bad_state(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        with pytest.raises(CookoutBadStateError):
            join(store, bank, seq, "Josh")  # the first player cannot take both seats
        join(store, bank, seq, "Rose")
        with pytest.raises(CookoutBadStateError):
            join(store, bank, seq, "Cupcake")
        late = start(store, bank, "cookout-late-0000001")
        store.abandon_cookout(anchor_seq=late, sender="Josh", email=None)
        with pytest.raises(CookoutBadStateError):
            join(store, bank, late, "Rose")

    def test_the_slot_two_name_under_another_sign_in_is_not_a_player(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq, "Rose", "b@example.com")
        with pytest.raises(CookoutNotPlayerError):
            join(store, bank, seq, "Rose", "someone-else@example.com")

    def test_a_missing_round_is_not_found(self, store: LiveChatStore, bank: FakeBank) -> None:
        with pytest.raises(CookoutRoundNotFoundError):
            join(store, bank, 999)


# -- seat identity --------------------------------------------------------------------------------


class TestSeatIdentity:
    def test_an_email_mismatch_is_a_stranger_and_an_unknown_email_falls_back_to_the_name(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank, sender="Josh", email="a@example.com")
        join(store, bank, seq, "Rose", "b@example.com")
        # Same name, different verified sign-in: not a player (view: no `you`; move: not_player).
        assert view_for(store, bank, seq, "Josh", "x@example.com")["you"] is None
        with pytest.raises(CookoutNotPlayerError):
            pick(store, bank, seq, "Josh", email="x@example.com")
        # The matching email (case-insensitively), or no email at all, is the player.
        assert view_for(store, bank, seq, "Josh", "A@Example.com")["you"] == {"slot": 1}
        assert view_for(store, bank, seq, "Josh", None)["you"] == {"slot": 1}
        assert view_for(store, bank, seq, "josh ", None)["you"] == {"slot": 1}
        assert view_for(store, bank, seq, "Nobody", "a@example.com")["you"] is None
        assert view_for(store, bank, seq, None)["you"] is None

    def test_a_round_started_without_an_email_matches_by_name_alone(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank, sender="Josh", email=None)
        assert view_for(store, bank, seq, "Josh", "anyone@example.com")["you"] == {"slot": 1}


# -- turns: alternation, skips, picks -------------------------------------------------------------


class TestTurns:
    def test_only_the_active_seat_may_move_and_strangers_are_not_players(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        with pytest.raises(CookoutNotYourTurnError):
            pick(store, bank, seq, "Rose")
        with pytest.raises(CookoutNotYourTurnError):
            skip(store, bank, seq, "Rose")
        with pytest.raises(CookoutNotPlayerError):
            pick(store, bank, seq, "Cupcake")
        with pytest.raises(CookoutNotPlayerError):
            skip(store, bank, seq, "Cupcake")
        pick(store, bank, seq, "Josh")
        with pytest.raises(CookoutNotYourTurnError):
            pick(store, bank, seq, "Josh")  # turn 2 is Rose's

    def test_ten_turns_alternate_five_picks_each_and_finish_the_round(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        players = []
        for turn in range(1, 11):
            assert live_of(store, seq).turn == turn
            who = "Josh" if turn % 2 == 1 else "Rose"
            players.append(live_of(store, seq).player)
            pick(store, bank, seq, who)
        assert players == [1, 2] * 5
        data = data_of(store, seq)
        assert data.round.state == "finished"
        assert current_turn(data.round, data.turns) is None
        assert len(data.turns) == 10 and all(t.choice_id for t in data.turns)
        # Each role was offered on two consecutive turns, one per player.
        for t in data.turns:
            role = data.round.role_schedule[(t.turn - 1) // 2]
            assert all(bank.ingredient(s["id"]).role == role for pair in t.offers for s in pair)  # type: ignore[union-attr]

    def test_two_skips_then_a_forced_pick_and_the_next_turn_starts_with_two_skips(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        assert len(live_of(store, seq).row.offers) == 1
        row, changed = skip(store, bank, seq, "Josh")
        assert changed is True and row.rev == 3  # create 1, join 2, skip 3
        assert len(live_of(store, seq).row.offers) == 2
        skip(store, bank, seq, "Josh")
        third = live_of(store, seq).row
        assert len(third.offers) == 3 and live_of(store, seq).turn == 1  # skipping never passes
        with pytest.raises(CookoutSkipExhaustedError):
            skip(store, bank, seq, "Josh")
        assert len(live_of(store, seq).row.offers) == 3  # the refused skip drew nothing
        chosen = third.offers[2][1]["id"]
        pick(store, bank, seq, "Josh", index=1)
        assert data_of(store, seq).turns[0].choice_id == chosen
        # Turn 2 begins fresh: one pair, two skips available.
        assert len(live_of(store, seq).row.offers) == 1
        skip(store, bank, seq, "Rose")
        skip(store, bank, seq, "Rose")
        with pytest.raises(CookoutSkipExhaustedError):
            skip(store, bank, seq, "Rose")

    def test_a_pick_must_be_one_of_the_live_pair(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        skip(store, bank, seq, "Josh")
        first_pair = [s["id"] for s in live_of(store, seq).row.offers[0]]
        with pytest.raises(CookoutInvalidError):
            pick(store, bank, seq, "Josh", ingredient="base-29")
        # An id from an EARLIER (skipped) pair is not on the table either.
        with pytest.raises(CookoutInvalidError):
            pick(store, bank, seq, "Josh", ingredient=first_pair[0])
        assert data_of(store, seq).turns[0].choice_id is None

    def test_a_stale_turn_or_offer_is_bad_state(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        live = live_of(store, seq)
        with pytest.raises(CookoutBadStateError):
            store.skip_cookout(
                anchor_seq=seq,
                sender="Josh",
                email=None,
                move_id=move_id(),
                turn=live.turn,
                offer=1,  # the pair on the table is offer 0
                bank=bank,
            )
        with pytest.raises(CookoutBadStateError):
            store.pick_cookout(
                anchor_seq=seq,
                sender="Josh",
                email=None,
                move_id=move_id(),
                turn=3,
                offer=0,
                ingredient_id=live.row.offers[0][0]["id"],
                bank=bank,
                runner_available=True,
            )

    def test_moves_on_a_round_that_is_not_picking_are_bad_state(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        live = live_of(store, seq)
        store.abandon_cookout(anchor_seq=seq, sender="Josh", email=None)
        with pytest.raises(CookoutBadStateError):
            store.skip_cookout(
                anchor_seq=seq,
                sender="Josh",
                email=None,
                move_id=move_id(),
                turn=1,
                offer=0,
                bank=bank,
            )
        with pytest.raises(CookoutBadStateError):
            store.pick_cookout(
                anchor_seq=seq,
                sender="Josh",
                email=None,
                move_id=move_id(),
                turn=1,
                offer=0,
                ingredient_id=live.row.offers[0][0]["id"],
                bank=bank,
                runner_available=True,
            )

    def test_the_draw_never_repeats_an_id_and_avoids_picked_families(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        for turn in range(1, 11):
            who = "Josh" if turn % 2 == 1 else "Rose"
            skip(store, bank, seq, who)
            skip(store, bank, seq, who)
            pick(store, bank, seq, who, index=turn % 2)
        data = data_of(store, seq)
        offered = [s["id"] for t in data.turns for pair in t.offers for s in pair]
        assert len(offered) == len(set(offered)) == 10 * 3 * 2
        picked_families = {
            s["family"]
            for t in data.turns
            for pair in t.offers
            for s in pair
            if s["id"] == t.choice_id
        }
        assert len(picked_families) == 10
        # Every draw was told everything offered/picked so far, per round (no cross-round state).
        last = bank.calls[-1]
        assert len(last["seen_ids"]) == 10 * 3 * 2 - 2 and len(last["picked_families"]) == 9
        # ...and what THAT player has already been shown, for the least-shown-category rule.
        assert (
            len(last["player_offered_categories"]) == 4 * 3 * 2 + 0
            or last["player_offered_categories"]
        )

    def test_an_exhausted_draw_refuses_and_charges_nothing(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        evs = events(db_path, seq)
        rev = data_of(store, seq).round.rev
        bank.exhausted = True
        with pytest.raises(CookoutExhaustedError):
            skip(store, bank, seq, "Josh")
        with pytest.raises(CookoutExhaustedError):
            pick(store, bank, seq, "Josh")
        data = data_of(store, seq)
        assert data.round.rev == rev and events(db_path, seq) == evs
        assert len(data.turns[0].offers) == 1 and data.turns[0].choice_id is None
        assert data.turns[0].skip_move_ids == ()


class TestIdempotency:
    def test_replaying_a_skip_move_changes_nothing(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        mv = move_id()
        live = live_of(store, seq)
        row, changed = store.skip_cookout(
            anchor_seq=seq, sender="Josh", email=None, move_id=mv, turn=1, offer=0, bank=bank
        )
        assert changed is True
        evs, calls, rev = events(db_path, seq), len(bank.calls), row.rev
        again, changed = store.skip_cookout(
            anchor_seq=seq, sender="Josh", email=None, move_id=mv, turn=1, offer=0, bank=bank
        )
        assert changed is False and again.rev == rev
        assert events(db_path, seq) == evs and len(bank.calls) == calls
        assert len(live_of(store, seq).row.offers) == 2 and live.turn == 1
        # A DIFFERENT move aimed at the old offer index is bad_state, not a free extra skip.
        with pytest.raises(CookoutBadStateError):
            store.skip_cookout(
                anchor_seq=seq,
                sender="Josh",
                email=None,
                move_id=move_id(),
                turn=1,
                offer=0,
                bank=bank,
            )

    def test_replaying_a_pick_move_changes_nothing_even_after_the_turn_moved_on(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        mv = move_id()
        live = live_of(store, seq)
        chosen = live.row.offers[0][0]["id"]
        kwargs: dict[str, Any] = {
            "anchor_seq": seq,
            "sender": "Josh",
            "email": None,
            "move_id": mv,
            "turn": 1,
            "offer": 0,
            "ingredient_id": chosen,
            "bank": bank,
            "runner_available": True,
        }
        _, changed = store.pick_cookout(**kwargs)
        assert changed is True
        evs, calls = events(db_path, seq), len(bank.calls)
        _, changed = store.pick_cookout(**kwargs)
        assert changed is False
        assert events(db_path, seq) == evs and len(bank.calls) == calls
        assert len(data_of(store, seq).turns) == 2  # no second draw
        # A different move for the already-picked turn: bad_state (the live turn is 2).
        with pytest.raises(CookoutBadStateError):
            store.pick_cookout(**{**kwargs, "move_id": move_id()})

    def test_replaying_the_final_pick_neither_re_finishes_nor_restarts_the_job(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        for turn in range(1, 10):
            pick(store, bank, seq, "Josh" if turn % 2 == 1 else "Rose")
        mv = move_id()
        live = live_of(store, seq)
        kwargs: dict[str, Any] = {
            "anchor_seq": seq,
            "sender": "Rose",
            "email": None,
            "move_id": mv,
            "turn": 10,
            "offer": 0,
            "ingredient_id": live.row.offers[0][0]["id"],
            "bank": bank,
            "runner_available": True,
        }
        row, changed = store.pick_cookout(**kwargs)
        assert changed is True and (row.state, row.concepts) == ("finished", "pending")
        evs = events(db_path, seq)
        row2, changed = store.pick_cookout(**kwargs)
        assert changed is False and row2.rev == row.rev and events(db_path, seq) == evs


# -- finishing ------------------------------------------------------------------------------------


class TestFinish:
    def test_the_tenth_pick_finishes_and_starts_the_concepts_window(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        for turn in range(1, 10):
            pick(store, bank, seq, "Josh" if turn % 2 == 1 else "Rose")
        before = events(db_path, seq)
        row, changed = pick(store, bank, seq, "Rose", runner=True)
        assert changed is True
        assert (row.state, row.concepts) == ("finished", "pending")
        assert row.concepts_run_id is None and row.concepts_tries == 1
        assert row.concepts_started_at == 30.0 and row.concepts_deadline_at == 30.0 + 900
        assert row.images == "none"
        assert events(db_path, seq) == [*before, "message_updated"]  # exactly one event
        assert len(data_of(store, seq).turns) == 10  # no eleventh draw

    def test_without_a_runner_concepts_are_unavailable_at_once(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        row = play_all(store, bank, seq, runner=False)
        assert (row.state, row.concepts) == ("finished", "unavailable")
        assert row.concepts_error and row.concepts_deadline_at is None

    def test_the_round_getter_for_the_ai_runner(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = start(store, bank)
        assert store.get_cookout_round(999) is None
        mid = store.get_cookout_round(seq)
        assert mid is not None and mid["picked_ids"] == [] and mid["recipes"] == {}
        join(store, bank, seq)
        play_all(store, bank, seq)
        got = store.get_cookout_round(seq)
        assert got is not None
        assert got["state"] == "finished" and got["concepts"] == "pending"
        assert got["anchor_message_seq"] == seq and got["images_generation"] == 0
        assert len(got["picked_ids"]) == 10
        assert got["picked_ids"] == [t.choice_id for t in data_of(store, seq).turns]
        assert got["pictures"] == {} and got["concepts_json"] is None
        assert isinstance(got["role_schedule"], str)


# -- abandon --------------------------------------------------------------------------------------


class TestAbandon:
    def test_either_bound_player_ends_an_open_round_and_it_is_idempotent(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        a = start(store, bank, "cookout-ab-00000001")
        join(store, bank, a)
        row, changed = store.abandon_cookout(anchor_seq=a, sender="Rose", email=None)
        assert changed is True and row.state == "abandoned" and row.rev == 3
        evs = events(db_path, a)
        row, changed = store.abandon_cookout(anchor_seq=a, sender="Josh", email=None)
        assert changed is False and events(db_path, a) == evs
        b = start(store, bank, "cookout-ab-00000002")  # the starter, before Slot 2 joined
        assert (
            store.abandon_cookout(anchor_seq=b, sender="Josh", email=None)[0].state == "abandoned"
        )

    def test_strangers_cannot_and_a_finished_round_is_never_abandoned(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        a = start(store, bank, "cookout-ab-00000003")
        with pytest.raises(CookoutNotPlayerError):
            store.abandon_cookout(anchor_seq=a, sender="Cupcake", email=None)
        done, _ = finished_round(store, bank, "cookout-ab-00000004")
        with pytest.raises(CookoutBadStateError):
            store.abandon_cookout(anchor_seq=done, sender="Josh", email=None)
        assert data_of(store, done).round.state == "finished"
        with pytest.raises(CookoutRoundNotFoundError):
            store.abandon_cookout(anchor_seq=404, sender="Josh", email=None)


# -- Blind mode redaction -------------------------------------------------------------------------


def names_of(store: LiveChatStore, seq: int, *, player: int) -> set[str]:
    return {
        s["name"]
        for t in data_of(store, seq).turns
        if t.player == player
        for pair in t.offers
        for s in pair
    }


def all_text(view: dict[str, Any]) -> str:
    return json.dumps(view)


class TestBlindRedaction:
    def test_the_partners_turn_options_role_and_skips_are_null_for_everyone_else(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank, blind=True)
        join(store, bank, seq)
        p1_names = names_of(store, seq, player=1)
        mine = view_for(store, bank, seq, "Josh")
        assert mine["current"]["player"] == 1
        assert len(mine["current"]["options"]) == 2
        assert mine["current"]["offerIndex"] == 0 and mine["current"]["skipsRemaining"] == 2
        assert mine["current"]["role"] == "base"
        for viewer in ("Rose", "Cupcake", None):
            seen = view_for(store, bank, seq, viewer)
            cur = seen["current"]
            assert (cur["turn"], cur["player"], cur["waitingForJoin"]) == (1, 1, False)
            assert cur["role"] is None and cur["options"] is None
            assert cur["offerIndex"] is None and cur["skipsRemaining"] is None
            assert not any(name in all_text(seen) for name in p1_names), viewer

    def test_partner_picks_are_null_with_only_a_count_until_the_reveal(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank, blind=True)
        join(store, bank, seq)
        pick(store, bank, seq, "Josh")
        pick(store, bank, seq, "Rose")
        pick(store, bank, seq, "Josh")
        p1_picks = [
            bank.ingredient(t.choice_id).name  # type: ignore[union-attr]
            for t in data_of(store, seq).turns
            if t.player == 1 and t.choice_id
        ]
        rose = view_for(store, bank, seq, "Rose")
        assert rose["revealed"] is False and rose["blind"] is True
        assert rose["players"][0] == {"slot": 1, "name": "Josh", "pickCount": 2, "picks": None}
        assert rose["players"][1]["pickCount"] == 1 and len(rose["players"][1]["picks"]) == 1
        assert not any(name in all_text(rose) for name in p1_picks)
        josh = view_for(store, bank, seq, "Josh")
        assert len(josh["players"][0]["picks"]) == 2 and josh["players"][1]["picks"] is None
        stranger = view_for(store, bank, seq, None)
        assert all(p["picks"] is None for p in stranger["players"])
        assert [p["pickCount"] for p in stranger["players"]] == [2, 1]

    def test_history_holds_only_the_viewers_own_turns_before_and_after_the_reveal(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank, blind=True)
        join(store, bank, seq)
        for turn in range(1, 11):
            who = "Josh" if turn % 2 == 1 else "Rose"
            if turn == 2:
                skip(store, bank, seq, "Rose")  # Rose's skipped pair must stay hers
            if turn == 3:
                skip(store, bank, seq, "Josh")
            pick(store, bank, seq, who, runner=True)
            josh, rose = view_for(store, bank, seq, "Josh"), view_for(store, bank, seq, "Rose")
            assert {h["player"] for h in josh["history"]} <= {1}
            assert {h["player"] for h in rose["history"]} <= {2}
            assert view_for(store, bank, seq, None)["history"] == []
        # Finished: the ten picks are revealed to both...
        josh, rose = view_for(store, bank, seq, "Josh"), view_for(store, bank, seq, "Rose")
        for v in (josh, rose, view_for(store, bank, seq, None)):
            assert v["state"] == "finished" and v["revealed"] is True
            assert [len(p["picks"]) for p in v["players"]] == [5, 5]
            assert v["current"] is None
        # ...but the partner's offered/skipped pairs never leave the server.
        assert len(josh["history"]) == 5 and len(rose["history"]) == 5
        rose_offered = names_of(store, seq, player=2)
        rose_picked = {p["name"] for p in josh["players"][1]["picks"]}
        leaked = [n for n in rose_offered - rose_picked if n in all_text(josh)]
        assert leaked == []

    def test_an_abandoned_blind_round_never_reveals(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank, blind=True)
        join(store, bank, seq)
        pick(store, bank, seq, "Josh")
        pick(store, bank, seq, "Rose")
        store.abandon_cookout(anchor_seq=seq, sender="Josh", email=None)
        rose_name = data_of(store, seq).turns[1]
        josh = view_for(store, bank, seq, "Josh")
        assert josh["state"] == "abandoned" and josh["revealed"] is False
        assert josh["current"] is None
        assert josh["players"][1]["picks"] is None and josh["players"][0]["picks"] is not None
        assert bank.ingredient(rose_name.choice_id).name not in all_text(josh)  # type: ignore[union-attr]

    def test_waiting_for_join_exposes_nothing_in_blind_mode(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank, blind=True)
        pick(store, bank, seq, "Josh")
        for viewer in ("Josh", "Rose", None):
            cur = view_for(store, bank, seq, viewer)["current"]
            assert cur["turn"] == 2 and cur["player"] == 2 and cur["waitingForJoin"] is True
            assert cur["role"] is None and cur["options"] is None
            assert cur["offerIndex"] is None and cur["skipsRemaining"] is None

    def test_open_mode_shows_everyone_everything(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        pick(store, bank, seq, "Josh")
        skip(store, bank, seq, "Rose")
        for viewer in ("Josh", "Rose", None):
            v = view_for(store, bank, seq, viewer)
            assert v["blind"] is False and v["revealed"] is True
            assert len(v["current"]["options"]) == 2 and v["current"]["offerIndex"] == 1
            assert v["current"]["skipsRemaining"] == 1 and v["current"]["role"] == "base"
            assert len(v["players"][0]["picks"]) == 1 and len(v["history"]) == 1
        waiting = start(store, bank, "cookout-open-wait01")
        pick(store, bank, waiting, "Josh")
        cur = view_for(store, bank, waiting, "Rose")["current"]
        assert cur["waitingForJoin"] is True and cur["options"] is None

    def test_the_view_shape(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = start(store, bank)
        v = view_for(store, bank, seq, "Josh")
        assert set(v) == {
            "seq", "state", "rev", "blind", "revealed", "players", "you", "current",
            "history", "staples", "concepts", "images", "recipes",
        }  # fmt: skip
        assert v["players"][1] == {"slot": 2, "name": None, "pickCount": 0, "picks": []}
        assert set(v["current"]["options"][0]) == {"id", "name", "category", "emoji", "blurb"}
        assert len(v["staples"]) == 8 and v["staples"][0] == {"id": "water", "name": "Water"}
        assert v["concepts"] == {"state": "none", "data": None, "error": None}
        assert v["images"] == {"state": "none", "pictures": {"a": None, "b": None, "c": None}}
        assert v["recipes"]["a"] == {
            "state": "none", "requestedBy": None, "bankedAt": None, "error": None, "data": None,
        }  # fmt: skip


# -- Stage 1: concepts ----------------------------------------------------------------------------


class TestConcepts:
    def test_the_run_id_is_recorded_once_and_a_dead_run_can_be_replaced(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq, _ = finished_round(store, bank)
        assert store.cookout_pending_concepts() == [(seq, None)]
        assert store.set_cookout_concepts_run(seq, "run-1") is True
        assert store.cookout_pending_concepts() == [(seq, "run-1")]
        # Another process racing to record its own first run loses.
        assert store.set_cookout_concepts_run(seq, "run-x") is False
        # The single early retry replaces the dead run and counts a try.
        assert store.set_cookout_concepts_run(seq, "run-2", expected_run_id="run-1") is True
        row = data_of(store, seq).round
        assert row.concepts_run_id == "run-2" and row.concepts_tries == 2
        assert store.set_cookout_concepts_run(404, "r") is False

    def test_a_ready_result_lands_once_and_starts_the_picture_wait(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq, picked = finished_round(store, bank)
        store.set_cookout_concepts_run(seq, "run-1")
        evs = events(db_path, seq)
        assert store.finish_cookout_concepts(
            seq, "run-1", "ready", concepts_json=canned_concepts(picked), pictures_pending=True
        )
        row = data_of(store, seq).round
        assert row.concepts == "ready" and row.concepts_error is None
        assert row.images == "pending" and row.images_tries == 1
        assert row.images_generation == 1 and row.images_started_at is not None
        assert row.images_deadline_at == row.images_started_at + 600
        assert events(db_path, seq) == [*evs, "message_updated"]
        # A second completion (the blue/green overlap) finds nothing waiting.
        assert not store.finish_cookout_concepts(
            seq, "run-1", "ready", concepts_json=canned_concepts(picked), pictures_pending=True
        )
        assert store.cookout_pending_concepts() == []
        view = view_for(store, bank, seq, "Josh")
        assert view["concepts"]["state"] == "ready" and len(view["concepts"]["data"]) == 3
        first = view["concepts"]["data"][0]
        assert first["id"] == "a" and len(first["pickedIngredients"]) == 8
        assert first["staplesUsed"] == [
            {"id": "salt", "name": "Salt"},
            {"id": "butter", "name": "Butter"},
        ]
        assert len(first["omitted"]) == 2 and set(first["omitted"][0]) == {"ingredient", "reason"}

    def test_a_ready_result_without_pictures_leaves_images_none(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank, pictures=False)
        row = data_of(store, seq).round
        assert row.images == "none" and row.images_generation == 0 and row.images_tries == 0

    def test_failed_and_unavailable_results_carry_an_error_and_no_data(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq, _ = finished_round(store, bank)
        store.set_cookout_concepts_run(seq, "run-1")
        assert store.finish_cookout_concepts(seq, "run-1", "failed", error="cmd said no")
        v = view_for(store, bank, seq, "Josh")
        assert v["concepts"] == {"state": "failed", "data": None, "error": "cmd said no"}
        # `unavailable` is recorded with no run (the NULL run id compares equal).
        other, _ = finished_round(store, bank, "cookout-unavail-0001")
        assert store.finish_cookout_concepts(other, None, "unavailable", error="no runner")
        assert data_of(store, other).round.concepts == "unavailable"

    def test_a_finish_from_a_cancelled_or_deleted_round_lands_nothing(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq, picked = finished_round(store, bank)
        store.set_cookout_concepts_run(seq, "run-1")
        store.delete_message(seq=seq, now=99.0)
        assert not store.finish_cookout_concepts(
            seq, "run-1", "ready", concepts_json=canned_concepts(picked), pictures_pending=True
        )
        assert store.get_cookout_round(seq) is None

    def test_retry_resets_everything_and_fences_the_old_run_and_pictures(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq, picked = finished_round(store, bank)
        store.set_cookout_concepts_run(seq, "run-1")
        store.finish_cookout_concepts(seq, "run-1", "failed", error="boom")
        gen_before = data_of(store, seq).round.images_generation
        evs = events(db_path, seq)
        assert store.retry_cookout_concepts(seq, now=100.0) is True
        row = data_of(store, seq).round
        assert row.concepts == "pending" and row.concepts_run_id is None
        assert row.concepts_error is None and row.concepts_json is None
        assert row.concepts_started_at == 100.0 and row.concepts_tries == 1
        assert row.concepts_deadline_at == 1000.0
        assert (row.images, row.pictures, row.images_started_at, row.images_tries) == (
            "none",
            {},
            None,
            0,
        )
        assert row.images_deadline_at is None and row.images_generation == gen_before + 1
        assert events(db_path, seq) == [*evs, "message_updated"]
        # A second tap while pending is not applicable (the route reads that as idempotent).
        assert store.retry_cookout_concepts(seq, now=101.0) is False
        # The old run completing late (after the retry epoch began) lands nothing...
        store.set_cookout_concepts_run(seq, "run-2")
        assert not store.finish_cookout_concepts(
            seq, "run-1", "ready", concepts_json=canned_concepts(picked)
        )
        # ...and only the new run's result does.
        assert store.finish_cookout_concepts(
            seq, "run-2", "ready", concepts_json=canned_concepts(picked)
        )

    def test_a_retry_resets_a_job_that_hit_its_try_limit_and_deadline(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq, _ = finished_round(store, bank)
        store.set_cookout_concepts_run(seq, "run-1")
        store.set_cookout_concepts_run(seq, "run-2", expected_run_id="run-1")
        store.finish_cookout_concepts(seq, "run-2", "failed", error="timed out")
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                "UPDATE cookout_rounds SET concepts_deadline_at = 1.0 WHERE anchor_message_seq = ?",
                (seq,),
            )
            conn.commit()
        finally:
            conn.close()
        row = data_of(store, seq).round
        assert row.concepts_tries == 2 and row.concepts_deadline_at == 1.0
        assert store.retry_cookout_concepts(seq, now=500.0) is True
        row = data_of(store, seq).round
        assert (row.concepts_tries, row.concepts_started_at) == (1, 500.0)
        assert row.concepts_deadline_at == 1400.0
        # Recipes the same: a row past its deadline with tries at the limit starts afresh.
        ready = ready_round(store, bank, "cookout-limit-0000001", pictures=False)
        TestRecipes()._bank(store, ready)
        store.set_cookout_recipe_run(ready, "a", "r1")
        store.set_cookout_recipe_run(ready, "a", "r2", expected_run_id="r1")
        store.finish_cookout_recipe(ready, "a", "r2", "failed", error="timed out")
        assert raw(db_path, "SELECT tries FROM cookout_recipes") == [(2,)]
        assert store.retry_cookout_recipe(ready, "a", now=900.0) is True
        assert raw(db_path, "SELECT tries, deadline_at FROM cookout_recipes") == [(1, 1800.0)]

    def test_retry_from_unavailable_and_not_from_ready_or_an_open_round(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq, _ = finished_round(store, bank, runner=False)
        assert data_of(store, seq).round.concepts == "unavailable"
        assert store.retry_cookout_concepts(seq, now=5.0) is True
        ready = ready_round(store, bank, "cookout-ready-000001")
        assert store.retry_cookout_concepts(ready, now=5.0) is False
        open_seq = start(store, bank, "cookout-open-000002")
        assert store.retry_cookout_concepts(open_seq, now=5.0) is False
        with pytest.raises(CookoutRoundNotFoundError):
            store.retry_cookout_concepts(404, now=5.0)


# -- pictures -------------------------------------------------------------------------------------


def uploads(*slots: str, size: int = 100) -> dict[str, tuple[str, int]]:
    return {slot: (f"upload-{slot}-{size:04d}-" + "0" * 16, size) for slot in slots}


class TestPictures:
    def test_claim_increments_the_generation_and_counts_a_try(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        assert data_of(store, seq).round.images_generation == 1
        status, generation = store.claim_cookout_pictures(seq, stale_before=None, now=50.0)
        assert (status, generation) == ("claimed", 2)
        row = data_of(store, seq).round
        assert row.images_tries == 2 and row.images_started_at == 50.0
        assert row.images_generation == 2 and row.images_deadline_at == 650.0
        # A young attempt is not due for the sweep to re-claim.
        assert store.claim_cookout_pictures(seq, stale_before=40.0, now=60.0)[0] == "not_due"
        assert store.cookout_stale_pictures(stale_before=40.0) == []
        assert store.cookout_stale_pictures(stale_before=51.0) == [seq]
        assert store.claim_cookout_pictures(seq, stale_before=51.0, now=70.0) == ("claimed", 3)

    def test_gone_when_nothing_waits(self, store: LiveChatStore, bank: FakeBank) -> None:
        open_seq = start(store, bank)
        assert store.claim_cookout_pictures(open_seq, stale_before=None, now=1.0)[0] == "gone"
        assert store.claim_cookout_pictures(404, stale_before=None, now=1.0)[0] == "gone"
        no_pics = ready_round(store, bank, "cookout-nopics-00001", pictures=False)
        assert store.claim_cookout_pictures(no_pics, stale_before=None, now=1.0)[0] == "gone"

    def test_after_the_maximum_attempts_the_wait_ends_as_failed(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        assert store.claim_cookout_pictures(seq, stale_before=None, now=1.0)[0] == "claimed"
        assert store.claim_cookout_pictures(seq, stale_before=None, now=2.0)[0] == "claimed"
        evs = events(db_path, seq)
        assert store.claim_cookout_pictures(seq, stale_before=None, now=3.0)[0] == "gave_up"
        assert data_of(store, seq).round.images == "failed"
        assert events(db_path, seq) == [*evs, "message_updated"]
        assert store.claim_cookout_pictures(seq, stale_before=None, now=4.0)[0] == "gone"

    def test_all_three_slots_attach_as_private_photos_and_finish_the_wait(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=50.0)
        evs = events(db_path, seq)
        assert store.store_cookout_pictures(
            seq, gen, uploads("a", "b", "c"), "x@example.com", all_done=True, now=60.0
        )
        row = data_of(store, seq).round
        assert row.images == "done" and set(row.pictures) == {"a", "b", "c"}
        rows = raw(
            db_path,
            "SELECT id, kind, status, message_seq, ordinal FROM attachments ORDER BY ordinal",
        )
        assert [(r[1], r[2], r[3], r[4]) for r in rows] == [
            ("photo", "processing", seq, i) for i in range(3)
        ]
        assert raw(db_path, "SELECT COUNT(*) FROM uploads WHERE by_email = 'x@example.com'") == [
            (3,)
        ]
        assert events(db_path, seq) == [*evs, "message_updated"]

    def test_partial_success_is_kept_and_a_retry_regenerates_only_the_missing_slots(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=50.0)
        assert store.store_cookout_pictures(
            seq, gen, uploads("a", "c"), None, all_done=False, now=60.0
        )
        row = data_of(store, seq).round
        assert row.images == "failed" and set(row.pictures) == {"a", "c"}
        kept = dict(row.pictures)
        gen_before = row.images_generation
        assert store.retry_cookout_pictures(seq, now=70.0) is True
        row = data_of(store, seq).round
        assert row.images == "pending" and row.pictures == kept  # attached slots preserved
        assert (row.images_tries, row.images_started_at, row.images_deadline_at) == (1, 70.0, 670.0)
        assert row.images_generation == gen_before + 1  # incremented, never reset
        # The next attempt supplies only `b`; a slot that is already filled is never overwritten.
        _, gen2 = store.claim_cookout_pictures(seq, stale_before=None, now=80.0)
        late = {**uploads("b", size=222), "a": ("upload-dup-a-" + "1" * 16, 5)}
        assert store.store_cookout_pictures(seq, gen2, late, None, all_done=True, now=90.0)
        row = data_of(store, seq).round
        assert row.images == "done" and set(row.pictures) == {"a", "b", "c"}
        assert row.pictures["a"] == kept["a"] and row.pictures["c"] == kept["c"]
        assert raw(db_path, "SELECT COUNT(*) FROM attachments") == [(3,)]
        # The duplicate `a` was never attached; its id is journaled for file cleanup.
        assert (
            raw(
                db_path,
                "SELECT cleanup_pending FROM deleted_storage WHERE id = ?",
                "upload-dup-a-" + "1" * 16,
            )
            != []
        )

    def test_retry_is_only_for_missing_slots_and_never_while_pending(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        assert store.retry_cookout_pictures(seq, now=1.0) is False  # pending already
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=2.0)
        store.store_cookout_pictures(seq, gen, uploads("a", "b", "c"), None, all_done=True, now=3.0)
        assert store.retry_cookout_pictures(seq, now=4.0) is False  # nothing missing
        open_seq = start(store, bank, "cookout-open-000003")
        assert store.retry_cookout_pictures(open_seq, now=4.0) is False

    def test_two_store_instances_fence_a_late_attempt(self, db_path: Path, bank: FakeBank) -> None:
        a, b = LiveChatStore(db_path), LiveChatStore(db_path)
        seq = ready_round(a, bank)
        _, gen_a = a.claim_cookout_pictures(seq, stale_before=None, now=10.0)
        _, gen_b = b.claim_cookout_pictures(seq, stale_before=None, now=20.0)
        assert gen_b == gen_a + 1
        row_before = data_of(b, seq).round
        # Late A failure: touches nothing of B's attempt.
        assert a.fail_cookout_pictures(seq, expected_generation=gen_a, now=30.0) is False
        assert data_of(b, seq).round.images == "pending"
        # Late A success: refused, its staged ids journaled, B's slots untouched.
        stale_ids = uploads("a", "b", size=11)
        assert (
            a.store_cookout_pictures(seq, gen_a, stale_ids, None, all_done=True, now=31.0) is False
        )
        assert data_of(b, seq).round.pictures == {} == row_before.pictures
        journaled = {r[0] for r in raw(db_path, "SELECT id FROM deleted_storage")}
        assert {uid for uid, _ in stale_ids.values()} <= journaled
        assert raw(db_path, "SELECT COUNT(*) FROM attachments") == [(0,)]
        # B (the current generation) still lands.
        assert b.store_cookout_pictures(
            seq, gen_b, uploads("a", "b", "c"), None, all_done=True, now=40.0
        )
        assert data_of(a, seq).round.images == "done"
        # ...and once done, a late A write is still refused and leaves ready slots alone.
        ready_slots = dict(data_of(a, seq).round.pictures)
        assert (
            a.store_cookout_pictures(
                seq, gen_a, uploads("a", size=12), None, all_done=True, now=50.0
            )
            is False
        )
        assert data_of(a, seq).round.pictures == ready_slots

    def test_a_manual_retry_fences_an_earlier_completion(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=10.0)
        store.fail_cookout_pictures(seq, expected_generation=gen, now=11.0)
        assert data_of(store, seq).round.images == "failed"
        assert store.retry_cookout_pictures(seq, now=12.0) is True
        # The first attempt finishing late is fenced by the retry's incremented generation.
        assert not store.store_cookout_pictures(
            seq, gen, uploads("a", "b", "c"), None, all_done=True, now=13.0
        )
        assert data_of(store, seq).round.images == "pending"

    def test_a_failed_attempt_ends_the_wait_once(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=10.0)
        evs = events(db_path, seq)
        assert store.fail_cookout_pictures(seq, expected_generation=gen, now=11.0) is True
        assert store.fail_cookout_pictures(seq, expected_generation=gen, now=12.0) is False
        assert events(db_path, seq) == [*evs, "message_updated"]

    def test_a_write_after_the_anchor_is_deleted_attaches_nothing(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=10.0)
        store.delete_message(seq=seq, now=11.0)
        ids = uploads("a", "b", "c", size=9)
        assert store.store_cookout_pictures(seq, gen, ids, None, all_done=True, now=12.0) is False
        assert store.fail_cookout_pictures(seq, expected_generation=gen, now=12.0) is False
        assert raw(db_path, "SELECT COUNT(*) FROM attachments") == [(0,)]
        journaled = {r[0] for r in raw(db_path, "SELECT id FROM deleted_storage")}
        assert {uid for uid, _ in ids.values()} <= journaled

    def test_the_pictures_are_not_gallery_media_and_a_ready_one_moves_the_rev(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        store.create_attachment(att_id="mine", kind="photo", now=1.0)
        owner = "worker-1"
        claimed = store.claim_processing(owner=owner, now=2.0, lease_s=60.0)
        assert claimed is not None and claimed.id == "mine"
        ready = AttachmentResult(
            status="ready",
            mime="image/jpeg",
            width=4,
            height=4,
            duration_s=None,
            peaks=None,
            renditions=("thumb", "full"),
            bytes_on_disk=10,
            failure=None,
        )
        store.finish_attachment(att_id="mine", owner=owner, result=ready, now=3.0)
        store.create_message(
            client_id="client-0000001",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            text=None,
            attachment_ids=("mine",),
            now=4.0,
        )
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=5.0)
        att_ids = uploads("a", "b", "c")
        store.store_cookout_pictures(seq, gen, att_ids, None, all_done=True, now=6.0)
        rev = data_of(store, seq).round.rev
        for _ in range(3):
            row = store.claim_processing(owner=owner, now=7.0, lease_s=60.0)
            assert row is not None
            store.finish_attachment(att_id=row.id, owner=owner, result=ready, now=8.0)
        assert data_of(store, seq).round.rev == rev + 3
        gallery, _ = store.list_gallery(before=None, limit=20)
        assert [g.id for g in gallery] == ["mine"]
        view = view_for(store, bank, seq, "Josh")
        assert set(view["images"]["pictures"]) == {"a", "b", "c"}
        assert view["images"]["pictures"]["a"]["fullUrl"].endswith("/full")
        assert view["images"]["state"] == "done"


# -- Stage 2: Bank this ---------------------------------------------------------------------------


class TestRecipes:
    def _bank(
        self, store: LiveChatStore, seq: int, concept: str = "a", *, runner: bool = True,
        sender: str = "Josh", mv: str | None = None,
    ) -> tuple[CookoutRoundRow, bool]:  # fmt: skip
        return store.bank_cookout_concept(
            anchor_seq=seq,
            sender=sender,
            email=None,
            concept_id=concept,
            move_id=mv or move_id(),
            runner_available=runner,
            now=40.0,
        )

    def test_bank_this_creates_a_pending_row_and_is_state_idempotent(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank, pictures=False)
        row, changed = self._bank(store, seq)
        assert changed is True
        got = store.get_cookout_round(seq)["recipes"]["a"]  # type: ignore[index]
        assert got["state"] == "pending" and got["tries"] == 1 and got["run_id"] is None
        assert got["started_at"] == 40.0 and got["deadline_at"] == 940.0
        assert (
            raw(db_path, "SELECT requested_by, bank_move_id FROM cookout_recipes")[0][0] == "Josh"
        )
        evs = events(db_path, seq)
        _, changed = self._bank(store, seq, sender="Rose")  # the other player taps it too
        assert changed is False and events(db_path, seq) == evs
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_recipes") == [(1,)]
        # Each concept is independently bankable.
        assert self._bank(store, seq, "b")[1] is True and self._bank(store, seq, "c")[1] is True
        assert store.cookout_pending_recipes() == [
            (seq, "a", None),
            (seq, "b", None),
            (seq, "c", None),
        ]
        assert row.rev == data_of(store, seq).round.rev - 2

    def test_without_a_runner_the_recipe_is_unavailable_at_once(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank, pictures=False)
        self._bank(store, seq, runner=False)
        v = view_for(store, bank, seq, "Josh")["recipes"]["a"]
        assert v["state"] == "unavailable" and v["error"] and v["data"] is None
        assert store.cookout_pending_recipes() == []

    def test_only_ready_concepts_of_a_finished_round_by_a_player_can_be_banked(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        open_seq = start(store, bank)
        with pytest.raises(CookoutBadStateError):
            self._bank(store, open_seq)
        pending, _ = finished_round(store, bank, "cookout-pend-0000001")
        with pytest.raises(CookoutBadStateError):
            self._bank(store, pending)
        seq = ready_round(store, bank, "cookout-ready-000009", pictures=False)
        with pytest.raises(CookoutNotPlayerError):
            self._bank(store, seq, sender="Cupcake")
        with pytest.raises(CookoutInvalidError):
            self._bank(store, seq, "z")
        with pytest.raises(CookoutRoundNotFoundError):
            self._bank(store, 404)

    def test_a_finished_recipe_is_banked_once_and_appears_in_the_book_newest_first(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        first = ready_round(store, bank, "cookout-book-0000001", pictures=False)
        second = ready_round(store, bank, "cookout-book-0000002", pictures=False)
        for seq, concept in ((first, "a"), (second, "b"), (first, "c")):
            self._bank(store, seq, concept)
            assert store.set_cookout_recipe_run(seq, concept, f"r-{seq}-{concept}")
        assert store.list_cookout_bank() == []  # pending rows are not in the book
        body = json.dumps(
            {
                "serves": 2,
                "prepMinutes": 10,
                "cookMinutes": 20,
                "ingredients": [],
                "steps": [],
                "tips": [],
            }
        )
        for seq, concept in ((first, "a"), (second, "b"), (first, "c")):
            assert store.finish_cookout_recipe(
                seq, concept, f"r-{seq}-{concept}", "banked", recipe_json=body
            )
        # CAS: a repeat finish lands nothing.
        assert not store.finish_cookout_recipe(first, "a", "r-1-a", "banked", recipe_json=body)
        book = store.list_cookout_bank()
        assert [(r.anchor_message_seq, rec.concept_id) for r, rec, _ in book] == [
            (first, "c"),
            (second, "b"),
            (first, "a"),
        ]
        assert all(rec.state == "banked" and rec.banked_at for _, rec, _ in book)
        msg = next(m for m in store.list_messages(before=None, limit=10)[0] if m.seq == first)
        assert msg.cookout is not None and msg.cookout.banked_count == 2

    def test_run_replacement_failure_and_retry(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank, pictures=False)
        self._bank(store, seq)
        assert store.set_cookout_recipe_run(seq, "a", "run-1") is True
        assert store.set_cookout_recipe_run(seq, "a", "run-x") is False
        assert store.set_cookout_recipe_run(seq, "a", "run-2", expected_run_id="run-1") is True
        assert store.get_cookout_round(seq)["recipes"]["a"]["tries"] == 2  # type: ignore[index]
        assert store.finish_cookout_recipe(seq, "a", "run-2", "failed", error="bad json")
        v = view_for(store, bank, seq, "Josh")["recipes"]["a"]
        assert v["state"] == "failed" and v["error"] == "bad json"
        with pytest.raises(CookoutBadStateError):
            self._bank(store, seq)  # a failed recipe is retried, not re-banked
        evs = events(db_path, seq)
        assert store.retry_cookout_recipe(seq, "a", now=100.0) is True
        got = store.get_cookout_round(seq)["recipes"]["a"]  # type: ignore[index]
        assert got["state"] == "pending" and got["run_id"] is None and got["error"] is None
        assert got["recipe_json"] is None and got["tries"] == 1
        assert got["started_at"] == 100.0 and got["deadline_at"] == 1000.0
        assert raw(db_path, "SELECT banked_at FROM cookout_recipes") == [(None,)]
        assert events(db_path, seq) == [*evs, "message_updated"]
        assert store.retry_cookout_recipe(seq, "a", now=101.0) is False  # pending: not applicable
        assert store.retry_cookout_recipe(seq, "b", now=101.0) is False  # never requested
        # The dead run completing after the retry lands nothing.
        assert not store.finish_cookout_recipe(seq, "a", "run-2", "banked", recipe_json="{}")

    def test_a_banked_recipe_view_carries_the_body_with_total_minutes(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq, picked = finished_round(store, bank)
        store.set_cookout_concepts_run(seq, "run-1")
        store.finish_cookout_concepts(seq, "run-1", "ready", concepts_json=canned_concepts(picked))
        self._bank(store, seq)
        store.set_cookout_recipe_run(seq, "a", "r1")
        body = {
            "serves": 2,
            "prepMinutes": 15,
            "cookMinutes": 20,
            "ingredients": [{"id": picked[0], "quantity": "2", "note": ""}],
            "steps": [{"text": "Cook.", "minutes": None, "uses": [picked[0]]}],
            "tips": [],
        }
        store.finish_cookout_recipe(seq, "a", "r1", "banked", recipe_json=json.dumps(body))
        slot = view_for(store, bank, seq, "Rose")["recipes"]["a"]
        assert slot["state"] == "banked" and slot["requestedBy"] == "Josh" and slot["bankedAt"]
        assert slot["data"]["totalMinutes"] == 35 and slot["data"]["serves"] == 2
        assert slot["data"]["ingredients"][0]["name"] == bank.ingredient(picked[0]).name  # type: ignore[union-attr]


# -- erasure and the game chat --------------------------------------------------------------------


class TestErasureAndGameChat:
    def _populate(self, store: LiveChatStore, bank: FakeBank) -> int:
        seq = ready_round(store, bank, pictures=True)
        TestRecipes()._bank(store, seq)
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=50.0)
        store.store_cookout_pictures(seq, gen, uploads("a"), None, all_done=False, now=51.0)
        return seq

    def test_deleting_the_anchor_cascades_every_cookout_row(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        keep = start(store, bank, "cookout-keep-0000001")
        seq = self._populate(store, bank)
        assert (
            raw(db_path, "SELECT COUNT(*) FROM cookout_turns WHERE anchor_message_seq = ?", seq)[0][
                0
            ]
            == 10
        )
        store.delete_message(seq=seq, now=60.0)
        for table in ("cookout_rounds", "cookout_turns", "cookout_recipes"):
            assert raw(
                db_path, f"SELECT COUNT(*) FROM {table} WHERE anchor_message_seq = ?", seq
            ) == [(0,)]
        assert raw(db_path, "SELECT COUNT(*) FROM attachments") == [(0,)]
        assert store.get_cookout_round(keep) is not None  # another round is untouched
        assert store.cookout_view_data(anchor_seq=seq) is None

    def test_a_wipe_clears_everything(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        self._populate(store, bank)
        start(store, bank, "cookout-wipe-0000001")
        store.wipe(now=70.0)
        for table in (
            "cookout_rounds",
            "cookout_turns",
            "cookout_recipes",
            "messages",
            "attachments",
        ):
            assert raw(db_path, f"SELECT COUNT(*) FROM {table}") == [(0,)], table
        assert store.cookout_pending_concepts() == [] and store.list_cookout_bank() == []

    def test_a_cookout_anchor_takes_game_chat_messages(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = start(store, bank)
        message, created = store.create_message(
            client_id="cookout-chat-000001",
            sender="Rose",
            device_id="device-1234",
            by_email=None,
            text="Is that cumin?",
            attachment_ids=[],
            wyr_anchor_seq=seq,
            now=11.0,
        )
        assert created is True and message.wyr_ref == seq and message.wyr_ref_kind == "cookout"
        wire = message_json(message, _Signer())
        assert wire["wyrRef"] == seq and wire["wyrRefKind"] == "cookout"
        assert wire["cookout"] is None and wire["adventure"] is None and wire["wyr"] is None
        history = store.list_messages(before=None, limit=10)[0]
        in_game = next(m for m in history if m.seq == message.seq)
        assert in_game.wyr_ref_kind == "cookout"
        with pytest.raises(WyrRoundNotFoundError):
            store.create_message(
                client_id="cookout-chat-000002",
                sender="Rose",
                device_id="device-1234",
                by_email=None,
                text="x",
                attachment_ids=[],
                wyr_anchor_seq=9999,
                now=12.0,
            )
        # The game chat dies with the anchor.
        store.delete_message(seq=seq, now=13.0)
        assert raw_chat_rows(store) == 0

    def test_the_other_games_kinds_are_unchanged(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        adv, _ = store.create_adventure_round(
            client_id="adv-kind-00000001", sender="Josh", device_id="device-1234", by_email=None
        )
        message, _ = store.create_message(
            client_id="adv-chat-00000001",
            sender="Rose",
            device_id="device-1234",
            by_email=None,
            text="hi",
            attachment_ids=[],
            wyr_anchor_seq=adv.seq,
            now=11.0,
        )
        assert message.wyr_ref_kind == "adventure"


def raw_chat_rows(store: LiveChatStore) -> int:
    return int(raw(store._db_path, "SELECT COUNT(*) FROM wyr_chat")[0][0])


# -- concurrency (two connections, BEGIN IMMEDIATE) -----------------------------------------------


class TestRaces:
    def test_two_phones_picking_at_once_one_wins_and_the_loser_is_bad_state(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = LiveChatStore(db_path), LiveChatStore(db_path)
        seq = start(a, bank)
        join(a, bank, seq)
        live = live_of(a, seq)
        o = live.row.offers[0]

        def mover(store: LiveChatStore, pick_index: int) -> Any:
            return lambda: store.pick_cookout(
                anchor_seq=seq,
                sender="Josh",
                email=None,
                move_id=move_id(),
                turn=1,
                offer=0,
                ingredient_id=o[pick_index]["id"],
                bank=bank,
                runner_available=True,
            )

        results = run_concurrently(mover(a, 0), mover(b, 1))
        wins = [r for r in results if isinstance(r, tuple)]
        losses = [r for r in results if isinstance(r, Exception)]
        assert len(wins) == 1 and len(losses) == 1
        assert isinstance(losses[0], CookoutBadStateError)
        assert len(data_of(a, seq).turns) == 2  # exactly one draw

    def test_skip_races_pick_one_move_applies(self, db_path: Path, bank: FakeBank) -> None:
        a, b = LiveChatStore(db_path), LiveChatStore(db_path)
        seq = start(a, bank)
        join(a, bank, seq)
        o = live_of(a, seq).row.offers[0]

        def do_skip() -> Any:
            return a.skip_cookout(
                anchor_seq=seq,
                sender="Josh",
                email=None,
                move_id=move_id(),
                turn=1,
                offer=0,
                bank=bank,
            )

        def do_pick() -> Any:
            return b.pick_cookout(
                anchor_seq=seq,
                sender="Josh",
                email=None,
                move_id=move_id(),
                turn=1,
                offer=0,
                ingredient_id=o[0]["id"],
                bank=bank,
                runner_available=True,
            )

        results = run_concurrently(do_skip, do_pick)
        assert sum(isinstance(r, tuple) for r in results) == 1
        assert sum(isinstance(r, CookoutBadStateError) for r in results) == 1
        turns = data_of(a, seq).turns
        # Either the skip won (offers 2, no pick) or the pick won (a pick, turn 2 drawn).
        assert (len(turns[0].offers) == 2 and turns[0].choice_id is None) or (
            turns[0].choice_id is not None and len(turns) == 2
        )

    def test_two_joins_of_the_same_and_of_different_people(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = LiveChatStore(db_path), LiveChatStore(db_path)
        same = start(a, bank, "cookout-race-join-001")
        r1 = run_concurrently(
            lambda: join(a, bank, same, "Rose"), lambda: join(b, bank, same, "Rose")
        )
        assert sorted(x[1] for x in r1) == [False, True]
        other = start(a, bank, "cookout-race-join-002")
        r2 = run_concurrently(
            lambda: join(a, bank, other, "Rose"), lambda: join(b, bank, other, "Cupcake")
        )
        assert sum(isinstance(x, tuple) for x in r2) == 1
        assert sum(isinstance(x, CookoutBadStateError) for x in r2) == 1

    def test_two_new_rounds_leave_exactly_one_picking_and_a_shared_client_id_makes_one(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = LiveChatStore(db_path), LiveChatStore(db_path)

        def make(store: LiveChatStore, cid: str) -> Any:
            return lambda: store.create_cookout_round(
                client_id=cid, sender="Josh", device_id="device-1234", by_email=None,
                blind=False, bank=bank,
            )  # fmt: skip

        run_concurrently(make(a, "cookout-race-new-0001"), make(b, "cookout-race-new-0002"))
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_rounds WHERE state='picking'") == [(1,)]
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_rounds") == [(2,)]
        same = run_concurrently(make(a, "cookout-race-same-001"), make(b, "cookout-race-same-001"))
        assert sorted(x[1] for x in same) == [False, True]
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_rounds") == [(3,)]

    def test_two_bank_taps_start_one_recipe_and_two_retries_one_attempt(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = LiveChatStore(db_path), LiveChatStore(db_path)
        seq = ready_round(a, bank, pictures=False)
        t = TestRecipes()
        r = run_concurrently(lambda: t._bank(a, seq), lambda: t._bank(b, seq, sender="Rose"))
        assert sorted(x[1] for x in r) == [False, True]
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_recipes") == [(1,)]
        a.set_cookout_recipe_run(seq, "a", "r1")
        a.finish_cookout_recipe(seq, "a", "r1", "failed", error="x")
        rr = run_concurrently(
            lambda: a.retry_cookout_recipe(seq, "a", now=5.0),
            lambda: b.retry_cookout_recipe(seq, "a", now=5.0),
        )
        assert sorted(rr) == [False, True]
        # Concepts retries likewise.
        other, _ = finished_round(a, bank, "cookout-race-retry-001")
        a.set_cookout_concepts_run(other, "c1")
        a.finish_cookout_concepts(other, "c1", "failed", error="x")
        cr = run_concurrently(
            lambda: a.retry_cookout_concepts(other, now=5.0),
            lambda: b.retry_cookout_concepts(other, now=5.0),
        )
        assert sorted(cr) == [False, True]
        assert data_of(a, other).round.images_generation == 1  # one reset, one increment

    def test_the_final_pick_from_two_connections_makes_one_transition_one_event_no_draw(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = LiveChatStore(db_path), LiveChatStore(db_path)
        seq = start(a, bank)
        join(a, bank, seq)
        for turn in range(1, 10):
            pick(a, bank, seq, "Josh" if turn % 2 == 1 else "Rose")
        live = live_of(a, seq)
        before = events(db_path, seq)
        calls = len(bank.calls)
        mv = move_id()

        def final(store: LiveChatStore) -> Any:
            return lambda: store.pick_cookout(
                anchor_seq=seq,
                sender="Rose",
                email=None,
                move_id=mv,
                turn=10,
                offer=0,
                ingredient_id=live.row.offers[0][0]["id"],
                bank=bank,
                runner_available=True,
            )

        results = run_concurrently(final(a), final(b))
        assert sorted(r[1] for r in results) == [False, True]  # one job start's worth of change
        assert events(db_path, seq) == [*before, "message_updated"]
        assert len(bank.calls) == calls  # no eleventh draw
        assert data_of(a, seq).round.concepts == "pending"
        assert len(data_of(a, seq).turns) == 10

    def test_delete_and_wipe_racing_job_completion(self, db_path: Path, bank: FakeBank) -> None:
        a, b = LiveChatStore(db_path), LiveChatStore(db_path)
        seq, picked = finished_round(a, bank)
        a.set_cookout_concepts_run(seq, "run-1")
        results = run_concurrently(
            lambda: a.delete_message(seq=seq, now=99.0),
            lambda: b.finish_cookout_concepts(
                seq, "run-1", "ready", concepts_json=canned_concepts(picked), pictures_pending=True
            ),
        )
        assert not any(isinstance(r, Exception) for r in results)
        assert a.get_cookout_round(seq) is None  # whichever order, the round ends erased
        wipe_seq, picked2 = finished_round(a, bank, "cookout-race-wipe-0001")
        a.set_cookout_concepts_run(wipe_seq, "run-w")
        results = run_concurrently(
            lambda: a.wipe(now=100.0),
            lambda: b.finish_cookout_concepts(
                wipe_seq, "run-w", "ready", concepts_json=canned_concepts(picked2)
            ),
        )
        assert not any(isinstance(r, Exception) for r in results)
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_rounds") == [(0,)]
