"""PNG -> .pxl: grid detection, per-cell dominant colour, background key-out, quantise."""

from __future__ import annotations

import math
import random
import re
from collections import Counter
from dataclasses import dataclass

from PIL import Image

from .model import Frame, Palette, PaletteEntry, Sprite
from .palette import RGB, delta_e, oklab_to_srgb, srgb_to_oklab

KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
BG_TOLERANCE = 0.03
Cell = tuple[int, int, int, int]
TRANSPARENT: Cell = (0, 0, 0, 0)


@dataclass(frozen=True)
class GridInfo:
    cell_w: int
    cell_h: int
    off_x: int
    off_y: int


def _edge_profile(lines: list[list[Cell]]) -> list[int]:
    """Energy of the colour change between neighbouring columns of `lines` (rows)."""
    width = len(lines[0])
    prof = [0] * width
    for row in lines:
        prev = row[0]
        for x in range(1, width):
            cur = row[x]
            if cur != prev:
                prof[x] += max(abs(cur[k] - prev[k]) for k in range(4)) or 1
            prev = cur
    return prof


def _detect_period(prof: list[int]) -> tuple[int, int] | None:
    total = sum(prof)
    if total == 0:
        return None
    n = len(prof)
    for p in range(max(2, n // 3), 1, -1):
        best_o, best = 0, -1
        for o in range(p):
            on = sum(prof[x] for x in range(o or p, n, p))
            if on > best:
                best, best_o = on, o
        if best / total >= 0.98:
            return p, best_o
    return None


def _pixels(img: Image.Image) -> list[list[Cell]]:
    rgba = img.convert("RGBA")
    w, h = rgba.size
    raw = rgba.tobytes()
    data: list[Cell] = [
        (0, 0, 0, 0) if raw[i + 3] < 128 else (raw[i], raw[i + 1], raw[i + 2], 255)
        for i in range(0, len(raw), 4)
    ]
    return [data[y * w : (y + 1) * w] for y in range(h)]


def detect_grid(img: Image.Image) -> GridInfo | None:
    """Find the implied pixel-cell size from the periodicity of colour edges."""
    rows = _pixels(img)
    cols = [list(c) for c in zip(*rows, strict=True)]
    px = _detect_period(_edge_profile(rows))
    py = _detect_period(_edge_profile(cols))
    if px is None and py is None:
        return None
    p = min(v[0] for v in (px, py) if v is not None)

    def offset(prof: list[int]) -> int:
        n = len(prof)
        return max(range(p), key=lambda o: sum(prof[x] for x in range(o if o else p, n, p)))

    return GridInfo(p, p, offset(_edge_profile(rows)), offset(_edge_profile(cols)))


def _bounds(n_cells: int, total: int, off: int, cell: float) -> list[int]:
    return [min(total, round(off + i * cell)) for i in range(n_cells + 1)]


def sample_cells(
    img: Image.Image,
    cols: int,
    rows: int,
    off_x: int = 0,
    off_y: int = 0,
    cw: float = 0,
    ch: float = 0,
) -> list[list[Cell]]:
    """Dominant colour (mode, never mean) of each cell, ignoring the cell's edges."""
    px = _pixels(img)
    h, w = len(px), len(px[0])
    cw = cw or (w - off_x) / cols
    ch = ch or (h - off_y) / rows
    xs = _bounds(cols, w, off_x, cw)
    ys = _bounds(rows, h, off_y, ch)
    out: list[list[Cell]] = []
    for r in range(rows):
        row: list[Cell] = []
        y0, y1 = ys[r], ys[r + 1]
        my = int((y1 - y0) * 0.2) if y1 - y0 >= 3 else 0
        for c in range(cols):
            x0, x1 = xs[c], xs[c + 1]
            mx = int((x1 - x0) * 0.2) if x1 - x0 >= 3 else 0
            cnt: Counter[Cell] = Counter()
            for yy in range(y0 + my, max(y0 + my + 1, y1 - my)):
                cnt.update(px[yy][x0 + mx : max(x0 + mx + 1, x1 - mx)])
            row.append(cnt.most_common(1)[0][0] if cnt else TRANSPARENT)
        out.append(row)
    return out


def _key_out_background(cells: list[list[Cell]]) -> None:
    """Key out the corner colour, flooding in from every border cell that has it.

    Opaque images only; images that already carry transparency are left alone.
    """
    if any(c == TRANSPARENT for row in cells for c in row):
        return
    rows, cols = len(cells), len(cells[0])
    corners = [cells[0][0], cells[0][cols - 1], cells[rows - 1][0], cells[rows - 1][cols - 1]]
    colour, count = Counter(corners).most_common(1)[0]
    if count < 2:
        return
    bg: RGB = (colour[0], colour[1], colour[2])
    seen: set[tuple[int, int]] = set()
    stack = [
        (y, x)
        for y in range(rows)
        for x in range(cols)
        if (y in (0, rows - 1) or x in (0, cols - 1)) and cells[y][x] == colour
    ]
    while stack:
        y, x = stack.pop()
        if (y, x) in seen:
            continue
        c = cells[y][x]
        if c == TRANSPARENT or delta_e((c[0], c[1], c[2]), bg) > BG_TOLERANCE:
            continue
        seen.add((y, x))
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < rows and 0 <= nx < cols:
                stack.append((ny, nx))
    for y, x in seen:
        cells[y][x] = TRANSPARENT


def kmeans_oklab(colours: Counter[RGB], k: int, seed: int = 0, iterations: int = 40) -> list[RGB]:
    """Deterministic weighted k-means (k-means++ init) in OKLab; returns sRGB centres."""
    pts = [(srgb_to_oklab(c), n) for c, n in sorted(colours.items())]
    rng = random.Random(seed)
    centres = [pts[rng.randrange(len(pts))][0]]
    while len(centres) < k:
        d2 = [min(math.dist(p, c) ** 2 for c in centres) * n for p, n in pts]
        tot = sum(d2)
        if tot == 0:
            break
        r = rng.random() * tot
        acc = 0.0
        for (p, _), dd in zip(pts, d2, strict=True):
            acc += dd
            if acc >= r:
                centres.append(p)
                break
    for _ in range(iterations):
        groups: list[list[tuple[tuple[float, float, float], int]]] = [[] for _ in centres]
        for p, n in pts:
            dists = [math.dist(p, c) for c in centres]
            j = dists.index(min(dists))
            groups[j].append((p, n))
        moved = False
        for j, g in enumerate(groups):
            if not g:
                continue
            tw = sum(n for _, n in g)
            nc = tuple(sum(p[a] * n for p, n in g) / tw for a in range(3))
            new = (nc[0], nc[1], nc[2])
            if math.dist(new, centres[j]) > 1e-6:
                moved = True
            centres[j] = new
        if not moved:
            break
    return [oklab_to_srgb(c) for c in centres]


def _nearest(c: RGB, pal: list[RGB]) -> RGB:
    return min(pal, key=lambda p: delta_e(c, p))


def pixelize(
    img: Image.Image,
    size: tuple[int, int] | None = None,
    palette: list[RGB] | None = None,
    colors: int = 16,
    key_bg: bool = True,
    name: str = "pixelized",
) -> Sprite:
    """Turn a (possibly upscaled / AI-generated) image into a palette-keyed sprite."""
    if size is not None:
        cols, rows = size
        cells = sample_cells(img, cols, rows)
    else:
        grid = detect_grid(img)
        if grid is None:
            raise ValueError(
                "could not detect the pixel grid (image is not cleanly upscaled); pass --size WxH"
            )
        cols = (img.width - grid.off_x) // grid.cell_w
        rows = (img.height - grid.off_y) // grid.cell_h
        cells = sample_cells(img, cols, rows, grid.off_x, grid.off_y, grid.cell_w, grid.cell_h)
    if not (1 <= cols <= 256 and 1 <= rows <= 256):
        raise ValueError(f"sprite size {cols}x{rows} is outside 1..256")
    if key_bg:
        _key_out_background(cells)

    counts: Counter[RGB] = Counter(
        (c[0], c[1], c[2]) for row in cells for c in row if c != TRANSPARENT
    )
    mapping: dict[RGB, RGB]
    if palette is not None:
        mapping = {c: _nearest(c, palette) for c in counts}
    elif len(counts) <= colors:
        mapping = {c: c for c in counts}
    else:
        centres = kmeans_oklab(counts, colors)
        mapping = {c: _nearest(c, centres) for c in counts}
    used = sorted(set(mapping.values()), key=lambda c: (srgb_to_oklab(c)[0], c))
    if len(used) > len(KEY_CHARS):
        raise ValueError(f"{len(used)} colours exceed the {len(KEY_CHARS)} available palette keys")
    keys = {c: KEY_CHARS[i] for i, c in enumerate(used)}
    safe = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-") or "pixelized"
    pal = Palette({k: PaletteEntry(k, c) for c, k in keys.items()})
    grid_rows = [
        "".join("." if c == TRANSPARENT else keys[mapping[(c[0], c[1], c[2])]] for c in row)
        for row in cells
    ]
    sp = Sprite(name=safe, w=cols, h=rows, palette=pal)
    sp.frames["main"] = Frame("main", rows=grid_rows)
    return sp
