"""The bundled Fry squint GIF behind the server chat's More → Fry item (decisions/00180).

The admin UI fetches it from `FRY_GIF_URL` (`admin-ui/src/server/gifLink.ts`) and uploads it
as an ordinary photo, so it must exist where that URL points, stay within the photo upload
cap, and come out of processing as a still-animated GIF."""

from __future__ import annotations

import re
from pathlib import Path

from PIL import Image

from wixy_server.livechat.processing import process_photo
from wixy_server.livechat.uploads import MAX_UPLOAD_BYTES

_REPO = Path(__file__).resolve().parents[2]
_STATIC = _REPO / "wixy_server" / "static"
_GIF_LINK_TS = _REPO / "admin-ui" / "src" / "server" / "gifLink.ts"


def _fry_path() -> Path:
    source = _GIF_LINK_TS.read_text(encoding="utf-8")
    match = re.search(r'FRY_GIF_URL = "/admin/static/([^"]+)"', source)
    assert match is not None, "FRY_GIF_URL must point under /admin/static/"
    return _STATIC / match.group(1)


def test_fry_gif_is_where_the_admin_ui_fetches_it() -> None:
    path = _fry_path()
    assert path.is_file()
    assert path.read_bytes()[:6] == b"GIF89a"
    assert path.stat().st_size <= MAX_UPLOAD_BYTES["photo"]


def test_fry_gif_survives_processing_as_an_animated_gif(tmp_path: Path) -> None:
    result = process_photo(_fry_path(), output_dir=tmp_path)
    assert result.mime == "image/gif"
    full = result.renditions["full"]
    assert full.name == "full.gif"
    with Image.open(full) as image:
        assert getattr(image, "is_animated", False) is True
