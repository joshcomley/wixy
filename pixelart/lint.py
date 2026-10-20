"""Mechanical quality checks for .pxl sprites (errors + advisory warnings)."""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

from .model import Sprite, anim_sequence, resolve_anchors, resolve_frames
from .palette import delta_e, hue_diff, srgb_to_oklab, srgb_to_oklch

XY = tuple[int, int]
DIRS8: tuple[XY, ...] = ((1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1))
DIRS4: tuple[XY, ...] = ((1, 0), (0, 1), (-1, 0), (0, -1))

# roles whose isolated pixels are deliberate (specular glints, eyes, stars)
ORPHAN_OK_ROLES = ("highlight", "eye", "glint", "spark", "star")
# anchors that legitimately move through a cycle (limbs, tools)
LIMB_PREFIXES = ("foot", "hand", "arm", "leg", "tail", "tip", "wing", "paw", "tool", "weapon")

NEAR_DUPLICATE_DE = 0.025
VOLUME_JUMP_RATIO = 0.25
ANCHOR_DRIFT_TOLERANCE = 1
MIN_HUE_SHIFT_DEG = 6.0
PILLOW_RHO = 0.6


@dataclass(frozen=True)
class Finding:
    level: str  # 'error' | 'warn'
    code: str
    frame: str | None
    x: int | None
    y: int | None
    message: str
    hint: str

    def where(self) -> str:
        parts = []
        if self.frame is not None:
            parts.append(f"frame {self.frame}")
        if self.x is not None and self.y is not None:
            parts.append(f"{self.x},{self.y}")
        return " ".join(parts) if parts else "-"


def _err(
    code: str, frame: str | None, x: int | None, y: int | None, msg: str, hint: str
) -> Finding:
    return Finding("error", code, frame, x, y, msg, hint)


def _warn(
    code: str, frame: str | None, x: int | None, y: int | None, msg: str, hint: str
) -> Finding:
    return Finding("warn", code, frame, x, y, msg, hint)


def spearman(a: list[float], b: list[float]) -> float:
    """Spearman rank correlation with average ranks for ties (0.0 if undefined)."""
    n = len(a)
    if n < 2 or n != len(b):
        return 0.0

    def ranks(v: list[float]) -> list[float]:
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / n, sum(rb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb, strict=True))
    va = sum((x - ma) ** 2 for x in ra)
    vb = sum((y - mb) ** 2 for y in rb)
    if va == 0 or vb == 0:
        return 0.0
    return cov / math.sqrt(va * vb)


class _Ctx:
    """Per-sprite lookups shared by the checks."""

    def __init__(self, sprite: Sprite) -> None:
        self.sprite = sprite
        self.grids = resolve_frames(sprite)
        self.anchors = resolve_anchors(sprite)
        pal = sprite.palette
        self.opaque = {k for k, e in pal.entries.items() if e.rgb is not None}
        self.outline = set(pal.keys_with_role("outline"))
        self.orphan_ok: set[str] = set()
        for role in ORPHAN_OK_ROLES:
            self.orphan_ok.update(pal.keys_with_role(role))
        self.ramp_pos: dict[str, tuple[str, int, int]] = {}
        for rname, keys in pal.ramps.items():
            for i, k in enumerate(keys):
                self.ramp_pos.setdefault(k, (rname, i, len(keys)))

    def is_opaque(self, grid: list[str], x: int, y: int) -> bool:
        return 0 <= y < self.sprite.h and 0 <= x < self.sprite.w and grid[y][x] in self.opaque

    def opaque_count(self, grid: list[str]) -> int:
        return sum(1 for row in grid for ch in row if ch in self.opaque)

    def bbox(self, grid: list[str]) -> tuple[int, int, int, int] | None:
        xs: list[int] = []
        ys: list[int] = []
        for y, row in enumerate(grid):
            for x, ch in enumerate(row):
                if ch in self.opaque:
                    xs.append(x)
                    ys.append(y)
        if not xs:
            return None
        return min(xs), min(ys), max(xs), max(ys)

    def baseline(self, grid: list[str]) -> int:
        bb = self.bbox(grid)
        return bb[3] if bb else -1


# ---------------------------------------------------------------------------
# palette checks


def _check_palette(ctx: _Ctx) -> list[Finding]:
    sp = ctx.sprite
    out: list[Finding] = []
    n_opaque = len(ctx.opaque)
    if sp.maxcolors is not None and n_opaque > sp.maxcolors:
        out.append(
            _err(
                "palette-over-limit",
                None,
                None,
                None,
                f"palette has {n_opaque} colours, maxcolors is {sp.maxcolors}",
                "drop or merge colours until the palette fits, or raise maxcolors deliberately",
            )
        )
    used = {ch for g in ctx.grids.values() for row in g for ch in row}
    for k, e in sp.palette.entries.items():
        if e.rgb is not None and not e.inherited and k not in used:
            out.append(
                _warn(
                    "unused-palette",
                    None,
                    None,
                    None,
                    f"palette key {k!r} ({e.role or 'no role'}) is never used",
                    "remove the entry or use the colour",
                )
            )
    keys = [k for k in sp.palette.entries if k in ctx.opaque]
    for i, ka in enumerate(keys):
        for kb in keys[i + 1 :]:
            ea, eb = sp.palette.entries[ka], sp.palette.entries[kb]
            if ea.inherited and eb.inherited:
                continue
            assert ea.rgb is not None and eb.rgb is not None
            de = delta_e(ea.rgb, eb.rgb)
            if de < NEAR_DUPLICATE_DE:
                out.append(
                    _warn(
                        "near-duplicate-colours",
                        None,
                        None,
                        None,
                        f"keys {ka!r} and {kb!r} differ by only dE={de:.3f} (OKLab)",
                        "merge them into one key, or separate them enough to read as two shades",
                    )
                )
    for rname, rkeys in sp.palette.ramps.items():
        cols = [sp.palette.entries[k].rgb for k in rkeys]
        rgbs = [c for c in cols if c is not None]
        if len(rgbs) < 2:
            continue
        lights = [srgb_to_oklab(c)[0] for c in rgbs]
        if any(b < a for a, b in zip(lights, lights[1:], strict=False)):
            out.append(
                _warn(
                    "ramp-order",
                    None,
                    None,
                    None,
                    f"ramp {rname!r} is not ordered dark to light",
                    "list the ramp's keys from darkest to lightest",
                )
            )
        if len(rgbs) >= 3:
            lch = [srgb_to_oklch(c) for c in rgbs]
            mean_c = sum(c[1] for c in lch) / len(lch)
            spread = abs(hue_diff(lch[0][2], lch[-1][2]))
            if mean_c >= 0.04 and spread < MIN_HUE_SHIFT_DEG:
                out.append(
                    _warn(
                        "ramp-no-hue-shift",
                        None,
                        None,
                        None,
                        f"ramp {rname!r} keeps one hue (shift {spread:.1f} deg, flat shading)",
                        "shift shadows toward blue/purple and highlights toward yellow: "
                        "python -m pixelart ramp <base> -n N --shift 20",
                    )
                )
    return out


# ---------------------------------------------------------------------------
# model conformance (errors, FORMAT.md "Models")


def _check_model(ctx: _Ctx) -> list[Finding]:
    sp = ctx.sprite
    out: list[Finding] = []
    for src, req in sp.requirements():
        for fname, grid in ctx.grids.items():
            have = ctx.anchors[fname]
            for a in req.anchors:
                if a not in have:
                    out.append(
                        _err(
                            "model-anchor-missing",
                            fname,
                            None,
                            None,
                            f"required anchor {a!r} (from {src}) is missing",
                            f"add 'anchor {a} x,y' as a default or inside this frame",
                        )
                    )
            bb = ctx.bbox(grid)
            h = (bb[3] - bb[1] + 1) if bb else 0
            w = (bb[2] - bb[0] + 1) if bb else 0
            if req.height and not req.height[0] <= h <= req.height[1]:
                out.append(
                    _err(
                        "model-height",
                        fname,
                        None,
                        None,
                        f"opaque height {h} outside required {req.height[0]}..{req.height[1]} "
                        f"(from {src})",
                        "redraw to the model's proportions",
                    )
                )
            if req.width and not req.width[0] <= w <= req.width[1]:
                out.append(
                    _err(
                        "model-width",
                        fname,
                        None,
                        None,
                        f"opaque width {w} outside required {req.width[0]}..{req.width[1]} "
                        f"(from {src})",
                        "redraw to the model's proportions",
                    )
                )
    return out


# ---------------------------------------------------------------------------
# per-frame checks


def _check_orphans(ctx: _Ctx, fname: str, grid: list[str]) -> list[Finding]:
    out: list[Finding] = []
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch not in ctx.opaque or ch in ctx.orphan_ok:
                continue
            if any(
                0 <= y + dy < ctx.sprite.h
                and 0 <= x + dx < ctx.sprite.w
                and grid[y + dy][x + dx] == ch
                for dx, dy in DIRS8
            ):
                continue
            out.append(
                _warn(
                    "orphan",
                    fname,
                    x,
                    y,
                    f"isolated pixel {ch!r} has no same-colour neighbour",
                    "attach it to a same-colour cluster, recolour it to match its surroundings, "
                    "delete it, or give the colour a 'highlight'/'eye' role if intentional",
                )
            )
    return out


def _outline_set(ctx: _Ctx, grid: list[str]) -> set[XY]:
    return {(x, y) for y, row in enumerate(grid) for x, ch in enumerate(row) if ch in ctx.outline}


def _check_outline_doubles(ctx: _Ctx, fname: str, outline: set[XY]) -> list[Finding]:
    out: list[Finding] = []
    for x, y in sorted(outline, key=lambda p: (p[1], p[0])):
        n4 = [(x + dx, y + dy) for dx, dy in DIRS4 if (x + dx, y + dy) in outline]
        if len(n4) != 2:
            continue
        (bx, by), (cx, cy) = n4
        if bx == cx or by == cy:
            continue  # straight, not an L
        horiz = (bx, by) if by == y else (cx, cy)
        vert = (cx, cy) if by == y else (bx, by)
        hx, vy = horiz[0] - x, vert[1] - y
        if (x + 2 * hx, y) in outline or (x, y + 2 * vy) in outline:
            continue  # a real corner with long arms, not a staircase double
        if (x + hx, y + vy) in outline:
            continue  # thick 2x2 block
        out.append(
            _warn(
                "outline-double",
                fname,
                x,
                y,
                "outline pixel forms an L; a diagonal step would do",
                f"delete the pixel at {x},{y} so the line steps diagonally",
            )
        )
    return out


def _check_outline_gaps(ctx: _Ctx, fname: str, grid: list[str]) -> list[Finding]:
    if not ctx.outline:
        return []
    h, w = ctx.sprite.h, ctx.sprite.w
    boundary: list[XY] = []
    for y in range(h):
        for x in range(w):
            if grid[y][x] not in ctx.opaque:
                continue
            for dx, dy in DIRS4:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and grid[ny][nx] not in ctx.opaque:
                    boundary.append((x, y))
                    break
    if len(boundary) < 8:
        return []
    n_out = sum(1 for x, y in boundary if grid[y][x] in ctx.outline)
    if n_out / len(boundary) < 0.6:
        return []  # the sprite is not outlined in general (selective outlining)
    out: list[Finding] = []
    for x, y in boundary:
        if grid[y][x] not in ctx.outline:
            out.append(
                _warn(
                    "outline-gap",
                    fname,
                    x,
                    y,
                    f"silhouette pixel {grid[y][x]!r} is not outline-coloured",
                    "paint it with the outline colour to close the silhouette "
                    "(or drop the outline role if this sprite is deliberately unoutlined there)",
                )
            )
    return out


def _paths(pixels: set[XY]) -> list[list[XY]]:
    deg = {p: sum(1 for dx, dy in DIRS8 if (p[0] + dx, p[1] + dy) in pixels) for p in pixels}
    unvisited = set(pixels)
    paths: list[list[XY]] = []
    while unvisited:
        start = min(unvisited, key=lambda p: (deg[p] != 1, p[1], p[0]))
        path = [start]
        unvisited.discard(start)
        cur = start
        prev_dir: XY | None = None
        while True:
            cands = [
                (cur[0] + dx, cur[1] + dy)
                for dx, dy in DIRS8
                if (cur[0] + dx, cur[1] + dy) in unvisited
            ]
            if not cands:
                break

            def cost(q: XY, cur: XY = cur, pd: XY | None = prev_dir) -> tuple[int, int]:
                d = (q[0] - cur[0], q[1] - cur[1])
                turn = 0
                if pd is not None:
                    turn = abs(DIRS8.index(d) - DIRS8.index(pd))
                    turn = min(turn, 8 - turn)
                return (turn, 0 if d[0] == 0 or d[1] == 0 else 1)

            nxt = min(cands, key=cost)
            prev_dir = (nxt[0] - cur[0], nxt[1] - cur[1])
            path.append(nxt)
            unvisited.discard(nxt)
            cur = nxt
        paths.append(path)
    return paths


def _sections(path: list[XY]) -> list[list[XY]]:
    secs: list[list[XY]] = []
    cur = [path[0]]
    sx = sy = 0
    for a, b in zip(path, path[1:], strict=False):
        dx, dy = b[0] - a[0], b[1] - a[1]
        rev = (dx != 0 and sx != 0 and (dx > 0) != (sx > 0)) or (
            dy != 0 and sy != 0 and (dy > 0) != (sy > 0)
        )
        if rev:
            secs.append(cur)
            cur = [b]
            sx = sy = 0
            continue
        cur.append(b)
        if dx:
            sx = 1 if dx > 0 else -1
        if dy:
            sy = 1 if dy > 0 else -1
    secs.append(cur)
    return secs


def _runs(sec: list[XY], axis: int) -> list[int]:
    runs: list[int] = []
    last: int | None = None
    for p in sec:
        v = p[1 - axis]  # axis 0 groups by row (y), axis 1 by column (x)
        if v == last:
            runs[-1] += 1
        else:
            runs.append(1)
            last = v
    return runs


def _irregular(runs: list[int]) -> bool:
    big = [i for i, r in enumerate(runs) if r > 1]
    if not big:
        return False
    seq = runs[max(0, big[0] - 1) : big[-1] + 2]
    if len(seq) < 3:
        return False
    inc = all(a <= b for a, b in zip(seq, seq[1:], strict=False))
    dec = all(a >= b for a, b in zip(seq, seq[1:], strict=False))
    if inc or dec:
        return False
    return not (len(seq) >= 4 and max(seq) - min(seq) <= 1)


def _check_jaggies(ctx: _Ctx, fname: str, outline: set[XY]) -> list[Finding]:
    out: list[Finding] = []
    for path in _paths(outline):
        if len(path) < 4:
            continue
        for sec in _sections(path):
            if len(sec) < 4:
                continue
            for axis in (0, 1):
                runs = _runs(sec, axis)
                if _irregular(runs):
                    x, y = sec[0]
                    out.append(
                        _warn(
                            "jaggies",
                            fname,
                            x,
                            y,
                            f"line staircase runs {runs} are not monotonic",
                            "make the step lengths shrink or grow steadily "
                            "(3,2,1 or 2,2,2), never 3,1,3 or 1,2,1",
                        )
                    )
                    break
    return out


def _distance_to_transparent(ctx: _Ctx, grid: list[str]) -> dict[XY, int] | None:
    h, w = ctx.sprite.h, ctx.sprite.w
    dist: dict[XY, int] = {}
    q: deque[XY] = deque()
    for y in range(h):
        for x in range(w):
            if grid[y][x] not in ctx.opaque:
                dist[(x, y)] = 0
                q.append((x, y))
    if not q:
        return None
    while q:
        x, y = q.popleft()
        for dx, dy in DIRS4:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in dist:
                dist[(nx, ny)] = dist[(x, y)] + 1
                q.append((nx, ny))
    return dist


def _check_pillow(ctx: _Ctx, fname: str, grid: list[str]) -> list[Finding]:
    if not ctx.ramp_pos:
        return []
    dist = _distance_to_transparent(ctx, grid)
    if dist is None:
        return []
    pts: list[tuple[int, int, float, int]] = []  # x, y, ramp index (0..1), distance
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch in ctx.ramp_pos and dist[(x, y)] >= 2:
                _, i, n = ctx.ramp_pos[ch]
                pts.append((x, y, i / (n - 1) if n > 1 else 0.5, dist[(x, y)]))
    if len(pts) < 12 or len({p[3] for p in pts}) < 3 or len({p[2] for p in pts}) < 3:
        return []
    shade = [p[2] for p in pts]
    rho_edge = spearman(shade, [float(p[3]) for p in pts])
    if rho_edge < PILLOW_RHO:
        return []
    best = max(spearman(shade, [float(p[0] * dx + p[1] * dy) for p in pts]) for dx, dy in DIRS8)
    if best >= rho_edge:
        return []
    return [
        _warn(
            "pillow-shading",
            fname,
            None,
            None,
            f"shade follows distance from the edge (rho={rho_edge:.2f}) more than any light "
            f"direction (best rho={best:.2f})",
            "pick one light direction (e.g. top-left): highlights on that side, shadows on "
            "the opposite side, ignoring the silhouette edge",
        )
    ]


def _check_banding(ctx: _Ctx, fname: str, grid: list[str]) -> list[Finding]:
    if not ctx.ramp_pos:
        return []
    out: list[Finding] = []
    h, w = ctx.sprite.h, ctx.sprite.w
    for axis in (0, 1):
        lines = grid if axis == 0 else ["".join(grid[y][x] for y in range(h)) for x in range(w)]
        runs_by_line: list[dict[tuple[int, int], str]] = []
        for line in lines:
            d: dict[tuple[int, int], str] = {}
            i = 0
            while i < len(line):
                j = i
                while j + 1 < len(line) and line[j + 1] == line[i]:
                    j += 1
                if j - i + 1 >= 4 and line[i] in ctx.ramp_pos:
                    d[(i, j)] = line[i]
                i = j + 1
            runs_by_line.append(d)
        for li in range(len(lines) - 2):
            for ext, ka in runs_by_line[li].items():
                kb = runs_by_line[li + 1].get(ext)
                kc = runs_by_line[li + 2].get(ext)
                if kb is None or kc is None:
                    continue
                ra, rb, rc = ctx.ramp_pos[ka], ctx.ramp_pos[kb], ctx.ramp_pos[kc]
                if not (ra[0] == rb[0] == rc[0]):
                    continue
                s1, s2 = rb[1] - ra[1], rc[1] - rb[1]
                if s1 == s2 and abs(s1) == 1:
                    x, y = (ext[0], li) if axis == 0 else (li, ext[0])
                    out.append(
                        _warn(
                            "banding",
                            fname,
                            x,
                            y,
                            f"three parallel bands of {ext[1] - ext[0] + 1} pixels step through "
                            "adjacent ramp shades",
                            "vary the band lengths and break the edges with a curve or "
                            "dithering so the shades follow the form",
                        )
                    )
    return out


# ---------------------------------------------------------------------------
# animation checks


def _check_anims(ctx: _Ctx) -> list[Finding]:
    sp = ctx.sprite
    out: list[Finding] = []
    tags = set(sp.tags)
    for aname, anim in sp.anims.items():
        seq = anim_sequence(anim)
        grids = [ctx.grids[f] for f in seq]
        exempt_all = "drift-ok" in tags or f"drift-{aname}" in tags
        looped = anim.mode == "loop" and len(seq) > 1

        if len(set(map(tuple, grids))) < 2:
            out.append(
                _warn(
                    "anim-static",
                    None,
                    None,
                    None,
                    f"anim {aname!r} never changes (fewer than two distinct frames)",
                    "draw the in-between poses or delete the anim",
                )
            )
        if len(seq) > 32:
            out.append(
                _warn(
                    "anim-timing",
                    None,
                    None,
                    None,
                    f"anim {aname!r} has {len(seq)} frames",
                    "keep animations to 32 frames or fewer; fewer, stronger poses read better",
                )
            )
        for f in dict.fromkeys(seq):
            ms = sp.frames[f].ms
            if len(seq) > 1 and (ms < 30 or ms > 2000):
                out.append(
                    _warn(
                        "anim-timing",
                        f,
                        None,
                        None,
                        f"frame duration {ms}ms is outside 30..2000ms",
                        "use 60-200ms for motion; GIF timing is 10ms-granular with a 20ms floor",
                    )
                )

        if not exempt_all and len(seq) > 1:
            bases = [ctx.baseline(g) for g in grids]
            if len(set(bases)) > 1:
                first = next(i for i, b in enumerate(bases) if b != bases[0])
                out.append(
                    _warn(
                        "anim-baseline-drift",
                        seq[first],
                        None,
                        bases[first],
                        f"lowest opaque row moves through anim {aname!r}: {bases}",
                        "keep the feet/base on one row, or add 'tag drift-ok' / "
                        f"'tag drift-{aname}' if the motion is intended (jump, hover)",
                    )
                )
            names = set(ctx.anchors[seq[0]])
            for f in seq[1:]:
                names &= set(ctx.anchors[f])
            for an in sorted(names):
                if f"drift-{an}" in tags or an.startswith(LIMB_PREFIXES):
                    continue
                pts = [(ctx.anchors[f][an].x, ctx.anchors[f][an].y) for f in seq]
                ox, oy = pts[0]
                for i, (px, py) in enumerate(pts):
                    if (
                        abs(px - ox) > ANCHOR_DRIFT_TOLERANCE
                        or abs(py - oy) > ANCHOR_DRIFT_TOLERANCE
                    ):
                        out.append(
                            _warn(
                                "anim-anchor-drift",
                                seq[i],
                                px,
                                py,
                                f"anchor {an!r} moves from {ox},{oy} to {px},{py} in {aname!r}",
                                f"hold the anchor steady, or add 'tag drift-{an}' / "
                                f"'tag drift-{aname}' if intended",
                            )
                        )
                        break

        counts = [ctx.opaque_count(g) for g in grids]
        pairs = list(zip(range(len(seq)), range(1, len(seq)), strict=False))
        if looped:
            pairs.append((len(seq) - 1, 0))
        for a, b in pairs:
            hi = max(counts[a], counts[b])
            if hi >= 8 and abs(counts[a] - counts[b]) / hi > VOLUME_JUMP_RATIO:
                out.append(
                    _warn(
                        "anim-volume-jump",
                        seq[b],
                        None,
                        None,
                        f"silhouette area jumps {counts[a]} -> {counts[b]} pixels from "
                        f"{seq[a]} to {seq[b]}",
                        "keep the character's mass roughly constant between frames "
                        "(squash and stretch preserve area)",
                    )
                )

        if len(seq) >= 4:
            trans = list(pairs)
            changed: list[set[XY]] = []
            for a, b in trans:
                changed.append(
                    {
                        (x, y)
                        for y in range(sp.h)
                        for x in range(sp.w)
                        if grids[a][y][x] != grids[b][y][x]
                    }
                )
            if changed:
                always = set.intersection(*changed)
                union = set().union(*changed)
                for x, y in sorted(always, key=lambda p: (p[1], p[0])):
                    if any((x + dx, y + dy) in union for dx, dy in DIRS8):
                        continue
                    out.append(
                        _warn(
                            "anim-flicker",
                            seq[0],
                            x,
                            y,
                            f"pixel changes on every frame of {aname!r} with no neighbours moving",
                            "hold it for 2+ frames or tie it to a moving shape; "
                            "single-pixel toggling reads as noise",
                        )
                    )
    return out


# ---------------------------------------------------------------------------


def lint(sprite: Sprite) -> list[Finding]:
    """Run every check; errors must be zero, warnings should be fixed or justified."""
    ctx = _Ctx(sprite)
    out: list[Finding] = []
    out += _check_palette(ctx)
    out += _check_model(ctx)
    for fname, grid in ctx.grids.items():
        out += _check_orphans(ctx, fname, grid)
        outline = _outline_set(ctx, grid)
        if outline:
            out += _check_outline_doubles(ctx, fname, outline)
            out += _check_outline_gaps(ctx, fname, grid)
            out += _check_jaggies(ctx, fname, outline)
        out += _check_pillow(ctx, fname, grid)
        out += _check_banding(ctx, fname, grid)
    out += _check_anims(ctx)
    return out
