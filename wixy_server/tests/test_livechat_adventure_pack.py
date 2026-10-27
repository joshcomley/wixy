# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The Adventure Time holiday pack (workspace 00056, spec/server-chat/08-adventure-time.md §4.3):
the defensive parse and sanitise, the prompt, `cmdchat.py`'s chat-spawn run calls against the fake
cmd, and the job itself — success, bad JSON, failure, timeout, the early retry, restart resume,
the blue/green compare-and-set, the unavailable edition, retry, and the pacing limits."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest

from wixy_server.background import ContainedTaskGroup
from wixy_server.cmdchat import (
    CmdChatClient,
    CmdChatError,
    CmdChatUnreachableError,
)
from wixy_server.livechat.adventure_bank import AdventureBank, AdventureDestination
from wixy_server.livechat.adventure_pack import (
    DISALLOWED_TOOLS,
    MAX_HEADLINE,
    MAX_ITEM_DETAIL,
    MAX_ITEM_NAME,
    MAX_SOURCES,
    PACK_CALLER,
    PACK_MODEL,
    RESEARCH_DIRNAME,
    AdventurePackRunner,
    CmdAdventureResearcher,
    PackTiming,
    ResearchError,
    ResearchUnavailableError,
    build_prompt,
    canonical_pack_json,
    clean_url,
    parse_pack,
    sanitise_pack,
)
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import (
    ADVENTURE_PACK_FAILED_TEXT,
    ADVENTURE_PACK_UNAVAILABLE_TEXT,
    LiveChatStore,
)
from wixy_server.storage import project_paths
from wixy_server.tests.adventure_testkit import (
    FAST,
    FakeResearcher,
    FakeRunPlan,
    fixture_bank,
    get_view,
    start_round,
    to_chosen,
    unlocked_client,
    wait_for_pack,
)
from wixy_server.tests.fake_cmd import (
    CANNED_ADVENTURE_PACK,
    FakeCmdState,
    FakeSpawnPlan,
    create_fake_cmd_app,
)
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)

PACK_TEXT = json.dumps(CANNED_ADVENTURE_PACK)


def _valid(**over: Any) -> dict[str, Any]:
    pack: dict[str, Any] = json.loads(PACK_TEXT)
    pack.update(over)
    return pack


# -- sanitising --------------------------------------------------------------------------------


class TestSanitise:
    def test_a_valid_pack_comes_through_whole(self) -> None:
        pack = sanitise_pack(_valid())
        assert pack is not None
        assert set(pack) == {
            "headline",
            "summary",
            "sections",
            "bestTime",
            "gettingThere",
            "travelAdvice",
            "sources",
        }
        assert pack["headline"] == CANNED_ADVENTURE_PACK["headline"]
        sections: Any = pack["sections"]
        assert [s["key"] for s in sections] == ["food", "stay", "sights"]
        assert sections[0]["items"][0] == {
            "name": "Pasteis de nata",
            "detail": "The custard tart every bakery sells; eat one warm with cinnamon.",
            "url": "https://example.com/food/pasteis",
        }
        assert sections[0]["items"][1]["url"] is None
        assert pack["sources"] == [{"title": "Visit Portugal", "url": "https://example.com/visit"}]

    def test_strings_are_clipped_to_their_limits(self) -> None:
        long = "x" * 5000
        raw = _valid(
            headline=long,
            summary=long,
            bestTime=long,
            gettingThere=long,
            travelAdvice=long,
            sections=[
                {
                    "key": "food",
                    "title": long,
                    "items": [{"name": long, "detail": long, "url": None}],
                }
            ],
            sources=[{"title": long, "url": "https://example.com/a"}],
        )
        pack: Any = sanitise_pack(raw)
        assert pack is not None
        limits = {
            "headline": 140,
            "summary": 700,
            "bestTime": 240,
            "gettingThere": 300,
            "travelAdvice": 400,
        }
        for key, limit in limits.items():
            value = pack[key]
            assert isinstance(value, str) and len(value) == limit and value.endswith("\u2026")
        section = pack["sections"][0]
        assert len(section["title"]) == 60
        assert len(section["items"][0]["name"]) == MAX_ITEM_NAME
        assert len(section["items"][0]["detail"]) == MAX_ITEM_DETAIL
        assert len(pack["sources"][0]["title"]) == 120
        assert MAX_HEADLINE == 140

    def test_counts_are_capped(self) -> None:
        keys = ["food", "stay", "culture", "sights", "do", "practical"]
        sections = [
            {
                "key": k,
                "title": k,
                "items": [{"name": f"item {n}", "detail": "d", "url": None} for n in range(9)],
            }
            for k in keys
        ]
        sources = [{"title": f"s{n}", "url": f"https://example.com/{n}"} for n in range(20)]
        pack: Any = sanitise_pack(_valid(sections=sections, sources=sources))
        assert pack is not None
        assert len(pack["sections"]) == 6
        assert all(len(s["items"]) == 6 for s in pack["sections"])
        assert len(pack["sources"]) == MAX_SOURCES == 12

    def test_unknown_keys_are_dropped_everywhere(self) -> None:
        raw = _valid(extra="x", secret={"a": 1})
        raw["sections"][0]["surprise"] = 1
        raw["sections"][0]["items"][0]["image"] = "https://example.com/a.png"
        raw["sources"][0]["note"] = "n"
        pack: Any = sanitise_pack(raw)
        assert pack is not None and "extra" not in pack and "secret" not in pack
        section = pack["sections"][0]
        assert set(section) == {"key", "title", "items"}
        assert set(section["items"][0]) == {"name", "detail", "url"}
        assert set(pack["sources"][0]) == {"title", "url"}

    @pytest.mark.parametrize(
        "url",
        [
            "https://example.com/page",
            "http://example.com",
            "HTTPS://Example.com/Path?x=1#frag",
            "https://sub.example.co.uk:8443/a/b",
        ],
    )
    def test_good_urls_survive_unchanged(self, url: str) -> None:
        assert clean_url(url) == url
        assert clean_url(f"  {url}  ") == url

    @pytest.mark.parametrize(
        "url",
        [
            "javascript:alert(1)",
            "data:text/html,hi",
            "ftp://example.com/a",
            "file:///etc/passwd",
            "//example.com/a",
            "example.com/a",
            "https://",
            "https:///path",
            "https://user:pw@example.com/",
            "https://user@example.com/",
            "https://exa mple.com/",
            "https://example.com/a b",
            "https://example.com/\x00",
            "https://localhost/",
            "https://intranet/",
            "https://[::1]/",
            "https://example.com:notaport/",
            "https://example.com/" + "a" * 500,
            "",
            "   ",
            None,
            7,
            ["https://example.com"],
        ],
    )
    def test_bad_urls_are_dropped(self, url: Any) -> None:
        assert clean_url(url) is None

    def test_a_url_of_exactly_500_characters_is_kept(self) -> None:
        url = "https://example.com/" + "a" * (500 - len("https://example.com/"))
        assert len(url) == 500 and clean_url(url) == url

    def test_items_with_bad_urls_keep_their_text_without_the_link(self) -> None:
        raw = _valid(
            sections=[
                {
                    "key": "stay",
                    "title": "Stay",
                    "items": [{"name": "A villa", "detail": "Nice.", "url": "javascript:x"}],
                }
            ]
        )
        pack: Any = sanitise_pack(raw)
        assert pack is not None
        assert pack["sections"][0]["items"][0] == {
            "name": "A villa",
            "detail": "Nice.",
            "url": None,
        }

    def test_sources_need_a_good_url_and_get_a_host_title_when_blank(self) -> None:
        raw = _valid(
            sources=[
                {"title": "Bad", "url": "javascript:x"},
                {"title": "", "url": "https://www.example.com/page"},
                {"title": "No url"},
                "not an object",
            ]
        )
        pack = sanitise_pack(raw)
        assert pack is not None
        assert pack["sources"] == [
            {"title": "www.example.com", "url": "https://www.example.com/page"}
        ]

    def test_section_rules(self) -> None:
        item = {"name": "n", "detail": "d", "url": None}
        raw = _valid(
            sections=[
                {"key": "food", "title": "First food", "items": [item]},
                {"key": "food", "title": "Second food", "items": [item]},  # duplicate key
                {"key": "nonsense", "title": "x", "items": [item]},  # unknown key
                {"key": "stay", "title": "x", "items": []},  # no items
                {"key": "do", "title": "x", "items": [{"name": "", "detail": "d"}]},  # no name
                {"key": "culture", "title": "", "items": [item]},  # default title
                "junk",
                {"key": 7, "items": [item]},
            ]
        )
        pack: Any = sanitise_pack(raw)
        assert pack is not None
        assert [(s["key"], s["title"]) for s in pack["sections"]] == [
            ("food", "First food"),
            ("culture", "Culture"),
        ]

    @pytest.mark.parametrize(
        "raw",
        [
            {},
            {"sections": []},
            {"sections": "nope"},
            {"sections": [{"key": "food", "title": "t", "items": []}]},
            {"headline": "H"},
            [],
            "text",
            None,
            7,
        ],
    )
    def test_a_pack_without_a_usable_section_is_a_failure(self, raw: Any) -> None:
        assert sanitise_pack(raw) is None

    def test_missing_optional_text_becomes_empty_strings(self) -> None:
        raw = {"sections": [{"key": "food", "title": "Food", "items": [{"name": "n"}]}]}
        pack: Any = sanitise_pack(raw)
        assert pack is not None
        assert pack["headline"] == "" and pack["summary"] == "" and pack["sources"] == []
        assert pack["sections"][0]["items"][0] == {"name": "n", "detail": "", "url": None}

    def test_whitespace_and_control_characters_are_tidied(self) -> None:
        raw = _valid(
            headline="  A \n  headline\twith \x07 bells  ",
            summary="First line.\r\n\r\n\r\n\r\nSecond   line.\x00",
        )
        pack = sanitise_pack(raw)
        assert pack is not None
        assert pack["headline"] == "A headline with bells"
        assert pack["summary"] == "First line.\n\nSecond line."

    def test_non_string_fields_do_not_crash(self) -> None:
        raw = _valid(headline=7, summary=None, bestTime=["x"], travelAdvice={"a": 1})
        pack = sanitise_pack(raw)
        assert pack is not None
        assert pack["headline"] == "" and pack["summary"] == ""
        assert pack["bestTime"] == "" and pack["travelAdvice"] == ""


class TestParse:
    def test_it_finds_the_json_in_prose_and_fences(self) -> None:
        text = f"Here is the pack you asked for:\n```json\n{PACK_TEXT}\n```\nHope that helps!"
        pack = parse_pack(text)
        assert pack is not None and pack["headline"] == CANNED_ADVENTURE_PACK["headline"]

    def test_it_takes_the_last_json_object(self) -> None:
        first = json.dumps(_valid(headline="DRAFT"))
        second = json.dumps(_valid(headline="FINAL"))
        pack = parse_pack(f"draft: {first}\n\nfinal: {second}")
        assert pack is not None and pack["headline"] == "FINAL"

    def test_a_later_object_that_is_not_a_pack_does_not_hide_the_pack(self) -> None:
        pack = parse_pack(PACK_TEXT + '\n\nAlso: {"note": "done"} {} {not json}')
        assert pack is not None and pack["headline"] == CANNED_ADVENTURE_PACK["headline"]

    def test_nested_objects_are_not_mistaken_for_the_pack(self) -> None:
        # The items inside the pack are objects too; the whole pack is the top-level one.
        pack: Any = parse_pack(PACK_TEXT)
        assert pack is not None and len(pack["sections"]) == 3

    @pytest.mark.parametrize(
        "text",
        ["", "no json here at all", "{broken", '{"sections": []}', "[1, 2, 3]", '"text"', "}{"],
    )
    def test_nothing_usable_is_a_failure(self, text: str) -> None:
        assert parse_pack(text) is None

    def test_the_canonical_form_round_trips(self) -> None:
        pack = parse_pack("Pack: " + PACK_TEXT)
        assert pack is not None
        text = canonical_pack_json(pack)
        assert json.loads(text) == pack
        assert parse_pack(text) == pack  # idempotent


# -- the prompt --------------------------------------------------------------------------------


class TestPrompt:
    DEST = AdventureDestination(
        id="PRX.lisbon",
        name="Lisbon",
        region="Lisbon District",
        lat=38.7223,
        lng=-9.1393,
        kind="city",
        blurb="Hilltop city of trams.",
    )

    def test_it_names_only_the_destination(self) -> None:
        prompt = build_prompt(self.DEST, "Portugal")
        assert "Destination: Lisbon" in prompt
        assert "Area: Lisbon District, Portugal" in prompt
        assert "latitude 38.7223, longitude -9.1393" in prompt
        # The bank's blurb and kind are not sent: the brief is name, region, unit, coordinates.
        assert "Hilltop city" not in prompt and "PRX" not in prompt

    def test_it_asks_for_live_web_research_with_only_the_web_tools(self) -> None:
        prompt = build_prompt(self.DEST, "Portugal")
        assert "WebSearch and WebFetch" in prompt
        assert "never invent a place or a link" in prompt

    def test_it_demands_the_exact_final_json_shape_with_the_limits(self) -> None:
        prompt = build_prompt(self.DEST, "Portugal")
        for needle in (
            "exactly one JSON object",
            '"headline"',
            '"summary"',
            '"sections"',
            '"food" | "stay" | "culture" | "sights" | "do" | "practical"',
            '"items"',
            '"bestTime"',
            '"gettingThere"',
            '"travelAdvice"',
            '"sources"',
            "max 140",
            "max 700",
            "max 400",
            "at most 6",
            "at most 12",
            "2-4 specific villas",
            "2-4 specific places",
        ):
            assert needle in prompt, needle

    def test_it_pins_the_voice_and_the_travel_advice_source(self) -> None:
        prompt = build_prompt(self.DEST, "Portugal")
        assert "warm, knowledgeable friend talking to the couple" in prompt
        assert "Never mention yourself, your searches or your sources" in prompt
        assert "leave it out" in prompt
        assert "https://www.gov.uk/foreign-travel-advice/" in prompt
        assert "one or two sentences" in prompt


# -- cmdchat.py's chat-spawn run calls against the fake cmd ----------------------------------------


def _fake_client(state: FakeCmdState) -> CmdChatClient:
    return CmdChatClient(transport=httpx.ASGITransport(app=create_fake_cmd_app(state)))


async def _spawn(client: CmdChatClient, **over: Any) -> Any:
    kwargs: dict[str, Any] = {
        "caller": PACK_CALLER,
        "prompt": "research please",
        "model": PACK_MODEL,
        "effort": "medium",
        "cwd": "D:/some/where/adventure-research",
        "timeout_secs": 1200,
        "disallowed_tools": list(DISALLOWED_TOOLS),
    }
    kwargs.update(over)
    return await client.spawn_run(**kwargs)


class TestCmdchatRuns:
    def test_the_spawn_body_is_exactly_what_the_spec_asks_for(self) -> None:
        state = FakeCmdState()
        researcher = CmdAdventureResearcher(_fake_client(state))

        async def go() -> str:
            return await researcher.start(
                prompt="the brief", cwd=Path("D:\\Servers\\Wixy\\Storage\\x\\adventure-research")
            )

        run_id = anyio.run(go)
        [run] = state.chat_spawn_runs.values()
        assert run.run_id == run_id
        assert run.body == {
            "caller": "wixy-adventure-pack",
            "prompt": "the brief",
            "model": "claude-sonnet-5-5",
            "effort": "medium",
            "spawned_by_session_id": "",
            "cwd": "D:/Servers/Wixy/Storage/x/adventure-research",
            "build_space": "primary",
            "bucket": "subscription",
            "timeout_secs": 1200,
            "disallowed_tools": [
                "Bash",
                "PowerShell",
                "Edit",
                "Write",
                "MultiEdit",
                "NotebookEdit",
                "Read",
                "Grep",
                "Glob",
                "Agent",
                "Task",
                "Skill",
                "TodoWrite",
            ],
        }
        assert "tag" not in run.body  # untagged: a hidden system chat in cmd

    def test_poll_reads_the_nested_run_and_the_final_message(self) -> None:
        state = FakeCmdState()
        state.chat_spawn_running_polls = 1
        state.chat_spawn_response_text = "FINAL TEXT"

        async def go() -> list[tuple[str, str | None]]:
            client = _fake_client(state)
            run = await _spawn(client)
            assert run.status == "queued" and run.response_text is None and not run.terminal
            seen = []
            for _ in range(3):
                polled = await client.get_run(run.run_id)
                seen.append((polled.status, polled.response_text))
            return seen

        assert anyio.run(go) == [
            ("running", None),
            ("completed", "FINAL TEXT"),
            ("completed", "FINAL TEXT"),
        ]

    def test_every_status_cmd_reports_is_passed_through(self) -> None:
        for status in ("error", "timeout", "cancelled"):
            state = FakeCmdState()
            state.chat_spawn_plans = [FakeSpawnPlan(final_status=status, error_text="boom")]

            async def go(state: FakeCmdState = state) -> Any:
                client = _fake_client(state)
                run = await _spawn(client)
                return await client.get_run(run.run_id)

            polled = anyio.run(go)
            assert polled.status == status and polled.terminal
            assert polled.response_text is None
            assert polled.error_text == ("boom" if status != "cancelled" else None)

    def test_cancel_stops_a_running_run_and_an_unknown_run_is_fine(self) -> None:
        state = FakeCmdState()
        state.chat_spawn_running_polls = 99

        async def go() -> str:
            client = _fake_client(state)
            run = await _spawn(client)
            await client.cancel_run(run.run_id)
            await client.cancel_run("no-such-run")  # 404 is tolerated
            return (await client.get_run(run.run_id)).status

        assert anyio.run(go) == "cancelled"

    def test_a_refused_spawn_is_a_cmd_error_not_an_unreachable_one(self) -> None:
        state = FakeCmdState()
        state.chat_spawn_status_code = 400

        async def go() -> None:
            await _spawn(_fake_client(state))

        with pytest.raises(CmdChatError) as info:
            anyio.run(go)
        assert not isinstance(info.value, CmdChatUnreachableError)

    def test_a_response_without_a_run_is_a_hard_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(201, json={"unexpected": True})

        client = CmdChatClient(transport=httpx.MockTransport(handler))

        async def go() -> None:
            await _spawn(client)

        with pytest.raises(CmdChatError, match="no run object"):
            anyio.run(go)

    def test_a_flat_run_row_is_accepted_too(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"run_id": "r1", "status": "running"})

        client = CmdChatClient(transport=httpx.MockTransport(handler))

        async def go() -> Any:
            return await client.get_run("r1")

        assert anyio.run(go).status == "running"

    def test_a_connection_refused_spawn_is_retried_then_unreachable(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            raise httpx.ConnectError("refused", request=request)

        client = CmdChatClient(transport=httpx.MockTransport(handler))

        async def go() -> None:
            await _spawn(client)

        with pytest.raises(CmdChatUnreachableError):
            anyio.run(go)
        assert len(attempts) == 3

    def test_a_spawn_whose_answer_was_lost_is_never_repeated(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            raise httpx.ReadTimeout("slow", request=request)

        client = CmdChatClient(transport=httpx.MockTransport(handler))

        async def go() -> None:
            await _spawn(client)

        with pytest.raises(CmdChatUnreachableError):
            anyio.run(go)
        assert attempts == [1]  # a second run would spend a second allowance

    def test_polling_is_still_retried_on_transport_errors(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) < 3:
                raise httpx.ReadTimeout("slow", request=request)
            return httpx.Response(200, json={"run": {"run_id": "r1", "status": "running"}})

        client = CmdChatClient(transport=httpx.MockTransport(handler))

        async def go() -> Any:
            return await client.get_run("r1")

        assert anyio.run(go).status == "running" and len(attempts) == 3

    def test_the_researcher_maps_cmd_failures(self) -> None:
        state = FakeCmdState()
        state.chat_spawn_status_code = 400
        refused = CmdAdventureResearcher(_fake_client(state))

        def down(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        unreachable = CmdAdventureResearcher(CmdChatClient(transport=httpx.MockTransport(down)))

        async def go(researcher: CmdAdventureResearcher, call: str) -> Any:
            if call == "start":
                return await researcher.start(prompt="p", cwd=Path("/x"))
            if call == "poll":
                return await researcher.poll("r")
            return await researcher.cancel("r")

        with pytest.raises(ResearchError) as refusal:
            anyio.run(go, refused, "start")
        assert not isinstance(refusal.value, ResearchUnavailableError)
        with pytest.raises(ResearchUnavailableError):
            anyio.run(go, unreachable, "start")
        with pytest.raises(ResearchError):
            anyio.run(go, unreachable, "poll")
        anyio.run(go, unreachable, "cancel")  # cancel never raises

    def test_the_directory_name_is_the_documented_one(self) -> None:
        assert RESEARCH_DIRNAME == "adventure-research"


# -- the job ---------------------------------------------------------------------------------------


class CountingNotifier(LiveChatNotifier):
    def __init__(self) -> None:
        super().__init__()
        self.publishes = 0

    def publish(self) -> None:
        self.publishes += 1
        super().publish()


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


@pytest.fixture
def bank() -> AdventureBank:
    return fixture_bank()


def _runner(
    store: LiveChatStore,
    bank: AdventureBank,
    researcher: FakeResearcher | None,
    tmp_path: Path,
    timing: PackTiming = FAST,
    notifier: LiveChatNotifier | None = None,
) -> AdventurePackRunner:
    return AdventurePackRunner(
        store=store,
        bank=bank,
        researcher=researcher,
        notifier=notifier if notifier is not None else CountingNotifier(),
        cwd=tmp_path / RESEARCH_DIRNAME,
        timing=timing,
    )


def _chosen(
    store: LiveChatStore,
    bank: AdventureBank,
    cid: str = "adv-pack-round-01",
    unit: str = "AAA",
    destination: str | None = None,
) -> int:
    seq = start_round(store, cid)
    to_chosen(store, bank, seq, unit=unit, destination=destination)
    return seq


def _pack(store: LiveChatStore, seq: int) -> Any:
    row = store.get_adventure_round(anchor_seq=seq)
    assert row is not None
    return row


_EARLY = PackTiming(poll_interval_s=0.02, spawn_gap_s=0.0, give_up_s=30.0, early_retry_s=150.0)


class TestJob:
    def test_success_stores_the_sanitised_pack_and_announces_it(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        notifier = CountingNotifier()
        researcher = FakeResearcher([FakeRunPlan(statuses=["running", "running", "completed"])])
        runner = _runner(store, bank, researcher, tmp_path, notifier=notifier)
        rev = _pack(store, seq).rev
        anyio.run(runner.run_job, seq)
        row = _pack(store, seq)
        assert row.pack == "ready" and row.pack_error is None and row.pack_run_id == "fake-run-1"
        assert row.pack_json is not None
        stored = json.loads(row.pack_json)
        assert stored == sanitise_pack(json.loads(PACK_TEXT))
        assert row.rev == rev + 1 and notifier.publishes == 1
        assert researcher.polls["fake-run-1"] == 3 and researcher.cancelled == []
        [(prompt, cwd)] = researcher.started
        assert "Destination: Alpha One" in prompt and cwd == tmp_path / RESEARCH_DIRNAME

    def test_the_job_only_ever_sends_the_bank_destination(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = start_round(store, "adv-pack-private-1", sender="ZZ-PRIVATE-NAME")
        store.create_message(
            client_id="adv-pack-private-m",
            sender="ZZ-PRIVATE-NAME",
            device_id="device-1234",
            by_email="private@example.com",
            text="ZZ-PRIVATE-TEXT about our trip",
            attachment_ids=[],
            wyr_anchor_seq=seq,
            now=5.0,
        )
        to_chosen(store, bank, seq)
        researcher = FakeResearcher()
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, seq)
        [(prompt, _cwd)] = researcher.started
        for private in ("ZZ-PRIVATE", "private@example.com", "Josh", "Rose"):
            assert private not in prompt

    @pytest.mark.parametrize(
        "text",
        ["not json at all", "{broken", '{"sections": []}', "", "[1,2]"],
    )
    def test_an_unusable_answer_is_a_failure_with_a_generic_error(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path, text: str
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher([FakeRunPlan(response_text=text)])
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, seq)
        row = _pack(store, seq)
        assert row.pack == "failed" and row.pack_json is None
        assert row.pack_error == ADVENTURE_PACK_FAILED_TEXT
        assert row.pack_error == "The research didn't finish \u2014 try again"

    @pytest.mark.parametrize("status", ["error", "timeout", "cancelled"])
    def test_a_run_that_ends_badly_fails_the_pack(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path, status: str
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher([FakeRunPlan(statuses=["running", status])])
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, seq)
        row = _pack(store, seq)
        assert row.pack == "failed" and row.pack_error == ADVENTURE_PACK_FAILED_TEXT
        assert len(researcher.started) == 1  # not within the early-retry window

    def test_a_run_that_never_finishes_is_cancelled_after_the_give_up_time(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher([FakeRunPlan(statuses=["running"])])
        timing = PackTiming(poll_interval_s=0.02, spawn_gap_s=0.0, give_up_s=0.2, early_retry_s=0.0)
        anyio.run(_runner(store, bank, researcher, tmp_path, timing).run_job, seq)
        assert researcher.cancelled == ["fake-run-1"]
        row = _pack(store, seq)
        assert row.pack == "failed" and row.pack_error == ADVENTURE_PACK_FAILED_TEXT

    def test_a_cmd_error_in_the_first_150_seconds_is_retried_once(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher([FakeRunPlan(statuses=["error"]), FakeRunPlan()])
        anyio.run(_runner(store, bank, researcher, tmp_path, _EARLY).run_job, seq)
        row = _pack(store, seq)
        assert row.pack == "ready" and row.pack_run_id == "fake-run-2"
        assert len(researcher.started) == 2
        assert PackTiming().early_retry_s == 150.0

    def test_only_one_retry_is_allowed(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher(
            [FakeRunPlan(statuses=["error"]), FakeRunPlan(statuses=["error"]), FakeRunPlan()]
        )
        anyio.run(_runner(store, bank, researcher, tmp_path, _EARLY).run_job, seq)
        row = _pack(store, seq)
        assert row.pack == "failed" and len(researcher.started) == 2

    def test_a_timeout_status_is_not_retried_even_when_early(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher([FakeRunPlan(statuses=["timeout"]), FakeRunPlan()])
        anyio.run(_runner(store, bank, researcher, tmp_path, _EARLY).run_job, seq)
        assert _pack(store, seq).pack == "failed" and len(researcher.started) == 1

    def test_cmd_unreachable_at_the_start_makes_the_pack_unavailable(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher(start_errors=[ResearchUnavailableError("down")])
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, seq)
        row = _pack(store, seq)
        assert row.pack == "unavailable" and row.pack_error == ADVENTURE_PACK_UNAVAILABLE_TEXT
        # ...and a later retry (cmd back) goes through.
        store.retry_adventure_pack(anchor_seq=seq, researcher_available=True)
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, seq)
        assert _pack(store, seq).pack == "ready"

    def test_cmd_refusing_the_run_fails_the_pack(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher(start_errors=[ResearchError("refused")])
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, seq)
        assert _pack(store, seq).pack == "failed"

    def test_transient_poll_errors_are_tolerated_but_not_forever(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher([FakeRunPlan(poll_errors=3)])
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, seq)
        assert _pack(store, seq).pack == "ready"

        other = _chosen(store, bank, "adv-pack-round-02", unit="BBB")
        broken = FakeResearcher([FakeRunPlan(poll_errors=99)])
        timing = PackTiming(
            poll_interval_s=0.01, spawn_gap_s=0.0, give_up_s=30.0, max_consecutive_poll_errors=4
        )
        anyio.run(_runner(store, bank, broken, tmp_path, timing).run_job, other)
        assert _pack(store, other).pack == "failed"
        assert broken.polls["fake-run-1"] == 4

    def test_an_unexpected_error_fails_the_pack_instead_of_leaving_it_pending(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        class Exploding(FakeResearcher):
            async def poll(self, run_id: str) -> Any:
                raise RuntimeError("bug")

        seq = _chosen(store, bank)
        anyio.run(_runner(store, bank, Exploding(), tmp_path).run_job, seq)
        assert _pack(store, seq).pack == "failed"

    def test_a_pack_landing_on_a_banked_round_still_lands(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        store.decide_adventure(anchor_seq=seq, sender="Josh", decision="bank")
        researcher = FakeResearcher()
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, seq)
        row = _pack(store, seq)
        assert row.state == "banked" and row.pack == "ready"

    def test_rejecting_during_the_research_cancels_the_run(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher([FakeRunPlan(statuses=["running"])])
        runner = _runner(store, bank, researcher, tmp_path)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(runner.run_job, seq)
                while not researcher.started:
                    await anyio.sleep(0.01)
                await anyio.to_thread.run_sync(
                    lambda: store.decide_adventure(anchor_seq=seq, sender="Josh", decision="reject")
                )

        anyio.run(go)
        assert researcher.cancelled == ["fake-run-1"]
        row = _pack(store, seq)
        assert row.state == "rejected" and row.pack == "failed" and row.pack_json is None

    def test_deleting_the_round_during_the_research_cancels_the_run(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path, db_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher([FakeRunPlan(statuses=["running"])])
        runner = _runner(store, bank, researcher, tmp_path)

        def delete() -> None:
            conn = sqlite3.connect(str(db_path))
            try:
                conn.execute("PRAGMA foreign_keys = ON")
                conn.execute("DELETE FROM messages WHERE seq = ?", (seq,))
                conn.commit()
            finally:
                conn.close()

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(runner.run_job, seq)
                while not researcher.started:
                    await anyio.sleep(0.01)
                await anyio.to_thread.run_sync(delete)

        anyio.run(go)
        assert researcher.cancelled == ["fake-run-1"]
        assert store.get_adventure_round(anchor_seq=seq) is None

    def test_a_round_that_is_no_longer_pending_is_left_alone(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="r0")
        store.finish_adventure_pack(anchor_seq=seq, run_id="r0", state="failed", error="e")
        researcher = FakeResearcher()
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, seq)
        assert researcher.started == [] and _pack(store, seq).pack == "failed"
        anyio.run(_runner(store, bank, researcher, tmp_path).run_job, 9999)  # unknown round
        assert researcher.started == []

    def test_a_retried_pack_runs_again(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher([FakeRunPlan(statuses=["timeout"])])
        runner = _runner(store, bank, researcher, tmp_path)
        anyio.run(runner.run_job, seq)
        assert _pack(store, seq).pack == "failed"
        _, changed = store.retry_adventure_pack(anchor_seq=seq, researcher_available=True)
        assert changed is True
        anyio.run(runner.run_job, seq)
        row = _pack(store, seq)
        assert row.pack == "ready" and row.pack_run_id == "fake-run-2"

    def test_no_researcher_means_the_job_does_nothing(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank, "adv-pack-none-0001")
        runner = _runner(store, bank, None, tmp_path)
        assert runner.available is False
        anyio.run(runner.run_job, seq)
        assert _pack(store, seq).pack == "pending"

    def test_the_working_directory_is_created_empty(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        runner = _runner(store, bank, FakeResearcher(), tmp_path)
        runner.prepare_directory()
        runner.prepare_directory()  # idempotent
        directory = tmp_path / RESEARCH_DIRNAME
        assert directory.is_dir() and list(directory.iterdir()) == []
        assert not (directory / ".git").exists()


async def _resume(runner: AdventurePackRunner) -> int:
    found = 0
    async with anyio.create_task_group() as tg:
        found = await runner.resume(ContainedTaskGroup(tg))
    return found


class TestRestartAndOverlap:
    def test_a_pending_round_with_a_run_id_resumes_polling_that_run(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="run-from-before")
        researcher = FakeResearcher()
        researcher.adopt("run-from-before", FakeRunPlan(statuses=["running", "completed"]))
        runner = _runner(store, bank, researcher, tmp_path)
        assert anyio.run(_resume, runner) == 1
        row = _pack(store, seq)
        assert row.pack == "ready" and row.pack_run_id == "run-from-before"
        assert researcher.started == []  # no new run was started

    def test_a_pending_round_without_a_run_id_starts_a_new_run(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        researcher = FakeResearcher()
        runner = _runner(store, bank, researcher, tmp_path)
        assert anyio.run(_resume, runner) == 1
        row = _pack(store, seq)
        assert row.pack == "ready" and row.pack_run_id == "fake-run-1"
        assert len(researcher.started) == 1

    def test_a_resumed_run_that_died_is_not_retried(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="old-run")
        researcher = FakeResearcher()
        researcher.adopt("old-run", FakeRunPlan(statuses=["error"]))
        anyio.run(_resume, _runner(store, bank, researcher, tmp_path, _EARLY))
        assert _pack(store, seq).pack == "failed" and researcher.started == []

    def test_only_pending_rounds_are_resumed(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        ready = _chosen(store, bank, "adv-resume-ready-1")
        store.set_adventure_pack_run(anchor_seq=ready, run_id="r")
        store.finish_adventure_pack(
            anchor_seq=ready, run_id="r", state="ready", pack_json='{"x":1}'
        )
        start_round(store, "adv-resume-spin-01")
        researcher = FakeResearcher()
        assert anyio.run(_resume, _runner(store, bank, researcher, tmp_path)) == 0
        assert researcher.started == []

    def test_without_a_researcher_pending_rounds_become_unavailable(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="orphan")
        notifier = CountingNotifier()
        runner = _runner(store, bank, None, tmp_path, notifier=notifier)
        assert anyio.run(_resume, runner) == 1
        row = _pack(store, seq)
        assert row.pack == "unavailable" and row.pack_error == ADVENTURE_PACK_UNAVAILABLE_TEXT
        assert notifier.publishes == 1

    def test_two_processes_polling_one_run_store_it_once(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path, db_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        store.set_adventure_pack_run(anchor_seq=seq, run_id="shared-run")
        other_store = LiveChatStore(db_path)  # the other blue/green process's connection
        researcher = FakeResearcher()
        researcher.adopt("shared-run", FakeRunPlan(statuses=["running", "completed"]))
        notifier_a, notifier_b = CountingNotifier(), CountingNotifier()
        a = _runner(store, bank, researcher, tmp_path, notifier=notifier_a)
        b = _runner(other_store, bank, researcher, tmp_path, notifier=notifier_b)
        rev = _pack(store, seq).rev

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(a.run_job, seq)
                tg.start_soon(b.run_job, seq)

        anyio.run(go)
        row = _pack(store, seq)
        assert row.pack == "ready" and row.rev == rev + 1
        assert notifier_a.publishes + notifier_b.publishes == 1

    def test_two_processes_starting_a_run_for_one_round_keep_exactly_one(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path, db_path: Path
    ) -> None:
        seq = _chosen(store, bank)
        other_store = LiveChatStore(db_path)
        researcher = FakeResearcher([FakeRunPlan(statuses=["running", "running", "completed"])] * 2)
        a = _runner(store, bank, researcher, tmp_path)
        b = _runner(other_store, bank, researcher, tmp_path)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(a.run_job, seq)
                tg.start_soon(b.run_job, seq)

        anyio.run(go)
        row = _pack(store, seq)
        assert row.pack == "ready"
        # Both may have asked cmd for a run, but only one is recorded; the loser cancels its own.
        assert len(researcher.started) in (1, 2)
        assert row.pack_run_id in {"fake-run-1", "fake-run-2"}
        if len(researcher.started) == 2:
            assert researcher.cancelled and row.pack_run_id not in researcher.cancelled


class TestPacing:
    def _five_chosen(self, store: LiveChatStore, bank: AdventureBank) -> list[int]:
        picks = [
            ("AAA", "AAA.one"),
            ("AAA", "AAA.two"),
            ("BBB", "BBB.one"),
            ("EEE", "EEE.one"),
            ("CCC", None),
        ]
        return [
            _chosen(store, bank, f"adv-pace-round-{n:02d}", unit, dest)
            for n, (unit, dest) in enumerate(picks)
        ]

    def test_at_most_two_runs_are_in_flight(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seqs = self._five_chosen(store, bank)
        researcher = FakeResearcher(
            [FakeRunPlan(statuses=["running"] * 4 + ["completed"]) for _ in seqs]
        )
        runner = _runner(store, bank, researcher, tmp_path)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                for seq in seqs:
                    tg.start_soon(runner.run_job, seq)

        anyio.run(go)
        assert all(_pack(store, seq).pack == "ready" for seq in seqs)
        assert len(researcher.started) == 5
        assert researcher.max_in_flight == 2

    def test_spawns_are_spaced(
        self, store: LiveChatStore, bank: AdventureBank, tmp_path: Path
    ) -> None:
        seqs = self._five_chosen(store, bank)[:3]
        researcher = FakeResearcher()
        timing = PackTiming(
            poll_interval_s=0.01, spawn_gap_s=0.2, give_up_s=30.0, early_retry_s=0.0
        )
        runner = _runner(store, bank, researcher, tmp_path, timing)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                for seq in seqs:
                    tg.start_soon(runner.run_job, seq)

        anyio.run(go)
        times = researcher.start_times
        assert len(times) == 3
        assert all(
            later - earlier >= 0.18 for earlier, later in zip(times, times[1:], strict=False)
        )

    def test_the_default_pacing_is_the_specs(self) -> None:
        timing = PackTiming()
        assert (timing.poll_interval_s, timing.spawn_gap_s) == (10.0, 5.0)
        assert timing.give_up_s == 25 * 60 and timing.early_retry_s == 150.0
        assert timing.concurrency == 2


# -- through the whole app -----------------------------------------------------------------


class TestAppStartup:
    def _seed(self, storage_root: Path, bank: AdventureBank, *, run_id: str | None) -> int:
        store = LiveChatStore(project_paths(storage_root, "test").server_db)
        seq = start_round(store, "adv-startup-seed-1")
        to_chosen(store, bank, seq)
        if run_id is not None:
            store.set_adventure_pack_run(anchor_seq=seq, run_id=run_id)
        return seq

    def test_startup_resumes_a_pending_pack_with_a_recorded_run(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        seq = self._seed(storage_root, fixture_bank(), run_id="run-before-restart")
        researcher = FakeResearcher()
        researcher.adopt("run-before-restart")
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, researcher=researcher) as (
            client,
            h,
        ):
            view = wait_for_pack(client, h, seq, "ready")
            assert view["pack"]["data"]["headline"] == CANNED_ADVENTURE_PACK["headline"]
            assert researcher.started == []

    def test_startup_starts_a_run_for_a_pending_pack_that_never_got_one(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        seq = self._seed(storage_root, fixture_bank(), run_id=None)
        researcher = FakeResearcher()
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, researcher=researcher) as (
            client,
            h,
        ):
            wait_for_pack(client, h, seq, "ready")
            assert len(researcher.started) == 1
            assert get_view(client, h, seq)["pack"]["canRetry"] is False

    def test_startup_without_a_researcher_marks_a_pending_pack_unavailable(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        seq = self._seed(storage_root, fixture_bank(), run_id="whatever")
        monkeypatch.setenv("WIXY_EDITION", "standalone")
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, no_researcher=True) as (
            client,
            h,
        ):
            view = get_view(client, h, seq)
            assert view["pack"]["state"] == "unavailable"

    def test_the_default_researcher_really_goes_through_cmdchat_and_a_refusal_fails_the_pack(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """No researcher injected: the fleet default (`CmdAdventureResearcher` over a
        `CmdChatClient`) runs for real. The suite's conftest points that client at a transport
        that answers 404, so cmd "refuses" the run and nothing leaves the process."""
        from unittest.mock import AsyncMock

        from fastapi.testclient import TestClient

        from wixy_server.app import create_app
        from wixy_server.tests.adventure_testkit import (
            BASE,
            create_round,
            route_to_chosen,
        )
        from wixy_server.tests.test_livechat_view_once import (
            TEST_PIN,
            UNLOCK_GUARD_HEADERS,
            _form_style_json,
        )

        app = create_app(
            storage_root=storage_root,
            wixy_repo_root=wixy_repo_root,
            pin_verifier=pin_verifier,
            transcriber=AsyncMock(),
            adventure_bank=fixture_bank(),
            adventure_pack_timing=FAST,
        )
        with TestClient(app, cookies={"CF_Authorization": "dummy"}) as client:
            token = client.post(
                f"{BASE}/unlock",
                content=_form_style_json(TEST_PIN),
                headers={**UNLOCK_GUARD_HEADERS, "Sec-Fetch-Site": "same-origin"},
            ).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            seq = create_round(client, headers).json()["message"]["seq"]
            route_to_chosen(client, headers, seq)
            failed = wait_for_pack(client, headers, seq, "failed")
            assert failed["pack"]["canRetry"] is True

    def test_the_default_researcher_is_cmd_backed_on_the_fleet_and_absent_on_standalone(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from unittest.mock import AsyncMock

        from wixy_server.app import create_app

        fleet = create_app(
            storage_root=storage_root,
            wixy_repo_root=wixy_repo_root,
            pin_verifier=pin_verifier,
            transcriber=AsyncMock(),
        )
        assert fleet.state.livechat_adventure_runner.available is True
        monkeypatch.setenv("WIXY_EDITION", "standalone")
        standalone = create_app(
            storage_root=storage_root,
            wixy_repo_root=wixy_repo_root,
            pin_verifier=pin_verifier,
            transcriber=AsyncMock(),
        )
        assert standalone.state.livechat_adventure_runner.available is False
