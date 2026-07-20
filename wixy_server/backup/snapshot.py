"""The actual backup run (spec/independence/06 §2): stage the backup-worthy
subset of Storage into a plain file tree, force-push it as a single-commit
`snapshot` branch on `<org>/ca-state-backup`, tag `monthly/YYYY-MM` on the
1st of each month (12 kept), and verify the push by re-cloning it fresh and
comparing commit SHAs — "a backup that isn't verified isn't a backup."

**Force-push target (M7's FABLE-light gate checklist item)**: `_SNAPSHOT_BRANCH`
is the ONLY ref this module ever force-pushes to, always via the fully
qualified `refs/heads/<name>` form on both the read (`git ls-remote`/`clone
--branch`) and write (`git push --force`) sides — never a bare branch name
that could be confused with a tag or another ref namespace, never a
caller-supplied/configurable value. `git push --force` appears exactly once
in this module (`_push_snapshot`, below) and its target is a `_SNAPSHOT_BRANCH`-
derived literal — grep this file for `--force` to audit the claim directly.
The monthly tag push is a NORMAL (non-force) push — tags are meant to be
immutable once published; only pruning an OLD tag ever deletes one, never
overwrites one in place.

**What gets backed up is an ALLOWLIST, not a denylist** (`_project_backup_items`
below): a new `wixy_server.storage.ProjectPaths` field added later is simply
NOT backed up until someone deliberately adds it here — the safe failure
mode for content about to be force-pushed to an external repo, even a
private one. `repo/` (redundant with GitHub — "git already holds" it, spec's
own words), `builds/` (reproducible from `repo/` + a SHA), `locks/`
(ephemeral), the top-level `.env` (a secret; spec's own explicit "NOT backed
up... .env/keys"), and `logs/` (operational, not "state") are never on the
allowlist and so are structurally excluded, not filtered out after the fact.
"""

from __future__ import annotations

import os
import shutil
import stat
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from wixy_server.backup.settings import BackupSettings
from wixy_server.backup.status import BackupStatus, write_status
from wixy_server.checkout import current_sha, run_git

_SNAPSHOT_BRANCH = "snapshot"
_MONTHLY_TAGS_KEPT = 12
_COMMIT_USER_NAME = "Wixy Backup"
_COMMIT_USER_EMAIL = "wixy-backup@cinnamons.uk"


class SnapshotError(Exception):
    """A backup run failed at some step — caught by the caller, which records
    it in the status file rather than crashing the whole process over one
    bad night (mirrors `wixy_server.worker.app`'s own "cleanup hiccups never
    take the process down" posture)."""


@dataclass(frozen=True, slots=True)
class BackupResult:
    status: BackupStatus


def _clear_readonly_and_retry(
    func: Callable[[str], object], path: str, _exc: BaseException
) -> None:
    """`shutil.rmtree`'s `onexc` hook — identical reasoning to
    `wixy_server.worker.workspace`'s own copy: git marks some of its own
    object/pack files read-only, which blocks `os.remove` outright on
    Windows (delete permission lives on the directory on Linux, not here)."""
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _rmtree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, onexc=_clear_readonly_and_retry)


def _project_backup_items(project_dir: Path) -> list[tuple[Path, str]]:
    """See module docstring: an ALLOWLIST of exactly the residual-droplet-state
    paths spec/independence/06 §1 names, each paired with its destination
    path relative to the staged tree's `projects/<slug>/` directory."""
    items: list[tuple[Path, str]] = []
    live_json = project_dir / "live.json"
    if live_json.is_file():
        items.append((live_json, "live.json"))
    publishes = project_dir / "publishes.jsonl"
    if publishes.is_file():
        items.append((publishes, "publishes.jsonl"))
    chats = project_dir / "chats.json"
    if chats.is_file():
        items.append((chats, "chats.json"))
    overlay = project_dir / "draft" / "overlay.json"
    if overlay.is_file():
        items.append((overlay, "draft/overlay.json"))
    media = project_dir / "draft" / "media"
    if media.is_dir():
        items.append((media, "draft/media"))
    return items


def _stage_tree(settings: BackupSettings, dest: Path) -> None:
    """Populates `dest` (a fresh, empty directory) with exactly the
    backup-worthy content — see module docstring."""
    projects_root = settings.storage_root / "projects"
    if projects_root.is_dir():
        for project_dir in sorted(p for p in projects_root.iterdir() if p.is_dir()):
            for source, rel in _project_backup_items(project_dir):
                target = dest / "projects" / project_dir.name / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                if source.is_dir():
                    shutil.copytree(source, target)
                else:
                    shutil.copy2(source, target)

    # A wholly separate compose volume from `wixy-storage` (module docstring
    # of `wixy_server.backup.settings`) — `None` when this backup run has no
    # anthropic-backend transcripts to fold in (the fleet/hub-mirror case).
    transcripts_root = settings.worker_transcripts_root
    if transcripts_root is not None and transcripts_root.is_dir():
        shutil.copytree(transcripts_root, dest / "worker-transcripts")


def _replace_working_tree(clone_dir: Path, staged_tree: Path) -> None:
    """Clears every path in `clone_dir` except `.git/`, then copies in the
    staged tree fresh — used after `git checkout --orphan` (which otherwise
    leaves the PREVIOUS branch's working-tree files sitting around, marked
    as if newly added) so the commit's tree is EXACTLY the staged tree,
    never a leftover mix of two different runs' content."""
    for entry in clone_dir.iterdir():
        if entry.name == ".git":
            continue
        if entry.is_dir():
            _rmtree(entry)
        else:
            entry.unlink()
    for entry in staged_tree.iterdir():
        dest = clone_dir / entry.name
        if entry.is_dir():
            shutil.copytree(entry, dest)
        else:
            shutil.copy2(entry, dest)


def _create_snapshot_commit(clone_dir: Path, staged_tree: Path, when: datetime) -> str:
    """`clone_dir` is a fresh clone of the backup repo, on WHATEVER branch it
    defaulted to (possibly none at all, on a genuinely empty new repo) — the
    orphan checkout below starts a brand-new, parent-less history regardless,
    which is how this module guarantees the branch NEVER accumulates more
    than one commit (spec's own "single-commit `snapshot` branch (history
    never accumulates)")."""
    orphan = run_git(["checkout", "--orphan", _SNAPSHOT_BRANCH], cwd=clone_dir)
    if orphan.returncode != 0:
        raise SnapshotError(
            f"git checkout --orphan {_SNAPSHOT_BRANCH} failed: {orphan.stderr.strip()}"
        )

    _replace_working_tree(clone_dir, staged_tree)

    name_cfg = run_git(["config", "user.name", _COMMIT_USER_NAME], cwd=clone_dir)
    if name_cfg.returncode != 0:
        raise SnapshotError(f"git config user.name failed: {name_cfg.stderr.strip()}")
    email_cfg = run_git(["config", "user.email", _COMMIT_USER_EMAIL], cwd=clone_dir)
    if email_cfg.returncode != 0:
        raise SnapshotError(f"git config user.email failed: {email_cfg.stderr.strip()}")

    add = run_git(["add", "-A"], cwd=clone_dir)
    if add.returncode != 0:
        raise SnapshotError(f"git add -A failed: {add.stderr.strip()}")

    message = f"snapshot: {when.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    # --allow-empty: a night where NOTHING changed since the last snapshot
    # (identical tree) must still push+verify a real, fresh commit — "a
    # backup that isn't verified isn't a backup" (spec §2) means every night
    # is actually exercised, never silently skipped as a no-op.
    commit = run_git(["commit", "--allow-empty", "-m", message], cwd=clone_dir)
    if commit.returncode != 0:
        raise SnapshotError(f"git commit failed: {commit.stderr.strip()}")
    return current_sha(clone_dir)


def _push_snapshot(clone_dir: Path) -> None:
    """The ONE `--force` push in this module — see module docstring's "force-
    push target" claim. Both sides of the refspec are the literal, fully
    qualified `_SNAPSHOT_BRANCH` ref: nothing caller-supplied, nothing that
    could resolve to `main` or any other branch."""
    push = run_git(
        ["push", "--force", "origin", f"{_SNAPSHOT_BRANCH}:refs/heads/{_SNAPSHOT_BRANCH}"],
        cwd=clone_dir,
    )
    if push.returncode != 0:
        raise SnapshotError(f"git push --force to {_SNAPSHOT_BRANCH} failed: {push.stderr.strip()}")


def _remote_monthly_tags(clone_dir: Path) -> list[str]:
    ls = run_git(["ls-remote", "--tags", "origin", "monthly/*"], cwd=clone_dir)
    if ls.returncode != 0:
        raise SnapshotError(f"git ls-remote --tags failed: {ls.stderr.strip()}")
    names: set[str] = set()
    for line in ls.stdout.splitlines():
        if "\t" not in line:
            continue
        _sha, ref = line.split("\t", 1)
        ref = ref.strip().removesuffix("^{}")  # a peeled-tag line's dereferenced marker
        prefix = "refs/tags/"
        if ref.startswith(prefix):
            names.add(ref[len(prefix) :])
    # Lexicographic order == chronological order for the fixed "monthly/YYYY-MM" shape.
    return sorted(names)


def _prune_old_monthly_tags(clone_dir: Path, *, keep: int) -> None:
    existing = _remote_monthly_tags(clone_dir)
    if len(existing) <= keep:
        return
    for name in existing[: len(existing) - keep]:
        delete = run_git(["push", "origin", "--delete", f"refs/tags/{name}"], cwd=clone_dir)
        if delete.returncode != 0:
            raise SnapshotError(f"failed to delete old tag {name}: {delete.stderr.strip()}")


def _maybe_push_monthly_tag(clone_dir: Path, commit_sha: str, when: datetime) -> str | None:
    if when.day != 1:
        return None
    tag_name = f"monthly/{when.strftime('%Y-%m')}"
    tag = run_git(["tag", tag_name, commit_sha], cwd=clone_dir)
    if tag.returncode != 0:
        raise SnapshotError(f"git tag {tag_name} failed: {tag.stderr.strip()}")
    # A normal (non-force) push — see module docstring: tags are immutable
    # once published; only pruning ever removes one.
    push_tag = run_git(["push", "origin", f"refs/tags/{tag_name}"], cwd=clone_dir)
    if push_tag.returncode != 0:
        raise SnapshotError(f"git push tag {tag_name} failed: {push_tag.stderr.strip()}")
    _prune_old_monthly_tags(clone_dir, keep=_MONTHLY_TAGS_KEPT)
    return tag_name


def _verify_pushed(backup_repo_url: str, expected_sha: str, verify_dir: Path) -> bool:
    """Re-clones the `snapshot` branch SHALLOW into a brand-new directory and
    compares its `HEAD` SHA against what was just pushed — git's own
    content-addressing makes a SHA match a real integrity proof (the remote
    genuinely holds this exact tree), not merely "the push command exited
    zero." "A backup that isn't verified isn't a backup" (spec §2)."""
    clone = run_git(
        ["clone", "--depth", "1", "--branch", _SNAPSHOT_BRANCH, backup_repo_url, str(verify_dir)]
    )
    if clone.returncode != 0:
        return False
    try:
        return current_sha(verify_dir) == expected_sha
    except Exception:  # noqa: BLE001 - any read failure here just means "not verified"
        return False


def run_backup_once(settings: BackupSettings, *, now: datetime) -> BackupResult:
    """Runs one full backup cycle: stage → clone → orphan-commit → force-push
    → (maybe) monthly tag → verify → write the status file. Never raises —
    every failure mode becomes a `BackupStatus(ok=False, error=...)` instead,
    so a bad night degrades to "reported stale/failed," never a crashed
    process the compose service's own restart policy would just spin on."""
    attempted_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    scratch = Path(tempfile.mkdtemp(prefix="wixy-backup-"))
    try:
        staged = scratch / "staged"
        staged.mkdir()
        _stage_tree(settings, staged)

        clone_dir = scratch / "clone"
        cloned = run_git(["clone", settings.backup_repo_url, str(clone_dir)])
        if cloned.returncode != 0:
            raise SnapshotError(f"git clone of the backup repo failed: {cloned.stderr.strip()}")

        commit_sha = _create_snapshot_commit(clone_dir, staged, now)
        _push_snapshot(clone_dir)
        monthly_tag = _maybe_push_monthly_tag(clone_dir, commit_sha, now)

        verify_dir = scratch / "verify"
        verified = _verify_pushed(settings.backup_repo_url, commit_sha, verify_dir)
        if not verified:
            raise SnapshotError(
                "post-push verification failed: the re-cloned snapshot branch's "
                "SHA didn't match what was just pushed"
            )

        status = BackupStatus(
            ok=True,
            attempted_at=attempted_at,
            commit_sha=commit_sha,
            verified=True,
            monthly_tag_pushed=monthly_tag,
            error=None,
        )
    except SnapshotError as exc:
        status = BackupStatus(
            ok=False,
            attempted_at=attempted_at,
            commit_sha=None,
            verified=False,
            monthly_tag_pushed=None,
            error=str(exc),
        )
    finally:
        _rmtree(scratch)

    write_status(settings.status_path, status)
    return BackupResult(status=status)
