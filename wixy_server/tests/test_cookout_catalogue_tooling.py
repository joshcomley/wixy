"""The catalogue builder and the shared cmd run pool (tooling/cookout/visual), driven by a fake cmd
client: no network, no model. Spec/server-chat/09b §A.3, §A.4, §F.1."""

from __future__ import annotations

import asyncio
import importlib
import json
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from wixy_server.cmdchat import ChatSpawnRun, CmdChatError

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

cmdruns: Any = importlib.import_module("tooling.cookout.visual.cmdruns")
cat: Any = importlib.import_module("tooling.cookout.visual.catalogue")
vc: Any = importlib.import_module("tooling.cookout.visual.validate_catalogue")

BANK = vc.load_bank_items()
LINES = re.compile(r"^(\{.*\})$", re.MULTILINE)


class FakeClient:
    """Answers every run immediately from `handler(kwargs) -> text`."""

    def __init__(self, handler: Callable[[dict[str, Any]], str]) -> None:
        self.handler = handler
        self.spawned: list[dict[str, Any]] = []
        self.texts: dict[str, str] = {}
        self.cancelled: list[str] = []
        self.polls: dict[str, int] = {}
        self.never_finish = False

    async def spawn_run(self, **kwargs: Any) -> ChatSpawnRun:
        run_id = f"run-{len(self.spawned)}"
        self.spawned.append(kwargs)
        self.texts[run_id] = self.handler(kwargs)
        return ChatSpawnRun(run_id, "queued", None, None)

    async def get_run(self, run_id: str) -> ChatSpawnRun:
        self.polls[run_id] = self.polls.get(run_id, 0) + 1
        if self.never_finish:
            return ChatSpawnRun(run_id, "running", None, None)
        return ChatSpawnRun(run_id, "completed", self.texts[run_id], None)

    async def cancel_run(self, run_id: str) -> None:
        self.cancelled.append(run_id)


async def _no_sleep(_: float) -> None:
    return None


def prompt_records(prompt: str) -> list[dict[str, Any]]:
    tail = prompt.split("one JSON object per line):", 1)[1]
    return [json.loads(m) for m in LINES.findall(tail)]


def author_item(record: dict[str, Any], **override: Any) -> dict[str, Any]:
    name = record["name"]
    item: dict[str, Any] = {
        "id": record["id"],
        "what": "A common ingredient used in many home kitchens.",
        "visual": f"one plain serving of {name.lower()}, shown whole on its own, true colour",
        "presentation": "bowl",
        "facts": [
            f"People have cooked with {name.lower()} in many different countries for centuries.",
            f"The name {name.lower()} is familiar in kitchens across the English-speaking world.",
        ],
        "concern": None,
    }
    item.update(override)
    return item


def good_handler(kwargs: dict[str, Any]) -> str:
    prompt: str = kwargs["prompt"]
    if "fact-checker" in prompt:
        items = [
            {
                "id": r["id"],
                "facts": [
                    {"index": f["index"], "verdict": "true", "reason": "Fine."} for f in r["facts"]
                ],
            }
            for r in prompt_records(prompt)
        ]
        return json.dumps({"items": items})
    return json.dumps({"items": [author_item(r) for r in prompt_records(prompt)]})


def make_builder(tmp_path: Path, client: FakeClient, **pool_kwargs: Any) -> Any:
    journal = cmdruns.Journal(tmp_path / "work" / "catalogue" / "journal.jsonl")
    pool = cmdruns.RunPool(
        client=client, journal=journal, spawn_gap_s=0, poll_s=0, sleep=_no_sleep, **pool_kwargs
    )
    return cat.Builder(
        pool=pool,
        bank=BANK,
        committed_path=tmp_path / "catalogue.json",
        work_dir=tmp_path / "work",
        waivers_path=tmp_path / "waivers.json",
        log=lambda _: None,
    )


def run(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------- small pieces


def test_parse_json_object() -> None:
    assert cat.parse_json_object('{"a": 1}')[0] == {"a": 1}
    assert cat.parse_json_object('```json\n{"a": 1}\n```')[0] == {"a": 1}
    for bad in ("", 'Sure! {"a": 1}', "[1]", "{nope"):
        data, error = cat.parse_json_object(bad)
        assert data is None and error


def test_interleave_makes_every_prefix_stratified() -> None:
    by_category: dict[str, list[str]] = {}
    for item in BANK.values():
        by_category.setdefault(item.category, []).append(item.id)
    order = cat.interleave(by_category)
    assert len(order) == len(BANK)
    first = {BANK[i].category for i in order[:15]}
    assert len(first) == 15
    assert order == cat.interleave(by_category)  # deterministic


def test_batches_are_twenty_and_mixed(tmp_path: Path) -> None:
    builder = make_builder(tmp_path, FakeClient(good_handler))
    batches = builder.plan("author", "author", None, None)
    assert all(len(b) == 20 for b in batches[:-1])
    assert sum(map(len, batches)) == 3494
    assert len({BANK[i].category for i in batches[0]}) >= 15  # 16th = the three seasonings


def test_parse_author_reports_each_problem_and_missing_ids() -> None:
    batch = [BANK["andouille-sausage"], BANK["butter"]]
    names = vc.ingredient_names(BANK)
    good = author_item({"id": "andouille-sausage", "name": "Andouille sausage"})
    bad = author_item({"id": "butter", "name": "Butter"}, presentation="pile")
    accepted, problems = cat.parse_author({"items": [good, bad]}, batch, names, 1)
    assert set(accepted) == {"andouille-sausage"}
    assert "unknown presentation" in problems["butter"]
    accepted, problems = cat.parse_author({"items": [good]}, batch, names, 1)
    assert "no item" in problems["butter"]
    accepted, problems = cat.parse_author({"nope": 1}, batch, names, 1)
    assert set(problems) == {"andouille-sausage", "butter"}
    extra = {**good, "colour": "red"}
    assert (
        "keys must be"
        in cat.parse_author({"items": [extra]}, batch, names, 1)[1]["andouille-sausage"]
    )


def test_parse_check_requires_every_index_once() -> None:
    batch = {"butter": ["one", "two"]}
    ok = {"items": [{"id": "butter", "facts": [
        {"index": 0, "verdict": "true", "reason": "r"},
        {"index": 1, "verdict": "false", "reason": "r"},
    ]}]}  # fmt: skip
    accepted, problems = cat.parse_check(ok, batch)
    assert accepted["butter"] == [("true", "r"), ("false", "r")] and not problems
    short = {"items": [{"id": "butter", "facts": [{"index": 0, "verdict": "true", "reason": "r"}]}]}
    assert "butter" in cat.parse_check(short, batch)[1]
    odd = {"items": [{"id": "butter", "facts": [
        {"index": 0, "verdict": "maybe", "reason": "r"},
        {"index": 1, "verdict": "true", "reason": "r"},
    ]}]}  # fmt: skip
    assert "butter" in cat.parse_check(odd, batch)[1]


# ---------------------------------------------------------------- the run pool


def test_pool_paces_spawns_and_resumes_a_journalled_run(tmp_path: Path) -> None:
    client = FakeClient(lambda kw: "answer")
    journal = cmdruns.Journal(tmp_path / "j.jsonl")
    sleeps: list[float] = []

    async def record_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    pool = cmdruns.RunPool(
        client=client,
        journal=journal,
        spawn_gap_s=5,
        poll_s=0,
        sleep=record_sleep,
        now=lambda: 1000.0,
    )
    spec = cmdruns.RunSpec("c", "p", cmdruns.HAIKU, "medium", "D:/x", 900, tool_profile="judge")
    out = run(pool.run("b1", "author", ["a"], spec))
    assert out.ok and out.text == "answer" and not out.resumed
    assert client.spawned[0]["provider"] == "claude"
    assert client.spawned[0]["tool_profile"] == "judge"
    run(pool.run("b2", "author", ["b"], spec))
    assert sleeps == [5]  # the second spawn waited out the gap

    # a crash after the spawn was journalled: a fresh pool polls the same run, never a second spawn
    journal.append(
        {
            "batch": "b3",
            "pass": "author",
            "ids": ["c"],
            "run_id": "run-0",
            "status": "spawned",
            "at": 1,
        }
    )
    before = len(client.spawned)
    fresh = cmdruns.RunPool(
        client=client, journal=journal, spawn_gap_s=0, poll_s=0, sleep=_no_sleep
    )
    out = run(fresh.run("b3", "author", ["c"], spec))
    assert out.resumed and out.run_id == "run-0"
    assert len(client.spawned) == before


def test_pool_caps_in_flight_runs_per_provider(tmp_path: Path) -> None:
    active = 0
    peak = 0

    class SlowClient(FakeClient):
        async def get_run(self, run_id: str) -> ChatSpawnRun:
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            active -= 1
            return await super().get_run(run_id)

    client = SlowClient(lambda kw: "x")
    pool = cmdruns.RunPool(
        client=client,
        journal=cmdruns.Journal(tmp_path / "j.jsonl"),
        spawn_gap_s=0,
        poll_s=0,
        sleep=_no_sleep,
    )
    spec = cmdruns.RunSpec("c", "p", cmdruns.HAIKU, "medium", "D:/x", 900)

    async def go() -> None:
        await asyncio.gather(*(pool.run(f"b{i}", "p", [str(i)], spec) for i in range(10)))

    run(go())
    assert peak <= 3 and len(client.spawned) == 10


def test_pool_cancels_a_run_past_its_deadline(tmp_path: Path) -> None:
    client = FakeClient(lambda kw: "x")
    client.never_finish = True
    ticks = iter(range(0, 100000, 400))
    pool = cmdruns.RunPool(
        client=client,
        journal=cmdruns.Journal(tmp_path / "j.jsonl"),
        spawn_gap_s=0,
        poll_s=0,
        sleep=_no_sleep,
        now=lambda: float(next(ticks)),
    )
    spec = cmdruns.RunSpec("c", "p", cmdruns.HAIKU, "medium", "D:/x", 900)
    out = run(pool.run("b", "p", ["a"], spec))
    assert out.status == "timeout" and client.cancelled == ["run-0"]


def test_pool_survives_spawn_refusal(tmp_path: Path) -> None:
    class Refusing(FakeClient):
        async def spawn_run(self, **kwargs: Any) -> ChatSpawnRun:
            raise CmdChatError("no")

    pool = cmdruns.RunPool(
        client=Refusing(lambda kw: ""),
        journal=cmdruns.Journal(tmp_path / "j.jsonl"),
        spawn_gap_s=0,
        poll_s=0,
        sleep=_no_sleep,
    )
    spec = cmdruns.RunSpec("c", "p", cmdruns.HAIKU, "medium", "D:/x", 900)
    out = run(pool.run("b", "p", ["a"], spec))
    assert out.status == "spawn-failed" and not out.ok


# ---------------------------------------------------------------- the builder end to end


def test_build_writes_a_valid_partial_catalogue_and_resumes(tmp_path: Path) -> None:
    client = FakeClient(good_handler)
    builder = make_builder(tmp_path, client)
    run(builder.build(limit=25))
    committed = json.loads((tmp_path / "catalogue.json").read_text(encoding="utf-8"))
    assert len(committed["items"]) == 25
    assert (
        vc.validate(
            tmp_path / "catalogue.json", allow_partial=True, waivers_path=tmp_path / "waivers.json"
        )
        == []
    )
    assert all(e["source"]["author"] == "claude-haiku-5-5" for e in committed["items"].values())
    spawned = len(client.spawned)
    assert spawned == 4  # 2 author batches (20 + 5) + 2 fact-check batches

    # a second builder over the same files has nothing left to do for those ids
    again = make_builder(tmp_path, client)
    assert again.counts()["done"] == 25
    before = (tmp_path / "catalogue.json").read_text(encoding="utf-8")
    run(again.build(limit=5))  # the NEXT five ingredients; the first 25 are not asked again
    assert again.counts()["done"] == 30
    after = json.loads((tmp_path / "catalogue.json").read_text(encoding="utf-8"))["items"]
    assert all(after[i] == json.loads(before)["items"][i] for i in json.loads(before)["items"])


def test_author_runs_use_haiku_with_no_tools_and_checks_get_web_tools(tmp_path: Path) -> None:
    client = FakeClient(good_handler)
    run(make_builder(tmp_path, client).build(limit=3))
    author, check = client.spawned[0], client.spawned[1]
    assert author["model"] == "claude-haiku-5-5" and author["tool_profile"] == "judge"
    assert author["effort"] == "medium" and author["timeout_secs"] == 900
    assert check["effort"] == "high" and check["timeout_secs"] == 1200
    assert "WebSearch" not in check["disallowed_tools"] and "Write" in check["disallowed_tools"]
    assert "tool_profile" not in check or check["tool_profile"] is None


def test_dropped_facts_send_the_entry_back_for_a_second_author_round(tmp_path: Path) -> None:
    seen_do_not_repeat: list[list[str]] = []

    def handler(kwargs: dict[str, Any]) -> str:
        prompt: str = kwargs["prompt"]
        if "fact-checker" in prompt:
            items = []
            for record in prompt_records(prompt):
                verdict = "false" if "centuries" in record["facts"][0]["text"] else "true"
                items.append(
                    {
                        "id": record["id"],
                        "facts": [
                            {"index": f["index"], "verdict": verdict, "reason": "r"}
                            for f in record["facts"]
                        ],
                    }
                )
            return json.dumps({"items": items})
        items = []
        for record in prompt_records(prompt):
            if "do_not_repeat" in record:
                seen_do_not_repeat.append(record["do_not_repeat"])
                items.append(
                    author_item(
                        record,
                        facts=[
                            f"{record['name']} appears in old cookbooks from long ago.",
                            f"Cooks in many regions give {record['name'].lower()} a local name.",
                        ],
                    )
                )
            else:
                items.append(author_item(record))
        return json.dumps({"items": items})

    client = FakeClient(handler)
    builder = make_builder(tmp_path, client)
    run(builder.build(limit=2))
    assert seen_do_not_repeat and all(len(x) == 2 for x in seen_do_not_repeat)
    committed = json.loads((tmp_path / "catalogue.json").read_text(encoding="utf-8"))
    assert len(committed["items"]) == 2
    assert all(len(e["facts"]) == 2 for e in committed["items"].values())
    assert builder.counts()["done"] == 2


def test_a_fact_that_never_survives_is_waived_after_two_rounds(tmp_path: Path) -> None:
    def handler(kwargs: dict[str, Any]) -> str:
        prompt: str = kwargs["prompt"]
        if "fact-checker" in prompt:
            return json.dumps(
                {
                    "items": [
                        {
                            "id": r["id"],
                            "facts": [
                                {"index": f["index"], "verdict": "doubtful", "reason": "r"}
                                for f in r["facts"]
                            ],
                        }
                        for r in prompt_records(prompt)
                    ]
                }
            )
        return good_handler(kwargs)

    builder = make_builder(tmp_path, FakeClient(handler))
    run(builder.build(limit=1))
    waivers = json.loads((tmp_path / "waivers.json").read_text(encoding="utf-8"))
    assert len(waivers) == 1
    committed = json.loads((tmp_path / "catalogue.json").read_text(encoding="utf-8"))
    (entry,) = committed["items"].values()
    assert entry["facts"] == []
    assert (
        vc.validate(
            tmp_path / "catalogue.json", allow_partial=True, waivers_path=tmp_path / "waivers.json"
        )
        == []
    )


def test_an_id_that_keeps_failing_is_marked_failed(tmp_path: Path) -> None:
    def handler(kwargs: dict[str, Any]) -> str:
        return "this is not json"

    builder = make_builder(tmp_path, FakeClient(handler))
    run(builder.build(limit=2))
    assert len(builder.failed()) == 2
    assert builder.counts()["failed"] == 2


def test_a_parse_failure_is_retried_once_with_the_error_quoted(tmp_path: Path) -> None:
    replies = {"count": 0}

    def handler(kwargs: dict[str, Any]) -> str:
        if "fact-checker" not in kwargs["prompt"]:
            replies["count"] += 1
            if replies["count"] == 1:
                return "Here you go: not json"
        return good_handler(kwargs)

    client = FakeClient(handler)
    builder = make_builder(tmp_path, client)
    run(builder.author(limit=2))
    assert "could not be used" in client.spawned[1]["prompt"]
    assert builder.counts()["check"] == 2


def test_audit_requeues_failing_categories_and_records_the_result(tmp_path: Path) -> None:
    client = FakeClient(good_handler)
    builder = make_builder(tmp_path, client)
    run(builder.build(limit=40))

    def audit_handler(kwargs: dict[str, Any]) -> str:
        records = prompt_records(kwargs["prompt"])
        return json.dumps(
            {
                "items": [
                    {
                        "n": r["n"],
                        "verdict": "not_upheld" if r["n"] == 0 else "upheld",
                        "reason": "x",
                    }
                    for r in records
                ]
            }
        )

    client.handler = audit_handler
    outcome = run(builder.audit(seed=7))
    assert outcome["judged"] == outcome["sampled"] == 40 * 2
    assert not outcome["passed"] and outcome["upheld"] < outcome["bar"] + 1
    assert list((tmp_path / "work" / "catalogue").glob("audit-1.json"))
    assert builder.counts()["check"] > 0  # the failing categories are back in the fact-check queue
    assert builder._load_examples()


def test_audit_passes_when_enough_facts_hold(tmp_path: Path) -> None:
    client = FakeClient(good_handler)
    builder = make_builder(tmp_path, client)
    run(builder.build(limit=100))

    def all_upheld(kwargs: dict[str, Any]) -> str:
        records = prompt_records(kwargs["prompt"])
        return json.dumps(
            {"items": [{"n": r["n"], "verdict": "upheld", "reason": "x"} for r in records]}
        )

    client.handler = all_upheld
    outcome = run(builder.audit(seed=1))
    assert outcome["sampled"] == 150 and outcome["passed"]
    assert builder.counts()["check"] == 0


def test_set_visual_validates_and_records_who(tmp_path: Path) -> None:
    run(make_builder(tmp_path, FakeClient(good_handler)).build(limit=1))
    path = tmp_path / "catalogue.json"
    (item_id,) = json.loads(path.read_text(encoding="utf-8"))["items"]
    cat.set_visual(
        path,
        item_id,
        "one plain serving shown whole on its own on the plain background, true colour",
        "claude-haiku-5-5",
        now=5,
    )
    entry = json.loads(path.read_text(encoding="utf-8"))["items"][item_id]
    assert entry["source"]["visualBy"] == "claude-haiku-5-5" and entry["source"]["visualAt"] == 5
    with pytest.raises(ValueError, match="forbidden word"):
        cat.set_visual(path, item_id, "a plain serving held in a hand on the plain background", "x")


def test_report_opens_with_the_answer(tmp_path: Path) -> None:
    builder = make_builder(tmp_path, FakeClient(good_handler))
    run(builder.build(limit=5))
    text = cat.report_markdown(builder, [], builder.pool.journal)
    assert text.startswith("# Cookout ingredient catalogue: build report")
    assert "5 of 3494 ingredients have a finished catalogue entry" in text
    assert "The Sol fact audit has not been run yet." in text
