"""Orchestrates capture + baseline I/O + comparison; backs the `python -m builder parity`
CLI subcommand (spec/03-site-migration.md §5). Operates on an already-servable static
directory — agnostic to whether that came from `builder build` or is the raw
pre-migration site — so the one-time baseline capture and every later CI check share
the same code path.
"""

from __future__ import annotations

import functools
import http.server
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from builder.tests.parity.capture import PageCapture, PageProbe, capture_site
from builder.tests.parity.compare import ParityIssue, compare_page, compare_screenshot

DEFAULT_MOBILE_SLUGS: tuple[str, ...] = ("index", "treatments")


@contextmanager
def serve_directory(directory: Path) -> Iterator[str]:
    """Serve `directory` on an OS-assigned loopback port; yield its base URL.

    `file://` isn't enough for parity capture — JS injection (site.js) needs a real
    origin (03 §5 point 1).
    """
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        thread.join(timeout=5)


def default_baseline_dir() -> Path:
    return Path(__file__).parent / "baseline"


def _page_dir(baseline_root: Path, slug: str) -> Path:
    return baseline_root / slug


def write_baseline(baseline_root: Path, captures: dict[str, PageCapture]) -> None:
    for slug, capture in captures.items():
        page_dir = _page_dir(baseline_root, slug)
        page_dir.mkdir(parents=True, exist_ok=True)
        (page_dir / "probe.json").write_text(
            json.dumps(capture.probe.to_dict(), indent=2, sort_keys=True, ensure_ascii=False)
            + "\n",
            encoding="utf-8",
        )
        (page_dir / "desktop.png").write_bytes(capture.screenshot_desktop)
        mobile_path = page_dir / "mobile.png"
        if capture.screenshot_mobile is not None:
            mobile_path.write_bytes(capture.screenshot_mobile)
        elif mobile_path.exists():
            mobile_path.unlink()


def load_baseline(baseline_root: Path, slugs: list[str]) -> dict[str, PageCapture]:
    results: dict[str, PageCapture] = {}
    for slug in slugs:
        page_dir = _page_dir(baseline_root, slug)
        probe = PageProbe.from_dict(
            json.loads((page_dir / "probe.json").read_text(encoding="utf-8"))
        )
        desktop = (page_dir / "desktop.png").read_bytes()
        mobile_path = page_dir / "mobile.png"
        mobile = mobile_path.read_bytes() if mobile_path.exists() else None
        results[slug] = PageCapture(
            probe=probe, screenshot_desktop=desktop, screenshot_mobile=mobile
        )
    return results


def rebaseline(
    base_url: str,
    slugs: list[str],
    baseline_root: Path,
    *,
    mobile_screenshot_slugs: tuple[str, ...] = DEFAULT_MOBILE_SLUGS,
) -> None:
    captures = capture_site(base_url, slugs, mobile_screenshot_slugs=mobile_screenshot_slugs)
    write_baseline(baseline_root, captures)


def run_parity_check(
    base_url: str,
    slugs: list[str],
    baseline_root: Path,
    *,
    mobile_screenshot_slugs: tuple[str, ...] = DEFAULT_MOBILE_SLUGS,
    strict_screenshots: bool,
) -> list[ParityIssue]:
    current = capture_site(base_url, slugs, mobile_screenshot_slugs=mobile_screenshot_slugs)
    baseline = load_baseline(baseline_root, slugs)
    issues: list[ParityIssue] = []
    for slug in slugs:
        issues.extend(compare_page(slug, baseline[slug].probe, current[slug].probe))
        issues.extend(
            compare_screenshot(
                slug,
                "desktop",
                baseline[slug].screenshot_desktop,
                current[slug].screenshot_desktop,
                strict=strict_screenshots,
            )
        )
        base_mobile = baseline[slug].screenshot_mobile
        cur_mobile = current[slug].screenshot_mobile
        if base_mobile is not None and cur_mobile is not None:
            issues.extend(
                compare_screenshot(
                    slug, "mobile", base_mobile, cur_mobile, strict=strict_screenshots
                )
            )
    return issues
