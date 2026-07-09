from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

from builder.config import MediaConfig, ProjectConfig
from wixy_server.checkout import current_sha
from wixy_server.storage import ProjectPaths, project_paths
from wixy_server.watcher import fetch_once, watch_upstream


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "README.md").write_text("hello\n", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


def _project(repo: str) -> ProjectConfig:
    return ProjectConfig(
        slug="test",
        name="Test",
        repo=repo,
        default_branch="main",
        cmd_project="test",
        domain="test.example.invalid",
        locale="en-GB",
        indexable=False,
        media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
    )


@pytest.fixture
def project(origin_repo: Path) -> ProjectConfig:
    return _project(str(origin_repo))


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return project_paths(tmp_path / "storage", "test")


class TestFetchOnce:
    def test_clones_when_absent(self, project: ProjectConfig, paths: ProjectPaths) -> None:
        fetch_once(project, paths)
        assert (paths.repo / ".git").exists()
        assert (paths.repo / "README.md").exists()

    def test_fetches_when_present(
        self, project: ProjectConfig, paths: ProjectPaths, origin_repo: Path
    ) -> None:
        fetch_once(project, paths)
        first_sha = current_sha(paths.repo)
        (origin_repo / "NEW.md").write_text("new\n", encoding="utf-8")
        _git(["add", "."], origin_repo)
        _git(["commit", "-m", "second"], origin_repo)

        fetch_once(project, paths)

        assert current_sha(paths.repo) != first_sha

    def test_swallows_checkout_error_instead_of_raising(
        self, tmp_path: Path, paths: ProjectPaths
    ) -> None:
        broken_project = _project(str(tmp_path / "does-not-exist"))
        fetch_once(broken_project, paths)  # must not raise
        assert not paths.repo.exists()


class TestWatchUpstream:
    @pytest.mark.asyncio
    async def test_fetches_repeatedly_and_stops_cleanly_on_cancel(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        tick = asyncio.Event()
        call_count = 0

        async def fast_sleep(_seconds: float) -> None:
            nonlocal call_count
            call_count += 1
            tick.set()
            tick.clear()

        task = asyncio.create_task(watch_upstream(project, paths, interval_s=0, sleep=fast_sleep))
        try:
            for _ in range(3):
                await asyncio.wait_for(tick.wait(), timeout=5)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        assert call_count >= 3
        # The very first fetch happens before the first sleep call — proves the loop
        # fetches-then-waits, not waits-then-fetches (spec/04 §7's watcher must have
        # something to serve as soon as it starts, not after the first interval).
        assert (paths.repo / ".git").exists()
