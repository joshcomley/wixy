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
    assert im.pending_work(["b"], state, lambda _i: True) == []


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
    text = cal.render_report(7, [h, lu], "haiku", ["Lime: checker said wrong."], {"agreed on": 100})
    first = text.split("\n\n")[1]
    assert "Haiku got 50 of 50" in first and "using Haiku" in first
    assert "Random seed" in text and "Lime" in text
    none = cal.render_report(7, [h, lu], None, [], {"agreed on": 1})
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

    def __init__(self, level_of: dict[str, int], name_of: dict[str, str]) -> None:
        self.level_of, self.name_of = level_of, name_of
        self.opus_calls, self.rewrites = 0, 0

    async def run(self, **kw: Any) -> str:
        import re

        from PIL import Image

        prompt, cwd = str(kw["prompt"]), Path(str(kw["cwd"]))
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
            rows.append(
                (m.group(1), "correct", [], "")
                if ok
                else (m.group(1), "wrong", ["wrong_food"], "That is not the right food.")
            )
        return _vjson(rows)


def _pipeline(
    tmp_path: Path, mods: dict[str, ModuleType], bad: dict[str, int]
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
    judge = FakeJudge(levels, {k.lower(): s.name for k, s in subjects.items()})
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
