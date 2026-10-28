"""Pictures in the Adventure Time holiday pack (workspace 00056, spec/server-chat/08 4.3a, Inv 56).

The research AI NAMES things (a venue's own site, an English Wikipedia article title); it supplies
no image link. After the text pack is stored, THIS SERVER finds the pictures from open sources,
fetches them itself through `SafeFetcher` (a viewer's device never contacts a third-party image
host from a private chat) and stores them as the round's private media. The sources, per slot, in
order (measured against real runs, spec 4.3a):

1. the Wikipedia REST summary's lead image, taken as its Wikimedia Commons file and fetched as the
   Commons API's 1600 px THUMBNAIL (never an `upload.wikimedia.org` original: those are huge and
   rate-limited), credited from the file's `extmetadata`;
2. the venue's own page `og:image` / `twitter:image` (HTML at most 1 MB; refusals and `403`/`429`
   are skipped quietly), credited to the site;
3. for the hero and the sights only: a Commons file-namespace search for JPEG photographs at least
   900 px on the short side.

Everything fetched is untrusted: the content type must be an image AND the bytes must sniff as
JPEG/PNG/WebP, Pillow opens it under the existing decompression-bomb cap, an icon or banner (short
side under 480 px, aspect beyond 3:1) is refused, and what is kept is a fresh JPEG with no
metadata at 1600 px or less. The finder returns those JPEGs in memory; `AdventurePictureJob`
stages them like the would-you-rather pictures (ordinary private photo attachments on the round's
anchor message, attached in ONE transaction), so renditions, signed URLs, quota and erasure are the
ordinary attachment machinery's.
"""

from __future__ import annotations

import dataclasses
import functools
import hashlib
import io
import json
import logging
import os
import re
import shutil
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Final, Protocol
from urllib.parse import quote, unquote, urlencode, urljoin, urlsplit

import anyio
import anyio.to_thread
from PIL import Image

from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat import processing
from wixy_server.livechat.adventure_bank import AdventureBank
from wixy_server.livechat.adventure_game import pack_data
from wixy_server.livechat.adventure_pack import clean_url, clean_wikipedia_title
from wixy_server.livechat.models import AdventureRoundRow
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.safe_fetch import (
    HTML_MAX_BYTES,
    IMAGE_MAX_BYTES,
    JSON_MAX_BYTES,
    FetchFailure,
    SafeFetcher,
    SafeFetchError,
)
from wixy_server.livechat.store import LiveChatStore
from wixy_server.storage import ProjectPaths

_LOGGER = logging.getLogger(__name__)

MAX_PICTURES: Final = 16
"""At most this many pictures per pack (hero + items)."""
HERO_TARGET: Final = 5
"""The hero is the destination article's lead image plus Commons-search photos up to this many."""
HERO_MAX: Final = 6
ITEM_SLOT_ATTEMPTS: Final = 20
"""How many item slots are tried (the pack can name up to 36 items; only ~11 pictures fit)."""
MAX_FETCHED_PIXELS: Final = min(processing.PHOTO_PIXEL_CAP, 36_000_000)
"""A fetched picture may declare at most this many pixels (6000 x 6000), checked BEFORE it is
decoded. Tighter than the chat's own 80 MP photo cap on purpose: an RGB decode costs 3 bytes a pixel
and the clean-up makes a few copies, and this runs on pictures nobody here chose."""
HEAD_SCAN_CHARS: Final = 200_000
DECODE_PARALLELISM: Final = 2
"""How many fetched images are decoded at once (each can be a hundred MB while it is)."""
MIN_SHORT_SIDE: Final = 480
SEARCH_MIN_SHORT_SIDE: Final = 900
MAX_ASPECT: Final = 3.0
OUTPUT_LONG_EDGE: Final = 1600
OUTPUT_QUALITY: Final = 90
MAX_CREDIT: Final = 120
MAX_CAPTION: Final = 120
JOB_BUDGET_S: Final = 240.0
"""The whole picture hunt for one pack gives up after this long and keeps what it has."""
SLOT_CONCURRENCY: Final = 6
SEARCH_RESULTS: Final = 24
SITE_IMAGE_TRIES: Final = 2
"""How many of a page's image tags are tried before giving up on that venue."""
HOST_STRIKES: Final = 3
"""After this many rate-limit refusals from one host, the job stops asking it."""
COMMONS_THUMB_WIDTH: Final = 1600
_STANDARD_THUMB_STEPS: Final = (1280, 960, 500)
LEAD_MIMES: Final = frozenset({"image/jpeg", "image/png", "image/webp"})
ITEM_SECTION_ORDER: Final = ("sights", "food", "stay", "culture", "do")
"""Which sections get pictures, and the order they are served in (round-robin by item index)."""
_AVOID_TITLE_WORDS_RE = re.compile(
    r"\b(map|flag|logo|coat of arms|locator|diagram|chart|poster|banner|stamp|icon|plan)\b",
    re.IGNORECASE,
)
_WHITESPACE_RE = re.compile(r"\s+")
_HASH_DIR_ONE_RE = re.compile(r"^[0-9a-f]$")
_HASH_DIR_TWO_RE = re.compile(r"^[0-9a-f]{2}$")

PICTURES_VERSION: Final = 1


# -- what the finder is given and returns --------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PictureSlot:
    """One item that may get a picture. `key` is `<section>:<item index>`."""

    key: str
    section: str
    name: str
    wikipedia: str | None
    url: str | None
    search: bool
    """A Commons search may be tried when nothing else finds a picture (the sights)."""


@dataclass(frozen=True, slots=True)
class PicturePlan:
    destination: str
    unit: str
    destination_wikipedia: str | None
    slots: tuple[PictureSlot, ...]


@dataclass(frozen=True, slots=True)
class FoundPicture:
    """A finished picture: clean JPEG bytes and its credit. `slot` is `hero:<n>` or an item key.
    `keys` identify the underlying file (Commons title, content digest) for de-duplication."""

    slot: str
    jpeg: bytes
    credit: str
    page: str
    caption: str | None
    keys: frozenset[str]


class AdventurePictureFinder(Protocol):
    """What the picture job needs from the picture sources; the seam is
    `create_app(adventure_picture_finder=...)` (production is `WebPictureFinder`, tests inject
    fakes)."""

    async def find(
        self, plan: PicturePlan, *, still_wanted: Callable[[], Awaitable[bool]]
    ) -> list[FoundPicture]:
        """The pictures found for `plan`, hero first, de-duplicated and capped at
        `MAX_PICTURES`. Never raises for an ordinary failure (a slot simply gets none);
        `still_wanted` turns false once the round no longer wants pictures."""
        ...


def plan_pictures(
    pack: Mapping[str, object], *, destination_name: str, unit_name: str
) -> PicturePlan:
    """The slots a pack offers pictures for, from its already-sanitised JSON. Items are served
    round-robin across `ITEM_SECTION_ORDER` by position so every section gets a look-in; an item
    qualifies with an article title, a site, or (for the sights) just a name to search for."""
    sections: dict[str, list[object]] = {}
    raw_sections = pack.get("sections")
    if isinstance(raw_sections, list):
        for section in raw_sections:
            if isinstance(section, dict) and isinstance(section.get("key"), str):
                items = section.get("items")
                if isinstance(items, list):
                    sections.setdefault(str(section["key"]), list(items))
    slots: list[PictureSlot] = []
    longest = max((len(items) for items in sections.values()), default=0)
    for index in range(longest):
        for key in ITEM_SECTION_ORDER:
            items = sections.get(key, [])
            if index >= len(items):
                continue
            item = items[index]
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not isinstance(name, str) or not name:
                continue
            wikipedia = clean_wikipedia_title(item.get("wikipedia"))
            url = clean_url(item.get("url"))
            search = key == "sights"
            if wikipedia is None and url is None and not search:
                continue
            slots.append(
                PictureSlot(
                    key=f"{key}:{index}",
                    section=key,
                    name=name,
                    wikipedia=wikipedia,
                    url=url,
                    search=search,
                )
            )
            if len(slots) == ITEM_SLOT_ATTEMPTS:
                break
        if len(slots) == ITEM_SLOT_ATTEMPTS:
            break
    return PicturePlan(
        destination=destination_name,
        unit=unit_name,
        destination_wikipedia=clean_wikipedia_title(pack.get("wikipedia")),
        slots=tuple(slots),
    )


# -- validating and re-encoding a fetched image --------------------------------------------------


class PictureRejected(Exception):
    """A fetched image or API answer was not usable (`reason` is short and machine-readable)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class PreparedImage:
    jpeg: bytes
    width: int
    height: int


def prepare_picture(data: bytes, *, min_short_side: int = MIN_SHORT_SIDE) -> PreparedImage:
    """Validate fetched image bytes and re-encode them (blocking; run in a thread). The bytes must
    sniff as JPEG/PNG/WebP (the content type was checked before the body was read), open in Pillow
    as that same format under the decompression-bomb cap, be a single still frame, have a short
    side of at least `min_short_side` px and an aspect ratio of at most 3:1 (icons and banners are
    refused), and are then rebuilt as a metadata-free sRGB JPEG of at most 1600 px."""
    try:
        container = processing.sniff(data[:64])
    except processing.MediaProcessingError as exc:
        raise PictureRejected("not_an_image") from exc
    expected = {"jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}.get(container)
    if expected is None:
        raise PictureRejected(f"format_{container}")
    try:
        with Image.open(io.BytesIO(data), formats=("JPEG", "PNG", "WEBP")) as image:
            if image.format != expected:
                raise PictureRejected("format_mismatch")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_FETCHED_PIXELS:
                raise PictureRejected("too_many_pixels")
            if int(getattr(image, "n_frames", 1)) > 1:
                raise PictureRejected("animated")
            short, long = min(width, height), max(width, height)
            if short < min_short_side:
                raise PictureRejected("too_small")
            if long / short > MAX_ASPECT:
                raise PictureRejected("banner")
            jpeg = processing.reencode_still_as_jpeg(
                image, long_edge=OUTPUT_LONG_EDGE, quality=OUTPUT_QUALITY
            )
    except PictureRejected:
        raise
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise PictureRejected("corrupt") from exc
    scale = min(1.0, OUTPUT_LONG_EDGE / long)
    return PreparedImage(jpeg=jpeg, width=round(width * scale), height=round(height * scale))


# -- text helpers --------------------------------------------------------------------------------


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def plain_text(value: object, limit: int) -> str:
    """`value` (an HTML fragment such as Commons' `Artist`) as one clipped line of plain text."""
    if not isinstance(value, str):
        return ""
    extractor = _TextExtractor()
    try:
        extractor.feed(value[:4000])
        extractor.close()
        text = "".join(extractor.parts)
    except Exception:  # a malformed fragment must never fail a slot
        text = re.sub(r"<[^>]*>", " ", value[:4000])
    text = _WHITESPACE_RE.sub(" ", unescape(text)).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


class _MetaParser(HTMLParser):
    """The `<meta>` tags of a page's `<head>`, first value per name/property wins."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self._done = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._done or tag != "meta":
            return
        fields = {name.lower(): value for name, value in attrs if value is not None}
        key = (fields.get("property") or fields.get("name") or "").strip().lower()
        content = (fields.get("content") or "").strip()
        if key and content:
            self.meta.setdefault(key, content)

    def handle_endtag(self, tag: str) -> None:
        if tag == "head":
            self._done = True


def page_meta(body: bytes, charset: str | None) -> dict[str, str]:
    """The `<meta>` tags of an HTML page (at most 1 MB, already capped by the fetch). Only the head
    is parsed: the text up to the first `</head>`, else the first 200 KB."""
    try:
        text = body.decode(charset or "utf-8", errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")
    head_end = text.lower().find("</head")
    text = text[:head_end] if head_end >= 0 else text[:HEAD_SCAN_CHARS]
    parser = _MetaParser()
    try:
        parser.feed(text)
        parser.close()
    except Exception:
        _LOGGER.debug("adventure pictures: unparseable page", exc_info=True)
    return parser.meta


# -- Wikimedia -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class WikimediaEndpoints:
    """Where the open sources live. Production uses the defaults; tests point a finder at a local
    fake through this (the SSRF policy stays in `SafeFetcher`, untouched)."""

    summary_base: str = "https://en.wikipedia.org/api/rest_v1/page/summary/"
    commons_api: str = "https://commons.wikimedia.org/w/api.php"
    commons_page_base: str = "https://commons.wikimedia.org/wiki/"
    thumb_hosts: frozenset[str] = frozenset({"thumb.wikimedia.org", "upload.wikimedia.org"})
    """The hosts a Commons thumbnail URL may be on."""


@dataclass(frozen=True, slots=True)
class CommonsFile:
    title: str
    """`File:Name With Spaces.jpg`."""
    mime: str
    width: int
    height: int
    size_bytes: int
    thumb_url: str
    artist: str
    licence: str
    index: int

    @property
    def key(self) -> str:
        return "commons:" + self.title.lower()


def commons_file_name(source: object) -> str | None:
    """The Commons FILE NAME inside a Wikipedia image URL, or `None`. The summary's image is
    `.../wikipedia/commons/thumb/<a>/<ab>/<File>/<N>px-<File>?utm_...` (on `thumb.wikimedia.org`) or
    `.../wikipedia/commons/<a>/<ab>/<File>` — the name is the segment after the two hash
    directories, NEVER the last segment of a thumb URL. Anything not on Commons (a local enwiki
    upload) is `None`."""
    if not isinstance(source, str):
        return None
    try:
        segments = [unquote(part) for part in urlsplit(source).path.split("/")]
    except ValueError:
        return None
    if len(segments) < 6 or segments[1] != "wikipedia" or segments[2] != "commons":
        return None
    start = 4 if segments[3] == "thumb" else 3
    if len(segments) < start + 3:
        return None
    first, second, name = segments[start], segments[start + 1], segments[start + 2]
    if not (_HASH_DIR_ONE_RE.match(first) and _HASH_DIR_TWO_RE.match(second)):
        return None
    if not second.startswith(first) or not name or re.search(r"[\x00-\x1f\x7f/]", name):
        return None
    return name


def _is_thumbnail_path(url: str) -> bool:
    return "/thumb/" in urlsplit(url).path


def _smaller_standard_step(width: int) -> int | None:
    for step in _STANDARD_THUMB_STEPS:
        if step < width:
            return step
    return None


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def parse_commons_pages(data: object, thumb_hosts: frozenset[str]) -> list[CommonsFile]:
    """The files in a Commons API `query.pages` answer (`prop=imageinfo`), in search order. A page
    without imageinfo (missing file) or whose thumbnail is not on an expected host is skipped."""
    if not isinstance(data, dict):
        return []
    query = data.get("query")
    pages = query.get("pages") if isinstance(query, dict) else None
    if not isinstance(pages, list):
        return []
    files: list[CommonsFile] = []
    for page in pages:
        if not isinstance(page, dict):
            continue
        title = page.get("title")
        infos = page.get("imageinfo")
        if not isinstance(title, str) or not title.startswith("File:"):
            continue
        if not isinstance(infos, list) or not infos or not isinstance(infos[0], dict):
            continue
        info = infos[0]
        thumb_url = info.get("thumburl")
        mime = info.get("mime")
        if not isinstance(thumb_url, str) or not isinstance(mime, str):
            continue
        try:
            host = urlsplit(thumb_url).hostname
        except ValueError:
            continue
        if host not in thumb_hosts:
            continue
        meta = info.get("extmetadata")
        meta = meta if isinstance(meta, dict) else {}

        def _value(name: str, meta: dict[str, object] = meta) -> object:
            entry = meta.get(name)
            return entry.get("value") if isinstance(entry, dict) else None

        files.append(
            CommonsFile(
                title=title,
                mime=mime,
                width=_int(info.get("width")),
                height=_int(info.get("height")),
                size_bytes=_int(info.get("size")),
                thumb_url=thumb_url,
                artist=plain_text(_value("Artist"), MAX_CREDIT),
                licence=plain_text(_value("LicenseShortName"), 40),
                index=_int(page.get("index")),
            )
        )
    return sorted(files, key=lambda f: f.index)


def _credit_line(file: CommonsFile) -> str:
    artist = file.artist.removeprefix("User:").strip()  # Commons links a user as "User:Name"
    parts = [part for part in (artist, file.licence) if part]
    text = ", ".join(parts) if parts else "Wikimedia Commons"
    return text if len(text) <= MAX_CREDIT else text[: MAX_CREDIT - 1].rstrip() + "…"


def _caption(text: str | None) -> str | None:
    if not text:
        return None
    line = _WHITESPACE_RE.sub(" ", text).strip()
    if not line:
        return None
    return line if len(line) <= MAX_CAPTION else line[: MAX_CAPTION - 1].rstrip() + "…"


# -- the finder ----------------------------------------------------------------------------------


class WebPictureFinder:
    """Finds a pack's pictures from Wikipedia, Wikimedia Commons and the venues' own pages, fetching
    everything through the one `SafeFetcher`. See the module docstring for the source order."""

    def __init__(
        self,
        fetcher: SafeFetcher,
        *,
        endpoints: WikimediaEndpoints | None = None,
        budget_s: float = JOB_BUDGET_S,
    ) -> None:
        self._fetcher = fetcher
        self._endpoints = endpoints if endpoints is not None else WikimediaEndpoints()
        self._budget_s = budget_s
        self._decode_limiter: anyio.CapacityLimiter | None = None  # made inside the event loop

    async def aclose(self) -> None:
        await self._fetcher.aclose()

    async def find(
        self, plan: PicturePlan, *, still_wanted: Callable[[], Awaitable[bool]]
    ) -> list[FoundPicture]:
        run = _Hunt(self, plan, still_wanted)
        with anyio.move_on_after(self._budget_s):
            await run.go()
        return run.assemble()

    # -- single fetches (each raises SafeFetchError / PictureRejected) ---------------------------

    async def json_get(self, url: str) -> object:
        response = await self._fetcher.get(
            url, max_bytes=JSON_MAX_BYTES, accept=("application/json",)
        )
        try:
            return json.loads(response.body)
        except (
            ValueError,
            RecursionError,
        ) as exc:  # malformed, or nested deeper than Python allows
            raise PictureRejected("bad_json") from exc

    async def image_get(self, url: str, *, min_short_side: int) -> tuple[PreparedImage, str]:
        """Fetch and validate an image; returns it with the SHA-256 of the fetched bytes."""
        response = await self._fetcher.get(url, max_bytes=IMAGE_MAX_BYTES, accept=("image/",))
        if self._decode_limiter is None:
            self._decode_limiter = anyio.CapacityLimiter(DECODE_PARALLELISM)
        prepared = await anyio.to_thread.run_sync(
            lambda: prepare_picture(response.body, min_short_side=min_short_side),
            limiter=self._decode_limiter,
        )
        return prepared, hashlib.sha256(response.body).hexdigest()

    async def html_get(self, url: str) -> tuple[str, dict[str, str]]:
        response = await self._fetcher.get(
            url, max_bytes=HTML_MAX_BYTES, accept=("text/html", "application/xhtml+xml")
        )
        return response.url, page_meta(response.body, response.charset)

    # -- the sources -----------------------------------------------------------------------------

    def _api_url(self, params: Mapping[str, str]) -> str:
        return self._endpoints.commons_api + "?" + urlencode(params, quote_via=quote)

    def commons_page(self, title: str) -> str:
        return self._endpoints.commons_page_base + quote(
            title.replace(" ", "_"), safe=":/(),!'*~-._"
        )

    async def imageinfo(self, title: str, width: int) -> CommonsFile | None:
        data = await self.json_get(
            self._api_url(
                {
                    "action": "query",
                    "format": "json",
                    "formatversion": "2",
                    "titles": title,
                    "prop": "imageinfo",
                    "iiprop": "url|size|mime|extmetadata",
                    "iiurlwidth": str(width),
                    "iiextmetadatafilter": "Artist|LicenseShortName",
                }
            )
        )
        files = parse_commons_pages(data, self._endpoints.thumb_hosts)
        return files[0] if files else None

    async def commons_search(self, query: str, *, min_short_side: int) -> list[CommonsFile]:
        """JPEG photographs for `query`, best match first but landscape before portrait, every one
        with a real thumbnail URL (never an original), a short side of at least `min_short_side`
        and no map / flag / logo style title."""
        data = await self.json_get(
            self._api_url(
                {
                    "action": "query",
                    "format": "json",
                    "formatversion": "2",
                    "generator": "search",
                    "gsrsearch": f"{query} filemime:image/jpeg",
                    "gsrnamespace": "6",
                    "gsrlimit": str(SEARCH_RESULTS),
                    "prop": "imageinfo",
                    "iiprop": "url|size|mime|extmetadata",
                    "iiurlwidth": str(COMMONS_THUMB_WIDTH),
                    "iiextmetadatafilter": "Artist|LicenseShortName",
                }
            )
        )
        good = [
            f
            for f in parse_commons_pages(data, self._endpoints.thumb_hosts)
            if f.mime == "image/jpeg"
            and min(f.width, f.height) >= min_short_side
            and max(f.width, f.height) / max(1, min(f.width, f.height)) <= MAX_ASPECT
            and _is_thumbnail_path(f.thumb_url)
            and not _AVOID_TITLE_WORDS_RE.search(f.title)
        ]
        return sorted(good, key=lambda f: f.width < f.height)  # stable: rank kept within a class

    async def commons_picture(
        self, file: CommonsFile, *, caption: str | None, min_short_side: int
    ) -> FoundPicture:
        """Download a Commons file's thumbnail and build the finished picture."""
        prepared, digest = await self.image_get(file.thumb_url, min_short_side=min_short_side)
        page = clean_url(self.commons_page(file.title))
        if page is None:
            raise PictureRejected("bad_page_url")
        return FoundPicture(
            slot="",
            jpeg=prepared.jpeg,
            credit=_credit_line(file),
            page=page,
            caption=_caption(caption),
            keys=frozenset({file.key, f"sha256:{digest}"}),
        )

    async def wikipedia_picture(self, title: str) -> FoundPicture | None:
        """Source 1: the article's lead image, as its Commons thumbnail."""
        summary = await self.json_get(
            self._endpoints.summary_base + quote(title.replace(" ", "_"), safe="")
        )
        if not isinstance(summary, dict) or summary.get("type") == "disambiguation":
            return None
        image = summary.get("originalimage")
        if not isinstance(image, dict):
            image = summary.get("thumbnail")
        name = commons_file_name(image.get("source") if isinstance(image, dict) else None)
        if name is None:
            return None
        commons_title = "File:" + name.replace("_", " ")
        file = await self.imageinfo(commons_title, COMMONS_THUMB_WIDTH)
        if file is not None and not _is_thumbnail_path(file.thumb_url):
            # Wikimedia serves a file narrower than its smallest step as itself; never fetch an
            # original — ask for the next standard thumbnail size down instead.
            smaller = _smaller_standard_step(file.width)
            file = await self.imageinfo(commons_title, smaller) if smaller is not None else None
        if file is None or file.mime not in LEAD_MIMES or not _is_thumbnail_path(file.thumb_url):
            return None
        return await self.commons_picture(
            file,
            caption=plain_text(summary.get("description"), MAX_CAPTION),
            min_short_side=MIN_SHORT_SIDE,
        )

    async def site_picture(self, url: str) -> FoundPicture | None:
        """Source 2: the venue's own page `og:image` / `twitter:image`."""
        page_url, meta = await self.html_get(url)
        page = clean_url(page_url)
        if page is None:
            raise PictureRejected("bad_page_url")
        candidates: list[str] = []
        for key in (
            "og:image:secure_url",
            "og:image",
            "og:image:url",
            "twitter:image",
            "twitter:image:src",
        ):
            raw = meta.get(key)
            image_url = clean_url(urljoin(page_url, raw)) if raw else None
            if image_url is not None and image_url not in candidates:
                candidates.append(image_url)
        last_error: SafeFetchError | PictureRejected | None = None
        for image_url in candidates[:SITE_IMAGE_TRIES]:
            try:
                prepared, digest = await self.image_get(image_url, min_short_side=MIN_SHORT_SIDE)
            except (SafeFetchError, PictureRejected) as exc:
                last_error = exc
                continue
            host = (urlsplit(page_url).hostname or "").removeprefix("www.")
            return FoundPicture(
                slot="",
                jpeg=prepared.jpeg,
                credit=plain_text(meta.get("og:site_name"), MAX_CREDIT) or host,
                page=page,
                caption=None,
                keys=frozenset({f"sha256:{digest}"}),
            )
        if last_error is not None:
            raise last_error
        return None


class _Hunt:
    """One run of the finder over one plan. Holds the results as they complete, so a budget that
    runs out still keeps everything found so far."""

    def __init__(
        self,
        finder: WebPictureFinder,
        plan: PicturePlan,
        still_wanted: Callable[[], Awaitable[bool]],
    ) -> None:
        self._finder = finder
        self._plan = plan
        self._still_wanted = still_wanted
        self._lead: FoundPicture | None = None
        """The destination article's lead image: hero number one."""
        self._more_hero: list[FoundPicture] = []
        self._slots: dict[str, FoundPicture] = {}
        self._strikes: dict[str, int] = {}

    async def go(self) -> None:
        limiter = anyio.CapacityLimiter(SLOT_CONCURRENCY)
        async with anyio.create_task_group() as tg:
            if self._plan.destination_wikipedia:
                tg.start_soon(self._lead_task, self._plan.destination_wikipedia, limiter)
            for slot in self._plan.slots:
                tg.start_soon(self._slot_task, slot, limiter)
        if not await self._still_wanted():
            return
        self._drop_duplicates()
        await self._fill_hero()
        await self._search_sights()

    def _drop_duplicates(self) -> None:
        """Settle which slot keeps a file two slots both found (the destination's lead image, then
        the items in plan order), so a slot that lost it is free to try its own fallbacks and the
        outcome does not depend on which request happened to finish first."""
        seen: set[str] = set(self._lead.keys) if self._lead is not None else set()
        for slot in self._plan.slots:
            picture = self._slots.get(slot.key)
            if picture is None:
                continue
            if picture.keys & seen:
                del self._slots[slot.key]
            else:
                seen |= picture.keys

    # -- guarded attempts ------------------------------------------------------------------------

    def _hero_pictures(self) -> list[FoundPicture]:
        return [*([self._lead] if self._lead is not None else []), *self._more_hero]

    def _used(self) -> set[str]:
        keys: set[str] = set()
        for picture in [*self._hero_pictures(), *self._slots.values()]:
            keys |= picture.keys
        return keys

    async def _attempt(
        self, what: str, host_hint: str, make: Callable[[], Awaitable[FoundPicture | None]]
    ) -> FoundPicture | None:
        """Run one source attempt: any expected failure is just "no picture here". A host that
        keeps answering 429/503 is left alone for the rest of the run."""
        if self._strikes.get(host_hint, 0) >= HOST_STRIKES:
            return None
        try:
            return await make()
        except SafeFetchError as exc:
            if exc.reason == FetchFailure.RATE_LIMITED:
                self._strikes[host_hint] = self._strikes.get(host_hint, 0) + 1
            _LOGGER.debug("adventure pictures: %s skipped (%s)", what, exc.reason.value)
        except PictureRejected as exc:
            _LOGGER.debug("adventure pictures: %s rejected (%s)", what, exc.reason)
        except Exception:
            _LOGGER.warning("adventure pictures: %s failed", what, exc_info=True)
        return None

    # -- phase 1: the destination's lead image and every item slot, concurrently -----------------

    async def _lead_task(self, title: str, limiter: anyio.CapacityLimiter) -> None:
        async with limiter:
            if not await self._still_wanted():
                return
            self._lead = await self._attempt(
                "the destination article",
                "wikipedia",
                lambda: self._finder.wikipedia_picture(title),
            )

    async def _slot_task(self, slot: PictureSlot, limiter: anyio.CapacityLimiter) -> None:
        async with limiter:
            if not await self._still_wanted():
                return
            picture: FoundPicture | None = None
            if slot.wikipedia is not None:
                title = slot.wikipedia
                picture = await self._attempt(
                    f"{slot.key} article",
                    "wikipedia",
                    lambda: self._finder.wikipedia_picture(title),
                )
            if picture is None and slot.url is not None:
                url = slot.url
                picture = await self._attempt(
                    f"{slot.key} site",
                    urlsplit(url).hostname or url,
                    lambda: self._finder.site_picture(url),
                )
            if picture is not None:
                self._slots[slot.key] = dataclasses.replace(picture, slot=slot.key)

    # -- phase 2: fill the hero from a Commons search --------------------------------------------

    async def _fill_hero(self) -> None:
        need = HERO_TARGET - len(self._hero_pictures())
        if need <= 0:
            return
        query = f"{self._plan.destination} {self._plan.unit}".strip()
        try:
            files = await self._finder.commons_search(query, min_short_side=SEARCH_MIN_SHORT_SIDE)
        except (SafeFetchError, PictureRejected) as exc:
            _LOGGER.debug("adventure pictures: hero search failed (%s)", exc)
            return
        attempts = 0
        for file in files:
            if need <= 0 or attempts >= HERO_TARGET * 2 or not await self._still_wanted():
                return
            if file.key in self._used():
                continue
            attempts += 1
            picture = await self._attempt(
                "a hero photo",
                "commons",
                functools.partial(
                    self._finder.commons_picture,
                    file,
                    caption=None,
                    min_short_side=MIN_SHORT_SIDE,
                ),
            )
            if picture is not None and not (picture.keys & self._used()):
                self._more_hero.append(picture)
                need -= 1

    # -- phase 3: a Commons search for sights that found nothing ---------------------------------

    async def _search_sights(self) -> None:
        for slot in self._plan.slots:
            if not slot.search or slot.key in self._slots or not await self._still_wanted():
                continue
            query = f"{slot.name} {self._plan.destination}".strip()
            try:
                files = await self._finder.commons_search(
                    query, min_short_side=SEARCH_MIN_SHORT_SIDE
                )
            except (SafeFetchError, PictureRejected) as exc:
                _LOGGER.debug("adventure pictures: search for %s failed (%s)", slot.key, exc)
                continue
            for file in [f for f in files if f.key not in self._used()][:3]:
                picture = await self._attempt(
                    f"{slot.key} search",
                    "commons",
                    functools.partial(
                        self._finder.commons_picture,
                        file,
                        caption=None,
                        min_short_side=MIN_SHORT_SIDE,
                    ),
                )
                if picture is not None and not (picture.keys & self._used()):
                    self._slots[slot.key] = dataclasses.replace(picture, slot=slot.key)
                    break

    # -- the result ------------------------------------------------------------------------------

    def assemble(self) -> list[FoundPicture]:
        """Hero first, then items in plan order; a file already used (by Commons title or content
        digest) is dropped; at most `MAX_PICTURES`."""
        seen: set[str] = set()
        out: list[FoundPicture] = []
        for picture in self._hero_pictures():
            if picture.keys & seen:
                continue
            seen |= picture.keys
            out.append(dataclasses.replace(picture, slot=f"hero:{len(out)}"))
            if len(out) == HERO_MAX:
                break
        for slot in self._plan.slots:
            picture_or_none = self._slots.get(slot.key)
            if picture_or_none is None or picture_or_none.keys & seen:
                continue
            seen |= picture_or_none.keys
            out.append(picture_or_none)
        return out[:MAX_PICTURES]


# -- the job: find, stage, attach ----------------------------------------------------------------


def pictures_wanted(row: AdventureRoundRow | None) -> bool:
    """Whether a round still wants its pictures: it exists, is a trip the pair is looking at
    (`chosen`, or saved as `banked`), its text pack is in and the picture job is still pending. A
    rejected or deleted round wants nothing (Inv 56)."""
    return (
        row is not None
        and row.state in ("chosen", "banked")
        and row.pack == "ready"
        and row.images == "pending"
    )


class AdventurePictureJob:
    """Finds a ready pack's pictures, stages them and attaches them to the round's anchor message
    in one transaction. Idempotent: the attach is a compare-and-set on `images = 'pending'`, so a
    restart, a blue/green overlap or a repeat finds nothing to do or loses the race harmlessly."""

    def __init__(
        self,
        *,
        store: LiveChatStore,
        paths: ProjectPaths,
        bank: AdventureBank,
        finder: AdventurePictureFinder,
        notifier: LiveChatNotifier,
        space_ok: Callable[[int], bool] | None = None,
    ) -> None:
        self._store = store
        self._paths = paths
        self._bank = bank
        self._finder = finder
        self._notifier = notifier
        self._space_ok = space_ok

    async def resume(self, background: ContainedTaskGroup) -> int:
        """Startup recovery: redo the hunt for every round whose pictures were still pending when
        the previous process stopped (nothing was attached — the attach is all-or-nothing)."""
        pending = await anyio.to_thread.run_sync(self._store.adventure_pending_pictures)
        for anchor_seq in pending:
            background.spawn("livechat-adventure-pictures", self.run, anchor_seq)
        return len(pending)

    async def run(self, anchor_seq: int) -> None:
        """Find and attach the pictures for `anchor_seq`. Never raises for an ordinary failure (the
        round just ends with `images = failed` and no pictures); only cancellation (shutdown)
        propagates, leaving the round `pending` for the next start to redo."""
        try:
            attached = await self._run(anchor_seq)
        except Exception:
            _LOGGER.exception("adventure picture job for round %s failed", anchor_seq)
            attached = False
        if attached:
            self._notifier.publish()
            return
        try:
            changed = await anyio.to_thread.run_sync(
                lambda: self._store.fail_adventure_pictures(anchor_seq=anchor_seq, now=time.time())
            )
        except Exception:
            _LOGGER.exception("could not end the picture wait for round %s", anchor_seq)
            return
        if changed:
            self._notifier.publish()

    async def _row(self, anchor_seq: int) -> AdventureRoundRow | None:
        return await anyio.to_thread.run_sync(
            lambda: self._store.get_adventure_round(anchor_seq=anchor_seq)
        )

    async def _run(self, anchor_seq: int) -> bool:
        row = await self._row(anchor_seq)
        if not pictures_wanted(row):
            return False
        assert row is not None
        pack = pack_data(row)
        destination = (
            self._bank.destination(row.destination_id) if row.destination_id is not None else None
        )
        if pack is None or destination is None:
            return False
        plan = plan_pictures(
            pack,
            destination_name=destination.name,
            unit_name=self._bank.unit_name(row.country_id or ""),
        )

        async def still_wanted() -> bool:
            return pictures_wanted(await self._row(anchor_seq))

        found = await self._finder.find(plan, still_wanted=still_wanted)
        if not found or not await still_wanted():
            return False
        if self._space_ok is not None:
            room = self._space_ok
            size = sum(len(p.jpeg) for p in found)
            if not await anyio.to_thread.run_sync(lambda: room(size)):
                _LOGGER.warning("adventure pictures: no room for round %s's pictures", anchor_seq)
                return False
        return await anyio.to_thread.run_sync(lambda: self._stage_and_attach(anchor_seq, found))

    def _stage_and_attach(self, anchor_seq: int, found: Sequence[FoundPicture]) -> bool:
        """Blocking. Write each picture to `uploads/<id>/assembled` (the media queue's source) and
        attach them all in ONE transaction; staged files of an attach that did not happen are
        removed."""
        staged: list[Path] = []
        try:
            images: list[tuple[str, int]] = []
            slots: list[dict[str, object]] = []
            for ordinal, picture in enumerate(found):
                attachment_id = uuid.uuid4().hex
                upload_dir = self._paths.server_upload_dir(attachment_id)
                upload_dir.mkdir(parents=True, exist_ok=True)
                staged.append(upload_dir)
                part = upload_dir / "assembled.part"
                part.write_bytes(picture.jpeg)
                os.replace(part, upload_dir / "assembled")
                images.append((attachment_id, len(picture.jpeg)))
                slots.append(
                    {
                        "slot": picture.slot,
                        "ordinal": ordinal,
                        "credit": picture.credit,
                        "page": picture.page,
                        "caption": picture.caption,
                    }
                )
            attached = self._store.create_adventure_picture_attachments(
                anchor_seq=anchor_seq,
                images=images,
                pictures_json=json.dumps(
                    {"v": PICTURES_VERSION, "slots": slots},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                by_email=None,
                now=time.time(),
            )
            if attached:
                staged = []  # the attachments own these directories now
            return attached
        finally:
            for upload_dir in staged:
                shutil.rmtree(upload_dir, ignore_errors=True)
