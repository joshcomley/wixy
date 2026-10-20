from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from PIL import Image

from pixelart.compose import (
    BAYER4,
    Key,
    dither_visible,
    interpolate,
    load_scene,
    render_scene,
    render_tick,
    round_half_up,
    save_scene_gif,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _scene_dir(tmp_path: Path, **overrides: object) -> Path:
    shutil.copy(FIXTURES / "dot.pxl", tmp_path / "dot.pxl")
    doc = json.loads((FIXTURES / "scene.json").read_text(encoding="utf-8"))
    doc.update(overrides)
    p = tmp_path / "scene.json"
    p.write_text(json.dumps(doc), encoding="utf-8")
    return p


def _opaque_cells(img: Image.Image, bg: tuple[int, int, int]) -> set[tuple[int, int]]:
    rgb = img.convert("RGB")
    return {
        (x, y) for y in range(rgb.height) for x in range(rgb.width) if rgb.getpixel((x, y)) != bg
    }


def test_bayer_matrix_is_a_permutation_of_0_15() -> None:
    assert sorted(v for row in BAYER4 for v in row) == list(range(16))


def test_dither_counts_per_opacity_step() -> None:
    for step in range(17):
        opacity = step / 16
        shown = sum(dither_visible(x, y, opacity) for y in range(4) for x in range(4))
        assert shown == step


def test_dither_is_nested_as_opacity_grows() -> None:
    prev: set[tuple[int, int]] = set()
    for step in range(17):
        cur = {(x, y) for y in range(4) for x in range(4) if dither_visible(x, y, step / 16)}
        assert prev <= cur
        prev = cur


def test_dither_pattern_is_anchored_to_canvas_not_sprite() -> None:
    assert dither_visible(5, 6, 0.5) == dither_visible(1, 2, 0.5)  # period 4 in both axes


def test_rounding_and_interpolation() -> None:
    keys = [Key(0, 0, 0, 0.0), Key(4, 3, 8, 1.0)]
    assert interpolate(keys, -5) == (0, 0, 0.0)
    assert interpolate(keys, 99) == (3, 8, 1.0)
    assert interpolate(keys, 2) == pytest.approx((1.5, 4.0, 0.5))
    assert [round_half_up(v) for v in (0.5, 1.5, 2.25, 2.5, -0.5)] == [1, 2, 2, 3, 0]


def test_scene_opacity_steps_through_dither(tmp_path: Path) -> None:
    p = _scene_dir(
        tmp_path,
        width=4,
        height=4,
        scale=1,
        ticks=5,
        layers=[
            {
                "sprite": "dot.pxl",
                "frame": "a",
                "keyframes": [
                    {"t": 0, "x": 0, "y": 0, "opacity": 0.0},
                    {"t": 4, "x": 0, "y": 0, "opacity": 1.0},
                ],
            }
        ],
    )
    scene = load_scene(p)
    bg = (0x10, 0x10, 0x20)
    counts = [len(_opaque_cells(img, bg)) for img in render_scene(scene)]
    assert counts == [0, 4, 8, 12, 16]  # stepped ordered dither, never alpha-blended
    img = render_tick(scene, 2)
    colours = {img.convert("RGB").getpixel((x, y)) for x in range(4) for y in range(4)}
    assert colours == {bg, (255, 0, 0)}  # only exact palette/background colours, no blends


def test_scene_positions_are_rounded_to_whole_pixels(tmp_path: Path) -> None:
    p = _scene_dir(
        tmp_path,
        width=8,
        height=4,
        scale=1,
        ticks=5,
        layers=[
            {
                "sprite": "dot.pxl",
                "frame": "a",
                "keyframes": [{"t": 0, "x": 0, "y": 0}, {"t": 4, "x": 3, "y": 0}],
            }
        ],
    )
    scene = load_scene(p)
    bg = (0x10, 0x10, 0x20)
    lefts = []
    for img in render_scene(scene):
        cells = _opaque_cells(img, bg)
        lefts.append(min(x for x, _ in cells))
        assert max(x for x, _ in cells) - min(x for x, _ in cells) == 3  # sprite stays 4 wide
    assert lefts == [0, 1, 2, 2, 3]  # 0, .75, 1.5, 2.25, 3 rounded half up


def test_layer_anim_follows_ticks_and_draw_order(tmp_path: Path) -> None:
    p = _scene_dir(
        tmp_path,
        width=4,
        height=4,
        scale=1,
        ticks=4,
        layers=[
            {"sprite": "dot.pxl", "anim": "blink", "x": 0, "y": 0},
            {"sprite": "dot.pxl", "frame": "b", "x": 0, "y": 0, "opacity": 0.25},
        ],
    )
    imgs = render_scene(load_scene(p))
    # tick 0: red frame, then 4/16 of the topmost blue layer drawn over it
    px = [imgs[0].convert("RGB").getpixel((x, y)) for y in range(4) for x in range(4)]
    assert px.count((0, 0, 255)) == 4 and px.count((255, 0, 0)) == 12
    # tick 1: anim is on blue; the top layer is blue too
    assert {imgs[1].convert("RGB").getpixel((x, y)) for x in range(4) for y in range(4)} == {
        (0, 0, 255)
    }
    # tick 2 loops back to red
    assert imgs[2].convert("RGB").getpixel((0, 0)) in {(255, 0, 0), (0, 0, 255)}
    assert imgs[0].tobytes() == imgs[2].tobytes()


def test_save_scene_gif_roundtrip(tmp_path: Path) -> None:
    scene = load_scene(_scene_dir(tmp_path))
    out = tmp_path / "out.gif"
    save_scene_gif(scene, out)
    im = Image.open(out)
    assert im.size == (32, 16) and im.n_frames == 5 and im.info["loop"] == 0
    for i in range(im.n_frames):
        im.seek(i)
        assert im.info["duration"] == 100
    im.seek(4)
    assert im.convert("RGB").getpixel((0, 0)) == (0x10, 0x10, 0x20)


def test_scene_transparent_background_and_once(tmp_path: Path) -> None:
    p = _scene_dir(tmp_path, background="transparent", loop=False, scale=1, width=4, height=4)
    scene = load_scene(p)
    out = tmp_path / "t.gif"
    save_scene_gif(scene, out)
    im = Image.open(out)
    assert "loop" not in im.info
    im.seek(0)
    assert im.convert("RGBA").getpixel((3, 3))[3] == 0


@pytest.mark.parametrize(
    "change,match",
    [
        ({"width": 0}, "width"),
        ({"layers": []}, "layers"),
        ({"ticks": 1.5}, "ticks"),
        ({"layers": [{"sprite": "dot.pxl"}]}, "exactly one of"),
        ({"layers": [{"sprite": "dot.pxl", "anim": "nope"}]}, "no anim"),
        ({"layers": [{"sprite": "dot.pxl", "frame": "zz"}]}, "no frame"),
        ({"layers": [{"sprite": "missing.pxl", "frame": "a"}]}, "cannot read"),
        ({"layers": [{"sprite": "dot.pxl", "frame": "a", "opacity": 2}]}, "opacity"),
        ({"layers": [{"frame": "a"}]}, "sprite"),
    ],
)
def test_scene_errors(tmp_path: Path, change: dict[str, object], match: str) -> None:
    with pytest.raises(ValueError, match=match):
        load_scene(_scene_dir(tmp_path, **change))


def test_scene_invalid_json(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text("{nope", encoding="utf-8")
    with pytest.raises(ValueError, match="invalid JSON"):
        load_scene(p)
