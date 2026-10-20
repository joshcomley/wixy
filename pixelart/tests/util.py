"""Shared test helpers."""

from __future__ import annotations

from pixelart.model import Sprite, parse

PALETTE = """\
  .  transparent
  k  #101820  outline
  d  #3a2a4a
  s  #c08040  skin
  l  #f0d090
  h  #ffffff  highlight
  e  #20a0c0  eye
"""


def make(
    frames: dict[str, list[str]],
    *,
    palette: str = PALETTE,
    extra_header: str = "",
    tail: str = "",
    ms: int = 100,
) -> Sprite:
    """Build a sprite from full-frame row lists (all frames the same size)."""
    first = next(iter(frames.values()))
    w, h = len(first[0]), len(first)
    parts = ["pxl 1", "name t", f"size {w}x{h}"]
    if extra_header:
        parts.append(extra_header)
    parts += ["palette", palette.rstrip("\n"), "end"]
    for name, rows in frames.items():
        parts.append(f"frame {name} ms={ms}")
        parts += rows
    if tail:
        parts.append(tail)
    return parse("\n".join(parts) + "\n", None)


def rect(w: int, h: int, x0: int, y0: int, x1: int, y1: int, ch: str = "s") -> list[str]:
    """A w*h grid with a filled rectangle (inclusive corners)."""
    return [
        "".join(ch if x0 <= x <= x1 and y0 <= y <= y1 else "." for x in range(w)) for y in range(h)
    ]
