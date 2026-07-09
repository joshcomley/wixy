"""spec/04-server.md §5's restore paragraph + §6 — every test uses REAL git repos
(a genuine bare origin, matching test_publisher.py's own convention) so restore's
`git worktree add` mechanism is exercised for real, not mocked.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from builder.config import MediaConfig, ProjectConfig
from builder.jsontypes import JsonValue
from wixy_server.ledger import read_ledger
from wixy_server.live_pointer import load_live_pointer
from wixy_server.overlay import Overlay, OverlayOp, PageAdd, load_overlay, save_overlay
from wixy_server.publisher import PublishJob, run_publish
from wixy_server.restore import RestoreError, ensure_build, run_restore
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
_ABOUT_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<p data-wx="intro.body">placeholder</p>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""
_PARTIAL_HTML = "<body></body>\n"


def _git(args: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _write_site_files(root: Path) -> None:
    (root / "pages").mkdir(parents=True, exist_ok=True)
    (root / "partials").mkdir(parents=True, exist_ok=True)
    (root / "content").mkdir(parents=True, exist_ok=True)
    (root / "images").mkdir(parents=True, exist_ok=True)
    (root / "pages" / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    (root / "pages" / "about.html").write_text(_ABOUT_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (root / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (root / "content" / "index.json").write_text(
        json.dumps(
            {
                "meta": {"title": "Home", "navLabel": "Home", "inNav": True, "navOrder": 10},
                "hero": {"title": "Original Title"},
            }
        ),
        encoding="utf-8",
    )
    (root / "content" / "about.json").write_text(
        json.dumps(
            {
                "meta": {"title": "About", "navLabel": "About", "inNav": True, "navOrder": 20},
                "intro": {"body": "About us"},
            }
        ),
        encoding="utf-8",
    )
    (root / "content" / "_global.json").write_text("{}", encoding="utf-8")


@pytest.fixture
def bare_origin(tmp_path: Path) -> Path:
    bare_dir = tmp_path / "origin.git"
    bare_dir.mkdir(parents=True)
    _git(["init", "--bare", "--initial-branch=main"], cwd=bare_dir)

    seed = tmp_path / "seed"
    _git(["clone", str(bare_dir), str(seed)], cwd=tmp_path)
    _git(["config", "user.email", "seed@example.com"], cwd=seed)
    _git(["config", "user.name", "Seed"], cwd=seed)
    _write_site_files(seed)
    _git(["add", "."], cwd=seed)
    _git(["commit", "-m", "initial"], cwd=seed)
    _git(["push", "origin", "main"], cwd=seed)
    return bare_dir


@pytest.fixture
def project(bare_origin: Path) -> ProjectConfig:
    return ProjectConfig(
        slug="test",
        name="Test",
        repo=str(bare_origin),
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


def _make_overlay(
    ops: dict[str, JsonValue],
    *,
    rev: int = 0,
    pages_added: tuple[PageAdd, ...] = (),
    pages_deleted: tuple[str, ...] = (),
) -> Overlay:
    return Overlay(
        rev=rev,
        base_sha="",
        ops={key: OverlayOp(value=value, ts=_TS, by="test") for key, value in ops.items()},
        pages_added=pages_added,
        pages_deleted=pages_deleted,
    )


def _new_job() -> PublishJob:
    return PublishJob(id="job-1")


def _publish(
    project: ProjectConfig, paths: ProjectPaths, ops: dict[str, JsonValue], message: str
) -> int:
    overlay = load_overlay(paths.draft_overlay, default_base_sha="")
    save_overlay(paths.draft_overlay, _make_overlay(ops, rev=overlay.rev))
    result = run_publish(
        project, paths, message=message, expected_rev=overlay.rev, now=_TS, job=_new_job()
    )
    return result.version


class TestRunRestore:
    def test_restores_content_and_flips_the_live_pointer(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")

        result = run_restore(project, paths, version=1, now=_TS)

        assert result.version == 3  # a new sequential version, not version 1 again
        assert result.of == 1

        pointer = load_live_pointer(paths)
        assert pointer is not None
        assert pointer.version == 3
        assert (pointer.build_dir / "index.html").read_text(encoding="utf-8").find("V1 Title") != -1

        entries = read_ledger(paths)
        assert len(entries) == 3
        assert entries[2].action == "restore"
        assert entries[2].of == 1
        assert entries[2].sha == entries[0].sha  # v1's own sha, no new commit

    def test_sets_the_overlay_to_the_diff_needed_to_reproduce_the_old_version(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")

        run_restore(project, paths, version=1, now=_TS)

        overlay = load_overlay(paths.draft_overlay, default_base_sha="")
        assert overlay.ops["index:hero.title"].value == "V1 Title"

    def test_an_unchanged_key_produces_no_overlay_op(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        # about.json's content never changes between the two publishes.
        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")

        run_restore(project, paths, version=1, now=_TS)

        overlay = load_overlay(paths.draft_overlay, default_base_sha="")
        assert not any(key.startswith("about:") for key in overlay.ops)

    def test_a_list_bound_field_change_is_a_whole_value_op_not_per_item(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        # _global.json has no list-bound field in this fixture's own template
        # set, so this proves the diff's generic "atomic-compare anything that
        # isn't a dict" behavior directly against a plain JSON array value
        # (meta.navOrder is a scalar; this uses a synthetic array-shaped value
        # to prove list handling without depending on a real data-wx-list
        # binding existing in the fixture).
        _publish(project, paths, {"index:hero.items": ["a", "b"]}, "first")
        _publish(project, paths, {"index:hero.items": ["a", "b", "c"]}, "second")

        run_restore(project, paths, version=1, now=_TS)

        overlay = load_overlay(paths.draft_overlay, default_base_sha="")
        assert overlay.ops["index:hero.items"].value == ["a", "b"]

    def test_a_page_added_since_the_restored_version_is_staged_for_deletion(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")  # v1: index+about only

        # v2 duplicates "about" into a new "contact" page (test_publisher.py's
        # own TestPageOps precedent) — current main now has index+about+contact.
        overlay = load_overlay(paths.draft_overlay, default_base_sha="")
        save_overlay(
            paths.draft_overlay,
            _make_overlay(
                {"contact:meta.title": "Contact", "contact:intro.body": "Contact us"},
                rev=overlay.rev,
                pages_added=(PageAdd(slug="contact", from_slug="about"),),
            ),
        )
        run_publish(
            project, paths, message="add contact", expected_rev=overlay.rev, now=_TS, job=_new_job()
        )
        assert (paths.repo / "pages" / "contact.html").exists()

        run_restore(project, paths, version=1, now=_TS)

        overlay_after = load_overlay(paths.draft_overlay, default_base_sha="")
        assert overlay_after.pages_deleted == ("contact",)

    def test_rebuilds_a_pruned_build_via_a_scratch_worktree(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        v1 = _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        entries = read_ledger(paths)
        v1_sha = entries[0].sha
        assert paths.build_dir(v1_sha).is_dir()

        # Simulate pruning (publisher._prune_builds would do this after enough
        # later publishes) without needing 20 real publishes in this test.
        import shutil

        shutil.rmtree(paths.build_dir(v1_sha))
        assert not paths.build_dir(v1_sha).is_dir()

        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")

        result = run_restore(project, paths, version=v1, now=_TS)

        assert paths.build_dir(v1_sha).is_dir()
        assert (paths.build_dir(v1_sha) / "index.html").read_text(encoding="utf-8").find(
            "V1 Title"
        ) != -1
        assert result.sha == v1_sha

    def test_unknown_version_raises_restore_error(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1"}, "first")
        with pytest.raises(RestoreError, match="no such version"):
            run_restore(project, paths, version=99, now=_TS)

    def test_resurrecting_a_fully_deleted_page_is_refused(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {}, "first")  # about.html exists in v1
        overlay = load_overlay(paths.draft_overlay, default_base_sha="")
        save_overlay(
            paths.draft_overlay, _make_overlay({}, rev=overlay.rev, pages_deleted=("about",))
        )
        run_publish(
            project,
            paths,
            message="delete about",
            expected_rev=overlay.rev,
            now=_TS,
            job=_new_job(),
        )

        with pytest.raises(RestoreError, match="about"):
            run_restore(project, paths, version=1, now=_TS)

    def test_restore_does_not_touch_the_main_checkout(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")
        sha_before = _git(["rev-parse", "HEAD"], cwd=paths.repo).stdout.strip()

        run_restore(project, paths, version=1, now=_TS)

        sha_after = _git(["rev-parse", "HEAD"], cwd=paths.repo).stdout.strip()
        assert sha_after == sha_before  # no commit, no checkout mutation
        content = json.loads((paths.repo / "content" / "index.json").read_text(encoding="utf-8"))
        assert content["hero"]["title"] == "V2 Title"  # still the CURRENT published value


class TestEnsureBuild:
    def test_returns_the_existing_build_dir_without_rebuilding(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        entries = read_ledger(paths)
        sha = entries[0].sha
        build_dir = ensure_build(project, paths, sha)
        assert build_dir == paths.build_dir(sha)
        assert build_dir.is_dir()
