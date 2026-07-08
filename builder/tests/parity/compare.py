"""Parity comparison: fresh probes vs the committed baseline (spec/03-site-migration.md §5
point 2). Text/link/image/computed-style checks are exact and run everywhere; screenshot
pixel-diff is computed everywhere too but only enforced as a hard failure on the pinned
CI platform — elsewhere it's advisory (font rasterization differs across OSes).
"""

from __future__ import annotations

import dataclasses
import io

from PIL import Image, ImageChops

from builder.tests.parity.capture import PageProbe

PIXEL_DIFF_BUDGET = 0.01  # 1%, per spec/03 §5


@dataclasses.dataclass(frozen=True, slots=True)
class ParityIssue:
    page: str
    kind: str
    detail: str
    advisory: bool = False


def compare_text(page: str, baseline: PageProbe, current: PageProbe) -> list[ParityIssue]:
    if baseline.text == current.text:
        return []
    return [
        ParityIssue(
            page, "text", f"body text differs:\n  was: {baseline.text}\n  now: {current.text}"
        )
    ]


def compare_links(page: str, baseline: PageProbe, current: PageProbe) -> list[ParityIssue]:
    base_set = {tuple(pair) for pair in baseline.links}
    cur_set = {tuple(pair) for pair in current.links}
    if base_set == cur_set:
        return []
    missing = sorted(base_set - cur_set)
    extra = sorted(cur_set - base_set)
    return [ParityIssue(page, "links", f"link set differs: missing={missing} extra={extra}")]


def compare_images(page: str, baseline: PageProbe, current: PageProbe) -> list[ParityIssue]:
    base_set = {tuple(triple) for triple in baseline.images}
    cur_set = {tuple(triple) for triple in current.images}
    if base_set == cur_set:
        return []
    missing = sorted(base_set - cur_set, key=str)
    extra = sorted(cur_set - base_set, key=str)
    return [ParityIssue(page, "images", f"image set differs: missing={missing} extra={extra}")]


def compare_styles(page: str, baseline: PageProbe, current: PageProbe) -> list[ParityIssue]:
    issues: list[ParityIssue] = []
    for selector, base_props in baseline.styles.items():
        cur_props = current.styles.get(selector)
        if cur_props is None:
            issues.append(
                ParityIssue(page, "styles", f"selector '{selector}' no longer matches anything")
            )
            continue
        if base_props != cur_props:
            detail = (
                f"selector '{selector}' computed style differs: was {base_props}, now {cur_props}"
            )
            issues.append(ParityIssue(page, "styles", detail))
    return issues


def compare_console_errors(page: str, current: PageProbe) -> list[ParityIssue]:
    if not current.console_errors:
        return []
    return [ParityIssue(page, "console", f"console errors present: {current.console_errors}")]


def pixel_diff_ratio(baseline_png: bytes, current_png: bytes) -> float:
    """Fraction of differing pixels between two same-format screenshots (0.0-1.0)."""
    base_img = Image.open(io.BytesIO(baseline_png)).convert("RGB")
    cur_img = Image.open(io.BytesIO(current_png)).convert("RGB")
    if base_img.size != cur_img.size:
        return 1.0
    diff = ImageChops.difference(base_img, cur_img)
    histogram = diff.convert("L").histogram()
    total_pixels = base_img.size[0] * base_img.size[1]
    differing = total_pixels - histogram[0]
    return differing / total_pixels if total_pixels else 0.0


def compare_screenshot(
    page: str,
    variant: str,
    baseline_png: bytes,
    current_png: bytes,
    *,
    strict: bool,
    budget: float = PIXEL_DIFF_BUDGET,
) -> list[ParityIssue]:
    ratio = pixel_diff_ratio(baseline_png, current_png)
    if ratio <= budget:
        return []
    detail = f"{variant} screenshot differs by {ratio:.2%} (budget {budget:.0%})"
    return [ParityIssue(page, "screenshot", detail, advisory=not strict)]


def compare_page(
    page: str,
    baseline: PageProbe,
    current: PageProbe,
) -> list[ParityIssue]:
    """All non-screenshot checks for one page."""
    return [
        *compare_text(page, baseline, current),
        *compare_links(page, baseline, current),
        *compare_images(page, baseline, current),
        *compare_styles(page, baseline, current),
        *compare_console_errors(page, current),
    ]
