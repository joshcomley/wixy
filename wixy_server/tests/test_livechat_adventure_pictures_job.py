# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as parameters)
"""The holiday pack's pictures — storage, the job and the wire (workspace 00056,
spec/server-chat/08-adventure-time.md §4.3a, Inv 46/56): the store's compare-and-set attach, the
picture job (success, nothing found, rejected / deleted mid-hunt, restart, a blue/green overlap),
the view's `pack.images` / `pack.pictures`, the Gallery exclusion, and erasure by delete and wipe.
Hermetic: pictures come from `FakePictureFinder`, or from the real `WebPictureFinder` over a fake
Wikipedia/Commons/venue web on loopback."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, cast
from unittest.mock import MagicMock

import anyio
import httpx
import pytest

from wixy_server.background import BackgroundTaskHealth, ContainedTaskGroup
from wixy_server.livechat.adventure_bank import AdventureBank
from wixy_server.livechat.adventure_pack import canonical_pack_json, parse_pack
from wixy_server.livechat.adventure_pictures import (
    AdventurePictureJob,
    PictureTiming,
    WebPictureFinder,
)
from wixy_server.livechat.models import AttachmentResult
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.storage import ProjectPaths
from wixy_server.tests.adventure_testkit import (
    BASE,
    FakePictureFinder,
    FakeResearcher,
    FakeRunPlan,
    create_round,
    fixture_bank,
    get_view,
    post,
    route_to_chosen,
    sample_pictures,
    start_round,
    to_chosen,
    unlocked_client,
    wait_for,
    wait_for_pack,
)
from wixy_server.tests.fake_cmd import CANNED_ADVENTURE_PACK, FakeCmdState, create_fake_cmd_app
from wixy_server.tests.fake_open_web import FakeFile, FakeOpenWeb
from wixy_server.tests.fake_web import FakeWeb, local_fetcher
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    TEST_APP_KEY,
    _dev_no_auth,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)

PACK_JSON = canonical_pack_json(parse_pack(json.dumps(CANNED_ADVENTURE_PACK)) or {})


# -- store-level setup ---------------------------------------------------------------------------


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


@pytest.fixture
def bank() -> AdventureBank:
    return fixture_bank()


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return ProjectPaths(slug="proj", root=tmp_path / "proj")


def ready_round(
    store: LiveChatStore,
    bank: AdventureBank,
    *,
    cid: str = "adv-client-0001",
    pictures_pending: bool = True,
    state: str = "chosen",
    now: float | None = None,
) -> int:
    """A round whose destination is chosen and whose text pack is stored `ready` (at `now`, when
    given: that is also when its first picture hunt is recorded as having begun)."""
    seq = start_round(store, cid)
    to_chosen(store, bank, seq)
    assert store.set_adventure_pack_run(anchor_seq=seq, run_id="run-1")
    assert store.finish_adventure_pack(
        anchor_seq=seq,
        run_id="run-1",
        state="ready",
        pack_json=PACK_JSON,
        pictures_pending=pictures_pending,
        now=now,
    )
    if state == "banked":
        store.decide_adventure(anchor_seq=seq, sender="Josh", decision="bank")
    return seq


def stage(paths: ProjectPaths, count: int) -> list[tuple[str, int]]:
    """Stage `count` pictures at `uploads/<id>/assembled`, as the job does before attaching."""
    images: list[tuple[str, int]] = []
    for index in range(count):
        att_id = f"{index:02d}" + "a" * 30
        folder = paths.server_upload_dir(att_id)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "assembled").write_bytes(b"jpeg-bytes-%d" % index)
        images.append((att_id, 13))
    return images


def slots_json(count: int = 3) -> str:
    slots = [
        {
            "slot": f"hero:{i}" if i < 2 else f"food:{i - 2}",
            "ordinal": i,
            "credit": f"Credit {i}",
            "page": f"https://commons.example.org/wiki/File:{i}.jpg",
            "caption": None,
        }
        for i in range(count)
    ]
    return json.dumps({"v": 1, "slots": slots})


def make_ready(store: LiveChatStore, *, now: float = 5000.0) -> int:
    """Process every `processing` attachment to `ready` (what the media queue does)."""
    done = 0
    while (claimed := store.claim_processing(owner="test", now=now, lease_s=120.0)) is not None:
        store.finish_attachment(
            att_id=claimed.id,
            owner="test",
            result=AttachmentResult(
                status="ready",
                mime="image/jpeg",
                width=900,
                height=700,
                duration_s=None,
                peaks=None,
                renditions=("full", "thumb"),
                bytes_on_disk=1000,
                failure=None,
            ),
            now=now,
        )
        done += 1
    return done


def round_of(store: LiveChatStore, seq: int) -> Any:
    row = store.get_adventure_round(anchor_seq=seq)
    assert row is not None
    return row


def count_rows(db_path: Path, table: str) -> int:
    conn = sqlite3.connect(str(db_path))
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    finally:
        conn.close()


# -- schema --------------------------------------------------------------------------------------


class TestSchema:
    OLD_V20 = """
    CREATE TABLE adv_rounds(
      anchor_message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('spin_lng','spin_lat','country','destination','chosen',
                                          'banked','rejected','abandoned')),
      started_by TEXT NOT NULL,
      spin_lng TEXT, spin_lat TEXT,
      landing TEXT,
      country_candidates TEXT, country_seed INTEGER, country_roulette_at REAL,
      country_id TEXT, country_by TEXT,
      dest_candidates TEXT, dest_seed INTEGER, dest_roulette_at REAL,
      destination_id TEXT, destination_by TEXT,
      pack TEXT NOT NULL DEFAULT 'none'
        CHECK(pack IN ('none','pending','ready','failed','unavailable')),
      pack_run_id TEXT, pack_json TEXT, pack_error TEXT,
      decided_by TEXT,
      rev INTEGER NOT NULL DEFAULT 1,
      created_at REAL NOT NULL, updated_at REAL NOT NULL);
    CREATE INDEX idx_adv_rounds_state ON adv_rounds(state);
    """

    def test_a_database_that_ran_the_first_v20_text_gains_the_picture_columns(
        self, db_path: Path, bank: AdventureBank
    ) -> None:
        LiveChatStore(db_path).list_messages(before=None, limit=1)  # create at the current schema
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("DROP INDEX idx_adv_rounds_state")
            conn.execute("DROP TABLE adv_rounds")
            for statement in self.OLD_V20.split(";"):
                if statement.strip():
                    conn.execute(statement)
            conn.commit()
            before = {r[1] for r in conn.execute("PRAGMA table_info(adv_rounds)")}
        finally:
            conn.close()
        assert not {"images", "pictures", "images_started_at", "images_tries"} & before

        store = LiveChatStore(db_path)  # reconnecting settles the columns
        seq = start_round(store)
        row = round_of(store, seq)
        assert row.images == "none" and row.pictures_json is None
        conn = sqlite3.connect(str(db_path))
        try:
            assert {"images", "pictures", "images_started_at", "images_tries"} <= {
                r[1] for r in conn.execute("PRAGMA table_info(adv_rounds)")
            }
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 20  # no version bump
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute("UPDATE adv_rounds SET images = 'nonsense' WHERE 1")
        finally:
            conn.close()
        # And it works end to end on that database.
        to_chosen(store, bank, seq)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="r")
        assert store.finish_adventure_pack(
            anchor_seq=seq, run_id="r", state="ready", pack_json=PACK_JSON, pictures_pending=True
        )
        assert round_of(store, seq).images == "pending"


# -- the pack landing, rejecting, retrying -------------------------------------------------------


class TestImagesState:
    def test_a_ready_pack_starts_the_picture_wait_only_when_pictures_are_configured(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        with_pics = ready_round(store, bank, cid="adv-client-0001", pictures_pending=True)
        without = ready_round(store, bank, cid="adv-client-0002", pictures_pending=False)
        assert round_of(store, with_pics).images == "pending"
        assert round_of(store, without).images == "none"

    @pytest.mark.parametrize("state", ["failed", "unavailable"])
    def test_a_pack_that_did_not_land_never_waits_for_pictures(
        self, store: LiveChatStore, bank: AdventureBank, state: str
    ) -> None:
        seq = start_round(store)
        to_chosen(store, bank, seq)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="r")
        assert store.finish_adventure_pack(
            anchor_seq=seq,
            run_id="r",
            state=cast(Any, state),
            pictures_pending=True,
        )
        assert round_of(store, seq).images == "none"

    def test_rejecting_while_pictures_are_pending_ends_the_wait(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = ready_round(store, bank)
        row, changed = store.decide_adventure(anchor_seq=seq, sender="Rose", decision="reject")
        assert changed and row.state == "rejected" and row.images == "failed"
        assert store.adventure_pending_pictures() == []

    def test_banking_keeps_the_pictures_pending(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = ready_round(store, bank, state="banked")
        assert round_of(store, seq).images == "pending"
        assert store.adventure_pending_pictures() == [seq]

    def test_a_retry_after_a_failed_pack_starts_clean(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = start_round(store)
        to_chosen(store, bank, seq)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="r")
        store.finish_adventure_pack(anchor_seq=seq, run_id="r", state="failed", error="no")
        row, started = store.retry_adventure_pack(anchor_seq=seq, researcher_available=True)
        assert started and row.pack == "pending" and row.images == "none"
        assert row.pictures_json is None

    def test_fail_adventure_pictures_is_a_compare_and_set_on_pending(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        before = round_of(store, seq).rev
        assert store.fail_adventure_pictures(anchor_seq=seq, now=time.time()) is True
        row = round_of(store, seq)
        assert row.images == "failed" and row.rev == before + 1
        assert store.fail_adventure_pictures(anchor_seq=seq, now=time.time()) is False
        assert store.fail_adventure_pictures(anchor_seq=999, now=time.time()) is False

    def test_pending_pictures_lists_only_ready_chosen_or_banked_rounds(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        a = ready_round(store, bank, cid="adv-client-0001")
        b = ready_round(store, bank, cid="adv-client-0002", state="banked")
        ready_round(store, bank, cid="adv-client-0003", pictures_pending=False)
        c = ready_round(store, bank, cid="adv-client-0004")
        store.decide_adventure(anchor_seq=c, sender="Josh", decision="reject")
        assert store.adventure_pending_pictures() == [a, b]


# -- attaching the pictures ----------------------------------------------------------------------


class TestAttach:
    def test_the_pictures_become_ordinary_private_photo_attachments_in_one_transaction(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        before = round_of(store, seq).rev
        images = stage(paths, 3)
        assert store.create_adventure_picture_attachments(
            anchor_seq=seq,
            images=images,
            pictures_json=slots_json(3),
            by_email=None,
            now=time.time(),
        )
        row = round_of(store, seq)
        assert row.images == "done" and row.rev == before + 1
        assert json.loads(row.pictures_json or "")["slots"][1]["credit"] == "Credit 1"
        attachments = store.adventure_picture_attachments(anchor_seq=seq)
        assert [a.id for a in attachments] == [i for i, _ in images]
        assert [a.ordinal for a in attachments] == [0, 1, 2]
        assert {(a.kind, a.status, a.message_seq) for a in attachments} == {
            ("photo", "processing", seq)
        }
        conn = sqlite3.connect(str(db_path))
        try:
            assert [r[0] for r in conn.execute("SELECT DISTINCT mime FROM uploads")] == [
                "image/jpeg"
            ]
            events = [
                r[0]
                for r in conn.execute(
                    "SELECT type FROM events WHERE message_seq = ? ORDER BY event_seq", (seq,)
                )
            ]
        finally:
            conn.close()
        assert events[-1] == "message_updated"
        # They are the ANCHOR MESSAGE's attachments, so the message carries them like any photo.
        message = store.list_messages(before=None, limit=10)[0]
        anchor = next(m for m in message if m.seq == seq) if isinstance(message, list) else None
        assert anchor is None or len(anchor.attachments) == 3

    def test_the_attach_is_a_compare_and_set_it_happens_once(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        first = stage(paths, 2)
        assert store.create_adventure_picture_attachments(
            anchor_seq=seq, images=first, pictures_json=slots_json(2), by_email=None, now=1.0
        )
        again = [(f"{i:02d}" + "b" * 30, 13) for i in range(2)]
        assert not store.create_adventure_picture_attachments(
            anchor_seq=seq, images=again, pictures_json=slots_json(2), by_email=None, now=2.0
        )
        assert count_rows(db_path, "attachments") == 2
        assert [a.id for a in store.adventure_picture_attachments(anchor_seq=seq)] == [
            i for i, _ in first
        ]

    @pytest.mark.parametrize("how", ["rejected", "pack_not_ready", "images_not_pending", "gone"])
    def test_it_refuses_a_round_that_no_longer_wants_pictures(
        self,
        store: LiveChatStore,
        bank: AdventureBank,
        paths: ProjectPaths,
        db_path: Path,
        how: str,
    ) -> None:
        seq = ready_round(store, bank)
        if how == "rejected":
            store.decide_adventure(anchor_seq=seq, sender="Josh", decision="reject")
            with store._write_txn() as conn:  # even if the images flag were stale
                conn.execute("UPDATE adv_rounds SET images = 'pending' WHERE 1")
        elif how == "pack_not_ready":
            with store._write_txn() as conn:
                conn.execute("UPDATE adv_rounds SET pack = 'failed' WHERE 1")
        elif how == "images_not_pending":
            store.fail_adventure_pictures(anchor_seq=seq, now=1.0)
        else:
            with store._write_txn() as conn:
                conn.execute("DELETE FROM adv_rounds WHERE 1")
        images = stage(paths, 2)
        assert not store.create_adventure_picture_attachments(
            anchor_seq=seq, images=images, pictures_json=slots_json(2), by_email=None, now=3.0
        )
        assert count_rows(db_path, "attachments") == 0 and count_rows(db_path, "uploads") == 0
        # The ids are journaled for cleanup (the caller also removes the staged files).
        assert count_rows(db_path, "deleted_storage") >= 2

    def test_the_slot_map_is_stored_with_the_attachments_or_not_at_all(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank)
        images = stage(paths, 2)
        # An id journaled as deleted (its anchor vanished before) makes the whole attach fail.
        with store._write_txn() as conn:
            store._queue_deleted_storage(conn, kind="attachment", ids=[images[1][0]], now=1.0)
        assert not store.create_adventure_picture_attachments(
            anchor_seq=seq, images=images, pictures_json=slots_json(2), by_email=None, now=2.0
        )
        row = round_of(store, seq)
        assert row.images == "pending" and row.pictures_json is None
        assert store.adventure_picture_attachments(anchor_seq=seq) == ()


class TestGalleryAndRev:
    def test_the_packs_pictures_are_not_in_the_gallery_but_ordinary_photos_are(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        # An ordinary photo someone sent.
        store.create_attachment(att_id="mine", kind="photo", now=1.0)
        make_ready(store)
        store.create_message(
            client_id="client-0000001",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            text=None,
            attachment_ids=("mine",),
            now=2.0,
        )
        seq = ready_round(store, bank)
        store.create_adventure_picture_attachments(
            anchor_seq=seq,
            images=stage(paths, 3),
            pictures_json=slots_json(3),
            by_email=None,
            now=3.0,
        )
        assert make_ready(store) == 3
        rows, _ = store.list_gallery(before=None, limit=20)
        assert [r.id for r in rows] == ["mine"]

    def test_a_picture_becoming_ready_moves_the_rounds_rev_and_only_its_own(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths, db_path: Path
    ) -> None:
        mine = ready_round(store, bank, cid="adv-client-0001")
        other = start_round(store, "adv-client-0002")
        store.create_adventure_picture_attachments(
            anchor_seq=mine,
            images=stage(paths, 2),
            pictures_json=slots_json(2),
            by_email=None,
            now=3.0,
        )
        before, other_before = round_of(store, mine).rev, round_of(store, other).rev
        assert make_ready(store, now=9.0) == 2
        assert round_of(store, mine).rev == before + 2  # one per picture, so a client re-fetches
        assert round_of(store, other).rev == other_before


# -- the job -------------------------------------------------------------------------------------


def make_job(
    store: LiveChatStore,
    bank: AdventureBank,
    paths: ProjectPaths,
    finder: FakePictureFinder,
    *,
    space_ok: Any = None,
    timing: PictureTiming | None = None,
    clock: Any = time.time,
) -> tuple[AdventurePictureJob, MagicMock]:
    notifier = MagicMock(spec=LiveChatNotifier)
    job = AdventurePictureJob(
        store=store,
        paths=paths,
        bank=bank,
        finder=finder,
        notifier=notifier,
        space_ok=space_ok,
        timing=timing,
        clock=clock,
    )
    return job, notifier


def staged_dirs(paths: ProjectPaths) -> list[str]:
    root = paths.server_uploads
    return sorted(p.name for p in root.iterdir()) if root.exists() else []


class TestJob:
    def test_the_job_finds_stages_and_attaches_the_pictures_then_publishes(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank)
        finder = FakePictureFinder(sample_pictures(4, hero=2))
        job, notifier = make_job(store, bank, paths, finder)
        anyio.run(job.run, seq)

        row = round_of(store, seq)
        assert row.images == "done"
        stored = json.loads(row.pictures_json or "")
        assert [s["slot"] for s in stored["slots"]] == ["hero:0", "hero:1", "food:0", "food:1"]
        assert [s["ordinal"] for s in stored["slots"]] == [0, 1, 2, 3]
        assert stored["slots"][0]["credit"] == "Photo 0, CC BY 4.0"
        assert (
            stored["slots"][0]["caption"] == "Caption 0" and stored["slots"][1]["caption"] is None
        )
        attachments = store.adventure_picture_attachments(anchor_seq=seq)
        assert len(attachments) == 4
        for attachment, picture in zip(attachments, finder.pictures, strict=True):
            source = paths.server_upload_dir(attachment.id) / "assembled"
            assert source.read_bytes() == picture.jpeg  # the media queue's source
        assert notifier.publish.call_count == 1
        # The plan was built from the PACK and the bank destination, nothing from the chat.
        (plan,) = finder.plans
        assert plan.destination_wikipedia == "Lisbon"
        assert [s.key for s in plan.slots][:2] == ["sights:0", "food:0"]
        assert plan.unit == bank.unit_name("AAA")

    def test_nothing_found_ends_the_wait_with_no_attachments(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank)
        job, notifier = make_job(store, bank, paths, FakePictureFinder([]))
        anyio.run(job.run, seq)
        assert round_of(store, seq).images == "failed"
        assert store.adventure_picture_attachments(anchor_seq=seq) == ()
        assert notifier.publish.call_count == 1 and staged_dirs(paths) == []

    def test_a_finder_that_raises_ends_the_wait_and_the_error_does_not_escape(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank)
        job, _ = make_job(store, bank, paths, FakePictureFinder(error=RuntimeError("boom")))
        anyio.run(job.run, seq)
        assert round_of(store, seq).images == "failed" and staged_dirs(paths) == []

    def test_a_round_that_is_not_waiting_is_left_alone(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank, pictures_pending=False)
        finder = FakePictureFinder()
        job, notifier = make_job(store, bank, paths, finder)
        anyio.run(job.run, seq)
        anyio.run(job.run, 12345)  # no such round
        assert finder.plans == [] and round_of(store, seq).images == "none"
        assert notifier.publish.call_count == 0

    def test_running_the_job_twice_attaches_once(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        job, _ = make_job(store, bank, paths, FakePictureFinder(sample_pictures(3)))
        anyio.run(job.run, seq)
        anyio.run(job.run, seq)
        assert count_rows(db_path, "attachments") == 3 and len(staged_dirs(paths)) == 3

    def test_no_room_means_no_pictures_and_nothing_left_on_disk(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank)
        sizes: list[int] = []

        def no_room(size: int) -> bool:
            sizes.append(size)
            return False

        job, _ = make_job(
            store, bank, paths, FakePictureFinder(sample_pictures(3)), space_ok=no_room
        )
        anyio.run(job.run, seq)
        assert round_of(store, seq).images == "failed" and staged_dirs(paths) == []
        assert sizes and sizes[0] > 0

    def test_a_round_rejected_while_the_hunt_runs_attaches_nothing_and_leaves_no_files(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        finder = FakePictureFinder(sample_pictures(3), hold=True)
        job, _ = make_job(store, bank, paths, finder)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(job.run, seq)
                while not finder.started.is_set():
                    await anyio.sleep(0.01)
                await anyio.to_thread.run_sync(
                    lambda: store.decide_adventure(anchor_seq=seq, sender="Rose", decision="reject")
                )
                finder.release.set()

        anyio.run(go)
        assert finder.wanted_after_release == [False]
        assert count_rows(db_path, "attachments") == 0 and staged_dirs(paths) == []
        assert round_of(store, seq).images == "failed"

    def test_a_round_deleted_while_the_hunt_runs_attaches_nothing(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        finder = FakePictureFinder(sample_pictures(3), hold=True)
        job, notifier = make_job(store, bank, paths, finder)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(job.run, seq)
                while not finder.started.is_set():
                    await anyio.sleep(0.01)
                await anyio.to_thread.run_sync(
                    lambda: store.delete_message(seq=seq, now=time.time())
                )
                finder.release.set()

        anyio.run(go)
        assert count_rows(db_path, "attachments") == 0 and staged_dirs(paths) == []
        assert store.get_adventure_round(anchor_seq=seq) is None
        assert notifier.publish.call_count == 0  # nothing to tell anyone

    def test_two_processes_hunting_the_same_round_attach_one_set(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths, db_path: Path
    ) -> None:
        """A blue/green overlap: both run the job; the compare-and-set lets one attach, and the
        other removes what it staged."""
        seq = ready_round(store, bank)
        job_a, _ = make_job(store, bank, paths, FakePictureFinder(sample_pictures(3, label="A")))
        job_b, _ = make_job(store, bank, paths, FakePictureFinder(sample_pictures(2, label="B")))

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(job_a.run, seq)
                tg.start_soon(job_b.run, seq)

        anyio.run(go)
        attachments = store.adventure_picture_attachments(anchor_seq=seq)
        assert len(attachments) in (2, 3)
        assert count_rows(db_path, "attachments") == len(attachments)
        assert sorted(staged_dirs(paths)) == sorted(a.id for a in attachments)
        assert round_of(store, seq).images == "done"

    def test_startup_redoes_the_hunt_for_every_round_still_pending(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        pending = ready_round(store, bank, cid="adv-client-0001")
        banked = ready_round(store, bank, cid="adv-client-0002", state="banked")
        skipped = ready_round(store, bank, cid="adv-client-0003", pictures_pending=False)
        finder = FakePictureFinder(sample_pictures(2))
        job, _ = make_job(store, bank, paths, finder)

        async def go() -> int:
            async with anyio.create_task_group() as tg:
                found = await job.resume(ContainedTaskGroup(tg, BackgroundTaskHealth()))
                # leaving the group waits for the spawned jobs
            return found

        assert anyio.run(go) == 2
        assert round_of(store, pending).images == "done"
        assert round_of(store, banked).images == "done"
        assert round_of(store, skipped).images == "none"
        assert len(finder.plans) == 2

    def test_a_job_stopped_by_shutdown_leaves_the_round_pending_for_the_next_start(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank)
        finder = FakePictureFinder(sample_pictures(2), hold=True)
        job, _ = make_job(store, bank, paths, finder)

        async def go() -> None:
            with anyio.move_on_after(0.3):  # the app stopping: the job is cancelled mid-hunt
                await job.run(seq)

        anyio.run(go)
        assert finder.started.is_set()
        assert round_of(store, seq).images == "pending"  # not failed: the next start redoes it
        assert store.adventure_pending_pictures() == [seq]
        assert staged_dirs(paths) == []


# -- a pending wait heals itself (audit round 3, F4) ---------------------------------------------


class TestHuntBookkeeping:
    def test_the_first_hunt_is_recorded_with_the_pack(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        seq = ready_round(store, bank, now=1000.0)
        row = round_of(store, seq)
        assert (row.images, row.images_started_at, row.images_tries) == ("pending", 1000.0, 1)
        none = ready_round(store, bank, cid="adv-client-0002", pictures_pending=False, now=1000.0)
        row = round_of(store, none)
        assert (row.images, row.images_started_at, row.images_tries) == ("none", None, 0)

    def test_a_retry_forgets_the_old_hunt(self, store: LiveChatStore, bank: AdventureBank) -> None:
        seq = start_round(store)
        to_chosen(store, bank, seq)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="r")
        store.finish_adventure_pack(anchor_seq=seq, run_id="r", state="failed", error="no")
        row, _ = store.retry_adventure_pack(anchor_seq=seq, researcher_available=True)
        assert row.images_started_at is None and row.images_tries == 0

    def test_stale_rounds_are_the_pending_ones_whose_hunt_began_before_the_cut(
        self, store: LiveChatStore, bank: AdventureBank
    ) -> None:
        old = ready_round(store, bank, cid="adv-client-0001", now=1000.0)
        young = ready_round(store, bank, cid="adv-client-0002", now=2000.0)
        banked = ready_round(store, bank, cid="adv-client-0003", now=1000.0, state="banked")
        ready_round(store, bank, cid="adv-client-0004", pictures_pending=False, now=1000.0)
        rejected = ready_round(store, bank, cid="adv-client-0005", now=1000.0)
        store.decide_adventure(anchor_seq=rejected, sender="Josh", decision="reject")
        assert store.adventure_stale_pictures(stale_before=1500.0) == [old, banked]
        assert store.adventure_stale_pictures(stale_before=3000.0) == [old, young, banked]
        assert store.adventure_stale_pictures(stale_before=500.0) == []

    def test_a_claim_is_a_compare_and_set_that_counts_tries_and_gives_up(
        self, store: LiveChatStore, bank: AdventureBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank, now=1000.0)  # try 1 began at 1000

        def claim(stale_before: float | None, now: float) -> str:
            return store.claim_adventure_pictures(
                anchor_seq=seq, stale_before=stale_before, now=now
            )

        assert claim(900.0, 1100.0) == "not_due"  # the hunt (1000) is younger than the cut
        assert claim(1001.0, 1100.0) == "claimed"  # began before the cut: abandoned
        row = round_of(store, seq)
        assert (row.images_started_at, row.images_tries) == (1100.0, 2)
        assert claim(1050.0, 1200.0) == "not_due"  # another sweeper already claimed it
        assert claim(None, 1300.0) == "claimed"  # a startup redo claims unconditionally
        assert round_of(store, seq).images_tries == 3
        rev = round_of(store, seq).rev
        assert claim(1400.0, 1500.0) == "gave_up"  # three hunts began, none finished
        row = round_of(store, seq)
        assert row.images == "failed" and row.rev == rev + 1
        assert claim(None, 1600.0) == "gone"
        conn = sqlite3.connect(str(db_path))
        try:
            events = [
                r[0]
                for r in conn.execute(
                    "SELECT type FROM events WHERE message_seq = ? ORDER BY event_seq", (seq,)
                )
            ]
        finally:
            conn.close()
        assert events[-1] == "message_updated"

    @pytest.mark.parametrize("how", ["done", "rejected", "pack_failed", "deleted", "unknown"])
    def test_a_round_that_no_longer_waits_cannot_be_claimed(
        self,
        store: LiveChatStore,
        bank: AdventureBank,
        paths: ProjectPaths,
        how: str,
    ) -> None:
        seq = ready_round(store, bank, now=1000.0)
        if how == "done":
            store.create_adventure_picture_attachments(
                anchor_seq=seq,
                images=stage(paths, 1),
                pictures_json=slots_json(1),
                by_email=None,
                now=1.0,
            )
        elif how == "rejected":
            store.decide_adventure(anchor_seq=seq, sender="Josh", decision="reject")
        elif how == "pack_failed":
            with store._write_txn() as conn:
                conn.execute("UPDATE adv_rounds SET pack = 'failed' WHERE 1")
        elif how == "deleted":
            store.delete_message(seq=seq, now=2.0)
        target = 9999 if how == "unknown" else seq
        assert (
            store.claim_adventure_pictures(anchor_seq=target, stale_before=None, now=5000.0)
            == "gone"
        )


class TestSelfHealing:
    """The hand-off the audit found: the OLD process wins the pack, sets `images = pending`, starts
    hunting, and is stopped mid-hunt AFTER the new process already did its startup redo."""

    TIMING = PictureTiming(watch_interval_s=0.02, stale_after_s=360.0, max_tries=3)

    def test_a_hunt_stopped_by_the_old_side_of_a_hand_off_is_redone_by_the_new_side(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank, now=1000.0)  # process A stored the pack at t=1000...
        stuck = FakePictureFinder(sample_pictures(3), hold=True)
        job_a, _ = make_job(store, bank, paths, stuck, clock=lambda: 1000.0)

        async def a_runs_then_is_stopped() -> None:
            with anyio.move_on_after(0.3):  # ...started hunting; Slots stops it 30 s later
                await job_a.run(seq)

        anyio.run(a_runs_then_is_stopped)
        assert stuck.started.is_set()
        assert (round_of(store, seq).images, staged_dirs(paths)) == ("pending", [])

        # Process B did its startup redo BEFORE A won the pack, so it never looks at this round
        # again on its own. Its sweep runs while the wait is still young: nothing happens...
        fresh = FakePictureFinder(sample_pictures(3))
        job_b, notifier_b = make_job(
            store, bank, paths, fresh, timing=self.TIMING, clock=lambda: 1100.0
        )

        async def sweep(job: AdventurePictureJob) -> int:
            result = 0
            async with anyio.create_task_group() as tg:
                result = await job.sweep(ContainedTaskGroup(tg, BackgroundTaskHealth()))
            return result

        assert anyio.run(sweep, job_b) == 0 and fresh.plans == []
        assert round_of(store, seq).images == "pending"

        # ...and once the wait is older than a hunt can last, B re-claims it and finishes it.
        job_late, notifier_late = make_job(
            store, bank, paths, fresh, timing=self.TIMING, clock=lambda: 1400.0
        )
        assert anyio.run(sweep, job_late) == 1
        row = round_of(store, seq)
        assert (
            row.images == "done" and len(store.adventure_picture_attachments(anchor_seq=seq)) == 3
        )
        assert (row.images_started_at, row.images_tries) == (1400.0, 2)
        assert notifier_late.publish.call_count == 1 and notifier_b.publish.call_count == 0

    def test_the_supervised_loop_heals_a_wait_nobody_is_hunting(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank, now=time.time() - 1000.0)
        finder = FakePictureFinder(sample_pictures(2))
        job, _ = make_job(
            store,
            bank,
            paths,
            finder,
            timing=PictureTiming(watch_interval_s=0.02, stale_after_s=0.2, max_tries=3),
        )

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                job_group = ContainedTaskGroup(tg, BackgroundTaskHealth())
                job_group.supervise("watch", lambda: job.watch_forever(job_group))
                with anyio.fail_after(10):
                    while round_of(store, seq).images == "pending":
                        await anyio.sleep(0.02)
                tg.cancel_scope.cancel()

        anyio.run(go)
        assert round_of(store, seq).images == "done" and len(finder.plans) == 1

    def test_a_failure_to_even_end_the_wait_is_healed_by_the_next_sweep(
        self,
        store: LiveChatStore,
        bank: AdventureBank,
        paths: ProjectPaths,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """`fail_adventure_pictures` itself fails (SQLite busy): the round stays pending, the next
        sweep re-hunts it and, this time, ends the wait."""
        seq = ready_round(store, bank, now=1000.0)
        real = store.fail_adventure_pictures
        failures = {"left": 1}

        def flaky(*, anchor_seq: int, now: float) -> bool:
            if failures["left"]:
                failures["left"] -= 1
                raise sqlite3.OperationalError("database is locked")
            return real(anchor_seq=anchor_seq, now=now)

        monkeypatch.setattr(store, "fail_adventure_pictures", flaky)
        finder = FakePictureFinder([])  # finds nothing: the hunt ends the wait as `failed`
        job, _ = make_job(store, bank, paths, finder, timing=self.TIMING, clock=lambda: 1400.0)
        anyio.run(job.run, seq)
        assert round_of(store, seq).images == "pending"  # could not be recorded

        async def sweep() -> int:
            started = 0
            async with anyio.create_task_group() as tg:
                started = await job.sweep(ContainedTaskGroup(tg, BackgroundTaskHealth()))
            return started

        assert anyio.run(sweep) == 1
        assert round_of(store, seq).images == "failed" and len(finder.plans) == 2

    def test_hunts_that_keep_dying_end_after_the_try_limit(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank, now=1000.0)  # try 1 was the pack's own hunt
        hung = FakePictureFinder(sample_pictures(2), hold=True)
        now = {"t": 1000.0}
        job, notifier = make_job(
            store, bank, paths, hung, timing=self.TIMING, clock=lambda: now["t"]
        )

        async def one_hunt_that_dies() -> int:
            async with anyio.create_task_group() as tg:
                started = await job.sweep(ContainedTaskGroup(tg, BackgroundTaskHealth()))
                await anyio.sleep(0.1)  # the hunt begins, then dies with its process (cancelled)
                tg.cancel_scope.cancel()
            return started

        started: list[int] = []
        for _ in range(5):
            if round_of(store, seq).images != "pending":
                break
            now["t"] += 400.0  # the wait outlives a hunt each time
            started.append(anyio.run(one_hunt_that_dies))
        assert started == [1, 1, 0]  # tries 2 and 3 hunted; the next sweep ends the wait instead
        row = round_of(store, seq)
        assert (row.images, row.images_tries) == ("failed", 3)
        assert notifier.publish.call_count == 1  # the give-up is announced
        assert store.adventure_picture_attachments(anchor_seq=seq) == ()

    def test_the_sweep_leaves_a_round_this_process_is_hunting_alone(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        seq = ready_round(store, bank, now=1000.0)
        slow = FakePictureFinder(sample_pictures(2), hold=True)
        job, _ = make_job(store, bank, paths, slow, timing=self.TIMING, clock=lambda: 9999.0)

        async def go() -> int:
            started = -1
            async with anyio.create_task_group() as tg:
                group = ContainedTaskGroup(tg, BackgroundTaskHealth())
                tg.start_soon(job.run, seq)
                while not slow.started.is_set():
                    await anyio.sleep(0.01)
                started = await job.sweep(group)  # long past stale, but it is running right here
                slow.release.set()
            return started

        assert anyio.run(go) == 0
        assert len(slow.plans) == 1 and round_of(store, seq).images == "done"

    def test_two_sweepers_start_one_hunt(
        self, store: LiveChatStore, bank: AdventureBank, paths: ProjectPaths
    ) -> None:
        """A blue/green overlap: both processes sweep at once; the claim is a compare-and-set."""
        seq = ready_round(store, bank, now=1000.0)
        finder_a, finder_b = FakePictureFinder(sample_pictures(2)), FakePictureFinder([])
        job_a, _ = make_job(store, bank, paths, finder_a, timing=self.TIMING, clock=lambda: 1400.0)
        job_b, _ = make_job(store, bank, paths, finder_b, timing=self.TIMING, clock=lambda: 1400.0)

        async def go() -> list[int]:
            async with anyio.create_task_group() as tg:
                group = ContainedTaskGroup(tg, BackgroundTaskHealth())
                a = await job_a.sweep(group)
                b = await job_b.sweep(group)
            return [a, b]

        assert sorted(anyio.run(go)) == [0, 1]
        assert len(finder_a.plans) + len(finder_b.plans) == 1
        assert round_of(store, seq).images_tries == 2


# -- through the app: the view, the media, erasure, restart --------------------------------------


def wait_for_pictures(
    client: Any, headers: dict[str, str], seq: int, *, count: int, timeout_s: float = 30.0
) -> dict[str, Any]:
    """Poll the view until the pictures are all there (stored AND processed by the media queue)."""
    deadline = time.monotonic() + timeout_s
    while True:
        view = get_view(client, headers, seq)
        pictures = view["pack"]["pictures"]
        shown = len(pictures["hero"]) + len(pictures["items"])
        if view["pack"]["images"] == "done" and shown == count:
            return view
        if time.monotonic() > deadline:
            raise AssertionError(f"pictures never arrived: {view['pack']}")
        time.sleep(0.05)


def app_store(client: Any) -> LiveChatStore:
    store: LiveChatStore = client.app.state.livechat_store
    return store


def app_paths(client: Any) -> ProjectPaths:
    paths: ProjectPaths = client.app.state.paths
    return paths


def raw_db(client: Any) -> bytes:
    store = app_store(client)
    wal = Path(f"{store._db_path}-wal")
    return store._db_path.read_bytes() + (wal.read_bytes() if wal.exists() else b"")


class TestThroughTheApp:
    def test_a_ready_pack_gets_its_pictures_with_signed_urls_credits_and_captions(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        finder = FakePictureFinder(sample_pictures(4, hero=2))
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, picture_finder=finder) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            first = wait_for_pack(client, h, seq, "ready")
            assert first["pack"]["images"] in ("pending", "done")  # the text pack shows at once
            view = wait_for_pictures(client, h, seq, count=4)

            pictures = view["pack"]["pictures"]
            assert [p["credit"] for p in pictures["hero"]] == [
                "Photo 0, CC BY 4.0",
                "Photo 1, CC BY 4.0",
            ]
            assert sorted(pictures["items"]) == ["food:0", "food:1"]
            hero = pictures["hero"][0]
            assert set(hero) == {"thumbUrl", "fullUrl", "credit", "page", "caption"}
            assert hero["page"] == "https://commons.example.org/wiki/File:Photo_0.jpg"
            assert hero["caption"] == "Caption 0" and pictures["hero"][1]["caption"] is None
            assert pictures["items"]["food:0"]["caption"] == "Caption 2"
            for url in (hero["thumbUrl"], hero["fullUrl"]):
                assert url.startswith("/api/admin/server/media/") and "sig=" in url
                response = client.get(url, headers=h)
                assert response.status_code == 200
                assert response.headers["content-type"].startswith("image/jpeg")
            # The pack itself is untouched by the pictures (and carries the article hints).
            assert (
                view["pack"]["state"] == "ready" and view["pack"]["data"]["wikipedia"] == "Lisbon"
            )

    def test_dish_pictures_are_keyed_dishes_i_like_every_other_item(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        finder = FakePictureFinder(sample_pictures(5, hero=2, item_section="dishes"))
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, picture_finder=finder) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            view = wait_for_pictures(client, h, seq, count=5)
            pictures = view["pack"]["pictures"]
            assert len(pictures["hero"]) == 2
            assert sorted(pictures["items"]) == ["dishes:0", "dishes:1", "dishes:2"]
            assert set(pictures["items"]["dishes:0"]) == {
                "thumbUrl",
                "fullUrl",
                "credit",
                "page",
                "caption",
            }

    def test_pictures_are_not_sent_media_they_stay_out_of_the_gallery(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, picture_finder=FakePictureFinder()
        ) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            wait_for_pictures(client, h, seq, count=3)
            gallery = client.get(f"{BASE}/gallery", headers=h).json()
            assert gallery == {"items": [], "hasMore": False}
            message = next(
                m
                for m in client.get(f"{BASE}/messages", headers=h).json()["messages"]
                if m["seq"] == seq
            )
            assert len(message["attachments"]) == 3  # they ARE the anchor message's attachments

    def test_the_round_rev_moves_as_each_picture_becomes_ready(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, picture_finder=FakePictureFinder()
        ) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            wait_for_pictures(client, h, seq, count=3)

            def message_rev() -> int:
                message = next(
                    m
                    for m in client.get(f"{BASE}/messages", headers=h).json()["messages"]
                    if m["seq"] == seq
                )
                return int(message["adventure"]["rev"])

            # The message summary's rev (what a client compares) settles on the view's.
            wait_for(
                lambda: message_rev() == get_view(client, h, seq)["rev"],
                what="the summary rev to match the view",
            )

    def test_with_no_picture_finder_the_pack_simply_has_no_pictures(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            view = wait_for_pack(client, h, seq, "ready")
            assert view["pack"]["images"] == "done"
            assert view["pack"]["pictures"] == {"hero": [], "items": {}}
            store = app_store(client)
            assert store.get_adventure_round(anchor_seq=seq).images == "none"  # type: ignore[union-attr]

    def test_rejecting_while_the_hunt_runs_attaches_nothing(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        finder = FakePictureFinder(hold=True)
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, picture_finder=finder) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            wait_for(lambda: finder.started.is_set(), what="the picture hunt to start")
            assert get_view(client, h, seq)["pack"]["images"] == "pending"
            rejected = post(client, h, f"/adventure/{seq}/decide", sender="Rose", decision="reject")
            assert rejected.status_code == 200
            assert rejected.json()["pack"]["images"] == "done"  # nothing more is coming
            finder.release.set()
            wait_for(lambda: finder.wanted_after_release == [False], what="the job to notice")
            store = app_store(client)
            assert store.adventure_picture_attachments(anchor_seq=seq) == ()

    def test_deleting_the_message_mid_hunt_attaches_nothing(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        finder = FakePictureFinder(hold=True)
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, picture_finder=finder) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            wait_for(lambda: finder.started.is_set(), what="the picture hunt to start")
            assert client.delete(f"{BASE}/messages/{seq}", headers=h).status_code in (202, 204)
            finder.release.set()
            wait_for(lambda: finder.wanted_after_release == [False], what="the job to notice")
            paths = app_paths(client)
            assert not paths.server_uploads.exists() or list(paths.server_uploads.iterdir()) == []
            assert client.get(f"{BASE}/adventure/{seq}", headers=h).status_code == 404

    def test_a_restart_redoes_a_hunt_the_last_process_never_finished(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        stuck = FakePictureFinder(hold=True)
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, picture_finder=stuck) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            wait_for(lambda: stuck.started.is_set(), what="the picture hunt to start")
            store = app_store(client)
            assert store.get_adventure_round(anchor_seq=seq).images == "pending"  # type: ignore[union-attr]
        # The app stopped mid-hunt (the context exit cancelled the job). A new process starts:
        fresh = FakePictureFinder(sample_pictures(3))
        again = CmdPinVerifier(  # the first process closed its verifier on the way out
            app_key=TEST_APP_KEY,
            transport=httpx.ASGITransport(app=create_fake_cmd_app(fake_cmd_state)),
        )
        with unlocked_client(storage_root, wixy_repo_root, again, picture_finder=fresh) as (
            client,
            h,
        ):
            view = wait_for_pictures(client, h, seq, count=3)
            assert view["pack"]["images"] == "done" and len(fresh.plans) == 1

    def test_deleting_the_message_erases_the_pictures_their_credits_and_their_files(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        sentinel = "ZZ-PICTURE-CREDIT-SENTINEL-7731"
        finder = FakePictureFinder(sample_pictures(3, label=sentinel))
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, picture_finder=finder) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            wait_for_pictures(client, h, seq, count=3)
            store = app_store(client)
            paths = app_paths(client)
            ids = [a.id for a in store.adventure_picture_attachments(anchor_seq=seq)]
            assert len(ids) == 3 and sentinel.encode() in raw_db(client)
            assert all(paths.server_attachment_media_dir(i).exists() for i in ids)

            assert client.delete(f"{BASE}/messages/{seq}", headers=h).status_code in (202, 204)
            assert sentinel.encode() not in raw_db(client)
            wait_for(
                lambda: not any(paths.server_attachment_media_dir(i).exists() for i in ids),
                what="the picture files to be erased",
            )
            assert client.get(f"{BASE}/adventure/{seq}", headers=h).status_code == 404

    def test_a_wipe_erases_the_pictures_too(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        sentinel = "ZZ-WIPE-CREDIT-SENTINEL-3318"
        finder = FakePictureFinder(sample_pictures(3, label=sentinel))
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, picture_finder=finder) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            post(client, h, f"/adventure/{seq}/decide", sender="Josh", decision="bank")
            wait_for_pictures(client, h, seq, count=3)
            store = app_store(client)
            paths = app_paths(client)
            ids = [a.id for a in store.adventure_picture_attachments(anchor_seq=seq)]
            assert sentinel.encode() in raw_db(client)

            assert client.post(f"{BASE}/wipe", json={"confirm": "WIPE"}, headers=h).status_code in (
                202,
                204,
            )
            assert sentinel.encode() not in raw_db(client)
            wait_for(
                lambda: not any(paths.server_attachment_media_dir(i).exists() for i in ids),
                what="the picture files to be erased",
            )
            assert client.get(f"{BASE}/adventure/bank", headers=h).json() == {"trips": []}

    def test_the_app_heals_a_wait_whose_hunt_died_with_another_process(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """The supervised sweep is wired into the app: a round left `images = pending` by a process
        that stored the pack and then stopped is hunted again, with nobody calling anything."""
        finder = FakePictureFinder(sample_pictures(3))
        researcher = FakeResearcher([FakeRunPlan(statuses=["running"])])
        timing = PictureTiming(watch_interval_s=0.05, stale_after_s=0.3, max_tries=3)
        with unlocked_client(
            storage_root,
            wixy_repo_root,
            pin_verifier,
            researcher=researcher,
            picture_finder=finder,
            picture_timing=timing,
        ) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)  # the research is still running in THIS process...
            store = app_store(client)
            wait_for(
                lambda: (
                    (r := store.get_adventure_round(anchor_seq=seq)) is not None
                    and r.pack_run_id == "fake-run-1"
                ),
                what="the research run to be recorded",
            )
            # ...while "the other process" stores the pack and starts a hunt that never finishes.
            assert store.finish_adventure_pack(
                anchor_seq=seq,
                run_id="fake-run-1",
                state="ready",
                pack_json=PACK_JSON,
                pictures_pending=True,
                now=time.time() - 100.0,
            )
            view = wait_for_pictures(client, h, seq, count=3)
            assert view["pack"]["images"] == "done" and len(finder.plans) == 1
            assert store.get_adventure_round(anchor_seq=seq).images_tries == 2  # type: ignore[union-attr]


class TestTheRealFinderThroughTheApp:
    """The whole chain with the production `WebPictureFinder` and `SafeFetcher` (only the resolver,
    policy and port injected), against a fake Wikipedia, Commons and venue on loopback."""

    def test_a_pack_gets_pictures_from_wikipedia_commons_and_the_venue(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        web = FakeWeb()
        port = web.start_threaded()
        try:
            open_web = FakeOpenWeb(web)
            lead = open_web.add_file(FakeFile("Lisbon Skyline.jpg", 4000, 2667, seed=1))
            open_web.add_article("Lisbon", lead, description="Capital of Portugal")
            dish = open_web.add_file(FakeFile("Pastel de nata.jpg", 3000, 2000, seed=2))
            open_web.add_article("Pastel de nata", dish)
            tower = open_web.add_file(FakeFile("Belem Tower.jpg", 3000, 2000, seed=3))
            open_web.add_article("Belém Tower", tower)
            more = [
                open_web.add_file(FakeFile(f"Lisbon Street {i}.jpg", 4000, 2667, seed=10 + i)).title
                for i in range(4)
            ]
            open_web.add_search("Alpha One", more)  # the fixture bank's destination
            open_web.add_venue(
                "alfama.example.com", "/stay", og_image="/img/hero.jpg", site_name="Casa Alfama"
            )

            pack = json.loads(json.dumps(CANNED_ADVENTURE_PACK))
            pack["sections"][1]["items"][0]["url"] = f"http://alfama.example.com:{port}/stay"
            researcher = FakeResearcher([FakeRunPlan(response_text=json.dumps(pack))])
            finder = WebPictureFinder(local_fetcher(port), endpoints=open_web.endpoints)

            with unlocked_client(
                storage_root,
                wixy_repo_root,
                pin_verifier,
                researcher=researcher,
                picture_finder=finder,
            ) as (client, h):
                seq = create_round(client, h).json()["message"]["seq"]
                route_to_chosen(client, h, seq, unit="AAA")
                # hero: the Lisbon lead + 4 search photos; items: Belém Tower, the nata, the villa
                view = wait_for_pictures(client, h, seq, count=5 + 3)
                pictures = view["pack"]["pictures"]
                assert len(pictures["hero"]) == 5
                assert pictures["hero"][0]["caption"] == "Capital of Portugal"
                assert pictures["hero"][0]["credit"] == "Jane Doe, CC BY-SA 4.0"
                assert pictures["hero"][0]["page"].endswith("/wiki/File:Lisbon_Skyline.jpg")
                assert sorted(pictures["items"]) == ["food:0", "sights:0", "stay:0"]
                assert pictures["items"]["stay:0"]["credit"] == "Casa Alfama"
                assert (
                    pictures["items"]["stay:0"]["page"] == f"http://alfama.example.com:{port}/stay"
                )
                # Fetched by the server only; the stored files are clean JPEGs.
                response = client.get(pictures["hero"][0]["fullUrl"], headers=h)
                assert response.status_code == 200
                assert b"WIXY-EXIF-SENTINEL" not in response.content
                # Every outbound request carried the descriptive User-Agent.
                assert web.requests
                assert all("wixy" in r.headers["user-agent"].lower() for r in web.requests)
        finally:
            web.stop_threaded()
