"""Wixy idempotent first-install (spec/07-hosting-deploy.md §1). Creates the blue/green
Slots layout under `D:\\Servers\\Wixy\\` (derived from `%AIM_ROOT%\\Servers`, never a
hardcoded drive), clones the wixy engine repo into both slots, builds each slot's own
venv, activates blue, seeds `Storage\\.env` (copying the CF_* provisioning credentials
from `D:\\Servers\\Loom\\.env`, spec/07 §3), clones the site repo the registry names, and
bootstraps serving — builds origin/main HEAD and publishes it as version 0 — so
ca.cinnamons.uk has something to serve immediately (spec/07 §1: "the server also
self-bootstraps this way on first startup," but running it here too means the very
first request after install doesn't have to wait for that).

Every step checks before acting, so re-running this script is always safe: an already-
cloned slot is left untouched (ownership passes to Slots/deploy.py once registered, see
the follow-ups this script prints at the end), an existing venv isn't rebuilt, an
existing `active.txt`/`Storage\\.env` is never overwritten.

Does NOT touch Devfleet/Slots/Cloudflare registration (spec/07 §2-3) — those are printed
as follow-up steps, not run by this script (a `D:\\Servers\\Wixy\\` that isn't registered
anywhere yet is a safe, inert state to leave for an operator/agent to review before it
starts receiving traffic or deploy cycles).

Usage:
    python install.py [--wixy-repo-url URL] [--skip-venv]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_WIXY_REPO_URL = "https://x-access-token@github.com/joshcomley/wixy.git"
LOOM_ENV_FILE = Path(r"D:\Servers\Loom\.env")
_CF_KEYS = ("CF_API_TOKEN", "CF_ACCESS_TOKEN", "CF_ZONE_ID", "CF_ACCOUNT_ID", "CF_TUNNEL_ID")

GIT_TIMEOUT_S = 120.0
VENV_CREATE_TIMEOUT_S = 120.0
PIP_TIMEOUT_S = 400.0
BOOTSTRAP_TIMEOUT_S = 60.0


def _install_root() -> Path:
    aim_root = os.environ.get("AIM_ROOT", "D:\\")
    return Path(aim_root) / "Servers" / "Wixy"


def _canonical_python() -> str:
    local_app_data = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
    return str(Path(local_app_data) / "Python" / "pythoncore-3.14-64" / "python.exe")


def _run(args: list[str], *, cwd: Path | None = None, timeout: float, label: str) -> None:
    print(f"[install] {label}: {' '.join(args)}", flush=True)
    result = subprocess.run(
        args,
        cwd=str(cwd) if cwd is not None else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{label} failed:\n{result.stdout}\n{result.stderr}")


def _clone_slot_if_missing(slot_dir: Path, repo_url: str) -> None:
    if (slot_dir / ".git").exists():
        print(f"[install] {slot_dir} already a git checkout — leaving it alone", flush=True)
        return
    slot_dir.parent.mkdir(parents=True, exist_ok=True)
    _run(
        ["git", "clone", "--branch", "main", repo_url, str(slot_dir)],
        timeout=GIT_TIMEOUT_S,
        label=f"clone into {slot_dir.name}",
    )


def _build_venv_if_missing(slot_dir: Path) -> None:
    venv_dir = slot_dir / ".venv"
    if (venv_dir / "Scripts" / "python.exe").exists():
        print(f"[install] {venv_dir} already built — skipping", flush=True)
        return
    _run(
        [_canonical_python(), "-m", "venv", str(venv_dir)],
        timeout=VENV_CREATE_TIMEOUT_S,
        label=f"create venv for {slot_dir.name}",
    )
    venv_python = str(venv_dir / "Scripts" / "python.exe")
    req = slot_dir / "requirements.txt"
    _run(
        [venv_python, "-m", "pip", "install", "-r", str(req)],
        cwd=slot_dir,
        timeout=PIP_TIMEOUT_S,
        label=f"pip install -r requirements.txt ({slot_dir.name})",
    )
    _run(
        [venv_python, "-m", "pip", "install", "--no-deps", "."],
        cwd=slot_dir,
        timeout=PIP_TIMEOUT_S,
        label=f"pip install --no-deps . ({slot_dir.name})",
    )


def _write_active_txt_if_missing(install_root: Path) -> None:
    active_file = install_root / "active.txt"
    if active_file.exists():
        print(
            f"[install] {active_file} already exists ({active_file.read_text().strip()!r})"
            " — leaving it alone",
            flush=True,
        )
        return
    active_file.write_text("blue", encoding="utf-8")
    print(f"[install] wrote {active_file} = blue", flush=True)


def _mirror_root_files(install_root: Path, active_slot_dir: Path) -> None:
    for fname in ("launcher.py", "deploy.py"):
        src = active_slot_dir / fname
        if not src.exists():
            continue
        dst = install_root / fname
        if dst.exists() and dst.read_bytes() == src.read_bytes():
            continue
        dst.write_bytes(src.read_bytes())
        print(f"[install] mirrored {fname} from {active_slot_dir.name}", flush=True)


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def _seed_storage_env_if_missing(storage_dir: Path) -> None:
    env_file = storage_dir / ".env"
    if env_file.exists():
        print(f"[install] {env_file} already exists — leaving it alone", flush=True)
        return

    loom_values = _parse_env_file(LOOM_ENV_FILE)
    missing = [k for k in _CF_KEYS if k not in loom_values]
    if missing:
        print(
            f"[install] WARNING: {LOOM_ENV_FILE} is missing {missing} — the Cloudflare "
            "provisioning script (spec/07 §3) will need these filled in by hand before it "
            "can run",
            flush=True,
        )

    lines = [
        "# Seeded by install.py (spec/07 §1). WIXY_PORT/WIXY_ENV are also set by",
        "# launcher.py itself (setdefault) — listed here for operator visibility only.",
        "WIXY_PORT=9380",
        "WIXY_ENV=prod",
        "",
        "# Filled in by tooling/provision_ca_cloudflare.py once the Access app exists",
        "# (spec/07 §3) — the JWT middleware (spec/04 §9) consumes these two.",
        "WIXY_CF_TEAM_DOMAIN=",
        "WIXY_CF_ACCESS_AUD=",
        "",
        "# Copied from D:\\Servers\\Loom\\.env at install time (spec/07 §3) — used only by",
        "# tooling/provision_ca_cloudflare.py, never read by the running server itself.",
    ]
    for key in _CF_KEYS:
        lines.append(f"{key}={loom_values.get(key, '')}")
    storage_dir.mkdir(parents=True, exist_ok=True)
    env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[install] seeded {env_file}", flush=True)


def _load_single_project_json(slot_dir: Path) -> dict[str, object]:
    project_files = sorted((slot_dir / "projects").glob("*.json"))
    if len(project_files) != 1:
        raise RuntimeError(
            f"expected exactly one projects/*.json in {slot_dir}, found {len(project_files)}"
        )
    data: dict[str, object] = json.loads(project_files[0].read_text(encoding="utf-8"))
    return data


def _clone_site_repo_if_missing(site_repo_dir: Path, repo_url: str, branch: str) -> None:
    if (site_repo_dir / ".git").exists():
        print(f"[install] {site_repo_dir} already a git checkout — leaving it alone", flush=True)
        return
    site_repo_dir.parent.mkdir(parents=True, exist_ok=True)
    _run(
        ["git", "clone", "--branch", branch, repo_url, str(site_repo_dir)],
        timeout=GIT_TIMEOUT_S,
        label=f"clone site repo into {site_repo_dir}",
    )


def _bootstrap_serving(active_slot_dir: Path, storage_dir: Path, slug: str) -> None:
    """Shells out to the ACTIVE SLOT'S OWN venv python (the wixy package is only
    importable there, never from install.py's own system interpreter) to run the real
    `wixy_server.bootstrap.bootstrap_if_needed` — the exact same function the server
    calls on every startup, so this is a preview of that behavior, not a separate
    reimplementation of it."""
    venv_python = active_slot_dir / ".venv" / "Scripts" / "python.exe"
    snippet = (
        "from datetime import UTC, datetime\n"
        "from pathlib import Path\n"
        "from builder.config import load_all_projects\n"
        "from wixy_server.bootstrap import bootstrap_if_needed\n"
        "from wixy_server.storage import ensure_project_dirs, project_paths\n"
        f"projects = load_all_projects(Path(r'{active_slot_dir}') / 'projects')\n"
        f"project = projects[{slug!r}]\n"
        f"paths = project_paths(Path(r'{storage_dir}'), {slug!r})\n"
        "ensure_project_dirs(paths)\n"
        "did_bootstrap = bootstrap_if_needed(project, paths, datetime.now(UTC).isoformat())\n"
        "print('BOOTSTRAPPED' if did_bootstrap else 'ALREADY-LIVE-OR-NOT-READY')\n"
    )
    result = subprocess.run(
        [str(venv_python), "-c", snippet],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=BOOTSTRAP_TIMEOUT_S,
    )
    if result.returncode != 0:
        print(
            f"[install] WARNING: bootstrap-serving step failed (non-fatal — the server "
            f"retries this on every startup too):\n{result.stdout}\n{result.stderr}",
            flush=True,
        )
        return
    print(f"[install] bootstrap-serving: {result.stdout.strip()}", flush=True)


def _print_followups(install_root: Path, port: int) -> None:
    print(
        f"""
[install] Repo-side install complete at {install_root}.

Still needed (spec/07 §2-3, NOT done by this script):

  1. Devfleet child — append to D:\\Servers\\Devfleet\\supervisor\\services.toml:
       [services.Wixy]
       cwd  = "{install_root}"
       argv = ["<pythoncore-3.14>\\\\python.exe", "{install_root}\\\\launcher.py"]
       port = {port}
       health = "http://127.0.0.1:{port}/healthz"
       restart = "always"
     then POST http://127.0.0.1:9999/reload and confirm Wixy healthy in /status.

  2. Slots consumer — add to D:\\Servers\\Slots\\Storage\\config\\consumers.json
     (name "wixy", install_root "{install_root}", base_url
     "http://127.0.0.1:{port}", slots_yaml_path "slots.wixy.yaml"), then
     POST http://127.0.0.1:9999/restart/Slots.

  3. Cloudflare (elevated — admin gate): DNS CNAME, tunnel ingress config, restart
     Cloudflared, create the "Wixy Admin (ca)" Access app scoped to /admin +
     /api/admin only. Run tooling/provision_ca_cloudflare.py for this.
""",
        flush=True,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wixy-repo-url", default=DEFAULT_WIXY_REPO_URL)
    parser.add_argument(
        "--skip-venv", action="store_true", help="skip venv build (useful for a dry structural run)"
    )
    args = parser.parse_args(argv)

    install_root = _install_root()
    slots_dir = install_root / "Slots"
    storage_dir = install_root / "Storage"
    blue_dir = slots_dir / "blue"
    green_dir = slots_dir / "green"

    print(f"[install] install root: {install_root}", flush=True)
    slots_dir.mkdir(parents=True, exist_ok=True)
    storage_dir.mkdir(parents=True, exist_ok=True)

    _clone_slot_if_missing(blue_dir, args.wixy_repo_url)
    _clone_slot_if_missing(green_dir, args.wixy_repo_url)

    if not args.skip_venv:
        _build_venv_if_missing(blue_dir)
        _build_venv_if_missing(green_dir)

    _write_active_txt_if_missing(install_root)
    active_colour = (install_root / "active.txt").read_text(encoding="utf-8").strip()
    active_slot_dir = slots_dir / active_colour

    _mirror_root_files(install_root, active_slot_dir)
    _seed_storage_env_if_missing(storage_dir)

    project_json = _load_single_project_json(active_slot_dir)
    slug = project_json["slug"]
    repo_url = project_json["repo"]
    default_branch = project_json.get("defaultBranch", "main")
    assert isinstance(slug, str)
    assert isinstance(repo_url, str)
    assert isinstance(default_branch, str)

    site_repo_dir = storage_dir / "projects" / slug / "repo"
    _clone_site_repo_if_missing(site_repo_dir, repo_url, default_branch)

    if not args.skip_venv:
        _bootstrap_serving(active_slot_dir, storage_dir, slug)

    _print_followups(install_root, port=int(os.environ.get("WIXY_PORT", "9380")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
