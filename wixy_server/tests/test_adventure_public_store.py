"""The public pack cache store (workspace 00065, spec/adventure-public/README.md §2.2, Inv 61): the
schema, WAL, the compare-and-set transitions, the retry backoff, the picture wait and the
all-or-nothing picture attach — and that it is a database of its own, never `server.db`."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from wixy_server.adventure_public.store import (
    MAX_PICTURE_TRIES,
    NewPicture,
    PublicPackStore,
    retry_delay_s,
)
from wixy_server.storage import project_paths

DEST = "AAA.one"
PACK = '{"headline":"h"}'


@pytest.fixture
def store(tmp_path: Path) -> PublicPackStore:
    return PublicPackStore(tmp_path / "adventure-public" / "public.db")


def pic(n: int, slot: str | None = None) -> NewPicture:
    return NewPicture(
        id=f"{n:032x}",
        slot=slot or ("hero:0" if n == 0 else f"food:{n}"),
        ordinal=n,
        width=1200,
        height=800,
        credit=f"Credit {n}",
        page=f"https://commons.example/File:{n}.jpg",
        caption=None if n % 2 else f"Caption {n}",
    )


def started(store: PublicPackStore, now: float = 1000.0, dest: str = DEST) -> None:
    assert store.request_start(dest, now=now).kind == "started"


def ready(store: PublicPackStore, *, now: float = 1000.0, pictures: bool = True) -> None:
    started(store, now)
    assert store.set_run(DEST, run_id="r1", now=now)
    assert store.finish(
        DEST, run_id="r1", state="ready", pack_json=PACK, pictures_pending=pictures, now=now
    )


class TestSchema:
    def test_it_creates_its_own_database_lazily_in_wal_mode(self, store: PublicPackStore) -> None:
        assert not store.db_path.exists()
        assert store.get(DEST) is None
        assert store.db_path.exists()
        conn = sqlite3.connect(str(store.db_path))
        try:
            assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
            tables = {
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            assert {"packs", "pictures", "schema_version"} <= tables
            assert not {"messages", "adv_rounds", "events"} & tables  # nothing of server.db
        finally:
            conn.close()

    def test_the_schema_version_table_says_v1(self, store: PublicPackStore) -> None:
        assert store.schema_version() == 1

    def test_the_columns_are_the_documented_ones(self, store: PublicPackStore) -> None:
        store.initialise()
        conn = sqlite3.connect(str(store.db_path))
        try:
            packs = [row[1] for row in conn.execute("PRAGMA table_info(packs)")]
            pictures = [row[1] for row in conn.execute("PRAGMA table_info(pictures)")]
        finally:
            conn.close()
        assert packs == [
            "destination_id",
            "state",
            "run_id",
            "pack_json",
            "error",
            "started_at",
            "tries",
            "next_try_at",
            "images",
            "images_started_at",
            "images_tries",
            "updated_at",
            "rev",
        ]
        assert pictures == [
            "id",
            "destination_id",
            "slot",
            "ordinal",
            "width",
            "height",
            "credit",
            "page",
            "caption",
            "created_at",
        ]

    def test_reopening_keeps_the_data_and_is_idempotent(self, tmp_path: Path) -> None:
        path = tmp_path / "x" / "public.db"
        first = PublicPackStore(path)
        started(first)
        second = PublicPackStore(path)
        second.initialise()
        row = second.get(DEST)
        assert row is not None and row.state == "pending"

    def test_it_lives_under_the_project_s_adventure_public_directory(self, tmp_path: Path) -> None:
        paths = project_paths(tmp_path, "site")
        assert paths.adventure_public_db == paths.root / "adventure-public" / "public.db"
        assert paths.adventure_public_db != paths.server_db
        assert paths.server_dir not in paths.adventure_public_db.parents
        assert paths.adventure_public_pictures == paths.adventure_public_dir / "pictures"
        assert paths.adventure_public_research == paths.adventure_public_dir / "research"

    def test_concurrent_first_use_from_many_threads_does_not_collide(self, tmp_path: Path) -> None:
        shared = PublicPackStore(tmp_path / "fresh" / "public.db")
        errors: list[BaseException] = []

        def hit(n: int) -> None:
            try:
                shared.request_start(f"AAA.dest{n}", now=1000.0)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=hit, args=(n,)) for n in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert errors == []
        assert len(shared.pending_packs()) == 12


class TestRequestStart:
    def test_the_first_request_creates_a_pending_row(self, store: PublicPackStore) -> None:
        result = store.request_start(DEST, now=1000.0)
        assert result.kind == "started"
        row = result.row
        assert (row.state, row.run_id, row.tries, row.started_at, row.next_try_at) == (
            "pending",
            None,
            1,
            1000.0,
            None,
        )
        assert (row.images, row.pack_json, row.error, row.rev) == ("none", None, None, 1)

    def test_asking_again_while_pending_or_ready_changes_nothing(
        self, store: PublicPackStore
    ) -> None:
        started(store)
        again = store.request_start(DEST, now=2000.0)
        assert again.kind == "exists" and again.row.updated_at == 1000.0
        store.set_run(DEST, run_id="r1", now=1001.0)
        store.finish(DEST, run_id="r1", state="ready", pack_json=PACK, now=1002.0)
        done = store.request_start(DEST, now=3000.0)
        assert done.kind == "exists" and done.row.state == "ready"

    def test_two_concurrent_requests_start_exactly_one_run(self, store: PublicPackStore) -> None:
        barrier = threading.Barrier(8)
        kinds: list[str] = []

        def ask() -> None:
            barrier.wait()
            kinds.append(store.request_start(DEST).kind)

        threads = [threading.Thread(target=ask) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert sorted(kinds) == ["exists"] * 7 + ["started"]


class TestSetRun:
    def test_it_is_a_compare_and_set_on_the_expected_run(self, store: PublicPackStore) -> None:
        started(store)
        assert store.set_run(DEST, run_id="r1", expected_run_id="other") is False
        assert store.set_run(DEST, run_id="r1", expected_run_id=None) is True
        assert store.set_run(DEST, run_id="r2", expected_run_id=None) is False  # lost the race
        assert store.set_run(DEST, run_id="r2", expected_run_id="r1") is True  # the early retry
        row = store.get(DEST)
        assert row is not None and row.run_id == "r2"

    def test_it_does_nothing_for_a_pack_that_is_not_pending(self, store: PublicPackStore) -> None:
        ready(store)
        assert store.set_run(DEST, run_id="r9", expected_run_id="r1") is False
        assert store.set_run("AAA.nothing", run_id="r1") is False


class TestFinish:
    def test_a_ready_pack_stores_the_json_and_starts_the_picture_wait(
        self, store: PublicPackStore
    ) -> None:
        ready(store, now=1000.0)
        row = store.get(DEST)
        assert row is not None
        assert (row.state, row.pack_json, row.error, row.next_try_at) == ("ready", PACK, None, None)
        assert (row.images, row.images_started_at, row.images_tries) == ("pending", 1000.0, 1)
        assert row.rev == 2  # created at 1, `finish` bumped it

    def test_a_ready_pack_without_pictures_has_none_to_wait_for(
        self, store: PublicPackStore
    ) -> None:
        ready(store, pictures=False)
        row = store.get(DEST)
        assert row is not None and (row.images, row.images_started_at, row.images_tries) == (
            "none",
            None,
            0,
        )

    def test_it_is_a_compare_and_set_on_the_run_id(self, store: PublicPackStore) -> None:
        started(store)
        store.set_run(DEST, run_id="r1")
        assert store.finish(DEST, run_id="stale", state="ready", pack_json=PACK) is False
        assert store.finish(DEST, run_id="r1", state="ready", pack_json=PACK) is True
        # A second process polling the same run lands nothing the second time.
        assert store.finish(DEST, run_id="r1", state="failed", error="late") is False
        row = store.get(DEST)
        assert row is not None and row.state == "ready"

    def test_a_pack_that_never_got_a_run_can_be_failed_with_no_run_id(
        self, store: PublicPackStore
    ) -> None:
        started(store)
        assert store.finish(DEST, run_id=None, state="failed", error="no cmd", now=1000.0)
        row = store.get(DEST)
        assert row is not None and row.state == "failed" and row.error == "no cmd"


class TestFailureBackoff:
    @pytest.mark.parametrize(("tries", "seconds"), [(1, 600), (2, 1200), (3, 2400), (4, 4800)])
    def test_the_delay_is_ten_minutes_doubling(self, tries: int, seconds: float) -> None:
        assert retry_delay_s(tries) == seconds

    def fail(self, store: PublicPackStore, now: float, run: str = "r") -> None:
        store.set_run(DEST, run_id=run, now=now)
        assert store.finish(DEST, run_id=run, state="failed", error="e", now=now)

    def test_the_first_failure_may_be_asked_for_again_after_ten_minutes(
        self, store: PublicPackStore
    ) -> None:
        started(store, 1000.0)
        self.fail(store, 1100.0)
        row = store.get(DEST)
        assert row is not None
        assert (row.state, row.error, row.next_try_at, row.tries) == ("failed", "e", 1700.0, 1)
        assert row.pack_json is None and row.images == "none"
        early = store.request_start(DEST, now=1699.0)
        assert early.kind == "wait" and early.row.next_try_at == 1700.0
        assert store.get(DEST) == row  # a refused retry changed nothing
        again = store.request_start(DEST, now=1700.0)
        assert again.kind == "started"
        assert (again.row.state, again.row.run_id, again.row.tries, again.row.error) == (
            "pending",
            None,
            2,
            None,
        )
        assert again.row.started_at == 1000.0  # the 24-hour window began at the first try

    def test_the_wait_doubles_and_three_tries_close_the_window_for_a_day(
        self, store: PublicPackStore
    ) -> None:
        started(store, 1000.0)
        self.fail(store, 1100.0)  # try 1 failed: +600
        assert store.request_start(DEST, now=1700.0).kind == "started"
        self.fail(store, 1800.0, "r2")  # try 2 failed: +1200
        row = store.get(DEST)
        assert row is not None and row.next_try_at == 3000.0 and row.tries == 2
        assert store.request_start(DEST, now=3000.0).kind == "started"
        self.fail(store, 3100.0, "r3")  # try 3 failed: +2400 = 5500, but the window holds to 87400
        row = store.get(DEST)
        assert row is not None and row.tries == 3 and row.next_try_at == 1000.0 + 24 * 3600
        assert store.request_start(DEST, now=5600.0).kind == "wait"
        assert store.request_start(DEST, now=1000.0 + 24 * 3600 - 1).kind == "wait"
        # 24 hours after the first try of the window, it starts a fresh window.
        fresh = store.request_start(DEST, now=1000.0 + 24 * 3600)
        assert fresh.kind == "started" and fresh.row.tries == 1
        assert fresh.row.started_at == 1000.0 + 24 * 3600

    def test_a_window_that_lapsed_with_tries_to_spare_also_restarts(
        self, store: PublicPackStore
    ) -> None:
        started(store, 1000.0)
        self.fail(store, 1100.0)
        later = store.request_start(DEST, now=1000.0 + 25 * 3600)
        assert later.kind == "started" and later.row.tries == 1

    def test_a_failure_with_cmd_unreachable_does_not_spend_a_try(
        self, store: PublicPackStore
    ) -> None:
        started(store, 1000.0)
        assert store.finish(
            DEST, run_id=None, state="failed", error="down", transient=True, now=1100.0
        )
        row = store.get(DEST)
        assert row is not None and row.tries == 0 and row.next_try_at == 1160.0
        assert store.request_start(DEST, now=1159.0).kind == "wait"
        again = store.request_start(DEST, now=1160.0)
        assert again.kind == "started" and again.row.tries == 1

    def test_a_ready_pack_has_no_retry_time(self, store: PublicPackStore) -> None:
        ready(store)
        row = store.get(DEST)
        assert row is not None and row.next_try_at is None


class TestPendingLists:
    def test_pending_packs_list_with_their_run_ids(self, store: PublicPackStore) -> None:
        started(store, 1000.0, "AAA.one")
        started(store, 1001.0, "AAA.two")
        store.set_run("AAA.two", run_id="r2")
        assert store.pending_packs() == [("AAA.one", None), ("AAA.two", "r2")]
        store.finish("AAA.two", run_id="r2", state="ready", pack_json=PACK)
        assert store.pending_packs() == [("AAA.one", None)]


class TestPictureWait:
    def test_pending_and_stale_pictures(self, store: PublicPackStore) -> None:
        ready(store, now=1000.0)
        assert store.pending_pictures() == [DEST]
        assert store.stale_pictures(stale_before=999.0) == []  # a hunt begun at 1000 is not stale
        assert store.stale_pictures(stale_before=1000.5) == [DEST]

    def test_a_pack_still_researching_has_no_picture_wait(self, store: PublicPackStore) -> None:
        started(store)
        assert store.pending_pictures() == [] and store.stale_pictures(stale_before=1e12) == []

    def test_claim_counts_a_try_and_restarts_the_clock(self, store: PublicPackStore) -> None:
        ready(store, now=1000.0)
        assert store.claim_pictures(DEST, stale_before=None, now=2000.0) == "claimed"
        row = store.get(DEST)
        assert row is not None and (row.images_started_at, row.images_tries) == (2000.0, 2)

    def test_a_young_hunt_is_not_due_and_a_stale_one_is(self, store: PublicPackStore) -> None:
        ready(store, now=1000.0)
        assert store.claim_pictures(DEST, stale_before=900.0, now=2000.0) == "not_due"
        assert store.claim_pictures(DEST, stale_before=1500.0, now=2000.0) == "claimed"

    def test_two_sweeps_at_once_start_one_hunt(self, store: PublicPackStore) -> None:
        ready(store, now=1000.0)
        results = [
            store.claim_pictures(DEST, stale_before=1500.0, now=2000.0 + n) for n in range(2)
        ]
        assert results == ["claimed", "not_due"]

    def test_a_pack_whose_hunts_keep_dying_ends_as_failed(self, store: PublicPackStore) -> None:
        ready(store, now=1000.0)  # try 1 was counted by the finish
        for n in range(MAX_PICTURE_TRIES - 1):
            assert store.claim_pictures(DEST, stale_before=None, now=2000.0 + n) == "claimed"
        assert store.claim_pictures(DEST, stale_before=None, now=3000.0) == "gave_up"
        row = store.get(DEST)
        assert row is not None and row.images == "failed"
        assert store.claim_pictures(DEST, stale_before=None, now=4000.0) == "gone"

    def test_claiming_something_that_does_not_wait_is_gone(self, store: PublicPackStore) -> None:
        assert store.claim_pictures("AAA.nothing", stale_before=None, now=1.0) == "gone"
        ready(store, pictures=False)
        assert store.claim_pictures(DEST, stale_before=None, now=1.0) == "gone"

    def test_fail_pictures_ends_the_wait_once(self, store: PublicPackStore) -> None:
        ready(store)
        assert store.fail_pictures(DEST, now=1500.0) is True
        assert store.fail_pictures(DEST, now=1600.0) is False
        row = store.get(DEST)
        assert row is not None and row.images == "failed"


class TestAttachPictures:
    def test_every_picture_and_the_done_flag_land_together(self, store: PublicPackStore) -> None:
        ready(store)
        assert store.attach_pictures(
            DEST, [pic(0), pic(1, "food:0"), pic(2, "dishes:1")], now=2000.0
        )
        got = store.get_with_pictures(DEST)
        assert got is not None
        row, pictures = got
        assert row.images == "done" and row.rev == 3
        assert [(p.id, p.slot, p.ordinal) for p in pictures] == [
            (f"{0:032x}", "hero:0", 0),
            (f"{1:032x}", "food:0", 1),
            (f"{2:032x}", "dishes:1", 2),
        ]
        assert pictures[0].caption == "Caption 0" and pictures[1].caption is None
        assert (pictures[0].width, pictures[0].height, pictures[0].credit) == (
            1200,
            800,
            "Credit 0",
        )
        assert store.picture_ids() == {f"{n:032x}" for n in range(3)}

    def test_it_attaches_only_while_the_pictures_are_pending(self, store: PublicPackStore) -> None:
        ready(store)
        assert store.attach_pictures(DEST, [pic(0)])
        assert store.attach_pictures(DEST, [pic(5)]) is False  # already done: a lost race
        assert store.picture_ids() == {f"{0:032x}"}

    def test_a_failed_wait_or_a_missing_pack_attaches_nothing(self, store: PublicPackStore) -> None:
        assert store.attach_pictures("AAA.nothing", [pic(0)]) is False
        ready(store)
        store.fail_pictures(DEST)
        assert store.attach_pictures(DEST, [pic(0)]) is False
        assert store.picture_ids() == set()

    def test_a_picture_that_cannot_be_stored_rolls_every_picture_back(
        self, store: PublicPackStore
    ) -> None:
        ready(store)
        with pytest.raises(sqlite3.IntegrityError):
            store.attach_pictures(DEST, [pic(0), pic(1), pic(1)])  # a duplicate id
        got = store.get_with_pictures(DEST)
        assert got is not None
        row, pictures = got
        assert row.images == "pending" and pictures == []  # all or nothing

    def test_pictures_are_read_in_ordinal_order_with_the_pack(self, store: PublicPackStore) -> None:
        ready(store)
        store.attach_pictures(DEST, [pic(2, "food:0"), pic(0), pic(1, "food:1")])
        got = store.get_with_pictures(DEST)
        assert got is not None
        assert [p.ordinal for p in got[1]] == [0, 1, 2]
        assert store.get_with_pictures("AAA.nothing") is None

    def test_restarting_a_failed_pack_drops_nothing_it_never_had(
        self, store: PublicPackStore
    ) -> None:
        started(store, 1000.0)
        store.set_run(DEST, run_id="r1")
        store.finish(DEST, run_id="r1", state="failed", error="e", now=1100.0)
        assert store.request_start(DEST, now=2000.0).kind == "started"
        got = store.get_with_pictures(DEST)
        assert got is not None and got[0].images == "none" and got[1] == []
