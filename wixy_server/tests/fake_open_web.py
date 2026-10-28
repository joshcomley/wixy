"""A fake Wikipedia, Wikimedia Commons and venue web for the holiday-pack picture tests and the e2e
fixture (workspace 00056, spec/server-chat/08-adventure-time.md §4.3a).

Built on `FakeWeb` (one local server routed by `Host` header) and shaped like the REAL services as
measured on 2026-10-28: the REST summary's image is a
`thumb.wikimedia.org/.../thumb/<a>/<ab>/<File>/<N>px-<File>?utm_...` URL (the file name is NOT
the last path segment); the Commons API's
`prop=imageinfo&iiurlwidth=` answers a `thumburl` snapped to a standard thumbnail step (and an
`upload.wikimedia.org` ORIGINAL when the file is smaller than that step); a file-namespace search
returns `imageinfo` for every hit. Nothing here touches the network.
"""

from __future__ import annotations

import hashlib
import io
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.parse import quote

from PIL import Image, ImageCms

from wixy_server.livechat.adventure_pictures import WikimediaEndpoints
from wixy_server.tests.fake_web import FakeWeb, Reply, SeenRequest

WIKI_HOST = "en.wikipedia.test"
COMMONS_HOST = "commons.wikimedia.test"
THUMB_HOST = "thumb.wikimedia.test"
UPLOAD_HOST = "upload.wikimedia.test"
EXIF_SENTINEL = "WIXY-EXIF-SENTINEL-4471"
"""Written into every generated picture's EXIF; a stored picture must not carry it (Inv 16/44)."""
STANDARD_STEPS = (20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840)
SUMMARY_PROFILE = 'profile="https://www.mediawiki.org/wiki/Specs/Summary/1.5.0"'


def make_image(
    width: int,
    height: int,
    *,
    fmt: str = "JPEG",
    seed: int = 0,
    exif: bool = True,
    orientation: int | None = None,
    alpha: bool = False,
    frames: int = 1,
) -> bytes:
    """A real image of the given size. `seed` changes the pixels (so two files differ); `exif`
    embeds `EXIF_SENTINEL` (plus an ICC profile on JPEG/PNG); `orientation` sets the EXIF
    orientation tag; `alpha` makes an RGBA image; `frames` > 1 makes an animated WebP/GIF/PNG."""
    mode = "RGBA" if alpha else "RGB"
    base = (40 + seed * 37 % 200, 90 + seed * 53 % 150, 150 + seed * 29 % 100)

    def frame(index: int) -> Image.Image:
        image = Image.new(mode, (width, height), base if not alpha else (*base, 128))
        # A diagonal band so the pixels are not flat (and each frame differs).
        for step in range(0, min(width, height), 7):
            shade = (index * 60 + step) % 255
            image.putpixel(
                (step, step), (shade, 255 - shade, 128, 255) if alpha else (shade, 255 - shade, 128)
            )
        return image

    out = io.BytesIO()
    first = frame(0)
    options: dict[str, object] = {}
    if exif:
        exif_data = Image.Exif()
        exif_data[0x010E] = EXIF_SENTINEL  # ImageDescription
        exif_data[0x010F] = "SecretCam"  # Make
        if orientation is not None:
            exif_data[0x0112] = orientation
        options["exif"] = exif_data.tobytes()
        if fmt in ("JPEG", "PNG"):
            profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
            options["icc_profile"] = profile.tobytes()  # type: ignore[no-untyped-call]
    if frames > 1:
        options.update(
            save_all=True, append_images=[frame(i) for i in range(1, frames)], duration=80
        )
    if fmt == "JPEG":
        first.convert("RGB").save(out, format="JPEG", quality=85, **options)  # type: ignore[arg-type]
    else:
        first.save(out, format=fmt, **options)  # type: ignore[arg-type]
    return out.getvalue()


@dataclass
class FakeFile:
    """A file on the fake Commons. `width`/`height` are what the API reports for the ORIGINAL;
    `served` is the real pixel size of the image the thumbnail host serves."""

    name: str
    """Without the `File:` prefix, spaces as in the title: `Kotor Bay.jpg`."""
    width: int = 4000
    height: int = 2667
    mime: str = "image/jpeg"
    artist_html: str = '<a href="//commons.wikimedia.test/wiki/User:Jane">Jane <b>Doe</b></a>'
    licence: str = "CC BY-SA 4.0"
    served: tuple[int, int] = (1920, 1280)
    seed: int = 0
    image: bytes | None = None
    """Served as-is when set (to test a hostile or broken file)."""
    content_type: str = "image/jpeg"

    @property
    def title(self) -> str:
        return "File:" + self.name

    @property
    def underscored(self) -> str:
        return self.name.replace(" ", "_")

    @property
    def hash_dirs(self) -> tuple[str, str]:
        digest = hashlib.md5(self.underscored.encode()).hexdigest()
        return digest[0], digest[:2]

    def body(self) -> bytes:
        if self.image is not None:
            return self.image
        return make_image(*self.served, seed=self.seed)


class FakeOpenWeb:
    """The services, registered on a `FakeWeb`. Build `endpoints` AFTER the web has started (it
    needs the port) and hand them to a `WebPictureFinder`; build the fetcher with
    `fake_web.local_fetcher(web.port)`."""

    def __init__(self, web: FakeWeb) -> None:
        self.web = web
        self.files: dict[str, FakeFile] = {}
        self.searches: list[tuple[str, list[str]]] = []
        self.imageinfo_titles: list[str] = []
        """Every `titles=` the fake Commons API was asked about, in order."""
        self.imageinfo_widths: list[int] = []
        self.search_queries: list[str] = []
        web.add(COMMONS_HOST, "/w/api.php", self._api)

    @property
    def endpoints(self) -> WikimediaEndpoints:
        port = self.web.port
        return WikimediaEndpoints(
            summary_base=f"http://{WIKI_HOST}:{port}/api/rest_v1/page/summary/",
            commons_api=f"http://{COMMONS_HOST}:{port}/w/api.php",
            commons_page_base=f"http://{COMMONS_HOST}:{port}/wiki/",
            thumb_hosts=frozenset({THUMB_HOST, UPLOAD_HOST}),
            wikimedia_suffixes=("wikimedia.test", "wikipedia.test"),
        )

    # -- Commons ---------------------------------------------------------------------------------

    def add_file(self, file: FakeFile) -> FakeFile:
        self.files[file.title] = file
        return file

    def _thumb_url(self, file: FakeFile, requested: int) -> str:
        port = self.web.port
        a, ab = file.hash_dirs
        step = next(s for s in STANDARD_STEPS if s >= requested)
        if step >= file.width:  # smaller than the step: Wikimedia serves the file itself
            path = f"/wikipedia/commons/{a}/{ab}/{file.underscored}"
            self.web.add(UPLOAD_HOST, path, self._image_reply(file))
            return (
                f"http://{UPLOAD_HOST}:{port}{quote(path)}?utm_source=commons&utm_content=original"
            )
        path = f"/wikipedia/commons/thumb/{a}/{ab}/{file.underscored}/{step}px-{file.underscored}"
        self.web.add(THUMB_HOST, path, self._image_reply(file))
        return f"http://{THUMB_HOST}:{port}{quote(path)}?utm_source=commons&utm_content=thumbnail"

    @staticmethod
    def _image_reply(file: FakeFile) -> Reply:
        return Reply(body=file.body(), content_type=file.content_type)

    def _imageinfo(self, file: FakeFile, requested: int) -> dict[str, object]:
        return {
            "size": 2_000_000,
            "width": file.width,
            "height": file.height,
            "thumburl": self._thumb_url(file, requested),
            "thumbwidth": min(requested, file.width),
            "url": f"http://{UPLOAD_HOST}:{self.web.port}/original/{quote(file.underscored)}",
            "descriptionurl": f"http://{COMMONS_HOST}:{self.web.port}/wiki/{quote(file.title)}",
            "mime": file.mime,
            "extmetadata": {
                "Artist": {"value": file.artist_html, "source": "commons-desc-page"},
                "LicenseShortName": {"value": file.licence, "source": "commons-desc-page"},
            },
        }

    def _api(self, request: SeenRequest) -> Reply:
        query = request.query
        width = int((query.get("iiurlwidth") or ["1600"])[0])
        pages: list[dict[str, object]] = []
        if "titles" in query:
            title = query["titles"][0]
            self.imageinfo_titles.append(title)
            self.imageinfo_widths.append(width)
            file = self.files.get(title)
            if file is None:
                pages.append({"title": title, "missing": True})
            else:
                pages.append({"title": title, "imageinfo": [self._imageinfo(file, width)]})
        elif query.get("generator") == ["search"]:
            needle = query["gsrsearch"][0]
            self.search_queries.append(needle)
            names: list[str] = []
            for fragment, hits in self.searches:
                if fragment.lower() in needle.lower():
                    names = hits
                    break
            for index, title in enumerate(names, start=1):
                file = self.files[title]
                pages.append(
                    {
                        "title": title,
                        "index": index,
                        "imageinfo": [self._imageinfo(file, width)],
                    }
                )
        body = json.dumps({"batchcomplete": True, "query": {"pages": pages}})
        return Reply(body=body.encode(), content_type="application/json; charset=utf-8")

    def add_search(self, query_fragment: str, titles: list[str]) -> None:
        """A search whose query contains `query_fragment` (case-insensitive) answers these file
        titles in order."""
        self.searches.append((query_fragment, titles))

    # -- Wikipedia -------------------------------------------------------------------------------

    def add_article(
        self,
        title: str,
        file: FakeFile | None,
        *,
        description: str | None = "A place",
        kind: str = "standard",
        local_upload: bool = False,
    ) -> None:
        """An article whose REST summary names `file` as its lead image in the REAL shape (a
        `thumb.wikimedia.org` thumb URL with `?utm_...`). `local_upload` makes the image a local
        enwiki upload (`/wikipedia/en/...`) instead of a Commons file."""
        port = self.web.port
        body: dict[str, object] = {"type": kind, "title": title}
        if description is not None:
            body["description"] = description
        if file is not None:
            a, ab = file.hash_dirs
            project = "en" if local_upload else "commons"
            source = (
                f"http://{THUMB_HOST}:{port}/wikipedia/{project}/thumb/{a}/{ab}/{quote(file.underscored)}"
                f"/3840px-{quote(file.underscored)}?utm_source=en.wikipedia.org&utm_campaign=api"
            )
            body["originalimage"] = {"source": source, "width": file.width, "height": file.height}
        self.web.add(
            WIKI_HOST,
            "/api/rest_v1/page/summary/" + title.replace(" ", "_"),
            Reply(
                body=json.dumps(body).encode(),
                content_type="application/json; charset=utf-8; " + SUMMARY_PROFILE,
            ),
        )

    # -- a venue's own site ----------------------------------------------------------------------

    def add_venue(
        self,
        host: str,
        path: str,
        *,
        og_image: str | None,
        twitter_image: str | None = None,
        site_name: str | None = None,
        image: bytes | None = None,
        image_path: str = "/img/hero.jpg",
        image_content_type: str = "image/jpeg",
        status: int = 200,
        head_extra: str = "",
        page_content_type: str = "text/html; charset=utf-8",
        after_html: bytes = b"",
    ) -> None:
        """A venue page at `host`+`path` carrying `og:image` (a path on the same host, or a full
        URL), optionally `twitter:image` / `og:site_name`; the image is served at `image_path`."""
        if status != 200:
            self.web.add(host, path, Reply(status=status, body=b"no"))
            return
        meta = []
        if og_image is not None:
            meta.append(f'<meta property="og:image" content="{og_image}">')
        if twitter_image is not None:
            meta.append(f'<meta name="twitter:image" content="{twitter_image}">')
        if site_name is not None:
            meta.append(f'<meta property="og:site_name" content="{site_name}">')
        head = "".join(meta) + head_extra
        html = f"<!doctype html><html><head><title>Venue</title>{head}</head><body>hi</body></html>"
        self.web.add(
            host, path, Reply(body=html.encode() + after_html, content_type=page_content_type)
        )
        self.web.add(
            host,
            image_path,
            Reply(
                body=image if image is not None else make_image(1200, 800, seed=len(host)),
                content_type=image_content_type,
            ),
        )

    def serve(self, host: str, path: str, route: Reply | Callable[[SeenRequest], Reply]) -> None:
        self.web.add(host, path, route)


@dataclass
class PackSpec:
    """A small helper for building packs in tests: `sections` is `{key: [item dicts]}`."""

    wikipedia: str | None = None
    sections: dict[str, list[dict[str, object]]] = field(default_factory=dict)

    def as_pack(self) -> dict[str, object]:
        return {
            "headline": "A headline",
            "summary": "A summary.",
            "wikipedia": self.wikipedia,
            "sections": [
                {"key": key, "title": key.title(), "items": items}
                for key, items in self.sections.items()
            ],
            "bestTime": "",
            "gettingThere": "",
            "travelAdvice": "",
            "sources": [],
        }
