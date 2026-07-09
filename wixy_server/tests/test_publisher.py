"""spec/04-server.md §5's publish pipeline — every test here uses REAL git repos,
with the origin simulated as a genuine BARE repo (spec/08-testing-acceptance.md
§1), so push-rejection/race behavior is exercised for real, not mocked.
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
from wixy_server.overlay import (
    Overlay,
    OverlayOp,
    PageAdd,
    RevConflictError,
    load_overlay,
    save_overlay,
)
from wixy_server.publisher import (
    PublishError,
    PublishJob,
    _commit_push_and_tag,
    _materialize,
    run_publish,
)
from wixy_server.storage import ProjectPaths, ensure_project_dirs, project_paths

_TS = "2026-07-10T09:00:00+00:00"

_INDEX_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<h1 data-wx="hero.title">placeholder</h1>
<div data-wx-bg="hero.bg" style="">bg</div>
<ul data-wx-list="showcase.items">
<li data-wx-list-item><img data-wx-img=".img" src="" alt=""></li>
</ul>
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
    (root / "theme").mkdir(parents=True, exist_ok=True)
    (root / "pages" / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    (root / "pages" / "about.html").write_text(_ABOUT_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (root / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (root / "content" / "index.json").write_text(
        json.dumps(
            {
                "meta": {"title": "Home", "navLabel": "Home", "inNav": True, "navOrder": 10},
                "hero": {
                    "title": "Original Title",
                    "bg": {"src": "images/hero.jpg", "alt": "hero"},
                },
                "showcase": {"items": [{"img": {"src": "images/hero.jpg", "alt": "one"}}]},
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
    (root / "theme" / "theme.json").write_text(
        json.dumps(
            {
                "colors": {"cream": "#F1E8D9"},
                "shadow": "0 1px 2px black",
                "fonts": {
                    "serif": {"family": "Cormorant Garamond", "weights": ["400"], "italics": False},
                    "sans": {"family": "Jost", "weights": ["400"], "italics": False},
                    "script": {"family": "Pinyon Script", "weights": ["400"], "italics": False},
                },
            }
        ),
        encoding="utf-8",
    )
    (root / "images" / "hero.jpg").write_bytes(b"fake-jpeg-bytes")


@pytest.fixture
def bare_origin(tmp_path: Path) -> Path:
    """A genuine bare repo (spec/08 §1) — pushed to from a scratch seed clone,
    never a working tree of its own."""
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


class TestRunPublishHappyPath:
    def test_publishes_a_content_change_end_to_end(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(paths.draft_overlay, _make_overlay({"index:hero.title": "New Title"}))
        job = _new_job()

        result = run_publish(
            project, paths, message="test publish", expected_rev=0, now=_TS, job=job
        )

        assert job.stage == "done"
        assert job.error is None
        assert result.version == 1

        pointer = load_live_pointer(paths)
        assert pointer is not None
        assert pointer.version == 1
        assert pointer.sha == result.sha
        assert (pointer.build_dir / "index.html").read_text(encoding="utf-8").find(
            "New Title"
        ) != -1

        content = json.loads((paths.repo / "content" / "index.json").read_text(encoding="utf-8"))
        assert content["hero"]["title"] == "New Title"

        entries = read_ledger(paths)
        assert len(entries) == 1
        assert entries[0].version == 1
        assert entries[0].source == "editor"
        assert entries[0].changed == {"index": ["hero.title"]}

        overlay_after = load_overlay(paths.draft_overlay, default_base_sha="")
        assert overlay_after.ops == {}

        tags = _git(["tag", "-l"], cwd=paths.repo).stdout.split()
        assert "wixy-publish-v1" in tags

    def test_theme_change_is_materialized(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(paths.draft_overlay, _make_overlay({"theme:colors.cream": "#000000"}))
        job = _new_job()
        run_publish(project, paths, message="theme", expected_rev=0, now=_TS, job=job)

        theme = json.loads((paths.repo / "theme" / "theme.json").read_text(encoding="utf-8"))
        assert theme["colors"]["cream"] == "#000000"

    def test_global_content_change_is_materialized(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(paths.draft_overlay, _make_overlay({"_global:phone": "01234 567890"}))
        job = _new_job()
        run_publish(project, paths, message="global", expected_rev=0, now=_TS, job=job)

        global_content = json.loads(
            (paths.repo / "content" / "_global.json").read_text(encoding="utf-8")
        )
        assert global_content["phone"] == "01234 567890"

    def test_a_pure_upstream_publish_with_no_draft_ops_still_succeeds(
        self, project: ProjectConfig, paths: ProjectPaths, tmp_path: Path
    ) -> None:
        # "Upstream commits since the last publish" is only a meaningful concept
        # once there IS a last publish — establish one first, THEN simulate the
        # AI lane merging a commit before the owner's SECOND publish.
        save_overlay(paths.draft_overlay, _make_overlay({}))
        run_publish(project, paths, message="first", expected_rev=0, now=_TS, job=_new_job())

        seed2 = tmp_path / "seed2"
        _git(["clone", str(Path(project.repo)), str(seed2)], cwd=tmp_path)
        _git(["config", "user.email", "ai@example.com"], cwd=seed2)
        _git(["config", "user.name", "AI Lane"], cwd=seed2)
        (seed2 / "content" / "about.json").write_text(
            json.dumps({"meta": {"title": "About Us"}, "intro": {"body": "Updated by AI"}}),
            encoding="utf-8",
        )
        _git(["add", "."], cwd=seed2)
        _git(["commit", "-m", "ai lane update"], cwd=seed2)
        _git(["push", "origin", "main"], cwd=seed2)

        save_overlay(paths.draft_overlay, _make_overlay({}, rev=1))
        job = _new_job()
        result = run_publish(
            project, paths, message="publish upstream", expected_rev=1, now=_TS, job=job
        )

        assert job.stage == "done"
        entries = read_ledger(paths)
        assert entries[1].source == "upstream"
        content = json.loads((paths.repo / "content" / "about.json").read_text(encoding="utf-8"))
        assert content["intro"]["body"] == "Updated by AI"
        assert result.sha == _git(["rev-parse", "HEAD"], cwd=paths.repo).stdout.strip()

    def test_editor_and_upstream_changes_together_are_source_mixed(
        self, project: ProjectConfig, paths: ProjectPaths, tmp_path: Path
    ) -> None:
        save_overlay(paths.draft_overlay, _make_overlay({}))
        run_publish(project, paths, message="first", expected_rev=0, now=_TS, job=_new_job())

        seed2 = tmp_path / "seed2"
        _git(["clone", str(Path(project.repo)), str(seed2)], cwd=tmp_path)
        _git(["config", "user.email", "ai@example.com"], cwd=seed2)
        _git(["config", "user.name", "AI Lane"], cwd=seed2)
        (seed2 / "content" / "about.json").write_text(
            json.dumps({"meta": {"title": "About Us"}, "intro": {"body": "Updated by AI"}}),
            encoding="utf-8",
        )
        _git(["add", "."], cwd=seed2)
        _git(["commit", "-m", "ai lane update"], cwd=seed2)
        _git(["push", "origin", "main"], cwd=seed2)

        save_overlay(paths.draft_overlay, _make_overlay({"index:hero.title": "Mixed"}, rev=1))
        job = _new_job()
        run_publish(project, paths, message="mixed", expected_rev=1, now=_TS, job=job)

        assert read_ledger(paths)[1].source == "mixed"

    def test_second_publish_gets_version_2(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(paths.draft_overlay, _make_overlay({"index:hero.title": "First"}))
        run_publish(project, paths, message="first", expected_rev=0, now=_TS, job=_new_job())

        save_overlay(paths.draft_overlay, _make_overlay({"index:hero.title": "Second"}, rev=1))
        result = run_publish(
            project, paths, message="second", expected_rev=1, now=_TS, job=_new_job()
        )

        assert result.version == 2
        assert len(read_ledger(paths)) == 2


class TestRevConflict:
    def test_stale_rev_raises_without_touching_anything(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(paths.draft_overlay, _make_overlay({"index:hero.title": "New"}, rev=0))
        job = _new_job()

        with pytest.raises(RevConflictError):
            run_publish(project, paths, message="test", expected_rev=5, now=_TS, job=job)

        assert job.stage == "pulling"  # the initial value -- never even started
        assert job.error is None
        assert load_live_pointer(paths) is None
        assert read_ledger(paths) == []
        assert not paths.publish_lock.exists()


class TestValidateFailure:
    def test_a_dangling_image_reference_aborts_and_leaves_everything_untouched(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(
            paths.draft_overlay,
            _make_overlay({"index:hero.bg": {"src": "images/does-not-exist.jpg", "alt": "x"}}),
        )
        job = _new_job()

        with pytest.raises(PublishError) as exc_info:
            run_publish(project, paths, message="bad", expected_rev=0, now=_TS, job=job)

        assert exc_info.value.stage == "merging"
        assert job.stage == "failed"
        assert load_live_pointer(paths) is None
        assert read_ledger(paths) == []
        overlay_after = load_overlay(paths.draft_overlay, default_base_sha="")
        assert overlay_after.rev == 0  # untouched -- never discarded
        assert "index:hero.bg" in overlay_after.ops
        content = json.loads((paths.repo / "content" / "index.json").read_text(encoding="utf-8"))
        assert content["hero"]["title"] == "Original Title"  # working tree reset
        assert not paths.publish_lock.exists()

    def test_working_tree_is_actually_clean_after_the_abort(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(
            paths.draft_overlay,
            _make_overlay({"index:hero.bg": {"src": "images/does-not-exist.jpg", "alt": "x"}}),
        )
        with pytest.raises(PublishError):
            run_publish(project, paths, message="bad", expected_rev=0, now=_TS, job=_new_job())

        status = _git(["status", "--porcelain"], cwd=paths.repo).stdout
        assert status == ""


class TestMediaMove:
    def test_a_draft_media_reference_is_moved_and_rewritten(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        paths.draft_media.mkdir(parents=True, exist_ok=True)
        (paths.draft_media / "abcd1234-new.jpg").write_bytes(b"new-image-bytes")
        save_overlay(
            paths.draft_overlay,
            _make_overlay(
                {"index:hero.bg": {"src": "/admin/draft-media/abcd1234-new.jpg", "alt": "New"}}
            ),
        )
        job = _new_job()

        run_publish(project, paths, message="new image", expected_rev=0, now=_TS, job=job)

        content = json.loads((paths.repo / "content" / "index.json").read_text(encoding="utf-8"))
        assert content["hero"]["bg"]["src"] == "images/abcd1234-new.jpg"
        assert (paths.repo / "images" / "abcd1234-new.jpg").read_bytes() == b"new-image-bytes"
        assert not (paths.draft_media / "abcd1234-new.jpg").exists()

    def test_an_item_scoped_whole_array_media_reference_is_rewritten(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        paths.draft_media.mkdir(parents=True, exist_ok=True)
        (paths.draft_media / "efgh5678-item.jpg").write_bytes(b"item-image-bytes")
        save_overlay(
            paths.draft_overlay,
            _make_overlay(
                {
                    "index:showcase.items": [
                        {"img": {"src": "/admin/draft-media/efgh5678-item.jpg", "alt": "Item"}}
                    ]
                }
            ),
        )
        run_publish(project, paths, message="item image", expected_rev=0, now=_TS, job=_new_job())

        content = json.loads((paths.repo / "content" / "index.json").read_text(encoding="utf-8"))
        assert content["showcase"]["items"][0]["img"]["src"] == "images/efgh5678-item.jpg"
        assert (paths.repo / "images" / "efgh5678-item.jpg").exists()

    def test_a_validate_failure_leaves_the_staged_draft_file_in_place(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        """The safety property this test exists to prove: even though materialize
        COPIES the referenced file into images/ before validate runs (so validate's
        own image-exists check can pass), a subsequent validate failure on a
        DIFFERENT key must never lose the original staged file — it's only
        deleted from draft/media/ after validate has actually succeeded."""
        paths.draft_media.mkdir(parents=True, exist_ok=True)
        (paths.draft_media / "abcd1234-new.jpg").write_bytes(b"new-image-bytes")
        save_overlay(
            paths.draft_overlay,
            _make_overlay(
                {
                    "index:hero.bg": {"src": "/admin/draft-media/abcd1234-new.jpg", "alt": "New"},
                    # A second op on a DIFFERENT key that will fail validate.
                    "about:intro.body": None,
                }
            ),
        )
        with pytest.raises(PublishError):
            run_publish(project, paths, message="bad", expected_rev=0, now=_TS, job=_new_job())

        assert (paths.draft_media / "abcd1234-new.jpg").read_bytes() == b"new-image-bytes"


class TestPageOps:
    def test_page_delete_removes_template_and_content(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(paths.draft_overlay, _make_overlay({}, pages_deleted=("about",)))
        run_publish(project, paths, message="delete about", expected_rev=0, now=_TS, job=_new_job())

        assert not (paths.repo / "pages" / "about.html").exists()
        assert not (paths.repo / "content" / "about.json").exists()

    def test_page_duplicate_copies_the_template_and_applies_new_content(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        # Duplicating "about" carries ALL of its bindings, not just the ones this
        # test cares about asserting — about.html binds `intro.body` too, so the
        # new page's content must supply it or `builder validate` correctly
        # rejects a page with an unresolvable text binding (that's the producer
        # route's job in a real duplicate flow; this test seeds it directly).
        save_overlay(
            paths.draft_overlay,
            _make_overlay(
                {"contact:meta.title": "Contact", "contact:intro.body": "Contact us"},
                pages_added=(PageAdd(slug="contact", from_slug="about"),),
            ),
        )
        run_publish(project, paths, message="add contact", expected_rev=0, now=_TS, job=_new_job())

        assert (paths.repo / "pages" / "contact.html").read_text(encoding="utf-8") == _ABOUT_HTML
        content = json.loads((paths.repo / "content" / "contact.json").read_text(encoding="utf-8"))
        assert content["meta"]["title"] == "Contact"
        assert content["intro"]["body"] == "Contact us"


class TestPushRejectionRetry:
    def test_retries_once_after_a_rejected_push_and_succeeds(
        self, project: ProjectConfig, paths: ProjectPaths, tmp_path: Path
    ) -> None:
        # Get Wixy's own checkout cloned and up to date first.
        save_overlay(paths.draft_overlay, _make_overlay({"index:hero.title": "First"}))
        run_publish(project, paths, message="first", expected_rev=0, now=_TS, job=_new_job())

        # Prepare the SECOND overlay, then force a real race: push a competing
        # commit to origin from a separate clone AFTER Wixy's checkout has
        # already fetched/merged, but BEFORE its own push — by driving
        # `_commit_push_and_tag` directly (bypassing `run_publish`'s own
        # preflight, which would otherwise just pick up the race during ITS
        # OWN fetch and never hit a genuine rejection at all).
        overlay = _make_overlay({"index:hero.title": "Second"}, rev=1)
        save_overlay(paths.draft_overlay, overlay)
        _materialize(project, paths, overlay)

        competitor = tmp_path / "competitor"
        _git(["clone", str(Path(project.repo)), str(competitor)], cwd=tmp_path)
        _git(["config", "user.email", "c@example.com"], cwd=competitor)
        _git(["config", "user.name", "Competitor"], cwd=competitor)
        (competitor / "content" / "about.json").write_text(
            json.dumps({"meta": {"title": "About"}, "intro": {"body": "Competing change"}}),
            encoding="utf-8",
        )
        _git(["add", "."], cwd=competitor)
        _git(["commit", "-m", "competing commit"], cwd=competitor)
        _git(["push", "origin", "main"], cwd=competitor)

        job = _new_job()
        sha = _commit_push_and_tag(project, paths, overlay, message="second", version=2, job=job)

        assert any("push rejected, retrying once" in line for line in job.log)
        assert sha == _git(["rev-parse", "HEAD"], cwd=paths.repo).stdout.strip()
        # The competitor's change survived the re-merge, and ours is on top of it.
        content = json.loads((paths.repo / "content" / "index.json").read_text(encoding="utf-8"))
        assert content["hero"]["title"] == "Second"
        about = json.loads((paths.repo / "content" / "about.json").read_text(encoding="utf-8"))
        assert about["intro"]["body"] == "Competing change"

    def test_a_second_rejection_aborts_and_resets_to_origin_leaving_overlay_untouched(
        self,
        project: ProjectConfig,
        paths: ProjectPaths,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        save_overlay(paths.draft_overlay, _make_overlay({"index:hero.title": "First"}))
        run_publish(project, paths, message="first", expected_rev=0, now=_TS, job=_new_job())

        overlay = _make_overlay({"index:hero.title": "Second"}, rev=1)
        save_overlay(paths.draft_overlay, overlay)
        _materialize(project, paths, overlay)

        import wixy_server.publisher as publisher_module

        # Force EVERY push attempt to fail, simulating a push that keeps losing
        # the race (or a genuinely broken remote) rather than trying to win a
        # real two-attempt race deterministically.
        original_run_git = publisher_module.run_git

        def _fail_pushes(
            args: list[str], *, cwd: Path | None = None
        ) -> subprocess.CompletedProcess[str]:
            if args and args[0] == "push":
                return subprocess.CompletedProcess(args, 1, "", "rejected (simulated)")
            return original_run_git(args, cwd=cwd)

        monkeypatch.setattr(publisher_module, "run_git", _fail_pushes)

        job = _new_job()
        with pytest.raises(PublishError) as exc_info:
            _commit_push_and_tag(project, paths, overlay, message="second", version=2, job=job)

        assert exc_info.value.stage == "committing"
        assert "aborted and reset to origin" in str(exc_info.value)
        overlay_after = load_overlay(paths.draft_overlay, default_base_sha="")
        assert overlay_after.rev == 1  # untouched


class TestPrune:
    def test_keeps_only_the_last_20_versions_worth_of_builds(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        for i in range(22):
            save_overlay(
                paths.draft_overlay, _make_overlay({"index:hero.title": f"Title {i}"}, rev=i)
            )
            run_publish(
                project, paths, message=f"publish {i}", expected_rev=i, now=_TS, job=_new_job()
            )

        entries = read_ledger(paths)
        assert len(entries) == 22
        kept_shas = {e.sha for e in entries[-20:]}
        on_disk = {p.name for p in paths.builds.iterdir() if p.is_dir()}
        assert on_disk == kept_shas
        assert len(on_disk) == 20


class TestLock:
    def test_the_lock_file_does_not_survive_a_successful_publish(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(paths.draft_overlay, _make_overlay({"index:hero.title": "New"}))
        run_publish(project, paths, message="test", expected_rev=0, now=_TS, job=_new_job())
        assert not paths.publish_lock.exists()

    def test_the_lock_file_does_not_survive_a_failed_publish(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        save_overlay(
            paths.draft_overlay,
            _make_overlay({"index:hero.bg": {"src": "images/nope.jpg", "alt": "x"}}),
        )
        with pytest.raises(PublishError):
            run_publish(project, paths, message="test", expected_rev=0, now=_TS, job=_new_job())
        assert not paths.publish_lock.exists()
