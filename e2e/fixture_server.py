"""Standalone fixture server for Playwright E2E flows (spec/08-testing-acceptance.md
§2: "Fixture: temp clone of the site repo (post-migration shape) + wixy server on an
ephemeral port"). Lives in `e2e/` (an npm package) rather than `wixy_server/` on
purpose — it exists ONLY in service of this test suite, nothing product-side depends
on it; it imports `builder`/`wixy_server` directly instead of reimplementing
checkout/app-construction in TypeScript.

Builds a real, throwaway git repo from `builder/tests/fixtures/mini-site` (the same
"real-shaped" fixture the Python unit suite trusts, per this repo's own testing
culture — not a hand-rolled toy that might miss a real edge case) in a fresh temp
directory, a temp Storage root, and a temp wixy-repo-root with one project pointed at
that local repo (git clone from a local path — no network, per spec/08 §1's "never
hit the real network" rule). Publishes ONE initial build before starting so the
preview route's own asset URLs resolve instead of 503ing (decisions/00018 — a fresh
install with no live.json yet is correct-but-noisy for what E2E flows actually test).
Then runs `wixy_server.app.create_app` via uvicorn on a fixed port
`playwright.config.ts`'s `webServer.url` health-checks.

Usage: python fixture_server.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import anyio

E2E_DIR = Path(__file__).resolve().parent
WIXY_REPO_ROOT = E2E_DIR.parent
MINI_SITE_FIXTURE = WIXY_REPO_ROOT / "builder" / "tests" / "fixtures" / "mini-site"
PORT = 8799

sys.path.insert(0, str(WIXY_REPO_ROOT))

from builder.build import build_site  # noqa: E402
from builder.config import ProjectConfig  # noqa: E402
from wixy_server.chats import find_chat  # noqa: E402
from wixy_server.checkout import current_sha, ensure_checkout  # noqa: E402
from wixy_server.cmdchat import CmdChatClient  # noqa: E402
from wixy_server.registry import load_registry  # noqa: E402
from wixy_server.site_source import build_site_source  # noqa: E402
from wixy_server.storage import ProjectPaths, ensure_project_dirs, project_paths  # noqa: E402
from wixy_server.tests.fake_cmd import FakeCmdServer, FakeCmdState  # noqa: E402
from wixy_server.watcher import WatcherStatus, fetch_once  # noqa: E402


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )


def _build_site_origin(tmp_root: Path) -> Path:
    """A genuine BARE repo (spec/08 §1, mirroring wixy_server/tests/test_publisher.py's
    own `bare_origin` fixture) — pushed to from a scratch seed clone, never a working
    tree of its own. A non-bare origin refuses `git push` to its checked-out branch by
    default, which would break every E2E flow that actually publishes (1, 4, 5, 6) the
    moment they existed; this fixture predates any of them needing a real push, so the
    gap was latent until milestone 9 slice 5."""
    bare = tmp_root / "site-origin.git"
    bare.mkdir(parents=True)
    _git(["init", "--bare", "--initial-branch=main"], bare)

    seed = tmp_root / "site-origin-seed"
    _git(["clone", str(bare), str(seed)], tmp_root)
    shutil.copytree(MINI_SITE_FIXTURE, seed, dirs_exist_ok=True)
    _git(["config", "user.email", "e2e@example.invalid"], seed)
    _git(["config", "user.name", "E2E Fixture"], seed)
    _git(["add", "."], seed)
    _git(["commit", "-m", "initial fixture site"], seed)
    _git(["push", "origin", "main"], seed)
    return bare


def _write_project_registry(tmp_root: Path, site_origin: Path) -> Path:
    projects_dir = tmp_root / "wixy-repo" / "projects"
    projects_dir.mkdir(parents=True)
    (projects_dir / "e2e.json").write_text(
        (
            '{"slug": "e2e", "name": "E2E Fixture", '
            f'"repo": "{site_origin.as_posix()}", "defaultBranch": "main", '
            '"cmdProject": "e2e", "domain": "e2e.example.invalid", '
            '"locale": "en-GB", "indexable": false, '
            '"media": {"maxLongSidePx": 2000, "jpegQuality": 85}}'
        ),
        encoding="utf-8",
    )
    return projects_dir.parent


def _publish_initial_build(project: ProjectConfig, storage_root: Path, slug: str) -> None:
    """Materializes ONE published build before the server ever starts, so preview
    pages' own relative asset URLs (site.css/theme.css/images/*, re-anchored to the
    site root by preview.py's `<base href="/">`, decisions/00018) resolve to a real
    file instead of routes_public.py's expected-but-noisy "no live.json yet" 503 —
    that 503 is CORRECT behavior for a genuinely fresh install (spec/04 §3), but it
    would pollute every E2E flow's console-error check with expected noise unrelated
    to whatever that flow actually tests. Mirrors what a real milestone 12 cutover's
    first publish does, just done here directly rather than through milestone 9's
    (not yet built) publish pipeline."""
    paths = project_paths(storage_root, slug)
    ensure_project_dirs(paths)
    ensure_checkout(project.repo, project.default_branch, paths.repo)

    sha = current_sha(paths.repo)
    source = build_site_source(project, paths.repo)
    out_dir = paths.build_dir(sha)
    build_site(paths.repo, source, out_dir)
    paths.live_json.write_text(
        json.dumps({"sha": sha, "version": 1, "buildDir": str(out_dir)}),
        encoding="utf-8",
    )


def _simulate_upstream_commit(site_origin: Path, tmp_root: Path, title: str) -> str:
    """E2E 6 (spec/08 §2): "fake cmd 'ships' a commit to the temp origin's main."
    A scratch clone edits `content/index.json`'s `hero.title` and pushes straight
    to the bare origin, exactly as a real AI-lane merge (milestone 10's cmdchat,
    not built yet) would land one — fixture-only simulation, never imported by
    product code. Returns the new commit's SHA (unused today, kept for a future
    assertion/debugging)."""
    scratch = tmp_root / f"upstream-commit-{uuid.uuid4().hex[:8]}"
    _git(["clone", str(site_origin), str(scratch)], tmp_root)
    content_path = scratch / "content" / "index.json"
    data = json.loads(content_path.read_text(encoding="utf-8"))
    data["hero"]["title"] = title
    content_path.write_text(json.dumps(data), encoding="utf-8")
    _git(["config", "user.email", "ai-lane@example.invalid"], scratch)
    _git(["config", "user.name", "AI Lane"], scratch)
    _git(["add", "."], scratch)
    _git(["commit", "-m", f"AI: {title}"], scratch)
    _git(["push", "origin", "main"], scratch)
    result = subprocess.run(
        ["git", "-c", "credential.helper=", "rev-parse", "HEAD"],
        cwd=scratch,
        capture_output=True,
        text=True,
        check=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def main() -> None:
    tmp_root = Path(tempfile.mkdtemp(prefix="wixy-e2e-"))
    site_origin = _build_site_origin(tmp_root)
    wixy_repo_root = _write_project_registry(tmp_root, site_origin)
    storage_root = tmp_root / "storage"

    os.environ["WIXY_DEV_NO_AUTH"] = "1"
    os.environ["WIXY_ENV"] = "dev"

    registry = load_registry(wixy_repo_root)
    _publish_initial_build(registry.get("e2e"), storage_root, "e2e")

    import uvicorn

    from wixy_server.app import create_app

    # E2E 7 (milestone 10, spec/08 §2/06): a real FakeCmdServer (the same
    # ephemeral-port uvicorn double the Python unit suite uses,
    # wixy_server/tests/fake_cmd.py) rather than a hand-rolled TS stub — one
    # fake, one behavior contract, exercised from both test layers.
    # `default_ready_after_polls=1` means every conversation the browser
    # creates becomes ready almost immediately with zero per-session fixture
    # wiring; a real cmd instance is never touched (fleet rule).
    fake_cmd_state = FakeCmdState(default_ready_after_polls=1)
    fake_cmd_server = FakeCmdServer(fake_cmd_state)
    fake_cmd_port = fake_cmd_server.start()
    cmdchat_client = CmdChatClient(
        portal_base_url=f"http://127.0.0.1:{fake_cmd_port}",
        chats_base_url=f"http://127.0.0.1:{fake_cmd_port}",
        readiness_poll_interval_s=0.2,
        readiness_timeout_s=10.0,
    )

    app = create_app(
        storage_root=storage_root,
        wixy_repo_root=wixy_repo_root,
        # No E2E flow depends on the PERIODIC watcher tick (spec/04 §7) — E2E 6's
        # own simulated upstream commit fetches directly (this file's
        # `/test/simulate-upstream-commit`, decisions/00030), never waiting on
        # it. A rare, full-suite-only theme-change.spec.ts timeout was
        # INVESTIGATED and this periodic tick coinciding with the suite's own
        # ~60s runtime was a suspected cause — DISPROVEN (the timeout still
        # occurred, equally rarely, with the tick disabled entirely); kept
        # disabled anyway purely because it's genuinely unneeded background
        # work for this fixture, not as a fix. The real pattern matches this
        # box's own already-documented transient disk-I/O contention from
        # OTHER unrelated processes (decisions/00025, 00027) — profiled with
        # `fleet_diag.py` during an active failure window and confirmed
        # elevated CPU/disk-I/O from unrelated PIDs, same as those prior
        # incidents (decisions/00030).
        watcher_interval_s=3600.0,
        cmdchat_client=cmdchat_client,
    )

    @app.post("/test/simulate-upstream-commit", include_in_schema=False)
    async def _post_simulate_upstream_commit(payload: dict[str, str]) -> dict[str, str]:
        """E2E 6 (decisions/00030) needs the pushed commit to be visible to the
        checkout deterministically and promptly, without depending on (or
        lowering, suite-wide) the real staleness-triggered fetch on the preview
        route (spec/04 §7) — that mechanism is for a REAL AI-lane merge arriving
        with no other signal; this fixture-only endpoint has a much stronger
        signal available (it just pushed the commit itself), so it fetches
        directly rather than waiting for the next preview load to notice."""
        paths: ProjectPaths = app.state.paths
        project: ProjectConfig = app.state.project
        watcher_status: WatcherStatus = app.state.watcher_status
        sha = await anyio.to_thread.run_sync(
            _simulate_upstream_commit, site_origin, tmp_root, payload["title"]
        )
        await anyio.to_thread.run_sync(fetch_once, project, paths, watcher_status)
        return {"sha": sha}

    def _find_fake_session(conv_id: str) -> object | None:
        paths: ProjectPaths = app.state.paths
        conversation = find_chat(paths.chats_json, conv_id)
        if conversation is None:
            return None
        return fake_cmd_state.sessions.get(conversation.session_id)

    @app.post("/test/chat/set-messages", include_in_schema=False)
    async def _post_set_chat_messages(payload: dict[str, object]) -> dict[str, bool]:
        """E2E 7: scripts a fake assistant reply (incl. tool-activity rows,
        spec/06 §1's message `kind`s) into the conversation the browser
        already created through the real admin UI — mirrors this file's own
        `_simulate_upstream_commit` pattern (fixture-only, never imported by
        product code)."""
        conv_id = payload["convId"]
        assert isinstance(conv_id, str)
        messages = payload["messages"]
        assert isinstance(messages, list)

        def _apply() -> bool:
            session = _find_fake_session(conv_id)
            if session is None:
                return False
            session.messages = messages  # type: ignore[attr-defined]
            return True

        return {"ok": await anyio.to_thread.run_sync(_apply)}

    @app.post("/test/chat/set-send-status", include_in_schema=False)
    async def _post_set_send_status(payload: dict[str, object]) -> dict[str, bool]:
        """E2E 7's send-retry-on-502 leg (spec/06 §3): the test sets a bad
        status code, drives a send through the real UI, asserts the bubble
        error, then calls this again with 202 before retrying."""
        conv_id = payload["convId"]
        assert isinstance(conv_id, str)
        status_code = payload["statusCode"]
        assert isinstance(status_code, int)

        def _apply() -> bool:
            session = _find_fake_session(conv_id)
            if session is None:
                return False
            session.send_status_code = status_code  # type: ignore[attr-defined]
            return True

        return {"ok": await anyio.to_thread.run_sync(_apply)}

    @app.post("/test/chat/stop-fake-cmd", include_in_schema=False)
    async def _post_stop_fake_cmd() -> dict[str, bool]:
        """E2E 7's offline-banner leg (spec/06 §3) — the LAST thing any chat
        E2E test does (no other spec file touches chat/cmd, so a one-way stop
        is safe for the shared, workers:1 fixture server)."""
        await anyio.to_thread.run_sync(fake_cmd_server.stop)
        return {"ok": True}

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
