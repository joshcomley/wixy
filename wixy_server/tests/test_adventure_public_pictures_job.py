# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The public holiday pack's picture job (workspace 00065, spec/adventure-public/README.md §2.2): a
full-size and a thumbnail file per picture, all-or-nothing per pack, the lost race, startup resume,
the supervised stale sweep, the give-up, the orphan sweep, the free-space floor — and the wiring of
the production defaults (Commons-only finder, its own cmd caller) on the same default path as the
private game."""

from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path
from typing import Any

import anyio
import pytest
from PIL import Image

from wixy_server.adventure_public.pictures import (
    FULL_NAME,
    ORPHAN_AGE_S,
    THUMB_LONG_EDGE,
    THUMB_NAME,
)
from wixy_server.adventure_public.runner import PUBLIC_PACK_CALLER
from wixy_server.app import create_app
from wixy_server.livechat.adventure_pictures import (
    FoundPicture,
    PictureTiming,
    WebPictureFinder,
)
from wixy_server.tests.adventure_public_testkit import (
    code_of,
    get_pack,
    public_client,
    request_pack,
    service,
    wait_for,
    wait_for_images,
    wait_for_state,
)
from wixy_server.tests.adventure_testkit import (
    FakePictureFinder,
    FakeResearcher,
    fixture_bank,
    sample_pictures,
)
from wixy_server.tests.fake_open_web import make_image
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    origin_repo,
    storage_root,
    wixy_repo_root,
)

FAST_PICTURES = PictureTiming(watch_interval_s=0.05, stale_after_s=0.2, max_tries=3)


def picture_dirs(client: Any) -> list[Path]:
    root = service(client).pictures_dir
    return sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []


def seed_ready_pack(
    client: Any,
    destination_id: str = "AAA.one",
    *,
    started: float,
    tries: int = 1,
) -> None:
    """A `ready` pack whose picture wait began at `started` (as a process that died mid-hunt, or a
    wait nobody is running, leaves it)."""
    store = service(client).store
    assert store.request_start(destination_id, now=started).kind == "started"
    assert store.set_run(destination_id, run_id="seed-run", now=started)
    assert store.finish(
        destination_id,
        run_id="seed-run",
        state="ready",
        pack_json='{"headline":"seeded","sections":[]}',
        pictures_pending=True,
        now=started,
    )
    conn = sqlite3.connect(str(store.db_path))
    try:
        conn.execute(
            "UPDATE packs SET images_tries = ? WHERE destination_id = ?", (tries, destination_id)
        )
        conn.commit()
    finally:
        conn.close()


class TestFiles:
    def test_each_picture_is_a_full_file_and_a_thumbnail_under_its_own_id(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        found = sample_pictures(4, hero=2)
        finder = FakePictureFinder(found)
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            view = wait_for_images(client, code, "done")
            stored = service(client).store.get_with_pictures("AAA.one")
            directories = picture_dirs(client)
        assert stored is not None
        rows = stored[1]
        assert [(r.slot, r.ordinal) for r in rows] == [
            ("hero:0", 0),
            ("hero:1", 1),
            ("food:0", 2),
            ("food:1", 3),
        ]
        assert sorted(d.name for d in directories) == sorted(r.id for r in rows)
        for row, source in zip(rows, found, strict=True):
            assert len(row.id) == 32 and set(row.id) <= set("0123456789abcdef")
            full = service(client).pictures_dir / row.id / FULL_NAME
            thumb = service(client).pictures_dir / row.id / THUMB_NAME
            assert full.read_bytes() == source.jpeg  # the full file is exactly what was found
            with Image.open(full) as big:
                assert (row.width, row.height) == big.size
            with Image.open(thumb) as small:
                assert small.format == "JPEG"
                assert max(small.size) <= THUMB_LONG_EDGE == 480
                assert small.size[0] / small.size[1] == pytest.approx(
                    row.width / row.height, abs=0.02
                )
            assert (row.credit, row.page, row.caption) == (
                source.credit,
                source.page,
                source.caption,
            )
        assert len(view["pictures"]["hero"]) == 2 and len(view["pictures"]["items"]) == 2

    def test_a_small_picture_is_not_enlarged_for_its_thumbnail(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        small = FoundPicture(
            slot="hero:0",
            jpeg=make_image(400, 300, seed=1, exif=False),
            credit="c",
            page="https://commons.example/File:S.jpg",
            caption=None,
            keys=frozenset({"sha256:small"}),
        )
        finder = FakePictureFinder([small])
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for_images(client, code, "done")
            stored = service(client).store.get_with_pictures("AAA.one")
            assert stored is not None
            [row] = stored[1]
            with Image.open(service(client).pictures_dir / row.id / THUMB_NAME) as thumb:
                assert thumb.size == (400, 300)

    def test_no_metadata_survives_into_either_file(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The finder already hands over metadata-free JPEGs; the thumbnail is rebuilt the same way.
        finder = FakePictureFinder(sample_pictures(2, hero=1))
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for_images(client, code, "done")
            rows = service(client).store.get_with_pictures("AAA.one")
            assert rows is not None
            for row in rows[1]:
                for name in (FULL_NAME, THUMB_NAME):
                    with Image.open(service(client).pictures_dir / row.id / name) as image:
                        assert not image.getexif() and "icc_profile" not in image.info


class TestPendingWait:
    def test_the_pack_is_served_at_once_and_its_pictures_follow(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder(hold=True)
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            view = wait_for_state(client, code, "ready")
            assert view["data"] is not None and view["images"] == "pending"
            assert view["pictures"] == {"hero": [], "items": {}}
            assert client.get(f"/api/pack/{code}").headers["cache-control"] == "no-store"
            finder.release.set()
            view = wait_for_images(client, code, "done")
            assert len(view["pictures"]["hero"]) == 2
            assert client.get(f"/api/pack/{code}").headers["cache-control"] == "public, max-age=60"

    def test_the_hunt_runs_outside_the_research_slot(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder(hold=True)
        fake = FakeResearcher()
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, finder=finder, researcher=fake
        ) as client:
            first, second = code_of(client, "AAA.one"), code_of(client, "AAA.two")
            request_pack(client, first)
            wait_for_state(client, first, "ready")
            assert finder.started.wait(5)  # the first hunt is running (held)...
            request_pack(client, second)  # ...and the next research is not blocked by it
            wait_for_state(client, second, "ready")
            finder.release.set()


class TestNoPictures:
    def test_a_hunt_that_finds_nothing_ends_the_wait_with_no_pictures(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder([])
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for(
                lambda: (service(client).store.get("AAA.one") or object()).images == "failed",  # type: ignore[attr-defined]
                what="the wait to end",
            )
            view = get_pack(client, code)
            assert view["state"] == "ready" and view["images"] == "done"
            assert view["pictures"] == {"hero": [], "items": {}}
            assert picture_dirs(client) == []

    def test_a_finder_that_raises_ends_the_wait_and_leaves_no_files(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder(error=RuntimeError("the web fell over"))
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for(
                lambda: (service(client).store.get("AAA.one") or object()).images == "failed",  # type: ignore[attr-defined]
                what="the wait to end",
            )
            assert picture_dirs(client) == []

    def test_without_a_finder_a_pack_simply_has_no_pictures(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch) as client:
            assert service(client).pictures is None
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            view = wait_for_state(client, code, "ready")
            row = service(client).store.get("AAA.one")
        assert view["images"] == "done" and view["pictures"] == {"hero": [], "items": {}}
        assert row is not None and row.images == "none"


class TestAllOrNothing:
    def test_one_unusable_picture_means_no_pictures_and_no_files(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        good = sample_pictures(2, hero=2)
        bad = FoundPicture(
            slot="food:0",
            jpeg=b"\xff\xd8 this is not a jpeg at all",
            credit="c",
            page="https://commons.example/File:Bad.jpg",
            caption=None,
            keys=frozenset({"sha256:bad"}),
        )
        finder = FakePictureFinder([*good, bad])
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for(
                lambda: (service(client).store.get("AAA.one") or object()).images == "failed",  # type: ignore[attr-defined]
                what="the wait to end",
            )
            stored = service(client).store.get_with_pictures("AAA.one")
            assert stored is not None and stored[1] == []  # not even the good two
            assert picture_dirs(client) == []  # and nothing staged is left behind

    def test_a_lost_race_removes_what_was_staged(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder()
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            store = service(client).store
            attempts: list[int] = []
            real = store.attach_pictures

            def attach(destination_id: str, pictures: Any, **kw: Any) -> bool:
                attempts.append(len(picture_dirs(client)))  # the files are staged by now
                real(destination_id, [], **kw)  # another process finishes the wait first
                return real(destination_id, pictures, **kw)

            monkeypatch.setattr(store, "attach_pictures", attach)
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for(lambda: attempts != [], what="the attach")
            wait_for(lambda: picture_dirs(client) == [], what="the staged files to be removed")
            assert attempts[0] == 3
            stored = store.get_with_pictures("AAA.one")
            assert stored is not None and stored[1] == [] and stored[0].images == "done"


class TestRecovery:
    def test_a_hunt_the_previous_process_left_pending_is_redone_at_startup(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch) as seed:
            seed_ready_pack(seed, started=time.time())
        finder = FakePictureFinder()
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            view = wait_for_images(client, code, "done")
            assert len(view["pictures"]["hero"]) == 2
            row = service(client).store.get("AAA.one")
        assert row is not None and row.images == "done" and row.images_tries == 2  # a redo is a try

    def test_the_supervised_sweep_redoes_a_hunt_that_died_after_startup(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder()
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            finder=finder,
            picture_timing=FAST_PICTURES,
        ) as client:
            # Nothing was pending at startup, so only the sweep can notice this wait.
            seed_ready_pack(client, started=time.time() - 60)
            code = code_of(client, "AAA.one")
            view = wait_for_images(client, code, "done")
            assert len(view["pictures"]["hero"]) == 2
            assert len(finder.plans) == 1

    def test_a_young_wait_is_left_alone_by_the_sweep(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder()
        slow = PictureTiming(watch_interval_s=0.05, stale_after_s=3600.0)
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, finder=finder, picture_timing=slow
        ) as client:
            seed_ready_pack(client, started=time.time())
            time.sleep(0.6)  # many sweeps
            assert finder.plans == []
            row = service(client).store.get("AAA.one")
            assert row is not None and row.images == "pending"

    def test_a_pack_whose_hunts_keep_dying_is_given_up_on(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder()
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            finder=finder,
            picture_timing=FAST_PICTURES,
        ) as client:
            seed_ready_pack(client, started=time.time() - 60, tries=3)
            wait_for(
                lambda: (service(client).store.get("AAA.one") or object()).images == "failed",  # type: ignore[attr-defined]
                what="the give-up",
            )
            assert finder.plans == []  # no fourth hunt was started

    def test_the_sweep_is_a_supervised_background_loop(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, finder=FakePictureFinder()
        ) as client:
            assert client.app.state.background_tasks is not None  # type: ignore[attr-defined]
            assert service(client).pictures is not None


class TestOrphans:
    def test_an_old_directory_no_row_owns_is_removed_a_young_one_and_an_owned_one_stay(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder(sample_pictures(1, hero=1))
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for_images(client, code, "done")
            root = service(client).pictures_dir
            owned = next(iter(root.iterdir()))
            old = root / ("a" * 32)
            young = root / ("b" * 32)
            for directory in (old, young):
                directory.mkdir()
                (directory / FULL_NAME).write_bytes(b"x")
            ancient = time.time() - ORPHAN_AGE_S - 600
            os.utime(old, (ancient, ancient))

            job = service(client).pictures
            assert job is not None
            removed = anyio.run(job.sweep_orphans)
            assert removed == 1
            assert not old.exists() and young.exists() and owned.exists()


class TestSpaceFloor:
    def test_no_room_means_no_pictures(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_SERVER_MIN_FREE_MB", str(10**9))  # a free-space floor nothing has
        finder = FakePictureFinder()
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for(
                lambda: (service(client).store.get("AAA.one") or object()).images == "failed",  # type: ignore[attr-defined]
                what="the wait to end",
            )
            assert picture_dirs(client) == []


class TestProductionWiring:
    def test_on_the_default_path_the_public_game_gets_its_own_caller_and_a_commons_only_finder(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_ADVENTURE_PUBLIC_HOST", "adventure.example.test")
        app = create_app(
            storage_root=storage_root,
            wixy_repo_root=wixy_repo_root,
            adventure_bank=fixture_bank(),
        )
        public = app.state.adventure_public
        assert public is not None
        researcher = public.runner._researcher  # noqa: SLF001
        assert researcher is not None and researcher._caller == PUBLIC_PACK_CALLER  # noqa: SLF001
        finder = public.owned_finder
        assert isinstance(finder, WebPictureFinder) and finder.allow_site_images is False
        assert public.pictures is not None
        # The private game's own finder (if any) is a different object with the default policy.
        private = app.state.livechat_adventure_runner
        assert private is not public.runner
        assert public.runner._researcher is not private._researcher  # noqa: SLF001

    def test_an_injected_private_researcher_never_gives_the_public_game_the_internet(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_ADVENTURE_PUBLIC_HOST", "adventure.example.test")
        app = create_app(
            storage_root=storage_root,
            wixy_repo_root=wixy_repo_root,
            adventure_bank=fixture_bank(),
            adventure_researcher=FakeResearcher(),
        )
        public = app.state.adventure_public
        assert public.runner.available is False and public.owned_finder is None
        assert public.pictures is None

    def test_a_non_cmd_backend_leaves_the_public_game_without_a_researcher(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch, no_researcher=True) as client:
            assert service(client).runner.available is False
            assert service(client).owned_finder is None

    def test_the_finder_is_closed_with_the_app(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        closed: list[bool] = []

        class Closing(WebPictureFinder):
            async def aclose(self) -> None:
                closed.append(self.allow_site_images)
                await super().aclose()

        monkeypatch.setattr("wixy_server.app.WebPictureFinder", Closing)
        monkeypatch.setenv("WIXY_ADVENTURE_PUBLIC_HOST", "adventure.example.test")
        from fastapi.testclient import TestClient

        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, adventure_bank=fixture_bank()
        )
        with TestClient(app):
            assert closed == []
        assert False in closed  # the public (Commons-only) finder was closed with the app
