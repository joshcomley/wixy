"""`GET /api/version` (spec/04-server.md §9, spec/07-hosting-deploy.md §1) — public by
design (fleet deploy-awareness; Slots smoke probes match `commit.sha_full` against the
engine repo's HEAD as the anti-stale gate). NOT gated by CF Access — it must stay
reachable even before any Access app is provisioned.

Independence-phase additions (spec/independence/01 §2.6, 03 §1): `edition`
(`settings.edition` — `fleet`/`standalone`) and `syncBase` (her fork's last-synced-
from upstream commit, spec/independence/04). `commit.sha_full` itself now prefers the
baked build-arg env `WIXY_ENGINE_SHA` (set at image-build time) over the git-shell
fallback — a pip-installed image ships no `.git`, so that fallback is best-effort only
and must never turn a missing repo into a 500 (the M2 finding this exists to fix); on
the fleet, where `.git` always exists, `WIXY_ENGINE_SHA` stays unset and behavior is
unchanged (git fallback always succeeds, exactly as it does today).

`commit.count` (decisions/00108) is the engine's human-facing `v N` display number —
the first-parent commit count of HEAD, the same number the fleet's `ver` badge
pattern shows (one increment per merge to main, so the owner watches it climb release
by release rather than per commit). The admin shell's version badge pins it at page
load and flags "a new version is ready" when a later poll shows it moved. It prefers
the baked `WIXY_ENGINE_VERSION` build-arg env (same provenance story as
`WIXY_ENGINE_SHA`) and degrades to `null` — never a 500 — when neither source can
produce one (a pip-installed image has no `.git`; the badge then simply hides its
number).
"""

from __future__ import annotations

import os
from pathlib import Path

import anyio
from fastapi import APIRouter, Request

from wixy_server.checkout import CheckoutError, current_sha, run_git
from wixy_server.live_pointer import load_live_pointer
from wixy_server.settings import Settings
from wixy_server.storage import ProjectPaths

router = APIRouter()


def resolve_engine_sha(wixy_repo_root: Path) -> str | None:
    """Blocking (may shell `git rev-parse`) — callers off the event loop wrap this
    in `anyio.to_thread.run_sync`, same as `_build_version` below does for the
    `/api/version` route; `wixy_server/routes_engine.py` reuses this directly for
    the Engine card's `currentSha` field rather than re-deriving it."""
    baked = os.environ.get("WIXY_ENGINE_SHA")
    if baked:
        return baked
    try:
        # `current_sha` is a plain "git rev-parse HEAD in this directory" primitive —
        # reused here for the ENGINE repo's own HEAD, not the site checkout it was
        # written for.
        return current_sha(wixy_repo_root)
    except CheckoutError:
        return None


def resolve_engine_version_count(wixy_repo_root: Path) -> int | None:
    """Blocking (may shell `git rev-list`) — same caller-wrapping contract as
    `resolve_engine_sha` above. `None` (never an exception) when neither the baked
    env nor the git fallback can produce a count — the admin badge hides its
    number rather than the route 500ing (same M2 lesson as the sha)."""
    baked = os.environ.get("WIXY_ENGINE_VERSION")
    if baked:
        try:
            return int(baked)
        except ValueError:
            return None
    result = run_git(["rev-list", "--first-parent", "--count", "HEAD"], cwd=wixy_repo_root)
    if result.returncode != 0:
        return None
    try:
        return int(result.stdout.strip())
    except ValueError:
        return None


def _build_version(
    wixy_repo_root: Path, paths: ProjectPaths, slot: str | None, edition: str
) -> dict[str, object]:
    engine_sha = resolve_engine_sha(wixy_repo_root)
    engine_version_count = resolve_engine_version_count(wixy_repo_root)
    # Her fork's last-synced-from upstream commit (spec/independence/04) — a baked
    # build-arg only; unset (null) on the fleet edition, which isn't a fork and has no
    # equivalent git ref to fall back to.
    sync_base = os.environ.get("WIXY_SYNC_BASE")
    live_pointer = load_live_pointer(paths)
    return {
        "commit": {"sha_full": engine_sha, "count": engine_version_count},
        "slot": slot,  # WIXY_SLOT, set by launcher.py from active.txt (spec/07 §1)
        "version": live_pointer.version if live_pointer is not None else None,
        "edition": edition,
        "syncBase": sync_base,
    }


@router.get("/api/version")
async def get_version(request: Request) -> dict[str, object]:
    wixy_repo_root: Path = request.app.state.wixy_repo_root
    paths: ProjectPaths = request.app.state.paths
    settings: Settings = request.app.state.settings
    return await anyio.to_thread.run_sync(
        _build_version, wixy_repo_root, paths, settings.slot, settings.edition
    )
