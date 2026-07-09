from __future__ import annotations

from pathlib import Path

from wixy_server.storage import ensure_project_dirs, logs_dir, project_paths


class TestProjectPaths:
    def test_paths_are_computed_under_storage_root(self, tmp_path: Path) -> None:
        paths = project_paths(tmp_path, "ca")
        assert paths.slug == "ca"
        assert paths.root == tmp_path / "projects" / "ca"
        assert paths.repo == tmp_path / "projects" / "ca" / "repo"
        assert paths.draft_overlay == tmp_path / "projects" / "ca" / "draft" / "overlay.json"
        assert paths.draft_media == tmp_path / "projects" / "ca" / "draft" / "media"
        assert paths.live_json == tmp_path / "projects" / "ca" / "live.json"
        assert paths.publishes_jsonl == tmp_path / "projects" / "ca" / "publishes.jsonl"
        assert paths.chats_json == tmp_path / "projects" / "ca" / "chats.json"
        assert paths.publish_lock == tmp_path / "projects" / "ca" / "locks" / "publish.lock"

    def test_build_dir_is_keyed_by_sha(self, tmp_path: Path) -> None:
        paths = project_paths(tmp_path, "ca")
        assert paths.build_dir("abc123") == tmp_path / "projects" / "ca" / "builds" / "abc123"

    def test_different_slugs_are_isolated(self, tmp_path: Path) -> None:
        ca = project_paths(tmp_path, "ca")
        other = project_paths(tmp_path, "other")
        assert ca.root != other.root


class TestLogsDir:
    def test_logs_dir_under_storage_root(self, tmp_path: Path) -> None:
        assert logs_dir(tmp_path) == tmp_path / "logs"


class TestEnsureProjectDirs:
    def test_creates_every_expected_directory(self, tmp_path: Path) -> None:
        paths = project_paths(tmp_path, "ca")
        ensure_project_dirs(paths)
        assert paths.draft_media.is_dir()
        assert paths.builds.is_dir()
        assert paths.locks_dir.is_dir()
        assert not paths.repo.exists()  # repo/ is checkout.py's job, not ours

    def test_idempotent(self, tmp_path: Path) -> None:
        paths = project_paths(tmp_path, "ca")
        ensure_project_dirs(paths)
        ensure_project_dirs(paths)  # must not raise
        assert paths.draft_media.is_dir()
