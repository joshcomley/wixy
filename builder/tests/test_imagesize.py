"""Tests for `builder/imagesize.py`'s stdlib-only image dimension sniffer
(decisions/00134). Every success case below is built from hand-crafted, minimal
bytes for its format — verified independently against Pillow while authoring this
module (real JPEG/WebP output byte-for-byte matched `probe_image_size`), so these
crafted fixtures pin the exact header layout without adding a Pillow dependency to
the test itself.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

from builder.imagesize import probe_image_size

FIXTURES_DIR = Path(__file__).parent / "fixtures"
MINI_SITE_IMAGES = FIXTURES_DIR / "mini-site" / "images"


def _png_bytes(width: int, height: int) -> bytes:
    signature = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data)
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    return signature + chunk(b"IHDR", ihdr_data) + chunk(b"IEND", b"")


def _gif_bytes(width: int, height: int) -> bytes:
    return b"GIF89a" + struct.pack("<HH", width, height) + b"\x00\x00\x00"


def _jpeg_sof_segment(width: int, height: int, sof_marker: int) -> bytes:
    component = bytes([1, 0x11, 0])  # id=1, sampling=1x1, quant table=0
    payload = struct.pack(">BHHB", 8, height, width, 1) + component
    return bytes([0xFF, sof_marker]) + struct.pack(">H", len(payload) + 2) + payload


def _jpeg_bytes(width: int, height: int, sof_marker: int = 0xC0) -> bytes:
    """SOI, a throwaway APP0 (JFIF) segment — exercising the "skip a non-SOF
    segment via its length, keep walking" path every real encoder's output takes
    — then one SOF segment carrying the dimensions, then EOI. No real scan data
    (this sniffer never decodes pixels, only headers)."""
    app0_payload = b"JFIF\x00" + bytes([1, 1, 0]) + struct.pack(">HH", 1, 1) + bytes([0, 0])
    app0 = b"\xff\xe0" + struct.pack(">H", len(app0_payload) + 2) + app0_payload
    sof = _jpeg_sof_segment(width, height, sof_marker)
    return b"\xff\xd8" + app0 + sof + b"\xff\xd9"


def _jpeg_bytes_with_dht_before_sof(width: int, height: int) -> bytes:
    """0xC4 (DHT) sits inside the SOF marker byte range (0xC0-0xCF) but must be
    excluded — a naive range check would misread its payload as dimensions."""
    dht_payload = b"\x00" * 20  # arbitrary — never interpreted as dimensions
    dht = b"\xff\xc4" + struct.pack(">H", len(dht_payload) + 2) + dht_payload
    sof = _jpeg_sof_segment(width, height, 0xC0)
    return b"\xff\xd8" + dht + sof + b"\xff\xd9"


def _riff_webp(fourcc: bytes, payload: bytes) -> bytes:
    chunk = fourcc + struct.pack("<I", len(payload)) + payload
    body = b"WEBP" + chunk
    return b"RIFF" + struct.pack("<I", len(body)) + body


def _webp_lossy_bytes(width: int, height: int) -> bytes:
    frame_tag = b"\x00\x00\x00"  # unused by the sniffer (key_frame/version/show_frame bits)
    start_code = b"\x9d\x01\x2a"
    dims = struct.pack("<HH", width, height)
    return _riff_webp(b"VP8 ", frame_tag + start_code + dims)


def _webp_lossless_bytes(width: int, height: int) -> bytes:
    bits = ((width - 1) & 0x3FFF) | (((height - 1) & 0x3FFF) << 14)
    payload = bytes([0x2F]) + struct.pack("<I", bits)
    return _riff_webp(b"VP8L", payload)


def _webp_extended_bytes(width: int, height: int) -> bytes:
    flags = b"\x00\x00\x00\x00"
    dims = (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
    return _riff_webp(b"VP8X", flags + dims)


class TestJpeg:
    def test_baseline_sof0(self, tmp_path: Path) -> None:
        path = tmp_path / "x.jpg"
        path.write_bytes(_jpeg_bytes(321, 117))
        assert probe_image_size(path) == (321, 117)

    def test_progressive_sof2(self, tmp_path: Path) -> None:
        path = tmp_path / "x.jpg"
        path.write_bytes(_jpeg_bytes(200, 100, sof_marker=0xC2))
        assert probe_image_size(path) == (200, 100)

    def test_dht_marker_excluded_from_sof_range(self, tmp_path: Path) -> None:
        path = tmp_path / "x.jpg"
        path.write_bytes(_jpeg_bytes_with_dht_before_sof(64, 32))
        assert probe_image_size(path) == (64, 32)

    def test_truncated_after_soi(self, tmp_path: Path) -> None:
        path = tmp_path / "x.jpg"
        path.write_bytes(b"\xff\xd8\xff")
        assert probe_image_size(path) is None

    def test_truncated_mid_sof_payload(self, tmp_path: Path) -> None:
        full = _jpeg_bytes(321, 117)
        path = tmp_path / "x.jpg"
        path.write_bytes(full[:12])  # cuts off inside the SOF0 payload
        assert probe_image_size(path) is None

    def test_scan_marker_before_any_sof(self, tmp_path: Path) -> None:
        """A malformed/atypical JPEG whose first real marker is SOS (0xDA) — no
        SOF appeared, so there's nothing to report."""
        path = tmp_path / "x.jpg"
        path.write_bytes(b"\xff\xd8\xff\xda\x00\x02")
        assert probe_image_size(path) is None


class TestPng:
    def test_valid_ihdr(self, tmp_path: Path) -> None:
        path = tmp_path / "x.png"
        path.write_bytes(_png_bytes(300, 150))
        assert probe_image_size(path) == (300, 150)

    def test_signature_only_no_ihdr(self, tmp_path: Path) -> None:
        path = tmp_path / "x.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\n")
        assert probe_image_size(path) is None

    def test_wrong_signature(self, tmp_path: Path) -> None:
        path = tmp_path / "x.png"
        path.write_bytes(b"not a png at all, just text pretending to be one")
        assert probe_image_size(path) is None


class TestGif:
    def test_gif89a(self, tmp_path: Path) -> None:
        path = tmp_path / "x.gif"
        path.write_bytes(_gif_bytes(64, 48))
        assert probe_image_size(path) == (64, 48)

    def test_gif87a(self, tmp_path: Path) -> None:
        path = tmp_path / "x.gif"
        path.write_bytes(b"GIF87a" + struct.pack("<HH", 10, 20) + b"\x00\x00\x00")
        assert probe_image_size(path) == (10, 20)

    def test_zero_dimensions_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "x.gif"
        path.write_bytes(_gif_bytes(0, 0))
        assert probe_image_size(path) is None

    def test_truncated_header(self, tmp_path: Path) -> None:
        path = tmp_path / "x.gif"
        path.write_bytes(b"GIF89a\x10\x00")  # only 2 of the 4 dimension bytes
        assert probe_image_size(path) is None


class TestWebp:
    def test_vp8_lossy(self, tmp_path: Path) -> None:
        path = tmp_path / "x.webp"
        path.write_bytes(_webp_lossy_bytes(37, 91))
        assert probe_image_size(path) == (37, 91)

    def test_vp8l_lossless(self, tmp_path: Path) -> None:
        path = tmp_path / "x.webp"
        path.write_bytes(_webp_lossless_bytes(37, 91))
        assert probe_image_size(path) == (37, 91)

    def test_vp8x_extended(self, tmp_path: Path) -> None:
        path = tmp_path / "x.webp"
        path.write_bytes(_webp_extended_bytes(55, 23))
        assert probe_image_size(path) == (55, 23)

    def test_bad_riff_fourcc(self, tmp_path: Path) -> None:
        path = tmp_path / "x.webp"
        path.write_bytes(b"RIFF" + struct.pack("<I", 20) + b"AVI " + b"\x00" * 20)
        assert probe_image_size(path) is None

    def test_unrecognized_webp_subtype(self, tmp_path: Path) -> None:
        path = tmp_path / "x.webp"
        path.write_bytes(_riff_webp(b"ANIM", b"\x00" * 16))
        assert probe_image_size(path) is None

    def test_truncated_vp8_start_code(self, tmp_path: Path) -> None:
        path = tmp_path / "x.webp"
        path.write_bytes(_riff_webp(b"VP8 ", b"\x00\x00\x00\x9d\x01"))  # cut mid start-code
        assert probe_image_size(path) is None


class TestGeneral:
    def test_missing_file(self, tmp_path: Path) -> None:
        assert probe_image_size(tmp_path / "does-not-exist.jpg") is None

    def test_directory_path_never_raises(self, tmp_path: Path) -> None:
        assert probe_image_size(tmp_path) is None

    def test_empty_file(self, tmp_path: Path) -> None:
        path = tmp_path / "empty"
        path.write_bytes(b"")
        assert probe_image_size(path) is None

    def test_real_fixture_images_are_placeholders_not_real_images(self) -> None:
        """`builder/tests/fixtures/mini-site/images/{hero,icon}.jpg` are 11-byte
        ASCII placeholders (the literal text `"placeholder"`) — they always have
        been, since the very first builder commit; nothing else in the suite
        decodes their bytes (parity screenshots the rendered page, never this
        file). They're genuine "non-image bytes on a real repo path" fixtures for
        the sniffer's most realistic failure mode."""
        assert MINI_SITE_IMAGES.joinpath("hero.jpg").read_bytes() == b"placeholder"
        assert probe_image_size(MINI_SITE_IMAGES / "hero.jpg") is None
        assert probe_image_size(MINI_SITE_IMAGES / "icon.jpg") is None
