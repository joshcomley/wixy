"""Real-git tests for `wixy_server.worker.workspace` (spec/independence/05 §2,
§4) — clone/branch/push exercised against a genuine BARE repo, mirroring
`test_publisher.py`'s own `bare_origin` fixture and spec/08-testing-
acceptance.md §1's "real repos, not mocked" convention, so credential-handling
(the Fable checklist's "key never logged/committed") is proven for real
against an actual `.git/config` on disk, not asserted against a mock call.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest

from wixy_server.worker.workspace import (
    WorkspaceError,
    cleanup_workspace,
    github_https_clone_url,
    head_sha,
    owner_repo_slug,
    provision_workspace,
    push_branch,
    sweep_idle_workspaces,
    touch_activity,
)

_FAKE_PAT = "fake-bot-pat-do-not-leak-me"


def _git(args: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


@pytest.fixture
def bare_origin(tmp_path: Path) -> Path:
    """A genuine bare repo standing in for a `github.com` remote — what's
    under test here is that `provision_workspace`/`push_branch` never persist
    the bot PAT to disk, which is exactly as true over this fixture's local
    transport as it would be over real HTTPS (the one-off `-c
    http.extraHeader=` flag either way never touches any config file — see
    workspace.py's own module docstring)."""
    bare_dir = tmp_path / "origin.git"
    bare_dir.mkdir(parents=True)
    _git(["init", "--bare", "--initial-branch=main"], cwd=bare_dir)

    seed = tmp_path / "seed"
    _git(["clone", str(bare_dir), str(seed)], cwd=tmp_path)
    _git(["config", "user.email", "seed@example.com"], cwd=seed)
    _git(["config", "user.name", "Seed"], cwd=seed)
    (seed / "content").mkdir()
    (seed / "content" / "index.json").write_text(
        '{"hero": {"title": "Original"}}', encoding="utf-8"
    )
    _git(["add", "."], cwd=seed)
    _git(["commit", "-m", "initial"], cwd=seed)
    _git(["push", "origin", "main"], cwd=seed)
    return bare_dir


# ---------------------------------------------------------------------------
# owner_repo_slug / github_https_clone_url
# ---------------------------------------------------------------------------


class TestOwnerRepoSlug:
    def test_ssh_form(self) -> None:
        assert owner_repo_slug("git@github.com:acme/wixy-site.git") == "acme/wixy-site"

    def test_ssh_form_no_dot_git_suffix(self) -> None:
        assert owner_repo_slug("git@github.com:acme/wixy-site") == "acme/wixy-site"

    def test_https_form(self) -> None:
        assert owner_repo_slug("https://github.com/acme/wixy-site.git") == "acme/wixy-site"

    def test_https_form_no_dot_git_suffix(self) -> None:
        assert owner_repo_slug("https://github.com/acme/wixy-site") == "acme/wixy-site"

    def test_unrecognized_host_raises(self) -> None:
        with pytest.raises(WorkspaceError, match="not a recognized github.com repo URL"):
            owner_repo_slug("https://gitlab.com/acme/wixy-site.git")

    def test_local_path_raises(self) -> None:
        with pytest.raises(WorkspaceError):
            owner_repo_slug("/tmp/some/local/repo.git")


class TestGithubHttpsCloneUrl:
    def test_converts_ssh_to_https(self) -> None:
        assert (
            github_https_clone_url("git@github.com:acme/wixy-site.git")
            == "https://github.com/acme/wixy-site.git"
        )

    def test_https_stays_https(self) -> None:
        assert (
            github_https_clone_url("https://github.com/acme/wixy-site.git")
            == "https://github.com/acme/wixy-site.git"
        )


# ---------------------------------------------------------------------------
# provision_workspace
# ---------------------------------------------------------------------------


class TestProvisionWorkspace:
    def test_clones_and_checks_out_new_branch(self, tmp_path: Path, bare_origin: Path) -> None:
        dest = tmp_path / "scratch" / "conv-1"
        provision_workspace(
            clone_url=str(bare_origin),
            branch_name="wixy-ai/conv-1",
            dest=dest,
            pat=_FAKE_PAT,
        )

        assert (dest / "content" / "index.json").exists()
        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=dest)
        assert branch.stdout.strip() == "wixy-ai/conv-1"

    def test_commit_identity_is_wixy_ai(self, tmp_path: Path, bare_origin: Path) -> None:
        dest = tmp_path / "scratch" / "conv-1"
        provision_workspace(
            clone_url=str(bare_origin), branch_name="wixy-ai/conv-1", dest=dest, pat=_FAKE_PAT
        )

        name = _git(["config", "user.name"], cwd=dest)
        email = _git(["config", "user.email"], cwd=dest)
        assert name.stdout.strip() == "Wixy AI"
        assert email.stdout.strip() == "wixy-ai@cinnamons.uk"

    def test_pat_never_persisted_to_git_config(self, tmp_path: Path, bare_origin: Path) -> None:
        """The Fable checklist's "key never logged/committed" — the agent has
        unrestricted Bash access inside `dest` for the rest of its turn (spec
        §3), so if the PAT lived in `.git/config` at rest, `cat .git/config`
        would hand it straight over."""
        dest = tmp_path / "scratch" / "conv-1"
        provision_workspace(
            clone_url=str(bare_origin), branch_name="wixy-ai/conv-1", dest=dest, pat=_FAKE_PAT
        )

        config_text = (dest / ".git" / "config").read_text(encoding="utf-8")
        assert _FAKE_PAT not in config_text

        remote = _git(["remote", "get-url", "origin"], cwd=dest)
        assert _FAKE_PAT not in remote.stdout

    def test_remote_url_is_the_bare_clone_url(self, tmp_path: Path, bare_origin: Path) -> None:
        dest = tmp_path / "scratch" / "conv-1"
        provision_workspace(
            clone_url=str(bare_origin), branch_name="wixy-ai/conv-1", dest=dest, pat=_FAKE_PAT
        )

        remote = _git(["remote", "get-url", "origin"], cwd=dest)
        assert remote.stdout.strip() == str(bare_origin)

    def test_nonexistent_remote_raises_workspace_error(self, tmp_path: Path) -> None:
        dest = tmp_path / "scratch" / "conv-1"
        with pytest.raises(WorkspaceError, match="git clone failed"):
            provision_workspace(
                clone_url=str(tmp_path / "does-not-exist.git"),
                branch_name="wixy-ai/conv-1",
                dest=dest,
                pat=_FAKE_PAT,
            )


# ---------------------------------------------------------------------------
# head_sha / push_branch
# ---------------------------------------------------------------------------


class TestHeadShaAndPush:
    def test_head_sha_matches_rev_parse(self, tmp_path: Path, bare_origin: Path) -> None:
        dest = tmp_path / "scratch" / "conv-1"
        provision_workspace(
            clone_url=str(bare_origin), branch_name="wixy-ai/conv-1", dest=dest, pat=_FAKE_PAT
        )

        expected = _git(["rev-parse", "HEAD"], cwd=dest).stdout.strip()
        assert head_sha(dest) == expected

    def test_push_lands_the_branch_on_origin(self, tmp_path: Path, bare_origin: Path) -> None:
        dest = tmp_path / "scratch" / "conv-1"
        provision_workspace(
            clone_url=str(bare_origin), branch_name="wixy-ai/conv-1", dest=dest, pat=_FAKE_PAT
        )
        (dest / "content" / "index.json").write_text('{"hero": {"title": "Updated"}}')
        _git(["add", "."], cwd=dest)
        _git(["commit", "-m", "wixy-ai: update hero title"], cwd=dest)

        push_branch(dest=dest, branch_name="wixy-ai/conv-1", pat=_FAKE_PAT)

        branches = _git(["branch", "-a"], cwd=bare_origin)
        assert "wixy-ai/conv-1" in branches.stdout

    def test_push_never_persists_pat_either(self, tmp_path: Path, bare_origin: Path) -> None:
        dest = tmp_path / "scratch" / "conv-1"
        provision_workspace(
            clone_url=str(bare_origin), branch_name="wixy-ai/conv-1", dest=dest, pat=_FAKE_PAT
        )
        (dest / "content" / "index.json").write_text('{"hero": {"title": "Updated"}}')
        _git(["add", "."], cwd=dest)
        _git(["commit", "-m", "wixy-ai: update hero title"], cwd=dest)

        push_branch(dest=dest, branch_name="wixy-ai/conv-1", pat=_FAKE_PAT)

        config_text = (dest / ".git" / "config").read_text(encoding="utf-8")
        assert _FAKE_PAT not in config_text

    def test_push_to_unreachable_remote_raises(self, tmp_path: Path, bare_origin: Path) -> None:
        dest = tmp_path / "scratch" / "conv-1"
        provision_workspace(
            clone_url=str(bare_origin), branch_name="wixy-ai/conv-1", dest=dest, pat=_FAKE_PAT
        )
        _git(["remote", "set-url", "origin", str(tmp_path / "gone.git")], cwd=dest)

        with pytest.raises(WorkspaceError, match="git push failed"):
            push_branch(dest=dest, branch_name="wixy-ai/conv-1", pat=_FAKE_PAT)


# ---------------------------------------------------------------------------
# touch_activity / sweep_idle_workspaces / cleanup_workspace
# ---------------------------------------------------------------------------


class TestTouchActivity:
    def test_creates_marker_file(self, tmp_path: Path) -> None:
        dest = tmp_path / "conv-1"
        dest.mkdir()
        touch_activity(dest)
        assert (dest / ".wixy-last-active").exists()

    def test_second_call_bumps_mtime(self, tmp_path: Path) -> None:
        dest = tmp_path / "conv-1"
        dest.mkdir()
        touch_activity(dest)
        marker = dest / ".wixy-last-active"
        old_mtime = marker.stat().st_mtime
        # os.utime rather than a real sleep — deterministic, no wall-clock wait.
        os.utime(marker, (old_mtime - 100, old_mtime - 100))
        touch_activity(dest)
        assert marker.stat().st_mtime > old_mtime - 100


class TestSweepIdleWorkspaces:
    def test_removes_dirs_older_than_max_age(self, tmp_path: Path) -> None:
        old = tmp_path / "old-conv"
        old.mkdir()
        touch_activity(old)
        marker = old / ".wixy-last-active"
        old_time = time.time() - 1000
        Path.touch(marker)
        os.utime(marker, (old_time, old_time))

        removed = sweep_idle_workspaces(tmp_path, now=time.time(), max_age_s=500)

        assert removed == ["old-conv"]
        assert not old.exists()

    def test_keeps_recently_active_dirs(self, tmp_path: Path) -> None:
        fresh = tmp_path / "fresh-conv"
        fresh.mkdir()
        touch_activity(fresh)

        removed = sweep_idle_workspaces(tmp_path, now=time.time(), max_age_s=500)

        assert removed == []
        assert fresh.exists()

    def test_falls_back_to_directory_mtime_when_no_marker(self, tmp_path: Path) -> None:
        no_marker = tmp_path / "failed-provision"
        no_marker.mkdir()
        old_time = time.time() - 1000
        os.utime(no_marker, (old_time, old_time))

        removed = sweep_idle_workspaces(tmp_path, now=time.time(), max_age_s=500)

        assert removed == ["failed-provision"]

    def test_ignores_non_directory_entries(self, tmp_path: Path) -> None:
        stray_file = tmp_path / "not-a-workspace.txt"
        stray_file.write_text("hi", encoding="utf-8")
        old_time = time.time() - 1000
        os.utime(stray_file, (old_time, old_time))

        removed = sweep_idle_workspaces(tmp_path, now=time.time(), max_age_s=500)

        assert removed == []
        assert stray_file.exists()

    def test_missing_scratch_root_returns_empty(self, tmp_path: Path) -> None:
        assert sweep_idle_workspaces(tmp_path / "does-not-exist", now=time.time()) == []


class TestCleanupWorkspace:
    def test_removes_the_directory(self, tmp_path: Path, bare_origin: Path) -> None:
        dest = tmp_path / "scratch" / "conv-1"
        provision_workspace(
            clone_url=str(bare_origin), branch_name="wixy-ai/conv-1", dest=dest, pat=_FAKE_PAT
        )
        assert dest.exists()

        cleanup_workspace(dest)

        assert not dest.exists()

    def test_missing_directory_is_a_no_op(self, tmp_path: Path) -> None:
        cleanup_workspace(tmp_path / "never-existed")  # must not raise
