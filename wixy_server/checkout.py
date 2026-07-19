"""Site-repo checkout manager: clone-if-absent, then fetch + fast-forward-only
(spec/04 §2, §7; spec/01 §1: "Storage\\...\\repo\\ ... fetch/ff-only").

This is Wixy's OWN working copy of the site repo — never a cmd workspace, never
authored by agents (spec/04 §2). Only read-only git operations are called from
THIS module's own functions (clone, fetch, `merge --ff-only`, `rev-parse`,
`log`) — `wixy_server.publisher` (milestone 9) is the only caller that commits,
pushes, or tags, but it reuses `run_git` (below) rather than re-implementing the
subprocess convention, since that convention (not the read-only-ness) is what's
actually shared. A full clone (no `--depth`/`--single-branch`) is used deliberately
— restore (milestone 9, spec/04 §5) needs an arbitrary historical tree, which a
shallow clone can't serve; this project has already hit a real bug from a
shallow-clone/short-SHA combination elsewhere in its history (see the wixy
`decisions/` log), so this module avoids that shape entirely.

Every git subprocess passes `-c credential.helper=` and a timeout, per the fleet's
git-subprocess convention.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from wixy_server.treelock import tree_lock

_GIT_TIMEOUT_S = 60
_LOG_FIELD_SEP = "\x1f"  # ASCII unit separator — never appears in a commit subject/author


class CheckoutError(Exception):
    """A git operation against the site-repo checkout failed."""


def run_git(args: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    """The shared git-subprocess runner (credential.helper disabled, timeout-bounded)
    — every git invocation anywhere in `wixy_server`, read or write, goes through
    this one function so the convention can't silently drift between callers."""
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
    with tree_lock():
        if (checkout_dir / ".git").exists():
            _fetch_and_fast_forward(checkout_dir, default_branch)
            return

        checkout_dir.parent.mkdir(parents=True, exist_ok=True)
        result = run_git(["clone", "--branch", default_branch, repo_url, str(checkout_dir)])
        if result.returncode != 0:
            raise CheckoutError(f"git clone failed: {result.stderr.strip()}")


def _fetch_and_fast_forward(checkout_dir: Path, default_branch: str) -> None:
    fetch = run_git(["fetch", "origin"], cwd=checkout_dir)
    if fetch.returncode != 0:
        raise CheckoutError(f"git fetch failed: {fetch.stderr.strip()}")

    merge = run_git(["merge", "--ff-only", f"origin/{default_branch}"], cwd=checkout_dir)
    if merge.returncode != 0:
        raise CheckoutError(
            "git merge --ff-only failed (a non-fast-forward local state is a bug — "
            f"never force it): {merge.stderr.strip()}"
        )


def current_sha(checkout_dir: Path) -> str:
    """The checkout's current `HEAD` commit SHA."""
    result = run_git(["rev-parse", "HEAD"], cwd=checkout_dir)
    if result.returncode != 0:
        raise CheckoutError(f"git rev-parse HEAD failed: {result.stderr.strip()}")
    return result.stdout.strip()


@dataclass(frozen=True, slots=True)
class UpstreamCommit:
    """One commit reachable from HEAD but not yet published (spec/04 §7's
    `aheadOfPublished` — what the AI lane has merged since the last publish)."""

    sha: str
    subject: str
    author: str
    when: str


def commits_ahead(checkout_dir: Path, since_sha: str) -> list[UpstreamCommit]:
    """Commits in `since_sha..HEAD`, newest first (git log's own default order).

    `since_sha` is normally the published version's SHA (`live.json`); this function
    has no opinion on what it means when there's no live pointer yet — the caller
    decides that (spec/04 §8's `/api/admin/state`)."""
    sep = _LOG_FIELD_SEP
    result = run_git(
        ["log", f"{since_sha}..HEAD", f"--format=%H{sep}%s{sep}%an{sep}%aI"],
        cwd=checkout_dir,
    )
    if result.returncode != 0:
        raise CheckoutError(f"git log failed: {result.stderr.strip()}")

    commits: list[UpstreamCommit] = []
    for line in result.stdout.splitlines():
        if not line:
            continue
        sha, subject, author, when = line.split(_LOG_FIELD_SEP)
        commits.append(UpstreamCommit(sha=sha, subject=subject, author=author, when=when))
    return commits
