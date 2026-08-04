"""Deterministic draft self-heal (decisions/00095) — wixy_server/draft_repair.py.

Uses a real (non-bare) git checkout written directly at `paths.repo` —
draft_repair only READS the checkout and writes the overlay locally, no push
involved, unlike the full publish pipeline tests in test_publisher.py.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from builder.config import MediaConfig, ProjectConfig
from builder.jsontypes import JsonObject, JsonValue
from wixy_server.draft_repair import run_repair
from wixy_server.overlay import Overlay, OverlayOp, RevConflictError, save_overlay
from wixy_server.storage import ProjectPaths, ensure_project_dirs, project_paths

_TS = "2026-07-30T21:00:00+00:00"

_GALLERY_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<div data-wx-list="gallery.sliders">
<figure data-wx-list-item data-wx-attr="data-cat:.cat">
<img data-wx-img=".before" src="" alt="">
<img data-wx-img=".after" src="" alt="">
<span data-wx=".title">t</span><span data-wx=".sub">s</span>
</figure>
</div>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""
_PARTIAL_HTML = "<body></body>\n"

_BASE_SLIDERS: list[JsonObject] = [
    {
        "cat": "lips",
        "title": "Lip Enhancement",
        "sub": "Dermal filler",
        "before": {"src": "images/ba-lips-1-before.jpg", "alt": "before"},
        "after": {"src": "images/ba-lips-1-after.jpg", "alt": "after"},
    },
    {
        "cat": "lips",
        "title": "Lip Definition",
        "sub": "Dermal filler",
        "before": {"src": "images/ba-lips-2-before.jpg", "alt": "before"},
        "after": {"src": "images/ba-lips-2-after.jpg", "alt": "after"},
    },
    {
        "cat": "cheeks",
        "title": "Cheek Definition",
        "sub": "Dermal filler",
        "before": {"src": "images/ba-cheeks-before.jpg", "alt": "before"},
        "after": {"src": "images/ba-cheeks-after.jpg", "alt": "after"},
    },
]


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


@pytest.fixture
def project() -> ProjectConfig:
    return ProjectConfig(
        slug="test",
        name="Test",
        repo="unused",
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

    root = p.repo
    (root / "pages").mkdir(parents=True)
    (root / "partials").mkdir(parents=True)
    (root / "content").mkdir(parents=True)
    (root / "images").mkdir(parents=True)
    (root / "pages" / "gallery.html").write_text(_GALLERY_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (root / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (root / "content" / "gallery.json").write_text(
        json.dumps(
            {
                "meta": {
                    "title": "Before & After",
                    "navLabel": "Before & After",
                    "inNav": True,
                    "navOrder": 30,
                    "ogImage": {"src": "images/exterior.jpg", "alt": "exterior"},
                },
                "gallery": {"sliders": _BASE_SLIDERS},
            }
        ),
        encoding="utf-8",
    )
    (root / "content" / "_global.json").write_text("{}", encoding="utf-8")
    image_names = [
        "exterior.jpg",
        "ba-lips-1-before.jpg",
        "ba-lips-1-after.jpg",
        "ba-lips-2-before.jpg",
        "ba-lips-2-after.jpg",
        "ba-cheeks-before.jpg",
        "ba-cheeks-after.jpg",
    ]
    for name in image_names:
        (root / "images" / name).write_bytes(b"fake-jpeg-bytes")
    _git(["init", "--initial-branch=main"], root)
    _git(["config", "user.email", "test@example.com"], root)
    _git(["config", "user.name", "Test"], root)
    _git(["add", "."], root)
    _git(["commit", "-m", "initial"], root)
    return p


def _save_overlay(paths: ProjectPaths, ops: dict[str, JsonValue], *, rev: int = 0) -> None:
    save_overlay(
        paths.draft_overlay,
        Overlay(
            rev=rev,
            base_sha="",
            ops={k: OverlayOp(value=v, ts=_TS, by="editor") for k, v in ops.items()},
            pages_added=(),
            pages_deleted=(),
        ),
    )


class TestRealIncidentShape:
    """The exact live-production shape (workstream 0 of the diagnosis this
    decision documents): item[0] fully gutted (blanked strings, empty image
    srcs), items[1]/[2] intact except missing `cat`, and a leading-slash
    ogImage pointing at a file that genuinely exists."""

    def test_heals_to_a_clean_draft(self, project: ProjectConfig, paths: ProjectPaths) -> None:
        gutted: JsonObject = {
            "title": "&nbsp;",
            "sub": "&nbsp;",
            "before": {"src": "", "alt": ""},
            "after": {"src": "", "alt": ""},
        }
        missing_cat_1: JsonObject = {k: v for k, v in _BASE_SLIDERS[1].items() if k != "cat"}
        missing_cat_2: JsonObject = {k: v for k, v in _BASE_SLIDERS[2].items() if k != "cat"}
        _save_overlay(
            paths,
            {
                "gallery:gallery.sliders": [gutted, missing_cat_1, missing_cat_2],
                "gallery:meta.ogImage": {
                    "src": "/images/ba-lips-1-after.jpg",
                    "alt": "Ba Lips 1 After",
                },
            },
        )

        result = run_repair(project, paths, expected_rev=0, by="editor", now=_TS)

        assert result.validate.ok is True
        assert result.rev == 1
        # sliders reverted entirely (repaired array == base) — gone from the
        # overlay; ogImage stays (normalize alone fixed it — the file exists).
        overlay_after = json.loads(paths.draft_overlay.read_text(encoding="utf-8"))
        assert "gallery:gallery.sliders" not in overlay_after["ops"]
        assert overlay_after["ops"]["gallery:meta.ogImage"]["value"] == {
            "src": "images/ba-lips-1-after.jpg",
            "alt": "Ba Lips 1 After",
        }
        assert len(result.actions) == 2
        assert any("Before & After" in a and "last published version" in a for a in result.actions)
        assert any("broken image link" in a for a in result.actions)

    def test_a_repair_with_no_broken_ops_reports_no_actions_and_stays_ok(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _save_overlay(paths, {"gallery:meta.title": "A perfectly fine edit"})

        result = run_repair(project, paths, expected_rev=0, by="editor", now=_TS)

        assert result.actions == ()
        assert result.validate.ok is True
        overlay_after = json.loads(paths.draft_overlay.read_text(encoding="utf-8"))
        assert overlay_after["ops"]["gallery:meta.title"]["value"] == "A perfectly fine edit"


class TestPartialFix:
    def test_a_single_missing_required_field_is_filled_from_base_not_replaced(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        missing_cat_only: JsonObject = {k: v for k, v in _BASE_SLIDERS[0].items() if k != "cat"}
        _save_overlay(
            paths,
            {"gallery:gallery.sliders": [missing_cat_only, _BASE_SLIDERS[1], _BASE_SLIDERS[2]]},
        )

        result = run_repair(project, paths, expected_rev=0, by="editor", now=_TS)

        # The whole array is now identical to base (only the cat was ever
        # missing) — reverts to base, same as the full-incident case.
        overlay_after = json.loads(paths.draft_overlay.read_text(encoding="utf-8"))
        assert "gallery:gallery.sliders" not in overlay_after["ops"]
        assert result.validate.ok is True

    def test_a_legitimate_edit_beyond_repair_is_kept_as_a_real_op(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        edited: list[JsonValue] = [
            {**_BASE_SLIDERS[0], "title": "A Real Retitle"},
            _BASE_SLIDERS[1],
            _BASE_SLIDERS[2],
        ]
        _save_overlay(paths, {"gallery:gallery.sliders": edited})

        result = run_repair(project, paths, expected_rev=0, by="editor", now=_TS)

        assert result.actions == ()  # every item was already fully valid
        overlay_after = json.loads(paths.draft_overlay.read_text(encoding="utf-8"))
        assert overlay_after["ops"]["gallery:gallery.sliders"]["value"][0]["title"] == (
            "A Real Retitle"
        )


class TestItemWithNoBaseCounterpart:
    def test_an_extra_unrepairable_item_is_dropped_leaving_the_real_edit_intact(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        # A genuine edit to item[0] (so the op survives repair as a real,
        # non-reverted op) PLUS an extra item with no base counterpart at
        # all and missing required fields — the drop must not also discard
        # the legitimate retitle sitting right next to it.
        retitled: JsonObject = {**_BASE_SLIDERS[0], "title": "A Real Retitle"}
        # missing cat/before/after entirely:
        unrepairable_extra: JsonObject = {"title": "New", "sub": ""}
        _save_overlay(
            paths,
            {
                "gallery:gallery.sliders": [
                    retitled,
                    _BASE_SLIDERS[1],
                    _BASE_SLIDERS[2],
                    unrepairable_extra,
                ]
            },
        )

        result = run_repair(project, paths, expected_rev=0, by="editor", now=_TS)

        overlay_after = json.loads(paths.draft_overlay.read_text(encoding="utf-8"))
        kept = overlay_after["ops"]["gallery:gallery.sliders"]["value"]
        assert len(kept) == 3  # the extra, unrepairable item is gone
        assert kept[0]["title"] == "A Real Retitle"  # the real edit survives
        assert result.validate.ok is True
        assert any("Fixed some content" in a for a in result.actions)


class TestStaleDraftMediaAfterPublish:
    """decisions/00115 — the 2026-08-03 production block. A publish copies a
    staged upload into the repo as `images/<name>` and DELETES the staged copy;
    a client still holding the pre-publish array writes those now-dead
    `/admin/draft-media/<name>` srcs back into the draft on its next edit. The
    items are structurally perfect, so the pre-00115 schema-only repair changed
    nothing and the owner was stuck with no action left that could help."""

    def _stale_published_pair(self) -> JsonObject:
        return {
            **_BASE_SLIDERS[0],
            "before": {"src": "/admin/draft-media/ba-lips-1-before.jpg", "alt": "before"},
            "after": {"src": "/admin/draft-media/ba-lips-1-after.jpg", "alt": "after"},
        }

    def _staged_new_pair(self, paths: ProjectPaths) -> JsonObject:
        for name in ("abc12345-new-before.jpg", "abc12345-new-after.jpg"):
            (paths.draft_media / name).write_bytes(b"fake-jpeg-bytes")
        return {
            "cat": "lips",
            "title": "A Genuinely New Pair",
            "sub": "Dermal filler",
            "before": {"src": "/admin/draft-media/abc12345-new-before.jpg", "alt": "before"},
            "after": {"src": "/admin/draft-media/abc12345-new-after.jpg", "alt": "after"},
        }

    def test_a_published_upload_is_re_pointed_and_the_new_pair_survives(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _save_overlay(
            paths,
            {
                "gallery:gallery.sliders": [
                    self._stale_published_pair(),
                    _BASE_SLIDERS[1],
                    _BASE_SLIDERS[2],
                    self._staged_new_pair(paths),
                ]
            },
        )

        result = run_repair(project, paths, expected_rev=0, by="editor", now=_TS)

        assert result.validate.ok is True
        overlay_after = json.loads(paths.draft_overlay.read_text(encoding="utf-8"))
        kept = overlay_after["ops"]["gallery:gallery.sliders"]["value"]
        # The already-published pair now points at its published copy...
        assert kept[0]["before"]["src"] == "images/ba-lips-1-before.jpg"
        assert kept[0]["after"]["src"] == "images/ba-lips-1-after.jpg"
        # ...and the owner's genuinely-new, still-staged pair is untouched.
        assert kept[3]["title"] == "A Genuinely New Pair"
        assert kept[3]["before"]["src"] == "/admin/draft-media/abc12345-new-before.jpg"
        assert any("image link" in a for a in result.actions)

    def test_an_image_that_resolves_nowhere_falls_back_to_the_published_item(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        """No staged copy AND no published copy — nothing to re-point at, so the
        item reverts to its last published version rather than blocking forever
        (a well-formed src is schema-valid, so only the image-resolution half of
        the item check can catch this)."""
        vanished: JsonObject = {
            **_BASE_SLIDERS[0],
            "before": {"src": "/admin/draft-media/deadbeef-gone.jpg", "alt": "before"},
        }
        _save_overlay(
            paths,
            {
                "gallery:gallery.sliders": [
                    vanished,
                    _BASE_SLIDERS[1],
                    _BASE_SLIDERS[2],
                    self._staged_new_pair(paths),
                ]
            },
        )

        result = run_repair(project, paths, expected_rev=0, by="editor", now=_TS)

        assert result.validate.ok is True
        overlay_after = json.loads(paths.draft_overlay.read_text(encoding="utf-8"))
        kept = overlay_after["ops"]["gallery:gallery.sliders"]["value"]
        assert kept[0] == _BASE_SLIDERS[0]
        assert kept[3]["title"] == "A Genuinely New Pair"


class TestUpstreamCausedErrorSurvivesRepair:
    def test_a_template_binding_error_not_overlay_fixable_reports_ok_false(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        """A problem baked into the CHECKOUT itself (e.g. a page's binding
        that doesn't resolve at all) is not something any overlay repair can
        fix — it must survive into validate.errors so the UI routes to Report."""
        (paths.repo / "pages" / "gallery.html").write_text(
            _GALLERY_HTML.replace("gallery.sliders", "gallery.doesNotExist"), encoding="utf-8"
        )
        _git(["add", "."], paths.repo)
        _git(["commit", "-m", "break it upstream"], paths.repo)
        _save_overlay(paths, {"gallery:meta.title": "Unrelated fine edit"})

        result = run_repair(project, paths, expected_rev=0, by="editor", now=_TS)

        assert result.validate.ok is False


class TestRevConflict:
    def test_a_stale_expected_rev_raises_rev_conflict_error(
        self, project: ProjectConfig, paths: ProjectPaths
    ) -> None:
        _save_overlay(paths, {"gallery:meta.title": "x"}, rev=3)

        with pytest.raises(RevConflictError):
            run_repair(project, paths, expected_rev=0, by="editor", now=_TS)

        # Untouched — a rejected repair must not mutate the overlay.
        overlay_after = json.loads(paths.draft_overlay.read_text(encoding="utf-8"))
        assert overlay_after["rev"] == 3
