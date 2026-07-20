"""The guide's single source of truth for chapter order, grouping, and nav
titles (spec/independence/07 §2's own Structure list) — `build.py` reads this
to generate the nav sidebar and prev/next footer links, so no chapter file
ever hand-maintains a link to another one. Adding a chapter means adding one
entry here; nothing else needs to know the order.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Chapter:
    slug: str
    nav_title: str
    page_title: str
    group: str
    time_estimate: str | None = None


CHAPTERS: list[Chapter] = [
    Chapter(
        slug="start-here",
        nav_title="Start here",
        page_title="Start here",
        group="",
    ),
    Chapter(
        slug="track-j",
        nav_title="Track J — Josh",
        page_title="Track J — what Josh does once",
        group="",
        time_estimate="≈1 hour",
    ),
    Chapter(
        slug="track-p-1-password-manager",
        nav_title="1. Password manager",
        page_title="Track P, chapter 1 — Set up a password manager",
        group="Track P — Purdi",
        time_estimate="10 minutes",
    ),
    Chapter(
        slug="track-p-2-github",
        nav_title="2. GitHub",
        page_title="Track P, chapter 2 — Your GitHub account and organisation",
        group="Track P — Purdi",
        time_estimate="20–30 minutes",
    ),
    Chapter(
        slug="track-p-3-digitalocean",
        nav_title="3. DigitalOcean",
        page_title="Track P, chapter 3 — Your DigitalOcean account and droplet",
        group="Track P — Purdi",
        time_estimate="15 minutes",
    ),
    Chapter(
        slug="track-p-4-cloudflare",
        nav_title="4. Cloudflare",
        page_title="Track P, chapter 4 — Your Cloudflare account and tunnel",
        group="Track P — Purdi",
        time_estimate="20–30 minutes",
    ),
    Chapter(
        slug="track-p-5-anthropic",
        nav_title="5. Anthropic (AI)",
        page_title="Track P, chapter 5 — Your Anthropic account and API key",
        group="Track P — Purdi",
        time_estimate="10 minutes",
    ),
    Chapter(
        slug="track-p-6-droplet-setup",
        nav_title="6. Droplet setup",
        page_title="Track P, chapter 6 — Setting up your droplet",
        group="Track P — Purdi",
        time_estimate="15–20 minutes",
    ),
    Chapter(
        slug="track-p-7-drill",
        nav_title="7. The drill",
        page_title="Track P, chapter 7 — The drill",
        group="Track P — Purdi",
    ),
    Chapter(
        slug="track-p-8-go-live",
        nav_title="8. Go live",
        page_title="Track P, chapter 8 — Go live",
        group="Track P — Purdi",
        time_estimate="30 minutes, with Josh on the phone",
    ),
    Chapter(
        slug="appendix-a-if-josh-disappears",
        nav_title="A. If Josh disappears",
        page_title="Appendix A — If Josh disappears tomorrow",
        group="Appendices",
    ),
    Chapter(
        slug="appendix-b-costs",
        nav_title="B. Costs",
        page_title="Appendix B — Costs",
        group="Appendices",
    ),
    Chapter(
        slug="appendix-c-revoking-access",
        nav_title="C. Revoking access",
        page_title="Appendix C — Revoking Josh's access",
        group="Appendices",
    ),
]

_BY_SLUG = {c.slug: c for c in CHAPTERS}


def chapter_by_slug(slug: str) -> Chapter:
    return _BY_SLUG[slug]


def next_chapter(slug: str) -> Chapter | None:
    index = next(i for i, c in enumerate(CHAPTERS) if c.slug == slug)
    return CHAPTERS[index + 1] if index + 1 < len(CHAPTERS) else None


def previous_chapter(slug: str) -> Chapter | None:
    index = next(i for i, c in enumerate(CHAPTERS) if c.slug == slug)
    return CHAPTERS[index - 1] if index > 0 else None
