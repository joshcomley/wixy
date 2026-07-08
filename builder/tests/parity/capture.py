"""Per-page probe capture via headless Playwright (spec/03-site-migration.md §5 point 1).

Five probe kinds per page: normalized visible text, `(text, href)` link pairs, every
`<img>`'s resolved src + natural dimensions, a `getComputedStyle` sample across a fixed
selector list, and a full-page screenshot. `file://` is not enough (JS injection needs a
real origin) — callers must serve the site over `http://127.0.0.1` first.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Sequence
from typing import Any, Literal

from playwright.sync_api import ConsoleMessage, Error, Page, ViewportSize, sync_playwright

STYLE_PROPS: tuple[str, ...] = (
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
)

# A common, generically-applicable sample covering hero/heading/body/buttons/footer
# (03 §5's "~15 selectors/page"); a selector simply contributes nothing on a page where
# it doesn't match anything, so one list works across every page without per-page
# hand-curation drifting out of sync with the real markup.
COMMON_SELECTORS: tuple[str, ...] = (
    "h1",
    "h2",
    "h3",
    "p",
    "a.btn-primary",
    "a.btn-ghost",
    "a.btn-olive",
    ".eyebrow",
    ".tag",
    ".price",
    "header#hd",
    "footer.site-footer",
    "nav.nav-links",
    "body",
)

Viewport = Literal["desktop", "mobile"]
VIEWPORT_SIZES: dict[Viewport, ViewportSize] = {
    "desktop": ViewportSize(width=1280, height=900),
    "mobile": ViewportSize(width=390, height=844),
}


@dataclasses.dataclass
class PageProbe:
    text: str
    links: list[list[str]]
    images: list[list[object]]
    styles: dict[str, dict[str, str]]
    console_errors: list[str]

    def to_dict(self) -> dict[str, object]:
        return dataclasses.asdict(self)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> PageProbe:
        return PageProbe(
            text=str(data["text"]),
            links=[list(pair) for pair in data["links"]],
            images=[list(triple) for triple in data["images"]],
            styles={str(k): dict(v) for k, v in data["styles"].items()},
            console_errors=list(data["console_errors"]),
        )


def _normalize_text(raw: str) -> str:
    return re.sub(r"\s+", " ", raw).strip()


def _on_console(errors: list[str], msg: ConsoleMessage) -> None:
    if msg.type == "error":
        errors.append(msg.text)


def _on_page_error(errors: list[str], exc: Error) -> None:
    errors.append(str(exc))


def _strip_origin(resolved_url: str, base_url: str) -> str:
    """Drop `base_url` from a resolved URL so an ephemeral local-server port (a fresh
    random port every time something serves a directory, per `serve_directory`) never
    shows up as a false parity diff. A URL that resolves somewhere else entirely (an
    external host) is left as-is — that mismatch would be a real, meaningful finding.
    """
    return resolved_url[len(base_url) :] if resolved_url.startswith(base_url) else resolved_url


def capture_page(
    page: Page, url: str, base_url: str, *, selectors: Sequence[str] = COMMON_SELECTORS
) -> PageProbe:
    console_errors: list[str] = []
    page.on("console", lambda msg: _on_console(console_errors, msg))
    page.on("pageerror", lambda exc: _on_page_error(console_errors, exc))

    page.goto(url, wait_until="networkidle")
    page.wait_for_timeout(300)  # let webfont swap / reveal animations settle

    text = _normalize_text(page.inner_text("body"))

    links_raw = page.eval_on_selector_all(
        "a[href]",
        "els => els.map(e => [e.textContent.trim(), e.getAttribute('href')])",
    )
    links = sorted((list(pair) for pair in links_raw), key=lambda p: (p[1], p[0]))

    images_raw = page.eval_on_selector_all(
        "img",
        "els => els.map(e => [e.currentSrc || e.src, e.naturalWidth, e.naturalHeight])",
    )
    images = sorted(
        ([_strip_origin(str(triple[0]), base_url), *triple[1:]] for triple in images_raw),
        key=lambda t: str(t[0]),
    )

    styles: dict[str, dict[str, str]] = {}
    for selector in selectors:
        if page.locator(selector).count() == 0:
            continue
        styles[selector] = page.eval_on_selector(
            selector,
            "(el, props) => Object.fromEntries("
            "props.map(p => [p, getComputedStyle(el).getPropertyValue(p)]))",
            list(STYLE_PROPS),
        )

    return PageProbe(
        text=text, links=links, images=images, styles=styles, console_errors=console_errors
    )


def capture_screenshot(page: Page, url: str, *, viewport: Viewport) -> bytes:
    page.set_viewport_size(VIEWPORT_SIZES[viewport])
    page.goto(url, wait_until="networkidle")
    page.wait_for_timeout(300)
    screenshot: bytes = page.screenshot(full_page=True)
    return screenshot


@dataclasses.dataclass
class PageCapture:
    probe: PageProbe
    screenshot_desktop: bytes
    screenshot_mobile: bytes | None


def capture_site(
    base_url: str,
    slugs: Sequence[str],
    *,
    mobile_screenshot_slugs: Sequence[str] = (),
) -> dict[str, PageCapture]:
    """Capture every probe kind for each `slug`, launching one browser for the batch."""
    results: dict[str, PageCapture] = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            page = browser.new_page(viewport=VIEWPORT_SIZES["desktop"])
            for slug in slugs:
                url = f"{base_url}/{'' if slug == 'index' else slug + '.html'}"
                probe = capture_page(page, url, base_url)
                desktop_shot = capture_screenshot(page, url, viewport="desktop")
                mobile_shot = (
                    capture_screenshot(page, url, viewport="mobile")
                    if slug in mobile_screenshot_slugs
                    else None
                )
                results[slug] = PageCapture(
                    probe=probe, screenshot_desktop=desktop_shot, screenshot_mobile=mobile_shot
                )
            page.close()
        finally:
            browser.close()
    return results
