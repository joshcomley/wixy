"""Template loading, partial injection, and `<head>` management (spec/02-content-model.md §7).

`title`/meta description/OG tags/fonts link are builder-managed from `meta` + theme;
`theme.css`'s link is static template markup (its href never varies) so migration adds it
by hand — this module only manages the pieces that genuinely vary per build.
"""

from __future__ import annotations

import copy
from pathlib import Path

from bs4 import BeautifulSoup, Comment, Tag

from builder.errors import BuildError
from builder.jsontypes import JsonObject

PARTIAL_NAMES = ("header", "footer", "booking-modal")
_FONTS_HREF_PREFIX = "https://fonts.googleapis.com/"


def load_template(path: Path) -> BeautifulSoup:
    html = path.read_text(encoding="utf-8")
    return BeautifulSoup(html, "html5lib")


def load_partials(partials_dir: Path) -> dict[str, BeautifulSoup]:
    partials: dict[str, BeautifulSoup] = {}
    for name in PARTIAL_NAMES:
        path = partials_dir / f"{name}.html"
        if path.exists():
            partials[name] = load_template(path)
    return partials


def require_partial_markers(soup: BeautifulSoup, *, file_label: str) -> None:
    """Every page must carry the header + footer + booking-modal markers (02 §7)."""
    found = {text.split()[1] for text in _partial_marker_texts(soup) if len(text.split()) == 2}
    missing = set(PARTIAL_NAMES) - found
    if missing:
        raise BuildError(
            f"missing partial marker(s): {', '.join(sorted(missing))}", location=file_label
        )


def _partial_marker_texts(soup: BeautifulSoup) -> list[str]:
    comments = soup.find_all(string=lambda s: isinstance(s, Comment))
    return [c.strip() for c in comments if c.strip().startswith("wx:partial")]


def inject_partials(
    soup: BeautifulSoup, partials: dict[str, BeautifulSoup], *, file_label: str
) -> None:
    """Replace each `<!-- wx:partial NAME -->` marker with a fresh copy of that partial."""
    comments = [c for c in soup.find_all(string=lambda s: isinstance(s, Comment))]
    for comment in comments:
        text = comment.strip()
        if not text.startswith("wx:partial"):
            continue
        parts = text.split()
        if len(parts) != 2:
            raise BuildError(f"malformed partial marker comment: '{text}'", location=file_label)
        name = parts[1]
        partial_soup = partials.get(name)
        if partial_soup is None:
            raise BuildError(f"unknown partial '{name}' referenced by marker", location=file_label)
        body = partial_soup.body
        if body is None:
            comment.extract()
            continue
        nodes = [copy.deepcopy(node) for node in body.contents]
        for node in reversed(nodes):
            comment.insert_after(node)
        comment.extract()


def _find_or_create_meta_name(soup: BeautifulSoup, head: Tag, name: str) -> Tag:
    tag = head.find("meta", attrs={"name": name})
    if isinstance(tag, Tag):
        return tag
    new_tag = soup.new_tag("meta")
    new_tag["name"] = name
    head.append(new_tag)
    return new_tag


def _find_or_create_meta_property(soup: BeautifulSoup, head: Tag, prop: str) -> Tag:
    tag = head.find("meta", attrs={"property": prop})
    if isinstance(tag, Tag):
        return tag
    new_tag = soup.new_tag("meta")
    new_tag["property"] = prop
    head.append(new_tag)
    return new_tag


def _find_fonts_link(head: Tag) -> Tag | None:
    for link in head.find_all("link"):
        if not isinstance(link, Tag):
            continue
        href = link.get("href")
        if isinstance(href, str) and href.startswith(_FONTS_HREF_PREFIX):
            return link
    return None


def apply_head(
    soup: BeautifulSoup,
    *,
    meta: JsonObject,
    fonts_url: str,
    page_url_path: str,
    domain: str,
    indexable: bool,
    file_label: str,
) -> None:
    """Set title/description/OG tags/fonts link/robots meta from `meta` + theme + registry."""
    head = soup.head
    if not isinstance(head, Tag):
        raise BuildError("template has no <head>", location=file_label)

    title_text = meta.get("title")
    if isinstance(title_text, str):
        title_tag = head.find("title")
        if not isinstance(title_tag, Tag):
            title_tag = soup.new_tag("title")
            head.append(title_tag)
        title_tag.string = title_text
        _find_or_create_meta_property(soup, head, "og:title")["content"] = title_text

    description = meta.get("description")
    if isinstance(description, str):
        _find_or_create_meta_name(soup, head, "description")["content"] = description
        _find_or_create_meta_property(soup, head, "og:description")["content"] = description

    _find_or_create_meta_property(soup, head, "og:type")["content"] = "website"
    _find_or_create_meta_property(soup, head, "og:url")["content"] = (
        f"https://{domain}{page_url_path}"
    )

    og_image = meta.get("ogImage")
    if isinstance(og_image, dict) and isinstance(og_image.get("src"), str):
        _find_or_create_meta_property(soup, head, "og:image")["content"] = (
            f"https://{domain}/{og_image['src']}"
        )

    fonts_link = _find_fonts_link(head)
    if fonts_link is None:
        fonts_link = soup.new_tag("link")
        fonts_link["rel"] = "stylesheet"
        head.append(fonts_link)
    fonts_link["href"] = fonts_url

    robots_tag = head.find("meta", attrs={"name": "robots"})
    if indexable:
        if isinstance(robots_tag, Tag):
            robots_tag.extract()
    else:
        if not isinstance(robots_tag, Tag):
            robots_tag = soup.new_tag("meta")
            robots_tag["name"] = "robots"
            head.append(robots_tag)
        robots_tag["content"] = "noindex"
