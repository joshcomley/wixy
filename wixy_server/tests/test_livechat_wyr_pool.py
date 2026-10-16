# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The would-you-rather picture pool: pictures painted ahead for upcoming questions. The on-disk
store (atomic publish, atomic reservation, overlap-safe cleanup), one filler iteration under every
guard (target, demand, disk, generator, played questions), the pacing/back-off, the supervised
loop, the pool-first round start (`POST /wyr` answers with both pictures already attached) and the
fallbacks. No test sleeps for real time and none needs a GPU."""

from __future__ import annotations

import os
import random
import time
from pathlib import Path
from typing import Any

import anyio
import pytest

from wixy_server.app import create_app
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.wyr_game import (
    PoolOutcome,
    PoolPacing,
    WyrDemand,
    attach_pooled_images,
    pick_round,
    pool_played_ids,
    pool_step,
    run_wyr_pool_forever,
    wyr_image_limiter,
)
from wixy_server.livechat.wyr_pool import STALE_AFTER_S, WyrPool
from wixy_server.livechat.wyr_questions import BANK_PATH, WyrQuestion, load_questions
from wixy_server.settings import load_settings
from wixy_server.storage import ProjectPaths
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
    FakeGenerator,
    _client,
    _create,
    _png,
    _pool_off_by_default,
)

GIB = 1024 * 1024 * 1024
ROOMY = 100 * GIB


@pytest.fixture
def questions() -> tuple[WyrQuestion, ...]:
    return load_questions(BANK_PATH)


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    p = ProjectPaths(slug="test", root=tmp_path / "storage" / "projects" / "test")
    p.server_dir.mkdir(parents=True, exist_ok=True)
    return p


@pytest.fixture
def store(paths: ProjectPaths) -> LiveChatStore:
    return LiveChatStore(paths.server_db)


@pytest.fixture
def pool(paths: ProjectPaths) -> WyrPool:
    return WyrPool(paths.server_dir / "wyr-pool")


def _fill(pool: WyrPool, question_id: str) -> None:
    tmp = pool.begin(question_id)
    (tmp / "a.png").write_bytes(_png())
    (tmp / "b.png").write_bytes(_png())
    assert pool.commit(question_id, tmp) is True


def _round(store: LiveChatStore, question_id: str, client_id: str = "wyr-pool-round-1") -> int:
    message, _ = store.create_wyr_round(
        images_pending=True,
        client_id=client_id,
        sender="Josh",
        device_id="device-1",
        by_email=None,
        question_id=question_id,
        now=10.0,
    )
    return message.seq


def _step(
    store: LiveChatStore,
    paths: ProjectPaths,
    pool: WyrPool,
    questions: tuple[WyrQuestion, ...],
    generator: FakeGenerator,
    **overrides: Any,
) -> PoolOutcome:
    args: dict[str, Any] = {
        "store": store,
        "paths": paths,
        "generator": generator,
        "pool": pool,
        "questions": questions,
        "target": 3,
        "demand": WyrDemand(),
        "min_free_bytes": 0,
        "rng": random.Random(7),
        "free_bytes": lambda: ROOMY,
    }
    args.update(overrides)
    return pool_step(**args)


class TestPoolStore:
    def test_a_pair_is_visible_only_once_committed_whole(self, pool: WyrPool) -> None:
        tmp = pool.begin("q0001")
        (tmp / "a.png").write_bytes(_png())
        assert pool.ids() == set()  # half a pair, still scratch
        assert pool.commit("q0001", tmp) is False  # incomplete: refused, scratch removed
        assert not tmp.exists() and pool.ids() == set()
        _fill(pool, "q0001")
        assert pool.ids() == {"q0001"} and pool.size() == 1

    def test_a_question_cannot_be_pooled_twice(self, pool: WyrPool) -> None:
        _fill(pool, "q0001")
        tmp = pool.begin("q0001")
        (tmp / "a.png").write_bytes(b"x")
        (tmp / "b.png").write_bytes(b"x")
        assert pool.commit("q0001", tmp) is False
        assert (pool.root / "q0001" / "a.png").read_bytes() == _png()  # the original is intact

    def test_take_reserves_atomically_and_only_among_candidates(self, pool: WyrPool) -> None:
        for qid in ("q0001", "q0002", "q0003"):
            _fill(pool, qid)
        rng = random.Random(1)
        first = pool.take({"q0002", "q0003"}, rng)
        assert first is not None and first.question_id in {"q0002", "q0003"}
        assert first.a.is_file() and first.b.is_file()
        assert first.question_id not in pool.ids()  # reserved: nobody else can take it
        second = pool.take({first.question_id}, rng)
        assert second is None
        assert pool.take(set(), rng) is None
        assert "q0001" in pool.ids()  # never a candidate, never touched

    def test_restore_gives_a_reserved_pair_back_and_discard_destroys_it(
        self, pool: WyrPool
    ) -> None:
        _fill(pool, "q0001")
        taken = pool.take({"q0001"}, random.Random(1))
        assert taken is not None
        pool.restore(taken)
        assert pool.ids() == {"q0001"} and not taken.directory.exists()
        taken = pool.take({"q0001"}, random.Random(1))
        assert taken is not None
        pool.discard(taken)
        assert pool.ids() == set() and not taken.directory.exists()

    def test_restore_over_a_repooled_question_discards_the_returned_copy(
        self, pool: WyrPool
    ) -> None:
        _fill(pool, "q0001")
        taken = pool.take({"q0001"}, random.Random(1))
        assert taken is not None
        _fill(pool, "q0001")  # re-pooled meanwhile
        pool.restore(taken)
        assert pool.ids() == {"q0001"} and not taken.directory.exists()

    def test_cleanup_removes_stale_scratch_and_played_pairs_but_keeps_young_work(
        self, pool: WyrPool
    ) -> None:
        _fill(pool, "q0001")  # will be played
        _fill(pool, "q0002")  # stays
        _fill(pool, "q0003")
        stale_tmp = pool.begin("q0010")
        young_tmp = pool.begin("q0011")
        reserved = pool.take({"q0003"}, random.Random(1))
        assert reserved is not None
        old = time.time() - STALE_AFTER_S - 60
        os.utime(stale_tmp, (old, old))
        # a young reserved pair and a young scratch dir may belong to the OLDER process of a
        # blue/green overlap, still working: both survive.
        removed = pool.cleanup({"q0001"})
        assert removed == 2  # the played pair and the stale scratch dir
        assert pool.ids() == {"q0002"}
        assert not stale_tmp.exists()
        assert young_tmp.exists() and reserved.directory.exists()
        old2 = time.time() - STALE_AFTER_S - 60
        os.utime(reserved.directory, (old2, old2))
        assert pool.cleanup(set()) == 1  # now the reserved one is stale too
        assert not reserved.directory.exists()

    def test_clear_removes_the_whole_pool(self, pool: WyrPool) -> None:
        _fill(pool, "q0001")
        pool.clear()
        assert not pool.root.exists() and pool.ids() == set()

    def test_a_missing_pool_directory_is_just_empty(self, pool: WyrPool) -> None:
        assert pool.ids() == set() and pool.size() == 0
        assert pool.cleanup(set()) == 0 and pool.take({"q0001"}, random.Random(1)) is None


class TestPoolStep:
    def test_a_step_paints_one_pair_into_the_pool_and_leaves_nothing_else(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        generator = FakeGenerator()
        assert _step(store, paths, pool, questions, generator) is PoolOutcome.GENERATED
        [qid] = pool.ids()
        assert (pool.root / qid / "a.png").is_file() and (pool.root / qid / "b.png").is_file()
        assert sorted(p.name for p in pool.root.iterdir()) == [qid]  # no .tmp left behind
        assert len(generator.calls) == 1
        # the pair is for a question of the bank, with that category's style appended
        question = next(q for q in questions if q.id == qid)
        assert generator.calls[0][0].startswith(question.image_a)

    def test_it_stops_at_the_target_without_touching_the_gpu(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        generator = FakeGenerator()
        for _ in range(3):
            assert _step(store, paths, pool, questions, generator) is PoolOutcome.GENERATED
        assert pool.size() == 3
        assert _step(store, paths, pool, questions, generator) is PoolOutcome.FULL
        assert len(generator.calls) == 3

    def test_it_never_pools_a_played_or_already_pooled_question(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        _round(store, questions[0].id)  # played
        _fill(pool, questions[1].id)  # pooled
        few = questions[:3]
        generator = FakeGenerator()
        assert _step(store, paths, pool, few, generator) is PoolOutcome.GENERATED
        assert pool.ids() == {questions[1].id, questions[2].id}
        assert _step(store, paths, pool, few, generator, target=9) is PoolOutcome.NO_CANDIDATES
        assert len(generator.calls) == 1

    def test_the_whole_bank_played_restarts_the_repeat_guard(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        few = questions[:2]
        _round(store, few[0].id, "wyr-pool-round-a")
        _round(store, few[1].id, "wyr-pool-round-b")
        assert pool_played_ids(store, few) == set()
        assert _step(store, paths, pool, few, FakeGenerator()) is PoolOutcome.GENERATED

    def test_it_yields_to_a_waiting_round(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        demand = WyrDemand()
        demand.count = 1
        generator = FakeGenerator()
        assert _step(store, paths, pool, questions, generator, demand=demand) is PoolOutcome.YIELDED
        assert generator.calls == [] and pool.size() == 0

    def test_it_stops_when_the_disk_is_short(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        generator = FakeGenerator()
        floor = 5 * GIB
        # exactly at the chat's own floor + 1 GiB of headroom is already too little
        outcome = _step(
            store,
            paths,
            pool,
            questions,
            generator,
            min_free_bytes=floor,
            free_bytes=lambda: floor + GIB - 1,
        )
        assert outcome is PoolOutcome.NO_DISK and generator.calls == []
        outcome = _step(
            store,
            paths,
            pool,
            questions,
            generator,
            min_free_bytes=floor,
            free_bytes=lambda: floor + GIB,
        )
        assert outcome is PoolOutcome.GENERATED

    def test_it_waits_for_a_generator_that_is_down(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        generator = FakeGenerator(up=False)
        assert _step(store, paths, pool, questions, generator) is PoolOutcome.UNAVAILABLE
        assert generator.calls == [] and pool.size() == 0

    def test_a_failed_run_leaves_nothing_behind(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        assert _step(store, paths, pool, questions, FakeGenerator(fail=True)) is PoolOutcome.FAILED
        assert pool.size() == 0 and list(pool.root.iterdir()) == []

    def test_a_question_played_while_it_was_painting_is_not_pooled(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        few = questions[:2]

        class PlaysItMeanwhile(FakeGenerator):
            def generate_pair(
                self, prompt_a: str, prompt_b: str, out_dir: Path, **k: Any
            ) -> tuple[Path, Path]:
                result = super().generate_pair(prompt_a, prompt_b, out_dir, **k)
                painting = next(q for q in few if prompt_a.startswith(q.image_a))
                _round(store, painting.id)  # an on-demand round took the question being painted
                return result

        _step(store, paths, pool, few, PlaysItMeanwhile())
        assert pool.size() == 0 and list(pool.root.iterdir()) == []


class TestPacing:
    def test_delays_follow_the_outcome_and_back_off_on_failure(self) -> None:
        pacing = PoolPacing()
        assert pacing.delay_for(PoolOutcome.GENERATED) == 2.0
        assert pacing.delay_for(PoolOutcome.YIELDED) == 5.0
        assert pacing.delay_for(PoolOutcome.FULL) == 60.0
        assert pacing.delay_for(PoolOutcome.NO_CANDIDATES) == 60.0
        assert pacing.delay_for(PoolOutcome.NO_DISK) == 300.0
        assert pacing.delay_for(PoolOutcome.UNAVAILABLE) == 300.0
        failures = [pacing.delay_for(PoolOutcome.FAILED) for _ in range(6)]
        assert failures == [30.0, 60.0, 120.0, 240.0, 300.0, 300.0]
        assert pacing.delay_for(PoolOutcome.GENERATED) == 2.0  # a success resets the back-off
        assert pacing.delay_for(PoolOutcome.FAILED) == 30.0


class _Stop(Exception):
    pass


class TestLoop:
    def test_the_loop_fills_to_target_then_idles_and_pauses_for_demand(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        generator = FakeGenerator()
        demand = WyrDemand()
        delays: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            delays.append(seconds)
            if len(delays) == 5:
                # a round starts waiting while the pool is short: the filler must yield
                demand.count = 1
                pool.drop(sorted(pool.ids())[0])
            if len(delays) == 7:
                raise _Stop

        async def main() -> None:
            limiter = anyio.CapacityLimiter(1)
            await run_wyr_pool_forever(
                store=store,
                paths=paths,
                generator=generator,
                pool=pool,
                questions=questions,
                target=3,
                demand=demand,
                limiter=lambda: limiter,
                min_free_bytes=0,
                sleep=fake_sleep,
            )

        with pytest.raises(_Stop):
            anyio.run(main)
        # 3 pairs painted (2 s pause after each), then full (60 s), then yielded (5 s)...
        assert delays[:3] == [2.0, 2.0, 2.0]
        assert delays[3] == 60.0 and delays[4] == 60.0
        assert delays[5] == 5.0 and delays[6] == 5.0
        assert pool.size() == 2 and len(generator.calls) == 3  # one was dropped; none painted

    def test_startup_cleans_the_pool_before_painting(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        _fill(pool, questions[0].id)
        _round(store, questions[0].id)  # played since the pair was painted
        stale = pool.begin("q9999")
        old = time.time() - STALE_AFTER_S - 60
        os.utime(stale, (old, old))

        async def fake_sleep(seconds: float) -> None:
            raise _Stop

        async def main() -> None:
            limiter = anyio.CapacityLimiter(1)
            await run_wyr_pool_forever(
                store=store,
                paths=paths,
                generator=FakeGenerator(up=False),
                pool=pool,
                questions=questions,
                target=3,
                demand=WyrDemand(),
                limiter=lambda: limiter,
                min_free_bytes=0,
                sleep=fake_sleep,
            )

        with pytest.raises(_Stop):
            anyio.run(main)
        assert pool.ids() == set() and not stale.exists()


class TestPickAndAttach:
    def test_a_pooled_question_is_preferred_and_reserved(
        self,
        store: LiveChatStore,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        _fill(pool, questions[5].id)
        question, pooled = pick_round(store, questions, pool, random.Random(3))
        assert question is not None and question.id == questions[5].id
        assert pooled is not None and pooled.question_id == questions[5].id
        assert pool.ids() == set()  # reserved
        again, none_left = pick_round(store, questions, pool, random.Random(3))
        assert again is not None and none_left is None  # empty pool: an ordinary pick

    def test_a_played_pooled_question_is_not_picked(
        self,
        store: LiveChatStore,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        _fill(pool, questions[5].id)
        _round(store, questions[5].id)
        question, pooled = pick_round(store, questions, pool, random.Random(3))
        assert pooled is None and question is not None
        assert pool.ids() == {questions[5].id}  # untouched (startup cleanup prunes it)

    def test_a_retired_question_pair_is_discarded(
        self, store: LiveChatStore, pool: WyrPool, questions: tuple[WyrQuestion, ...]
    ) -> None:
        _fill(pool, "q-retired")
        question, pooled = pick_round(store, questions, pool, random.Random(3))
        # the id is not in the bank so it was never a candidate: untouched, ordinary pick
        assert pooled is None and question is not None and pool.ids() == {"q-retired"}

    def test_attach_moves_both_pictures_in_one_transaction(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        _fill(pool, questions[0].id)
        pooled = pool.take({questions[0].id}, random.Random(1))
        assert pooled is not None
        anchor = _round(store, questions[0].id)
        assert attach_pooled_images(
            store=store, paths=paths, pooled=pooled, anchor_seq=anchor, by_email=None
        )
        [message] = store.get_messages([anchor])
        assert [a.ordinal for a in message.attachments] == [0, 1]
        assert all(
            (paths.server_upload_dir(a.id) / "assembled").read_bytes() == _png()
            for a in message.attachments
        )
        round_ = store.get_wyr_round(anchor_seq=anchor)
        assert round_ is not None and round_.images == "done"
        assert not pooled.directory.exists() and pool.ids() == set()

    def test_attach_to_a_vanished_round_cleans_everything_up(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        pool: WyrPool,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        _fill(pool, questions[0].id)
        pooled = pool.take({questions[0].id}, random.Random(1))
        assert pooled is not None
        anchor = _round(store, questions[0].id)
        store.delete_message(seq=anchor, now=20.0)
        assert not attach_pooled_images(
            store=store, paths=paths, pooled=pooled, anchor_seq=anchor, by_email=None
        )
        uploads = list(paths.server_uploads.glob("*")) if paths.server_uploads.exists() else []
        assert uploads == [] and not pooled.directory.exists()


def _app_pool(storage_root: Path) -> WyrPool:
    return WyrPool(
        ProjectPaths(slug="test", root=storage_root / "projects" / "test").server_dir / "wyr-pool"
    )


class TestRoutes:
    def test_a_round_with_a_pooled_pair_answers_with_both_pictures_at_once(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_WYR_POOL_SIZE", "1")
        monkeypatch.setenv("WIXY_COMFY_URL", "")
        questions = load_questions(BANK_PATH)
        pool = _app_pool(storage_root)
        _fill(pool, questions[3].id)
        generator = FakeGenerator()
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, generator, "a@example.com")
        try:
            created = _create(client, h, "wyr-pool-route-1")
            assert created.status_code == 201, created.text
            message = created.json()["message"]
            # the response ALREADY carries both pictures — no waiting for a job
            assert len(message["attachments"]) == 2
            assert all(a["kind"] == "photo" for a in message["attachments"])
            view = client.get(f"{BASE}/wyr/{message['seq']}?as=Josh", headers=h).json()
            assert view["question"]["id"] == questions[3].id
            assert view["images"] == "done"
            assert pool.ids() == set()  # consumed
        finally:
            client.__exit__(None, None, None)

    def test_a_replayed_start_consumes_nothing(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_WYR_POOL_SIZE", "2")
        questions = load_questions(BANK_PATH)
        pool = _app_pool(storage_root)
        _fill(pool, questions[3].id)
        _fill(pool, questions[4].id)
        client, h = _client(
            storage_root, wixy_repo_root, pin_verifier, FakeGenerator(), "a@example.com"
        )
        try:
            first = _create(client, h, "wyr-pool-route-2")
            again = _create(client, h, "wyr-pool-route-2")
            assert first.status_code == 201 and again.status_code == 200
            assert again.json()["message"]["seq"] == first.json()["message"]["seq"]
            assert len(pool.ids()) == 1  # one pair used; the replay put its reservation back
        finally:
            client.__exit__(None, None, None)

    def test_without_a_pooled_pair_the_round_paints_on_demand_as_before(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_WYR_POOL_SIZE", "0")
        generator = FakeGenerator()
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, generator, "a@example.com")
        try:
            created = _create(client, h, "wyr-pool-route-3")
            assert created.status_code == 201
            assert created.json()["message"]["attachments"] == []  # nothing yet
            seq = created.json()["message"]["seq"]
            deadline = time.time() + 15
            while time.time() < deadline:
                rows = client.get(f"{BASE}/messages?limit=10", headers=h).json()["messages"]
                [row] = [m for m in rows if m["seq"] == seq]
                if len(row["attachments"]) == 2:
                    break
                time.sleep(0.1)
            assert len(row["attachments"]) == 2 and len(generator.calls) == 1
        finally:
            client.__exit__(None, None, None)

    def test_a_staging_failure_falls_back_to_the_on_demand_job(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import wixy_server.routes_livechat as routes

        monkeypatch.setenv("WIXY_WYR_POOL_SIZE", "1")
        questions = load_questions(BANK_PATH)
        _fill(_app_pool(storage_root), questions[3].id)
        monkeypatch.setattr(routes, "attach_pooled_images", lambda **_k: False)
        generator = FakeGenerator()
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, generator, "a@example.com")
        try:
            created = _create(client, h, "wyr-pool-route-4")
            assert created.status_code == 201
            seq = created.json()["message"]["seq"]
            deadline = time.time() + 15
            while time.time() < deadline:
                rows = client.get(f"{BASE}/messages?limit=10", headers=h).json()["messages"]
                [row] = [m for m in rows if m["seq"] == seq]
                if len(row["attachments"]) == 2:
                    break
                time.sleep(0.1)
            assert len(row["attachments"]) == 2  # painted by the job instead
            assert any(call for call in generator.calls)
        finally:
            client.__exit__(None, None, None)

    def test_switching_the_pool_off_removes_a_stale_pool(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_WYR_POOL_SIZE", "0")
        pool = _app_pool(storage_root)
        _fill(pool, "q0001")
        client, _h = _client(
            storage_root, wixy_repo_root, pin_verifier, FakeGenerator(), "a@example.com"
        )
        try:
            assert not pool.root.exists()
        finally:
            client.__exit__(None, None, None)

    def test_one_shared_single_flight_gate(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )

        async def main() -> bool:
            first = wyr_image_limiter(app.state)
            return first is wyr_image_limiter(app.state) and first.total_tokens == 1

        assert anyio.run(main) is True


class TestSettings:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [(None, 100), ("0", 0), ("25", 25), ("5000", 1000), ("-3", 0), ("lots", 100), ("", 100)],
    )
    def test_pool_size_parsing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, raw: str | None, expected: int
    ) -> None:
        monkeypatch.delenv("WIXY_WYR_POOL_SIZE", raising=False)
        if raw is not None:
            monkeypatch.setenv("WIXY_WYR_POOL_SIZE", raw)
        assert load_settings(tmp_path).wyr_pool_size == expected
