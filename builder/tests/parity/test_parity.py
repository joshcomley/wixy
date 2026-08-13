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


class TestCaptureConsoleErrorScoping:
    """`capture_site` reuses one Playwright page across every slug in its loop —
    `console`/`pageerror` listeners registered per-slug must not outlive that slug's
    own capture, or a later slug's async error gets attributed to every earlier slug
    whose listener is still attached (a real incident: a slow-loading Google Maps
    embed on one page made four earlier, unrelated pages fail parity too).
    """

    def test_delayed_error_does_not_leak_into_earlier_slugs(self, tmp_path: Path) -> None:
        (tmp_path / "a.html").write_text("<html><body>A</body></html>", encoding="utf-8")
        (tmp_path / "b.html").write_text(
            "<html><body>B<script>"
            "setTimeout(() => { throw new Error('delayed boom'); }, 30);"
            "</script></body></html>",
            encoding="utf-8",
        )
        with serve_directory(tmp_path) as base_url:
            captures = capture_site(base_url, ["a", "b"])

        assert captures["a"].probe.console_errors == []
        assert any("delayed boom" in e for e in captures["b"].probe.console_errors)


class TestCaptureForcesLazyImagesToLoad:
    """decisions/00141: capture never scrolls, so a correctly `loading="lazy"` image
    positioned below the fold is never given a reason to fetch — `capture_page` must
    force it to load anyway (mirroring `_force_reveal`'s precedent for scroll-gated
    content) or its probe reports `(0, 0)` and its screenshot shows a blank box,
    neither of which is a real markup bug."""

    def _site_with_lazy_image_below_the_fold(self, tmp_path: Path) -> None:
        images_dir = tmp_path / "images"
        images_dir.mkdir()
        (images_dir / "below.png").write_bytes(_png_bytes((64, 48), "#3366CC"))
        (tmp_path / "index.html").write_text(
            "<!doctype html><html><body>"
            '<div style="height:20000px">spacer, well past one viewport</div>'
            '<img src="images/below.png" loading="lazy" alt="below the fold">'
            "</body></html>",
            encoding="utf-8",
        )

    def test_probe_reports_real_dimensions_not_zero(self, tmp_path: Path) -> None:
        self._site_with_lazy_image_below_the_fold(tmp_path)
        with serve_directory(tmp_path) as base_url:
            captures = capture_site(base_url, ["index"])
        images = captures["index"].probe.images
        assert len(images) == 1
        _src, width, height = images[0]
        assert (width, height) == (64, 48)

    def test_screenshot_is_not_blank_at_the_image_location(self, tmp_path: Path) -> None:
        self._site_with_lazy_image_below_the_fold(tmp_path)
        with serve_directory(tmp_path) as base_url:
            captures = capture_site(base_url, ["index"])
        shot = Image.open(BytesIO(captures["index"].screenshot_desktop)).convert("RGB")
        # The image sits just past the 3000px spacer -- sample a strip of rows there
        # rather than one exact pixel, forgiving of body-margin/layout rounding.
        found_image_color = any(
            shot.getpixel((10, y)) == (0x33, 0x66, 0xCC)
            for y in range(19995, min(20080, shot.height))
        )
        assert found_image_color, "expected the lazy image's own color, not a blank box"


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
