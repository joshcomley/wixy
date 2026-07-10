"""spec/08-testing-acceptance.md §1's publish-pipeline guarantee ("any step's
failure -> job state 'failed'; live site + ledger + draft all unchanged; steps 1-4
never touch the serving pointer") was already exercised at the unit level in
test_publisher.py via monkeypatched/raised exceptions — a WELL-BEHAVED failure mode
where Python's own `finally`/`except` machinery always runs. This file exercises
the genuinely different, harder case milestone 9 slice 5's own scope calls for
(decisions/00030): a REAL OS-level process kill (`Popen.kill()`, no graceful
shutdown, no `finally` block executes) landing mid-pipeline, against a REAL uvicorn
subprocess and REAL bare-origin git repo — never yet exercised as a genuine kill
before this slice, per the todos sidecar's own "kill-during-publish drill" scope
item.

Runs the whole publish pipeline as a real, separate OS process (not the in-process
ASGI TestClient every other wixy_server test uses) specifically so `Popen.kill()`
can terminate it truly abruptly at an unpredictable bytecode boundary — the exact
thing atomic tmp+rename writes (`live_pointer.save_live_pointer`) are meant to
survive, and the exact thing that skips `run_publish`'s own `finally:
paths.publish_lock.unlink(...)`, found to leave a stale lock behind (fixed in
`watcher.py`, decisions/00030) BY the process of writing this exact test.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

from wixy_server.storage import ProjectPaths, project_paths

WIXY_REPO_ROOT = Path(__file__).resolve().parents[2]

_INDEX_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<h1 data-wx="hero.title">placeholder</h1>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""
_PARTIAL_HTML = "<body></body>\n"

_LAUNCHER_SOURCE = """
import sys
from pathlib import Path

sys.path.insert(0, {wixy_repo_root!r})

import uvicorn

from wixy_server.app import create_app

app = create_app(storage_root=Path({storage_root!r}), wixy_repo_root=Path({wixy_repo_root_arg!r}))
uvicorn.run(app, host="127.0.0.1", port={port}, log_level="warning")
"""


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


def _write_site_files(root: Path) -> None:
    (root / "pages").mkdir(parents=True, exist_ok=True)
    (root / "partials").mkdir(parents=True, exist_ok=True)
    (root / "content").mkdir(parents=True, exist_ok=True)
    (root / "pages" / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (root / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (root / "content" / "index.json").write_text(
        json.dumps({"meta": {"title": "Home"}, "hero": {"title": "Original Title"}}),
        encoding="utf-8",
    )
    (root / "content" / "_global.json").write_text("{}", encoding="utf-8")


@pytest.fixture
def bare_origin(tmp_path: Path) -> Path:
    bare_dir = tmp_path / "origin.git"
    bare_dir.mkdir(parents=True)
    _git(["init", "--bare", "--initial-branch=main"], bare_dir)

    seed = tmp_path / "seed"
    _git(["clone", str(bare_dir), str(seed)], tmp_path)
    _git(["config", "user.email", "seed@example.com"], seed)
    _git(["config", "user.name", "Seed"], seed)
    _write_site_files(seed)
    _git(["add", "."], seed)
    _git(["commit", "-m", "initial"], seed)
    _git(["push", "origin", "main"], seed)
    return bare_dir


@pytest.fixture
def wixy_repo_root(tmp_path: Path, bare_origin: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "Test",
                "repo": str(bare_origin),
                "defaultBranch": "main",
                "cmdProject": "test",
                "domain": "test.example.invalid",
                "locale": "en-GB",
                "indexable": False,
                "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
            }
        ),
        encoding="utf-8",
    )
    return root


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture
def paths(storage_root: Path) -> ProjectPaths:
    return project_paths(storage_root, "test")


def _launcher_script(tmp_path: Path, storage_root: Path, wixy_repo_root: Path, port: int) -> Path:
    script = tmp_path / "launch_server.py"
    script.write_text(
        _LAUNCHER_SOURCE.format(
            wixy_repo_root=str(WIXY_REPO_ROOT),
            storage_root=str(storage_root),
            wixy_repo_root_arg=str(wixy_repo_root),
            port=port,
        ),
        encoding="utf-8",
    )
    return script


def _start_server(script: Path) -> subprocess.Popen[bytes]:
    env = {**os.environ, "WIXY_DEV_NO_AUTH": "1", "WIXY_ENV": "dev"}
    return subprocess.Popen(
        [sys.executable, str(script)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )


def _wait_until_serving_state(base_url: str, *, timeout_s: float = 30.0) -> None:
    deadline = time.monotonic() + timeout_s
    last_exc: Exception | None = None
    while time.monotonic() < deadline:
        try:
            resp = httpx.get(f"{base_url}/api/admin/state", timeout=2.0)
            if resp.status_code == 200:
                return
        except httpx.HTTPError as exc:
            last_exc = exc
        time.sleep(0.05)
    raise TimeoutError(f"server never became ready at {base_url}") from last_exc


def _read_or_none(path: Path) -> bytes | None:
    return path.read_bytes() if path.exists() else None


def test_a_real_process_kill_mid_publish_leaves_live_ledger_and_draft_untouched(
    tmp_path: Path, storage_root: Path, wixy_repo_root: Path, paths: ProjectPaths
) -> None:
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"
    script = _launcher_script(tmp_path, storage_root, wixy_repo_root, port)

    proc = _start_server(script)
    try:
        _wait_until_serving_state(base_url)

        with httpx.Client(base_url=base_url, timeout=10.0) as client:
            patch_resp = client.patch(
                "/api/admin/draft",
                json={
                    "expectedRev": 0,
                    "ops": [{"file": "index", "path": "hero.title", "value": "Edited Before Kill"}],
                },
            )
            assert patch_resp.status_code == 200
            rev = patch_resp.json()["rev"]

        pre_live = _read_or_none(paths.live_json)
        pre_ledger = _read_or_none(paths.publishes_jsonl)
        pre_overlay = paths.draft_overlay.read_bytes()

        publish_errors: list[Exception] = []

        def _fire_publish() -> None:
            try:
                httpx.post(
                    f"{base_url}/api/admin/publish",
                    json={"message": "kill test", "expectedRev": rev},
                    timeout=30.0,
                )
            except httpx.HTTPError as exc:
                # Expected — the process gets killed mid-request, so the
                # connection dies before any response arrives.
                publish_errors.append(exc)

        # daemon=True: never blocks process/test-session exit even in the rare
        # case its own httpx call outlives the bounded `.join()` below.
        publish_thread = threading.Thread(target=_fire_publish, daemon=True)
        publish_thread.start()

        # Poll as tightly as possible for the job to become observably running,
        # then kill IMMEDIATELY — `job.stage` is set to "pulling" as literally
        # the first statement inside `run_publish`, before any git/file I/O, so
        # this reliably lands well before "swapping" (step 5, spec/04 §5) even
        # on a slow box; the assertion below turns a late kill into a loud
        # failure instead of a silent false pass.
        observed_stage: str | None = None
        deadline = time.monotonic() + 10.0
        with httpx.Client(base_url=base_url, timeout=2.0) as poll_client:
            while time.monotonic() < deadline:
                try:
                    state_resp = poll_client.get("/api/admin/state")
                except httpx.HTTPError:
                    continue
                if state_resp.status_code != 200:
                    continue
                job = state_resp.json().get("publishJob")
                if job is not None and job.get("isRunning"):
                    observed_stage = job.get("stage")
                    break

        proc.kill()
        proc.wait(timeout=10)
        publish_thread.join(timeout=10)

        assert observed_stage is not None, (
            "never observed the publish job actually running — the kill couldn't "
            "have interrupted anything, this run proves nothing"
        )
        assert observed_stage not in ("swapping", "done"), (
            f"kill landed too late (stage={observed_stage!r}) to test the "
            "steps-1-4 guarantee — rerun"
        )

        post_live = _read_or_none(paths.live_json)
        post_ledger = _read_or_none(paths.publishes_jsonl)
        post_overlay = paths.draft_overlay.read_bytes()

        assert post_live == pre_live, "live.json changed despite a kill before 'swapping'"
        assert post_ledger == pre_ledger, "the ledger changed despite a kill before 'swapping'"
        assert post_overlay == pre_overlay, "the draft overlay changed despite the kill"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)

    # Recovery: a FRESH server process against the SAME Storage root starts
    # cleanly and can publish normally afterward — the system self-heals from a
    # genuine kill rather than needing manual cleanup (spec's own "never crash"
    # posture, extended to "never stay broken").
    port2 = _free_port()
    base_url2 = f"http://127.0.0.1:{port2}"
    script2 = _launcher_script(tmp_path, storage_root, wixy_repo_root, port2)
    proc2 = _start_server(script2)
    try:
        _wait_until_serving_state(base_url2)
        with httpx.Client(base_url=base_url2, timeout=15.0) as client:
            state_resp = client.get("/api/admin/state")
            assert state_resp.status_code == 200
            recovered_rev = state_resp.json()["draft"]["rev"]

            publish_resp = client.post(
                "/api/admin/publish",
                json={"message": "recovery publish", "expectedRev": recovered_rev},
            )
            assert publish_resp.status_code == 200, publish_resp.text
    finally:
        proc2.kill()
        proc2.wait(timeout=10)
