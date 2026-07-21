"""Page-thumbnail store (decisions/00078): small JPEG previews of each page's
MOBILE rendering, shown in the admin Pages panel.

Thumbnails are DERIVED artifacts — re-capturable from the preview renderer at
any time — so they live OUTSIDE the site repo in `Storage/projects/<slug>/
thumbnails/<page>.jpg` (never content, never published). The server is a dumb
validated store: the admin client captures (it already renders the preview in
an iframe; a browser engine on the server would be a heavy deployment
dependency, and the independence standalone target must stay free of one) and
PUTs JPEGs here.

Uploads are validated like media uploads (spec/02 §9's posture): size cap,
then Pillow must actually read the bytes, and the stored file is a FRESH
re-encode — never the client's bytes verbatim.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

from PIL import Image

MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
_JPEG_QUALITY = 80


class ThumbnailError(Exception):
    """The upload isn't a usable JPEG (too big, unreadable)."""


def thumbnail_path(root: Path, slug: str) -> Path:
    return root / f"{slug}.jpg"


def load_thumbnail(root: Path, slug: str) -> bytes | None:
    path = thumbnail_path(root, slug)
    if not path.exists():
        return None
    return path.read_bytes()


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Tmp+rename, mirroring builder.content.atomic_write_json's convention."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def save_thumbnail(root: Path, slug: str, data: bytes) -> None:
    if len(data) > MAX_THUMBNAIL_BYTES:
        limit_mb = MAX_THUMBNAIL_BYTES // (1024 * 1024)
        raise ThumbnailError(f"thumbnail exceeds the {limit_mb}MB limit")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:
        raise ThumbnailError(f"not a readable image: {exc}") from None
    root.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
    _atomic_write_bytes(thumbnail_path(root, slug), buffer.getvalue())
