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

import os
import re
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
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


#: The waits between attempts (so three attempts per URL): a dead or renamed link fails every
#: attempt, while a third-party site's own few-second blip should not block an unrelated PR (the
#: spec's "keeps honesty" goal is about catching real rot, not being hostage to someone else's
#: outage).
_BACKOFF_S = (2.0, 4.0)

#: Answers that mean "this site will not serve this automated request", not "this page is gone":
#: a bot check turning away a datacenter address (403, or Cloudflare's `cf-mitigated: challenge`),
#: or rate limiting (429). Measured 2026-10-28: opensource.org answered GitHub's CI runner 403 on
#: both attempts in 1 of the last 60 runs while serving it, and this box, normally. A 401 is NOT
#: here: a page that wants a login is broken for the guide's reader.
_REFUSED_STATUSES = frozenset({403, 429})

Outcome = Literal["live", "refused", "dead"]


@dataclass(frozen=True)
class LinkResult:
    outcome: Outcome
    #: Short and human-readable: "HTTP 404", "HTTP 403 (server: cloudflare, cf-mitigated:
    #: challenge)", "request failed: ...". Empty when live.
    detail: str


def _describe(response: httpx.Response) -> str:
    """The status plus the headers that say WHO refused (a bot check or the site itself), so a
    refusal in a CI log can be told apart from a real error without re-running anything."""
    clues = [
        f"{name}: {response.headers[name]}"
        for name in ("server", "cf-mitigated")
        if name in response.headers
    ]
    return f"HTTP {response.status_code}" + (f" ({', '.join(clues)})" if clues else "")


def classify(response: httpx.Response) -> LinkResult:
    if response.status_code < 400:
        return LinkResult("live", "")
    refused = (
        response.headers.get("cf-mitigated") == "challenge"
        or response.status_code in _REFUSED_STATUSES
    )
    return LinkResult("refused" if refused else "dead", _describe(response))


def check_url(
    client: httpx.Client, url: str, *, sleep: Callable[[float], None] = time.sleep
) -> LinkResult:
    """Fetches `url` up to `len(_BACKOFF_S) + 1` times; the first live answer wins, otherwise the
    last attempt's verdict stands."""
    result = LinkResult("dead", "not attempted")
    for attempt in range(len(_BACKOFF_S) + 1):
        if attempt > 0:
            sleep(_BACKOFF_S[attempt - 1])
        try:
            response = client.get(url, timeout=_TIMEOUT_S, follow_redirects=True)
        except httpx.HTTPError as exc:
            result = LinkResult("dead", f"request failed: {exc}")
            continue
        result = classify(response)
        if result.outcome == "live":
            return result
    return result


def run(
    guide_dir: Path = DEFAULT_OUT,
    *,
    client: httpx.Client | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Returns a process exit code: 1 if any external link is dead, else 0. Every link that is not
    live gets one line on stdout naming every chapter that references it. A REFUSED link does not
    fail the build (it says nothing about the page, only about this network), but it is never
    silent either: on GitHub Actions it is also a `::warning::` annotation on the run."""
    by_url = collect_all_links(guide_dir)
    if not by_url:
        print("No external links found to check.")
        return 0

    headers = {"User-Agent": "wixy-guide-linkcheck/1 (+https://github.com/joshcomley/wixy)"}
    own_client = client is None
    http = client if client is not None else httpx.Client(headers=headers)
    results: dict[str, LinkResult] = {}
    try:
        for url in sorted(by_url):
            results[url] = check_url(http, url, sleep=sleep)
    finally:
        if own_client:
            http.close()

    def count(outcome: Outcome) -> int:
        return sum(1 for r in results.values() if r.outcome == outcome)

    print(
        f"Checked {len(by_url)} external link(s): {count('live')} live, "
        f"{count('refused')} refused by the site, {count('dead')} failing."
    )
    on_actions = os.environ.get("GITHUB_ACTIONS") == "true"
    for url, result in results.items():
        if result.outcome == "live":
            continue
        pages = ", ".join(p.name for p in by_url[url])
        label = "FAIL" if result.outcome == "dead" else "REFUSED"
        print(f"  [{label}] {url} -- {result.detail} (referenced by: {pages})")
        if result.outcome == "refused" and on_actions:
            print(
                f"::warning title=Guide link not verifiable::{url} -- the site refused this "
                f"automated request ({result.detail}), so it could not be checked from here; "
                f"referenced by {pages}"
            )

    return 1 if count("dead") else 0


if __name__ == "__main__":
    sys.exit(run())
