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
from pathlib import Path

E2E_DIR = Path(__file__).resolve().parent
WIXY_REPO_ROOT = E2E_DIR.parent
MINI_SITE_FIXTURE = WIXY_REPO_ROOT / "builder" / "tests" / "fixtures" / "mini-site"
PORT = 8799

sys.path.insert(0, str(WIXY_REPO_ROOT))

from builder.build import build_site  # noqa: E402
from builder.config import ProjectConfig  # noqa: E402
from wixy_server.checkout import current_sha, ensure_checkout  # noqa: E402
from wixy_server.registry import load_registry  # noqa: E402
from wixy_server.site_source import build_site_source  # noqa: E402
from wixy_server.storage import ensure_project_dirs, project_paths  # noqa: E402


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

    app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
