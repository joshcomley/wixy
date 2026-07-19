"""Per-conversation git workspace provisioning for the anthropic-backend worker
(spec/independence/05 §2): clone the target repo into a scratch directory,
create a branch for the agent to work on, and — once its turn produces new
commits — push them under the bot credential. Reuses `wixy_server.checkout.
run_git` for the actual subprocess convention (credential.helper disabled,
bounded timeout) rather than re-implementing it a third time (`checkout.py`,
`wixy_server.publisher` already share it).

Credential handling (Fable checklist, spec/independence/05 §4: "key never
logged/committed"): the bot PAT is NEVER written to the clone's persisted
`.git/config` or embedded in a remote URL — every credentialed git call passes
it via a ONE-OFF `-c http.extraHeader=` flag (git's own per-invocation auth
override), which applies only to that single subprocess and is never persisted
to any config file. This matters specifically because the agent itself has
unrestricted Bash access inside the clone for the rest of its turn (spec §3) —
if the PAT lived in `.git/config`/the remote URL at rest, `git remote -v` or
`cat .git/config` would hand it straight to the agent, and from there into the
transcript the owner reads. `origin` is reset to a bare, credential-less HTTPS
URL immediately after the clone, and stays that way for the entire time the
agent has Bash access — only the worker's OWN push call (never agent-issued,
which only ever runs after the agent's turn has ended) uses the header again.

Fable M6 gate review, R1: disk/config is not the only channel a secret can
cross on its way to the agent — process-environment inheritance is another,
closed separately (`wixy_server.worker.settings.load_worker_settings` pops
`WIXY_AI_BOT_PAT` from `os.environ` at load time, before this module or the
Agent SDK's spawned CLI child can ever see it as an inherited env var). Stated
honestly, per Fable's own wording: this reduces casual/accidental exposure, it
does NOT claim container-grade separation. Within one container running as one
uid, `/proc/<worker-pid>/environ` remains readable by anything running as that
same uid regardless of what this module or `load_worker_settings` does — no
in-process file/env discipline closes that residual channel. Full privilege
separation (moving push/PR duties out of the agent's container into the server
via a read-only-mounted scratch fetch) would close it, and was considered and
explicitly deferred as disproportionate for v1 (decisions/00065's "Correction
(Fable review, PR #76 R1+R2)") — the blast radius of a leaked site-repo PAT is
repo vandalism on branches, not live-site compromise (publishes are
owner-pinned SHAs) or the engine or her key. Banked as a hardening upgrade
alongside that same entry's egress-sidecar note.
"""

from __future__ import annotations

import base64
import os
import shutil
import stat
from collections.abc import Callable
from pathlib import Path

from wixy_server.checkout import run_git

_COMMIT_USER_NAME = "Wixy AI"
_COMMIT_USER_EMAIL = "wixy-ai@cinnamons.uk"
_ACTIVITY_MARKER_NAME = ".wixy-last-active"

# spec/independence/05 §4 "scratch clones cleaned" — a plain idle-retention
# sweep, not a merge/close-aware one: the pushed branch + any opened PR on
# GitHub is the durable artifact (spec's own "ships a PR via her bot deploy
# key/PAT"), so treating an idle local clone as disposable working state is
# the same accepted tradeoff `wixy_server.worker.state` already documents for
# a worker restart losing in-flight conversations.
DEFAULT_SWEEP_MAX_AGE_S = 7 * 24 * 3600.0


class WorkspaceError(Exception):
    """A git operation provisioning/publishing a conversation's workspace failed."""


def owner_repo_slug(repo_url: str) -> str:
    """Normalizes a `github.com` repo URL (SSH `git@github.com:owner/repo.git`
    or HTTPS `https://github.com/owner/repo.git`, with or without the `.git`
    suffix — `projects/*.json`'s committed default is HTTPS, a real standalone
    deployment's `WIXY_SITE_REPO` is SSH per `setup.sh`'s own prompt) down to
    the bare `owner/repo` slug both `github_https_clone_url` (below) and
    `wixy_server.github.GitHubClient`'s REST calls need. Plain string
    prefix-stripping rather than a regex — easier to verify by eye, which
    matters for code a security review checklist explicitly covers."""
    text = repo_url.strip()
    for prefix in ("git@github.com:", "https://github.com/", "http://github.com/"):
        if text.startswith(prefix):
            text = text[len(prefix) :]
            break
    else:
        raise WorkspaceError(f"not a recognized github.com repo URL: {repo_url!r}")
    if text.endswith(".git"):
        text = text[: -len(".git")]
    if not text or "/" not in text:
        raise WorkspaceError(f"not a recognized github.com repo URL: {repo_url!r}")
    return text


def github_https_clone_url(repo_url: str) -> str:
    """The bare HTTPS clone URL the bot PAT authenticates against — `run_git`
    disables credential helpers (see `checkout.py`), and the main server's own
    site-repo checkout deliberately stays SSH-keyed (spec/independence/01
    §2.2), but the worker authenticates as the bot PAT instead, which only
    works over HTTPS."""
    return f"https://github.com/{owner_repo_slug(repo_url)}.git"


def _auth_header_args(pat: str) -> list[str]:
    """A ONE-OFF `-c http.extraHeader=` pair (see module docstring) — `pat`
    goes straight into an argv element `run_git` hands to `subprocess.run`
    (never through a shell, never logged, never persisted to `.git/config`)."""
    basic = base64.b64encode(f"x-access-token:{pat}".encode()).decode()
    return ["-c", f"http.extraHeader=Authorization: Basic {basic}"]


def provision_workspace(
    *, clone_url: str, branch_name: str, dest: Path, pat: str, default_branch: str = "main"
) -> None:
    """Clones `clone_url` (an already-resolved, credential-free HTTPS URL —
    callers derive it with `github_https_clone_url` first; kept as a separate
    step rather than folded in here so this function's own git mechanics are
    testable against ANY reachable remote, including a local bare repo in
    tests, not just a real github.com one) at `default_branch` into `dest`
    (must not already exist) and creates+checks-out `branch_name` — the
    workspace the agent's own Bash-tool git/test commands then operate in for
    the rest of the conversation. Calling this twice against the SAME `dest`
    is a caller bug (git's own "destination already exists" error), never
    silently reused — a stale prior clone left mid-provision by a worker
    restart is exactly the accepted tradeoff `wixy_server.worker.state`
    already documents, not something to paper over here.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    cloned = run_git(
        [*_auth_header_args(pat), "clone", "--branch", default_branch, clone_url, str(dest)]
    )
    if cloned.returncode != 0:
        raise WorkspaceError(f"git clone failed: {cloned.stderr.strip()}")

    # Strip credentials from the persisted remote for the entire time the
    # agent has Bash access (see module docstring) — the clone above only
    # ever used the PAT transiently via the one-off header above, never
    # writing it to disk.
    stripped = run_git(["remote", "set-url", "origin", clone_url], cwd=dest)
    if stripped.returncode != 0:
        raise WorkspaceError(f"git remote set-url failed: {stripped.stderr.strip()}")

    name_cfg = run_git(["config", "user.name", _COMMIT_USER_NAME], cwd=dest)
    if name_cfg.returncode != 0:
        raise WorkspaceError(f"git config user.name failed: {name_cfg.stderr.strip()}")
    email_cfg = run_git(["config", "user.email", _COMMIT_USER_EMAIL], cwd=dest)
    if email_cfg.returncode != 0:
        raise WorkspaceError(f"git config user.email failed: {email_cfg.stderr.strip()}")

    branched = run_git(["checkout", "-b", branch_name], cwd=dest)
    if branched.returncode != 0:
        raise WorkspaceError(f"git checkout -b {branch_name} failed: {branched.stderr.strip()}")


def head_sha(dest: Path) -> str:
    """The workspace's current `HEAD` — callers diff this before/after an
    agent turn to detect whether it actually committed anything (a turn that
    only answers a question, with no edits, should never push an empty
    branch or open an empty PR)."""
    result = run_git(["rev-parse", "HEAD"], cwd=dest)
    if result.returncode != 0:
        raise WorkspaceError(f"git rev-parse HEAD failed: {result.stderr.strip()}")
    return result.stdout.strip()


def push_branch(*, dest: Path, branch_name: str, pat: str) -> None:
    """Worker-issued (never agent-issued — see module docstring) push, using
    the bot PAT transiently via the same one-off header `provision_workspace`
    uses for the clone. A second and later push of the SAME branch (a
    follow-up conversation turn with more commits) is exactly how GitHub
    auto-updates the already-open PR — no separate "update PR" call needed."""
    result = run_git([*_auth_header_args(pat), "push", "origin", branch_name], cwd=dest)
    if result.returncode != 0:
        raise WorkspaceError(f"git push failed: {result.stderr.strip()}")


def touch_activity(dest: Path) -> None:
    """Bumps a sentinel marker's mtime (`sweep_idle_workspaces` reads it) —
    called after every completed turn, whether or not it produced a commit,
    so an active-but-quiet conversation (the owner reading, not yet replying)
    is never mistaken for an abandoned one. Deliberately NOT the directory's
    own mtime: that only bumps when an entry is added/removed/renamed
    directly inside `dest`, which many normal git/file operations don't
    trigger (editing an existing file's contents doesn't touch its parent
    dir's mtime) — an explicit marker this module fully controls is a
    reliable signal, not a filesystem-semantics guess.
    """
    (dest / _ACTIVITY_MARKER_NAME).write_text("", encoding="utf-8")


def _clear_readonly_and_retry(
    func: Callable[[str], object], path: str, _exc: BaseException
) -> None:
    """`shutil.rmtree`'s `onexc` hook — git marks some of its own object/pack
    files read-only, which is harmless to delete on Linux (delete permission
    lives on the DIRECTORY there, not the file) but blocks `os.remove`/`os.
    rmdir` outright on Windows. Silently swallowing that with `ignore_errors=
    True` (this function's own prior shape) left `dest` PARTIALLY deleted with
    no error — exactly the kind of silent failure a "scratch clones cleaned"
    guarantee must not have, on the platform this actually runs on or not."""
    os.chmod(path, stat.S_IWRITE)
    func(path)


def cleanup_workspace(dest: Path) -> None:
    if not dest.exists():
        return
    shutil.rmtree(dest, onexc=_clear_readonly_and_retry)


def sweep_idle_workspaces(
    scratch_root: Path, *, now: float, max_age_s: float = DEFAULT_SWEEP_MAX_AGE_S
) -> list[str]:
    """Deletes every immediate `scratch_root` subdirectory idle longer than
    `max_age_s` (spec/independence/05 §4's "scratch clones cleaned" checklist
    item) — idle meaning its `touch_activity` marker (falling back to the
    directory's own mtime if a workspace somehow has none, e.g. one that
    failed provisioning before ever calling `touch_activity`) hasn't been
    bumped recently. `now` is caller-supplied (never `time.time()` internally)
    so tests are deterministic. Returns the names removed so far — a single
    entry's `cleanup_workspace` failure propagates (never silently ignored,
    see that function's own docstring), leaving any remaining entries for the
    NEXT sweep pass (`wixy_server.worker.app._run_scratch_sweep` runs hourly
    and catches/logs a whole-pass failure, so one stubborn directory degrades
    to "retried next hour," never a crashed worker)."""
    if not scratch_root.exists():
        return []
    removed: list[str] = []
    for entry in scratch_root.iterdir():
        if not entry.is_dir():
            continue
        marker = entry / _ACTIVITY_MARKER_NAME
        reference = marker if marker.exists() else entry
        if now - reference.stat().st_mtime > max_age_s:
            cleanup_workspace(entry)
            removed.append(entry.name)
    return removed
