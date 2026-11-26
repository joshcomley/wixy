# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""Review fixes to the public Adventure Time host (workspace 00065, decisions/00216 addendum).

A pack stuck `pending` is healed by a supervised sweep, the public side has its own thread budget
and a settled-pack cache, a cmd outage does not drain the start budget, a public store that did not
prepare answers 503, the loops start independently, and the public host never serves a source
map."""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import anyio
import pytest
from fastapi.testclient import TestClient

from wixy_server.adventure_public.limits import PublicLimits
from wixy_server.adventure_public.runner import PUBLIC_UNAVAILABLE_TEXT, PublicPackRunner
from wixy_server.adventure_public.service import AdventurePublicService
from wixy_server.livechat.adventure_pack import PackTiming, ResearchUnavailableError
from wixy_server.tests.adventure_public_testkit import (
    ORIGIN_HEADERS,
    code_of,
    get_pack,
    make_static_dir,
    public_client,
    request_pack,
    service,
    wait_for,
    wait_for_state,
)
from wixy_server.tests.adventure_testkit import (
    FakePictureFinder,
    FakeResearcher,
    FakeRunPlan,
)
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    origin_repo,
    storage_root,
    wixy_repo_root,
)

STATIC_ROOT = Path(__file__).parents[1] / "static"


def sweeping(**over: Any) -> PackTiming:
    """Fast pacing with a research sweep that looks every 50 ms for packs pending 0.3 s."""
    fields: dict[str, Any] = {
        "poll_interval_s": 0.02,
        "spawn_gap_s": 0.0,
        "give_up_s": 0.2,
        "early_retry_s": 0.0,
        "stale_sweep_interval_s": 0.05,
        "stale_margin_s": 0.1,
    }
    fields.update(over)
    return PackTiming(**fields)


def plant_stale_pending(client: TestClient, destination_id: str, *, age_s: float = 10_000) -> None:
    """A pack left `pending` long ago with nobody running it (what a lost job leaves)."""
    result = service(client).store.request_start(destination_id, now=time.time() - age_s)
    assert result.kind == "started"


class TestStalePackSweep:
    def test_a_pack_stuck_pending_is_researched_by_the_sweep_without_a_restart(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher()
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, researcher=fake, timing=sweeping()
        ) as client:
            plant_stale_pending(client, "AAA.one")
            view = wait_for_state(client, code_of(client, "AAA.one"), "ready", timeout_s=5)
        assert view["data"] is not None
        assert len(fake.started) == 1

    def test_the_sweep_polls_the_run_a_stale_row_already_knows(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher()
        fake.adopt("fake-run-known", FakeRunPlan())
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, researcher=fake, timing=sweeping()
        ) as client:
            plant_stale_pending(client, "AAA.one")
            assert service(client).store.set_run(
                "AAA.one", run_id="fake-run-known", now=time.time() - 10_000
            )
            wait_for_state(client, code_of(client, "AAA.one"), "ready", timeout_s=5)
        assert fake.started == []  # it polled the known run; it did not start another

    def test_a_young_pending_pack_is_left_alone(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher()
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=fake,
            timing=sweeping(give_up_s=600.0, stale_margin_s=600.0),
        ) as client:
            plant_stale_pending(client, "AAA.one", age_s=5)
            time.sleep(0.4)  # many sweeps
            row = service(client).store.get("AAA.one")
        assert row is not None and row.state == "pending"
        assert fake.started == []

    def test_the_sweep_claims_a_stale_row_once_and_never_one_this_process_is_running(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["running"] * 100000)])
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=fake,
            timing=sweeping(give_up_s=60.0, stale_margin_s=-59.9),
        ) as client:
            store = service(client).store
            claims: list[str] = []
            real_claim = store.claim_pending

            def counting_claim(destination_id: str, **kwargs: Any) -> bool:
                claims.append(destination_id)
                return real_claim(destination_id, **kwargs)

            monkeypatch.setattr(store, "claim_pending", counting_claim)
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for(lambda: len(fake.started) == 1, what="the run to start")
            time.sleep(0.5)  # the row is older than the stale age, but its job is alive here
            stale = store.stale_pending(stale_before=time.time() - 0.1)
            assert stale == ["AAA.one"]  # the sweep did see it as stale...
        assert claims == []  # ...and left it to the job this process is running
        assert len(fake.started) == 1

    def test_the_pack_is_stored_once_when_two_sweeps_race(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher()
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, researcher=fake, timing=sweeping()
        ) as client:
            plant_stale_pending(client, "AAA.one")
            wait_for_state(client, code_of(client, "AAA.one"), "ready", timeout_s=5)
            row = service(client).store.get("AAA.one")
        assert row is not None and row.rev == 2  # one `finish`, never two

    def test_a_start_the_runner_could_not_take_is_settled_as_a_retryable_failure(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch) as client:
            monkeypatch.setattr(PublicPackRunner, "start", lambda *_a, **_k: False)
            code = code_of(client, "AAA.one")
            posted = request_pack(client, code)
            assert posted.status_code == 200
            view = get_pack(client, code)
        assert view["state"] == "failed", view
        assert view["error"] == PUBLIC_UNAVAILABLE_TEXT
        assert 0 < view["retryAfterS"] <= 60  # the cmd-unreachable rule: a minute, not ten


class TestLoopsStartIndependently:
    def test_the_sweep_still_runs_when_the_startup_resume_fails(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def broken(self: PublicPackRunner, _background: Any) -> int:
            raise RuntimeError("the resume blew up")

        monkeypatch.setattr(PublicPackRunner, "resume", broken)
        fake = FakeResearcher()
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, researcher=fake, timing=sweeping()
        ) as client:
            plant_stale_pending(client, "AAA.one")
            wait_for_state(client, code_of(client, "AAA.one"), "ready", timeout_s=5)

    def test_the_picture_sweep_still_runs_when_the_startup_resume_fails(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from wixy_server.livechat.adventure_pictures import PictureTiming

        async def broken(self: PublicPackRunner, _background: Any) -> int:
            raise RuntimeError("the resume blew up")

        monkeypatch.setattr(PublicPackRunner, "resume", broken)
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            finder=FakePictureFinder(),
            timing=sweeping(),
            picture_timing=PictureTiming(stale_after_s=0.1, watch_interval_s=0.05),
        ) as client:
            store = service(client).store
            now = time.time() - 10_000
            assert store.request_start("AAA.one", now=now).kind == "started"
            assert store.set_run("AAA.one", run_id="r1", now=now)
            assert store.finish(
                "AAA.one", run_id="r1", state="ready", pack_json="{}", pictures_pending=True,
                now=now,
            )  # fmt: skip
            wait_for(
                lambda: (store.get("AAA.one") or _row_missing()).images != "pending",
                timeout_s=5,
                what="the picture sweep to heal the hunt",
            )


def _row_missing() -> Any:
    raise AssertionError("the pack row vanished")


def saturate(
    client: TestClient, limiter_of: Callable[[], anyio.CapacityLimiter]
) -> Callable[[], None]:
    """Take every token of a limiter on the app's event loop; the returned function gives them
    back."""
    holders: list[object] = []

    async def take() -> None:
        limiter = limiter_of()
        while len(holders) < int(limiter.total_tokens):
            holder = object()
            await limiter.acquire_on_behalf_of(holder)
            holders.append(holder)

    client.portal.call(take)  # type: ignore[union-attr]

    def release() -> None:
        async def give() -> None:
            limiter = limiter_of()
            for holder in holders:
                limiter.release_on_behalf_of(holder)

        client.portal.call(give)  # type: ignore[union-attr]

    return release


def default_limiter() -> anyio.CapacityLimiter:
    return anyio.to_thread.current_default_thread_limiter()


def call_with_timeout(call: Callable[[], Any], timeout_s: float) -> tuple[bool, Any]:
    """`(finished, result)`: run `call` on a thread and give up waiting after `timeout_s`."""
    box: list[Any] = []
    thread = threading.Thread(target=lambda: box.append(call()), daemon=True)
    thread.start()
    thread.join(timeout_s)
    return (not thread.is_alive(), box[0] if box else None)


class TestOwnThreadBudget:
    def test_a_flood_of_default_pool_work_does_not_starve_a_public_request(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The public side never borrows anyio's process-wide default thread pool: with every one
        of its threads taken, pack reads, assets and pictures still answer."""
        static = make_static_dir(storage_root.parent / "flood-static")
        fake = FakeResearcher()
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=fake,
            finder=FakePictureFinder(),
            static_dir=static,
        ) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            view = wait_for_state(client, code, "ready")
            picture_url = (
                view["pictures"]["hero"][0]["thumbUrl"] if view["pictures"]["hero"] else ""
            )
            release = saturate(client, default_limiter)
            try:
                for path in (f"/api/pack/{code}", f"/d/{code}", "/assets/app.js", picture_url):
                    if not path:
                        continue
                    finished, response = call_with_timeout(lambda p=path: client.get(p), 3.0)  # type: ignore[misc]
                    assert finished, f"{path} waited for the default thread pool"
                    assert response.status_code == 200, path
                finished, response = call_with_timeout(
                    lambda: client.post(f"/api/pack/{code}", headers=ORIGIN_HEADERS), 3.0
                )
                assert finished, "POST waited for the default thread pool"
            finally:
                release()

    def test_a_saturated_public_budget_does_not_block_a_private_thread_call(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch) as client:
            pool = service(client).threads
            assert int(pool.limiter.total_tokens) == 6
            release = saturate(client, lambda: pool.limiter)
            try:
                code = code_of(client, "AAA.one")
                # A public request is now parked on its own full budget...
                finished, _ = call_with_timeout(lambda: client.get(f"/api/pack/{code}"), 0.6)
                assert not finished, "the public side should be waiting for its own threads"

                # ...while a thread call on the default pool (what a private route makes) is free.
                async def private_call() -> str:
                    return await anyio.to_thread.run_sync(lambda: "done")

                result = client.portal.call(private_call)  # type: ignore[union-attr]
                assert result == "done"
            finally:
                release()

    def test_assets_and_pictures_keep_their_headers(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        static = make_static_dir(storage_root.parent / "headers-static")
        with public_client(storage_root, wixy_repo_root, monkeypatch, static_dir=static) as client:
            plain = client.get("/assets/app.js")
            assert plain.headers["content-type"].startswith("text/javascript")
            assert plain.headers["content-length"] == str(len(plain.content))
            assert plain.headers["accept-ranges"] == "bytes"
            assert plain.headers["etag"] and plain.headers["last-modified"]
            ranged = client.get("/assets/app.js", headers={"Range": "bytes=3-8"})
            assert ranged.status_code == 206 and ranged.content == plain.content[3:9]
            assert client.head("/assets/app.js").status_code == 200


class TestSettledPackCache:
    def reads(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> list[str]:
        store = service(client).store
        connects: list[str] = []
        real = store._connect  # noqa: SLF001

        def counting() -> Any:
            connects.append("connect")
            return real()

        monkeypatch.setattr(store, "_connect", counting)
        return connects

    def test_a_ready_pack_is_read_from_the_database_once(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, finder=FakePictureFinder()
        ) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for(
                lambda: get_pack(client, code)["images"] == "done", what="the pictures to attach"
            )
            first = get_pack(client, code)
            connects = self.reads(client, monkeypatch)
            for _ in range(5):
                assert get_pack(client, code) == first
                assert client.get(f"/d/{code}").status_code == 200
        assert connects == []

    def test_a_pack_still_researching_is_never_cached(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["running"] * 100000)])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            assert get_pack(client, code)["state"] == "pending"
            connects = self.reads(client, monkeypatch)
            for _ in range(3):
                assert get_pack(client, code)["state"] == "pending"
        assert len(connects) >= 3

    def test_a_pack_whose_pictures_are_still_pending_is_never_cached(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder(hold=True)
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            assert get_pack(client, code)["images"] == "pending"
            connects = self.reads(client, monkeypatch)
            for _ in range(3):
                assert get_pack(client, code)["images"] == "pending"
            finder.release.set()
            wait_for(lambda: get_pack(client, code)["images"] == "done", what="pictures")
        assert len(connects) >= 3

    def test_a_write_to_the_row_drops_the_cached_view(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["error"])])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            failed = wait_for_state(client, code, "failed")
            assert failed["canRetry"] is False and failed["retryAfterS"]
            assert get_pack(client, code)["state"] == "failed"  # now cached until next_try_at
            # Another write to the row (here: the retry a later request starts).
            service(client).store.request_start("AAA.one", now=time.time() + 100_000)
            assert get_pack(client, code)["state"] == "pending"

    def test_a_cached_failed_pack_still_counts_down_and_becomes_retryable(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["error"])])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "failed")
            store = service(client).store
            row = store.get("AAA.one")
            assert row is not None and row.next_try_at is not None
            first = get_pack(client, code)
            assert first["canRetry"] is False
            # The view is computed from the row at read time: a clock past `next_try_at` makes it
            # retryable without any write.
            from wixy_server.routes_adventure_public import pack_view

            stored = store.get_with_pictures("AAA.one")
            view, _ = pack_view(
                service(client), service(client).bank.by_code[code], stored,
                now=row.next_try_at + 1,
            )  # fmt: skip
            assert view["canRetry"] is True and view["retryAfterS"] is None

    def test_the_cache_is_bounded_by_the_bank(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch) as client:
            svc = service(client)
            destinations = sum(len(unit.destinations) for unit in svc.bank.bank.units.values())
            assert svc.store.cache_limit == destinations


class TestStartBudget:
    def test_a_cmd_outage_gives_the_slot_back(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Five visitors during a cmd outage must not lock research for an hour: a start that never
        reached cmd is given back, so the next place may still be asked for."""
        fake = FakeResearcher(start_errors=[ResearchUnavailableError("cmd is down")] * 10)
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=fake,
            limits=PublicLimits(global_per_hour=2, per_ip_per_hour=2),
        ) as client:
            headers = {**ORIGIN_HEADERS, "CF-Connecting-IP": "203.0.113.5"}
            for dest in ("AAA.one", "AAA.two", "AAA.three", "AAA.four"):
                code = code_of(client, dest)
                response = client.post(f"/api/pack/{code}", headers=headers)
                assert response.status_code == 200, (dest, response.text)
                wait_for_state(client, code, "failed")

    def test_a_real_spawn_still_costs_a_slot(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            limits=PublicLimits(global_per_hour=2, per_ip_per_hour=2),
        ) as client:
            headers = {**ORIGIN_HEADERS, "CF-Connecting-IP": "203.0.113.5"}
            statuses = [
                client.post(f"/api/pack/{code_of(client, d)}", headers=headers).status_code
                for d in ("AAA.one", "AAA.two", "AAA.three")
            ]
        assert statuses == [200, 200, 429]

    def test_neighbours_in_a_slash_24_share_a_client_budget(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            limits=PublicLimits(global_per_hour=30, per_ip_per_hour=1),
        ) as client:

            def post(dest: str, ip: str) -> int:
                headers = {**ORIGIN_HEADERS, "CF-Connecting-IP": ip}
                response = client.post(f"/api/pack/{code_of(client, dest)}", headers=headers)
                return int(response.status_code)

            assert post("AAA.one", "203.0.113.5") == 200
            assert post("AAA.two", "203.0.113.200") == 429  # same /24
            assert post("AAA.two", "203.0.114.5") == 200  # another /24


class TestUnpreparedStore:
    def test_every_public_page_and_api_route_answers_503_and_creates_nothing(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def broken(self: AdventurePublicService) -> None:
            raise OSError("the disk is gone")

        monkeypatch.setattr(AdventurePublicService, "prepare", broken)
        static = make_static_dir(storage_root.parent / "unprepared-static")
        with public_client(storage_root, wixy_repo_root, monkeypatch, static_dir=static) as client:
            code = code_of(client, "AAA.one")
            for path in ("/", f"/d/{code}", "/d/zzzzzz", "/api/bank", f"/api/pack/{code}"):
                response = client.get(path)
                assert response.status_code == 503, path
                assert response.headers["cache-control"] == "no-store"
                assert response.headers["content-type"].startswith("text/plain")
                assert 0 < len(response.text) < 120
            posted = client.post(f"/api/pack/{code}", headers=ORIGIN_HEADERS)
            assert posted.status_code == 503
            assert client.get("/media/" + "0" * 32 + "/thumb.jpg").status_code == 503
            # Assets (and the static bits) are still served; the private chat is untouched.
            assert client.get("/assets/app.js").status_code == 200
            assert client.get("/robots.txt").status_code == 200
            assert service(client).store.get("AAA.one") is None  # no row was ever created


class TestNoSourceMaps:
    def test_the_public_host_refuses_a_map_even_when_one_is_in_the_bundle_directory(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        static = make_static_dir(storage_root.parent / "maps-static")
        (static / "app.js.map").write_text('{"sources":["private.ts"]}', encoding="utf-8")
        (static / "app.css.map").write_text("{}", encoding="utf-8")
        with public_client(storage_root, wixy_repo_root, monkeypatch, static_dir=static) as client:
            for name in ("app.js.map", "app.css.map"):
                response = client.get(f"/assets/{name}")
                assert response.status_code == 404 and response.text == "Not found"
            assert client.get("/assets/app.js").status_code == 200

    def test_the_committed_public_bundle_has_no_source_map(self) -> None:
        bundle = STATIC_ROOT / "adventure-public"
        assert sorted(p.name for p in bundle.glob("*.map")) == []
        for name in ("app.js", "app.css"):
            text = (bundle / name).read_text(encoding="utf-8")
            assert not re.search(r"sourceMappingURL", text), name

    def test_the_public_esbuild_entries_emit_no_sourcemap(self) -> None:
        config = (Path(__file__).parents[2] / "admin-ui" / "esbuild.config.mjs").read_text(
            encoding="utf-8"
        )
        public = config[config.index("src/public/main.ts") - 60 :]
        assert "sourcemap: true" not in public
        assert json.dumps("sourcemap") and public.count("sourcemap: false") == 2
