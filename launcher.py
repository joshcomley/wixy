"""Wixy launcher — the fixed Devfleet entrypoint (spec/07-hosting-deploy.md §1-2).

Devfleet's `services.toml` argv never changes (`pythoncore-3.14-64\\python.exe
D:\\Servers\\Wixy\\launcher.py`, no subcommand) — this file reads `active.txt`, sets the
env the app needs, then runs the ACTIVE SLOT'S OWN venv interpreter as a CHILD process
(`python -m wixy_server`), blocking until it exits and propagating its exit code. The app
itself never runs in THIS process's interpreter, so each slot's dependencies stay isolated
(a blue install can't see green's freshly-`pip install`ed packages, and vice versa) and a
swap takes effect on the very next restart with no code in this file needing to change.

**Deliberately a blocking child subprocess, NOT `os.execv`** — found via a real deploy,
not assumed: `os.execv` on Windows does not replace the current process image the way
POSIX `execve` does. It spawns a genuinely separate process and lets THIS process return/
exit, which orphans the new process from Devfleet's own process-tracking (a Windows Job
Object) — Devfleet observed launcher.py's own PID exit immediately (code 0) and killed the
job, taking the execv'd uvicorn child down with it mid-startup, over and over
(`restart_count_total` climbing with no actual uptime). A plain child `subprocess.run`
keeps THIS process (the one Devfleet's job actually owns) alive for the server's entire
lifetime, so the child is correctly supervised — killed cleanly on a Devfleet restart,
staying up otherwise.

Lives OUTSIDE the slots (`D:\\Servers\\Wixy\\launcher.py`) so flipping `active.txt` +
restarting the Devfleet child is the only step a swap needs. Refreshed from the newly
active slot on every deploy (`deploy.py`'s `post_swap`), per the fleet's standard
blue/green pattern (`D:\\Servers\\Slots\\Slots\\green\\docs\\ai\\onboarding.md` §2c).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

WIXY_ROOT = Path(__file__).resolve().parent
ACTIVE_FILE = WIXY_ROOT / "active.txt"
SLOTS_DIR = WIXY_ROOT / "Slots"
STORAGE_DIR = WIXY_ROOT / "Storage"


def _resolve_slot() -> tuple[str, Path]:
    if not ACTIVE_FILE.exists():
        print(f"FATAL: {ACTIVE_FILE} not found", file=sys.stderr)
        sys.exit(1)
    slot = ACTIVE_FILE.read_text(encoding="utf-8").strip()
    slot_dir = SLOTS_DIR / slot
    if not slot_dir.exists():
        print(f"FATAL: slot directory {slot_dir} not found", file=sys.stderr)
        sys.exit(1)
    return slot, slot_dir


def main() -> None:
    slot, slot_dir = _resolve_slot()

    # No content paths inside slots (spec/04 §2) — all runtime state lives in the shared
    # Storage\ dir so a blue/green swap never strands data or forces a cold rebuild.
    # setdefault everywhere so an outer override (Devfleet's own services.toml env
    # block, or a manual `WIXY_PORT=... python launcher.py` invocation) always wins.
    os.environ.setdefault("WIXY_STORAGE_ROOT", str(STORAGE_DIR))
    os.environ.setdefault("WIXY_PORT", "9380")
    os.environ.setdefault("WIXY_ENV", "prod")
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    # Always the freshly-resolved slot, never inherited — backs /api/version's `slot`
    # field (spec/07 §1), so a stale WIXY_SLOT in the outer environment can never
    # mislead the anti-stale deploy-awareness check.
    os.environ["WIXY_SLOT"] = slot

    venv_python = slot_dir / ".venv" / "Scripts" / "python.exe"
    if not venv_python.exists():
        print(f"FATAL: slot venv interpreter {venv_python} not found", file=sys.stderr)
        sys.exit(1)

    print(f"Wixy launcher: slot={slot} dir={slot_dir} python={venv_python}", flush=True)
    os.chdir(slot_dir)
    # Inherits this process's stdout/stderr (Devfleet captures those, not a pipe of
    # our own) — no capture_output/PIPE here, or uvicorn's own logs would vanish.
    result = subprocess.run([str(venv_python), "-m", "wixy_server"])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
