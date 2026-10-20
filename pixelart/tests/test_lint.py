"""One positive and one negative fixture per lint check."""

from __future__ import annotations

from pathlib import Path

import pytest

from pixelart import palette as P
from pixelart.lint import Finding, lint, spearman
from pixelart.model import Sprite, parse

from .util import PALETTE, make, rect

FIXTURES = Path(__file__).parent / "fixtures"
RAMP_PALETTE = PALETTE + "  ramp shade = d s l\n"


def found(sp: Sprite, code: str) -> list[Finding]:
    return [f for f in lint(sp) if f.code == code]


def blank(w: int = 8, h: int = 8) -> list[str]:
    return ["." * w for _ in range(h)]


def put(rows: list[str], pts: dict[tuple[int, int], str]) -> list[str]:
    g = [list(r) for r in rows]
    for (x, y), ch in pts.items():
        g[y][x] = ch
    return ["".join(r) for r in g]


def test_spearman_known_values() -> None:
    assert spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
    assert spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1.0)
    assert spearman([1, 1, 1], [1, 2, 3]) == 0.0
    assert spearman([1, 2, 2, 3], [1, 2, 3, 4]) == pytest.approx(0.9486833, abs=1e-6)


# ---------------------------------------------------------------- orphans


def test_orphan_positive() -> None:
    sp = make({"a": put(rect(8, 8, 1, 1, 3, 3, "l"), {(6, 6): "d"})})
    f = found(sp, "orphan")
    assert [(x.frame, x.x, x.y, x.level) for x in f] == [("a", 6, 6, "warn")]
    assert f[0].hint


def test_orphan_negative_highlight_role_pair_and_blob() -> None:
    # isolated pixel with a highlight role / eye role: deliberate
    rows = put(rect(8, 8, 1, 1, 3, 3, "l"), {(6, 6): "h", (6, 1): "e"})
    assert not found(make({"a": rows}), "orphan")
    # two touching pixels (diagonal) are not orphans
    rows = put(rect(8, 8, 1, 1, 3, 3, "l"), {(6, 6): "d", (7, 7): "d"})
    assert not found(make({"a": rows}), "orphan")


# ---------------------------------------------------------------- outline


def test_outline_double_positive_staircase_of_ls() -> None:
    rows = ["kk......", ".kk.....", "..kk....", "...k...."]
    f = found(make({"a": rows}), "outline-double")
    assert f and (1, 0) in {(x.x, x.y) for x in f}
    assert "diagonal" in f[0].message


def test_outline_double_negative_pixel_perfect_diagonal_and_box() -> None:
    diag = ["k.......", ".k......", "..k.....", "...k...."]
    assert not found(make({"a": diag}), "outline-double")
    box = put(blank(), {})
    box = ["........", ".kkkkk..", ".k...k..", ".k...k..", ".kkkkk..", "........"]
    assert not found(make({"a": box}), "outline-double")


def test_outline_gap_positive() -> None:
    ring = ["........", ".kkkkkk.", ".klllllk"[:8], ".kllllk.", ".kllllk.", ".kkkkkk.", "........"]
    ring = [
        "........",
        ".kkkkkk.",
        ".kllllk.",
        ".kllllk.",
        ".kllllk.",
        ".kkkkkk.",
        "........",
    ]
    gap = put(ring, {(3, 1): "s"})
    f = found(make({"a": gap}), "outline-gap")
    assert [(x.x, x.y) for x in f] == [(3, 1)]


def test_outline_gap_negative_closed_and_unoutlined() -> None:
    ring = [
        "........",
        ".kkkkkk.",
        ".kllllk.",
        ".kllllk.",
        ".kllllk.",
        ".kkkkkk.",
        "........",
    ]
    assert not found(make({"a": ring}), "outline-gap")
    # a sprite that is not outlined at all is not "full of gaps"
    assert not found(make({"a": rect(8, 8, 1, 1, 6, 6, "s")}), "outline-gap")


def test_jaggies_positive_3131() -> None:
    rows = ["kkk.....", "...k....", "....kkk.", ".......k"]
    f = found(make({"a": rows}), "jaggies")
    assert f and "[3, 1, 3, 1]" in f[0].message
    assert "3,2,1" in f[0].hint


def test_jaggies_positive_121() -> None:
    # runs 1,2,1: a one-pixel kink in the middle of a diagonal
    rows = ["k.......", ".kk.....", "...k...."]
    # path (0,0),(1,1),(2,1),(3,2) -> row runs [1,2,1]
    assert found(make({"a": rows}), "jaggies")


@pytest.mark.parametrize(
    "rows",
    [
        ["kkk.....", "...kk...", ".....k.."],  # 3,2,1
        ["kk......", "..kk....", "....kk.."],  # 2,2,2
        ["kkk.....", "...kkk..", "......kk"],  # 3,3,2 (shallow, non-increasing)
        [
            "..kkkk..",
            ".k....k.",
            "k......k",
            "k......k",
            "k......k",
            "k......k",
            ".k....k.",
            "..kkkk..",
        ],  # a clean small circle
    ],
)
def test_jaggies_negative(rows: list[str]) -> None:
    assert not found(make({"a": rows}), "jaggies")


# ---------------------------------------------------------------- shading


def _ring_blob() -> list[str]:
    rows = []
    for y in range(14):
        row = ""
        for x in range(14):
            if 1 <= x <= 12 and 1 <= y <= 12:
                ring = min(x - 1, y - 1, 12 - x, 12 - y) + 1
                row += "d" if ring <= 2 else ("s" if ring <= 4 else "l")
            else:
                row += "."
        rows.append(row)
    return rows


def _lit_blob() -> list[str]:
    rows = []
    for y in range(14):
        row = ""
        for x in range(14):
            if 1 <= x <= 12 and 1 <= y <= 12:
                s = (x - 1) + (y - 1)
                row += "l" if s < 8 else ("s" if s < 15 else "d")
            else:
                row += "."
        rows.append(row)
    return rows


def test_pillow_shading_positive() -> None:
    f = found(make({"a": _ring_blob()}, palette=RAMP_PALETTE), "pillow-shading")
    assert len(f) == 1 and "light" in f[0].hint


def test_pillow_shading_negative_directional_light_and_no_ramp() -> None:
    assert not found(make({"a": _lit_blob()}, palette=RAMP_PALETTE), "pillow-shading")
    # without a declared ramp the check cannot know the shade order
    assert not found(make({"a": _ring_blob()}), "pillow-shading")


def test_banding_positive_three_parallel_bars() -> None:
    rows = blank(10, 6)
    rows = put(rows, {(x, y): ch for y, ch in ((1, "d"), (2, "s"), (3, "l")) for x in range(2, 8)})
    f = found(make({"a": rows}, palette=RAMP_PALETTE), "banding")
    assert [(x.x, x.y) for x in f] == [(2, 1)]


def test_banding_negative_irregular_and_two_bars() -> None:
    rows = blank(10, 6)
    jumpy = put(rows, {(x, y): ch for y, ch in ((1, "d"), (2, "l"), (3, "s")) for x in range(2, 8)})
    assert not found(make({"a": jumpy}, palette=RAMP_PALETTE), "banding")
    two = put(rows, {(x, y): ch for y, ch in ((1, "d"), (2, "s")) for x in range(2, 8)})
    assert not found(make({"a": two}, palette=RAMP_PALETTE), "banding")
    ragged = put(
        rows,
        {
            **{(x, 1): "d" for x in range(2, 8)},
            **{(x, 2): "s" for x in range(3, 8)},
            **{(x, 3): "l" for x in range(2, 6)},
        },
    )
    assert not found(make({"a": ragged}, palette=RAMP_PALETTE), "banding")


# ---------------------------------------------------------------- palette


def test_unused_palette_positive_and_negative() -> None:
    sp = make(
        {"a": rect(4, 4, 0, 0, 3, 3, "s")}, palette="  .  transparent\n  s  #c08040\n  d  #3a2a4a\n"
    )
    assert [f.message for f in found(sp, "unused-palette")] == [
        "palette key 'd' (no role) is never used"
    ]
    sp2 = make(
        {"a": put(rect(4, 4, 0, 0, 3, 3, "s"), {(1, 1): "d", (2, 1): "d"})},
        palette="  .  transparent\n  s  #c08040\n  d  #3a2a4a\n",
    )
    assert not found(sp2, "unused-palette")


def test_near_duplicate_colours() -> None:
    near = "  .  transparent\n  a  #c08040\n  b  #c08141\n"
    rows = put(rect(4, 4, 0, 0, 3, 3, "a"), {(0, 0): "b", (1, 0): "b"})
    assert len(found(make({"a": rows}, palette=near), "near-duplicate-colours")) == 1
    far = "  .  transparent\n  a  #c08040\n  b  #3a2a4a\n"
    assert not found(make({"a": rows}, palette=far), "near-duplicate-colours")


def _ramp_palette(cols: list[str], order: str = "abc") -> str:
    lines = ["  .  transparent"]
    lines += [f"  {k}  {c}" for k, c in zip(order, cols, strict=True)]
    lines.append(f"  ramp r = {' '.join(order)}")
    return "\n".join(lines)


def test_ramp_no_hue_shift_positive_and_negative() -> None:
    rows = put(rect(4, 4, 0, 0, 3, 3, "a"), {(1, 0): "b", (2, 0): "b", (1, 1): "c", (2, 1): "c"})
    flat = _ramp_palette(P.ramp("#c0502a", 3, 0))
    assert len(found(make({"a": rows}, palette=flat), "ramp-no-hue-shift")) == 1
    shifted = _ramp_palette(P.ramp("#c0502a", 3, 25))
    assert not found(make({"a": rows}, palette=shifted), "ramp-no-hue-shift")


def test_ramp_order() -> None:
    cols = P.ramp("#c0502a", 3, 25)
    rows = put(rect(4, 4, 0, 0, 3, 3, "a"), {(1, 0): "b", (2, 0): "b", (1, 1): "c", (2, 1): "c"})
    bad = _ramp_palette(cols[::-1])
    assert len(found(make({"a": rows}, palette=bad), "ramp-order")) == 1
    assert not found(make({"a": rows}, palette=_ramp_palette(cols)), "ramp-order")


def test_palette_over_limit_is_error() -> None:
    rows = rect(4, 4, 0, 0, 3, 3, "s")
    over = [
        f
        for f in lint(make({"a": rows}, extra_header="maxcolors 2"))
        if f.code == "palette-over-limit"
    ]
    assert len(over) == 1 and over[0].level == "error"
    ok = lint(make({"a": rows}, extra_header="maxcolors 6"))
    assert not [f for f in ok if f.code == "palette-over-limit"]


# ---------------------------------------------------------------- models


def _child(replace: dict[str, str] | None = None, extra: str = "") -> Sprite:
    path = FIXTURES / "child.pxl"
    text = path.read_text(encoding="utf-8")
    for old, new in (replace or {}).items():
        assert old in text
        text = text.replace(old, new)
    text = text.replace("anchor eye-l", extra + "anchor eye-l", 1) if extra else text
    return parse(text, str(path))


def test_model_conformance_clean_child_has_no_errors() -> None:
    assert [f for f in lint(_child()) if f.level == "error"] == []


def test_model_anchor_missing_error() -> None:
    sp = _child({"anchor eye-r 4,1\n": ""})
    f = found(sp, "model-anchor-missing")
    assert len(f) == 1 and f[0].level == "error" and "eye-r" in f[0].message and f[0].frame == "a"


def test_model_height_error() -> None:
    squat = "frame a ms=100\n......\n......\n.kkkk.\n......\n......\n......\n"
    text = (FIXTURES / "child.pxl").read_text(encoding="utf-8")
    sp = parse(text.split("frame a")[0] + squat, str(FIXTURES / "child.pxl"))
    f = found(sp, "model-height")
    assert len(f) == 1 and f[0].level == "error" and "2..4" in f[0].message


def test_model_width_error_from_own_require() -> None:
    sp = _child(extra="require width 2..3\n")
    f = found(sp, "model-width")
    assert len(f) == 1 and f[0].level == "error"


# ---------------------------------------------------------------- animation

BASE_A = rect(8, 8, 1, 1, 4, 4)
BASE_B = rect(8, 8, 1, 2, 4, 5)


def test_baseline_drift_positive_and_declared() -> None:
    sp = make({"a": BASE_A, "b": BASE_B}, tail="anim w = a b loop")
    f = found(sp, "anim-baseline-drift")
    assert len(f) == 1 and f[0].frame == "b" and "drift-w" in f[0].hint
    for tag in ("drift-ok", "drift-w"):
        sp = make({"a": BASE_A, "b": BASE_B}, extra_header=f"tag {tag}", tail="anim w = a b loop")
        assert not found(sp, "anim-baseline-drift")
    steady = put(BASE_A, {(2, 2): "l"})
    assert not found(
        make({"a": BASE_A, "b": steady}, tail="anim w = a b loop"), "anim-baseline-drift"
    )


def test_anchor_drift_positive_declared_and_limbs() -> None:
    tail = "anchor eye 1,6\nanim w = a b loop"
    sp = make(
        {"a": BASE_A, "b": put(BASE_A, {(2, 2): "l"})}, extra_header="anchor eye 1,1", tail=tail
    )
    f = found(sp, "anim-anchor-drift")
    assert len(f) == 1 and f[0].frame == "b" and (f[0].x, f[0].y) == (1, 6)
    declared = make(
        {"a": BASE_A, "b": put(BASE_A, {(2, 2): "l"})},
        extra_header="anchor eye 1,1\ntag drift-eye",
        tail=tail,
    )
    assert not found(declared, "anim-anchor-drift")
    limb = make(
        {"a": BASE_A, "b": put(BASE_A, {(2, 2): "l"})},
        extra_header="anchor foot-l 1,1",
        tail="anchor foot-l 1,6\nanim w = a b loop",
    )
    assert not found(limb, "anim-anchor-drift")
    small = make(
        {"a": BASE_A, "b": put(BASE_A, {(2, 2): "l"})},
        extra_header="anchor eye 1,1",
        tail="anchor eye 1,2\nanim w = a b loop",
    )
    assert not found(small, "anim-anchor-drift")  # 1px breathing bob is tolerated


def _flicker_frames(pattern: str) -> dict[str, list[str]]:
    return {
        f"f{i}": put(BASE_A, {(6, 0): "h"} if ch == "h" else {}) for i, ch in enumerate(pattern)
    }


def test_flicker_positive_and_negative() -> None:
    tail = "anim w = f0 f1 f2 f3 loop"
    f = found(make(_flicker_frames("..hh"[:0] + ".h.h"), tail=tail), "anim-flicker")
    assert [(x.x, x.y) for x in f] == [(6, 0)]
    assert not found(make(_flicker_frames(".hh."), tail=tail), "anim-flicker")
    # fewer than 4 frames: not a flicker loop
    assert not found(make(_flicker_frames(".h."), tail="anim w = f0 f1 f2 loop"), "anim-flicker")


def test_flicker_ignores_pixel_with_moving_neighbour() -> None:
    frames = {f"f{i}": put(BASE_A, {(6, 0): "h"} if i % 2 else {(7, 1): "h"}) for i in range(4)}
    assert not found(make(frames, tail="anim w = f0 f1 f2 f3 loop"), "anim-flicker")


def test_volume_jump_positive_and_negative() -> None:
    small = rect(8, 8, 1, 1, 1, 1)
    f = found(make({"a": BASE_A, "b": small}, tail="anim w = a b loop"), "anim-volume-jump")
    assert f and f[0].frame in ("a", "b")
    moved = rect(8, 8, 2, 1, 5, 4)
    assert not found(make({"a": BASE_A, "b": moved}, tail="anim w = a b loop"), "anim-volume-jump")


def test_anim_static_and_timing() -> None:
    sp = make({"a": BASE_A, "b": BASE_A}, tail="anim w = a b loop")
    assert len(found(sp, "anim-static")) == 1
    assert not found(
        make({"a": BASE_A, "b": put(BASE_A, {(2, 2): "l"})}, tail="anim w = a b loop"),
        "anim-static",
    )
    fast = make({"a": BASE_A, "b": put(BASE_A, {(2, 2): "l"})}, tail="anim w = a b loop", ms=20)
    assert found(fast, "anim-timing")
    slow = make({"a": BASE_A, "b": put(BASE_A, {(2, 2): "l"})}, tail="anim w = a b loop", ms=3000)
    assert found(slow, "anim-timing")
    fine = make({"a": BASE_A, "b": put(BASE_A, {(2, 2): "l"})}, tail="anim w = a b loop", ms=120)
    assert not found(fine, "anim-timing")


def test_pingpong_and_once_do_not_wrap() -> None:
    small = rect(8, 8, 1, 1, 1, 1)
    # a -> b is a jump either way, but a 'once' anim of [a, a] has no wrap pair to flag
    sp = make({"a": BASE_A}, tail="anim w = a once")
    assert not found(sp, "anim-volume-jump")
    assert found(make({"a": BASE_A, "b": small}, tail="anim w = a b once"), "anim-volume-jump")


def test_clean_sprite_has_no_findings_at_all() -> None:
    rows = [
        "........",
        ".kkkkkk.",
        ".kssssk.",
        ".ksllsk.",
        ".ksllsk.",
        ".kssssk.",
        ".kkkkkk.",
        "........",
    ]
    sp = make(
        {"a": rows},
        palette="  .  transparent\n  k  #101820  outline\n  s  #c08040\n  l  #f0d090\n",
    )
    assert lint(sp) == []
