"""Render the interface-art previews: the icon set, the 9-slice card stretched to several
sizes, and the night tile repeated 3x3 (to prove it tiles seamlessly).

    python -m pixelart.examples.ui.make_previews
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from pixelart.model import parse
from pixelart.render import save_sheet, to_image

HERE = Path(__file__).parent
OUT = HERE / "previews"
BG = (40, 44, 60, 255)


def load(name: str) -> Image.Image:
    sp = parse((HERE / name).read_text(encoding="utf-8"), str(HERE / name))
    return to_image(sp, next(iter(sp.frames)), 1)


def nine_slice(src: Image.Image, corner: int, w: int, h: int) -> Image.Image:
    """Stretch by repeating the edge/centre pixels; corners stay fixed (no resampling)."""
    sw, sh = src.size
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    mid_w, mid_h = sw - 2 * corner, sh - 2 * corner
    xs = list(range(corner)) + [corner + (i % mid_w) for i in range(w - 2 * corner)]
    xs += list(range(sw - corner, sw))
    ys = list(range(corner)) + [corner + (i % mid_h) for i in range(h - 2 * corner)]
    ys += list(range(sh - corner, sh))
    px, sp = out.load(), src.load()
    assert px is not None and sp is not None
    for y, sy in enumerate(ys):
        for x, sx in enumerate(xs):
            px[x, y] = sp[sx, sy]
    return out


def board(items: list[Image.Image], scale: int, gap: int = 4) -> Image.Image:
    w = sum(i.width for i in items) + gap * (len(items) + 1)
    h = max(i.height for i in items) + gap * 2
    b = Image.new("RGBA", (w, h), BG)
    x = gap
    for i in items:
        b.alpha_composite(i, (x, gap))
        x += i.width + gap
    return b.resize((b.width * scale, b.height * scale), Image.Resampling.NEAREST)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    icons = parse((HERE / "icons.pxl").read_text(encoding="utf-8"), str(HERE / "icons.pxl"))
    save_sheet(icons, OUT / "icons.sheet.png", scale=1)
    board([to_image(icons, f, 1) for f in icons.frames], 6).save(OUT / "icons.png")
    panel = load("panel.pxl")
    board([nine_slice(panel, 4, w, h) for w, h in [(24, 24), (64, 32), (40, 56)]], 5).save(
        OUT / "panel-9slice.png"
    )
    tile = load("night-tile.pxl")
    sheet = Image.new("RGBA", (tile.width * 3, tile.height * 3))
    for ty in range(3):
        for tx in range(3):
            sheet.paste(tile, (tx * tile.width, ty * tile.height))
    sheet.resize((sheet.width * 6, sheet.height * 6), Image.Resampling.NEAREST).save(
        OUT / "night-tile-3x3.png"
    )


if __name__ == "__main__":
    main()
