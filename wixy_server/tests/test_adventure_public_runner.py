# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The public holiday-pack research job (workspace 00065, spec/adventure-public/README.md §2.2): the
prompt and the cmd caller, its own research slot (concurrency 1) and folder, the compare-and-set
writes, the early retry, the 25 minute give-up, the failure backoff, resume at startup — and that no
public data ever enters `server.db` (Inv 61)."""

from __future__ import annotations

import functools
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest

from wixy_server.adventure_public.runner import (
    PUBLIC_FAILED_TEXT,
    PUBLIC_PACK_CALLER,
    PUBLIC_UNAVAILABLE_TEXT,
)
from wixy_server.adventure_public.store import PublicPackStore
from wixy_server.cmdchat import CmdChatClient
from wixy_server.livechat.adventure_pack import (
    PACK_CALLER,
    PACK_MODEL,
    CmdAdventureResearcher,
    PackTiming,
    ResearchError,
    ResearchUnavailableError,
    build_prompt,
    sanitise_pack,
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
    FAST,
    FakePictureFinder,
    FakeResearcher,
    FakeRunPlan,
    fixture_bank,
)
from wixy_server.tests.fake_cmd import CANNED_ADVENTURE_PACK, FakeCmdState, create_fake_cmd_app
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    origin_repo,
    storage_root,
    wixy_repo_root,
)


def fast(**over: Any) -> PackTiming:
    fields: dict[str, Any] = {
        "poll_interval_s": 0.02,
        "spawn_gap_s": 0.0,
        "give_up_s": 30.0,
        "early_retry_s": 0.0,
    }
    fields.update(over)
    return PackTiming(**fields)


class TestCaller:
    def test_the_private_game_keeps_its_own_caller_by_default(self) -> None:
        state = FakeCmdState()
        client = CmdChatClient(transport=httpx.ASGITransport(app=create_fake_cmd_app(state)))

        async def go() -> None:
            await CmdAdventureResearcher(client).start(prompt="p", cwd=Path("/x/y"))
            await CmdAdventureResearcher(client, caller=PUBLIC_PACK_CALLER).start(
                prompt="p", cwd=Path("/x/z")
            )

        anyio.run(go)
        callers = [run.body["caller"] for run in state.chat_spawn_runs.values()]
        assert callers == [PACK_CALLER, "wixy-adventure-public-pack"]
        assert PACK_CALLER == "wixy-adventure-pack"

    def test_a_public_pack_is_researched_by_the_public_caller_in_its_own_folder(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        state = FakeCmdState()
        client = CmdChatClient(transport=httpx.ASGITransport(app=create_fake_cmd_app(state)))
        researcher = CmdAdventureResearcher(client, caller=PUBLIC_PACK_CALLER)
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, researcher=researcher
        ) as http:
            code = code_of(http, "AAA.one")
            request_pack(http, code)
            view = wait_for_state(http, code, "ready")
        assert view["data"] == sanitise_pack(CANNED_ADVENTURE_PACK)
        [run] = state.chat_spawn_runs.values()
        body = run.body
        assert body["caller"] == "wixy-adventure-public-pack"
        assert body["model"] == PACK_MODEL
        cwd = str(body["cwd"]).replace("\\", "/")
        assert cwd.endswith("/adventure-public/research")
        assert "adventure-research" not in cwd  # not the private game's folder
        destination = fixture_bank().destination("AAA.one")
        assert destination is not None
        assert body["prompt"] == build_prompt(destination, "Alphaland")
        # The research folder was created before cmd was asked to use it.
        assert (storage_root / "projects" / "test" / "adventure-public" / "research").is_dir()


class TestResearchSlot:
    def test_only_one_public_research_runs_at_a_time_whatever_the_timing(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        busy = FakeRunPlan(statuses=["running"] * 15 + ["completed"])
        fake = FakeResearcher([busy, busy, busy])
        # `concurrency=2` is the private game's number; the public runner ignores it: its own slot.
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, researcher=fake, timing=fast(concurrency=2)
        ) as client:
            codes = [code_of(client, d) for d in ("AAA.one", "AAA.two", "AAA.three")]
            for code in codes:
                request_pack(client, code)
            for code in codes:
                wait_for_state(client, code, "ready", timeout_s=20)
        assert len(fake.started) == 3
        assert fake.max_in_flight == 1

    def test_spawns_are_at_least_the_gap_apart(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher()
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=fake,
            timing=fast(spawn_gap_s=0.4),
        ) as client:
            codes = [code_of(client, d) for d in ("AAA.one", "AAA.two")]
            for code in codes:
                request_pack(client, code)
            for code in codes:
                wait_for_state(client, code, "ready")
        first, second = fake.start_times
        assert second - first >= 0.35


class TestOutcomes:
    def test_an_answer_that_is_not_a_pack_fails_the_pack(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(response_text="I could not find anything.")])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            view = wait_for_state(client, code, "failed")
        assert view["error"] == PUBLIC_FAILED_TEXT and view["data"] is None

    def test_a_pack_with_pictures_to_find_goes_on_to_find_them(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        finder = FakePictureFinder()
        with public_client(storage_root, wixy_repo_root, monkeypatch, finder=finder) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for_images(client, code, "done")
        [plan] = finder.plans
        assert (plan.destination, plan.unit) == ("Alpha One", "Alphaland")

    def test_a_run_that_never_finishes_is_given_up_on_and_cancelled(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["running"])])
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, researcher=fake, timing=fast(give_up_s=0.3)
        ) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            view = wait_for_state(client, code, "failed")
        assert view["error"] == PUBLIC_FAILED_TEXT
        assert fake.cancelled == ["fake-run-1"]

    def test_the_production_give_up_is_twenty_five_minutes(self) -> None:
        assert PackTiming().give_up_s == 25 * 60 and PackTiming().spawn_gap_s == 5.0
        assert PackTiming().early_retry_s == 150.0 and PackTiming().poll_interval_s == 10.0

    @pytest.mark.parametrize("status", ["error", "timeout", "cancelled"])
    def test_a_run_that_ends_badly_fails_the_pack(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch, status: str
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=[status])])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "failed")

    def test_cmd_that_keeps_failing_to_answer_fails_the_pack(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(poll_errors=1000)])
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=fake,
            timing=fast(max_consecutive_poll_errors=3),
        ) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "failed")

    def test_a_refused_run_fails_the_pack_and_counts_as_a_try(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher(start_errors=[ResearchError("cmd refused")])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            view = wait_for_state(client, code, "failed")
            row = service(client).store.get("AAA.one")
        assert view["error"] == PUBLIC_FAILED_TEXT
        assert row is not None and row.tries == 1
        assert row.next_try_at is not None and row.next_try_at - time.time() > 590

    def test_cmd_being_unreachable_does_not_spend_a_try_and_may_be_retried_soon(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher(start_errors=[ResearchUnavailableError("down")])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            view = wait_for_state(client, code, "failed")
            row = service(client).store.get("AAA.one")
        assert view["error"] == PUBLIC_UNAVAILABLE_TEXT
        assert row is not None and row.tries == 0
        assert row.next_try_at is not None and 0 < row.next_try_at - time.time() <= 60

    def test_a_third_failure_closes_the_day_for_that_place(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["error"])] * 3)
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            store = service(client).store
            for attempt in range(3):
                assert request_pack(client, code).status_code == 200
                wait_for(
                    functools.partial(_failed_after, store, fake, attempt + 1),
                    what=f"failure {attempt + 1}",
                )
                if attempt < 2:  # the wait is over: let the next try through
                    conn = sqlite3.connect(str(store.db_path))
                    try:
                        conn.execute("UPDATE packs SET next_try_at = ?", (time.time() - 1,))
                        conn.commit()
                    finally:
                        conn.close()
            view = get_pack(client, code)
            assert view["state"] == "failed" and view["canRetry"] is False
            assert view["retryAfterS"] is not None and view["retryAfterS"] > 20 * 3600
            assert request_pack(client, code).json()["state"] == "failed"
            assert len(fake.started) == 3  # a fourth try was not started


class _Missing:
    state = "missing"


def _failed_after(store: PublicPackStore, fake: FakeResearcher, runs: int) -> bool:
    return (store.get("AAA.one") or _Missing).state == "failed" and len(fake.started) == runs


class TestEarlyRetry:
    def test_one_early_error_is_retried_once(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["error"]), FakeRunPlan()])
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=fake,
            timing=fast(early_retry_s=60),
        ) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
        assert len(fake.started) == 2

    def test_a_second_early_error_is_final(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["error"]), FakeRunPlan(statuses=["error"])])
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=fake,
            timing=fast(early_retry_s=60),
        ) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "failed")
        assert len(fake.started) == 2


class TestOverlap:
    def test_a_pack_finished_by_another_process_is_left_alone_and_the_run_cancelled(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["running"] * 1000)])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            store = service(client).store
            wait_for(lambda: (store.get("AAA.one") or _Missing).state == "pending", what="pending")
            wait_for(lambda: fake.polls.get("fake-run-1", 0) >= 2, what="the first polls")
            # The other (blue/green) process stores its own answer for the same run.
            assert store.finish(
                "AAA.one",
                run_id="fake-run-1",
                state="ready",
                pack_json=json.dumps({"headline": "the other process's pack"}),
            )
            wait_for(lambda: fake.cancelled == ["fake-run-1"], what="the run to be cancelled")
            view = get_pack(client, code)
        assert view["state"] == "ready" and view["data"] == {"headline": "the other process's pack"}


class TestResume:
    def test_a_pack_that_never_got_a_run_is_started_by_the_next_process(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Seed a `pending` row with no run, as a process that died before the spawn leaves.
        with public_client(storage_root, wixy_repo_root, monkeypatch, no_researcher=True) as seed:
            service(seed).store.request_start("AAA.one")
        fake = FakeResearcher()
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            view = wait_for_state(client, code, "ready")
        assert view["data"] is not None and len(fake.started) == 1

    def test_with_no_researcher_a_pending_pack_cannot_finish_so_it_fails_and_may_be_asked_again(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch) as seed:
            service(seed).store.request_start("AAA.one")
        with public_client(storage_root, wixy_repo_root, monkeypatch, no_researcher=True) as client:
            row = service(client).store.get("AAA.one")
        assert row is not None and row.state == "failed" and row.error == PUBLIC_UNAVAILABLE_TEXT
        assert row.tries == 0  # an outage is not a try

    def test_a_resumed_pack_whose_run_cmd_has_forgotten_fails_after_the_poll_limit(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch) as seed:
            store = service(seed).store
            store.request_start("AAA.one")
            store.set_run("AAA.one", run_id="gone-run")
        forgetful = FakeResearcher()  # does not know "gone-run": every poll raises
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=_Forgetful(forgetful),
            timing=fast(max_consecutive_poll_errors=3),
        ) as client:
            code = code_of(client, "AAA.one")
            wait_for_state(client, code, "failed")
        assert forgetful.started == []  # nothing was re-spawned for a run that might have an answer


class _Forgetful:
    """A researcher whose polls of an unknown run fail (cmd forgot it), delegating the rest."""

    def __init__(self, inner: FakeResearcher) -> None:
        self._inner = inner

    async def start(self, *, prompt: str, cwd: Path) -> str:
        return await self._inner.start(prompt=prompt, cwd=cwd)

    async def poll(self, run_id: str) -> Any:
        raise ResearchError("unknown run")

    async def cancel(self, run_id: str) -> None:
        await self._inner.cancel(run_id)


def _raw(db: Path) -> bytes:
    wal = Path(f"{db}-wal")
    return db.read_bytes() + (wal.read_bytes() if wal.exists() else b"")


class TestNothingEntersTheChatDatabase:
    def test_public_data_never_reaches_server_db(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, finder=FakePictureFinder()
        ) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            wait_for_images(client, code, "done")
            private = service(client).store.db_path.parent.parent / "server" / "server.db"
            public_db = service(client).store.db_path
        assert private.exists() and private != public_db
        conn = sqlite3.connect(str(private))
        try:
            tables = {
                r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            assert not {"packs", "pictures"} & tables
            assert conn.execute("SELECT count(*) FROM adv_rounds").fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM attachments").fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM uploads").fetchone()[0] == 0
        finally:
            conn.close()
        assert b"Alpha One" not in _raw(private) and b"custard" not in _raw(private)
        # Sanity: the public database DID receive the pack.
        assert b"custard" in _raw(public_db)

    def test_the_private_game_cannot_see_the_public_cache(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            wait_for_state(client, code, "ready")
            runner = client.app.state.livechat_adventure_runner  # type: ignore[attr-defined]
            assert runner is not service(client).runner  # separate runners, separate slots
            assert runner._store is not service(client).store  # noqa: SLF001
            assert FAST.concurrency == 2  # the private game keeps its two slots
