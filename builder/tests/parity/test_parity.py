"""Parity harness tests (spec/03-site-migration.md §5) — capture/compare/rebaseline
against the fixture mini-site, served locally (hermetic, no real network).

Module-scoped fixtures build its own `SiteSource` rather than reusing the shared
function-scoped `conftest.py` fixtures — pytest forbids a module-scoped fixture from
depending on a function-scoped one, and re-launching a browser per test is needless
overhead for read-only probing against an already-built, unchanging static tree.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from builder.build import build_site
from builder.config import load_project_config
from builder.render import load_site_source
from builder.tests.parity.capture import capture_site
from builder.tests.parity.compare import (
    compare_console_errors,
    compare_images,
    compare_links,
    compare_page,
    compare_screenshot,
    compare_styles,
    compare_text,
    pixel_diff_ratio,
)
from builder.tests.parity.runner import load_baseline, rebaseline, run_parity_check, serve_directory
from builder.theme import load_theme

_FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"
_MINI_SITE_DIR = _FIXTURES_DIR / "mini-site"
_PROJECT_JSON = _FIXTURES_DIR / "project.json"


def _png_bytes(size: tuple[int, int], color: str) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(scope="module")
def built_site_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    project = load_project_config(_PROJECT_JSON)
    theme = load_theme(_MINI_SITE_DIR / "theme" / "theme.json")
    source = load_site_source(_MINI_SITE_DIR, project, theme)
    out = tmp_path_factory.mktemp("parity-build")
    build_site(_MINI_SITE_DIR, source, out)
    with serve_directory(out) as base_url:
        yield base_url


class TestCaptureOriginStripping:
    def test_image_src_has_no_ephemeral_port(self, built_site_url: str) -> None:
        captures = capture_site(built_site_url, ["index"])
        for src, _width, _height in captures["index"].probe.images:
            assert isinstance(src, str)
            assert built_site_url not in src
            assert src.startswith("/images/")

    def test_links_are_already_relative(self, built_site_url: str) -> None:
        captures = capture_site(built_site_url, ["index"])
        hrefs = [href for _text, href in captures["index"].probe.links]
        assert any(href == "/about.html" for href in hrefs)
        assert not any(built_site_url in href for href in hrefs)


class TestCaptureContent:
    def test_captures_text_and_styles(self, built_site_url: str) -> None:
        captures = capture_site(built_site_url, ["index"])
        probe = captures["index"].probe
        assert "Fixture Cottage" in probe.text
        assert "h1" in probe.styles
        assert "color" in probe.styles["h1"]
        assert probe.console_errors == []

    def test_selector_absent_from_page_is_skipped_not_erroring(self, built_site_url: str) -> None:
        # about.html has no .price element -- must not raise, just omit it.
        captures = capture_site(built_site_url, ["about"])
        assert ".price" not in captures["about"].probe.styles


class TestCompareFunctions:
    def test_identical_probes_compare_clean(self, built_site_url: str) -> None:
        captures = capture_site(built_site_url, ["index"])
        probe_a = captures["index"].probe
        probe_b = captures["index"].probe
        assert compare_text("index", probe_a, probe_b) == []
        assert compare_links("index", probe_a, probe_b) == []
        assert compare_images("index", probe_a, probe_b) == []
        assert compare_styles("index", probe_a, probe_b) == []
        assert compare_console_errors("index", probe_b) == []
        assert compare_page("index", probe_a, probe_b) == []

    def test_text_mismatch_detected(self, built_site_url: str) -> None:
        captures = capture_site(built_site_url, ["index"])
        baseline = captures["index"].probe
        mutated = dataclasses.replace(baseline, text=baseline.text + " EXTRA")
        issues = compare_text("index", baseline, mutated)
        assert len(issues) == 1
        assert issues[0].kind == "text"

    def test_link_set_mismatch_detected(self, built_site_url: str) -> None:
        captures = capture_site(built_site_url, ["index"])
        baseline = captures["index"].probe
        mutated = dataclasses.replace(baseline, links=[*baseline.links, ["New", "/new.html"]])
        issues = compare_links("index", baseline, mutated)
        assert len(issues) == 1
        assert "new.html" in issues[0].detail


class TestPixelDiff:
    def test_identical_images_zero_diff(self, built_site_url: str) -> None:
        captures = capture_site(built_site_url, ["index"])
        shot = captures["index"].screenshot_desktop
        assert pixel_diff_ratio(shot, shot) == 0.0

    def test_different_sized_images_full_diff(self) -> None:
        small = _png_bytes((10, 10), "white")
        big = _png_bytes((20, 20), "white")
        assert pixel_diff_ratio(small, big) == 1.0

    def test_screenshot_within_budget_passes(self, built_site_url: str) -> None:
        captures = capture_site(built_site_url, ["index"])
        shot = captures["index"].screenshot_desktop
        assert compare_screenshot("index", "desktop", shot, shot, strict=True) == []

    def test_screenshot_over_budget_advisory_when_not_strict(self) -> None:
        base = _png_bytes((50, 50), "white")
        current = _png_bytes((50, 50), "black")
        issues = compare_screenshot("index", "desktop", base, current, strict=False)
        assert len(issues) == 1
        assert issues[0].advisory is True

    def test_screenshot_over_budget_hard_failure_when_strict(self) -> None:
        base = _png_bytes((50, 50), "white")
        current = _png_bytes((50, 50), "black")
        issues = compare_screenshot("index", "desktop", base, current, strict=True)
        assert len(issues) == 1
        assert issues[0].advisory is False


class TestRebaselineRoundTrip:
    def test_rebaseline_then_check_is_clean(self, built_site_url: str, tmp_path: Path) -> None:
        baseline_root = tmp_path / "baseline"
        rebaseline(built_site_url, ["index", "about"], baseline_root)
        loaded = load_baseline(baseline_root, ["index", "about"])
        assert set(loaded) == {"index", "about"}

        issues = run_parity_check(
            built_site_url, ["index", "about"], baseline_root, strict_screenshots=True
        )
        assert issues == []

    def test_mobile_screenshot_only_for_requested_slugs(
        self, built_site_url: str, tmp_path: Path
    ) -> None:
        baseline_root = tmp_path / "baseline"
        rebaseline(
            built_site_url, ["index", "about"], baseline_root, mobile_screenshot_slugs=("index",)
        )
        assert (baseline_root / "index" / "mobile.png").exists()
        assert not (baseline_root / "about" / "mobile.png").exists()
