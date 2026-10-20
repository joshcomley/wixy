"""Scene composition: several sprites on a timeline -> animated GIF (see FORMAT.md "Scenes")."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from .model import PxlError, Sprite, anim_sequence, parse, resolve_frames
from .palette import hex_to_rgb
from .render import save_gif_images

# Ordered 4x4 Bayer matrix: a pixel at (x, y) is shown when BAYER4[y % 4][x % 4] < opacity * 16.
BAYER4: tuple[tuple[int, ...], ...] = (
    (0, 8, 2, 10),
    (12, 4, 14, 6),
    (3, 11, 1, 9),
    (15, 7, 13, 5),
)


@dataclass
class Key:
    t: float
    x: float
    y: float
    opacity: float


@dataclass
class Layer:
    sprite: Sprite
    anim: str | None
    frame: str | None
    keys: list[Key]
    start_tick: int = 0


@dataclass
class Scene:
    width: int
    height: int
    background: tuple[int, int, int] | None
    tick_ms: int
    ticks: int
    loop: bool
    scale: int
    layers: list[Layer] = field(default_factory=list)


def _num(v: object, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, int | float):
        raise ValueError(f"{what} must be a number")
    return float(v)


def _int(v: object, what: str, lo: int, hi: int) -> int:
    f = _num(v, what)
    if f != int(f) or not lo <= int(f) <= hi:
        raise ValueError(f"{what} must be an integer {lo}..{hi}")
    return int(f)


def load_scene(path: str | Path) -> Scene:
    p = Path(path)
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{p}: invalid JSON: {e}") from e
    if not isinstance(doc, dict):
        raise ValueError("scene must be a JSON object")
    width = _int(doc.get("width"), "width", 1, 1024)
    height = _int(doc.get("height"), "height", 1, 1024)
    bg_raw = doc.get("background", "transparent")
    background = None if bg_raw in (None, "transparent") else hex_to_rgb(str(bg_raw))
    tick_ms = _int(doc.get("tick_ms", 100), "tick_ms", 10, 10000)
    ticks = _int(doc.get("ticks"), "ticks", 1, 2000)
    scale = _int(doc.get("scale", 1), "scale", 1, 64)
    loop = bool(doc.get("loop", True))
    layers_raw = doc.get("layers")
    if not isinstance(layers_raw, list) or not layers_raw:
        raise ValueError("scene needs a non-empty 'layers' list")
    cache: dict[Path, Sprite] = {}
    layers: list[Layer] = []
    for n, lr in enumerate(layers_raw):
        if not isinstance(lr, dict):
            raise ValueError(f"layer {n} must be an object")
        sprite_rel = lr.get("sprite")
        if not isinstance(sprite_rel, str):
            raise ValueError(f"layer {n}: 'sprite' path is required")
        sp_path = (p.parent / sprite_rel).resolve()
        if sp_path not in cache:
            try:
                cache[sp_path] = parse(sp_path.read_text(encoding="utf-8"), str(sp_path))
            except OSError as e:
                raise ValueError(f"layer {n}: cannot read {sprite_rel}: {e.strerror}") from e
            except PxlError as e:
                raise ValueError(f"layer {n}: {e}") from e
        sprite = cache[sp_path]
        anim = lr.get("anim")
        frame = lr.get("frame")
        if (anim is None) == (frame is None):
            raise ValueError(f"layer {n}: give exactly one of 'anim' or 'frame'")
        if anim is not None and anim not in sprite.anims:
            raise ValueError(f"layer {n}: sprite has no anim {anim!r}")
        if frame is not None and frame not in sprite.frames:
            raise ValueError(f"layer {n}: sprite has no frame {frame!r}")
        bx = _num(lr.get("x", 0), f"layer {n} x")
        by = _num(lr.get("y", 0), f"layer {n} y")
        bo = _num(lr.get("opacity", 1.0), f"layer {n} opacity")
        keys: list[Key] = []
        for kr in lr.get("keyframes", []):
            if not isinstance(kr, dict):
                raise ValueError(f"layer {n}: keyframes must be objects")
            keys.append(
                Key(
                    _num(kr.get("t"), f"layer {n} keyframe t"),
                    _num(kr.get("x", bx), f"layer {n} keyframe x"),
                    _num(kr.get("y", by), f"layer {n} keyframe y"),
                    _num(kr.get("opacity", bo), f"layer {n} keyframe opacity"),
                )
            )
        if not keys:
            keys = [Key(0, bx, by, bo)]
        keys.sort(key=lambda k: k.t)
        for k in keys:
            if not 0 <= k.opacity <= 1:
                raise ValueError(f"layer {n}: opacity must be 0..1")
        layers.append(
            Layer(sprite, anim, frame, keys, _int(lr.get("start_tick", 0), "start_tick", 0, 10**6))
        )
    return Scene(width, height, background, tick_ms, ticks, loop, scale, layers)


def interpolate(keys: list[Key], tick: float) -> tuple[float, float, float]:
    """Linear interpolation of (x, y, opacity); holds the first/last key outside the range."""
    if tick <= keys[0].t:
        k = keys[0]
        return k.x, k.y, k.opacity
    for a, b in zip(keys, keys[1:], strict=False):
        if tick <= b.t:
            f = 0.0 if b.t == a.t else (tick - a.t) / (b.t - a.t)
            return (
                a.x + (b.x - a.x) * f,
                a.y + (b.y - a.y) * f,
                a.opacity + (b.opacity - a.opacity) * f,
            )
    k = keys[-1]
    return k.x, k.y, k.opacity


def round_half_up(v: float) -> int:
    return math.floor(v + 0.5)


def dither_visible(x: int, y: int, opacity: float) -> bool:
    """Ordered-dither visibility of canvas pixel (x, y) at the given opacity (0..1)."""
    return BAYER4[y % 4][x % 4] < round_half_up(opacity * 16)


def layer_frame(layer: Layer, tick: int, tick_ms: int) -> str:
    if layer.frame is not None:
        return layer.frame
    assert layer.anim is not None
    anim = layer.sprite.anims[layer.anim]
    seq = anim_sequence(anim)
    durs = [layer.sprite.frames[f].ms for f in seq]
    total = sum(durs)
    elapsed = max(0, tick - layer.start_tick) * tick_ms
    t = min(elapsed, total - 1) if anim.mode == "once" else elapsed % total
    acc = 0
    for f, d in zip(seq, durs, strict=True):
        acc += d
        if t < acc:
            return f
    return seq[-1]


def render_tick(scene: Scene, tick: int) -> Image.Image:
    bg = (*scene.background, 255) if scene.background else (0, 0, 0, 0)
    canvas = Image.new("RGBA", (scene.width, scene.height), bg)
    px = canvas.load()
    assert px is not None
    for layer in scene.layers:
        x, y, opacity = interpolate(layer.keys, tick)
        ox, oy = round_half_up(x), round_half_up(y)
        sp = layer.sprite
        grid = resolve_frames(sp)[layer_frame(layer, tick, scene.tick_ms)]
        for sy, row in enumerate(grid):
            cy = oy + sy
            if not 0 <= cy < scene.height:
                continue
            for sx, ch in enumerate(row):
                cx = ox + sx
                if not 0 <= cx < scene.width:
                    continue
                r, g, b, a = sp.palette.rgba(ch)
                if a and dither_visible(cx, cy, opacity):
                    px[cx, cy] = (r, g, b, 255)
    if scene.scale != 1:
        canvas = canvas.resize(
            (scene.width * scene.scale, scene.height * scene.scale), Image.Resampling.NEAREST
        )
    return canvas


def render_scene(scene: Scene) -> list[Image.Image]:
    return [render_tick(scene, t) for t in range(scene.ticks)]


def save_scene_gif(scene: Scene, path: str | Path) -> None:
    images = render_scene(scene)
    save_gif_images(images, [scene.tick_ms] * len(images), path, loop=scene.loop)
