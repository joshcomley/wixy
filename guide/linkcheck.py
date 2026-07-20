"""Verifies every external URL referenced by the BUILT guide is genuinely
live (spec/independence/07 §3: "Every external URL in the guide verified
live at build time (a `guide-linkcheck` CI job)... the linkcheck keeps
honesty"). Run via `python -m guide.linkcheck` after `python -m guide` has
built the guide — this script reads the built HTML, not the source
fragments, so it's checking exactly what a real reader would click.

Internal links (same-guide chapter-to-chapter, `guide.css`/`guide.js`) are
NOT this script's job — `wixy_server/tests/test_guide_route.py`'s
`test_every_manifest_chapter_is_served` already proves every manifest slug
resolves to a real served page, a stronger, faster, network-free check than
an HTTP round-trip would be for content this repo already controls.
"""

from __future__ import annotations

import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

from guide.build import DEFAULT_OUT

_HREF_PATTERN = re.compile(r'href="([^"]+)"')
_TIMEOUT_S = 15.0


def external_links(html: str) -> set[str]:
    urls: set[str] = set()
    for match in _HREF_PATTERN.finditer(html):
        url = match.group(1)
        parsed = urlparse(url)
        if parsed.scheme in ("http", "https"):
            urls.add(url)
    return urls


def collect_all_links(guide_dir: Path) -> dict[str, list[Path]]:
    """Maps each external URL to every chapter file that references it —
    one failing URL should name every page that would break, not just the
    first one found."""
    by_url: dict[str, list[Path]] = {}
    for html_path in sorted(guide_dir.glob("*.html")):
        html = html_path.read_text(encoding="utf-8")
        for url in external_links(html):
            by_url.setdefault(url, []).append(html_path)
    return by_url


_ATTEMPTS = 2


def check_url(client: httpx.Client, url: str) -> str | None:
    """Returns `None` if live, else a short human-readable failure reason.
    Retries once — a genuinely dead/renamed link fails every attempt, but a
    third-party site's own transient blip shouldn't block an unrelated PR
    (spec's own "keeps honesty" goal is about catching real rot, not being
    hostage to someone else's five-second outage)."""
    reason: str | None = None
    for attempt in range(_ATTEMPTS):
        if attempt > 0:
            time.sleep(2.0)
        try:
            response = client.get(url, timeout=_TIMEOUT_S, follow_redirects=True)
        except httpx.HTTPError as exc:
            reason = f"request failed: {exc}"
            continue
        if response.status_code >= 400:
            reason = f"HTTP {response.status_code}"
            continue
        return None
    return reason


def run(guide_dir: Path = DEFAULT_OUT) -> int:
    """Returns a process exit code: 0 if every external link is live, 1
    otherwise (with failures printed to stdout, one line each, naming every
    chapter that references the broken URL)."""
    by_url = collect_all_links(guide_dir)
    if not by_url:
        print("No external links found to check.")
        return 0

    failures: list[tuple[str, str, list[Path]]] = []
    headers = {"User-Agent": "wixy-guide-linkcheck/1 (+https://github.com/joshcomley/wixy)"}
    with httpx.Client(headers=headers) as client:
        for url in sorted(by_url):
            reason = check_url(client, url)
            if reason is not None:
                failures.append((url, reason, by_url[url]))

    print(f"Checked {len(by_url)} external link(s), {len(failures)} failing.")
    for url, reason, pages in failures:
        page_names = ", ".join(p.name for p in pages)
        print(f"  [FAIL] {url} -- {reason} (referenced by: {page_names})")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
