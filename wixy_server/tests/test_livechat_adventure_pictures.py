"""The holiday pack's pictures — the finder (workspace 00056, spec/server-chat/08-adventure-time.md
§4.3a, Inv 56): the plan, the image check and re-encode, and every source (Wikipedia lead image,
the venue's own page, a Commons search) against a fake Wikipedia/Commons/venue web served on
loopback through the SSRF-safe fetcher's injected resolver and policy. Hermetic."""

from __future__ import annotations

import dataclasses
import io
import threading
import time
import warnings
from collections.abc import Callable, Sequence
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import anyio
import pytest
from PIL import Image, JpegImagePlugin

from wixy_server.livechat import adventure_pictures
from wixy_server.livechat.adventure_pictures import (
    HEAD_SCAN_BYTES,
    HERO_MAX,
    HERO_TARGET,
    ITEM_SLOT_ATTEMPTS,
    MAX_PICTURES,
    FoundPicture,
    PicturePlan,
    PictureRejected,
    PictureSlot,
    WebPictureFinder,
    commons_file_name,
    declared_picture_size,
    is_wikimedia_host,
    page_meta,
    parse_commons_pages,
    plain_text,
    plan_pictures,
    prepare_picture,
    web_codec,
)
from wixy_server.tests.fake_open_web import (
    COMMONS_HOST,
    EXIF_SENTINEL,
    THUMB_HOST,
    UPLOAD_HOST,
    WIKI_HOST,
    FakeFile,
    FakeOpenWeb,
    PackSpec,
    make_image,
)
from wixy_server.tests.fake_web import FakeWeb, Reply, local_fetcher

KOTOR_PLAN_ARGS = {"destination_name": "Kotor", "unit_name": "Montenegro"}


def item(
    name: str, *, wikipedia: str | None = None, url: str | None = None, detail: str = ""
) -> dict[str, object]:
    return {"name": name, "detail": detail, "url": url, "wikipedia": wikipedia}


def plan_of(
    sections: dict[str, list[dict[str, object]]], *, wikipedia: str | None = "Kotor"
) -> PicturePlan:
    return plan_pictures(PackSpec(wikipedia, sections).as_pack(), **KOTOR_PLAN_ARGS)


def jpeg_of(picture: FoundPicture) -> Image.Image:
    return Image.open(io.BytesIO(picture.jpeg))


def run_find(
    configure: Callable[[FakeOpenWeb], None],
    plan: PicturePlan,
    *,
    budget_s: float = 60.0,
    wanted: Callable[[], bool] = lambda: True,
    fetcher_options: dict[str, Any] | None = None,
) -> tuple[list[FoundPicture], FakeWeb, FakeOpenWeb]:
    """Run a `WebPictureFinder` over `plan` against a fake open web; returns what it found, the
    server (its recorded requests) and the fake services. The plan's item sites are written as an
    AI would give them (no port); the harness adds the fake server's port to them."""

    async def go() -> tuple[list[FoundPicture], FakeWeb, FakeOpenWeb]:
        web = FakeWeb()
        port = await web.start()
        open_web = FakeOpenWeb(web)
        configure(open_web)
        ported = dataclasses.replace(
            plan,
            slots=tuple(dataclasses.replace(s, url=with_port(s.url, port)) for s in plan.slots),
        )
        finder = WebPictureFinder(
            local_fetcher(port, **(fetcher_options or {})),
            endpoints=open_web.endpoints,
            budget_s=budget_s,
        )

        async def still_wanted() -> bool:
            return wanted()

        try:
            return await finder.find(ported, still_wanted=still_wanted), web, open_web
        finally:
            await finder.aclose()
            await web.stop()

    return anyio.run(go)


def with_port(url: str | None, port: int) -> str | None:
    if url is None:
        return None
    parts = urlsplit(url)
    return urlunsplit(parts._replace(netloc=f"{parts.hostname}:{port}"))


def by_slot(pictures: Sequence[FoundPicture]) -> dict[str, FoundPicture]:
    return {p.slot: p for p in pictures}


# -- the plan ------------------------------------------------------------------------------------


class TestPlan:
    def test_items_are_served_round_robin_by_position_and_practical_gets_none(self) -> None:
        plan = plan_of(
            {
                "food": [item("F0", wikipedia="A"), item("F1", url="https://f1.example.com/")],
                "sights": [item("S0"), item("S1", wikipedia="B")],
                "practical": [item("P0", url="https://p.example.com/")],
                "stay": [item("T0", url="https://t0.example.com/")],
            }
        )
        assert [s.key for s in plan.slots] == ["sights:0", "food:0", "stay:0", "sights:1", "food:1"]

    def test_a_non_sight_with_neither_article_nor_site_is_not_a_slot(self) -> None:
        plan = plan_of({"food": [item("Grilled sardines")], "sights": [item("Old gate")]})
        assert [s.key for s in plan.slots] == ["sights:0"]
        assert plan.slots[0].search is True

    def test_slot_fields_come_from_the_item(self) -> None:
        plan = plan_of(
            {"food": [item("Cevapi", wikipedia="Ćevapi", url="https://cevapi.example.com/x")]}
        )
        (slot,) = plan.slots
        assert (slot.key, slot.section, slot.name) == ("food:0", "food", "Cevapi")
        assert (slot.wikipedia, slot.url, slot.search) == (
            "Ćevapi",
            "https://cevapi.example.com/x",
            False,
        )
        assert plan.destination == "Kotor" and plan.unit == "Montenegro"
        assert plan.destination_wikipedia == "Kotor"

    def test_the_number_of_attempts_is_capped(self) -> None:
        many = {
            "food": [item(f"f{i}", url=f"https://f{i}.example.com/") for i in range(6)],
            "stay": [item(f"s{i}", url=f"https://s{i}.example.com/") for i in range(6)],
            "culture": [item(f"c{i}", url=f"https://c{i}.example.com/") for i in range(6)],
            "sights": [item(f"x{i}", wikipedia=f"X{i}") for i in range(6)],
            "do": [item(f"d{i}", url=f"https://d{i}.example.com/") for i in range(6)],
        }
        assert len(plan_of(many).slots) == ITEM_SLOT_ATTEMPTS

    def test_garbage_in_the_pack_is_ignored(self) -> None:
        pack: dict[str, object] = {
            "sections": [
                "nope",
                {"key": 5, "items": []},
                {"key": "food", "items": "x"},
                {"key": "sights", "items": [3, {"name": ""}, {"name": "ok"}]},
            ]
        }
        plan = plan_pictures(pack, **KOTOR_PLAN_ARGS)
        assert [s.key for s in plan.slots] == ["sights:2"]
        assert plan.destination_wikipedia is None


# -- which Commons file a Wikipedia image URL names ----------------------------------------------


class TestCommonsFileName:
    @pytest.mark.parametrize(
        ("source", "name"),
        [
            # The REAL shape measured on 2026-10-28: a thumb.wikimedia.org thumb URL with utm
            # parameters; the name is the segment after the two hash directories, NOT the last one.
            (
                "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/26/"
                "20090719_Crkva_Gospa_od_Zdravlja_Kotor_Bay_Montenegro.jpg/"
                "3840px-20090719_Crkva_Gospa_od_Zdravlja_Kotor_Bay_Montenegro.jpg"
                "?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail",
                "20090719_Crkva_Gospa_od_Zdravlja_Kotor_Bay_Montenegro.jpg",
            ),
            (
                "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d9/"
                "Kotor_and_Boka_kotorska_-_view_from_city_wall.jpg/330px-Kotor_and_Boka.jpg",
                "Kotor_and_Boka_kotorska_-_view_from_city_wall.jpg",
            ),
            (
                "https://upload.wikimedia.org/wikipedia/commons/8/8b/Crkva_Gospa.jpg?utm_x=1",
                "Crkva_Gospa.jpg",
            ),
            (
                "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a6/"
                "Iglesia_de_Nuestra_Se%C3%B1ora%2C_Kotor.JPG/1920px-Iglesia_de_Nuestra_Se%C3%B1ora.JPG",
                "Iglesia_de_Nuestra_Señora,_Kotor.JPG",
            ),
            (
                "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1f/"
                "Bay_of_Kotor_from_Lepetani%27s_road.jpg/1920px-x.jpg",
                "Bay_of_Kotor_from_Lepetani's_road.jpg",
            ),
            # A thumbnail of a PDF page / TIFF keeps the file name in the same place.
            (
                "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Doc.pdf/page1-330px-Doc.pdf.jpg",
                "Doc.pdf",
            ),
        ],
    )
    def test_the_name_is_after_the_hash_directories(self, source: str, name: str) -> None:
        assert commons_file_name(source) == name

    @pytest.mark.parametrize(
        "source",
        [
            # A local enwiki upload (not on Commons: usually a non-free logo or poster).
            "https://upload.wikimedia.org/wikipedia/en/thumb/a/ab/Logo.png/220px-Logo.png",
            "https://upload.wikimedia.org/wikipedia/en/a/ab/Logo.png",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/2/Only.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/x/yy/Bad_hash_dir.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/a/bc/Hash_does_not_start_with_a.jpg",
            "https://upload.wikimedia.org/something/else.jpg",
            "https://example.com/",
            "not a url",
            "",
            None,
            42,
        ],
    )
    def test_anything_else_is_none(self, source: object) -> None:
        assert commons_file_name(source) is None


# -- the Commons API answer ----------------------------------------------------------------------


class TestParseCommonsPages:
    HOSTS = frozenset({"thumb.example.org"})

    def _page(self, **over: Any) -> dict[str, Any]:
        page: dict[str, Any] = {
            "title": "File:A b.jpg",
            "index": 1,
            "imageinfo": [
                {
                    "width": 4000,
                    "height": 3000,
                    "size": 5,
                    "mime": "image/jpeg",
                    "thumburl": "https://thumb.example.org/wikipedia/commons/thumb/a/ab/A_b.jpg/1920px-A_b.jpg",
                    "extmetadata": {
                        "Artist": {"value": '<a href="//x">Ann</a> &amp; <i>Bo</i>'},
                        "LicenseShortName": {"value": "CC0"},
                    },
                }
            ],
        }
        page.update(over)
        return page

    def test_a_page_becomes_a_file_with_stripped_credit_text(self) -> None:
        (file,) = parse_commons_pages({"query": {"pages": [self._page()]}}, self.HOSTS)
        assert file.title == "File:A b.jpg" and file.key == "commons:file:a b.jpg"
        assert (file.width, file.height, file.mime) == (4000, 3000, "image/jpeg")
        assert file.artist == "Ann & Bo" and file.licence == "CC0"

    def test_results_are_in_search_order(self) -> None:
        pages = [self._page(index=3, title="File:c.jpg"), self._page(index=1, title="File:a.jpg")]
        files = parse_commons_pages({"query": {"pages": pages}}, self.HOSTS)
        assert [f.title for f in files] == ["File:a.jpg", "File:c.jpg"]

    @pytest.mark.parametrize(
        "bad",
        [
            {"missing": True, "imageinfo": None},
            {"imageinfo": []},
            {"imageinfo": ["x"]},
            {"title": "Category:x"},
            {"title": 5},
            {"imageinfo": [{"mime": "image/jpeg"}]},
            {
                "imageinfo": [
                    {"mime": "image/jpeg", "thumburl": "https://evil.example.net/x.jpg", "width": 9}
                ]
            },
        ],
    )
    def test_unusable_pages_are_skipped(self, bad: dict[str, Any]) -> None:
        assert parse_commons_pages({"query": {"pages": [self._page(**bad)]}}, self.HOSTS) == []

    @pytest.mark.parametrize("data", [None, [], {"query": []}, {"query": {"pages": {}}}, "x"])
    def test_garbage_is_empty(self, data: object) -> None:
        assert parse_commons_pages(data, self.HOSTS) == []


# -- text helpers --------------------------------------------------------------------------------


def test_plain_text_strips_tags_entities_and_clips() -> None:
    assert plain_text('<a href="//u">J<b>ane</b></a> &amp; Co&nbsp;Ltd', 50) == "Jane & Co Ltd"
    assert plain_text("x" * 300, 120).endswith("…") and len(plain_text("x" * 300, 120)) == 120
    assert (
        plain_text(None, 10) == "" and plain_text(5, 10) == "" and plain_text("<b></b>", 10) == ""
    )


def test_page_meta_reads_head_meta_first_value_wins_and_stops_at_the_head() -> None:
    html = (
        b'<html><head><meta property="og:image" content="/a.jpg">'
        b'<meta property="og:image" content="/second.jpg">'
        b'<meta name="Twitter:Image" content=" /t.jpg "><meta name="x"></head>'
        b'<body><meta property="og:site_name" content="late"></body></html>'
    )
    meta = page_meta(html, "utf-8")
    assert meta == {"og:image": "/a.jpg", "twitter:image": "/t.jpg"}
    assert page_meta("<meta property='og:image' content='é.jpg'>".encode("latin-1"), "nope") != {}


# -- validating and re-encoding a fetched image --------------------------------------------------


class TestPreparePicture:
    def test_a_jpeg_is_rebuilt_clean_and_scaled_to_1600(self) -> None:
        source = make_image(3200, 2000, seed=3)
        assert EXIF_SENTINEL.encode() in source  # the fixture really carries it
        prepared = prepare_picture(source)
        assert (prepared.width, prepared.height) == (1600, 1000)
        out = Image.open(io.BytesIO(prepared.jpeg))
        assert out.format == "JPEG" and out.size == (1600, 1000) and out.mode == "RGB"
        assert EXIF_SENTINEL.encode() not in prepared.jpeg and b"SecretCam" not in prepared.jpeg
        assert len(out.getexif()) == 0 and "icc_profile" not in out.info and "exif" not in out.info

    def test_a_small_enough_image_is_not_enlarged(self) -> None:
        prepared = prepare_picture(make_image(900, 700))
        assert (prepared.width, prepared.height) == (900, 700)

    @pytest.mark.parametrize("fmt", ["PNG", "WEBP"])
    def test_png_and_webp_are_accepted_and_come_out_as_jpeg(self, fmt: str) -> None:
        prepared = prepare_picture(make_image(1000, 800, fmt=fmt))
        assert Image.open(io.BytesIO(prepared.jpeg)).format == "JPEG"
        assert EXIF_SENTINEL.encode() not in prepared.jpeg

    def test_transparency_is_flattened_onto_white(self) -> None:
        prepared = prepare_picture(make_image(800, 800, fmt="PNG", alpha=True, exif=False))
        out = Image.open(io.BytesIO(prepared.jpeg)).convert("RGB")
        assert out.getpixel((799, 0)) != (0, 0, 0)  # not the black a naive RGBA->RGB gives

    def test_exif_orientation_is_applied(self) -> None:
        # Stored 1200 wide x 800 tall with orientation 6 (rotate 90): upright it is 800 x 1200.
        prepared = prepare_picture(make_image(1200, 800, orientation=6))
        assert Image.open(io.BytesIO(prepared.jpeg)).size == (800, 1200)

    @pytest.mark.parametrize(
        ("width", "height", "ok"),
        [
            (480, 480, True),
            (479, 600, False),
            (600, 479, False),
            (1440, 480, True),  # exactly 3:1
            (1441, 480, False),  # beyond 3:1: a banner
            (4000, 300, False),
            (64, 64, False),
        ],
    )
    def test_the_size_and_aspect_bounds(self, width: int, height: int, ok: bool) -> None:
        if ok:
            assert prepare_picture(make_image(width, height)).jpeg
        else:
            with pytest.raises(PictureRejected) as caught:
                prepare_picture(make_image(width, height))
            assert caught.value.reason in ("too_small", "banner")

    def test_the_minimum_short_side_can_be_raised(self) -> None:
        with pytest.raises(PictureRejected):
            prepare_picture(make_image(800, 800), min_short_side=900)

    @pytest.mark.parametrize(
        "data",
        [
            b"",
            b"hello world, definitely not an image",
            b"<svg xmlns='http://www.w3.org/2000/svg' width='900' height='900'></svg>",
            b"<!doctype html><html><body>blocked</body></html>",
            b"GIF89a" + b"\x00" * 100,
            b"\x00\x00\x00\x18ftypheic" + b"\x00" * 100,
            b"%PDF-1.7 " + b"\x00" * 100,
            b"RIFF\x00\x00\x00\x00WAVEfmt " + b"\x00" * 100,
        ],
    )
    def test_things_that_do_not_sniff_as_jpeg_png_or_webp_are_refused(self, data: bytes) -> None:
        with pytest.raises(PictureRejected):
            prepare_picture(data)

    def test_a_truncated_or_corrupt_image_is_refused(self) -> None:
        good = make_image(1000, 800)
        for broken in (
            good[: len(good) // 3],
            good[:12] + b"\x00" * 500,
            b"\xff\xd8\xff" + b"x" * 50,
        ):
            with pytest.raises(PictureRejected):
                prepare_picture(broken)

    def test_an_animated_image_is_refused(self) -> None:
        for fmt in ("WEBP", "PNG"):
            data = make_image(600, 600, fmt=fmt, frames=3, exif=False)
            with pytest.raises(PictureRejected) as caught:
                prepare_picture(data)
            assert caught.value.reason == "animated"

    @pytest.mark.filterwarnings("ignore::PIL.Image.DecompressionBombWarning")
    def test_a_decompression_bomb_is_refused_before_it_is_decoded(self) -> None:
        # 10,000 x 10,000 one-bit pixels = 100 MP: a few KiB on the wire, over the 80 MP cap.
        bomb = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            Image.new("1", (10_000, 10_000)).save(bomb, format="PNG")
        assert len(bomb.getvalue()) < 100_000
        with pytest.raises(PictureRejected) as caught:
            prepare_picture(bomb.getvalue())
        assert caught.value.reason == "too_many_pixels"

    def test_a_png_dressed_as_a_jpeg_is_a_mismatch_or_corrupt(self) -> None:
        png = make_image(600, 600, fmt="PNG")
        with pytest.raises(PictureRejected):
            prepare_picture(b"\xff\xd8\xff" + png[3:])

    def test_a_picture_declaring_more_than_16_megapixels_is_refused_before_decoding(self) -> None:
        # 5000 x 4000 = 20 MP: under the chat's own 80 MP cap, over the fetched-picture cap.
        big = io.BytesIO()
        Image.new("1", (5000, 4000)).save(big, format="PNG")
        assert adventure_pictures.MAX_FETCHED_PIXELS == 16_000_000
        with pytest.raises(PictureRejected) as caught:
            prepare_picture(big.getvalue())
        assert caught.value.reason == "too_many_pixels"

    def test_a_picture_of_exactly_16_megapixels_is_accepted_and_shrunk(self) -> None:
        # The largest allowed input, in the format that needs the most memory (RGBA).
        buffer = io.BytesIO()
        Image.new("RGBA", (4000, 4000), (200, 30, 30, 255)).save(buffer, format="PNG")
        prepared = prepare_picture(buffer.getvalue())
        assert (prepared.width, prepared.height) == (1600, 1600)

    def test_the_reported_size_is_the_upright_size_written(self) -> None:
        # Stored 3600 x 2400, EXIF orientation 6 (rotate 90): upright 2400 x 3600 -> 1067 x 1600.
        prepared = prepare_picture(make_image(3600, 2400, orientation=6))
        assert (prepared.width, prepared.height) == (1067, 1600)
        assert Image.open(io.BytesIO(prepared.jpeg)).size == (1067, 1600)


# -- the header is read from the bytes, BEFORE Image.open (F1) -------------------------------------


def png_header(width: int, height: int) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + (13).to_bytes(4, "big")
        + b"IHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + b"\x08\x06\x00\x00\x00"
        + b"\x00" * 8
    )


def jpeg_header(width: int, height: int) -> bytes:
    sof = (
        b"\x08"
        + height.to_bytes(2, "big")
        + width.to_bytes(2, "big")
        + b"\x03"
        + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    )
    return (
        b"\xff\xd8"
        + b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
        + b"\xff\xc0"
        + (len(sof) + 2).to_bytes(2, "big")
        + sof
        + b"\xff\xda\x00\x08\x01\x01\x00\x00?\x00"
        + b"\x00" * 8
    )


def _riff(chunk: bytes) -> bytes:
    return b"RIFF" + (4 + len(chunk)).to_bytes(4, "little") + b"WEBP" + chunk


def webp_vp8x(width: int, height: int) -> bytes:
    body = (
        b"\x10\x00\x00\x00" + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
    )
    return _riff(b"VP8X" + (10).to_bytes(4, "little") + body + b"\x00" * 8)


def webp_vp8(width: int, height: int) -> bytes:
    frame = (
        b"\x10\x02\x00"
        + b"\x9d\x01\x2a"
        + width.to_bytes(2, "little")
        + height.to_bytes(2, "little")
    )
    return _riff(b"VP8 " + len(frame).to_bytes(4, "little") + frame + b"\x00" * 8)


def webp_vp8l(width: int, height: int) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    frame = b"\x2f" + bits.to_bytes(4, "little")
    return _riff(b"VP8L" + len(frame).to_bytes(4, "little") + frame + b"\x00" * 8)


HEADER_BUILDERS = {
    "png": png_header,
    "jpeg": jpeg_header,
    "webp-vp8x": webp_vp8x,
    "webp-vp8": webp_vp8,
    "webp-vp8l": webp_vp8l,
}


class TestDeclaredSize:
    @pytest.fixture
    def no_image_open(self, monkeypatch: pytest.MonkeyPatch) -> list[int]:
        calls: list[int] = []

        def boom(*args: object, **kwargs: object) -> object:
            calls.append(1)
            raise AssertionError("Image.open must not be called for this header")

        monkeypatch.setattr(Image, "open", boom)
        return calls

    @pytest.mark.parametrize("kind", list(HEADER_BUILDERS))
    @pytest.mark.parametrize(("width", "height"), [(4001, 4000), (8000, 8000), (16383, 16383)])
    def test_an_oversize_header_is_refused_without_calling_image_open(
        self, no_image_open: list[int], kind: str, width: int, height: int
    ) -> None:
        with pytest.raises(PictureRejected) as caught:
            prepare_picture(HEADER_BUILDERS[kind](width, height))
        assert caught.value.reason == "too_many_pixels"
        assert no_image_open == []

    @pytest.mark.parametrize(("width", "height"), [(65535, 65535), (30000, 40000)])
    def test_the_huge_sizes_only_png_jpeg_and_vp8x_can_declare_are_refused_too(
        self, no_image_open: list[int], width: int, height: int
    ) -> None:
        for builder in (png_header, jpeg_header):
            with pytest.raises(PictureRejected) as caught:
                prepare_picture(builder(width, height))
            assert caught.value.reason == "too_many_pixels"
        # The auditor's case: a 140-byte animated WebP declaring a 16384 x 16384 canvas.
        with pytest.raises(PictureRejected) as caught:
            prepare_picture(webp_vp8x(16384, 16384))
        assert caught.value.reason == "too_many_pixels"
        assert no_image_open == []

    @pytest.mark.parametrize("kind", list(HEADER_BUILDERS))
    def test_a_small_or_banner_header_is_refused_before_opening_too(
        self, no_image_open: list[int], kind: str
    ) -> None:
        for size, reason in (((300, 300), "too_small"), ((2000, 480), "banner")):
            with pytest.raises(PictureRejected) as caught:
                prepare_picture(HEADER_BUILDERS[kind](*size))
            assert caught.value.reason == reason
        assert no_image_open == []

    @pytest.mark.parametrize("kind", list(HEADER_BUILDERS))
    def test_an_acceptable_header_does_reach_image_open(
        self, kind: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        opened: list[int] = []
        real_open = Image.open

        def spy(*args: Any, **kwargs: Any) -> Any:
            opened.append(1)
            return real_open(*args, **kwargs)

        monkeypatch.setattr(Image, "open", spy)
        with pytest.raises(PictureRejected) as caught:  # a header with no image data behind it
            prepare_picture(HEADER_BUILDERS[kind](1200, 800))
        assert caught.value.reason in ("corrupt", "format_mismatch")
        assert opened == [1]

    @pytest.mark.parametrize(
        "data",
        [
            b"\x89PNG\r\n\x1a\n" + b"\x00" * 30,  # no IHDR
            b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IDAT" + b"\x00" * 20,
            b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 40,  # never reaches a frame header
            b"\xff\xd8\xff\xdb\x00\x04\x00\x00" + b"\x00" * 12,  # junk where a marker should be
            b"RIFF\x00\x00\x00\x00WEBPJUNK" + b"\x00" * 30,  # a first chunk that is not VP8*
            b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 30,  # bad VP8 start code
            b"RIFF\x00\x00\x00\x00WEBPVP8L" + b"\x00" * 30,  # bad VP8L signature
            b"RIFF\x00\x00\x00\x00WEBPVP8X\x0a",  # truncated
        ],
    )
    def test_an_unreadable_header_is_refused_before_opening(
        self, no_image_open: list[int], data: bytes
    ) -> None:
        with pytest.raises(PictureRejected) as caught:
            prepare_picture(data)
        assert caught.value.reason == "corrupt"
        assert no_image_open == []

    def test_the_header_reader_agrees_with_real_files(self) -> None:
        def encode(image: Image.Image, **options: Any) -> bytes:
            out = io.BytesIO()
            image.save(out, **options)
            return out.getvalue()

        rgb = Image.new("RGB", (731, 509), (10, 120, 200))
        lossy_webp = make_image(731, 509, fmt="WEBP", exif=False)
        exif_webp = make_image(731, 509, fmt="WEBP", exif=True)
        assert lossy_webp[12:16] == b"VP8 " and exif_webp[12:16] == b"VP8X"
        cases: dict[str, tuple[str, bytes]] = {
            "baseline jpeg": ("jpeg", make_image(731, 509)),
            "progressive jpeg": ("jpeg", encode(rgb, format="JPEG", progressive=True)),
            "grey jpeg": ("jpeg", encode(rgb.convert("L"), format="JPEG")),
            "png": ("png", make_image(731, 509, fmt="PNG")),
            "webp VP8": ("webp", lossy_webp),
            "webp VP8X": ("webp", exif_webp),
            "webp VP8L": ("webp", encode(rgb, format="WEBP", lossless=True)),
        }
        for name, (container, data) in cases.items():
            assert declared_picture_size(container, data) == (731, 509), name

    def test_an_exif_thumbnail_inside_a_segment_is_not_mistaken_for_the_frame(self) -> None:
        real = make_image(1200, 900, exif=False)
        thumbnail = make_image(10, 10, exif=False)
        app1 = b"\xff\xe1" + (len(thumbnail) + 8).to_bytes(2, "big") + b"Exif\x00\x00" + thumbnail
        data = real[:2] + app1 + real[2:]
        assert declared_picture_size("jpeg", data) == (1200, 900)

    def test_a_jpeg_with_two_frame_headers_is_refused(self) -> None:
        real = make_image(1200, 900, exif=False)
        start = real.index(b"\xff\xc0")
        length = int.from_bytes(real[start + 2 : start + 4], "big")
        frame = real[start : start + 2 + length]
        doubled = real[: start + 2 + length] + frame + real[start + 2 + length :]
        assert declared_picture_size("jpeg", doubled) is None
        with pytest.raises(PictureRejected):
            prepare_picture(doubled)

    def test_the_header_and_pillow_must_agree(self) -> None:
        real = bytearray(make_image(1200, 900, fmt="PNG", exif=False))
        real[16:20] = (1000).to_bytes(4, "big")  # lie about the width in IHDR
        with pytest.raises(PictureRejected):
            prepare_picture(bytes(real))


class TestLeanReencode:
    """Every mode Pillow can hand over comes out as the same clean RGB JPEG, shrunk first."""

    @staticmethod
    def _png(image: Image.Image, **options: Any) -> bytes:
        out = io.BytesIO()
        image.save(out, format="PNG", **options)
        return out.getvalue()

    @pytest.mark.parametrize(
        "mode",
        ["RGB", "RGBA", "LA", "L", "1", "P", "PT", "I;16", "CMYK"],
    )
    def test_each_mode_becomes_an_rgb_jpeg_of_the_right_size(self, mode: str) -> None:
        size = (1800, 1200)
        out = io.BytesIO()
        if mode == "CMYK":
            Image.new("CMYK", size, (0, 100, 200, 10)).save(out, format="JPEG")
        elif mode == "PT":  # palette with a transparent index
            Image.new("P", size, 0).save(out, format="PNG", transparency=0)
        elif mode == "P":
            Image.new("P", size, 3).save(out, format="PNG")
        elif mode == "I;16":
            Image.new("I;16", size, 40000).save(out, format="PNG")
        else:
            Image.new(mode, size).save(out, format="PNG")  # black / transparent: any pixels do
        prepared = prepare_picture(out.getvalue())
        assert (prepared.width, prepared.height) == (1600, 1067)
        result = Image.open(io.BytesIO(prepared.jpeg))
        assert result.format == "JPEG" and result.mode == "RGB" and result.size == (1600, 1067)

    def test_a_big_jpeg_is_decoded_at_reduced_scale(self, monkeypatch: pytest.MonkeyPatch) -> None:
        drafted: list[tuple[str, tuple[int, int]]] = []
        real: Any = JpegImagePlugin.JpegImageFile.draft

        def spy(self: Image.Image, mode: str | None, size: tuple[int, int]) -> object:
            drafted.append((str(mode), size))
            return real(self, mode, size)

        monkeypatch.setattr(JpegImagePlugin.JpegImageFile, "draft", spy)
        prepared = prepare_picture(make_image(3600, 2400))
        assert drafted and drafted[0] == ("RGB", (1600, 1067))
        assert (prepared.width, prepared.height) == (1600, 1067)

    def test_a_transparent_png_flattens_onto_white_even_after_shrinking(self) -> None:
        source = self._png(Image.new("RGBA", (2400, 1600), (255, 0, 0, 0)))  # fully transparent
        prepared = prepare_picture(source)
        pixel = Image.open(io.BytesIO(prepared.jpeg)).convert("RGB").getpixel((800, 500))
        assert isinstance(pixel, tuple) and min(pixel) > 240

    def test_an_icc_profile_is_applied_then_dropped(self) -> None:
        source = make_image(2000, 1400, fmt="PNG")  # carries an sRGB profile and EXIF
        assert b"iCCP" in source
        result = Image.open(io.BytesIO(prepare_picture(source).jpeg))
        assert "icc_profile" not in result.info and len(result.getexif()) == 0


# -- the sources ---------------------------------------------------------------------------------


class TestWikipediaLeadImage:
    def test_the_lead_image_comes_from_the_commons_thumbnail_named_by_the_real_file_name(
        self,
    ) -> None:
        lead = FakeFile("Kotor Bay Panorama.jpg", 4256, 2832, seed=1)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(lead)
            w.add_article("Kotor", lead, description="City in Coastal Montenegro")

        pictures, web, open_web = run_find(configure, plan_of({}))
        (hero,) = pictures
        assert hero.slot == "hero:0"
        # The Commons title was parsed from the path (NOT the last segment `3840px-...`).
        assert open_web.imageinfo_titles == ["File:Kotor Bay Panorama.jpg"]
        assert open_web.imageinfo_widths == [1600]
        assert hero.credit == "Jane Doe, CC BY-SA 4.0"
        assert hero.page == (f"http://{COMMONS_HOST}:{web.port}/wiki/File:Kotor_Bay_Panorama.jpg")
        assert hero.caption == "City in Coastal Montenegro"
        # Only the API's thumbnail was fetched, never an upload.wikimedia original.
        assert [r.host for r in web.requests if r.host in (THUMB_HOST, UPLOAD_HOST)] == [THUMB_HOST]
        thumb_request = web.seen(THUMB_HOST)[0]
        assert "/thumb/" in thumb_request.path and thumb_request.path.endswith(
            "1920px-Kotor_Bay_Panorama.jpg"
        )

    def test_the_stored_picture_is_a_clean_jpeg_of_at_most_1600(self) -> None:
        lead = FakeFile("Big.jpg", 5000, 3333, served=(1920, 1280))

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(lead)
            w.add_article("Kotor", lead)

        (hero,) = run_find(configure, plan_of({}))[0]
        out = jpeg_of(hero)
        assert out.format == "JPEG" and max(out.size) == 1600
        assert EXIF_SENTINEL.encode() not in hero.jpeg and len(out.getexif()) == 0

    @pytest.mark.parametrize(
        ("width", "served", "asks", "expect_picture"),
        [
            (1850, (1280, 830), [1600, 1280], True),
            (1000, (960, 640), [1600, 960], True),
            (700, (500, 500), [1600, 500], True),
            (450, (450, 450), [1600], False),
        ],
    )
    def test_a_file_smaller_than_the_thumbnail_step_is_never_fetched_as_its_original(
        self, width: int, served: tuple[int, int], asks: list[int], expect_picture: bool
    ) -> None:
        small = FakeFile("Small.jpg", width, width * 2 // 3, served=served)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(small)
            w.add_article("Kotor", small)

        pictures, web, open_web = run_find(configure, plan_of({}))
        assert open_web.imageinfo_widths == asks
        assert web.seen(UPLOAD_HOST) == []  # NEVER an original
        assert bool(pictures) is expect_picture

    def test_a_missing_article_is_skipped_without_trouble(self) -> None:
        pictures, web, open_web = run_find(lambda w: None, plan_of({}, wikipedia="No Such Article"))
        assert pictures == [] and open_web.imageinfo_titles == []
        assert [r.host for r in web.requests] == [WIKI_HOST, COMMONS_HOST]  # the 404, then a search

    def test_a_disambiguation_page_a_local_upload_and_a_file_with_no_image_are_skipped(
        self,
    ) -> None:
        pic = FakeFile("Pic.jpg", 3000, 2000)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(pic)
            w.add_article("Disambig", pic, kind="disambiguation")
            w.add_article("Local", pic, local_upload=True)
            w.add_article("Imageless", None)

        sections = {
            "sights": [
                item("a", wikipedia="Disambig"),
                item("b", wikipedia="Local"),
                item("c", wikipedia="Imageless"),
            ]
        }
        pictures, _, open_web = run_find(configure, plan_of(sections, wikipedia=None))
        # No lead image and nothing found; the sights fall through to a (fruitless) search.
        assert pictures == [] and open_web.imageinfo_titles == []

    @pytest.mark.parametrize("mime", ["image/svg+xml", "image/tiff", "image/gif", "video/webm"])
    def test_a_lead_that_is_not_a_jpeg_png_or_webp_file_is_skipped(self, mime: str) -> None:
        pic = FakeFile("Odd.svg", 3000, 2000, mime=mime)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(pic)
            w.add_article("Kotor", pic)

        pictures, web, _ = run_find(configure, plan_of({}))
        assert pictures == [] and web.seen(THUMB_HOST) == []


class TestSiteImage:
    def test_a_venue_with_no_article_uses_its_own_page_image_credited_to_the_site(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue(
                "villa.example.com", "/stay", og_image="/img/hero.jpg", site_name="Villa Mira"
            )

        plan = plan_of(
            {"stay": [item("Villa Mira", url="http://villa.example.com/stay")]}, wikipedia=None
        )
        (pic,) = run_find(configure, plan)[0]
        assert pic.slot == "stay:0" and pic.credit == "Villa Mira" and pic.caption is None
        assert pic.page.startswith("http://villa.example.com:") and pic.page.endswith("/stay")

    def test_the_credit_falls_back_to_the_host_name(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue("www.cafe.example.com", "/", og_image="/img/hero.jpg")

        plan = plan_of({"food": [item("Cafe", url="http://www.cafe.example.com/")]}, wikipedia=None)
        (pic,) = run_find(configure, plan)[0]
        assert pic.credit == "cafe.example.com"

    def test_an_article_beats_the_venue_site_and_the_site_is_then_never_asked(self) -> None:
        dish = FakeFile("Dish.jpg", 3000, 2000, seed=4)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(dish)
            w.add_article("Cevapi", dish)
            w.add_venue("grill.example.com", "/", og_image="/img/hero.jpg")

        plan = plan_of(
            {"food": [item("Cevapi", wikipedia="Cevapi", url="http://grill.example.com/")]},
            wikipedia=None,
        )
        pictures, web, _ = run_find(configure, plan)
        assert [p.slot for p in pictures] == ["food:0"]
        assert pictures[0].credit == "Jane Doe, CC BY-SA 4.0"
        assert web.seen("grill.example.com") == []

    def test_a_missing_article_falls_back_to_the_site(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue("grill.example.com", "/", og_image="/img/hero.jpg", site_name="Grill")

        plan = plan_of(
            {"food": [item("Grill", wikipedia="No Such Page", url="http://grill.example.com/")]},
            wikipedia=None,
        )
        (pic,) = run_find(configure, plan)[0]
        assert pic.credit == "Grill"

    def test_a_forbidden_or_rate_limited_site_is_skipped_quietly(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue("blocked.example.com", "/", og_image=None, status=403)
            w.add_venue("busy.example.com", "/", og_image=None, status=429)

        plan = plan_of(
            {
                "food": [item("a", url="http://blocked.example.com/")],
                "stay": [item("b", url="http://busy.example.com/")],
            },
            wikipedia=None,
        )
        pictures, web, _ = run_find(configure, plan)
        assert pictures == []
        # Each was really asked (once: a 429 with no Retry-After is not retried), then left alone.
        assert [r.path for r in web.seen("blocked.example.com")] == ["/"]
        assert [r.path for r in web.seen("busy.example.com")] == ["/"]

    def test_a_tiny_icon_is_refused_and_the_next_image_tag_is_tried(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue(
                "icon.example.com",
                "/",
                og_image="/img/icon.png",
                twitter_image="/img/real.jpg",
                image=make_image(1200, 800, seed=9),
                image_path="/img/real.jpg",
            )
            w.serve(
                "icon.example.com",
                "/img/icon.png",
                Reply(body=make_image(180, 180), content_type="image/png"),
            )

        plan = plan_of({"food": [item("a", url="http://icon.example.com/")]}, wikipedia=None)
        pictures, web, _ = run_find(configure, plan)
        assert len(pictures) == 1
        assert [r.path for r in web.seen("icon.example.com")] == [
            "/",
            "/img/icon.png",
            "/img/real.jpg",
        ]

    def test_an_image_url_that_serves_html_is_refused(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue(
                "lie.example.com", "/", og_image="/img/hero.jpg", image_content_type="text/html"
            )

        plan = plan_of({"food": [item("a", url="http://lie.example.com/")]}, wikipedia=None)
        assert run_find(configure, plan)[0] == []

    def test_a_data_uri_or_junk_image_tag_is_ignored(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue(
                "junk.example.com",
                "/",
                og_image="data:image/png;base64,AAAA",
                twitter_image="javascript:x",
            )

        plan = plan_of({"food": [item("a", url="http://junk.example.com/")]}, wikipedia=None)
        pictures, web, _ = run_find(configure, plan)
        assert pictures == [] and [r.path for r in web.seen("junk.example.com")] == ["/"]


class TestPageCharset:
    """F3: a third party's `charset=` can neither freeze the event loop nor make the slot raise."""

    @pytest.mark.parametrize(
        ("charset", "codec"),
        [
            ("utf-8", "utf-8"),
            ("UTF8", "utf-8"),
            ("us-ascii", "ascii"),
            ("latin-1", "iso8859-1"),
            ("ISO-8859-15", "iso8859-15"),
            ("windows-1252", "cp1252"),
            ("cp1251", "cp1251"),
            ("utf-16", "utf-16"),
            ("UTF-32LE", "utf-32-le"),
            ("shift_jis", "shift_jis"),
            ("euc-kr", "euc_kr"),
            ("gb2312", "gb2312"),
            ("big5", "big5"),
            ("koi8-r", "koi8-r"),
        ],
    )
    def test_real_web_encodings_are_kept(self, charset: str, codec: str) -> None:
        assert web_codec(charset) == codec

    @pytest.mark.parametrize(
        "charset",
        [
            "punycode",  # quadratic to decode: 15.6 s for 1 MB on the audit box
            "idna",  # raises UnicodeError('Unsupported error handling: replace')
            "utf-7",
            "unicode_escape",
            "raw_unicode_escape",
            "rot13",
            "base64",
            "hex",
            "zlib",
            "bz2",
            "uu",
            "quopri",
            "mbcs",
            "oem",
            "undefined",
            "palmos",
            "mac_roman",
            "nope-not-a-codec",
            "utf-8\x00",
            "a" * 100,
            "",
            None,
        ],
    )
    def test_anything_else_is_read_as_utf8(self, charset: str | None) -> None:
        assert web_codec(charset) == "utf-8"

    HEAD = b'<html><head><meta property="og:image" content="/hero.jpg"></head><body>'

    @pytest.mark.parametrize("charset", ["punycode", "idna", "unicode_escape", "utf-7", "nope"])
    def test_a_hostile_charset_on_a_one_megabyte_page_is_fast_and_the_head_still_read(
        self, charset: str
    ) -> None:
        body = self.HEAD + b"-" + b"a" * 1_000_000  # exactly the shape that took punycode 15.6 s
        started = time.monotonic()
        meta = page_meta(body, charset)
        assert time.monotonic() - started < 2.0
        assert meta == {"og:image": "/hero.jpg"}

    def test_only_the_first_200_kb_of_bytes_is_decoded(self) -> None:
        body = (
            b"<html><head>"
            + b" " * (HEAD_SCAN_BYTES + 10)
            + b'<meta property="og:image" content="/late.jpg"></head>'
        )
        assert page_meta(body, "utf-8") == {}
        assert page_meta(self.HEAD + b"x" * 5_000_000, "utf-8") == {"og:image": "/hero.jpg"}

    def test_a_real_non_utf8_page_is_still_read_in_its_charset(self) -> None:
        body = '<head><meta property="og:site_name" content="Café Zürich"></head>'.encode("latin-1")
        assert page_meta(body, "ISO-8859-1") == {"og:site_name": "Café Zürich"}
        assert page_meta(body, "utf-8") == {"og:site_name": "Caf� Z�rich"}

    @pytest.mark.parametrize("charset", ["punycode", "idna"])
    def test_through_the_finder_a_hostile_charset_costs_nothing(self, charset: str) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue(
                "trap.example.com",
                "/",
                og_image="/img/hero.jpg",
                page_content_type=f"text/html; charset={charset}",
                after_html=b"-" + b"a" * 1_000_000,
            )

        plan = plan_of({"stay": [item("a", url="http://trap.example.com/")]}, wikipedia=None)
        started = time.monotonic()
        pictures, _, _ = run_find(configure, plan)
        assert time.monotonic() - started < 5.0
        assert [p.slot for p in pictures] == ["stay:0"]  # the og:image was still found

    def test_no_third_party_text_is_parsed_on_the_event_loop(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: dict[str, int] = {}
        loop_thread: list[int] = []

        def recording(name: str, real: Callable[..., Any]) -> Callable[..., Any]:
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                seen[name] = threading.get_ident()
                return real(*args, **kwargs)

            return wrapper

        for name in ("page_meta", "parse_commons_pages", "plain_text", "_load_json"):
            monkeypatch.setattr(
                adventure_pictures, name, recording(name, getattr(adventure_pictures, name))
            )

        def configure(w: FakeOpenWeb) -> None:
            lead = w.add_file(FakeFile("Kotor Lead.jpg", 4256, 2832, seed=1))
            w.add_article("Kotor", lead, description="City in Coastal Montenegro")
            w.add_venue("v.example.com", "/", og_image="/img/hero.jpg")

        original_find = WebPictureFinder.find

        async def find(self: WebPictureFinder, plan: PicturePlan, **kwargs: Any) -> Any:
            loop_thread.append(threading.get_ident())
            return await original_find(self, plan, **kwargs)

        monkeypatch.setattr(WebPictureFinder, "find", find)
        plan = plan_of({"stay": [item("a", url="http://v.example.com/")]})
        pictures, _, _ = run_find(configure, plan)
        assert pictures
        assert set(seen) == {"page_meta", "parse_commons_pages", "plain_text", "_load_json"}
        assert all(ident != loop_thread[0] for ident in seen.values()), seen


class TestWikimediaOriginals:
    """F5: Wikimedia is only ever asked for API thumbnails, even through a venue's own page."""

    def _original_url(self, w: FakeOpenWeb, file: FakeFile) -> str:
        a, ab = file.hash_dirs
        return f"http://{UPLOAD_HOST}:{w.web.port}/wikipedia/commons/{a}/{ab}/{file.underscored}"

    def test_a_venue_image_tag_naming_an_upload_original_goes_through_the_thumbnail(self) -> None:
        file = FakeFile("Casa Alfama Terrace.jpg", 4000, 2667, seed=5)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(file)
            w.add_venue("casa.example.com", "/", og_image=self._original_url(w, file))

        plan = plan_of({"stay": [item("Casa", url="http://casa.example.com/")]}, wikipedia=None)
        pictures, web, open_web = run_find(configure, plan)
        (pic,) = pictures
        assert pic.slot == "stay:0" and pic.credit == "Jane Doe, CC BY-SA 4.0"
        assert pic.page.endswith("/wiki/File:Casa_Alfama_Terrace.jpg")  # credited as a Commons file
        assert open_web.imageinfo_titles == ["File:Casa Alfama Terrace.jpg"]
        assert web.seen(UPLOAD_HOST) == []  # the ORIGINAL was never requested
        assert all("/thumb/" in r.path for r in web.seen(THUMB_HOST))

    def test_a_wikimedia_address_that_names_no_commons_file_is_skipped(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            local = f"http://{UPLOAD_HOST}:{w.web.port}/wikipedia/en/a/ab/Some_Logo.png"
            static = f"http://{WIKI_HOST}:{w.web.port}/static/images/logo.png"
            w.add_venue("v.example.com", "/", og_image=local, twitter_image=static)

        plan = plan_of({"stay": [item("V", url="http://v.example.com/")]}, wikipedia=None)
        pictures, web, _ = run_find(configure, plan)
        assert pictures == []
        assert web.seen(UPLOAD_HOST) == [] and web.seen(WIKI_HOST) == []

    def test_an_image_that_redirects_onto_wikimedia_is_refused_before_it_is_followed(self) -> None:
        file = FakeFile("Redirected.jpg", 4000, 2667, seed=6)

        def configure(w: FakeOpenWeb) -> None:
            w.add_venue("cdn.example.com", "/", og_image="/img/hero.jpg")
            w.serve(
                "cdn.example.com",
                "/img/hero.jpg",
                Reply(status=302, headers={"Location": self._original_url(w, file)}),
            )
            w.serve(UPLOAD_HOST, f"/wikipedia/commons/x/{file.underscored}", Reply(body=b"orig"))

        plan = plan_of({"stay": [item("V", url="http://cdn.example.com/")]}, wikipedia=None)
        pictures, web, _ = run_find(configure, plan)
        assert pictures == [] and web.seen(UPLOAD_HOST) == []

    def test_a_venue_url_on_wikipedia_is_an_article_not_a_site(self) -> None:
        plan = plan_pictures(
            PackSpec(
                None,
                {
                    "sights": [
                        item("Perast", url="https://en.wikipedia.org/wiki/Perast"),
                        item("Gate", url="https://commons.wikimedia.org/wiki/File:Gate.jpg"),
                        item(
                            "Both",
                            wikipedia="Real Title",
                            url="https://en.wikipedia.org/wiki/Other",
                        ),
                    ]
                },
            ).as_pack(),
            **KOTOR_PLAN_ARGS,
        )
        got = {s.key: (s.wikipedia, s.url) for s in plan.slots}
        assert got["sights:0"] == ("Perast", None)  # the link's title feeds source 1
        assert got["sights:1"] == (None, None) and plan.slots[1].search is True
        assert got["sights:2"] == ("Real Title", None)  # the AI's own title wins

    def test_a_slot_aimed_at_a_wikimedia_page_is_not_fetched_even_if_the_plan_allows_it(
        self,
    ) -> None:
        plan = PicturePlan(
            destination="Kotor",
            unit="Montenegro",
            destination_wikipedia=None,
            slots=(
                PictureSlot("stay:0", "stay", "X", None, f"http://{WIKI_HOST}/wiki/Perast", False),
            ),
        )
        pictures, web, _ = run_find(lambda w: None, plan)
        assert pictures == [] and web.seen(WIKI_HOST) == []  # (only the hero search ran)

    @pytest.mark.parametrize(
        ("host", "expected"),
        [
            ("upload.wikimedia.org", True),
            ("commons.wikimedia.org", True),
            ("wikimedia.org", True),
            ("en.wikipedia.org", True),
            ("EN.Wikipedia.ORG.", True),
            ("wikipedia.org", True),
            ("notwikipedia.org", False),
            ("wikipedia.org.evil.example", False),
            ("example.com", False),
            ("", False),
            (None, False),
        ],
    )
    def test_which_hosts_count_as_wikimedia(self, host: str | None, expected: bool) -> None:
        assert is_wikimedia_host(host) is expected


class TestCommonsSearch:
    def _kotor_files(self, w: FakeOpenWeb) -> None:
        lead = w.add_file(FakeFile("Kotor Lead.jpg", 4256, 2832, seed=1))
        w.add_article("Kotor", lead, description="City in Coastal Montenegro")
        titles = [
            w.add_file(FakeFile("Kotor Lead.jpg", 4256, 2832, seed=1)).title,  # the lead again
            w.add_file(
                FakeFile("Kotor Portrait.jpg", 2000, 3000, served=(1280, 1920), seed=2)
            ).title,
            w.add_file(FakeFile("Kotor Bay A.jpg", 4000, 2667, seed=3)).title,
            w.add_file(FakeFile("Map of Kotor.jpg", 4000, 2667, seed=4)).title,
            w.add_file(FakeFile("Kotor Drawing.png", 4000, 2667, mime="image/png", seed=5)).title,
            w.add_file(FakeFile("Kotor Small.jpg", 1200, 800, served=(1200, 800), seed=6)).title,
            w.add_file(FakeFile("Kotor Bay B.jpg", 4000, 2667, seed=7)).title,
        ]
        w.add_search("Kotor Montenegro", titles)

    def test_the_hero_is_the_lead_plus_good_search_photos_landscape_first(self) -> None:
        pictures, web, open_web = run_find(self._kotor_files, plan_of({}))
        assert [p.slot for p in pictures] == ["hero:0", "hero:1", "hero:2", "hero:3"]
        # Lead first; then the landscape photos in search order; the portrait last. The duplicate of
        # the lead, the map, the PNG and the 1200x800 (short side under 900) are all left out.
        titles = [p.page.rsplit("/", 1)[1] for p in pictures]
        assert titles == [
            "File:Kotor_Lead.jpg",
            "File:Kotor_Bay_A.jpg",
            "File:Kotor_Bay_B.jpg",
            "File:Kotor_Portrait.jpg",
        ]
        assert open_web.search_queries == ["Kotor Montenegro filemime:image/jpeg"]
        assert 1 <= len(pictures) <= HERO_MAX and HERO_TARGET == 5
        assert web.seen(UPLOAD_HOST) == []

    def test_search_photos_carry_their_credit_and_no_caption(self) -> None:
        pictures, _, _ = run_find(self._kotor_files, plan_of({}))
        assert pictures[1].credit == "Jane Doe, CC BY-SA 4.0" and pictures[1].caption is None
        assert pictures[0].caption == "City in Coastal Montenegro"  # the article's description

    def test_without_an_article_the_hero_is_filled_by_the_search_alone(self) -> None:
        pictures, _, _ = run_find(self._kotor_files, plan_of({}, wikipedia=None))
        assert [p.slot for p in pictures] == ["hero:0", "hero:1", "hero:2", "hero:3"]

    def test_a_sight_with_no_article_or_site_is_found_by_a_search_for_it(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            gate = w.add_file(FakeFile("Sea Gate Kotor.jpg", 4000, 2667, seed=11))
            w.add_search("Sea Gate", [gate.title])

        plan = plan_of({"sights": [item("Sea Gate")]}, wikipedia=None)
        pictures, _, open_web = run_find(configure, plan)
        assert "Sea Gate Kotor filemime:image/jpeg" in open_web.search_queries
        assert by_slot(pictures)["sights:0"].page.endswith("File:Sea_Gate_Kotor.jpg")

    def test_a_sight_that_shares_the_destinations_lead_image_gets_its_own_from_a_search(
        self,
    ) -> None:
        """Real Kotor: the town's article and its old-town article have the same lead photo. The
        hero keeps it, and the sight, having lost it, tries its own fallback."""

        def configure(w: FakeOpenWeb) -> None:
            shared = w.add_file(FakeFile("Kotor Shared Lead.jpg", 4256, 2832, seed=1))
            w.add_article("Kotor", shared)
            w.add_article("Old Town of Kotor", shared)
            own = w.add_file(FakeFile("Kotor Old Town Walls.jpg", 4000, 2667, seed=2))
            w.add_search("Old Town", [own.title])

        plan = plan_of({"sights": [item("Old Town", wikipedia="Old Town of Kotor")]})
        pictures, _, open_web = run_find(configure, plan)
        got = by_slot(pictures)
        assert got["hero:0"].page.endswith("File:Kotor_Shared_Lead.jpg")
        assert got["sights:0"].page.endswith("File:Kotor_Old_Town_Walls.jpg")
        assert "Old Town Kotor filemime:image/jpeg" in open_web.search_queries

    def test_a_users_name_loses_its_user_prefix_in_the_credit(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            f = w.add_file(
                FakeFile("Kotor Lead.jpg", 4000, 2667, artist_html='<a href="//u">User:Ggia</a>')
            )
            w.add_article("Kotor", f)

        (hero,) = run_find(configure, plan_of({}))[0]
        assert hero.credit == "Ggia, CC BY-SA 4.0"

    def test_a_non_sight_never_falls_back_to_a_search(self) -> None:
        plan = plan_of({"food": [item("Cevapi", wikipedia="No Such Page")]}, wikipedia=None)
        _, _, open_web = run_find(lambda w: None, plan)
        assert all("Cevapi" not in q for q in open_web.search_queries)


class TestAssembly:
    def test_a_file_used_twice_is_kept_once_in_plan_order(self) -> None:
        shared = FakeFile("Shared.jpg", 3000, 2000, seed=21)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(shared)
            w.add_article("Dish A", shared)
            w.add_article("Dish B", shared)

        plan = plan_of(
            {"food": [item("A", wikipedia="Dish A"), item("B", wikipedia="Dish B")]}, wikipedia=None
        )
        pictures = run_find(configure, plan)[0]
        assert [p.slot for p in pictures] == ["food:0"]

    def test_identical_bytes_from_two_venues_are_kept_once(self) -> None:
        same = make_image(1200, 800, seed=5)

        def configure(w: FakeOpenWeb) -> None:
            w.add_venue("one.example.com", "/", og_image="/img/hero.jpg", image=same)
            w.add_venue("two.example.com", "/", og_image="/img/hero.jpg", image=same)

        plan = plan_of(
            {
                "food": [
                    item("a", url="http://one.example.com/"),
                    item("b", url="http://two.example.com/"),
                ]
            },
            wikipedia=None,
        )
        assert [p.slot for p in run_find(configure, plan)[0]] == ["food:0"]

    def test_at_most_sixteen_pictures_with_the_hero_first(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            lead = w.add_file(FakeFile("Kotor Lead.jpg", 4256, 2832, seed=1))
            w.add_article("Kotor", lead)
            titles = [
                w.add_file(FakeFile(f"Kotor View {i}.jpg", 4000, 2667, seed=30 + i)).title
                for i in range(8)
            ]
            w.add_search("Kotor Montenegro", titles)
            for i in range(20):
                w.add_venue(
                    f"v{i}.example.com",
                    "/",
                    og_image="/img/hero.jpg",
                    image=make_image(1000, 700, seed=100 + i),
                )

        plan = plan_of(
            {
                "food": [item(f"f{i}", url=f"http://v{i}.example.com/") for i in range(6)],
                "stay": [item(f"s{i}", url=f"http://v{6 + i}.example.com/") for i in range(6)],
                "culture": [item(f"c{i}", url=f"http://v{12 + i}.example.com/") for i in range(2)],
            }
        )
        pictures = run_find(configure, plan)[0]
        assert len(pictures) == MAX_PICTURES == 16
        slots = [p.slot for p in pictures]
        assert slots[:HERO_TARGET] == [f"hero:{i}" for i in range(HERO_TARGET)]
        assert all(not s.startswith("hero:") for s in slots[HERO_TARGET:])
        assert len(set(slots)) == 16

    def test_the_hero_is_capped_at_six(self) -> None:
        # The search can supply more than the target, but the loop stops at it.
        def configure(w: FakeOpenWeb) -> None:
            titles = [
                w.add_file(FakeFile(f"Kotor View {i}.jpg", 4000, 2667, seed=50 + i)).title
                for i in range(10)
            ]
            w.add_search("Kotor Montenegro", titles)

        pictures = run_find(configure, plan_of({}, wikipedia=None))[0]
        assert len(pictures) == HERO_TARGET


# -- safety, politeness, budget ------------------------------------------------------------------


class TestSafety:
    def _hostile_resolver(self) -> dict[str, Any]:
        async def resolver(host: str, port: int) -> Sequence[str]:
            return ["10.0.0.5"] if host.startswith("internal") else ["127.0.0.1"]

        return {"resolver": resolver}

    def test_a_page_image_tag_aimed_at_a_private_address_is_never_fetched(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            port = w.web.port
            w.add_venue(
                "trap.example.com",
                "/",
                og_image=f"http://127.0.0.1:{port}/secret.jpg",
                twitter_image=f"http://internal.example.com:{port}/secret.jpg",
            )
            w.serve(
                "internal.example.com",
                "/secret.jpg",
                Reply(body=make_image(900, 900), content_type="image/jpeg"),
            )

        plan = plan_of({"food": [item("a", url="http://trap.example.com/")]}, wikipedia=None)
        pictures, web, _ = run_find(configure, plan, fetcher_options=self._hostile_resolver())
        assert pictures == []
        assert (
            web.seen("internal.example.com") == []
        )  # resolved to 10.0.0.5: refused, no connection
        assert [r.host for r in web.requests if r.host != COMMONS_HOST] == ["trap.example.com"]

    def test_a_site_that_redirects_to_a_private_address_yields_nothing(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            port = w.web.port
            w.serve(
                "bounce.example.com",
                "/",
                Reply(status=302, headers={"Location": f"http://internal.example.com:{port}/meta"}),
            )
            w.serve(
                "internal.example.com", "/meta", Reply(body=b"<html>", content_type="text/html")
            )

        plan = plan_of({"food": [item("a", url="http://bounce.example.com/")]}, wikipedia=None)
        pictures, web, _ = run_find(configure, plan, fetcher_options=self._hostile_resolver())
        assert pictures == [] and web.seen("internal.example.com") == []

    def test_an_image_that_redirects_to_a_private_address_yields_nothing(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            port = w.web.port
            w.add_venue("img.example.com", "/", og_image="/img/hero.jpg")
            w.serve(
                "img.example.com",
                "/img/hero.jpg",
                Reply(
                    status=301, headers={"Location": f"http://internal.example.com:{port}/p.jpg"}
                ),
            )
            w.serve(
                "internal.example.com",
                "/p.jpg",
                Reply(body=make_image(900, 900), content_type="image/jpeg"),
            )

        plan = plan_of({"food": [item("a", url="http://img.example.com/")]}, wikipedia=None)
        pictures, web, _ = run_find(configure, plan, fetcher_options=self._hostile_resolver())
        assert pictures == [] and web.seen("internal.example.com") == []

    def test_a_hostile_commons_thumbnail_host_is_ignored(self) -> None:
        """The API names a thumbnail on a host outside the expected set: the file is skipped."""
        lead = FakeFile("Kotor Lead.jpg", 4256, 2832)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(lead)
            w.add_article("Kotor", lead)

        def hostile(w: FakeOpenWeb) -> None:
            configure(w)
            w._thumb_url = lambda file, requested: (  # type: ignore[method-assign]
                f"http://evil.example.net:{w.web.port}/x.jpg"
            )

        pictures, web, _ = run_find(hostile, plan_of({}))
        assert pictures == [] and web.seen("evil.example.net") == []

    def test_the_image_bytes_are_checked_even_when_the_content_type_says_image(self) -> None:
        liar = FakeFile("Liar.jpg", 4000, 2667, image=b"<html>not an image at all</html>")

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(liar)
            w.add_article("Kotor", liar)

        assert run_find(configure, plan_of({}))[0] == []

    def test_deeply_nested_or_broken_api_json_is_just_no_picture(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.serve(
                WIKI_HOST,
                "/api/rest_v1/page/summary/Kotor",
                Reply(body=b"[" * 400_000, content_type="application/json"),
            )
            w.serve(
                WIKI_HOST,
                "/api/rest_v1/page/summary/Dish",
                Reply(
                    body=b'{"type": "standard", "originalimage": ', content_type="application/json"
                ),
            )

        plan = plan_of({"food": [item("Dish", wikipedia="Dish")]})
        assert run_find(configure, plan)[0] == []


class TestPoliteness:
    def test_wikipedia_is_asked_one_request_at_a_time(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            for i in range(5):
                f = w.add_file(FakeFile(f"Dish {i}.jpg", 3000, 2000, seed=60 + i))
                w.add_article(f"Dish {i}", f)

        plan = plan_of(
            {"food": [item(f"d{i}", wikipedia=f"Dish {i}") for i in range(5)]}, wikipedia=None
        )
        pictures, web, _ = run_find(configure, plan)
        assert len(pictures) == 5
        for host in (WIKI_HOST, COMMONS_HOST, THUMB_HOST):
            assert web.max_in_flight_by_host[host] == 1
        assert web.max_in_flight <= 4
        assert all("wixy" in r.headers["user-agent"].lower() for r in web.requests)

    def test_a_host_that_keeps_saying_429_is_left_alone(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(adventure_pictures, "SLOT_CONCURRENCY", 1)

        def configure(w: FakeOpenWeb) -> None:
            for i in range(8):
                w.serve(
                    WIKI_HOST,
                    f"/api/rest_v1/page/summary/Dish_{i}",
                    Reply(status=429, headers={"Retry-After": "0"}),
                )

        plan = plan_of(
            {"food": [item(f"d{i}", wikipedia=f"Dish {i}") for i in range(8)]}, wikipedia=None
        )
        pictures, web, _ = run_find(configure, plan)
        assert pictures == []
        # Three struck-out attempts (each: the request and its one retry), then the rest skipped.
        assert len(web.seen(WIKI_HOST)) == adventure_pictures.HOST_STRIKES * 2

    def test_the_budget_keeps_what_was_found_and_never_hangs(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue("fast.example.com", "/", og_image="/img/hero.jpg")
            w.serve(
                "slow.example.com",
                "/",
                Reply(body=b"<html></html>", content_type="text/html", delay_s=30.0),
            )

        plan = plan_of(
            {
                "food": [
                    item("a", url="http://fast.example.com/"),
                    item("b", url="http://slow.example.com/"),
                ]
            },
            wikipedia=None,
        )
        started = time.monotonic()
        pictures, _, _ = run_find(configure, plan, budget_s=2.0)
        assert time.monotonic() - started < 10.0
        assert [p.slot for p in pictures] == ["food:0"]

    def test_nothing_is_fetched_once_the_round_no_longer_wants_pictures(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_venue("fast.example.com", "/", og_image="/img/hero.jpg")

        plan = plan_of({"food": [item("a", url="http://fast.example.com/")]})
        pictures, web, _ = run_find(configure, plan, wanted=lambda: False)
        assert pictures == [] and web.requests == []
