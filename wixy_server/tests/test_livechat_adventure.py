"""Adventure Time, store level (workspace 00056, spec/server-chat/08-adventure-time.md §4.1/§4.2,
Inv 56): schema v20 and its migration from a real v19 database, the round state machine and every
transition's idempotency, the destination exclusion maths, the never-again list, the holiday-pack
compare-and-sets, the game chat reusing `wyr_chat`, erasure (anchor delete, wipe) and concurrency.
The routes are in `test_routes_livechat_adventure.py`, the pack job in
`test_livechat_adventure_pack.py`, the bank in `test_adventure_bank.py`."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any

import pytest

from wixy_server.livechat.adventure_bank import AdventureBank
from wixy_server.livechat.models import message_json
from wixy_server.livechat.store import (
    _LATEST_SCHEMA_VERSION,
    ADVENTURE_PACK_STOPPED_TEXT,
    ADVENTURE_PACK_UNAVAILABLE_TEXT,
    AdventureBadStateError,
    AdventureExhaustedError,
    AdventureInvalidError,
    AdventureRoundNotFoundError,
    AdventureTooEarlyError,
    LiveChatStore,
    WyrRoundNotFoundError,
)
from wixy_server.tests.adventure_testkit import (
    SPIN_DELTA,
    SPIN_DURATION_MS,
    SPIN_FROM,
    fixture_bank,
    landing_for,
    roulette_open,
    run_concurrently,
    start_round,
    stop_country,
    stop_destination,
    to_chosen,
    to_country,
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


@pytest.fixture
def bank() -> AdventureBank:
    return fixture_bank()


def _count(db_path: Path, table: str) -> int:
    conn = sqlite3.connect(str(db_path))
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    finally:
        conn.close()


def _events(db_path: Path, seq: int) -> list[str]:
    conn = sqlite3.connect(str(db_path))
    try:
        return [
            r[0]
            for r in conn.execute(
                "SELECT type FROM events WHERE message_seq = ? ORDER BY event_seq", (seq,)
            )
        ]
    finally:
        conn.close()


def _raw_db(db_path: Path) -> bytes:
    wal = Path(f"{db_path}-wal")
    return db_path.read_bytes() + (wal.read_bytes() if wal.exists() else b"")


# -- schema ---------------------------------------------------------------------------------------


class TestSchema:
    def test_a_fresh_database_is_v20_with_the_adventure_tables(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        assert _LATEST_SCHEMA_VERSION == 20
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 20
            names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
            assert {"adv_rounds", "idx_adv_rounds_state", "adv_rejected"} <= names
            columns = {r[1] for r in conn.execute("PRAGMA table_info(adv_rounds)")}
            assert columns == {
                "anchor_message_seq",
                "state",
                "started_by",
                "spin_lng",
                "spin_lat",
                "landing",
                "country_candidates",
                "country_seed",
                "country_roulette_at",
                "country_id",
                "country_by",
                "dest_candidates",
                "dest_seed",
                "dest_roulette_at",
                "destination_id",
                "destination_by",
                "pack",
                "pack_run_id",
                "pack_json",
                "pack_error",
                "decided_by",
                "rev",
                "created_at",
                "updated_at",
            }
            assert [r[1] for r in conn.execute("PRAGMA table_info(adv_rejected)")] == [
                "destination_id"
            ]
        finally:
            conn.close()

    def test_check_constraints_refuse_an_unknown_state_or_pack(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        seq = start_round(store)
        conn = sqlite3.connect(str(db_path))
        try:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute("UPDATE adv_rounds SET state = 'nonsense' WHERE 1")
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute("UPDATE adv_rounds SET pack = 'nonsense' WHERE 1")
        finally:
            conn.close()
        assert store.get_adventure_round(anchor_seq=seq) is not None

    def test_a_real_v19_database_gains_the_tables_and_keeps_everything(
        self, db_path: Path
    ) -> None:
        old = LiveChatStore(db_path)
        old.list_messages(before=None, limit=1)
        message, _ = old.create_message(
            client_id="old-message-0001",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            text="a v19 message",
            attachment_ids=[],
            now=5.0,
        )
        wyr, _ = old.create_wyr_round(
            client_id="old-wyr-round-01",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            question_id="q0001",
            images_pending=False,
            now=6.0,
        )
        old.set_wyr_topics(["food-meals"])
        conn = sqlite3.connect(str(db_path))
        try:
            wyr_columns_before = [r[1] for r in conn.execute("PRAGMA table_info(wyr_rounds)")]
            conn.execute("DROP INDEX idx_adv_rounds_state")
            conn.execute("DROP TABLE adv_rounds")
            conn.execute("DROP TABLE adv_rejected")
            conn.execute("PRAGMA user_version = 19")
            conn.commit()
        finally:
            conn.close()

        migrated = LiveChatStore(db_path)
        listed, _more, _cursor = migrated.list_messages(before=None, limit=10)
        assert {m.seq for m in listed} == {message.seq, wyr.seq}
        assert all(m.adventure is None for m in listed)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 20
            names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
            assert {"adv_rounds", "idx_adv_rounds_state", "adv_rejected", "wyr_chat"} <= names
            # v19 is deployed and is never edited.
            assert [r[1] for r in conn.execute("PRAGMA table_info(wyr_rounds)")] == (
                wyr_columns_before
            )
        finally:
            conn.close()
        assert migrated.wyr_selected_topics() == frozenset({"food-meals"})
        assert migrated.get_wyr_round(anchor_seq=wyr.seq) is not None
        seq = start_round(migrated, "new-adventure-01")
        assert migrated.get_adventure_round(anchor_seq=seq) is not None
        again = LiveChatStore(db_path)  # a second open is a clean no-op
        assert len(again.list_messages(before=None, limit=10)[0]) == 3

    def test_the_cascade_erases_a_round_even_from_a_connection_that_never_heard_of_it(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        seq = start_round(store)
        assert _count(db_path, "adv_rounds") == 1
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("DELETE FROM messages WHERE seq = ?", (seq,))
            conn.commit()
        finally:
            conn.close()
        assert _count(db_path, "adv_rounds") == 0
        assert store.get_adventure_round(anchor_seq=seq) is None


# -- creating a round -------------------------------------------------------------------------


class TestCreate:
    def test_the_anchor_is_a_text_less_message_carrying_the_summary(
        self, store: LiveChatStore
    ) -> None:
        message, created = store.create_adventure_round(
            client_id="adv-create-0001", sender="Josh", device_id="dev-12345", by_email="a@b.c"
        )
        assert created is True
        assert message.text is None and message.attachments == ()
        assert message.adventure is not None
        assert (message.adventure.state, message.adventure.pack, message.adventure.rev) == (
            "spin_lng",
            "none",
            1,
        )
        wire = message_json(message, _Signer())
        assert wire["adventure"] == {"state": "spin_lng", "pack": "none", "rev": 1}
        assert wire["wyr"] is None and wire["wyrRef"] is None and wire["wyrRefKind"] is None
        row = store.get_adventure_round(anchor_seq=message.seq)
        assert row is not None
        assert row.started_by == "Josh" and row.state == "spin_lng" and row.pack == "none"
        assert row.spin_lng is None and row.landing is None and row.decided_by is None

    def test_a_replayed_client_id_returns_the_same_message(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        first, created = store.create_adventure_round(
            client_id="adv-replay-0001", sender="Josh", device_id="dev-12345", by_email=None
        )
        again, created_again = store.create_adventure_round(
            client_id="adv-replay-0001", sender="Rose", device_id="dev-67890", by_email=None
        )
        assert created is True and created_again is False
        assert again.seq == first.seq
        assert _count(db_path, "adv_rounds") == 1

    def test_the_summary_is_carried_by_every_read_path(self, store: LiveChatStore) -> None:
        seq = start_round(store)
        [by_get] = store.get_messages([seq])
        [by_list], _more, _cursor = store.list_messages(before=None, limit=5)
        assert by_get.adventure == by_list.adventure
        assert by_list.adventure is not None and by_list.adventure.state == "spin_lng"

    def test_starting_abandons_every_open_round_but_never_a_chosen_one(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        spinning = start_round(store, "adv-open-lng-0001")
        # A second adventure starting abandons the first (one live adventure at a time).
        landing = start_round(store, "adv-open-lat-0001")
        assert store.get_adventure_round(anchor_seq=spinning).state == "abandoned"  # type: ignore[union-attr]
        store.spin_adventure(
            anchor_seq=landing,
            sender="Josh",
            axis="lng",
            from_deg=SPIN_FROM,
            delta_deg=SPIN_DELTA,
            duration_ms=SPIN_DURATION_MS,
            now=50.0,
        )
        on_country = start_round(store, "adv-open-country-1")
        assert store.get_adventure_round(anchor_seq=landing).state == "abandoned"  # type: ignore[union-attr]
        country_row = to_country(store, on_country)
        on_destination = start_round(store, "adv-open-dest-0001")
        assert store.get_adventure_round(anchor_seq=on_country).state == "abandoned"  # type: ignore[union-attr]
        # Drive a round to `destination`, abandon it, then to `chosen` and keep it.
        assert country_row.state == "country"
        row = to_country(store, on_destination)
        row = stop_country(store, bank, on_destination, "AAA", row)
        assert row.state == "destination"
        chosen = start_round(store, "adv-chosen-00001")
        assert store.get_adventure_round(anchor_seq=on_destination).state == "abandoned"  # type: ignore[union-attr]
        to_chosen(store, bank, chosen)
        newest = start_round(store, "adv-newest-00001")
        assert store.get_adventure_round(anchor_seq=chosen).state == "chosen"  # type: ignore[union-attr]
        assert store.get_adventure_round(anchor_seq=newest).state == "spin_lng"  # type: ignore[union-attr]
        # Each abandonment bumped the round and announced it.
        abandoned = store.get_adventure_round(anchor_seq=spinning)
        assert abandoned is not None and abandoned.rev == 2
        assert _events(db_path, spinning) == ["message", "message_updated"]

    def test_decided_rounds_are_left_alone_by_a_new_adventure(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        banked = start_round(store, "adv-banked-00001")
        to_chosen(store, bank, banked)
        store.decide_adventure(anchor_seq=banked, sender="Josh", decision="bank")
        rejected = start_round(store, "adv-rejected-0001")
        to_chosen(store, bank, rejected, unit="BBB")
        store.decide_adventure(anchor_seq=rejected, sender="Josh", decision="reject")
        start_round(store, "adv-after-000001")
        assert store.get_adventure_round(anchor_seq=banked).state == "banked"  # type: ignore[union-attr]
        assert store.get_adventure_round(anchor_seq=rejected).state == "rejected"  # type: ignore[union-attr]


# -- spinning -----------------------------------------------------------------------------------


class TestSpin:
    def test_the_sideways_spin_is_stored_once_and_advances_the_round(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        seq = start_round(store)
        row, changed = store.spin_adventure(
            anchor_seq=seq,
            sender="Bubble",
            axis="lng",
            from_deg=SPIN_FROM,
            delta_deg=SPIN_DELTA,
            duration_ms=SPIN_DURATION_MS,
            now=77.0,
        )
        assert changed is True and row.state == "spin_lat" and row.rev == 2
        assert row.spin_lng is not None
        assert row.spin_lng.to_json() == {
            "by": "Bubble",
            "from": SPIN_FROM,
            "delta": SPIN_DELTA,
            "durationMs": SPIN_DURATION_MS,
            "at": 77.0,
        }
        assert row.spin_lat is None and row.landing is None and row.country_seed is None
        assert _events(db_path, seq) == ["message", "message_updated"]

    def test_the_up_down_spin_stores_the_landing_candidates_seed_and_roulette_time(
        self, store: LiveChatStore
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq, unit="BBB", at=100.0, duration_ms=4000.0)
        landing, candidates = landing_for("BBB")
        assert row.landing == landing
        assert row.country_candidates == candidates
        assert row.spin_lat is not None and row.spin_lat.by == "Rose"
        assert row.spin_lat.at == 100.0
        assert row.country_seed is not None and 0 <= row.country_seed < 2**32
        # now + durationMs / 1000 + 5 s for the glide and the zoom.
        assert row.country_roulette_at == 100.0 + 4.0 + 5.0
        assert row.rev == 3

    def test_each_spin_draws_its_own_random_seed(self, store: LiveChatStore) -> None:
        seeds = set()
        for n in range(8):
            seq = start_round(store, f"adv-seed-{n:06d}")
            seeds.add(to_country(store, seq).country_seed)
        assert len(seeds) > 1

    def test_the_clock_is_sampled_after_the_write_lock_when_not_given(
        self, store: LiveChatStore
    ) -> None:
        seq = start_round(store)
        before = time.time()
        row, _ = store.spin_adventure(
            anchor_seq=seq,
            sender="Josh",
            axis="lng",
            from_deg=1.0,
            delta_deg=SPIN_DELTA,
            duration_ms=SPIN_DURATION_MS,
        )
        assert row.spin_lng is not None
        assert before <= row.spin_lng.at <= time.time()

    def test_the_wrong_axis_for_the_state_is_bad_state(self, store: LiveChatStore) -> None:
        seq = start_round(store)
        landing, candidates = landing_for()
        with pytest.raises(AdventureBadStateError):
            store.spin_adventure(
                anchor_seq=seq,
                sender="Josh",
                axis="lat",
                from_deg=0.0,
                delta_deg=SPIN_DELTA,
                duration_ms=SPIN_DURATION_MS,
                landing=landing,
                candidates=candidates,
            )

    def test_replaying_the_same_spin_is_an_idempotent_success(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        seq = start_round(store)
        first, changed = store.spin_adventure(
            anchor_seq=seq,
            sender="Josh",
            axis="lng",
            from_deg=SPIN_FROM,
            delta_deg=SPIN_DELTA,
            duration_ms=SPIN_DURATION_MS,
            now=1.0,
        )
        assert changed is True
        events_before = _events(db_path, seq)
        # Same axis + from + delta, even from the other person and with another duration: a replay.
        again, changed_again = store.spin_adventure(
            anchor_seq=seq,
            sender="Rose",
            axis="lng",
            from_deg=SPIN_FROM,
            delta_deg=SPIN_DELTA,
            duration_ms=5000.0,
            now=2.0,
        )
        assert changed_again is False and again == first
        assert _events(db_path, seq) == events_before

    def test_a_different_spin_after_the_state_moved_is_bad_state(
        self, store: LiveChatStore
    ) -> None:
        seq = start_round(store)
        store.spin_adventure(
            anchor_seq=seq,
            sender="Josh",
            axis="lng",
            from_deg=SPIN_FROM,
            delta_deg=SPIN_DELTA,
            duration_ms=SPIN_DURATION_MS,
        )
        for frm, delta in ((SPIN_FROM + 1.0, SPIN_DELTA), (SPIN_FROM, SPIN_DELTA + 10.0)):
            with pytest.raises(AdventureBadStateError):
                store.spin_adventure(
                    anchor_seq=seq,
                    sender="Rose",
                    axis="lng",
                    from_deg=frm,
                    delta_deg=delta,
                    duration_ms=SPIN_DURATION_MS,
                )

    def test_replaying_the_up_down_spin_after_the_country_stop_still_succeeds(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq)
        row = stop_country(store, bank, seq, "AAA", row)
        landing, candidates = landing_for()
        again, changed = store.spin_adventure(
            anchor_seq=seq,
            sender="Rose",
            axis="lat",
            from_deg=-15.0,
            delta_deg=-SPIN_DELTA,
            duration_ms=SPIN_DURATION_MS,
            landing=landing,
            candidates=candidates,
        )
        assert changed is False and again == row

    def test_an_unknown_round_is_not_found(self, store: LiveChatStore) -> None:
        with pytest.raises(AdventureRoundNotFoundError):
            store.spin_adventure(
                anchor_seq=999,
                sender="Josh",
                axis="lng",
                from_deg=0.0,
                delta_deg=SPIN_DELTA,
                duration_ms=SPIN_DURATION_MS,
            )


# -- the roulettes ------------------------------------------------------------------------------


class TestCountryStop:
    def test_it_draws_the_units_top_five_in_rank_order_with_a_destination_roulette(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq)
        now = roulette_open(row)
        stopped, changed = store.stop_adventure(
            anchor_seq=seq,
            sender="Rose",
            stage="country",
            choice="AAA",
            bank=bank,
            pack_available=True,
            now=now,
        )
        assert changed is True and stopped.state == "destination"
        assert stopped.country_id == "AAA" and stopped.country_by == "Rose"
        # Alphaland has six destinations; the top five, in rank order.
        assert stopped.dest_candidates == ("AAA.one", "AAA.two", "AAA.three", "AAA.four", "AAA.five")
        assert stopped.dest_roulette_at == now + 3.5
        assert stopped.dest_seed is not None and 0 <= stopped.dest_seed < 2**32
        assert stopped.destination_id is None and stopped.pack == "none"

    def test_the_choice_must_be_one_of_the_candidates(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq)
        for bad in ("DDD", "ZZZ", "", "aaa"):
            with pytest.raises(AdventureInvalidError):
                store.stop_adventure(
                    anchor_seq=seq,
                    sender="Josh",
                    stage="country",
                    choice=bad,
                    bank=bank,
                    pack_available=True,
                    now=roulette_open(row),
                )

    def test_a_stop_before_the_roulette_is_too_early_with_one_second_of_tolerance(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq)
        assert row.country_roulette_at is not None
        starts = row.country_roulette_at
        for now in (starts - 5.0, starts - 1.01):
            with pytest.raises(AdventureTooEarlyError):
                store.stop_adventure(
                    anchor_seq=seq,
                    sender="Josh",
                    stage="country",
                    choice="AAA",
                    bank=bank,
                    pack_available=True,
                    now=now,
                )
        assert store.get_adventure_round(anchor_seq=seq).state == "country"  # type: ignore[union-attr]
        # Exactly one second early is inside the tolerance.
        stopped, changed = store.stop_adventure(
            anchor_seq=seq,
            sender="Josh",
            stage="country",
            choice="AAA",
            bank=bank,
            pack_available=True,
            now=starts - 1.0,
        )
        assert changed is True and stopped.state == "destination"

    def test_rejected_and_banked_destinations_leave_the_draw(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        # Reject Alphaland's rank one, bank rank two: the next draw is three..six + nothing more.
        first = start_round(store, "adv-excl-reject-1")
        to_chosen(store, bank, first, destination="AAA.one")
        store.decide_adventure(anchor_seq=first, sender="Josh", decision="reject")
        second = start_round(store, "adv-excl-bank-001")
        to_chosen(store, bank, second, destination="AAA.two")
        store.decide_adventure(anchor_seq=second, sender="Josh", decision="bank")
        assert store.adventure_excluded_ids() == frozenset({"AAA.one", "AAA.two"})

        third = start_round(store, "adv-excl-third-01")
        row = to_country(store, third)
        row = stop_country(store, bank, third, "AAA", row)
        assert row.dest_candidates == ("AAA.three", "AAA.four", "AAA.five", "AAA.six")

    def test_a_unit_with_nothing_left_is_exhausted_and_the_round_stays_on_country(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        for n, dest in enumerate(("BBB.one", "BBB.two")):
            seq = start_round(store, f"adv-exhaust-{n:05d}")
            to_chosen(store, bank, seq, unit="BBB", destination=dest)
            store.decide_adventure(anchor_seq=seq, sender="Josh", decision="reject")
        seq = start_round(store, "adv-exhaust-final")
        row = to_country(store, seq, unit="BBB")
        with pytest.raises(AdventureExhaustedError):
            store.stop_adventure(
                anchor_seq=seq,
                sender="Josh",
                stage="country",
                choice="BBB",
                bank=bank,
                pack_available=True,
                now=roulette_open(row),
            )
        # Nothing moved: the roulette can still be stopped on another country.
        assert store.get_adventure_round(anchor_seq=seq).state == "country"  # type: ignore[union-attr]
        again = stop_country(store, bank, seq, "AAA", row)
        assert again.state == "destination"

    def test_a_single_remaining_destination_skips_straight_to_chosen(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq, unit="CCC")
        chosen = stop_country(store, bank, seq, "CCC", row, sender="Rose")
        assert chosen.state == "chosen"
        assert chosen.country_id == "CCC" and chosen.destination_id == "CCC.only"
        assert chosen.destination_by == "Rose"
        assert chosen.dest_candidates == ("CCC.only",)
        assert chosen.dest_seed is None and chosen.dest_roulette_at is None
        assert chosen.pack == "pending" and chosen.pack_run_id is None

    def test_two_remaining_destinations_still_run_a_roulette(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq, unit="BBB")
        row = stop_country(store, bank, seq, "BBB", row)
        assert row.state == "destination" and row.dest_candidates == ("BBB.one", "BBB.two")

    def test_replaying_the_country_stop_succeeds_but_another_choice_is_bad_state(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq)
        stopped = stop_country(store, bank, seq, "AAA", row)
        events = _events(db_path, seq)
        again, changed = store.stop_adventure(
            anchor_seq=seq,
            sender="Rose",
            stage="country",
            choice="AAA",
            bank=bank,
            pack_available=True,
            now=roulette_open(row),
        )
        assert changed is False and again == stopped
        assert _events(db_path, seq) == events
        with pytest.raises(AdventureBadStateError):
            store.stop_adventure(
                anchor_seq=seq,
                sender="Rose",
                stage="country",
                choice="BBB",
                bank=bank,
                pack_available=True,
                now=roulette_open(row),
            )

    def test_a_destination_stop_before_the_country_stop_is_bad_state(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq)
        with pytest.raises(AdventureBadStateError):
            store.stop_adventure(
                anchor_seq=seq,
                sender="Josh",
                stage="destination",
                choice="AAA.one",
                bank=bank,
                pack_available=True,
                now=roulette_open(row),
            )

    def test_the_advised_unit_is_never_a_playable_landing(self, bank: AdventureBank) -> None:
        assert bank.is_playable("AAA") and not bank.is_playable("DDD")
        assert "DDD" not in bank.eligible_units()


class TestDestinationStop:
    def test_it_chooses_and_starts_the_pack(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq)
        row = stop_country(store, bank, seq, "EEE", row)
        chosen = stop_destination(store, bank, seq, "EEE.two", row, sender="Bubble")
        assert chosen.state == "chosen"
        assert chosen.destination_id == "EEE.two" and chosen.destination_by == "Bubble"
        assert chosen.pack == "pending" and chosen.pack_run_id is None
        assert chosen.pack_json is None and chosen.pack_error is None

    def test_without_a_researcher_the_pack_is_unavailable_at_once(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        chosen = to_chosen(store, bank, seq, unit="EEE", pack_available=False)
        assert chosen.pack == "unavailable"
        assert chosen.pack_error == ADVENTURE_PACK_UNAVAILABLE_TEXT

    def test_the_choice_must_be_a_candidate_and_not_early(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq)
        row = stop_country(store, bank, seq, "AAA", row)
        assert row.dest_roulette_at is not None
        with pytest.raises(AdventureInvalidError):
            store.stop_adventure(
                anchor_seq=seq,
                sender="Josh",
                stage="destination",
                choice="AAA.six",  # in the unit, but not among the five drawn
                bank=bank,
                pack_available=True,
                now=roulette_open(row),
            )
        with pytest.raises(AdventureTooEarlyError):
            store.stop_adventure(
                anchor_seq=seq,
                sender="Josh",
                stage="destination",
                choice="AAA.one",
                bank=bank,
                pack_available=True,
                now=row.dest_roulette_at - 1.5,
            )

    def test_replay_and_a_different_choice(self, store: LiveChatStore, bank: AdventureBank) -> None:
        seq = start_round(store)
        row = to_country(store, seq)
        row = stop_country(store, bank, seq, "AAA", row)
        chosen = stop_destination(store, bank, seq, "AAA.three", row)
        again, changed = store.stop_adventure(
            anchor_seq=seq,
            sender="Josh",
            stage="destination",
            choice="AAA.three",
            bank=bank,
            pack_available=True,
            now=roulette_open(row),
        )
        assert changed is False and again == chosen
        with pytest.raises(AdventureBadStateError):
            store.stop_adventure(
                anchor_seq=seq,
                sender="Josh",
                stage="destination",
                choice="AAA.four",
                bank=bank,
                pack_available=True,
                now=roulette_open(row),
            )

    def test_the_single_destination_skip_replays_a_destination_stop_too(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        row = to_country(store, seq, unit="CCC")
        chosen = stop_country(store, bank, seq, "CCC", row)
        again, changed = store.stop_adventure(
            anchor_seq=seq,
            sender="Josh",
            stage="destination",
            choice="CCC.only",
            bank=bank,
            pack_available=True,
            now=1.0,
        )
        assert changed is False and again == chosen


# -- deciding ---------------------------------------------------------------------------------


class TestDecide:
    def test_bank_keeps_the_trip_and_takes_it_out_of_the_draw(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        seq = start_round(store)
        to_chosen(store, bank, seq, destination="AAA.three")
        row, changed = store.decide_adventure(anchor_seq=seq, sender="Rose", decision="bank")
        assert changed is True and row.state == "banked" and row.decided_by == "Rose"
        assert "AAA.three" in store.adventure_excluded_ids()
        assert _count(db_path, "adv_rejected") == 0
        assert [r.anchor_message_seq for r in store.list_adventure_bank()] == [seq]

    def test_reject_adds_to_the_never_again_list_in_the_same_transaction(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        seq = start_round(store)
        to_chosen(store, bank, seq, destination="AAA.one")
        row, changed = store.decide_adventure(anchor_seq=seq, sender="Josh", decision="reject")
        assert changed is True and row.state == "rejected" and row.decided_by == "Josh"
        conn = sqlite3.connect(str(db_path))
        try:
            assert [r[0] for r in conn.execute("SELECT destination_id FROM adv_rejected")] == [
                "AAA.one"
            ]
        finally:
            conn.close()
        assert store.list_adventure_bank() == []

    def test_replay_succeeds_and_the_opposite_decision_is_bad_state(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        seq = start_round(store)
        to_chosen(store, bank, seq)
        banked, _ = store.decide_adventure(anchor_seq=seq, sender="Josh", decision="bank")
        events = _events(db_path, seq)
        again, changed = store.decide_adventure(anchor_seq=seq, sender="Rose", decision="bank")
        assert changed is False and again == banked and _events(db_path, seq) == events
        with pytest.raises(AdventureBadStateError):
            store.decide_adventure(anchor_seq=seq, sender="Josh", decision="reject")

    def test_only_a_chosen_round_can_be_decided(self, store: LiveChatStore) -> None:
        seq = start_round(store)
        for decision in ("bank", "reject"):
            with pytest.raises(AdventureBadStateError):
                store.decide_adventure(
                    anchor_seq=seq,
                    sender="Josh",
                    decision=decision,  # type: ignore[arg-type]
                )

    def test_rejecting_while_the_research_runs_ends_the_pack(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        to_chosen(store, bank, seq)
        assert store.set_adventure_pack_run(anchor_seq=seq, run_id="run-1") is True
        row, _ = store.decide_adventure(anchor_seq=seq, sender="Josh", decision="reject")
        assert row.pack == "failed" and row.pack_error == ADVENTURE_PACK_STOPPED_TEXT
        # The job's compare-and-set now finds nothing waiting, so it stores nothing.
        assert (
            store.finish_adventure_pack(
                anchor_seq=seq, run_id="run-1", state="ready", pack_json='{"x":1}'
            )
            is False
        )

    def test_a_rejection_survives_deleting_the_round_but_a_banked_trip_does_not(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        rejected = start_round(store, "adv-survive-rej-1")
        to_chosen(store, bank, rejected, destination="AAA.one")
        store.decide_adventure(anchor_seq=rejected, sender="Josh", decision="reject")
        banked = start_round(store, "adv-survive-bank1")
        to_chosen(store, bank, banked, destination="AAA.two")
        store.decide_adventure(anchor_seq=banked, sender="Josh", decision="bank")
        assert store.adventure_excluded_ids() == frozenset({"AAA.one", "AAA.two"})

        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("DELETE FROM messages WHERE seq IN (?, ?)", (rejected, banked))
            conn.commit()
        finally:
            conn.close()
        # "Never appears again" outlives the message; deleting the trip returns it to the draw.
        assert store.adventure_excluded_ids() == frozenset({"AAA.one"})
        assert store.list_adventure_bank() == []


# -- the holiday pack ---------------------------------------------------------------------------


class TestPackTransitions:
    def _chosen(self, store: LiveChatStore, bank: AdventureBank) -> int:
        seq = start_round(store)
        to_chosen(store, bank, seq)
        return seq

    def test_the_run_id_is_a_compare_and_set(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = self._chosen(store, bank)
        assert store.set_adventure_pack_run(anchor_seq=seq, run_id="run-1") is True
        # A second process starting a run for the same round loses.
        assert store.set_adventure_pack_run(anchor_seq=seq, run_id="run-2") is False
        row = store.get_adventure_round(anchor_seq=seq)
        assert row is not None and row.pack_run_id == "run-1" and row.pack == "pending"
        # The early retry replaces exactly the dead run.
        assert (
            store.set_adventure_pack_run(anchor_seq=seq, run_id="run-3", expected_run_id="run-0")
            is False
        )
        assert (
            store.set_adventure_pack_run(anchor_seq=seq, run_id="run-3", expected_run_id="run-1")
            is True
        )

    def test_finish_lands_once_only_for_the_current_run(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        seq = self._chosen(store, bank)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="run-1")
        rev_before = store.get_adventure_round(anchor_seq=seq).rev  # type: ignore[union-attr]
        assert (
            store.finish_adventure_pack(
                anchor_seq=seq, run_id="other-run", state="ready", pack_json='{"a":1}'
            )
            is False
        )
        assert (
            store.finish_adventure_pack(
                anchor_seq=seq, run_id="run-1", state="ready", pack_json='{"a":1}'
            )
            is True
        )
        # A second poller of the same run (blue/green overlap) finds nothing waiting.
        assert (
            store.finish_adventure_pack(
                anchor_seq=seq, run_id="run-1", state="failed", error="late"
            )
            is False
        )
        row = store.get_adventure_round(anchor_seq=seq)
        assert row is not None and row.pack == "ready" and row.pack_json == '{"a":1}'
        assert row.rev == rev_before + 1 and row.pack_error is None
        assert _events(db_path, seq)[-1] == "message_updated"

    def test_a_pack_still_pending_when_banked_still_lands(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = self._chosen(store, bank)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="run-1")
        store.decide_adventure(anchor_seq=seq, sender="Josh", decision="bank")
        assert (
            store.finish_adventure_pack(
                anchor_seq=seq, run_id="run-1", state="ready", pack_json='{"headline":"H"}'
            )
            is True
        )
        row = store.get_adventure_round(anchor_seq=seq)
        assert row is not None and row.state == "banked" and row.pack == "ready"

    def test_a_pack_on_a_deleted_round_stores_nothing(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        seq = self._chosen(store, bank)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="run-1")
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("DELETE FROM messages WHERE seq = ?", (seq,))
            conn.commit()
        finally:
            conn.close()
        assert (
            store.finish_adventure_pack(
                anchor_seq=seq, run_id="run-1", state="ready", pack_json='{"a":1}'
            )
            is False
        )

    def test_retry_resets_a_failed_pack_to_pending(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = self._chosen(store, bank)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="run-1")
        store.finish_adventure_pack(anchor_seq=seq, run_id="run-1", state="failed", error="no")
        row, changed = store.retry_adventure_pack(anchor_seq=seq, researcher_available=True)
        assert changed is True and row.pack == "pending"
        assert row.pack_run_id is None and row.pack_json is None and row.pack_error is None

    def test_retry_while_pending_is_an_idempotent_double_tap(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = self._chosen(store, bank)
        row, changed = store.retry_adventure_pack(anchor_seq=seq, researcher_available=True)
        assert changed is False and row.pack == "pending"

    def test_retry_of_an_unavailable_pack_needs_a_researcher(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        to_chosen(store, bank, seq, pack_available=False)
        with pytest.raises(AdventureBadStateError):
            store.retry_adventure_pack(anchor_seq=seq, researcher_available=False)
        row, changed = store.retry_adventure_pack(anchor_seq=seq, researcher_available=True)
        assert changed is True and row.pack == "pending"

    def test_retry_is_bad_state_for_a_ready_pack_or_an_undecided_round(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        spinning = start_round(store, "adv-retry-spin-01")
        with pytest.raises(AdventureBadStateError):
            store.retry_adventure_pack(anchor_seq=spinning, researcher_available=True)
        seq = start_round(store, "adv-retry-ready-1")
        to_chosen(store, bank, seq)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="run-1")
        store.finish_adventure_pack(
            anchor_seq=seq, run_id="run-1", state="ready", pack_json='{"a":1}'
        )
        with pytest.raises(AdventureBadStateError):
            store.retry_adventure_pack(anchor_seq=seq, researcher_available=True)
        store.decide_adventure(anchor_seq=seq, sender="Josh", decision="reject")
        with pytest.raises(AdventureBadStateError):
            store.retry_adventure_pack(anchor_seq=seq, researcher_available=True)

    def test_pending_packs_list_what_a_restart_must_resume(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        with_run = start_round(store, "adv-pending-run-1")
        to_chosen(store, bank, with_run)
        store.set_adventure_pack_run(anchor_seq=with_run, run_id="run-9")
        without_run = start_round(store, "adv-pending-norun")
        to_chosen(store, bank, without_run, unit="EEE")
        done = start_round(store, "adv-pending-done1")
        to_chosen(store, bank, done, unit="BBB")
        store.set_adventure_pack_run(anchor_seq=done, run_id="run-x")
        store.finish_adventure_pack(anchor_seq=done, run_id="run-x", state="failed", error="e")
        assert store.adventure_pending_packs() == [(with_run, "run-9"), (without_run, None)]


# -- the game chat reuses wyr_chat --------------------------------------------------------------


class TestGameChat:
    def _say(self, store: LiveChatStore, cid: str, anchor: int | None) -> Any:
        return store.create_message(
            client_id=cid,
            sender="Rose",
            device_id="device-2",
            by_email=None,
            text="hello from the trip",
            attachment_ids=[],
            wyr_anchor_seq=anchor,
            now=20.0,
        )

    def test_an_adventure_anchor_accepts_game_chat_in_every_state(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        anchors = [start_round(store, "adv-chat-abandon")]
        anchors.append(start_round(store, "adv-chat-chosen1"))
        to_chosen(store, bank, anchors[-1])
        store.decide_adventure(anchor_seq=anchors[-1], sender="Josh", decision="bank")
        anchors.append(start_round(store, "adv-chat-reject-1"))
        to_chosen(store, bank, anchors[-1], unit="BBB")
        store.decide_adventure(anchor_seq=anchors[-1], sender="Josh", decision="reject")
        anchors.append(start_round(store, "adv-chat-live-001"))
        for n, anchor in enumerate(anchors):
            sent, created = self._say(store, f"adv-game-msg-{n:04d}", anchor)
            assert created is True
            assert sent.wyr_ref == anchor and sent.wyr_ref_kind == "adventure"
            assert sent.adventure is None and sent.text == "hello from the trip"

    def test_an_unknown_anchor_is_the_one_not_found_error(self, store: LiveChatStore) -> None:
        with pytest.raises(WyrRoundNotFoundError):
            self._say(store, "adv-game-nowhere", 4242)
        plain, _ = self._say(store, "adv-plain-anchor", None)
        with pytest.raises(WyrRoundNotFoundError):
            self._say(store, "adv-game-plain", plain.seq)

    def test_a_would_you_rather_anchor_still_works_and_reports_its_kind(
        self, store: LiveChatStore
    ) -> None:
        wyr, _ = store.create_wyr_round(
            client_id="adv-wyr-anchor-01",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            question_id="q0001",
            images_pending=False,
            now=1.0,
        )
        sent, _ = self._say(store, "adv-wyr-chat-001", wyr.seq)
        assert sent.wyr_ref == wyr.seq and sent.wyr_ref_kind == "wyr"

    def test_the_wire_names_the_kind_beside_wyr_ref(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        adventure = start_round(store)
        wyr, _ = store.create_wyr_round(
            client_id="adv-kind-wyr-0001",
            sender="Josh",
            device_id="device-1",
            by_email=None,
            question_id="q0001",
            images_pending=False,
            now=1.0,
        )
        in_adventure, _ = self._say(store, "adv-kind-adv-0001", adventure)
        in_wyr, _ = self._say(store, "adv-kind-wyr-msg-1", wyr.seq)
        ordinary, _ = self._say(store, "adv-kind-plain-001", None)

        def kinds(rows: list[Any]) -> dict[int, tuple[Any, Any]]:
            wire = [message_json(m, _Signer()) for m in rows]
            return {m["seq"]: (m["wyrRef"], m["wyrRefKind"]) for m in wire}

        expected = {
            in_adventure.seq: (adventure, "adventure"),
            in_wyr.seq: (wyr.seq, "wyr"),
            ordinary.seq: (None, None),
        }
        seqs = list(expected)
        assert kinds(store.get_messages(seqs)) == expected
        listed, _more, _cursor = store.list_messages(before=None, limit=20)
        assert {k: v for k, v in kinds(listed).items() if k in expected} == expected
        # The kind survives the anchor leaving history: it is a join, not a copy.
        assert kinds(store.get_messages([in_adventure.seq]))[in_adventure.seq][1] == "adventure"

    def test_deleting_the_anchor_keeps_the_chat_messages_in_the_main_chat(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        anchor = start_round(store)
        sent, _ = self._say(store, "adv-keep-chat-001", anchor)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("DELETE FROM messages WHERE seq = ?", (anchor,))
            conn.commit()
        finally:
            conn.close()
        [left] = store.get_messages([sent.seq])
        assert left.text == "hello from the trip" and left.wyr_ref is None
        assert left.wyr_ref_kind is None


# -- erasure -----------------------------------------------------------------------------------


class TestErasure:
    def test_a_wipe_clears_rounds_the_game_chat_and_the_never_again_list(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        rejected = start_round(store, "adv-wipe-reject-1")
        to_chosen(store, bank, rejected, destination="AAA.one")
        store.decide_adventure(anchor_seq=rejected, sender="Josh", decision="reject")
        banked = start_round(store, "adv-wipe-bank-001")
        to_chosen(store, bank, banked, destination="AAA.two")
        store.decide_adventure(anchor_seq=banked, sender="Josh", decision="bank")
        store.create_message(
            client_id="adv-wipe-chat-001",
            sender="Rose",
            device_id="device-2",
            by_email=None,
            text="a trip message",
            attachment_ids=[],
            wyr_anchor_seq=banked,
            now=30.0,
        )
        assert _count(db_path, "adv_rounds") == 2 and _count(db_path, "adv_rejected") == 1

        store.wipe(now=40.0)
        assert _count(db_path, "adv_rounds") == 0
        assert _count(db_path, "adv_rejected") == 0
        assert _count(db_path, "wyr_chat") == 0
        assert store.adventure_excluded_ids() == frozenset()
        assert store.list_adventure_bank() == []

    def test_the_raw_bytes_of_a_round_are_gone_after_a_scrubbed_delete(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        seq = start_round(store)
        to_chosen(store, bank, seq)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="run-1")
        store.finish_adventure_pack(
            anchor_seq=seq,
            run_id="run-1",
            state="ready",
            pack_json='{"headline":"ZZ-PACK-SENTINEL-731"}',
        )
        assert b"ZZ-PACK-SENTINEL-731" in _raw_db(db_path)
        store.delete_message_for_scrub(seq=seq, now=50.0)
        assert store.scrub(deadline_s=5.0) is True
        assert b"ZZ-PACK-SENTINEL-731" not in _raw_db(db_path)
        assert store.get_adventure_round(anchor_seq=seq) is None


# -- concurrency -----------------------------------------------------------------------------


class TestConcurrency:
    def test_two_racing_different_spins_one_wins_and_the_loser_is_bad_state(
        self, db_path: Path
    ) -> None:
        store_a = LiveChatStore(db_path)
        store_b = LiveChatStore(db_path)
        seq = start_round(store_a)

        def spin(store: LiveChatStore, frm: float) -> Any:
            return lambda: store.spin_adventure(
                anchor_seq=seq,
                sender="Josh",
                axis="lng",
                from_deg=frm,
                delta_deg=SPIN_DELTA,
                duration_ms=SPIN_DURATION_MS,
            )

        results = run_concurrently(spin(store_a, 1.0), spin(store_b, 2.0))
        wins = [r for r in results if isinstance(r, tuple)]
        losses = [r for r in results if isinstance(r, AdventureBadStateError)]
        assert len(wins) == 1 and len(losses) == 1
        row = store_a.get_adventure_round(anchor_seq=seq)
        assert row is not None and row.rev == 2 and row.state == "spin_lat"
        assert row.spin_lng is not None and row.spin_lng.from_deg == wins[0][0].spin_lng.from_deg

    def test_two_racing_identical_stops_change_the_round_once(
        self, db_path: Path, bank: AdventureBank
    ) -> None:
        store_a = LiveChatStore(db_path)
        store_b = LiveChatStore(db_path)
        seq = start_round(store_a)
        row = to_country(store_a, seq)

        def stop(store: LiveChatStore) -> Any:
            return lambda: store.stop_adventure(
                anchor_seq=seq,
                sender="Josh",
                stage="country",
                choice="AAA",
                bank=bank,
                pack_available=True,
                now=roulette_open(row),
            )

        results = run_concurrently(stop(store_a), stop(store_b))
        assert all(isinstance(r, tuple) for r in results)
        assert sorted(changed for _row, changed in results) == [False, True]
        final = store_a.get_adventure_round(anchor_seq=seq)
        assert final is not None and final.rev == row.rev + 1

    def test_two_racing_decisions_one_wins_and_the_other_is_bad_state(
        self, db_path: Path, bank: AdventureBank
    ) -> None:
        store_a = LiveChatStore(db_path)
        store_b = LiveChatStore(db_path)
        seq = start_round(store_a)
        to_chosen(store_a, bank, seq)

        def decide(store: LiveChatStore, decision: Any) -> Any:
            return lambda: store.decide_adventure(anchor_seq=seq, sender="Josh", decision=decision)

        results = run_concurrently(decide(store_a, "bank"), decide(store_b, "reject"))
        assert sum(isinstance(r, tuple) for r in results) == 1
        assert sum(isinstance(r, AdventureBadStateError) for r in results) == 1
