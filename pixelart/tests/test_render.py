from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from pixelart.model import parse
from pixelart.render import (
    gif_duration,
    preview_board,
    save_gif,
    save_png,
    save_sheet,
    to_image,
)

from .util import make, rect

TEXT = """\
pxl 1
name r
size 3x2
palette
  .  transparent
  k  #101820
  s  #c08040
  h  #ffffff
end
frame a ms=100
ks.
.hk
frame b ms=135
sk.
h.k
frame c ms=10 like=a shift=1,0
anim go = a b c loop
anim once-go = a b once
anim pp = a b c pingpong
"""


def _px(img: Image.Image, x: int, y: int) -> tuple[int, int, int, int]:
    v = img.getpixel((x, y))
    assert isinstance(v, tuple)
    return (v[0], v[1], v[2], v[3])


def test_to_image_pixel_exact_at_scale() -> None:
    sp = parse(TEXT)
    img = to_image(sp, "a", 4)
    assert img.size == (12, 8) and img.mode == "RGBA"
    expect = [
        [(16, 24, 32, 255), (192, 128, 64, 255), (0, 0, 0, 0)],
        [(0, 0, 0, 0), (255, 255, 255, 255), (16, 24, 32, 255)],
    ]
    for y in range(8):
        for x in range(12):
            assert _px(img, x, y) == expect[y // 4][x // 4]


def test_to_image_by_index_and_errors() -> None:
    sp = parse(TEXT)
    assert to_image(sp, 1, 1).getpixel((0, 0)) == (192, 128, 64, 255)
    with pytest.raises(KeyError):
        to_image(sp, "zz")
    with pytest.raises(KeyError):
        to_image(sp, 9)
    with pytest.raises(ValueError):
        to_image(sp, "a", 0)


def test_save_png_roundtrip(tmp_path: Path) -> None:
    sp = parse(TEXT)
    save_png(sp, "b", tmp_path / "b.png", 2)
    back = Image.open(tmp_path / "b.png").convert("RGBA")
    assert back.size == (6, 4)
    assert _px(back, 0, 0) == (192, 128, 64, 255)
    assert _px(back, 4, 0)[3] == 0


def test_gif_duration_rounding() -> None:
    assert gif_duration(100) == 100
    assert gif_duration(135) == 140  # centisecond rounding
    assert gif_duration(14) == 20  # minimum 2cs
    assert gif_duration(10) == 20


def test_gif_timing_and_transparency_roundtrip(tmp_path: Path) -> None:
    sp = parse(TEXT)
    out = tmp_path / "go.gif"
    save_gif(sp, "go", out, 3)
    im = Image.open(out)
    assert im.n_frames == 3
    assert im.info.get("loop") == 0
    durations: list[int] = []
    frames: list[Image.Image] = []
    for i in range(im.n_frames):
        im.seek(i)
        durations.append(int(im.info["duration"]))
        frames.append(im.convert("RGBA"))
    assert durations == [100, 140, 20]
    for name, f in zip(["a", "b", "c"], frames, strict=True):
        expected = to_image(sp, name, 3)
        assert f.size == expected.size
        for y in range(f.height):
            for x in range(f.width):
                e = _px(expected, x, y)
                g = _px(f, x, y)
                if e[3] == 0:
                    assert g[3] == 0, f"{name} {x},{y} should be transparent, got {g}"
                else:
                    assert g == e, f"{name} {x},{y}: {g} != {e}"


def test_gif_once_has_no_loop_and_pingpong_expands(tmp_path: Path) -> None:
    sp = parse(TEXT)
    save_gif(sp, "once-go", tmp_path / "o.gif", 1)
    assert "loop" not in Image.open(tmp_path / "o.gif").info
    save_gif(sp, "pp", tmp_path / "p.gif", 1)
    assert Image.open(tmp_path / "p.gif").n_frames == 4  # a b c b


def test_gif_unknown_anim(tmp_path: Path) -> None:
    with pytest.raises(KeyError, match="no anim"):
        save_gif(parse(TEXT), "nope", tmp_path / "x.gif")


def test_sheet_png_and_json(tmp_path: Path) -> None:
    sp = parse(TEXT)
    side = save_sheet(sp, tmp_path / "s.png", 2)
    assert side == tmp_path / "s.json"
    doc = json.loads(side.read_text(encoding="utf-8"))
    assert doc["name"] == "r" and doc["w"] == 6 and doc["h"] == 4
    assert doc["frames"] == [
        {"name": "a", "x": 0, "y": 0, "ms": 100},
        {"name": "b", "x": 6, "y": 0, "ms": 135},
        {"name": "c", "x": 12, "y": 0, "ms": 10},
    ]
    assert doc["anims"]["go"] == {"frames": ["a", "b", "c"], "mode": "loop"}
    assert doc["anims"]["once-go"]["mode"] == "once"
    sheet = Image.open(tmp_path / "s.png").convert("RGBA")
    assert sheet.size == (18, 4)
    for i, name in enumerate(["a", "b", "c"]):
        tile = sheet.crop((i * 6, 0, i * 6 + 6, 4))
        assert tile.tobytes() == to_image(sp, name, 2).tobytes()


def test_preview_board_small_sprite() -> None:
    sp = make({"a": rect(8, 8, 1, 1, 6, 6)})
    board = preview_board(sp)
    assert board.mode == "RGBA" and max(board.size) <= 1800
    assert board.height > 100  # frames + strip + palette


def test_preview_board_many_big_frames_stays_within_limit() -> None:
    frames = {f"f{i}": rect(64, 64, i, i, 40 + i, 40 + i) for i in range(10)}
    sp = make(frames)
    for scale in (None, 12, 30):
        assert max(preview_board(sp, scale).size) <= 1800
    huge = make({f"f{i}": rect(200, 200, 5, 5, 150, 150) for i in range(8)})
    assert max(preview_board(huge, 4).size) <= 1800


def test_preview_board_shows_grid_and_onion(tmp_path: Path) -> None:
    sp = make({"a": rect(6, 6, 1, 1, 3, 3), "b": rect(6, 6, 2, 2, 4, 4)})
    board = preview_board(sp, 8)
    raw = board.tobytes()
    colours = {(raw[i], raw[i + 1], raw[i + 2]) for i in range(0, len(raw), 4)}
    assert any(r > 180 and g < 110 and b < 110 for r, g, b in colours)  # onion: previous (red)
    assert any(b > 200 and r < 130 for r, g, b in colours)  # onion: current (blue)
    board.save(tmp_path / "b.png")
    assert (tmp_path / "b.png").stat().st_size > 0
