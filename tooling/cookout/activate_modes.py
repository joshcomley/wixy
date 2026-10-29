"""Switch a Cookout game mode on or off for the deployed Wixy (spec 09c §5.6).

Why this exists: a v21 server process accepts a database at a higher schema version and ignores the
`cookout_rounds.mode` column, so a Toasted sandwich round it handled would be corrupted (the review
reproduced it). A non-Classic round must therefore never exist while any older process can still
reach the database. The release ships with `WIXY_COOKOUT_MODES` absent (Classic only); this tool is
the checked, last step that sets it, on the hub:

    python tooling/cookout/activate_modes.py --enable toastie --token <server token>
    python tooling/cookout/activate_modes.py --disable toastie --token <server token>
    python tooling/cookout/activate_modes.py --check-rollback <commit>

`--enable` REFUSES (non-zero exit, nothing changed) unless every check holds, and prints each check
and its result:

  (a) Devfleet shows Wixy running;
  (b) the active slot (`active.txt`) holds a `store.py` with `_LATEST_SCHEMA_VERSION >= 22`;
  (c) every live database has `PRAGMA user_version >= 22`;
  (d) no running process has a command line or working directory under the OTHER slot;
  (e) `GET /cookout/options` on the live server answers.

It then writes `WIXY_COOKOUT_MODES=<ids>` into `Storage\\.env` (every other line preserved byte for
byte; UTF-8, LF), bounces Wixy in place through Devfleet (`POST /restart/Wixy`; no older code
starts) and verifies that the options now list the mode. `--disable` removes the id the same way
(no slot checks are needed to switch off). `--check-rollback <commit>` says whether rolling Wixy
back to that commit is safe: its `store.py` is >= v22, or no non-Classic round exists.

The decision logic is pure (`evaluate_enable`) and every side effect sits behind `Probe`, so the
refusals are tested without a machine (`test_cookout_modes_overlap.py`).
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

SETTING = "WIXY_COOKOUT_MODES"
REQUIRED_SCHEMA = 22
DEVFLEET_URL = "http://127.0.0.1:9999"
WIXY_URL = "http://127.0.0.1:9380"
_VERSION_RE = re.compile(r"^_LATEST_SCHEMA_VERSION\s*=\s*(\d+)\s*$", re.MULTILINE)
STORE_RELPATH = "wixy_server/livechat/store.py"


@dataclass(frozen=True, slots=True)
class ProcessInfo:
    pid: int
    command_line: str
    cwd: str = ""


@dataclass(frozen=True, slots=True)
class Facts:
    """Everything the checks read, gathered once by a `Probe` (a fake in tests)."""

    devfleet_wixy_running: bool | None
    active_slot: str | None
    slot_schema: Mapping[str, int | None]
    db_versions: Sequence[int]
    processes: Sequence[ProcessInfo]
    options_modes: Sequence[str] | None


@dataclass(frozen=True, slots=True)
class Check:
    label: str
    ok: bool
    detail: str


@dataclass(frozen=True, slots=True)
class Decision:
    checks: tuple[Check, ...]

    @property
    def ok(self) -> bool:
        return all(c.ok for c in self.checks)


class Probe(Protocol):
    """The tool's side effects. The real one touches the machine; tests inject fakes."""

    def gather(self) -> Facts: ...
    def read_env(self) -> str: ...
    def write_env(self, text: str) -> None: ...
    def bounce(self) -> None: ...
    def options_modes(self) -> Sequence[str] | None: ...
    def rollback_target_schema(self, commit: str) -> int | None: ...
    def non_classic_round_count(self) -> int: ...


def other_slot(active: str) -> str:
    return "green" if active == "blue" else "blue"


def _under(path_text: str, slot_dir: str) -> bool:
    norm = path_text.replace("/", "\\").lower()
    return bool(norm) and slot_dir.lower() in norm


def evaluate_enable(facts: Facts, *, slots_root: str) -> Decision:
    """The five `--enable` checks (spec 09c §5.6 step 3). `slots_root` is the `Slots` directory
    path as text; the other slot's directory is `<slots_root>\\<other>`."""
    checks: list[Check] = []
    checks.append(
        Check(
            "(a) Devfleet shows Wixy running",
            facts.devfleet_wixy_running is True,
            "running"
            if facts.devfleet_wixy_running
            else "not running"
            if facts.devfleet_wixy_running is False
            else "Devfleet did not answer",
        )
    )
    active = facts.active_slot
    schema = facts.slot_schema.get(active) if active else None
    checks.append(
        Check(
            "(b) the active slot is at schema 22 or later",
            schema is not None and schema >= REQUIRED_SCHEMA,
            f"active slot {active!r}: store.py schema {schema}",
        )
    )
    below = [v for v in facts.db_versions if v < REQUIRED_SCHEMA]
    checks.append(
        Check(
            "(c) the live database is at schema 22 or later",
            bool(facts.db_versions) and not below,
            f"user_version(s) {list(facts.db_versions)}"
            if facts.db_versions
            else "no live database found",
        )
    )
    if active is None:
        stale: list[ProcessInfo] = list(facts.processes)
        detail_slot = "unknown"
    else:
        slot_dir = f"{slots_root}\\{other_slot(active)}"
        stale = [
            p
            for p in facts.processes
            if _under(p.command_line, slot_dir) or _under(p.cwd, slot_dir)
        ]
        detail_slot = slot_dir
    checks.append(
        Check(
            "(d) no process is running from the other slot",
            active is not None and not stale,
            f"none under {detail_slot}"
            if not stale
            else "still running: " + ", ".join(f"pid {p.pid}" for p in stale),
        )
    )
    checks.append(
        Check(
            "(e) the live server answers GET /cookout/options",
            facts.options_modes is not None,
            f"modes listed: {list(facts.options_modes)}"
            if facts.options_modes is not None
            else "no answer",
        )
    )
    return Decision(tuple(checks))


def parse_modes(text: str) -> list[str]:
    return [part.strip().lower() for part in text.split(",") if part.strip()]


def set_setting(env_text: str, mode_ids: Sequence[str]) -> str:
    """`env_text` with `WIXY_COOKOUT_MODES` set to `mode_ids` (removed when empty). Every other
    line is kept byte for byte, LF endings; a missing setting is appended."""
    lines = env_text.split("\n") if env_text else []
    out: list[str] = []
    done = False
    for line in lines:
        if line.strip().startswith(f"{SETTING}="):
            if mode_ids and not done:
                out.append(f"{SETTING}={','.join(mode_ids)}")
            done = True
            continue
        out.append(line)
    if mode_ids and not done:
        while out and out[-1] == "":
            out.pop()
        out.append(f"{SETTING}={','.join(mode_ids)}")
        out.append("")
    return "\n".join(out)


def current_modes(env_text: str) -> list[str]:
    for line in env_text.split("\n"):
        if line.strip().startswith(f"{SETTING}="):
            return parse_modes(line.split("=", 1)[1])
    return []


def _print_decision(decision: Decision) -> None:
    for check in decision.checks:
        print(f"  [{'ok' if check.ok else 'FAIL'}] {check.label}: {check.detail}")


def enable(probe: Probe, mode_id: str, *, slots_root: str) -> int:
    facts = probe.gather()
    decision = evaluate_enable(facts, slots_root=slots_root)
    print(f"Checks before switching {mode_id} on:")
    _print_decision(decision)
    if not decision.ok:
        print("REFUSED: not every check passed; nothing was changed.")
        return 1
    env_text = probe.read_env()
    modes = current_modes(env_text)
    if mode_id not in modes:
        modes.append(mode_id)
    probe.write_env(set_setting(env_text, modes))
    print(f"Wrote {SETTING}={','.join(modes)}")
    probe.bounce()
    print("Wixy restarted in place.")
    listed = probe.options_modes()
    if listed is None or mode_id not in listed:
        print(f"FAIL: after the restart GET /cookout/options lists {listed}, not {mode_id}.")
        return 2
    print(f"Verified: GET /cookout/options now lists {mode_id}.")
    return 0


def disable(probe: Probe, mode_id: str) -> int:
    env_text = probe.read_env()
    modes = [m for m in current_modes(env_text) if m != mode_id]
    probe.write_env(set_setting(env_text, modes))
    print(f"Wrote {SETTING}={','.join(modes) or '(removed)'}")
    probe.bounce()
    listed = probe.options_modes()
    if listed is not None and mode_id in listed:
        print(f"FAIL: after the restart GET /cookout/options still lists {mode_id}.")
        return 2
    print(f"Verified: {mode_id} is no longer offered.")
    return 0


def check_rollback(probe: Probe, commit: str) -> int:
    """0 = safe to roll back to `commit`, 1 = unsafe (v21 code would meet non-Classic rounds)."""
    schema = probe.rollback_target_schema(commit)
    if schema is not None and schema >= REQUIRED_SCHEMA:
        print(f"SAFE: {commit} is at schema {schema} (it refuses modes it does not know).")
        return 0
    count = probe.non_classic_round_count()
    if count == 0:
        print(f"SAFE: {commit} is at schema {schema}, but no non-Classic round exists.")
        return 0
    print(
        f"UNSAFE: {commit} is at schema {schema} and {count} non-Classic round(s) exist; "
        "that older code would corrupt them. Do not roll back to it."
    )
    return 1


# -- the real machine --------------------------------------------------------------------------


@dataclass(slots=True)
class MachineProbe:
    root: Path
    repo: Path
    token: str
    devfleet_url: str = DEVFLEET_URL
    wixy_url: str = WIXY_URL
    _timeout: float = field(default=15.0)

    @property
    def slots_dir(self) -> Path:
        return self.root / "Slots"

    @property
    def env_path(self) -> Path:
        return self.root / "Storage" / ".env"

    def _get(self, url: str, headers: Mapping[str, str] | None = None) -> Any:
        request = urllib.request.Request(url, headers=dict(headers or {}))
        with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))

    def options_modes(self) -> Sequence[str] | None:
        try:
            body = self._get(
                f"{self.wixy_url}/api/admin/server/cookout/options",
                {"X-Wixy-Server-Token": self.token},
            )
        except urllib.error.URLError, OSError, ValueError:
            return None
        modes = body.get("modes") if isinstance(body, dict) else None
        if not isinstance(modes, list):
            return []
        return [str(m.get("id")) for m in modes if isinstance(m, dict)]

    def _devfleet_running(self) -> bool | None:
        try:
            status = self._get(f"{self.devfleet_url}/status")
        except urllib.error.URLError, OSError, ValueError:
            return None
        for service in status.get("services", []) if isinstance(status, dict) else []:
            if isinstance(service, dict) and str(service.get("name", "")).lower() == "wixy":
                return str(service.get("status", "")).lower() == "running"
        return False

    def _active_slot(self) -> str | None:
        try:
            text = (self.root / "active.txt").read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return text if text in ("blue", "green") else None

    def _slot_schema(self, slot: str) -> int | None:
        try:
            text = (self.slots_dir / slot / STORE_RELPATH).read_text(encoding="utf-8")
        except OSError:
            return None
        found = _VERSION_RE.search(text)
        return int(found.group(1)) if found else None

    def _db_paths(self) -> list[Path]:
        return sorted((self.root / "Storage" / "projects").glob("*/server/server.db"))

    def _db_versions(self) -> list[int]:
        versions: list[int] = []
        for path in self._db_paths():
            conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
            try:
                versions.append(int(conn.execute("PRAGMA user_version").fetchone()[0]))
            finally:
                conn.close()
        return versions

    def _processes(self) -> list[ProcessInfo]:
        script = (
            "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,ExecutablePath "
            "| ConvertTo-Json -Compress"
        )
        result = subprocess.run(  # noqa: S603
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],  # noqa: S607
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
            check=False,
        )
        try:
            rows = json.loads(result.stdout or "[]")
        except ValueError:
            return []
        if isinstance(rows, dict):
            rows = [rows]
        out: list[ProcessInfo] = []
        for row in rows:
            command = " ".join(str(row.get(k) or "") for k in ("CommandLine", "ExecutablePath"))
            out.append(ProcessInfo(int(row.get("ProcessId") or 0), command, _cwd_of(row)))
        return out

    def gather(self) -> Facts:
        slots = {slot: self._slot_schema(slot) for slot in ("blue", "green")}
        return Facts(
            devfleet_wixy_running=self._devfleet_running(),
            active_slot=self._active_slot(),
            slot_schema=slots,
            db_versions=self._db_versions(),
            processes=self._processes(),
            options_modes=self.options_modes(),
        )

    def read_env(self) -> str:
        try:
            return self.env_path.read_bytes().decode("utf-8")
        except FileNotFoundError:
            return ""

    def write_env(self, text: str) -> None:
        self.env_path.write_bytes(text.encode("utf-8"))

    def bounce(self) -> None:
        request = urllib.request.Request(f"{self.devfleet_url}/restart/Wixy", method="POST")
        with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310
            response.read()
        import time

        deadline = time.time() + 120
        while time.time() < deadline:
            if self.options_modes() is not None:
                return
            time.sleep(2)
        raise RuntimeError("Wixy did not answer within 120 s of the restart")

    def rollback_target_schema(self, commit: str) -> int | None:
        result = subprocess.run(  # noqa: S603
            ["git", "-C", str(self.repo), "show", f"{commit}:{STORE_RELPATH}"],  # noqa: S607
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
            check=False,
        )
        found = _VERSION_RE.search(result.stdout)
        return int(found.group(1)) if found else None

    def non_classic_round_count(self) -> int:
        total = 0
        for path in self._db_paths():
            conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
            try:
                columns = {r[1] for r in conn.execute("PRAGMA table_info(cookout_rounds)")}
                if "mode" not in columns:
                    continue  # still v21: every round is Classic
                total += int(
                    conn.execute(
                        "SELECT COUNT(*) FROM cookout_rounds WHERE mode != 'classic'"
                    ).fetchone()[0]
                )
            finally:
                conn.close()
        return total


def _cwd_of(row: Mapping[str, Any]) -> str:
    """A process's working directory when `psutil` is installed (the command line alone misses a
    process started with a relative path); empty otherwise."""
    try:
        psutil: Any = importlib.import_module("psutil")
        return str(psutil.Process(int(row.get("ProcessId") or 0)).cwd())
    except Exception:  # noqa: BLE001 - best effort: access denied, gone, or psutil missing
        return ""


def main(argv: Sequence[str] | None = None, probe: Probe | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--enable", metavar="MODE")
    group.add_argument("--disable", metavar="MODE")
    group.add_argument("--check-rollback", metavar="COMMIT")
    parser.add_argument(
        "--root", default=str(Path(os.environ.get("AIM_ROOT", "D:\\")) / "Servers" / "Wixy")
    )
    parser.add_argument("--repo", default=".")
    parser.add_argument("--token", default=os.environ.get("WIXY_SERVER_TOKEN", ""))
    args = parser.parse_args(argv)
    root = Path(args.root)
    machine = probe or MachineProbe(root=root, repo=Path(args.repo), token=args.token)
    if args.check_rollback:
        return check_rollback(machine, args.check_rollback)
    if args.disable:
        return disable(machine, args.disable.strip().lower())
    return enable(machine, args.enable.strip().lower(), slots_root=str(root / "Slots"))


if __name__ == "__main__":
    sys.exit(main())
