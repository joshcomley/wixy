"""Wixy deploy hooks — thin wrapper around ``slot_swap_deploy`` (spec/07-hosting-deploy.md
§1, modeled on ``D:\\Servers\\Smartbell\\deploy.py`` per
``D:\\Servers\\Slots\\Slots\\green\\docs\\ai\\onboarding.md``). Slots' executor imports this
module (from the INACTIVE slot's own checkout) and calls the hooks / build-step runners
named in ``slots.wixy.yaml``. Wixy wires:

  * ``pre_validate`` — git fetch + reset --hard FETCH_HEAD into the inactive slot;
    raises DeployError (short-circuits, not a real failure) when origin/main hasn't
    moved, or when this exact sha was already attempted (retry-storm guard).
  * build ``pip install`` — rebuilds ``<slot>/.venv`` from the pythoncore-3.14
    interpreter (built OUT OF PLACE at ``.venv.new`` then swapped in atomically —
    never an in-place rmtree of the live venv, see ``_atomic_swap_dir``), installs
    the pinned ``requirements.txt``, then the ``wixy`` package itself ``--no-deps``
    (spec/07 §1: "per-slot .venv... pinned requirements.txt" — a rollback-safe
    per-slot isolation; no npm step, frontend bundles are COMMITTED so deploys stay
    pip-only, spec/07 §1).
  * build ``TestClient validate`` — boots the slot's app in a subprocess (isolated
    throwaway Storage dir) and asserts /healthz is 200 OK.
  * ``post_swap`` — mirror launcher.py + deploy.py to the install root.
  * ``post_restart`` — /healthz probe + self-update mtime-watch.

Usage (manual operator use only — Slots drives the chain in production)::

    python deploy.py --poll       # long-running poll loop
    python deploy.py --rollback   # swap to other slot, restart
    python deploy.py --status     # current slot + git HEADs
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

# ---------------------------------------------------------------------------
# Deferred slot_swap_deploy import (cold-start bootstrap deadlock fix)
# ---------------------------------------------------------------------------
#
# This module is imported in TWO ways: (1) ``python deploy.py --poll`` drives the
# blue/green orchestration via make_deploy(); (2) Slots' executor imports it IN A
# SUBPROCESS purely to call the build-step runners (_pip_install_venv /
# _testclient_validate; see slots.wixy.yaml). A MODULE-TOP import of
# slot_swap_deploy (or devfleet_deploy_shim, which imports it) would make
# ``import deploy`` fail if that package is ever missing/half-installed on the
# orchestrator interpreter BEFORE the build step that could fix it even runs — the
# exact executor-stuck deadlock other consumers hit (see cor's own deploy.py). Fix:
# keep the build-step runners importable WITHOUT slot_swap_deploy; the import is
# deferred into _load_slot_swap(), called only from make_deploy (the --poll path).


class DeployError(RuntimeError):
    """Local fallback so the build-step runners stay importable on a cold
    interpreter without slot_swap_deploy. ``_load_slot_swap()`` rebinds this to
    the real ``slot_swap_deploy.DeployError`` for the --poll path.

    Reserved EXCLUSIVELY for the library's documented graceful-skip signal
    (``pre_validate``'s "nothing to deploy" / already-attempted-sha cases) — the
    executor (``hook_runner.run_build_step``/``make_hook_invoker``) special-cases
    this exact exception type and treats it as a benign no-op, not a failure.
    A build step or any OTHER hook raising this for a genuine error would have
    that error silently swallowed as "nothing to deploy" — use BuildStepError
    below for every real failure."""


class BuildStepError(RuntimeError):
    """A build step genuinely failed. Deliberately NOT DeployError — raising
    DeployError from a build step gets the library's graceful-skip treatment
    (silently treated as "nothing to deploy" rather than a loud failure), which
    is correct ONLY for pre_validate's own no-op case, never for an actual
    pip-install/validate failure."""


# Bound lazily by _load_slot_swap(); only the --poll path uses them.
BuildStep = Deploy = LifecycleHooks = RestartStrategy = Service = deploy_cli = None


def _load_slot_swap() -> None:
    """Import slot_swap_deploy (+ the devfleet restart shim) and bind the
    orchestration symbols as module globals. Required only for ``--poll``."""
    global BuildStep, Deploy, DeployError, LifecycleHooks
    global RestartStrategy, Service, deploy_cli

    try:
        import devfleet_deploy_shim  # noqa: F401
    except ImportError:
        sys.path.insert(0, r"D:\Servers\Devfleet\scripts")
        try:
            import devfleet_deploy_shim  # noqa: F401
        except ImportError:
            print(
                "[wixy] devfleet shim unavailable — using raw NSSM strategy",
                flush=True,
            )

    from slot_swap_deploy import (
        BuildStep,
        Deploy,
        DeployError,
        LifecycleHooks,
        RestartStrategy,
        Service,
        deploy_cli,
    )


_HERE = Path(__file__).resolve().parent
if (_HERE / "active.txt").exists():
    WIXY_ROOT = _HERE
else:
    WIXY_ROOT = _HERE.parent.parent  # imported from Slots\<colour>\deploy.py

ACTIVE_FILE = WIXY_ROOT / "active.txt"
SLOTS_DIR = WIXY_ROOT / "Slots"
STORAGE_DIR = WIXY_ROOT / "Storage"
ENV_FILE = STORAGE_DIR / ".env"
ROOT_FILES = ("launcher.py", "deploy.py")

DEFAULT_REPO = os.environ.get(
    "WIXY_REPO_URL", "https://x-access-token@github.com/joshcomley/wixy.git"
)
DEFAULT_PORT = int(os.environ.get("WIXY_PORT", "9380"))
HEALTH_URL = f"http://localhost:{DEFAULT_PORT}/healthz"

SERVICE_NAME = "Wixy"

# %LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe — resolved, never a hardcoded
# username (differs per box: josh vs joshc, global CLAUDE.md).
_CANONICAL_PYTHON = str(
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    / "Python"
    / "pythoncore-3.14-64"
    / "python.exe"
)

GIT_TIMEOUT_S = 60.0
VENV_CREATE_TIMEOUT_S = 120.0
PIP_TIMEOUT_S = 400.0  # pinned deps incl. cryptography/playwright — generous headroom
TESTCLIENT_TIMEOUT_S = 60.0
HEALTH_PROBE_TIMEOUT_S = 5.0
HEALTH_PROBE_TRIES = 12
HEALTH_PROBE_INTERVAL_S = 2.5

_EXTRA_PATHS = os.pathsep.join(
    [
        r"C:\Program Files\Git\cmd",
        r"C:\Program Files\GitHub CLI",
    ]
)


def _augmented_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = _EXTRA_PATHS + os.pathsep + env.get("PATH", "")
    if "HOME" not in env:
        env["HOME"] = env.get("USERPROFILE", str(Path.home()))
    env.setdefault("USERPROFILE", str(Path.home()))
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


def _run_git(args: list[str], cwd: Path, timeout: float = GIT_TIMEOUT_S) -> tuple[int, str]:
    try:
        result = subprocess.run(
            ["git", "-c", "credential.helper=", "-c", "safe.directory=*", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            env=_augmented_env(),
        )
    except subprocess.TimeoutExpired:
        return 124, f"[git timed out after {timeout}s] {' '.join(args)}"
    return result.returncode, (result.stdout or "") + (result.stderr or "")


def _slot_head(slot_dir: Path) -> str | None:
    code, out = _run_git(["rev-parse", "HEAD"], cwd=slot_dir)
    return out.strip() if code == 0 else None


def _active_colour() -> str:
    return ACTIVE_FILE.read_text(encoding="utf-8").strip()


def _inactive_colour() -> str:
    return "green" if _active_colour() == "blue" else "blue"


_LAST_ATTEMPTED_REMOTE_SHA: str | None = None


def pre_validate(_ctx: dict) -> None:
    global _LAST_ATTEMPTED_REMOTE_SHA
    inactive = _inactive_colour()
    inactive_dir = SLOTS_DIR / inactive
    active_dir = SLOTS_DIR / _active_colour()

    code, out = _run_git(["fetch", DEFAULT_REPO, "main"], cwd=inactive_dir)
    if code != 0:
        raise DeployError(f"git fetch failed: {out.strip()[:300]}")
    code, out = _run_git(["reset", "--hard", "FETCH_HEAD"], cwd=inactive_dir)
    if code != 0:
        raise DeployError(f"reset --hard FETCH_HEAD failed in {inactive}: {out.strip()[:300]}")

    new = _slot_head(inactive_dir)
    active_head = _slot_head(active_dir)
    if new is None or active_head is None:
        raise DeployError("could not resolve slot HEADs")
    if new == active_head:
        raise DeployError(f"nothing to deploy (HEAD == active {new[:8]})")
    if new == _LAST_ATTEMPTED_REMOTE_SHA:
        raise DeployError(f"skipping retry on already-attempted sha {new[:8]}")
    _LAST_ATTEMPTED_REMOTE_SHA = new
    print(f"[wixy] {inactive}: {active_head[:8]} -> {new[:8]}; building", flush=True)


# ---------------------------------------------------------------------------
# Build steps: per-slot venv (rollback-safe isolation, spec/07 §1)
# ---------------------------------------------------------------------------


def _venv_python(slot: Path) -> Path:
    return slot / ".venv" / "Scripts" / "python.exe"


def _atomic_swap_dir(new_dir: Path, live_dir: Path) -> None:
    """Rename `new_dir` into `live_dir`'s place. NEVER rmtree's `live_dir` in
    place — see `_pip_install_venv`'s own docstring for the exact failure this
    avoids (a real, previously-hit fleet outage class). Renaming the OLD dir
    aside first (never deleting it in this process) succeeds even with its own
    interpreter's binary open inside it — Windows keeps an open file handle
    valid via the underlying file object regardless of a path rename of its
    containing directory; only an actual DELETE of the open file itself is
    refused. If `live_dir` genuinely can't be renamed (held open in some other,
    non-renameable way), this raises and `live_dir` is left completely
    untouched — a clean failure, never a half-deleted venv."""
    if live_dir.exists():
        stale = live_dir.with_name(f"{live_dir.name}.old.{os.getpid()}.{int(time.time())}")
        live_dir.rename(stale)
    new_dir.rename(live_dir)


def _run_or_raise(args: list[str], *, cwd: Path, timeout: float, label: str) -> None:
    result = subprocess.run(
        args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=_augmented_env(),
    )
    if result.returncode != 0:
        raise BuildStepError(f"{label} failed: {(result.stdout + result.stderr)[-800:]!r}")


def _pip_install_venv(slot: Path) -> None:
    """Rebuilds ``<slot>/.venv`` FRESH (never reused across deploys — a rollback to
    the OTHER slot keeps ITS OWN independently-built venv completely untouched, and
    this slot never inherits a stale package from a previous build). Installs the
    pinned ``requirements.txt`` first, then the ``wixy`` package itself ``--no-deps``
    (every runtime dependency is already pinned+installed by that point — this step
    is purely "make `import wixy_server` resolve," never a second, un-pinned
    dependency resolution).

    Builds OUT OF PLACE at ``<slot>/.venv.new`` and swaps it in atomically at the
    end — NEVER ``rmtree``'s the live ``.venv`` directly. Found the hard way: the
    build step's OWN interpreter is resolved by Slots' executor via
    ``find_slot_python(slot)``, which prefers the slot's EXISTING venv when one is
    already there (true for every real redeploy, since the venv only doesn't exist
    on the very first build) — so an in-place ``rmtree(<slot>/.venv)`` tries to
    delete the very ``python.exe`` currently interpreting this function, which
    Windows refuses (``PermissionError: [WinError 5] Access is denied``). This is
    the exact same failure class `D:\\Slots\\self`'s own ``run_pip_install`` docstring
    documents as a real prior fleet outage (2026-05-25: an in-place rmtree of a
    still-running slot's venv left an empty ``click/`` dir → import crash → dead
    orchestrator) — confirmed via Slots' own ``executor_outcomes`` table after a
    live deploy exit-looped on exactly this, not assumed from reading the docstring
    first. Renaming the OLD `.venv` aside (never deleting it in THIS process) works
    even with its own interpreter's binary open inside it — Windows keeps an open
    handle valid via the file's underlying object even after its containing
    directory is renamed."""
    venv_new = slot / ".venv.new"
    if venv_new.exists():
        shutil.rmtree(venv_new)  # leftover from a prior failed attempt; nothing
        # ever runs FROM .venv.new, so deleting it here is always safe.
    print(f"[wixy] creating venv at {venv_new}", flush=True)
    _run_or_raise(
        [_CANONICAL_PYTHON, "-m", "venv", str(venv_new)],
        cwd=slot,
        timeout=VENV_CREATE_TIMEOUT_S,
        label="venv creation",
    )

    venv_new_python = str(venv_new / "Scripts" / "python.exe")
    req = slot / "requirements.txt"
    print(f"[wixy] pip install -r {req}", flush=True)
    _run_or_raise(
        [venv_new_python, "-m", "pip", "install", "-r", str(req)],
        cwd=slot,
        timeout=PIP_TIMEOUT_S,
        label="pip install -r requirements.txt",
    )

    print("[wixy] pip install --no-deps . (the wixy package itself)", flush=True)
    _run_or_raise(
        [venv_new_python, "-m", "pip", "install", "--no-deps", "."],
        cwd=slot,
        timeout=PIP_TIMEOUT_S,
        label="pip install --no-deps .",
    )

    venv_dir = slot / ".venv"
    print(f"[wixy] swapping {venv_new.name} -> {venv_dir.name}", flush=True)
    _atomic_swap_dir(venv_new, venv_dir)
    print(f"[wixy] venv ready for {slot.name}", flush=True)


def _testclient_validate(slot: Path) -> None:
    env = _augmented_env()
    env["WIXY_DEV_NO_AUTH"] = "1"
    env["WIXY_ENV"] = "dev"
    # Isolate the validate from prod runtime data: a throwaway Storage dir inside
    # the slot, deleted after — this only proves the app BOOTS (fastapi wiring +
    # settings + registry all load cleanly), not that a real publish would succeed
    # (that's what a real deploy's smoke probes against the swapped-in slot check).
    validate_storage = slot / ".deploy-validate-storage"
    env["WIXY_STORAGE_ROOT"] = str(validate_storage)
    snippet = (
        "from pathlib import Path\n"
        "from fastapi.testclient import TestClient\n"
        "from wixy_server.app import create_app\n"
        f"app = create_app(storage_root=Path(r'{validate_storage}'), "
        f"wixy_repo_root=Path(r'{slot}'))\n"
        "with TestClient(app) as c:\n"
        "    r = c.get('/healthz')\n"
        "    assert r.status_code == 200, f'healthz: {r.status_code} {r.text[:200]}'\n"
        "print('OK')\n"
    )
    try:
        result = subprocess.run(
            [str(_venv_python(slot)), "-c", snippet],
            cwd=str(slot),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TESTCLIENT_TIMEOUT_S,
            env=env,
        )
    finally:
        shutil.rmtree(validate_storage, ignore_errors=True)
    if result.returncode != 0 or "OK" not in result.stdout:
        raise BuildStepError(
            f"TestClient validate failed for {slot.name}: "
            f"stdout={result.stdout[:300]!r} stderr={result.stderr[:600]!r}"
        )
    print(f"[wixy] TestClient validate passed for {slot.name}", flush=True)


def post_swap(ctx: dict) -> None:
    new_active = ctx.get("new_active") or _active_colour()
    src_dir = SLOTS_DIR / new_active
    for fname in ROOT_FILES:
        src = src_dir / fname
        if not src.exists():
            continue
        dst = WIXY_ROOT / fname
        try:
            if dst.exists() and src.read_bytes() == dst.read_bytes():
                continue
            dst.write_bytes(src.read_bytes())
            shutil.copystat(str(src), str(dst))
            print(f"[wixy] mirrored {fname} <- {new_active}", flush=True)
        except OSError as exc:
            print(f"[wixy] WARNING: failed to mirror {fname}: {exc}", flush=True)


_DEPLOY_PY_AT_ROOT = WIXY_ROOT / "deploy.py"
try:
    _DEPLOY_PY_MTIME_AT_START = _DEPLOY_PY_AT_ROOT.stat().st_mtime
except OSError:
    _DEPLOY_PY_MTIME_AT_START = 0.0

_HEALTH_PROBED_THIS_CYCLE = False


def _probe_health() -> bool:
    for _ in range(HEALTH_PROBE_TRIES):
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=HEALTH_PROBE_TIMEOUT_S) as resp:
                if resp.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(HEALTH_PROBE_INTERVAL_S)
    return False


def post_restart(ctx: dict, svc: Service) -> None:
    global _HEALTH_PROBED_THIS_CYCLE
    if svc.name == SERVICE_NAME and not _HEALTH_PROBED_THIS_CYCLE:
        _HEALTH_PROBED_THIS_CYCLE = True
        if _probe_health():
            print(f"[wixy] /healthz 200 OK after {svc.name} restart", flush=True)
        else:
            print(
                f"[wixy] WARNING: /healthz did not respond after {svc.name} "
                f"restart; consider `python deploy.py --rollback`.",
                flush=True,
            )
            ctx.setdefault("doctor_events", []).append(("wixy", "health_post_restart_no_response"))
    try:
        current = _DEPLOY_PY_AT_ROOT.stat().st_mtime
    except OSError:
        return
    if current > _DEPLOY_PY_MTIME_AT_START + 0.5:
        print("[wixy] WIXY_ROOT/deploy.py mtime advanced; exiting for respawn", flush=True)
        sys.exit(0)


def _reset_per_cycle_state(_ctx: dict) -> None:
    global _HEALTH_PROBED_THIS_CYCLE
    _HEALTH_PROBED_THIS_CYCLE = False


def make_deploy() -> Deploy:
    _load_slot_swap()  # bind BuildStep/Deploy/Service/... for the --poll path
    services = (
        Service(
            name=SERVICE_NAME,
            restart_strategy=RestartStrategy.NSSM_RESTART,
            force_kill_host=True,
            port=DEFAULT_PORT,
        ),
    )
    build_steps = (
        BuildStep(
            name="pip install (per-slot venv)",
            runner=_pip_install_venv,
            required_tools=["pip"],
        ),
        BuildStep(
            name="TestClient subprocess validate",
            runner=_testclient_validate,
            required_tools=[],
        ),
    )
    return Deploy(
        install_root=WIXY_ROOT,
        repo_url=DEFAULT_REPO,
        services=services,
        slots=("blue", "green"),
        build_steps=build_steps,
        verify_paths=(),
        verify_base_url=None,
        hooks=LifecycleHooks(
            pre_validate=pre_validate,
            pre_swap=_reset_per_cycle_state,
            post_swap=post_swap,
            post_restart=post_restart,
        ),
    )


def main(argv: list[str] | None = None) -> int:
    deploy = make_deploy()
    return deploy_cli(deploy, argv=argv if argv is not None else sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
