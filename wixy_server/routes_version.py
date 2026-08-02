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

`commit.count` (decisions/00109) is the engine's human-facing `v N` display number —
the first-parent commit count of HEAD, the same number the fleet's `ver` badge
pattern shows (one increment per merge to main, so the owner watches it climb release
by release rather than per commit). The admin shell's version badge pins it at page
load and flags "a new version is ready" when a later poll shows it moved. It prefers
the baked `WIXY_ENGINE_VERSION` build-arg env (same provenance story as
`WIXY_ENGINE_SHA`) and degrades to `null` — never a 500 — when neither source can
produce one (a pip-installed image has no `.git`; the badge then simply hides its
number).

`GET /api/version/notes?since=<sha>` (decisions/00112) is the badge popup's "What's
new" feed: the `Release-note:` trailers harvested from the commit messages in
`<since>..HEAD`. This is deliberately NOT a changelog — the doctrine (repo CLAUDE.md,
CI-enforced by the `release-note` job) is that every commit carries one plain-English
sentence written for the site owner ("General bug fixes and improvements." when
nothing is user-visible), and this endpoint serves exactly those sentences: deduped,
chronological, capped, with the same generic line as the fallback when a range comes
up empty (pre-doctrine commits, an unknown `since`, or a gitless image — never a 500).
Same public-by-design posture as `/api/version` — the sentences are written for her
anyway, and the engine repo is on the MIT-public track (decisions/00051 #7).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import anyio
from fastapi import APIRouter, Request

from wixy_server.checkout import CheckoutError, current_sha, run_git
from wixy_server.live_pointer import load_live_pointer
from wixy_server.settings import Settings
from wixy_server.storage import ProjectPaths

router = APIRouter()

# decisions/00112 — the release-notes contract. The fallback line is what the
# operator asked any unglamorous deploy to read as ("if it's just bug fixes and
# things, then it just says that. General bug fixes, something like that." —
# 2026-08-02); keep it in sync with the doctrine rule in the repo CLAUDE.md.
RELEASE_NOTES_FALLBACK = "General bug fixes and improvements."
_RELEASE_NOTES_MAX = 8
# `since` is interpolated into a git rev range; accept hex only (anything else
# falls through to the recent-history fallback rather than a git error).
_SINCE_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")
_TRAILER_RE = re.compile(r"^\s*release-note\s*:\s*(.+?)\s*$", re.IGNORECASE)


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


def _extract_release_notes(log_text: str) -> list[str]:
    """The `Release-note:` trailer lines from a `git log --format=%B` dump —
    whitespace-collapsed, deduped (a multi-commit PR may repeat one note), in
    git log's own newest-first order."""
    notes: list[str] = []
    for line in log_text.splitlines():
        match = _TRAILER_RE.match(line)
        if match:
            note = " ".join(match.group(1).split())
            if note and note not in notes:
                notes.append(note)
    return notes


def resolve_release_notes(wixy_repo_root: Path, since: str | None) -> list[str]:
    """Blocking (shells `git log`) — same caller-wrapping contract as the other
    resolvers. Chronological (oldest first, the order she reads), capped, and
    NEVER empty: the generic fallback line covers pre-doctrine history, a
    `since` git can't resolve, and the gitless image alike."""
    args = ["log", "--format=%B"]
    if since is not None and _SINCE_RE.match(since):
        args.append(f"{since}..HEAD")
    else:
        args.extend(["-n", "10"])
    result = run_git(args, cwd=wixy_repo_root)
    if result.returncode != 0:
        # An unknown/unreachable `since` (or a repo in a weird state): try the
        # recent past rather than error the whole endpoint.
        result = run_git(["log", "-n", "10", "--format=%B"], cwd=wixy_repo_root)
        if result.returncode != 0:
            return [RELEASE_NOTES_FALLBACK]
    notes = _extract_release_notes(result.stdout)
    if not notes:
        return [RELEASE_NOTES_FALLBACK]
    notes.reverse()  # git log is newest-first; she reads oldest-first
    return notes[:_RELEASE_NOTES_MAX]


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


@router.get("/api/version/notes")
async def get_version_notes(request: Request, since: str | None = None) -> dict[str, object]:
    wixy_repo_root: Path = request.app.state.wixy_repo_root
    return await anyio.to_thread.run_sync(_build_notes, wixy_repo_root, since)


def _build_notes(wixy_repo_root: Path, since: str | None) -> dict[str, object]:
    return {"notes": resolve_release_notes(wixy_repo_root, since)}
