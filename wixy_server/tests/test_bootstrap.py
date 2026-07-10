"""`bootstrap_if_needed` tests (spec/04-server.md §3, spec/07-hosting-deploy.md §1) — the
server's own "publish zero." Real git repos throughout, same convention as
`test_publisher.py`."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from builder.config import MediaConfig, ProjectConfig
from wixy_server.bootstrap import BOOTSTRAP_VERSION, bootstrap_if_needed
from wixy_server.checkout import ensure_checkout
from wixy_server.ledger import read_ledger
from wixy_server.live_pointer import load_live_pointer
from wixy_server.storage import ProjectPaths, ensure_project_dirs, project_paths

_TS = "2026-07-10T09:00:00+00:00"

_INDEX_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<h1 data-wx="hero.title">placeholder</h1>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""
_PARTIAL_HTML = "<body></body>\n"
_NO_BODY_HTML = "<!DOCTYPE html>\n<html><head><title>placeholder</title></head></html>\n"


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _write_buildable_site(root: Path) -> None:
    (root / "pages").mkdir(parents=True, exist_ok=True)
    (root / "partials").mkdir(parents=True, exist_ok=True)
    (root / "content").mkdir(parents=True, exist_ok=True)
    (root / "pages" / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (root / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (root / "content" / "index.json").write_text(
        json.dumps({"meta": {"title": "Home"}, "hero": {"title": "Original Title"}}),
        encoding="utf-8",
    )
    (root / "content" / "_global.json").write_text("{}", encoding="utf-8")


def _init_repo(repo_dir: Path) -> None:
    repo_dir.mkdir(parents=True, exist_ok=True)
    _git(["init", "--initial-branch=main"], repo_dir)
    _git(["config", "user.email", "test@example.com"], repo_dir)
    _git(["config", "user.name", "Test"], repo_dir)


def _commit_all(repo_dir: Path, message: str) -> str:
    _git(["add", "."], repo_dir)
    _git(["commit", "-m", message], repo_dir)
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo_dir, check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    """A real, buildable one-page repo."""
    origin = tmp_path / "origin"
    _init_repo(origin)
    _write_buildable_site(origin)
    _commit_all(origin, "initial")
    return origin


@pytest.fixture
def project(origin_repo: Path) -> ProjectConfig:
    return ProjectConfig(
        slug="test",
        name="Test",
        repo=str(origin_repo),
        default_branch="main",
        cmd_project="test",
        domain="test.example.invalid",
        locale="en-GB",
        indexable=False,
        media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
    )


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture
def paths(storage_root: Path) -> ProjectPaths:
    p = project_paths(storage_root, "test")
    ensure_project_dirs(p)
    return p


class TestBootstrapIfNeeded:
    def test_noop_when_live_pointer_already_exists(
        self, project: ProjectConfig, paths: ProjectPaths, origin_repo: Path
    ) -> None:
        ensure_checkout(project.repo, project.default_branch, paths.repo)
        first = bootstrap_if_needed(project, paths, _TS)
        assert first is True

        second = bootstrap_if_needed(project, paths, _TS)
        assert second is False
        assert len(read_ledger(paths)) == 1  # not duplicated

    def test_noop_when_checkout_not_cloned_yet(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        # paths.repo was never cloned — no .git dir at all.
        assert bootstrap_if_needed(project, paths, _TS) is False
        assert load_live_pointer(paths) is None
        assert read_ledger(paths) == []

    def test_noop_when_checkout_has_no_pages(self, storage_root: Path, tmp_path: Path) -> None:
        # A genuine git repo with no pages/ dir at all (e.g. a pre-migration-step-1
        # checkout, spec/03 §3.1) — not a real, buildable site yet.
        bare_repo = tmp_path / "bare-origin"
        _init_repo(bare_repo)
        (bare_repo / "README.md").write_text("hi\n", encoding="utf-8")
        _commit_all(bare_repo, "initial")

        project = ProjectConfig(
            slug="bare",
            name="Bare",
            repo=str(bare_repo),
            default_branch="main",
            cmd_project="bare",
            domain="bare.example.invalid",
            locale="en-GB",
            indexable=False,
            media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
        )
        paths = project_paths(storage_root, "bare")
        ensure_project_dirs(paths)
        ensure_checkout(project.repo, project.default_branch, paths.repo)

        assert bootstrap_if_needed(project, paths, _TS) is False
        assert load_live_pointer(paths) is None
        assert read_ledger(paths) == []

    def test_bootstraps_a_real_buildable_checkout(
        self, project: ProjectConfig, paths: ProjectPaths, origin_repo: Path
    ) -> None:
        head_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=origin_repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        ensure_checkout(project.repo, project.default_branch, paths.repo)

        assert bootstrap_if_needed(project, paths, _TS) is True

        pointer = load_live_pointer(paths)
        assert pointer is not None
        assert pointer.sha == head_sha
        assert pointer.version == BOOTSTRAP_VERSION == 0
        assert (pointer.build_dir / "index.html").exists()

        entries = read_ledger(paths)
        assert len(entries) == 1
        assert entries[0].version == 0
        assert entries[0].sha == head_sha
        assert entries[0].source == "bootstrap"
        assert entries[0].when == _TS

    def test_swallows_build_errors_and_returns_false(
        self, storage_root: Path, tmp_path: Path
    ) -> None:
        # A page template with no <body> — load_site_source happily lists it (it
        # only globs pages/*.html), but build_site's render step raises BuildError.
        broken = tmp_path / "broken-origin"
        _init_repo(broken)
        (broken / "pages").mkdir(parents=True)
        (broken / "partials").mkdir()
        (broken / "content").mkdir()
        (broken / "pages" / "index.html").write_text(_NO_BODY_HTML, encoding="utf-8")
        (broken / "content" / "index.json").write_text(
            json.dumps({"meta": {"title": "Home"}}), encoding="utf-8"
        )
        (broken / "content" / "_global.json").write_text("{}", encoding="utf-8")
        _commit_all(broken, "initial")

        project = ProjectConfig(
            slug="broken",
            name="Broken",
            repo=str(broken),
            default_branch="main",
            cmd_project="broken",
            domain="broken.example.invalid",
            locale="en-GB",
            indexable=False,
            media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
        )
        paths = project_paths(storage_root, "broken")
        ensure_project_dirs(paths)
        ensure_checkout(project.repo, project.default_branch, paths.repo)

        assert bootstrap_if_needed(project, paths, _TS) is False
        assert load_live_pointer(paths) is None
        assert read_ledger(paths) == []
