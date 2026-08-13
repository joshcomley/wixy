"""Stdlib-only image pixel-dimension sniffing (no Pillow) — `builder/` ships Pillow as a
core dependency for the parity harness's screenshot diff (config.py), but the *build*
path itself stays Pillow-free by policy (the site repo's CI installs just this package);
see decisions/00134.

Supports JPEG, PNG, GIF, and WebP (VP8/VP8L/VP8X). Dims are the file's *stored* pixel
dimensions — EXIF orientation is never applied (decisions/00134's accepted limitation).
Every image the upload pipeline produces is re-encoded by Pillow anyway (orientation
already baked into the stored dimensions); a hand-placed legacy image carrying rotation
metadata could at worst get width/height swapped in the emitted `og:image:width/height`
hint, which crawlers tolerate.
"""

from __future__ import annotations

import struct
from pathlib import Path

_JPEG_SOF_MARKERS = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_WEBP_VP8_START_CODE = b"\x9d\x01\x2a"


def is_safe_relative_src(src: str) -> bool:
    """Whether `src` is safe to join onto a `site_root` for an on-disk dimension sniff —
    repo-relative, no leading `/` or `\\`, no drive letter (`C:`), no `..` segment (either
    slash direction). A `/`-prefixed, drive-rooted, or path-traversing src still gets its
    (unmodified) rendered tag/attribute; this only gates a WIDTH/HEIGHT sniff, which has to
    touch the filesystem — and `Path.joinpath` treats an absolute-looking right-hand segment
    (a leading slash, or a Windows drive letter) as REPLACING `site_root` entirely rather than
    joining under it, so those must be rejected explicitly, not just `..`. Shared by
    `templates.py` (og:image dims, decisions/00134) and `bindings.py` (data-wx-img dims,
    decisions/00140) — one gate, not a driftable copy per caller (decisions/00012's own
    precedent)."""
    if src.startswith(("/", "\\")) or ":" in src:
        return False
    return ".." not in src.replace("\\", "/").split("/")


def probe_image_size(path: Path) -> tuple[int, int] | None:
    """Return `(width, height)` in pixels, or `None` if the file is missing, unreadable,
    an unrecognized format, or its header is truncated/malformed. Never raises — a build
    must never fail because a dimension sniff failed."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    try:
        dims = _probe_jpeg(data) or _probe_png(data) or _probe_gif(data) or _probe_webp(data)
    except struct.error, IndexError, ValueError:
        return None
    if dims is None:
        return None
    width, height = dims
    return dims if width > 0 and height > 0 else None


def _probe_jpeg(data: bytes) -> tuple[int, int] | None:
    if len(data) < 4 or data[0:2] != b"\xff\xd8":
        return None
    length = len(data)
    offset = 2
    while offset < length:
        if data[offset] != 0xFF:
            return None
        # A marker may be preceded by 0xFF fill bytes (rare, but legal).
        while offset < length and data[offset] == 0xFF:
            offset += 1
        if offset >= length:
            return None
        marker = data[offset]
        offset += 1
        if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
            continue  # no-payload markers (SOI/EOI/TEM/restart)
        if marker == 0xDA:
            return None  # start of scan — no SOF marker appeared before it
        if offset + 2 > length:
            return None
        segment_length = struct.unpack(">H", data[offset : offset + 2])[0]
        if segment_length < 2:
            return None
        if marker in _JPEG_SOF_MARKERS:
            if offset + 7 > length:
                return None
            height, width = struct.unpack(">HH", data[offset + 3 : offset + 7])
            return (width, height)
        offset += segment_length
    return None


def _probe_png(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(_PNG_SIGNATURE) or len(data) < 24 or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return (width, height)


def _probe_gif(data: bytes) -> tuple[int, int] | None:
    if not (data.startswith(b"GIF87a") or data.startswith(b"GIF89a")) or len(data) < 10:
        return None
    width, height = struct.unpack("<HH", data[6:10])
    return (width, height)


def _probe_webp(data: bytes) -> tuple[int, int] | None:
    if len(data) < 20 or data[0:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    fourcc = data[12:16]
    payload = data[20:]

    if fourcc == b"VP8 ":
        if len(payload) < 10 or payload[3:6] != _WEBP_VP8_START_CODE:
            return None
        width_field, height_field = struct.unpack("<HH", payload[6:10])
        return (width_field & 0x3FFF, height_field & 0x3FFF)

    if fourcc == b"VP8L":
        if len(payload) < 5 or payload[0] != 0x2F:
            return None
        bits = struct.unpack("<I", payload[1:5])[0]
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
        return (width, height)

    if fourcc == b"VP8X":
        if len(payload) < 10:
            return None
        width = int.from_bytes(payload[4:7], "little") + 1
        height = int.from_bytes(payload[7:10], "little") + 1
        return (width, height)

    return None
