"""Site-repo checkout manager: clone-if-absent, then fetch + fast-forward-only
(spec/04 §2, §7; spec/01 §1: "Storage\\...\\repo\\ ... fetch/ff-only").

This is Wixy's OWN working copy of the site repo — never a cmd workspace, never
authored by agents (spec/04 §2). Only read-only git operations happen here (clone,
fetch, `merge --ff-only`); the publisher (milestone 9) is the only code that commits
and pushes to it. A full clone (no `--depth`/`--single-branch`) is used deliberately
— restore (milestone 9, spec/04 §5) needs `git show <old-sha>` against arbitrary
historical commits, which a shallow clone can't serve; this project has already hit
a real bug from a shallow-clone/short-SHA combination elsewhere in its history
(see the wixy `decisions/` log), so this module avoids that shape entirely.

Every git subprocess passes `-c credential.helper=` and a timeout, per the fleet's
git-subprocess convention.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

_GIT_TIMEOUT_S = 60


class CheckoutError(Exception):
    """A git operation against the site-repo checkout failed."""


def _run_git(args: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=_GIT_TIMEOUT_S,
    )


def ensure_checkout(repo_url: str, default_branch: str, checkout_dir: Path) -> None:
    """Clone `repo_url` into `checkout_dir` if it's not already a git checkout;
    otherwise fetch + fast-forward the working tree to `origin/<default_branch>`.

    Raises `CheckoutError` (with the git stderr) on any failure. A non-fast-forward
    local state is treated as a bug, never silently forced (spec/04 §5 step 1).
    """
    if (checkout_dir / ".git").exists():
        _fetch_and_fast_forward(checkout_dir, default_branch)
        return

    checkout_dir.parent.mkdir(parents=True, exist_ok=True)
    result = _run_git(["clone", "--branch", default_branch, repo_url, str(checkout_dir)])
    if result.returncode != 0:
        raise CheckoutError(f"git clone failed: {result.stderr.strip()}")


def _fetch_and_fast_forward(checkout_dir: Path, default_branch: str) -> None:
    fetch = _run_git(["fetch", "origin"], cwd=checkout_dir)
    if fetch.returncode != 0:
        raise CheckoutError(f"git fetch failed: {fetch.stderr.strip()}")

    merge = _run_git(["merge", "--ff-only", f"origin/{default_branch}"], cwd=checkout_dir)
    if merge.returncode != 0:
        raise CheckoutError(
            "git merge --ff-only failed (a non-fast-forward local state is a bug — "
            f"never force it): {merge.stderr.strip()}"
        )


def current_sha(checkout_dir: Path) -> str:
    """The checkout's current `HEAD` commit SHA."""
    result = _run_git(["rev-parse", "HEAD"], cwd=checkout_dir)
    if result.returncode != 0:
        raise CheckoutError(f"git rev-parse HEAD failed: {result.stderr.strip()}")
    return result.stdout.strip()
