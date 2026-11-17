"""Cookout picture tooling (spec/server-chat/09b §B-§C): parsers, decoys, gate, ladder,
calibration scoring, review, pack building. Fakes only: no network, GPU or model."""

from __future__ import annotations

import asyncio
import importlib
import json
import random
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from wixy_server.livechat import cookout_pack as cp

TOOLING = Path(__file__).resolve().parents[2] / "tooling" / "cookout" / "visual"


@pytest.fixture(scope="module")
def mods() -> Iterator[dict[str, ModuleType]]:
    sys.path.insert(0, str(TOOLING))
    try:
        yield {
            name: importlib.import_module(name)
            for name in ("calibrate", "check", "images", "prompts", "review")
        }
    finally:
        sys.path.remove(str(TOOLING))


def _vjson(rows: list[tuple[str, str, list[str], str]]) -> str:
    return json.dumps(
        {
            "items": [
                {
                    "image": n,
                    "seen": "a thing on a pale background",
                    "verdict": v,
                    "problems": p,
                    "reason": r,
                }
                for n, v, p, r in rows
            ]
        }
    )


# --- verdict parser --------------------------------------------------------------------------


def test_verdict_parser_accepts_schema_and_fence(mods: dict[str, ModuleType]) -> None:
    c = mods["check"]
    text = _vjson(
        [("01", "correct", [], ""), ("02", "wrong", ["wrong_food"], "This is a lemon, not lime.")]
    )
    assert [v.verdict for v in c.parse_verdicts(text, ["01", "02"])] == ["correct", "wrong"]
    assert len(c.parse_verdicts(f"```json\n{text}\n```", ["01", "02"])) == 2


@pytest.mark.parametrize(
    "rows",
    [
        [("01", "correct", ["other"], "")],  # correct with a problem
        [("01", "correct", [], "fine")],  # correct with a reason
        [("01", "wrong", [], "Not the right thing at all.")],  # wrong without a problem
        [("01", "wrong", ["wrong_food"], "short")],  # reason too short
        [("01", "unclear", [], "")],  # unclear without a reason
        [("01", "wrong", ["nonsense"], "A long enough reason.")],  # unknown problem
        [("01", "maybe", [], "")],  # unknown verdict
        [("09", "correct", [], "")],  # unknown image
        [("01", "correct", [], ""), ("01", "correct", [], "")],  # duplicate
    ],
)
def test_verdict_parser_rejects(mods: dict[str, ModuleType], rows: list[object]) -> None:
    c = mods["check"]
    with pytest.raises(c.VerdictError):
        c.parse_verdicts(_vjson(rows), ["01", "02"])  # type: ignore[arg-type]


def test_verdict_parser_rejects_missing_extra_text_and_keys(mods: dict[str, ModuleType]) -> None:
    c = mods["check"]
    good = _vjson([("01", "correct", [], "")])
    with pytest.raises(c.VerdictError, match="missing"):
        c.parse_verdicts(good, ["01", "02"])
    with pytest.raises(c.VerdictError):
        c.parse_verdicts("Sure! " + good, ["01"])
    with pytest.raises(c.VerdictError):
        c.parse_verdicts(json.dumps({"items": [], "extra": 1}), [])
    short = json.loads(good)
    short["items"][0]["seen"] = "x"
    with pytest.raises(c.VerdictError, match="seen"):
        c.parse_verdicts(json.dumps(short), ["01"])


# --- batches, decoys -------------------------------------------------------------------------


class FakeRunner:
    """Answers each run from a callable(prompt, cwd) -> text; records calls."""

    def __init__(self, answer) -> None:  # type: ignore[no-untyped-def]
        self.answer = answer
        self.calls: list[dict[str, object]] = []

    async def run(self, **kw: object) -> str:
        self.calls.append(kw)
        return self.answer(kw["prompt"], kw["cwd"])  # type: ignore[no-any-return]


def _images(c: ModuleType, tmp_path: Path, n: int) -> list[object]:
    out = []
    for i in range(n):
        p = tmp_path / f"src{i}.webp"
        p.write_bytes(b"img%d" % i)
        out.append(c.CheckImage(f"ing-{i}", f"Ingredient {i}", "what", "whole", p))
    return out


def _decoy(c: ModuleType, tmp_path: Path, tag: str = "d") -> object:
    p = tmp_path / f"{tag}.webp"
    p.write_bytes(b"decoy")
    return c.Decoy(p, "Pork belly", "Fatty cut", "cut")


def test_check_directory_has_neutral_names_and_random_decoy_slot(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    c = mods["check"]
    real = _images(c, tmp_path, 10)
    positions = set()
    for seed in range(12):
        b = c.build_batch(
            f"b{seed}", real, _decoy(c, tmp_path), tmp_path / "chk", random.Random(seed)
        )
        names = sorted(p.name for p in b.directory.iterdir())
        assert names == [f"{i:02d}.webp" for i in range(1, 12)]
        assert not any("ing-" in n or "Ingredient" in n for n in names)
        positions.add(b.decoy_number)
    assert len(positions) > 3


def test_decoy_caught_accepts_real_results(mods: dict[str, ModuleType], tmp_path: Path) -> None:
    c = mods["check"]
    real = _images(c, tmp_path, 3)

    def answer(prompt: str, cwd: Path) -> str:
        # the decoy line names Pork belly: mark it wrong, others correct
        rows = []
        for line in prompt.splitlines():
            if line.startswith("Image "):
                n = line.split()[1].rstrip(":")
                if "Pork belly" in line:
                    rows.append((n, "wrong", ["wrong_food"], "That is not pork belly at all."))
                else:
                    rows.append((n, "correct", [], ""))
        return _vjson(rows)

    runner = FakeRunner(answer)
    res = asyncio.run(
        c.check_images(
            runner,
            c.HAIKU,
            "t",
            real,
            lambda: _decoy(c, tmp_path),
            tmp_path / "k",
            random.Random(1),
        )
    )
    assert res.decoy_caught and not res.discarded
    assert set(res.verdicts) == {"ing-0", "ing-1", "ing-2"}
    assert runner.calls[0]["tool_profile"] == "replay_probe"
    assert runner.calls[0]["cwd"] != tmp_path


def test_decoy_marked_correct_discards_and_reruns_once(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    c = mods["check"]
    real = _images(c, tmp_path, 2)

    def always_correct(prompt: str, cwd: Path) -> str:
        n = [ln.split()[1].rstrip(":") for ln in prompt.splitlines() if ln.startswith("Image ")]
        return _vjson([(x, "correct", [], "") for x in n])

    runner = FakeRunner(always_correct)
    picks: list[int] = []

    def pick() -> object:
        picks.append(1)
        return _decoy(c, tmp_path, f"d{len(picks)}")

    res = asyncio.run(
        c.check_images(runner, c.HAIKU, "t", real, pick, tmp_path / "k", random.Random(1))
    )
    assert res.discarded and res.verdicts == {} and res.decoy_caught is False
    assert len(runner.calls) == 2 and len(picks) == 2  # one re-run, with a fresh decoy


def test_parse_failure_retries_once_quoting_error(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    c = mods["check"]
    seen: list[str] = []

    def answer(prompt: str, cwd: Path) -> str:
        seen.append(prompt)
        if len(seen) == 1:
            return "not json"
        n = [ln.split()[1].rstrip(":") for ln in prompt.splitlines() if ln.startswith("Image ")]
        return _vjson([(x, "wrong", ["wrong_food"], "Marked wrong for the test.") for x in n])

    b = c.build_batch("x", _images(c, tmp_path, 2), None, tmp_path / "k", random.Random(0))
    out = asyncio.run(c.run_batch(FakeRunner(answer), c.HAIKU, b))
    assert len(out) == 2 and "could not be accepted" in seen[1]
    with pytest.raises(c.VerdictError):
        asyncio.run(c.run_batch(FakeRunner(lambda p, d: "still not json"), c.HAIKU, b))


def test_outcomes_and_vision_proof(mods: dict[str, ModuleType], tmp_path: Path) -> None:
    c = mods["check"]
    assert [c.classify(v) for v in ("correct", "wrong", "unclear")] == [
        "accepted",
        "regenerate",
        "tiebreak",
    ]
    right = _images(c, tmp_path, 2)
    decoys = [_decoy(c, tmp_path, "p1"), _decoy(c, tmp_path, "p2")]

    def perfect(prompt: str, cwd: Path) -> str:
        rows = []
        for ln in prompt.splitlines():
            if ln.startswith("Image "):
                n = ln.split()[1].rstrip(":")
                bad = "Pork belly" in ln
                rows.append(
                    (n, "wrong", ["wrong_food"], "Not what the label says.")
                    if bad
                    else (n, "correct", [], "")
                )
        return _vjson(rows)

    asyncio.run(
        c.vision_proof(FakeRunner(perfect), c.LUNA, right, decoys, tmp_path / "k", random.Random(2))
    )
    blind = FakeRunner(
        lambda p, d: _vjson(
            [
                (ln.split()[1].rstrip(":"), "correct", [], "")
                for ln in p.splitlines()
                if ln.startswith("Image ")
            ]
        )
    )
    with pytest.raises(c.VisionProofFailed, match="luna"):
        asyncio.run(c.vision_proof(blind, c.LUNA, right, decoys, tmp_path / "k", random.Random(2)))


# --- the empty-queue gate and the ladder -----------------------------------------------------


def test_gate_needs_three_consecutive_idle_polls(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]
    seq: Iterator[dict[str, Any]] = iter(
        [{"queue_running": [1]}, {}, {}, {"queue_pending": [1]}, {}, {}, {}]
    )
    polls: list[int] = []

    def get() -> dict[str, object]:
        polls.append(1)
        return next(seq)

    sleeps: list[float] = []
    assert im.wait_for_idle(get, sleep=sleeps.append) is True
    assert len(polls) == 7 and all(s == 1.0 for s in sleeps)


def test_gate_never_submits_while_busy_and_honours_pause(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im = mods["images"]
    ticks = iter(range(1000))
    busy = {"queue_running": [1]}
    assert (
        im.wait_for_idle(
            lambda: busy, sleep=lambda _s: None, max_wait_s=5, clock=lambda: float(next(ticks))
        )
        is False
    )
    pause = tmp_path / "PAUSE"
    pause.write_text("")
    assert im.wait_for_idle(lambda: {}, pause_file=pause, sleep=lambda _s: None) is False


def test_memory_guard_waits_below_the_floor_and_then_goes(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]
    readings: Iterator[float | None] = iter([3.7, 12.0, 19.9, 20.0])
    sleeps: list[float] = []
    proceed, free = im.wait_for_memory(lambda: next(readings), sleep=sleeps.append)
    assert (proceed, free) == (True, 20.0)
    assert sleeps == [im.MEMORY_POLL_GAP_S] * 3


def test_memory_guard_unreadable_does_not_block_and_pause_wins(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im = mods["images"]
    assert im.wait_for_memory(lambda: None, sleep=lambda _s: None) == (True, None)
    pause = tmp_path / "PAUSE"
    pause.write_text("")
    assert im.wait_for_memory(lambda: 1.0, pause_file=pause, sleep=lambda _s: None) == (
        False,
        None,
    )


def test_pipeline_waits_for_memory_and_journals_it(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im, c = mods["images"], mods["check"]
    work = im.WorkDir(tmp_path / "work")
    subjects = {"a": im.Subject("a", "A", "c", "w", "v tokA", "whole")}
    readings: Iterator[float | None] = iter([4.0, 9.0, 31.5])
    slept: list[float] = []
    asyncio.run(
        im.run_pipeline(
            ["a"],
            subjects,
            work,
            FakeComfy({"a": 30}, {}),
            lambda: {},
            FakeJudge({"a": 30}, {"a": "A"}),
            c.HAIKU,
            c.HAIKU,
            c.SOL,
            c.OPUS,
            review_path=tmp_path / "r.json",
            sleep=slept.append,
            render_only=True,
            free_gb=lambda: next(readings, 31.5),
        )
    )
    entries = [json.loads(line) for line in work.journal.read_text("utf-8").splitlines()]
    rendered = [e for e in entries if e["state"] == "rendered"]
    assert len(rendered) == 1
    assert rendered[0]["memFreeGb"] == 31.5 and rendered[0]["voice"] == {}
    assert slept.count(im.MEMORY_POLL_GAP_S) == 2


def test_pipeline_rechecks_memory_after_the_idle_wait(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    """The idle wait can be long; if memory ran low meanwhile the render must not start on the old
    figure. Readings: fine, then low right after the idle wait, then fine again."""
    im, c = mods["images"], mods["check"]
    work = im.WorkDir(tmp_path / "work")
    subjects = {"a": im.Subject("a", "A", "c", "w", "v tokA", "whole")}
    readings = iter([31.0, 5.0, 33.0, 34.0])
    slept: list[float] = []
    asyncio.run(
        im.run_pipeline(
            ["a"],
            subjects,
            work,
            FakeComfy({"a": 30}, {}),
            lambda: {},
            FakeJudge({"a": 30}, {"a": "A"}),
            c.HAIKU,
            c.HAIKU,
            c.SOL,
            c.OPUS,
            review_path=tmp_path / "r.json",
            sleep=slept.append,
            render_only=True,
            free_gb=lambda: next(readings, 40.0),
        )
    )
    entries = [json.loads(x) for x in work.journal.read_text("utf-8").splitlines()]
    rendered = [e for e in entries if e["state"] == "rendered"]
    assert len(rendered) == 1 and rendered[0]["memFreeGb"] >= 20
    assert slept.count(im.GATE_POLL_GAP_S) == 4  # two idle waits of 3 polls (2 sleeps each)


def test_voice_probes_parse_and_summarise(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]
    assert im.voice_probes_from_env(None) == {}
    assert im.voice_probes_from_env("voice=http://h:1/x, util=http://h:2/y,junk") == {
        "voice": "http://h:1/x",
        "util": "http://h:2/y",
    }
    summary = im.summarise_latency({"voice": [10.0, None, 30.0, 20.0], "util": []})
    assert summary["voice"] == {"n": 4, "failed": 1, "medianMs": 20.0, "maxMs": 30.0}
    assert summary["util"] == {"n": 0, "failed": 0, "medianMs": None, "maxMs": None}


def test_queue_signatures_know_our_own_qwen_job(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]

    def job(client: str, field: str, text: str, cls: str) -> list[Any]:
        graph = {
            "11": {"class_type": cls, "inputs": {field: text}},
            "16": {"class_type": "SaveImage", "inputs": {"filename_prefix": "wyr_ab_a"}},
        }
        return [1, "id", graph, {"client_id": client}]

    qwen = job("c1", "prompt", "a pear", "TextEncodeQwenImage21")
    clip = job("c2", "text", "a dish", "CLIPTextEncode")
    queue = {"queue_running": [qwen], "queue_pending": [clip]}
    assert im.queue_signatures(queue, own_prompt="a pear") == ["pending|c2|a dish|wyr_"]
    assert len(im.queue_signatures(queue)) == 2


def test_probe_asks_the_loaded_model_for_one_token(mods: dict[str, ModuleType]) -> None:
    import http.server
    import threading

    im = mods["images"]
    seen: list[tuple[str, bytes]] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_a: object) -> None:
            pass

        def do_GET(self) -> None:  # noqa: N802
            seen.append((self.path, b""))
            body = b'{"models":[{"name":"voice-model"}]}' if self.path == "/api/ps" else b"{}"
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            seen.append((self.path, self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        ms = im.probe_ms(f"http://127.0.0.1:{server.server_address[1]}")
    finally:
        server.shutdown()
    assert ms is not None and ms >= 0
    posted = [json.loads(body) for path, body in seen if path == "/api/generate"]
    assert posted == [
        {"model": "voice-model", "prompt": "Hi", "stream": False, "options": {"num_predict": 1}}
    ]
    assert im.probe_ms("http://127.0.0.1:9", timeout_s=1.0) is None


def test_probe_embeds_when_only_an_embedding_model_is_loaded(
    mods: dict[str, ModuleType],
) -> None:
    import http.server
    import threading

    im = mods["images"]
    posted: list[tuple[str, dict[str, Any]]] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_a: object) -> None:
            pass

        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"models":[{"name":"nomic-embed-text:latest"}]}')

        def do_POST(self) -> None:  # noqa: N802
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            posted.append((self.path, json.loads(raw)))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        ms = im.probe_ms(f"http://127.0.0.1:{server.server_address[1]}")
    finally:
        server.shutdown()
    assert ms is not None
    assert posted == [("/api/embed", {"model": "nomic-embed-text:latest", "input": "Hi"})]


def test_latency_sampler_records_each_probe_until_stopped(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]

    async def go() -> dict[str, list[float | None]]:
        samples: dict[str, list[float | None]] = {}
        stop = asyncio.Event()
        calls: list[str] = []

        def probe(url: str) -> float | None:
            calls.append(url)
            if len(calls) >= 4:
                stop.set()
            return None if url.endswith("bad") else 5.0

        await im.sample_latency(
            {"voice": "http://h/ok", "util": "http://h/bad"}, samples, stop, probe=probe, gap_s=0.01
        )
        return samples

    samples = asyncio.run(go())
    assert samples["voice"][0] == 5.0 and samples["util"][0] is None


def test_attempt_ladder(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]
    assert [im.plan_attempt(n).rewrite_visual for n in range(1, 5)] == [False, False, True, False]
    assert [im.after_failure(n, reviewed=False) for n in range(1, 5)] == [
        "retry",
        "retry",
        "retry",
        "review",
    ]
    assert im.after_failure(5, reviewed=True) == "retry"
    assert im.after_failure(6, reviewed=True) == "pictureless"
    with pytest.raises(ValueError):
        im.plan_attempt(7)


def test_journal_resumes_and_skips_accepted(mods: dict[str, ModuleType], tmp_path: Path) -> None:
    im = mods["images"]
    j = tmp_path / "journal.jsonl"
    im.journal_append(j, {"id": "a", "state": "queued"})
    im.journal_append(j, {"id": "a", "state": "accepted"})
    im.journal_append(j, {"id": "b", "state": "rendered"})
    im.journal_append(j, {"id": "c", "state": "regenerate"})
    j.write_text(j.read_text("utf-8") + '{"id": "torn', encoding="utf-8")
    with pytest.raises(ValueError):
        im.journal_append(j, {"id": "z", "state": "bogus"})
    state = im.journal_state(j)
    assert im.pending_work(["a", "b", "c", "d"], state, lambda _i: False) == ["b", "c", "d"]
    assert im.pending_work(["b"], state, lambda _i: True) == ["b"]  # rendered still needs its check


def test_renditions_and_pack_roundtrip(mods: dict[str, ModuleType], tmp_path: Path) -> None:
    from PIL import Image

    im = mods["images"]
    png = tmp_path / "m.png"
    Image.new("RGB", (1024, 1024), (200, 30, 30)).save(png)
    master = tmp_path / "m.webp"
    im.encode_master(png, master)
    card, thumb = im.make_renditions(master)
    assert Image.open(__import__("io").BytesIO(card)).size == (512, 512)
    assert Image.open(__import__("io").BytesIO(thumb)).size == (160, 160)
    pics = [
        im.AcceptedPicture("tomato", card, thumb, 1, "claude-haiku-5-5"),
        im.AcceptedPicture("beet", card + b"x", thumb, 2, "sol-tiebreak"),
    ]
    tar = tmp_path / "pack.tar"
    manifest = im.build_pack(pics, tar, pack_version=1, url="https://example.invalid/p.tar")
    again = im.build_pack(
        pics, tmp_path / "p2.tar", pack_version=1, url="https://example.invalid/p.tar"
    )
    assert manifest == again  # deterministic
    mpath = tmp_path / "m.json"
    im.write_manifest(mpath, manifest)
    loaded = cp.load_manifest(mpath)  # every hard bound passes
    assert loaded.pack is not None and loaded.pack.objects == 3  # thumb shared
    store = cp.PackStore(tmp_path / "store", min_free_bytes=0)
    assert store.install(tar, loaded) == 3
    assert im.release_url("joshcomley/wixy", 1).endswith("/cookout-images-v1/cookout-images-v1.tar")


def test_history_check(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]
    ms = [{"pack": None}, {"pack": {"url": "u1", "bytes": 5}}, {"pack": {"url": "u2", "bytes": 7}}]
    assert im.history_check(ms, lambda u: {"u1": 5, "u2": 8}[u]) == [
        "u2: answers 8, manifest says 7"
    ]
    assert im.history_check(ms, lambda u: None)  # unreachable is a problem too


# --- calibration -----------------------------------------------------------------------------


def test_sampler_is_deterministic_and_splits_evenly(mods: dict[str, ModuleType]) -> None:
    cal = mods["calibrate"]
    ids = [f"i{n}" for n in range(600)]
    a1, b1 = cal.draw_sample(ids, 42)
    a2, b2 = cal.draw_sample(list(reversed(ids)), 42)
    assert (a1, b1) == (a2, b2) and len(a1) == len(b1) == 50
    assert not set(a1) & set(b1) and cal.draw_sample(ids, 43) != (a1, b1)
    with pytest.raises(ValueError):
        cal.draw_sample(ids[:50], 1)


def _score(
    cal: ModuleType,
    c: ModuleType,
    rows: Sequence[tuple[str, str, str | None, tuple[str, ...]]],
    decoys: tuple[int, int] = (5, 5),
) -> Any:
    """rows: (ident, checker verdict, truth verdict or None=unresolved, truth problems)."""
    verdicts, truths = {}, {}
    for ident, cv, tv, problems in rows:
        verdicts[ident] = c.Verdict("01", "something seen here", cv, (), "")
        truths[ident] = cal.Truth(tv is not None, tv, frozenset(problems))
    return cal.score_checker(
        "haiku", verdicts, truths, decoys_caught=decoys[0], decoys_total=decoys[1]
    )


def _fifty(cal: ModuleType, c: ModuleType, bad: Sequence[tuple[Any, ...]]) -> Any:
    rows: list[tuple[str, str, str | None, tuple[str, ...]]] = [
        (f"i{n}", "correct", "correct", ()) for n in range(50 - len(bad))
    ]
    rows += [(f"x{n}", spec[0], spec[1], spec[2]) for n, spec in enumerate(bad)]
    return _score(cal, c, rows)


def test_score_table(mods: dict[str, ModuleType]) -> None:
    cal = mods["calibrate"]
    T = cal.Truth
    f: frozenset[str] = frozenset()
    assert cal.score_one("correct", T(True, "correct", f)) == "right"
    assert cal.score_one("correct", T(True, "wrong", f)) == "false_accept"
    assert cal.score_one("correct", T(True, "unclear", f)) == "false_accept"
    assert cal.score_one("correct", T(False, None, f)) == "error_unresolved"
    assert cal.score_one("wrong", T(True, "correct", f)) == "false_reject"
    assert cal.score_one("wrong", T(True, "wrong", f)) == "right"
    assert cal.score_one("wrong", T(True, "unclear", f)) == "right"  # unclear truth: right
    assert cal.score_one("unclear", T(True, "wrong", f)) == "right"  # not an error
    assert cal.score_one("unclear", T(True, "correct", f)) == "false_reject"
    assert cal.score_one("unclear", T(False, None, f)) == "error_unresolved"


def test_recommendation_rule(mods: dict[str, ModuleType]) -> None:
    cal, c = mods["calibrate"], mods["check"]
    assert _fifty(cal, c, [("correct", "wrong", ())] * 0).qualifies
    two = _fifty(cal, c, [("wrong", "correct", ())] * 2)  # two false rejects: still qualifies
    assert two.errors == 2 and two.qualifies
    assert not _fifty(cal, c, [("wrong", "correct", ())] * 3).qualifies
    # all 50 unresolved
    allu = _score(cal, c, [(f"i{n}", "correct", None, ()) for n in range(50)])
    assert allu.errors == 50 and not allu.qualifies
    # 47 resolved and right + 3 unresolved
    three = _score(
        cal,
        c,
        [(f"i{n}", "correct", "correct", ()) for n in range(47)]
        + [(f"u{n}", "correct", None, ()) for n in range(3)],
    )
    assert three.errors == 3 and not three.qualifies
    # a `correct` on an unresolved image where one judge tagged wrong_food: not qualified
    wf = _score(
        cal,
        c,
        [(f"i{n}", "correct", "correct", ()) for n in range(49)]
        + [("u", "correct", None, ("wrong_food",))],
    )
    assert wf.wrong_food_false_accepts == 1 and not wf.qualifies
    # decoy missed
    missed = _score(cal, c, [(f"i{n}", "correct", "correct", ()) for n in range(50)], decoys=(4, 5))
    assert not missed.qualifies
    assert cal.recommend(_fifty(cal, c, []), missed) == "haiku"
    ok = _fifty(cal, c, [])
    assert cal.recommend(missed, ok) == "luna"
    assert cal.recommend(missed, missed) is None


def test_unclear_checker_on_wrong_truth_is_not_an_error(mods: dict[str, ModuleType]) -> None:
    cal, c = mods["calibrate"], mods["check"]
    s = _score(cal, c, [(f"i{n}", "unclear", "wrong", ("wrong_food",)) for n in range(50)])
    assert s.errors == 0 and s.right == 50 and s.qualifies


def test_latest_judge_problems_are_used(mods: dict[str, ModuleType]) -> None:
    cal = mods["calibrate"]
    F = cal.Final
    s2 = {"1": F("wrong", ("wrong_food",), "x" * 12)}
    s3 = {"1": F("wrong", ("distorted",), "y" * 12)}
    latest = cal.latest_finals(s2, s3)
    truth = cal.truth_for(latest["1"], F("wrong", ("other",), "z" * 12))
    assert truth.resolved and truth.problems == {"distorted", "other"}  # wrong_food gone
    assert cal.latest_finals(s2, None) == s2


def test_judge_final_parser(mods: dict[str, ModuleType]) -> None:
    cal, c = mods["calibrate"], mods["check"]
    ok = json.dumps(
        {
            "items": [
                {
                    "image": "01",
                    "checkerRight": True,
                    "finalVerdict": "wrong",
                    "finalProblems": ["wrong_food"],
                    "reason": "Looks like a lime.",
                }
            ]
        }
    )
    got = cal.parse_judge_final(ok, ["01"], with_checker_right=True)
    assert got["01"][0].verdict == "wrong" and got["01"][1] is True
    for bad in (
        {
            "image": "01",
            "checkerRight": True,
            "finalVerdict": "correct",
            "finalProblems": ["other"],
            "reason": "",
        },
        {
            "image": "01",
            "checkerRight": True,
            "finalVerdict": "wrong",
            "finalProblems": [],
            "reason": "No problems listed here.",
        },
        {
            "image": "01",
            "finalVerdict": "wrong",
            "finalProblems": ["other"],
            "reason": "Missing checkerRight.",
        },
    ):
        with pytest.raises(c.VerdictError):
            cal.parse_judge_final(json.dumps({"items": [bad]}), ["01"], with_checker_right=True)


def test_report_opens_with_the_answer(mods: dict[str, ModuleType]) -> None:
    cal, c = mods["calibrate"], mods["check"]
    h, lu = _fifty(cal, c, []), _fifty(cal, c, [("wrong", "correct", ())] * 2)
    h.label, lu.label = "haiku", "luna"
    text = cal.render_report(
        7,
        [h, lu],
        "haiku",
        ["Lime: checker said wrong."],
        {"total": 100, "blind": 97, "final": 100},
        {"haiku": {"sol": 50, "opus": 49}},
    )
    first = text.split("\n\n")[1]
    assert "Haiku got 50 of 50" in first and "using Haiku" in first
    assert "Random seed" in text and "Lime" in text
    assert "97 of 100 pictures before seeing any checker" in text
    assert "50 of 50 against Sol" in text and "| Checker said |" in text
    none = cal.render_report(7, [h, lu], None, [], {"total": 1, "blind": 1, "final": 1})
    assert "paused" in none


# --- review ---------------------------------------------------------------------------------


def test_review_parser_and_decisions(mods: dict[str, ModuleType], tmp_path: Path) -> None:
    rv, c = mods["review"], mods["check"]
    v = "A whole raw lime with a dimpled green skin, lying on a plain background."
    assert rv.parse_review(json.dumps({"choose": 2, "visual": None, "reason": "ok"}), 4).choose == 2
    assert (
        rv.parse_review(json.dumps({"choose": None, "visual": v, "reason": "retry"}), 4).visual == v
    )
    for bad in (
        {"choose": 5, "visual": None, "reason": "r"},
        {"choose": True, "visual": None, "reason": "r"},
        {"choose": None, "visual": None, "reason": "r"},
        {"choose": 1, "visual": v, "reason": "r"},
        {"choose": None, "visual": "short", "reason": "r"},
        {"choose": 1, "visual": None, "reason": " "},
    ):
        with pytest.raises(c.VerdictError):
            rv.parse_review(json.dumps(bad), 4)
    path = tmp_path / "image_review.json"
    rv.record_decision("lime", "pictureless", None, "never looked right", path)
    rv.record_decision("kale", "accepted", 3, "fine", path)
    decided = rv.load_decisions(path)
    assert rv.already_decided("lime", decided) and list(decided) == ["kale", "lime"]
    with pytest.raises(ValueError):
        rv.record_decision("x", "maybe", None, "r", path)


def test_committed_review_file_and_image_prompt(mods: dict[str, ModuleType]) -> None:
    rv, p = mods["review"], mods["prompts"]
    assert isinstance(rv.load_decisions(), dict)
    prompt = p.image_prompt("a whole lemon.")
    assert "lemon.." not in prompt and "a whole lemon." in prompt
    assert "no text, no logos, no watermark" in prompt and "warm off-white" in prompt
    assert p.prompt_hash(prompt) == p.prompt_hash(prompt) and len(p.prompt_hash(prompt)) == 16


# --- the whole pipeline with fakes ------------------------------------------------------------

_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]


class FakeComfy:
    """Writes a flat grey PNG whose level encodes WHICH ingredient it shows. `bad` maps an
    ingredient to how many of its first renders show the wrong thing."""

    def __init__(self, level_of: dict[str, int], bad: dict[str, int]) -> None:
        self.level_of, self.bad, self.renders = level_of, dict(bad), 0
        self.count: dict[str, int] = {}

    def generate_many(self, prompts: list[str], out_dir: Path, *, seeds: list[int]) -> list[Path]:
        import re

        from PIL import Image

        ident = re.search(r"tok(\w+)", prompts[0]).group(1)  # type: ignore[union-attr]
        self.count[ident] = self.count.get(ident, 0) + 1
        self.renders += 1
        shows = ident if self.count[ident] > self.bad.get(ident, 0) else "zzz"
        level = self.level_of.get(shows, 250)
        path = out_dir / f"wyr_{self.renders}.png"
        Image.new("RGB", (64, 64), (level, level, level)).save(path)
        return [path]


class FakeJudge:
    """Reads the picture's grey level to decide what it shows, then answers like a checker."""

    def __init__(
        self,
        level_of: dict[str, int],
        name_of: dict[str, str],
        sol_rejects: dict[str, int] | None = None,
    ) -> None:
        self.level_of, self.name_of = level_of, name_of
        self.opus_calls, self.rewrites = 0, 0
        # name -> how many times Sol still says "wrong" about a picture Haiku accepted
        self.sol_rejects = dict(sol_rejects or {})
        self.models_seen: list[str] = []

    async def run(self, **kw: Any) -> str:
        import re

        from PIL import Image

        prompt, cwd = str(kw["prompt"]), Path(str(kw["cwd"]))
        self.models_seen.append(str(kw.get("model")))
        if "text-to-image model keeps failing" in prompt:
            self.rewrites += 1
            ids = re.findall(r"^id: (\w+)$", prompt, re.M)
            return json.dumps(
                {
                    "items": [
                        {"id": i, "visual": f"a whole raw plain thing tok{i} on a pale surface"}
                        for i in ids
                    ]
                }
            )
        if "failed an automatic check" in prompt:
            self.opus_calls += 1
            return json.dumps(
                {
                    "choose": None,
                    "reason": "try again",
                    "visual": "a clearer whole raw thing tokzzz on a pale surface",
                }
            )
        rows = []
        for line in prompt.splitlines():
            m = re.match(r"Image (\d+): should show (\w+)", line)
            if not m:
                continue
            with Image.open(cwd / f"{m.group(1)}.webp") as im:
                level = im.convert("RGB").getpixel((5, 5))[0]
            shown = min(self.level_of, key=lambda k: abs(self.level_of[k] - level))
            ok = abs(self.level_of[shown] - level) < 20 and self.name_of[shown] == m.group(2)
            if ok and kw.get("model") == "gpt-6.1-sol" and self.sol_rejects.get(m.group(2), 0) > 0:
                self.sol_rejects[m.group(2)] -= 1
                ok = False
            rows.append(
                (m.group(1), "correct", [], "")
                if ok
                else (m.group(1), "wrong", ["wrong_food"], "That is not the right food.")
            )
        return _vjson(rows)


def _pipeline(
    tmp_path: Path,
    mods: dict[str, ModuleType],
    bad: dict[str, int],
    sol_rejects: dict[str, int] | None = None,
) -> tuple[Any, Any, Any, Any, dict[str, int]]:
    im, c = mods["images"], mods["check"]
    levels = {n.lower(): 30 * (i + 1) for i, n in enumerate(_NAMES)}
    subjects = {
        n.lower(): im.Subject(
            n.lower(),
            n,
            f"cat{i % 3}",
            f"A plain {n}.",
            f"one whole raw plain {n} tok{n.lower()}",
            "whole",
        )
        for i, n in enumerate(_NAMES)
    }
    work = im.WorkDir(tmp_path / "work")
    comfy = FakeComfy(levels, bad)
    judge = FakeJudge(levels, {k.lower(): s.name for k, s in subjects.items()}, sol_rejects)
    totals = asyncio.run(
        im.run_pipeline(
            sorted(subjects),
            subjects,
            work,
            comfy,
            lambda: {},
            judge,
            c.HAIKU,
            c.HAIKU,
            c.SOL,
            c.OPUS,
            chunk_size=3,
            review_path=tmp_path / "rev.json",
            rng=random.Random(4),
            sleep=lambda _s: None,
        )
    )
    return im, work, comfy, judge, totals


def test_pipeline_regenerates_a_failed_picture_then_accepts(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im, work, comfy, _judge, totals = _pipeline(tmp_path, mods, {"bravo": 1})
    assert totals["accepted"] == 6 and totals["pictureless"] == 0
    assert comfy.renders == 7  # six first attempts + one regeneration
    state = im.journal_state(work.journal)
    assert all(e["state"] == "accepted" for e in state.values())
    assert [a["attempt"] for a in work.read_attempts("bravo")] == [1, 2]
    pics = im.accepted_pictures(work)
    assert len(pics) == 6 and {p.ident for p in pics} == set(state)
    # a re-run does nothing: accepted ids are skipped
    again = _pipeline(tmp_path, mods, {})[4]
    assert again["rendered"] == 0


def test_sol_looks_again_at_every_haiku_accept_and_can_overrule_it(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    """Decision 2150: Haiku checks, then Sol re-checks every picture Haiku accepts."""
    im, work, comfy, judge, totals = _pipeline(tmp_path, mods, {}, sol_rejects={_NAMES[1]: 1})
    assert totals["accepted"] == 6 and totals["pictureless"] == 0
    # Sol said "wrong" about one picture Haiku had accepted: it was redrawn, then accepted
    bravo = _NAMES[1].lower()
    assert comfy.renders == 7
    assert [a["attempt"] for a in work.read_attempts(bravo)] == [1, 2]
    first, second = work.read_attempts(bravo)
    assert (first["verdict"], first["by"]) == ("wrong", "sol-recheck")
    assert (second["verdict"], second["by"]) == ("correct", "haiku+sol")
    # every accepted picture was accepted by both models, and Sol was asked
    accepted = [e for e in im.journal_state(work.journal).values() if e["state"] == "accepted"]
    assert len(accepted) == 6 and all(e["by"] == "haiku+sol" for e in accepted)
    assert "gpt-6.1-sol" in judge.models_seen and "claude-haiku-5-5" in judge.models_seen


def test_second_look_without_a_trusted_verdict_regenerates_never_accepts(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im, c = mods["images"], mods["check"]

    class Silent:
        async def run(self, **kw: Any) -> str:
            raise AssertionError("no model should be asked for an empty list")

    work = im.WorkDir(tmp_path / "work")
    assert (
        asyncio.run(
            im.second_look(Silent(), c.SOL, [], lambda: None, tmp_path, random.Random(1), "t")
        )
        == {}
    )
    assert work  # the empty case needs no decoy and no model


def test_pipeline_walks_the_ladder_to_opus_then_picture_less(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im, work, comfy, judge, totals = _pipeline(tmp_path, mods, {"echo": 99})
    assert totals["accepted"] == 5 and totals["pictureless"] == 1
    assert [a["attempt"] for a in work.read_attempts("echo")] == [1, 2, 3, 4, 5, 6]
    assert judge.rewrites >= 1 and judge.opus_calls == 1  # attempt-3 rewrite; one Opus review
    decided = json.loads((tmp_path / "rev.json").read_text("utf-8"))
    assert decided["echo"]["decision"] == "pictureless"
    assert im.journal_state(work.journal)["echo"].get("pictureless") is True
    assert "echo" not in {p.ident for p in im.accepted_pictures(work)}


def test_pipeline_pause_file_stops_between_pictures(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im, c = mods["images"], mods["check"]
    work = im.WorkDir(tmp_path / "work")
    work.pause.parent.mkdir(parents=True)
    work.pause.write_text("")
    subjects = {"a": im.Subject("a", "A", "c", "w", "v tokA", "whole")}
    totals = asyncio.run(
        im.run_pipeline(
            ["a"],
            subjects,
            work,
            FakeComfy({}, {}),
            lambda: {},
            FakeJudge({}, {}),
            c.HAIKU,
            c.HAIKU,
            c.SOL,
            c.OPUS,
            review_path=tmp_path / "r.json",
            sleep=lambda _s: None,
        )
    )
    assert totals["rendered"] == 0


def test_plan_pilot_is_stratified_and_seeded(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]
    cats = {f"c{c}-{n}": f"cat{c}" for c in range(15) for n in range(60)}
    plan = im.make_plan(cats, 7)
    assert plan == im.make_plan(cats, 7) and plan != im.make_plan(cats, 8)
    assert len(plan["pilot"]) == 600 and not set(plan["pilot"]) & set(plan["rest"])
    first15 = {cats[i] for i in plan["pilot"][:15]}
    assert len(first15) == 15  # any prefix is stratified


def test_html_report_is_standalone_and_lists_disagreements_first(
    mods: dict[str, ModuleType],
) -> None:
    cal = mods["calibrate"]
    page = cal.render_html(
        "T",
        "Haiku got 49 of 50 right.",
        [
            {"name": "Zed", "thumb": b"RIFFxxxx", "disagree": False},
            {"name": "Abe", "thumb": None, "disagree": True},
        ],
    )
    assert page.index("Abe") < page.index("Zed") and "data:image/webp;base64," in page
    assert "http://" not in page and "https://" not in page


def test_render_only_then_check_later(mods: dict[str, ModuleType], tmp_path: Path) -> None:
    im, c = mods["images"], mods["check"]
    levels = {n.lower(): 30 * (i + 1) for i, n in enumerate(_NAMES)}
    subjects = {
        n.lower(): im.Subject(
            n.lower(),
            n,
            f"cat{i % 3}",
            f"A plain {n}.",
            f"one whole raw plain {n} tok{n.lower()}",
            "whole",
        )
        for i, n in enumerate(_NAMES)
    }
    work = im.WorkDir(tmp_path / "work")
    comfy = FakeComfy(levels, {})
    judge = FakeJudge(levels, {k.lower(): s.name for k, s in subjects.items()})

    def go(render_only: bool) -> dict[str, int]:
        return asyncio.run(
            im.run_pipeline(
                sorted(subjects),
                subjects,
                work,
                comfy,
                lambda: {},
                judge,
                c.HAIKU,
                c.HAIKU,
                c.SOL,
                c.OPUS,
                chunk_size=3,
                review_path=tmp_path / "rev.json",
                rng=random.Random(4),
                sleep=lambda _s: None,
                render_only=render_only,
            )
        )

    first = go(True)
    assert first["rendered"] == 6 and first["accepted"] == 0 and not judge.rewrites
    assert all(e["state"] == "rendered" for e in im.journal_state(work.journal).values())
    second = go(False)  # no re-render: the existing pictures are simply checked
    assert second["rendered"] == 0 and second["accepted"] == 6 and comfy.renders == 6


def _tiny_setup(
    tmp_path: Path, mods: dict[str, ModuleType]
) -> tuple[Any, Any, Any, Any, dict[str, Any], Any, Any]:
    im, c = mods["images"], mods["check"]
    levels = {"alpha": 30}
    subjects = {
        "alpha": im.Subject("alpha", "Alpha", "c", "w", "one whole alpha tokalpha", "whole")
    }
    work = im.WorkDir(tmp_path / "work")
    work.images.mkdir(parents=True, exist_ok=True)
    return im, c, levels, subjects, {}, work, FakeJudge(levels, {"alpha": "Alpha"})


def test_an_attempt_that_never_rendered_is_used_again_not_counted(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    """A run killed mid-picture leaves an attempt record with no picture; it must not use up a
    rung of the ladder (the attempt-3 rewrite would then come one failed check too early)."""
    im, _c, _levels, subjects, _x, work, _judge = _tiny_setup(tmp_path, mods)
    im.record_attempt(work, "alpha", 1, 11, "v", "p")  # killed before the card was written
    assert im.next_attempt(work, "alpha") == 1
    work.card("alpha", 1).parent.mkdir(parents=True, exist_ok=True)
    work.card("alpha", 1).write_bytes(b"x")  # now attempt 1 did render
    im.record_attempt(work, "alpha", 2, 22, "v", "p")  # recorded, then killed again
    assert im.next_attempt(work, "alpha") == 2
    assert subjects  # the helper's subject exists


def _round(
    tmp_path: Path,
    mods: dict[str, ModuleType],
    comfy: Any,
    judge: Any,
    subjects: dict[str, Any],
    work: Any,
    **mode: bool,
) -> dict[str, int]:
    im, c = mods["images"], mods["check"]
    return asyncio.run(
        im.run_pipeline(
            sorted(subjects),
            subjects,
            work,
            comfy,
            lambda: {},
            judge,
            c.HAIKU,
            c.HAIKU,
            c.SOL,
            c.OPUS,
            chunk_size=3,
            review_path=tmp_path / "rev.json",
            rng=random.Random(4),
            sleep=lambda _s: None,
            **mode,
        )
    )


def test_check_only_never_renders_and_rounds_with_render_only_converge(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    """The hub checks (needs cmd), the render machine draws: alternating the two modes ends with
    every picture accepted, and the hub rounds draw nothing."""
    im = mods["images"]
    levels = {n.lower(): 30 * (i + 1) for i, n in enumerate(_NAMES)}
    subjects = {
        n.lower(): im.Subject(
            n.lower(),
            n,
            f"cat{i % 3}",
            f"A plain {n}.",
            f"one whole raw plain {n} tok{n.lower()}",
            "whole",
        )
        for i, n in enumerate(_NAMES)
    }
    work = im.WorkDir(tmp_path / "work")
    comfy = FakeComfy(
        levels, {"bravo": 1, "delta": 1}
    )  # first draw of two ids shows the wrong food
    judge = FakeJudge(levels, {k.lower(): s.name for k, s in subjects.items()})
    first = _round(tmp_path, mods, comfy, judge, subjects, work, render_only=True)
    assert first["rendered"] == 6 and comfy.renders == 6
    check1 = _round(tmp_path, mods, comfy, judge, subjects, work, check_only=True)
    assert comfy.renders == 6, "a check-only round must not render"
    assert check1["accepted"] == 4
    state = im.journal_state(work.journal)
    assert {i for i, e in state.items() if e["state"] == "regenerate"} == {"bravo", "delta"}
    redraw = _round(tmp_path, mods, comfy, judge, subjects, work, render_only=True)
    assert redraw["rendered"] == 2 and comfy.renders == 8
    check2 = _round(tmp_path, mods, comfy, judge, subjects, work, check_only=True)
    assert check2["accepted"] == 2 and comfy.renders == 8
    assert all(e["state"] == "accepted" for e in im.journal_state(work.journal).values())
    assert [a["attempt"] for a in work.read_attempts("bravo")] == [1, 2]


def test_check_only_asks_for_the_attempt_three_rewrite_once(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im = mods["images"]
    names = ["Alpha", "Bravo", "Charlie"]
    levels = {n.lower(): 30 * (i + 1) for i, n in enumerate(names)}
    subjects = {
        n.lower(): im.Subject(
            n.lower(), n, f"cat{i}", f"A plain {n}.", f"one whole plain {n} tok{n.lower()}", "whole"
        )
        for i, n in enumerate(names)
    }
    work = im.WorkDir(tmp_path / "work")
    comfy = FakeComfy(levels, {"alpha": 2})  # attempts 1 and 2 of alpha show the wrong food
    judge = FakeJudge(levels, {k.lower(): s.name for k, s in subjects.items()})
    for _ in range(2):
        _round(tmp_path, mods, comfy, judge, subjects, work, render_only=True)
        _round(tmp_path, mods, comfy, judge, subjects, work, check_only=True)
    assert judge.rewrites == 1  # asked as soon as attempt 3 was next
    for _ in range(3):  # more hub rounds before the render machine gets to it: no more asks
        _round(tmp_path, mods, comfy, judge, subjects, work, check_only=True)
    assert judge.rewrites == 1 and comfy.renders == 4  # 3 first draws + alpha's second
    _round(tmp_path, mods, comfy, judge, subjects, work, render_only=True)  # draws attempt 3
    assert comfy.renders == 5 and "alpha" in work.read_overrides()
    # the lone redraw is checked with decoys taken from the accepted pictures of other categories
    _round(tmp_path, mods, comfy, judge, subjects, work, check_only=True)
    assert im.journal_state(work.journal)["alpha"]["state"] == "accepted"


class _OverlapJudge:
    """Wraps FakeJudge: every model run takes a moment, and we count how many were in flight."""

    def __init__(
        self,
        inner: Any,
        fail_first: int = 0,
        fail_tag: str | None = None,
        slow_tag: str | None = None,
    ) -> None:
        self.inner, self.in_flight, self.peak, self.fail_first = inner, 0, 0, fail_first
        self.slow_tag = slow_tag  # the batch folder containing this is slow
        self.slow_active = False
        self.started_during_slow = 0  # runs of OTHER batches that began while the slow one ran
        self.fail_tag = fail_tag  # every run whose batch folder name contains this fails

    async def run(self, **kw: Any) -> str:
        if self.fail_tag is not None and self.fail_tag in str(kw.get("cwd")):
            raise RuntimeError("run spawn-failed: POST failed and is not safe to repeat")
        if self.fail_first > 0:
            self.fail_first -= 1
            raise RuntimeError("run spawn-failed: POST failed and is not safe to repeat")
        slow = self.slow_tag is not None and self.slow_tag in str(kw.get("cwd"))
        if self.slow_active and not slow:
            self.started_during_slow += 1
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        self.slow_active = self.slow_active or slow
        try:
            await asyncio.sleep(0.5 if slow else 0.02)
            return str(await self.inner.run(**kw))
        finally:
            self.in_flight -= 1
            if slow:
                self.slow_active = False


def _eight_subjects(im: Any) -> tuple[dict[str, Any], dict[str, int]]:
    names = [f"Item{c}" for c in "abcdefgh"]
    levels = {n.lower(): 25 * (i + 1) for i, n in enumerate(names)}
    subjects = {
        n.lower(): im.Subject(
            n.lower(),
            n,
            f"cat{i % 3}",
            f"A plain {n}.",
            f"one whole plain {n} tok{n.lower()}",
            "whole",
        )
        for i, n in enumerate(names)
    }
    return subjects, levels


def test_check_only_checks_several_batches_at_once(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im, c = mods["images"], mods["check"]
    subjects, levels = _eight_subjects(im)
    work = im.WorkDir(tmp_path / "work")
    comfy = FakeComfy(levels, {})
    inner = FakeJudge(levels, {k: s.name for k, s in subjects.items()})
    judge = _OverlapJudge(inner)

    def run(**mode: Any) -> dict[str, int]:
        return asyncio.run(
            im.run_pipeline(
                sorted(subjects),
                subjects,
                work,
                comfy,
                lambda: {},
                judge,
                c.HAIKU,
                c.HAIKU,
                c.SOL,
                c.OPUS,
                chunk_size=2,
                review_path=tmp_path / "rev.json",
                rng=random.Random(4),
                sleep=lambda _s: None,
                **mode,
            )
        )

    run(render_only=True)
    totals = run(check_only=True, check_concurrency=3)
    assert totals["accepted"] == 8 and comfy.renders == 8
    assert judge.peak >= 2, "batches were checked one after the other"
    assert all(e["state"] == "accepted" for e in im.journal_state(work.journal).values())


def test_a_locked_batch_folder_does_not_end_the_round(
    mods: dict[str, ModuleType], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Windows cannot delete a folder some process still has open (a cancelled check run, an
    indexer): the round died of exactly that. The batch takes a new folder name instead."""
    import shutil

    c = mods["check"]
    monkeypatch.setattr(c.time, "sleep", lambda _s: None)
    root = tmp_path / "k"
    locked = root / "b9-1"
    locked.mkdir(parents=True)
    (locked / "old.webp").write_bytes(b"x")
    real_rmtree = shutil.rmtree

    def rmtree(path: Any, *a: Any, **kw: Any) -> None:
        if Path(path) == locked:
            raise PermissionError(32, "The process cannot access the file")
        real_rmtree(path, *a, **kw)

    monkeypatch.setattr(c.shutil, "rmtree", rmtree)
    b = c.build_batch("b9-1", _images(c, tmp_path, 2), None, root, random.Random(0))
    assert b.directory == root / "b9-1-r1" and (b.directory / "01.webp").exists()
    assert (locked / "old.webp").exists()  # the stuck folder is left alone, not half-deleted
    # an ordinary stale folder is still replaced in place
    free = root / "b10-1"
    free.mkdir()
    (free / "stale.webp").write_bytes(b"y")
    b2 = c.build_batch("b10-1", _images(c, tmp_path, 2), None, root, random.Random(0))
    assert b2.directory == free and not (free / "stale.webp").exists()


def test_a_render_only_round_draws_just_the_listed_ids(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    """`--only-ids`: a redraw round on one set of pictures must not draw (or touch) the others."""
    im, c = mods["images"], mods["check"]
    subjects, levels = _eight_subjects(im)
    NL = chr(10)
    listing = tmp_path / "ids.txt"
    listing.write_text("# redraws" + NL + "itemb" + NL + NL + "  itemd  " + NL, encoding="utf-8")
    only = im.read_only_ids(listing, subjects)
    assert only == {"itemb", "itemd"}
    listing.write_text("itemb" + NL + "itemzz" + NL, encoding="utf-8")
    with pytest.raises(ValueError, match="itemzz"):
        im.read_only_ids(listing, subjects)  # a typo must not become a silent no-op
    work = im.WorkDir(tmp_path / "work")
    comfy = FakeComfy(levels, {})
    asyncio.run(
        im.run_pipeline(
            [i for i in sorted(subjects) if i in only],
            subjects,
            work,
            comfy,
            lambda: {},
            FakeJudge(levels, {k: s.name for k, s in subjects.items()}),
            c.HAIKU,
            c.HAIKU,
            c.SOL,
            c.OPUS,
            chunk_size=2,
            review_path=tmp_path / "rev.json",
            rng=random.Random(4),
            sleep=lambda _s: None,
            render_only=True,
        )
    )
    assert comfy.renders == 2 and set(im.journal_state(work.journal)) == only


def test_one_slow_batch_does_not_hold_the_other_lanes_idle(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    """A rolling pool: while one batch is slow, the other lane keeps taking batches (the old
    group-of-N barrier waited for the slowest batch before starting the next group)."""
    im, c = mods["images"], mods["check"]
    subjects, levels = _eight_subjects(im)
    work = im.WorkDir(tmp_path / "work")
    comfy = FakeComfy(levels, {})
    inner = FakeJudge(levels, {k: s.name for k, s in subjects.items()})
    judge = _OverlapJudge(inner, slow_tag="b1-")

    def run(**mode: Any) -> dict[str, int]:
        return asyncio.run(
            im.run_pipeline(
                sorted(subjects),
                subjects,
                work,
                comfy,
                lambda: {},
                judge,
                c.HAIKU,
                c.HAIKU,
                c.SOL,
                c.OPUS,
                chunk_size=2,
                review_path=tmp_path / "rev.json",
                rng=random.Random(4),
                sleep=lambda _s: None,
                **mode,
            )
        )

    run(render_only=True)
    totals = run(check_only=True, check_concurrency=2)
    assert totals["accepted"] == 8
    assert judge.peak == 2
    assert judge.started_during_slow >= 3, "the free lane waited for the slow batch"


def test_a_batch_whose_run_fails_to_start_is_retried(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im, c = mods["images"], mods["check"]
    subjects, levels = _eight_subjects(im)
    work = im.WorkDir(tmp_path / "work")
    comfy = FakeComfy(levels, {})
    judge = _OverlapJudge(FakeJudge(levels, {k: s.name for k, s in subjects.items()}), fail_first=2)

    def run(**mode: Any) -> dict[str, int]:
        return asyncio.run(
            im.run_pipeline(
                sorted(subjects),
                subjects,
                work,
                comfy,
                lambda: {},
                judge,
                c.HAIKU,
                c.HAIKU,
                c.SOL,
                c.OPUS,
                chunk_size=4,
                review_path=tmp_path / "rev.json",
                rng=random.Random(4),
                sleep=lambda _s: None,
                retry_wait_s=0.0,
                **mode,
            )
        )

    run(render_only=True)
    totals = run(check_only=True, check_concurrency=2)  # two starts fail, then it goes on
    assert totals["accepted"] == 8


def test_a_batch_that_fails_for_good_does_not_drop_the_others_results(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im, c = mods["images"], mods["check"]
    subjects, levels = _eight_subjects(im)
    work = im.WorkDir(tmp_path / "work")
    comfy = FakeComfy(levels, {})
    inner = FakeJudge(levels, {k: s.name for k, s in subjects.items()})
    judge = _OverlapJudge(inner, fail_tag="b1-")  # the first batch can never be checked

    def run(**mode: Any) -> dict[str, int]:
        return asyncio.run(
            im.run_pipeline(
                sorted(subjects),
                subjects,
                work,
                comfy,
                lambda: {},
                judge,
                c.HAIKU,
                c.HAIKU,
                c.SOL,
                c.OPUS,
                chunk_size=2,
                review_path=tmp_path / "rev.json",
                rng=random.Random(4),
                sleep=lambda _s: None,
                retry_wait_s=0.0,
                **mode,
            )
        )

    run(render_only=True)
    with pytest.raises(RuntimeError):
        run(check_only=True, check_concurrency=3)
    state = im.journal_state(work.journal)
    done = [i for i, e in state.items() if e["state"] == "accepted"]
    # batches 2 and 3 finished and were kept; batch 1 (2 ids) can never be accepted; once it had
    # failed no new batch is taken, so batch 4 may or may not have started
    assert 4 <= len(done) <= 6 and not {"itema", "itemb"} & set(done)
    assert (work.images / "status.json").exists()  # settle() and the status write still ran
    judge.fail_tag = None  # the cmd trouble is over: the next round finishes everything
    run(check_only=True, check_concurrency=3)
    assert all(e["state"] == "accepted" for e in im.journal_state(work.journal).values())


def test_check_concurrency_below_one_is_refused(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im = mods["images"]
    with pytest.raises(SystemExit) as err:
        im.main(["--work-dir", str(tmp_path), "run", "--check-only", "--check-concurrency", "0"])
    assert err.value.code == 2


def test_render_only_and_check_only_together_are_refused(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im = mods["images"]
    with pytest.raises(SystemExit) as err:
        im.main(["--work-dir", str(tmp_path), "run", "--render-only", "--check-only"])
    assert err.value.code == 2


def test_render_only_never_asks_for_a_rewrite(mods: dict[str, ModuleType], tmp_path: Path) -> None:
    """Two failed attempts put an id at attempt 3, which normally starts with a Haiku rewrite of
    its description. A render-only run has no checker (on Cherry, no cmd at all): it renders."""
    im, c, levels, subjects, _x, work, judge = _tiny_setup(tmp_path, mods)
    for attempt in (1, 2):
        im.record_attempt(work, "alpha", attempt, attempt, "v", "p")
        im.record_verdict(work, "alpha", attempt, "wrong", "not it", "haiku")
        work.card("alpha", attempt).parent.mkdir(parents=True, exist_ok=True)
        work.card("alpha", attempt).write_bytes(b"x")
    im.journal_append(
        work.journal, {"id": "alpha", "attempt": 2, "state": "regenerate", "by": None}
    )
    comfy = FakeComfy(levels, {})
    totals = asyncio.run(
        im.run_pipeline(
            ["alpha"],
            subjects,
            work,
            comfy,
            lambda: {},
            judge,
            c.HAIKU,
            c.HAIKU,
            c.SOL,
            c.OPUS,
            review_path=tmp_path / "rev.json",
            rng=random.Random(1),
            sleep=lambda _s: None,
            render_only=True,
        )
    )
    assert totals["rendered"] == 1 and comfy.renders == 1
    assert judge.rewrites == 0 and judge.models_seen == []
    assert [a["attempt"] for a in work.read_attempts("alpha")] == [1, 2, 3]


# --- the clean-environment history check (spec B.6) --------------------------------------------


class _PackServer:
    """Serves one file at /pack.tar from a mutable bytes holder on a loopback port."""

    def __init__(self) -> None:
        import http.server
        import threading

        outer = self
        self.body = b""

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Length", str(len(outer.body)))
                self.end_headers()
                self.wfile.write(outer.body)

            def log_message(self, *a: object) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/pack.tar"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _v1_history(im: Any, tmp_path: Path, srv: _PackServer) -> list[dict[str, Any]]:
    pics = [im.AcceptedPicture("a", b"card-a" * 9, b"thumb-a" * 9, 1, "claude-haiku-5-5")]
    manifest = im.build_pack(pics, tmp_path / "v1.tar", pack_version=1, url=srv.url)
    srv.body = (tmp_path / "v1.tar").read_bytes()
    v2 = {"packVersion": 2, "pack": {"url": "http://x/v2.tar", "bytes": 5}, "items": {}}
    return [v2, manifest]


def test_clean_install_check_proves_v1_from_v2_onward(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im = mods["images"]
    srv = _PackServer()
    try:
        history = _v1_history(im, tmp_path, srv)
        assert im.clean_install_check(history, 2) == []  # real fetch, real install, fresh storage
        assert im.clean_install_check(history, 1) == []  # nothing to prove for v1 itself
        srv.body = srv.body + b"x"  # the release asset changed under the manifest
        problems = im.clean_install_check(history, 2)
        assert problems and "clean install of v1 failed" in problems[0]
    finally:
        srv.close()


def test_clean_install_check_uses_a_fresh_empty_store(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im = mods["images"]
    seen: list[int] = []

    def fake_fetch(manifest: Any, store: Any) -> int:
        seen.append(len(list(store.objects_dir.rglob("*.webp"))))
        return 0  # installs nothing

    no_pack: list[dict[str, Any]] = [{"packVersion": 1, "pack": None, "items": {}}]
    assert "no earlier manifest" in im.clean_install_check(no_pack, 2)[0]
    srv = _PackServer()
    try:
        with_v1 = _v1_history(im, tmp_path, srv)
        problems = im.clean_install_check(with_v1, 2, fake_fetch)
    finally:
        srv.close()
    assert seen == [0]  # no cache: it started empty
    assert problems and "missing afterwards" in problems[0]


def test_images_docstring_matches_the_code(mods: dict[str, ModuleType]) -> None:
    doc = mods["images"].__doc__ or ""
    assert "scheduled task" in doc and "nothing here claims a CLI" not in doc
    assert "Run as a Grid task" not in doc


def test_judge_reason_is_free_text_and_stage_retries_once(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    cal, c = mods["calibrate"], mods["check"]

    def answer(reason: str, verdict: str = "unclear", problems: list[str] | None = None) -> str:
        item = {
            "image": "01",
            "checkerRight": True,
            "finalVerdict": verdict,
            "finalProblems": problems or [],
            "reason": reason,
        }
        return json.dumps({"items": [item]})

    # a short or empty reason is fine for a judge's final answer
    got = cal.parse_judge_final(answer("ok"), ["01"], with_checker_right=True)
    assert got["01"][0].verdict == "unclear"
    assert cal.parse_judge_final(answer(""), ["01"], with_checker_right=True)
    with pytest.raises(c.VerdictError):  # but `wrong` still needs a problem
        cal.parse_judge_final(answer("x", "wrong"), ["01"], with_checker_right=True)
    with pytest.raises(c.VerdictError):
        cal.parse_judge_final(answer("x", "maybe"), ["01"], with_checker_right=True)

    calls: list[str] = []

    def flaky(prompt: str, cwd: Path) -> str:
        calls.append(prompt)
        return "not json" if len(calls) == 1 else answer("fine", "wrong", ["wrong_food"])

    out = asyncio.run(
        cal.run_stage(
            FakeRunner(flaky), c.SOL, "judge these", tmp_path, ["01"], with_checker_right=True
        )
    )
    assert out["01"][0].problems == ("wrong_food",) and len(calls) == 2
    assert "could not be accepted" in calls[1]


def test_pool_runner_retries_a_dead_run(
    mods: dict[str, ModuleType], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    im = mods["images"]
    monkeypatch.setattr(im, "RUN_RETRY_GAP_S", 0.0)

    class Outcome:
        def __init__(self, status: str, text: str | None) -> None:
            self.status, self.text, self.error = status, text, "process exited before end_turn"
            self.ok = status == "completed" and text is not None

    class Pool:
        def __init__(self, outcomes: list[Outcome]) -> None:
            self.outcomes = outcomes
            self.keys: list[str] = []
            self.passes: list[tuple[str, list[str]]] = []

        async def run(self, key: str, pass_name: str, ids: list[str], spec: object) -> Outcome:
            self.keys.append(key)
            self.passes.append((pass_name, ids))
            return self.outcomes.pop(0)

    def make(outcomes: list[Outcome]) -> tuple[Any, Pool]:
        pool = Pool(outcomes)
        return im.PoolRunner(pool, lambda **kw: kw, lambda p, m: (p, m)), pool

    kw: dict[str, Any] = dict(
        prompt="p",
        model="m",
        provider="x",
        effort="medium",
        cwd=tmp_path,
        tool_profile="replay_probe",
        timeout_secs=9,
    )
    runner, pool = make([Outcome("error", None), Outcome("completed", "answer")])
    assert asyncio.run(runner.run(**kw)) == "answer"
    assert len(pool.keys) == 2 and pool.keys[0] == pool.keys[1]  # same key: journal-resumable
    # the run journal names the batch folder, so a hung run can be tied to its pictures
    assert pool.passes[0] == (f"image-{tmp_path.name}", [tmp_path.name])
    # a check batch that cmd never starts must not hold a lane for 15 minutes
    assert mods["check"].BATCH_TIMEOUT_S <= 420
    runner, pool = make([Outcome("error", None)] * 3)
    with pytest.raises(mods["check"].VerdictError, match="process exited"):
        asyncio.run(runner.run(**kw))
    assert len(pool.keys) == 3  # first try + two retries, then it gives up loudly


def test_run_calibration_end_to_end_with_fakes(mods: dict[str, ModuleType], tmp_path: Path) -> None:
    """The whole calibration (checks with decoys, blind judges, review, reconcile, scoring, files)
    against fake models, so a crash at any stage shows up here and not after hours of real runs."""
    import re

    from PIL import Image

    cal, c, im = mods["calibrate"], mods["check"], mods["images"]
    names = [f"Item{n:02d}" for n in range(20)]
    levels = {n.lower(): 10 + 11 * i for i, n in enumerate(names)}
    subjects = {
        n.lower(): im.Subject(n.lower(), n, f"cat{i % 4}", f"A plain {n}.", "v", "whole")
        for i, n in enumerate(names)
    }
    cards: dict[str, Path] = {}
    for ident, level in levels.items():
        path = tmp_path / f"{ident}.webp"
        Image.new("RGB", (32, 32), (level, level, level)).save(path, "WEBP", lossless=True)
        cards[ident] = path
    name_of = {k: s.name for k, s in subjects.items()}
    judge = FakeJudge(levels, name_of)

    class Models:
        async def run(self, **kw: Any) -> str:
            prompt = str(kw["prompt"])
            if "A checker model has now given" in prompt:
                items = []
                for m in re.finditer(r"Image (\d+): checker said (\w+);", prompt):
                    wrong = m.group(2) != "correct"
                    items.append(
                        {
                            "image": m.group(1),
                            "checkerRight": True,
                            "finalVerdict": m.group(2),
                            "finalProblems": ["wrong_food"] if wrong else [],
                            "reason": "",
                        }
                    )
                return json.dumps({"items": items})
            return await judge.run(**kw)

    def image_of(ident: str) -> Any:
        s = subjects[ident]
        return c.CheckImage(ident, s.name, s.what, s.presentation, cards[ident])

    ids = sorted(subjects)
    rng = random.Random(5)
    pick = im.pick_decoy_factory(subjects, lambda: cards, rng)
    result = asyncio.run(
        cal.run_calibration(
            Models(),
            [image_of(i) for i in ids[:10]],
            [image_of(i) for i in ids[10:]],
            pick,
            tmp_path / "work",
            5,
            rng,
        )
    )
    assert result.choice == "haiku" and {s.label for s in result.scores} == {"haiku", "luna"}
    assert all(s.total == 10 and s.errors == 0 for s in result.scores)
    assert all(s.decoys_caught == s.decoys_total == 1 for s in result.scores)
    assert "Haiku got 10 of 10 right" in result.report and len(result.detail) == 20
    out = tmp_path / "work" / "calibration"
    names_written = sorted(p.name for p in out.iterdir())
    assert "scores.json" in names_written and "checks-haiku.jsonl" in names_written
    assert "judge-sol-blind.jsonl" in names_written and "judge-opus-final.jsonl" in names_written
    scores = json.loads((out / "scores.json").read_text("utf-8"))
    assert [s["label"] for s in scores] == ["haiku", "luna"] and scores[0]["errors"] == 0


def test_extend_plan_keeps_pilot_and_interleaves_new_ids(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]
    cats = {f"c{c}-{n}": f"cat{c}" for c in range(3) for n in range(10)}
    first = {k: v for k, v in cats.items() if int(k.split("-")[1]) < 6}
    plan = im.make_plan(first, 9, per_category=2)
    grown = im.extend_plan(plan, cats)
    assert grown["pilot"] == plan["pilot"] and grown["seed"] == plan["seed"]
    assert grown["rest"][: len(plan["rest"])] == plan["rest"]  # earlier order untouched
    added = grown["rest"][len(plan["rest"]) :]
    assert sorted(added) == sorted(set(cats) - set(first))
    assert {cats[i] for i in added[:3]} == {"cat0", "cat1", "cat2"}  # category-interleaved
    assert im.extend_plan(grown, cats) == grown  # idempotent


def test_every_rendered_picture_records_where_its_time_went(
    mods: dict[str, ModuleType], tmp_path: Path
) -> None:
    im, _work, _comfy, _judge, _totals = _pipeline(tmp_path, mods, {})
    rendered = [
        json.loads(line)
        for line in (tmp_path / "work" / "images" / "journal.jsonl").read_text("utf-8").splitlines()
        if '"rendered"' in line
    ]
    assert len(rendered) == 6
    for entry in rendered:
        timing = entry["timing"]
        assert set(timing) == {"gateS", "prepS", "comfyS", "encodeS", "totalS"}
        assert all(isinstance(v, float) and v >= 0 for v in timing.values())
        assert timing["totalS"] >= timing["comfyS"] + timing["encodeS"] - 0.01


def _queue_item(text: str, client: str = "abcdef12", prefix: str = "wyr_x_a") -> list[Any]:
    graph = {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": text}},
        "2": {"class_type": "SaveImage", "inputs": {"filename_prefix": prefix}},
    }
    return [3, "pid", graph, {"client_id": client}, []]


def test_queue_signatures_name_foreign_jobs_and_skip_ours(mods: dict[str, ModuleType]) -> None:
    im = mods["images"]
    queue = {
        "queue_running": [_queue_item("Studio food photograph of a toastie")],
        "queue_pending": [_queue_item("our own prompt"), "not a job", [1, "p", None]],
    }
    everything = im.queue_signatures(queue)
    assert any("toastie" in s and s.startswith("running|abcdef12|") for s in everything)
    assert sum("unreadable" in s for s in everything) == 2
    foreign = im.queue_signatures(queue, "our own prompt")
    assert not any("our own prompt" in s for s in foreign) and len(foreign) == 3
    assert im.queue_signatures({}) == []


def test_journal_records_who_shared_the_queue(mods: dict[str, ModuleType], tmp_path: Path) -> None:
    im, c = mods["images"], mods["check"]
    busy = {"queue_running": [_queue_item("somebody else's dish photo", "feedbeef")]}
    calls = {"n": 0}

    def get_queue() -> dict[str, Any]:
        calls["n"] += 1
        return busy if calls["n"] <= 3 else {}  # busy for the first polls, then idle

    work = im.WorkDir(tmp_path / "work")
    subjects = {"a": im.Subject("a", "A", "c", "w", "v toka", "whole")}
    asyncio.run(
        im.run_pipeline(
            ["a"],
            subjects,
            work,
            FakeComfy({}, {}),
            get_queue,
            FakeJudge({}, {}),
            c.HAIKU,
            c.HAIKU,
            c.SOL,
            c.OPUS,
            review_path=tmp_path / "r.json",
            sleep=lambda _s: None,
            render_only=True,
        )
    )
    entry = json.loads(
        (tmp_path / "work" / "images" / "journal.jsonl").read_text("utf-8").splitlines()[0]
    )
    gate = entry["sharedWith"]["gate"]
    assert gate and next(iter(gate)).startswith("running|feedbeef|somebody else's dish photo")
    assert entry["sharedWith"]["render"] == {} or isinstance(entry["sharedWith"]["render"], dict)
