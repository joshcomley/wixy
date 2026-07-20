"""`GET /api/admin/publishes/{version}/diff`'s computation (decisions/00070):
what a ledger version actually changed on the live site, old→new per content
key — computed by diffing the version's own SHA against the previous ledger
entry's SHA via scratch worktrees, so upstream (AI-lane) merges and restore
entries are covered uniformly, not just the editor-lane overlay keys the
ledger's own `changed` summary records.

Every test uses REAL git repos (a genuine bare origin — test_restore.py's
convention) so the `git worktree add` mechanism is exercised for real.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from builder.config import MediaConfig, ProjectConfig
from builder.jsontypes import JsonValue
from wixy_server.overlay import Overlay, OverlayOp, load_overlay, save_overlay
from wixy_server.publisher import PublishJob, run_publish
from wixy_server.restore import run_restore
from wixy_server.storage import ProjectPaths, ensure_project_dirs, project_paths
from wixy_server.version_diff import build_version_diff

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


def _write_site_files(root: Path, *, themed: bool = False) -> None:
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
    if themed:
        (root / "theme").mkdir(parents=True, exist_ok=True)
        (root / "theme" / "theme.json").write_text(
            json.dumps(
                {
                    "colors": {"cream": "#F1E8D9", "coffee": "#3E312A"},
                    "shadow": "0 18px 44px rgba(62,49,42,.14)",
                    "fonts": {
                        "serif": {
                            "family": "Cormorant Garamond",
                            "weights": ["400", "600"],
                            "italics": True,
                        },
                        "sans": {"family": "Jost", "weights": ["300", "400"], "italics": False},
                        "script": {"family": "Pinyon Script", "weights": ["400"], "italics": False},
                    },
                }
            ),
            encoding="utf-8",
        )


def _make_bare_origin(tmp_path: Path, name: str, *, themed: bool = False) -> Path:
    bare_dir = tmp_path / f"{name}.git"
    bare_dir.mkdir(parents=True)
    _git(["init", "--bare", "--initial-branch=main"], cwd=bare_dir)

    seed = tmp_path / f"{name}-seed"
    _git(["clone", str(bare_dir), str(seed)], cwd=tmp_path)
    _git(["config", "user.email", "seed@example.com"], cwd=seed)
    _git(["config", "user.name", "Seed"], cwd=seed)
    _write_site_files(seed, themed=themed)
    _git(["add", "."], cwd=seed)
    _git(["commit", "-m", "initial"], cwd=seed)
    _git(["push", "origin", "main"], cwd=seed)
    return bare_dir


@pytest.fixture
def bare_origin(tmp_path: Path) -> Path:
    return _make_bare_origin(tmp_path, "origin")


@pytest.fixture
def bare_origin_themed(tmp_path: Path) -> Path:
    return _make_bare_origin(tmp_path, "origin-themed", themed=True)


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
def themed_project(bare_origin_themed: Path) -> ProjectConfig:
    return ProjectConfig(
        slug="test",
        name="Test",
        repo=str(bare_origin_themed),
        default_branch="main",
        cmd_project="test",
        domain="test.example.invalid",
        locale="en-GB",
        indexable=False,
        media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
    )


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    p = project_paths(tmp_path / "storage", "test")
    ensure_project_dirs(p)
    return p


def _make_overlay(ops: dict[str, JsonValue], *, rev: int = 0) -> Overlay:
    return Overlay(
        rev=rev,
        base_sha="",
        ops={key: OverlayOp(value=value, ts=_TS, by="test") for key, value in ops.items()},
        pages_added=(),
        pages_deleted=(),
    )


def _publish(
    project: ProjectConfig, paths: ProjectPaths, ops: dict[str, JsonValue], message: str
) -> int:
    overlay = load_overlay(paths.draft_overlay, default_base_sha="")
    save_overlay(paths.draft_overlay, _make_overlay(ops, rev=overlay.rev))
    result = run_publish(
        project, paths, message=message, expected_rev=overlay.rev, now=_TS, job=PublishJob(id="job")
    )
    return result.version


def _flatten(changes: JsonValue) -> list[tuple[str, str, JsonValue, JsonValue]]:
    """`(file_key, dotted_key, old, new)` rows across every group, for asserting
    without caring about group nesting."""
    assert isinstance(changes, dict)
    rows: list[tuple[str, str, JsonValue, JsonValue]] = []
    for file_key, entries in changes.items():
        assert isinstance(entries, list)
        for entry in entries:
            assert isinstance(entry, dict)
            rows.append((file_key, str(entry["key"]), entry["old"], entry["new"]))
    return rows


class TestBuildVersionDiff:
    def test_a_publish_diffs_against_the_previous_version_with_old_and_new(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")

        diff = build_version_diff(project, paths, 2)

        assert diff is not None
        assert diff["version"] == 2
        assert diff["of"] == 1
        assert _flatten(diff["changes"]) == [("index", "hero.title", "V1 Title", "V2 Title")]

    def test_unchanged_pages_and_keys_are_absent(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")

        diff = build_version_diff(project, paths, 2)

        assert diff is not None
        changes = diff["changes"]
        assert isinstance(changes, dict)
        assert set(changes) == {"index"}  # no about/_global groups
        entries = changes["index"]
        assert isinstance(entries, list)
        assert [e["key"] for e in entries if isinstance(e, dict)] == ["hero.title"]

    def test_the_kind_comes_from_the_versions_own_bindings(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")

        diff = build_version_diff(project, paths, 2)

        assert diff is not None
        changes = diff["changes"]
        assert isinstance(changes, dict)
        entries = changes["index"]
        assert isinstance(entries, list)
        entry = entries[0]
        assert isinstance(entry, dict)
        assert entry["kind"] == "text"  # data-wx on <h1>, not the "text" fallback

    def test_the_first_ever_version_diffs_against_an_empty_baseline(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")

        diff = build_version_diff(project, paths, 1)

        assert diff is not None
        assert diff["of"] is None
        rows = _flatten(diff["changes"])
        assert ("index", "hero.title", None, "V1 Title") in rows

    def test_upstream_changes_between_publishes_are_covered_too(
        self, project: ProjectConfig, paths: ProjectPaths, tmp_path: Path
    ) -> None:
        """The ledger's own `changed` summary records only the editor-lane overlay
        ops — an AI-lane merge that lands between two publishes is invisible to it.
        The SHA-to-SHA diff covers both lanes: the upstream removal of `hero.sub`
        shows up here even though no overlay op ever touched that key."""
        _publish(
            project,
            paths,
            {"index:hero.title": "V1 Title", "index:hero.sub": "V1 Sub"},
            "first",
        )

        # An upstream (AI-lane) commit lands: removes hero.sub from the content.
        work = tmp_path / "upstream-work"
        _git(["clone", str(project.repo), str(work)], cwd=tmp_path)
        _git(["config", "user.email", "ai@example.com"], cwd=work)
        _git(["config", "user.name", "AI"], cwd=work)
        content = json.loads((work / "content" / "index.json").read_text(encoding="utf-8"))
        assert isinstance(content, dict)
        hero = content["hero"]
        assert isinstance(hero, dict)
        del hero["sub"]
        (work / "content" / "index.json").write_text(json.dumps(content), encoding="utf-8")
        _git(["add", "."], cwd=work)
        _git(["commit", "-m", "AI: drop hero.sub"], cwd=work)
        _git(["push", "origin", "main"], cwd=work)

        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")

        diff = build_version_diff(project, paths, 2)
        assert diff is not None
        rows = _flatten(diff["changes"])
        assert ("index", "hero.title", "V1 Title", "V2 Title") in rows
        assert ("index", "hero.sub", "V1 Sub", None) in rows

    def test_a_restore_entry_diffs_against_what_was_live_before_it(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")
        _publish(project, paths, {"index:hero.title": "V2 Title"}, "second")
        restored = run_restore(project, paths, version=1, now=_TS)
        assert restored.version == 3

        diff = build_version_diff(project, paths, 3)

        assert diff is not None
        assert diff["of"] == 2
        assert _flatten(diff["changes"]) == [("index", "hero.title", "V2 Title", "V1 Title")]

    def test_a_theme_change_is_grouped_under_theme_with_kind_theme(
        self, themed_project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(themed_project, paths, {"theme:colors.cream": "#EEEEEE"}, "first")
        _publish(themed_project, paths, {"theme:colors.cream": "#FFFFFF"}, "second")

        diff = build_version_diff(themed_project, paths, 2)

        assert diff is not None
        rows = _flatten(diff["changes"])
        assert ("theme", "colors.cream", "#EEEEEE", "#FFFFFF") in rows
        changes = diff["changes"]
        assert isinstance(changes, dict)
        theme_entries = changes["theme"]
        assert isinstance(theme_entries, list)
        kinds = [
            e["kind"] for e in theme_entries if isinstance(e, dict) and e["key"] == "colors.cream"
        ]
        assert kinds == ["theme"]

    def test_an_unknown_version_returns_none(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _publish(project, paths, {"index:hero.title": "V1 Title"}, "first")

        assert build_version_diff(project, paths, 99) is None
