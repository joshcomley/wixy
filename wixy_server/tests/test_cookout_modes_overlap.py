"""The activation barrier (workspace 00058, spec 09c §5.6 and §8.2).

A v21 server process accepts a database at a higher schema version and ignores the mode column.
These tests load the DEPLOYED v21 `wixy_server` from git history (the pinned commit below, on
`origin/main`, schema 21) into a separate interpreter and run its real write logic over a database
migrated to v22:

1. the canary proves the barrier is still needed (v21 corrupts a Toasted sandwich round);
2. before activation the v22 routes refuse to create such a round: the database holds only Classic
   rows, and v21's pick/skip/pending reads then behave exactly as v22's do on the same rows;
3. `tooling/cookout/activate_modes.py` refuses unless every check passes, preserves `.env` byte for
   byte and bounces only on success; `--check-rollback` knows when v21 is unsafe.
"""

from __future__ import annotations

import json
import os
import random
import sqlite3
import subprocess
import sys
import tarfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from tooling.cookout import activate_modes as am
from wixy_server.livechat.cookout_bank import CookoutBank, load_cookout_bank_or_empty
from wixy_server.livechat.store import LiveChatStore

REPO_ROOT = Path(__file__).resolve().parents[2]
V21_COMMIT = "4d2b005c"
"""The round-1 Cookout delivery on `origin/main` (schema 21): main is never rewritten, so a later
squash of the feature branch cannot make it unreachable. It needs full history: CI's `python` job
checks out with `fetch-depth: 0` (ci.yml), and a shallow clone makes the test FAIL, never skip."""

# Runs inside whichever tree is on PYTHONPATH (v21 or the current one) and prints JSON.
RUNNER = r"""
import json, random, sys
from pathlib import Path
from wixy_server.livechat.cookout_bank import load_cookout_bank_or_empty
from wixy_server.livechat.cookout_game import current_turn
from wixy_server.livechat.store import LiveChatStore

db, op, seq = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
bank = load_cookout_bank_or_empty()
store = LiveChatStore(db)
n = [0]

def mid():
    n[0] += 1
    return f"overlap-move-{n[0]:04d}"

def live():
    data = store.cookout_view_data(anchor_seq=seq)
    cur = current_turn(data.round, data.turns)
    return data, cur

def pick(seed):
    data, cur = live()
    name = "Rose" if cur.player == 1 else "Josh"
    store.pick_cookout(anchor_seq=seq, sender=name, email=None, move_id=mid(), turn=cur.turn,
        offer=len(cur.row.offers) - 1, ingredient_id=cur.row.offers[-1][0]["id"], bank=bank,
        runner_available=True, rng=random.Random(seed))

if op == "pick-live-turn":
    pick(1)
    data, cur = live()
    out = {
        "turns": len(data.turns),
        "turn4_roles": [bank.ingredient(s["id"]).role for s in data.turns[-1].offers[-1]],
        "turn4": data.turns[-1].turn,
    }
elif op == "classic-run":
    store.join_cookout(anchor_seq=seq, sender="Josh", email=None, bank=bank, rng=random.Random(1))
    data, cur = live()
    store.skip_cookout(anchor_seq=seq, sender="Rose", email=None, move_id=mid(), turn=cur.turn,
        offer=0, bank=bank, rng=random.Random(2))
    for i in range(4):
        pick(10 + i)
    data, cur = live()
    out = {
        "schedule": list(data.round.role_schedule),
        "turns": [
            {
                "turn": t.turn,
                "offers": [[a["id"], b["id"]] for a, b in t.offers],
                "choice": t.choice_id,
            }
            for t in data.turns
        ],
        "pending": [store.cookout_pending_concepts(), store.cookout_pending_recipes(),
                    store.cookout_stale_pictures(stale_before=1e12)],
    }
else:
    raise SystemExit("unknown op")
print(json.dumps(out))
"""


@pytest.fixture(scope="module")
def v21_tree(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The deployed v21 `wixy_server` + `builder`, exported from git history."""
    probe = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "cat-file", "-e", f"{V21_COMMIT}^{{commit}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        pytest.fail(
            f"needs full git history: commit {V21_COMMIT} (the deployed v21 code) is not in this "
            "checkout. Clone with fetch-depth 0 (CI does) — this test never skips."
        )
    target = tmp_path_factory.mktemp("v21tree")
    archive = target / "v21.tar"
    with archive.open("wb") as handle:
        subprocess.run(
            ["git", "-C", str(REPO_ROOT), "archive", V21_COMMIT, "wixy_server", "builder"],
            stdout=handle,
            check=True,
        )
    with tarfile.open(archive) as tar:
        tar.extractall(target, filter="data")
    archive.unlink()
    version = (target / "wixy_server" / "livechat" / "store.py").read_text(encoding="utf-8")
    assert "_LATEST_SCHEMA_VERSION = 21" in version, "the pinned commit must be schema v21"
    return target


def run_runner(tree: Path, db: Path, op: str, seq: int, tmp: Path) -> dict[str, Any]:
    script = tmp / "overlap_runner.py"
    script.write_text(RUNNER, encoding="utf-8")
    env = {**os.environ, "PYTHONPATH": str(tree), "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run(
        [sys.executable, str(script), str(db), op, str(seq)],
        cwd=tree,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=300,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    parsed: dict[str, Any] = json.loads(result.stdout.strip().splitlines()[-1])
    return parsed


@pytest.fixture(scope="module")
def bank() -> CookoutBank:
    return load_cookout_bank_or_empty()


def make_round(db: Path, bank: CookoutBank, *, mode: str, schedule: Sequence[str] | None) -> int:
    store = LiveChatStore(db)
    message, _ = store.create_cookout_round(
        client_id=f"overlap-client-{mode}",
        sender="Rose",
        device_id="device-1234",
        by_email=None,
        blind=False,
        bank=bank,
        mode_id=mode,
        rng=random.Random(5),
    )
    if schedule is not None:
        conn = sqlite3.connect(db)
        conn.execute("UPDATE cookout_rounds SET role_schedule = ?", (json.dumps(list(schedule)),))
        conn.commit()
        conn.close()
    return message.seq


class TestV21Canary:
    def test_v21_corrupts_a_toasted_sandwich_round_so_the_barrier_is_needed(
        self, v21_tree: Path, bank: CookoutBank, tmp_path: Path
    ) -> None:
        db = tmp_path / "v22.db"
        schedule = ["bread", "produce", "produce", "cheese", "cheese", "main", "main", "finish"]
        seq = make_round(db, bank, mode="toastie", schedule=schedule)
        store = LiveChatStore(db)
        # v22 plays turns 1-2 (the bread and Player 2's first filling)
        store.join_cookout(
            anchor_seq=seq, sender="Josh", email=None, bank=bank, rng=random.Random(1)
        )
        for turn in (1, 2):
            data = store.cookout_view_data(anchor_seq=seq)
            assert data is not None
            row = data.turns[-1]
            assert row.turn == turn
            store.pick_cookout(
                anchor_seq=seq,
                sender="Rose" if turn == 1 else "Josh",
                email=None,
                move_id=f"canary-move-{turn:04d}",
                turn=turn,
                offer=0,
                ingredient_id=row.offers[0][0]["id"],
                bank=bank,
                runner_available=True,
                rng=random.Random(turn),
            )
        # v22 deals turn 3 as `produce` (the plan) ...
        # ... and v21, handed the same database, commits the turn-3 pick and draws turn 4.
        result = run_runner(v21_tree, db, "pick-live-turn", seq, tmp_path)
        assert result["turn4"] == 4
        # the plan says turn 4 is a CHEESE turn; v21 reads its paired index and deals `produce`
        assert result["turn4_roles"] == ["produce", "produce"]
        planned = schedule[3]
        assert planned == "cheese"


class TestBeforeActivation:
    def test_with_modes_switched_off_the_database_holds_only_classic_rows(
        self, bank: CookoutBank, tmp_path: Path
    ) -> None:
        # The v22 routes answer 503 for a Toasted sandwich round while the setting is absent
        # (TestRoutes in test_livechat_cookout_modes.py), so only Classic rounds can exist.
        db = tmp_path / "v22.db"
        make_round(db, bank, mode="classic", schedule=None)
        conn = sqlite3.connect(db)
        assert {r[0] for r in conn.execute("SELECT mode FROM cookout_rounds")} == {"classic"}
        conn.close()

    def test_v21_write_logic_over_a_migrated_classic_database_matches_v22_exactly(
        self, v21_tree: Path, bank: CookoutBank, tmp_path: Path
    ) -> None:
        base = tmp_path / "base.db"
        seq = make_round(base, bank, mode="classic", schedule=None)
        old = tmp_path / "old.db"
        new = tmp_path / "new.db"
        for target in (old, new):
            conn = sqlite3.connect(base)
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.close()
            target.write_bytes(base.read_bytes())
        with_v21 = run_runner(v21_tree, old, "classic-run", seq, tmp_path)
        with_v22 = run_runner(REPO_ROOT, new, "classic-run", seq, tmp_path)
        assert with_v21 == with_v22
        assert len(with_v21["turns"]) == 5 and len(with_v21["schedule"]) == 5


# -- activate_modes.py ---------------------------------------------------------------------

SLOTS = "D:\\Servers\\Wixy\\Slots"


def good_facts(**changes: Any) -> am.Facts:
    base: dict[str, Any] = {
        "devfleet_wixy_running": True,
        "active_slot": "blue",
        "slot_schema": {"blue": 22, "green": 21},
        "db_versions": [22],
        "processes": [am.ProcessInfo(10, SLOTS + "\\blue\\launcher.py", SLOTS + "\\blue")],
        "options_modes": ["classic"],
    }
    base.update(changes)
    return am.Facts(**base)


class FakeProbe:
    def __init__(self, facts: am.Facts, env: str = "", *, after: Sequence[str] | None = None):
        self.facts = facts
        self.env = env
        self.written: list[str] = []
        self.bounces = 0
        self.after = ["classic", "toastie"] if after is None else list(after)
        self.target_schema: int | None = 21
        self.non_classic = 0

    def gather(self) -> am.Facts:
        return self.facts

    def read_env(self) -> str:
        return self.env

    def write_env(self, text: str) -> None:
        self.written.append(text)
        self.env = text

    def bounce(self) -> None:
        self.bounces += 1

    def options_modes(self) -> Sequence[str] | None:
        return self.after if self.bounces else self.facts.options_modes

    def rollback_target_schema(self, commit: str) -> int | None:
        return self.target_schema

    def non_classic_round_count(self) -> int:
        return self.non_classic


class TestActivationTool:
    def test_it_enables_when_every_check_passes_and_preserves_other_env_lines(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        env = "WIXY_PORT=9380\nWIXY_COMFY_URL=http://x:8188\n# a comment, ünïcode\n"
        probe = FakeProbe(good_facts(), env)
        assert am.enable(probe, "toastie", slots_root=SLOTS) == 0
        assert probe.bounces == 1
        assert probe.written == [env + "WIXY_COOKOUT_MODES=toastie\n"]
        out = capsys.readouterr().out
        for label in ("(a)", "(b)", "(c)", "(d)", "(e)", "Verified"):
            assert label in out
        assert out.count("[ok]") == 5

    @pytest.mark.parametrize(
        ("changes", "failing"),
        [
            ({"devfleet_wixy_running": False}, "(a)"),
            ({"devfleet_wixy_running": None}, "(a)"),
            ({"slot_schema": {"blue": 21, "green": 21}}, "(b)"),
            ({"slot_schema": {"blue": None, "green": 22}}, "(b)"),
            ({"active_slot": None}, "(b)"),
            ({"db_versions": [21]}, "(c)"),
            ({"db_versions": []}, "(c)"),
            (
                {
                    "processes": [
                        am.ProcessInfo(7, SLOTS + "\\green\\launcher.py", SLOTS + "\\green")
                    ]
                },
                "(d)",
            ),
            ({"processes": [am.ProcessInfo(8, "python x", SLOTS + "\\green\\wixy_server")]}, "(d)"),
            # a relative-path start: the command line names no slot, only the working directory does
            ({"processes": [am.ProcessInfo(9, "python launcher.py", SLOTS + "\\green")]}, "(d)"),
            # fail closed: an unreadable cwd on a python/wixy process, and an unreadable list
            ({"processes": [am.ProcessInfo(11, "python launcher.py", None)]}, "(d)"),
            ({"processes": [am.ProcessInfo(12, "C:\\x\\python.exe -m wixy_server", None)]}, "(d)"),
            ({"processes": None}, "(d)"),
            ({"options_modes": None}, "(e)"),
        ],
    )
    def test_it_refuses_and_changes_nothing_when_a_check_fails(
        self, changes: dict[str, Any], failing: str, capsys: pytest.CaptureFixture[str]
    ) -> None:
        probe = FakeProbe(good_facts(**changes), "WIXY_PORT=9380\n")
        assert am.enable(probe, "toastie", slots_root=SLOTS) == 1
        assert probe.written == [] and probe.bounces == 0
        out = capsys.readouterr().out
        assert "REFUSED" in out
        assert any(line.startswith("  [FAIL]") and failing in line for line in out.splitlines())

    def test_it_reports_failure_when_the_mode_is_not_listed_after_the_restart(self) -> None:
        probe = FakeProbe(good_facts(), "", after=["classic"])
        assert am.enable(probe, "toastie", slots_root=SLOTS) == 2

    def test_enabling_twice_does_not_duplicate_the_id_and_a_second_mode_is_added(self) -> None:
        probe = FakeProbe(good_facts(), "WIXY_COOKOUT_MODES=toastie\nA=1\n")
        assert am.enable(probe, "toastie", slots_root=SLOTS) == 0
        assert probe.written[-1] == "WIXY_COOKOUT_MODES=toastie\nA=1\n"
        assert am.enable(probe, "pizza", slots_root=SLOTS) in (0, 2)
        assert am.current_modes(probe.written[-1]) == ["toastie", "pizza"]

    def test_disable_removes_only_that_id_with_no_slot_checks(self) -> None:
        facts = good_facts(devfleet_wixy_running=False, active_slot=None, db_versions=[])
        probe = FakeProbe(facts, "A=1\nWIXY_COOKOUT_MODES=toastie,pizza\nB=2\n", after=["classic"])
        assert am.disable(probe, "toastie") == 0
        assert probe.written == ["A=1\nWIXY_COOKOUT_MODES=pizza\nB=2\n"]
        assert probe.bounces == 1
        probe.after = ["classic"]
        assert am.disable(probe, "pizza") == 0
        assert probe.written[-1] == "A=1\nB=2\n"

    def test_set_setting_keeps_crlf_free_utf8_and_appends_when_missing(self) -> None:
        assert am.set_setting("", ["toastie"]) == "WIXY_COOKOUT_MODES=toastie\n"
        assert am.set_setting("A=1", ["toastie"]) == "A=1\nWIXY_COOKOUT_MODES=toastie\n"
        assert am.set_setting("A=1\n", []) == "A=1\n"

    def test_check_rollback_reports_v21_unsafe_while_a_non_classic_row_exists(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        probe = FakeProbe(good_facts())
        probe.target_schema, probe.non_classic = 21, 2
        assert am.check_rollback(probe, "abc1234") == 1
        assert "UNSAFE" in capsys.readouterr().out
        probe.non_classic = 0
        assert am.check_rollback(probe, "abc1234") == 0
        probe.target_schema, probe.non_classic = 22, 5
        assert am.check_rollback(probe, "def5678") == 0

    def test_the_machine_probe_reads_schema_env_and_rounds_from_a_slot_tree(
        self, tmp_path: Path, bank: CookoutBank
    ) -> None:
        root = tmp_path / "Wixy"
        store_py = root / "Slots" / "blue" / "wixy_server" / "livechat" / "store.py"
        store_py.parent.mkdir(parents=True)
        store_py.write_text("X = 1\n_LATEST_SCHEMA_VERSION = 22\n", encoding="utf-8")
        (root / "active.txt").write_text("blue\n", encoding="utf-8")
        db = root / "Storage" / "projects" / "ca" / "server" / "server.db"
        make_round(db, bank, mode="toastie", schedule=None)
        probe = am.MachineProbe(root=root, repo=REPO_ROOT, token="t")
        assert probe._active_slot() == "blue"
        assert probe._slot_schema("blue") == 22 and probe._slot_schema("green") is None
        assert probe._db_versions() == [22]
        assert probe.non_classic_round_count() == 1
        probe.write_env("A=1\n")
        assert probe.read_env() == "A=1\n"
        assert (root / "Storage" / ".env").read_bytes() == b"A=1\n"


class TestCheckDFailsClosed:
    def test_an_unrelated_process_with_an_unreadable_cwd_does_not_block(self) -> None:
        facts = good_facts(
            processes=[
                am.ProcessInfo(10, SLOTS + "\\blue\\launcher.py", SLOTS + "\\blue"),
                am.ProcessInfo(4, "System", None),
            ]
        )
        assert am.evaluate_enable(facts, slots_root=SLOTS).ok

    def test_the_refusal_says_why_the_cwd_is_unreadable(self) -> None:
        facts = good_facts(processes=[am.ProcessInfo(11, "python launcher.py", None)])
        detail = next(
            c.detail for c in am.evaluate_enable(facts, slots_root=SLOTS).checks if "(d)" in c.label
        )
        assert "pid 11" in detail and "unreadable" in detail and "psutil" in detail

    def test_without_psutil_cwd_of_is_none_not_an_empty_string(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import importlib

        real = importlib.import_module

        def fake(name: str, *a: Any, **k: Any) -> Any:
            if name == "psutil":
                raise ModuleNotFoundError(name)
            return real(name, *a, **k)

        monkeypatch.setattr(importlib, "import_module", fake)
        assert am._cwd_of({"ProcessId": 1}) is None
