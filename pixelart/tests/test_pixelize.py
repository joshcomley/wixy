from __future__ import annotations

import random
from collections import Counter

import pytest
from PIL import Image

from pixelart.model import resolve_frames
from pixelart.pixelize import detect_grid, kmeans_oklab, pixelize
from pixelart.render import to_image

from .util import make

ART = [
    "..kkkk..",
    ".kssssk.",
    "kslllssk",
    "ksllhssk",
    "ksssssdk",
    ".kddddk.",
    "..k..k..",
    "..kk.kk.",
]


def _rgba_grid(sprite_img: Image.Image) -> list[tuple[int, int, int, int]]:
    raw = sprite_img.tobytes()
    return [tuple(raw[i : i + 4]) for i in range(0, len(raw), 4)]  # type: ignore[misc]


def test_recovers_known_upscaled_sprite_exactly_with_size() -> None:
    src = make({"main": ART})
    big = to_image(src, "main", 8)
    out = pixelize(big, size=(8, 8))
    assert (out.w, out.h) == (8, 8)
    assert _rgba_grid(to_image(out, "main", 1)) == _rgba_grid(to_image(src, "main", 1))


@pytest.mark.parametrize("scale", [2, 5, 8, 13])
def test_auto_detects_grid_and_recovers_exactly(scale: int) -> None:
    src = make({"main": ART})
    big = to_image(src, "main", scale)
    grid = detect_grid(big)
    assert grid is not None and grid.cell_w == scale
    out = pixelize(big)
    assert (out.w, out.h) == (8, 8)
    assert _rgba_grid(to_image(out, "main", 1)) == _rgba_grid(to_image(src, "main", 1))
    assert len(out.palette.opaque_keys()) == len({c for row in ART for c in row} - {"."})


def test_opaque_background_is_keyed_out_from_corners() -> None:
    src = make({"main": ART})
    big = to_image(src, "main", 6)
    bg = Image.new("RGBA", big.size, (255, 0, 255, 255))
    bg.alpha_composite(big)
    out = pixelize(bg)
    # the magenta (including the pocket between the legs) is gone: pixel-exact match
    assert _rgba_grid(to_image(out, "main", 1)) == _rgba_grid(to_image(src, "main", 1))


def test_no_bg_flag_keeps_background() -> None:
    src = make({"main": ART})
    big = to_image(src, "main", 4)
    bg = Image.new("RGBA", big.size, (255, 0, 255, 255))
    bg.alpha_composite(big)
    out = pixelize(bg, key_bg=False)
    assert all("." not in row for row in resolve_frames(out)["main"])


def test_alpha_background_is_transparent() -> None:
    src = make({"main": ART})
    out = pixelize(to_image(src, "main", 7))
    assert resolve_frames(out)["main"][0].startswith("..")


def test_dominant_colour_not_mean() -> None:
    img = Image.new("RGBA", (16, 16), (200, 0, 0, 255))
    # corrupt cell edges and a minority of pixels in cell (0,0) and (1,1)
    for x in range(8):
        img.putpixel((x, 0), (0, 0, 200, 255))
    for y in range(8, 16):
        img.putpixel((8, y), (0, 200, 0, 255))
    out = pixelize(img, size=(2, 2), key_bg=False)
    colours = {e.rgb for e in out.palette.entries.values() if e.rgb}
    assert colours == {(200, 0, 0)}  # a mean would have invented a purple/brown


def test_quantise_to_palette_file() -> None:
    img = Image.new("RGBA", (4, 4), (250, 10, 10, 255))
    img.putpixel((0, 0), (10, 10, 240, 255))
    pal = [(255, 0, 0), (0, 0, 255), (0, 255, 0)]
    out = pixelize(img, size=(4, 4), palette=pal, key_bg=False)
    assert {e.rgb for e in out.palette.entries.values() if e.rgb} == {(255, 0, 0), (0, 0, 255)}


def test_kmeans_is_deterministic_and_reduces() -> None:
    rng = random.Random(7)
    cols: Counter[tuple[int, int, int]] = Counter()
    for base in [(200, 30, 30), (30, 200, 30), (30, 30, 200)]:
        for _ in range(8):
            cols[
                (base[0] + rng.randrange(8), base[1] + rng.randrange(8), base[2] + rng.randrange(8))
            ] += 3
    a = kmeans_oklab(cols, 3)
    assert a == kmeans_oklab(cols, 3)
    assert len(a) == 3
    img = Image.new("RGBA", (24, 1))
    for i, c in enumerate(sorted(cols)):
        img.putpixel((i, 0), (*c, 255))
    sp1 = pixelize(img, size=(24, 1), colors=3, key_bg=False)
    sp2 = pixelize(img, size=(24, 1), colors=3, key_bg=False)
    assert len(sp1.palette.opaque_keys()) <= 3
    assert resolve_frames(sp1) == resolve_frames(sp2)


def test_undetectable_grid_asks_for_size() -> None:
    rng = random.Random(3)
    img = Image.new("RGBA", (40, 40))
    for y in range(40):
        for x in range(40):
            img.putpixel((x, y), (rng.randrange(256), rng.randrange(256), rng.randrange(256), 255))
    assert detect_grid(img) is None
    with pytest.raises(ValueError, match="--size"):
        pixelize(img)


def test_emitted_text_parses_back() -> None:
    from pixelart.model import dump, parse

    src = make({"main": ART})
    out = pixelize(to_image(src, "main", 3), name="My Sprite!")
    assert out.name == "my-sprite"
    again = parse(dump(out))
    assert resolve_frames(again) == resolve_frames(out)
