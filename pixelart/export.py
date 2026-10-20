"""Export `.pxl` sprites as a strict-TypeScript module (`python -m pixelart export-ts`).

Data encoding (document of record, repeated in the generated header):

* ``palette`` is an array; index 0 is always ``null`` (transparent). Opaque colours follow in
  the sprite's palette order as ``"#rrggbb"`` strings.
* each frame's ``data`` is a string of ``w * h`` characters, row-major, one character per
  pixel: the palette index written in base 36 (``0-9a-z``). Palettes are capped at 36 entries.
* ``anims`` lists frame names in playback order with the anim mode (a pingpong anim is
  *not* expanded; the consumer expands ``a b c`` to ``a b c b``).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

from .model import PxlError, Sprite, parse, resolve_frames

BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def palette_index(sprite: Sprite) -> tuple[list[str | None], dict[str, int]]:
    """Palette array (index 0 = transparent) and the key -> index map."""
    colours: list[str | None] = [None]
    index: dict[str, int] = {}
    for key, entry in sprite.palette.entries.items():
        if entry.rgb is None:
            index[key] = 0
            continue
        index[key] = len(colours)
        r, g, b = entry.rgb
        colours.append(f"#{r:02x}{g:02x}{b:02x}")
    if len(colours) > len(BASE36):
        raise PxlError(f"{sprite.name}: {len(colours)} palette entries exceed the 36 export limit")
    return colours, index


def sprite_data(sprite: Sprite) -> dict[str, object]:
    colours, index = palette_index(sprite)
    grids = resolve_frames(sprite)
    frames = [
        {
            "name": name,
            "ms": sprite.frames[name].ms,
            "data": "".join(BASE36[index[ch]] for row in grid for ch in row),
        }
        for name, grid in grids.items()
    ]
    anims = {
        name: {"frames": list(a.frames), "mode": a.mode} for name, a in sorted(sprite.anims.items())
    }
    return {
        "w": sprite.w,
        "h": sprite.h,
        "palette": colours,
        "frames": frames,
        "anims": anims,
    }


def _ts(value: object, indent: int) -> str:
    """Deterministic TypeScript literal for JSON-shaped data (double quotes, trailing commas)."""
    pad = "  " * indent
    inner = "  " * (indent + 1)
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [f"{inner}{json.dumps(k)}: {_ts(v, indent + 1)}," for k, v in value.items()]
        return "{\n" + "\n".join(items) + f"\n{pad}}}"
    if isinstance(value, list):
        if all(isinstance(v, str | int) or v is None for v in value):
            return "[" + ", ".join(json.dumps(v) for v in value) + "]"
        items = [f"{inner}{_ts(v, indent + 1)}," for v in value]
        return "[\n" + "\n".join(items) + f"\n{pad}]"
    return json.dumps(value)


def const_name(sprite_name: str) -> str:
    """The exported constant for a sprite, e.g. ``owl-perched`` -> ``OWL_PERCHED_SPRITE``."""
    ident = "".join(c if c.isalnum() else "_" for c in sprite_name)
    return f"{ident.upper()}_SPRITE"


def export_ts(paths: Sequence[str | Path], command: str) -> str:
    """The generated module text for the given `.pxl` files (sorted by sprite name)."""
    sprites: dict[str, Sprite] = {}
    for p in paths:
        sp = parse(Path(p).read_text(encoding="utf-8"), str(p))
        if sp.name in sprites:
            raise PxlError(f"duplicate sprite name {sp.name!r}")
        sprites[sp.name] = sp
    out = [
        "// GENERATED FILE - DO NOT EDIT.",
        f"// Regenerate with: {command}",
        "//",
        '// Encoding: palette[0] is null (transparent); the rest are "#rrggbb". Each frame\'s',
        "// `data` has w*h characters, row-major, one per pixel: the palette index in base 36",
        '// (0-9a-z). A "pingpong" anim is stored unexpanded (a b c plays a b c b).',
        "",
        'export type SpriteMode = "loop" | "once" | "pingpong";',
        "",
        "export interface SpriteFrameData {",
        "  readonly name: string;",
        "  readonly ms: number;",
        "  readonly data: string;",
        "}",
        "",
        "export interface SpriteAnimData {",
        "  readonly frames: readonly string[];",
        "  readonly mode: SpriteMode;",
        "}",
        "",
        "export interface SpriteData {",
        "  readonly w: number;",
        "  readonly h: number;",
        "  readonly palette: readonly (string | null)[];",
        "  readonly frames: readonly SpriteFrameData[];",
        "  readonly anims: Readonly<Record<string, SpriteAnimData>>;",
        "}",
        "",
    ]
    for name in sorted(sprites):
        body = _ts(sprite_data(sprites[name]), 0)
        out.append(f"export const {const_name(name)}: SpriteData = {body};")
        out.append("")
    return "\n".join(out).rstrip("\n") + "\n"
