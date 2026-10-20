"""Rendering: PNG, animated GIF, sprite sheet (+JSON) and the preview board."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

from .model import Sprite, anim_sequence, resolve_frames

BOARD_MAX = 1800


def _frame_rgba_1x(sprite: Sprite, grid: list[str]) -> Image.Image:
    lut = {k: sprite.palette.rgba(k) for k in sprite.palette.entries}
    data = bytearray()
    for row in grid:
        for ch in row:
            data.extend(lut[ch])
    return Image.frombytes("RGBA", (sprite.w, sprite.h), bytes(data))


def _grid_of(sprite: Sprite, frame: str | int) -> list[str]:
    grids = resolve_frames(sprite)
    if isinstance(frame, int):
        names = list(grids)
        if not 0 <= frame < len(names):
            raise KeyError(f"frame index {frame} out of range 0..{len(names) - 1}")
        return grids[names[frame]]
    if frame not in grids:
        raise KeyError(f"no frame {frame!r} (have: {', '.join(grids)})")
    return grids[frame]


def _check_scale(scale: int) -> None:
    if scale < 1:
        raise ValueError("scale must be an integer >= 1")


def to_image(sprite: Sprite, frame: str | int, scale: int = 1) -> Image.Image:
    """One frame as an RGBA image, nearest-neighbour scaled by an integer."""
    _check_scale(scale)
    img = _frame_rgba_1x(sprite, _grid_of(sprite, frame))
    if scale != 1:
        img = img.resize((sprite.w * scale, sprite.h * scale), Image.Resampling.NEAREST)
    return img


def save_png(sprite: Sprite, frame: str | int, path: str | Path, scale: int = 1) -> None:
    to_image(sprite, frame, scale).save(path, format="PNG")


def gif_duration(ms: int) -> int:
    """GIF stores centiseconds: round, minimum 2 (20 ms). Returns milliseconds."""
    return max(2, round(ms / 10)) * 10


def save_gif_images(
    images: Sequence[Image.Image],
    durations_ms: Sequence[int],
    path: str | Path,
    loop: bool = True,
) -> None:
    """Write RGBA images as a GIF with a shared palette and binary transparency."""
    if not images:
        raise ValueError("no frames to write")
    size = images[0].size
    rgbas: list[Image.Image] = []
    colours: dict[tuple[int, int, int], int] = {}
    has_transparent = False
    for im in images:
        if im.size != size:
            raise ValueError("all GIF frames must be the same size")
        rgba = im.convert("RGBA")
        rgbas.append(rgba)
        # getcolors() is a C-side histogram: far cheaper than a per-pixel Python scan
        for _count, px in rgba.getcolors(size[0] * size[1]) or []:
            assert isinstance(px, tuple)
            r, g, b, a = px
            if a < 128:
                has_transparent = True
            elif (r, g, b) not in colours:
                colours[(r, g, b)] = len(colours)
    offset = 1 if has_transparent else 0
    if len(colours) + offset > 256:
        raise ValueError("more than 255 colours; GIF cannot hold this animation exactly")
    # The transparent slot and the unused tail of the 256-entry palette get a colour that
    # is not in the image, so quantize()'s exact matches can never land on them.
    # A spare slot is only needed when fewer than 256 entries are real colours, and then
    # some grey is always free.
    spare = next(((v, v, v) for v in range(256) if (v, v, v) not in colours), (0, 0, 0))
    entries = ([spare] if has_transparent else []) + list(colours)
    entries += [spare] * (256 - len(entries))
    palimg = Image.new("P", (1, 1))
    palimg.putpalette([c for rgb in entries for c in rgb])
    frames: list[Image.Image] = []
    for rgba in rgbas:
        rgb = rgba.convert("RGB")
        # quantize() is a fast C-side mapping, but its colour cache is approximate: two
        # near-identical palette colours can swap. Verify against the source and repair the
        # few mismatched pixels exactly, so the palette lock holds.
        p = rgb.quantize(palette=palimg, dither=Image.Dither.NONE)
        _repair_exact(p, rgb, colours, offset)
        if has_transparent:
            clear = rgba.getchannel("A").point(lambda a: 255 if a < 128 else 0)
            p.paste(0, mask=clear)
        frames.append(p)
    kwargs: dict[str, object] = {
        "save_all": True,
        "append_images": frames[1:],
        "duration": [gif_duration(d) for d in durations_ms],
        "disposal": 2,
        "optimize": False,
    }
    if has_transparent:
        kwargs["transparency"] = 0
    if loop:
        kwargs["loop"] = 0
    frames[0].save(path, format="GIF", **kwargs)  # type: ignore[arg-type]


def _repair_exact(
    p: Image.Image, rgb: Image.Image, colours: dict[tuple[int, int, int], int], offset: int
) -> None:
    diff = ImageChops.difference(p.convert("RGB"), rgb)
    r, g, b = diff.split()
    wrong = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v else 0)
    box = wrong.getbbox()
    if box is None:
        return
    src = rgb.load()
    dst = p.load()
    bad = wrong.load()
    assert src is not None and dst is not None and bad is not None
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            if bad[x, y]:
                px = src[x, y]
                assert isinstance(px, tuple)
                dst[x, y] = colours[(px[0], px[1], px[2])] + offset


def anim_images(sprite: Sprite, anim: str, scale: int = 1) -> tuple[list[Image.Image], list[int]]:
    if anim not in sprite.anims:
        raise KeyError(f"no anim {anim!r} (have: {', '.join(sprite.anims) or 'none'})")
    seq = anim_sequence(sprite.anims[anim])
    return [to_image(sprite, f, scale) for f in seq], [sprite.frames[f].ms for f in seq]


def save_gif(sprite: Sprite, anim: str, path: str | Path, scale: int = 1) -> None:
    """Animated GIF of an anim: per-frame ms, binary transparency; `once` plays once."""
    images, durations = anim_images(sprite, anim, scale)
    save_gif_images(images, durations, path, loop=sprite.anims[anim].mode != "once")


def sheet_layout(sprite: Sprite, scale: int = 1) -> dict[str, object]:
    fw, fh = sprite.w * scale, sprite.h * scale
    return {
        "name": sprite.name,
        "w": fw,
        "h": fh,
        "scale": scale,
        "frames": [
            {"name": n, "x": i * fw, "y": 0, "ms": fr.ms}
            for i, (n, fr) in enumerate(sprite.frames.items())
        ],
        "anims": {n: {"frames": list(a.frames), "mode": a.mode} for n, a in sprite.anims.items()},
    }


def save_sheet(sprite: Sprite, path: str | Path, scale: int = 1) -> Path:
    """Frames left to right in file order -> PNG, plus `<path>.json` sidecar."""
    _check_scale(scale)
    path = Path(path)
    grids = resolve_frames(sprite)
    fw, fh = sprite.w * scale, sprite.h * scale
    sheet = Image.new("RGBA", (fw * len(grids), fh), (0, 0, 0, 0))
    for i, name in enumerate(grids):
        sheet.paste(to_image(sprite, name, scale), (i * fw, 0))
    sheet.save(path, format="PNG")
    sidecar = path.with_suffix(".json")
    sidecar.write_text(
        json.dumps(sheet_layout(sprite, scale), indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return sidecar


# ---------------------------------------------------------------------------
# preview board

_BG = (30, 30, 36, 255)
_FG = (225, 225, 230, 255)
_DIM = (150, 150, 160, 255)
_CHECK_A = (70, 70, 76, 255)
_CHECK_B = (92, 92, 98, 255)


def _checker(w: int, h: int, cell: int = 8) -> Image.Image:
    img = Image.new("RGBA", (w, h), _CHECK_A)
    d = ImageDraw.Draw(img)
    for cy in range(0, h, cell):
        for cx in range(0, w, cell):
            if (cx // cell + cy // cell) % 2:
                d.rectangle((cx, cy, cx + cell - 1, cy + cell - 1), fill=_CHECK_B)
    return img


def _scaled(img: Image.Image, s: int) -> Image.Image:
    return img if s == 1 else img.resize((img.width * s, img.height * s), Image.Resampling.NEAREST)


def _on_checker(img: Image.Image, cell: int = 8) -> Image.Image:
    base = _checker(img.width, img.height, cell)
    base.alpha_composite(img)
    return base


def _with_grid(img: Image.Image, s: int) -> Image.Image:
    if s < 4:
        return img
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    line = (255, 255, 255, 46)
    for x in range(0, img.width + 1, s):
        d.line((min(x, img.width - 1), 0, min(x, img.width - 1), img.height - 1), fill=line)
    for y in range(0, img.height + 1, s):
        d.line((0, min(y, img.height - 1), img.width - 1, min(y, img.height - 1)), fill=line)
    out = img.copy()
    out.alpha_composite(ov)
    return out


def _tint(img: Image.Image, rgb: tuple[int, int, int], alpha: int) -> Image.Image:
    mask = img.getchannel("A").point(lambda a: alpha if a >= 128 else 0)
    out = Image.new("RGBA", img.size, (*rgb, 255))
    out.putalpha(mask)
    return out


class _Tile:
    def __init__(self, img: Image.Image, label: str) -> None:
        self.img = img
        self.label = label


def _text_w(font: ImageFont.ImageFont | ImageFont.FreeTypeFont, text: str) -> int:
    left, _, right, _ = font.getbbox(text)
    return int(right - left)


def _board(sprite: Sprite, s: int) -> Image.Image:
    font = ImageFont.load_default()
    pad, label_h, title_h = 8, 14, 20
    grids = resolve_frames(sprite)
    names = list(grids)
    base = {n: _frame_rgba_1x(sprite, g) for n, g in grids.items()}

    sections: list[tuple[str, list[_Tile]]] = []
    frame_tiles = [
        _Tile(
            _with_grid(_on_checker(_scaled(base[n], s), max(4, s // 2)), s),
            f"{n}  {sprite.frames[n].ms}ms",
        )
        for n in names
    ]
    sections.append(
        (f"frames  {sprite.w}x{sprite.h} at {s}x  (grid = pixel boundaries)", frame_tiles)
    )

    strip: list[_Tile] = []
    for n in names:
        one = _on_checker(base[n], 4)
        two = _on_checker(_scaled(base[n], 2), 4)
        tile = Image.new("RGBA", (one.width + 4 + two.width, max(one.height, two.height)), _BG)
        tile.paste(one, (0, 0))
        tile.paste(two, (one.width + 4, 0))
        strip.append(_Tile(tile, n))
    sections.append(("actual size  1x and 2x", strip))

    swatches: list[_Tile] = []
    for k, e in sprite.palette.entries.items():
        if e.rgb is None:
            continue
        cr, cg, cb = e.rgb
        txt = f"{k} #{cr:02x}{cg:02x}{cb:02x}{f' {e.role}' if e.role else ''}"
        sw = Image.new("RGBA", (22 + 6 + _text_w(font, txt), 20), _BG)
        d = ImageDraw.Draw(sw)
        d.rectangle((0, 0, 21, 19), fill=(*e.rgb, 255), outline=(255, 255, 255, 90))
        d.text((28, 4), txt, font=font, fill=_FG)
        swatches.append(_Tile(sw, ""))
    sections.append(("palette  (key, colour, role)", swatches))

    onion: list[_Tile] = []
    for prev, cur in zip(names, names[1:], strict=False):
        a = _tint(base[prev], (255, 70, 70), 170)
        b = _tint(base[cur], (70, 140, 255), 170)
        comp = Image.new("RGBA", base[cur].size, (0, 0, 0, 0))
        comp.alpha_composite(a)
        comp.alpha_composite(b)
        onion.append(
            _Tile(_on_checker(_scaled(comp, s), max(4, s // 2)), f"{prev} (red) -> {cur} (blue)")
        )
    if onion:
        sections.append(("onion skin  (previous frame red, this frame blue)", onion))

    # pass 1: layout
    placed: list[tuple[str, int, int, object]] = []
    y = pad
    width = 0
    for title, tiles in sections:
        placed.append(("title", pad, y, title))
        y += title_h
        x = pad
        row_h = 0
        for t in tiles:
            lw = max(_text_w(font, t.label), 0)
            tw = max(t.img.width, lw)
            th = t.img.height + (label_h if t.label else 0)
            if x + tw > BOARD_MAX - pad and x > pad:
                y += row_h + pad
                x, row_h = pad, 0
            placed.append(("tile", x, y, t))
            x += tw + pad
            width = max(width, x)
            row_h = max(row_h, th)
        y += row_h + pad * 2
    canvas = Image.new("RGBA", (max(width, 200), y), _BG)
    d = ImageDraw.Draw(canvas)
    d.text((pad, 2), sprite.name, font=font, fill=_FG)
    for kind, x, yy, payload in placed:
        if kind == "title":
            d.text((x, yy + 4), str(payload), font=font, fill=_DIM)
        else:
            assert isinstance(payload, _Tile)
            canvas.paste(payload.img, (x, yy))
            if payload.label:
                d.text((x, yy + payload.img.height + 1), payload.label, font=font, fill=_FG)
    return canvas


def preview_board(sprite: Sprite, scale: int | None = None) -> Image.Image:
    """One PNG for visual inspection; longest side is kept <= 1800 px."""
    if scale is None:
        scale = max(2, min(24, 512 // max(sprite.w, sprite.h)))
    _check_scale(scale)
    s = scale
    while True:
        board = _board(sprite, s)
        if max(board.size) <= BOARD_MAX:
            return board
        if s == 1:
            break
        s -= 1
    k = BOARD_MAX / max(board.size)
    return board.resize(
        (max(1, int(board.width * k)), max(1, int(board.height * k))), Image.Resampling.NEAREST
    )
