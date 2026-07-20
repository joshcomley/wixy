"""Real-git tests for `wixy_server.backup.snapshot` (spec/independence/06 §2)
— force-push/tag/verify exercised against a genuine BARE repo, mirroring
`test_worker_workspace.py`'s own convention, so M7's FABLE-light gate
checklist items (key-scope is a deploy-config concern, not testable here;
force-push-target IS) are proven for real against actual git refs, not
asserted against a mock call.
"""

from __future__ import annotations

import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import pytest

from wixy_server.backup.settings import BackupSettings
from wixy_server.backup.snapshot import _SNAPSHOT_BRANCH, run_backup_once
from wixy_server.backup.status import read_status


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
def empty_bare_backup_repo(tmp_path: Path) -> Path:
    """A genuine bare repo with ZERO commits — exactly the state a fresh `gh
    repo create --private cottage-aesthetics/ca-state-backup` leaves behind,
    the very first backup run's actual starting point."""
    bare_dir = tmp_path / "ca-state-backup.git"
    bare_dir.mkdir(parents=True)
    _git(["init", "--bare", "--initial-branch=main"], cwd=bare_dir)
    return bare_dir


@pytest.fixture
def seeded_bare_backup_repo(tmp_path: Path) -> Path:
    """A bare repo with real content already on `main` — what's under test
    against this fixture is that a backup run NEVER touches `main`, only
    ever `snapshot` (the force-push-target gate item)."""
    bare_dir = tmp_path / "ca-state-backup.git"
    bare_dir.mkdir(parents=True)
    _git(["init", "--bare", "--initial-branch=main"], cwd=bare_dir)

    seed = tmp_path / "seed"
    _git(["clone", str(bare_dir), str(seed)], cwd=tmp_path)
    _git(["config", "user.email", "seed@example.com"], cwd=seed)
    _git(["config", "user.name", "Seed"], cwd=seed)
    (seed / "README.md").write_text("# ca-state-backup\n", encoding="utf-8")
    _git(["add", "."], cwd=seed)
    _git(["commit", "-m", "initial"], cwd=seed)
    _git(["push", "origin", "main"], cwd=seed)
    return bare_dir


def _make_storage(tmp_path: Path) -> Path:
    """A minimal but representative Storage tree: one project ("ca") with
    every allowlisted file present, PLUS every excluded thing (repo/,
    builds/, locks/, top-level .env) so exclusion is tested against real
    content that would be an obvious leak if it ever slipped through."""
    storage = tmp_path / "storage"
    project = storage / "projects" / "ca"
    project.mkdir(parents=True)
    (project / "live.json").write_text('{"sha": "abc123", "version": 1}', encoding="utf-8")
    (project / "publishes.jsonl").write_text('{"version": 1}\n', encoding="utf-8")
    (project / "chats.json").write_text("[]", encoding="utf-8")
    draft = project / "draft"
    draft.mkdir()
    (draft / "overlay.json").write_text('{"rev": 1, "ops": []}', encoding="utf-8")
    media = draft / "media"
    media.mkdir()
    (media / "photo.jpg").write_text("fake-jpeg-bytes", encoding="utf-8")

    # Excluded (allowlist, not a denylist -- see snapshot.py's own docstring):
    repo = project / "repo"
    repo.mkdir()
    (repo / ".git-marker").write_text("pretend site checkout", encoding="utf-8")
    builds = project / "builds" / "abc123"
    builds.mkdir(parents=True)
    (builds / "index.html").write_text("<html>built</html>", encoding="utf-8")
    locks = project / "locks"
    locks.mkdir()
    (locks / "publish.lock").write_text("", encoding="utf-8")
    (storage / ".env").write_text("WIXY_CF_ACCESS_AUD=super-secret-aud\n", encoding="utf-8")
    (storage / "logs").mkdir()
    (storage / "logs" / "app.log").write_text("2026-07-20 ...", encoding="utf-8")
    return storage


def _settings(
    tmp_path: Path,
    backup_repo: Path,
    *,
    worker_transcripts_root: Path | None = None,
) -> BackupSettings:
    return BackupSettings(
        storage_root=_make_storage(tmp_path),
        backup_repo_url=str(backup_repo),
        worker_transcripts_root=worker_transcripts_root,
        status_path=tmp_path / "backup-status" / "status.json",
        run_once=True,
    )


_WHEN = datetime(2026, 7, 15, 3, 0, 0, tzinfo=UTC)  # not the 1st -- no monthly tag expected
_FIRST_OF_MONTH = datetime(2026, 8, 1, 3, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Force-push target (M7's FABLE-light gate checklist item)
# ---------------------------------------------------------------------------


class TestForcePushTarget:
    def test_main_branch_is_never_touched(
        self, tmp_path: Path, seeded_bare_backup_repo: Path
    ) -> None:
        before = _git(["rev-parse", "main"], cwd=seeded_bare_backup_repo).stdout.strip()

        settings = _settings(tmp_path, seeded_bare_backup_repo)
        result = run_backup_once(settings, now=_WHEN)

        assert result.status.ok, result.status.error
        after = _git(["rev-parse", "main"], cwd=seeded_bare_backup_repo).stdout.strip()
        assert after == before

    def test_only_snapshot_and_main_branches_exist(
        self, tmp_path: Path, seeded_bare_backup_repo: Path
    ) -> None:
        settings = _settings(tmp_path, seeded_bare_backup_repo)
        run_backup_once(settings, now=_WHEN)

        branches = _git(
            ["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd=seeded_bare_backup_repo
        )
        names = set(branches.stdout.split())
        assert names == {"main", _SNAPSHOT_BRANCH}

    def test_snapshot_branch_created_on_empty_repo(
        self, tmp_path: Path, empty_bare_backup_repo: Path
    ) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        result = run_backup_once(settings, now=_WHEN)

        assert result.status.ok, result.status.error
        branches = _git(
            ["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd=empty_bare_backup_repo
        )
        assert branches.stdout.split() == [_SNAPSHOT_BRANCH]


# ---------------------------------------------------------------------------
# Single-commit history (never accumulates)
# ---------------------------------------------------------------------------


class TestSingleCommitHistory:
    def test_snapshot_branch_always_has_exactly_one_commit(
        self, tmp_path: Path, empty_bare_backup_repo: Path
    ) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        run_backup_once(settings, now=_WHEN)
        count_1 = _git(
            ["rev-list", "--count", _SNAPSHOT_BRANCH], cwd=empty_bare_backup_repo
        ).stdout.strip()
        assert count_1 == "1"

        run_backup_once(settings, now=_WHEN)
        count_2 = _git(
            ["rev-list", "--count", _SNAPSHOT_BRANCH], cwd=empty_bare_backup_repo
        ).stdout.strip()
        assert count_2 == "1"

    def test_second_run_produces_a_fresh_orphan_commit(
        self, tmp_path: Path, empty_bare_backup_repo: Path
    ) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        first = run_backup_once(settings, now=_WHEN)
        second = run_backup_once(settings, now=_WHEN)

        assert first.status.commit_sha != second.status.commit_sha
        parents = _git(
            ["rev-list", "--parents", "-n", "1", _SNAPSHOT_BRANCH], cwd=empty_bare_backup_repo
        ).stdout.strip()
        # A single hash with no parent hashes after it -- a true root commit.
        assert len(parents.split()) == 1


# ---------------------------------------------------------------------------
# Allowlist content (what does/doesn't get force-pushed)
# ---------------------------------------------------------------------------


class TestAllowlistContent:
    def _clone_pushed_tree(self, tmp_path: Path, backup_repo: Path) -> Path:
        checkout = tmp_path / "check" / "clone"
        _git(["clone", "--branch", _SNAPSHOT_BRANCH, str(backup_repo), str(checkout)], cwd=tmp_path)
        return checkout

    def test_included_files_are_present(self, tmp_path: Path, empty_bare_backup_repo: Path) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        run_backup_once(settings, now=_WHEN)

        pushed = self._clone_pushed_tree(tmp_path, empty_bare_backup_repo)
        assert (pushed / "projects" / "ca" / "live.json").exists()
        assert (pushed / "projects" / "ca" / "publishes.jsonl").exists()
        assert (pushed / "projects" / "ca" / "chats.json").exists()
        assert (pushed / "projects" / "ca" / "draft" / "overlay.json").exists()
        assert (pushed / "projects" / "ca" / "draft" / "media" / "photo.jpg").exists()

    def test_excluded_paths_are_absent(self, tmp_path: Path, empty_bare_backup_repo: Path) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        run_backup_once(settings, now=_WHEN)

        pushed = self._clone_pushed_tree(tmp_path, empty_bare_backup_repo)
        assert not (pushed / "projects" / "ca" / "repo").exists()
        assert not (pushed / "projects" / "ca" / "builds").exists()
        assert not (pushed / "projects" / "ca" / "locks").exists()
        assert not (pushed / ".env").exists()
        assert not (pushed / "logs").exists()

    def test_env_secret_value_never_appears_anywhere_in_the_pushed_tree(
        self, tmp_path: Path, empty_bare_backup_repo: Path
    ) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        run_backup_once(settings, now=_WHEN)

        pushed = self._clone_pushed_tree(tmp_path, empty_bare_backup_repo)
        for path in pushed.rglob("*"):
            if path.is_file():
                assert "super-secret-aud" not in path.read_text(encoding="utf-8", errors="ignore")

    def test_worker_transcripts_included_when_configured(
        self, tmp_path: Path, empty_bare_backup_repo: Path
    ) -> None:
        transcripts_root = tmp_path / "worker-transcripts"
        (transcripts_root / "conv-1").mkdir(parents=True)
        (transcripts_root / "conv-1" / "transcript.jsonl").write_text(
            '{"role": "user"}\n', encoding="utf-8"
        )
        settings = _settings(
            tmp_path, empty_bare_backup_repo, worker_transcripts_root=transcripts_root
        )
        run_backup_once(settings, now=_WHEN)

        pushed = self._clone_pushed_tree(tmp_path, empty_bare_backup_repo)
        assert (pushed / "worker-transcripts" / "conv-1" / "transcript.jsonl").exists()

    def test_worker_transcripts_absent_when_not_configured(
        self, tmp_path: Path, empty_bare_backup_repo: Path
    ) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo, worker_transcripts_root=None)
        run_backup_once(settings, now=_WHEN)

        pushed = self._clone_pushed_tree(tmp_path, empty_bare_backup_repo)
        assert not (pushed / "worker-transcripts").exists()


# ---------------------------------------------------------------------------
# Monthly tag: push-on-the-1st + prune to 12
# ---------------------------------------------------------------------------


class TestMonthlyTag:
    def test_no_tag_pushed_on_a_non_first_day(
        self, tmp_path: Path, empty_bare_backup_repo: Path
    ) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        result = run_backup_once(settings, now=_WHEN)

        assert result.status.monthly_tag_pushed is None
        tags = _git(["tag", "-l"], cwd=empty_bare_backup_repo).stdout.split()
        assert tags == []

    def test_tag_pushed_on_the_first_of_the_month(
        self, tmp_path: Path, empty_bare_backup_repo: Path
    ) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        result = run_backup_once(settings, now=_FIRST_OF_MONTH)

        assert result.status.monthly_tag_pushed == "monthly/2026-08"
        tags = _git(["tag", "-l"], cwd=empty_bare_backup_repo).stdout.split()
        assert tags == ["monthly/2026-08"]
        tag_sha = _git(
            ["rev-list", "-n", "1", "monthly/2026-08"], cwd=empty_bare_backup_repo
        ).stdout.strip()
        assert tag_sha == result.status.commit_sha

    def test_prunes_down_to_twelve_kept(self, tmp_path: Path, empty_bare_backup_repo: Path) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        # Seed 13 pre-existing monthly tags (a backup that's been running
        # more than a year, or missed pruning for a month) on the initial
        # snapshot commit, oldest first -- plus this run's own new tag makes
        # 14 total seen by the prune pass, so pruning down to 12 must delete
        # exactly the OLDEST TWO, not just one -- proving the loop actually
        # walks the excess, not merely "delete the single oldest."
        run_backup_once(settings, now=_WHEN)
        seed = tmp_path / "tag-seed"
        _git(
            ["clone", "--branch", _SNAPSHOT_BRANCH, str(empty_bare_backup_repo), str(seed)],
            cwd=tmp_path,
        )
        base_sha = _git(["rev-parse", _SNAPSHOT_BRANCH], cwd=seed).stdout.strip()
        seeded_names = [f"monthly/2025-{month:02d}" for month in range(1, 13)] + ["monthly/2026-01"]
        for tag_name in seeded_names:
            _git(["tag", tag_name, base_sha], cwd=seed)
            _git(["push", "origin", tag_name], cwd=seed)

        result = run_backup_once(settings, now=_FIRST_OF_MONTH)

        assert result.status.monthly_tag_pushed == "monthly/2026-08"
        tags = sorted(_git(["tag", "-l"], cwd=empty_bare_backup_repo).stdout.split())
        assert len(tags) == 12
        # The two oldest (2025-01, 2025-02) are gone; everything else, incl.
        # this run's own new tag, survives.
        assert "monthly/2025-01" not in tags
        assert "monthly/2025-02" not in tags
        assert "monthly/2025-03" in tags
        assert "monthly/2026-01" in tags
        assert "monthly/2026-08" in tags


# ---------------------------------------------------------------------------
# Verification + status file
# ---------------------------------------------------------------------------


class TestVerificationAndStatus:
    def test_successful_run_writes_a_verified_status(
        self, tmp_path: Path, empty_bare_backup_repo: Path
    ) -> None:
        settings = _settings(tmp_path, empty_bare_backup_repo)
        result = run_backup_once(settings, now=_WHEN)

        assert result.status.ok is True
        assert result.status.verified is True
        assert result.status.commit_sha is not None
        assert result.status.error is None

        on_disk = read_status(settings.status_path)
        assert on_disk == result.status

    def test_unreachable_remote_never_raises_and_records_the_error(self, tmp_path: Path) -> None:
        settings = _settings(tmp_path, Path("/does/not/exist.git"))
        result = run_backup_once(settings, now=_WHEN)

        assert result.status.ok is False
        assert result.status.error is not None
        assert result.status.commit_sha is None

        on_disk = read_status(settings.status_path)
        assert on_disk is not None
        assert on_disk.ok is False

    def test_scratch_directory_is_cleaned_up_after_a_run(
        self,
        tmp_path: Path,
        empty_bare_backup_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Tracks exactly the ONE scratch dir THIS call creates, immune to
        # sibling xdist workers' own concurrent scratch dirs in the same
        # shared system temp dir (a plain before/after glob diff raced with
        # them and flaked).
        created: list[str] = []
        real_mkdtemp = tempfile.mkdtemp

        def _tracking_mkdtemp(
            suffix: str | None = None, prefix: str | None = None, dir: str | None = None
        ) -> str:
            path = real_mkdtemp(suffix, prefix, dir)
            created.append(path)
            return path

        monkeypatch.setattr(tempfile, "mkdtemp", _tracking_mkdtemp)

        settings = _settings(tmp_path, empty_bare_backup_repo)
        run_backup_once(settings, now=_WHEN)

        assert len(created) == 1
        assert not Path(created[0]).exists()
