"""Write scene.json: the good-night timeline as a `python -m pixelart compose` preview.

The in-app scene (spec/server-chat/goodnight-scene.md) follows the same timeline; this
preview is how the art and timing were judged before wiring it into the chat.

    python -m pixelart.examples.goodnight.make_scene
    python -m pixelart compose pixelart/examples/goodnight/scene.json -o goodnight.gif
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

from pixelart.model import anim_sequence, parse

W, H, TICK = 120, 214, 50  # scene pixels (portrait phone), 50 ms per tick
HERE = Path(__file__).parent

Key = dict[str, float]
Layer = dict[str, object]


def tick(ms: int) -> int:
    return ms // TICK


def anim_ms(sprite_file: str, anim: str) -> int:
    """Total duration of one pass through an animation, from the sprite itself."""
    sp = parse((HERE / sprite_file).read_text(encoding="utf-8"), str(HERE / sprite_file))
    return sum(sp.frames[f].ms for f in anim_sequence(sp.anims[anim]))


# The timeline (ms from the trigger). The in-app scene mirrors these numbers.
APPEAR = 1500  # branch + owl start dithering in
SETTLED = 2300  # fully visible; the owl's intro starts
INTRO_END = SETTLED + anim_ms("owl.pxl", "intro")  # eyes, head turn, back to front
BUBBLE_IN = INTRO_END - 1200  # bubble rises into view as the owl settles after the turn
CAPTURE = BUBBLE_IN + 9000  # a slow drift in
LIFT = CAPTURE + 2200  # glances, then the smile, then it starts to float
GONE = LIFT + 11000  # a slow float up and away
CHAT_BACK = GONE + 1000
SWAY_PERIOD_MS = 3400


def place_stars(rnd: random.Random, count: int) -> list[tuple[int, int]]:
    """Spread stars over the sky, keeping clear of the moon and each other."""
    stars: list[tuple[int, int]] = []
    while len(stars) < count:
        x, y = rnd.randrange(2, W - 7), rnd.randrange(2, H - 50)
        if x < 34 and y < 40:
            continue
        if any(abs(x - a) < 9 and abs(y - b) < 9 for a, b in stars):
            continue
        stars.append((x, y))
    return stars


def drift(
    t0: int, t1: int, p0: tuple[int, int], p1: tuple[int, int], amp: float, grow: bool
) -> list[Key]:
    """Eased path from p0 to p1 with a sideways sway that fades out (arriving) or in
    (leaving); positions are whole pixels."""
    keys: list[Key] = []
    n = t1 - t0
    for k in range(0, n + 1, 2):
        f = k / n
        e = f * f * (3 - 2 * f)
        weight = f if grow else 1 - f
        sway = amp * math.sin(2 * math.pi * k * TICK / SWAY_PERIOD_MS) * weight
        keys.append(
            {
                "t": t0 + k,
                "x": round(p0[0] + (p1[0] - p0[0]) * e + sway),
                "y": round(p0[1] + (p1[1] - p0[1]) * e),
            }
        )
    return keys


def shown_between(t0: int, t1: int, path: list[Key]) -> list[Key]:
    """Keyframes that follow `path` but are only visible from t0 to t1 (a hard cut, so
    two owl layers can hand over between animations without a dissolve)."""
    keys = [dict(k) for k in path]
    for k in keys:
        k["opacity"] = 1.0 if t0 <= k["t"] <= t1 else 0.0
    keys += [
        {"t": t0 - 1, "opacity": 0.0},
        {"t": t0, "opacity": 1.0},
        {"t": t1, "opacity": 1.0},
        {"t": t1 + 1, "opacity": 0.0},
    ]
    keys.sort(key=lambda k: k["t"])
    # carry the latest known position onto the visibility-only keys
    x, y = path[0]["x"], path[0]["y"]
    for k in keys:
        if "x" in k:
            x, y = k["x"], k["y"]
        else:
            k["x"], k["y"] = x, y
    return keys


def fade(*points: tuple[int, float]) -> list[Key]:
    return [{"t": tick(ms), "opacity": op} for ms, op in points]


def build() -> dict[str, object]:
    rnd = random.Random(7)
    layers: list[Layer] = []

    stars = place_stars(rnd, 34)
    for i, (x, y) in enumerate(stars):
        t0 = tick(400) + i * (tick(2000) // len(stars))
        layers.append(
            {
                "sprite": "star.pxl",
                "anim": "twinkle",
                "x": x,
                "y": y,
                "start_tick": max(0, t0 - rnd.randrange(0, 19)),
                "keyframes": [{"t": t0, "opacity": 0.0}, {"t": t0 + 6, "opacity": 1.0}],
            }
        )

    layers.append(
        {
            "sprite": "moon.pxl",
            "frame": "still",
            "x": 14,
            "y": 18,
            "keyframes": fade((800, 0.0), (1800, 1.0), (GONE - 1000, 1.0), (GONE, 0.0)),
        }
    )
    bx, by = 32, 150
    ox, oy = 44, by - 28  # owl's feet on the branch top
    layers.append(
        {
            "sprite": "branch.pxl",
            "frame": "still",
            "x": bx,
            "y": by,
            "keyframes": fade((APPEAR, 0.0), (SETTLED, 1.0), (GONE - 1000, 1.0), (GONE, 0.0)),
        }
    )

    capture, lift, gone = tick(CAPTURE), tick(LIFT), tick(GONE)
    held = (ox - 5, oy - 5)  # the 42x42 bubble centred on the 32x32 owl
    bubble = (
        drift(tick(BUBBLE_IN), capture, (-46, H + 4), held, 8, grow=False)
        + [{"t": lift, "x": held[0], "y": held[1]}]
        + drift(lift, gone, held, (W + 10, -60), 7, grow=True)
    )
    inside = [{"t": k["t"], "x": k["x"] + 5, "y": k["y"] + 5} for k in bubble if k["t"] >= capture]

    intro_end = tick(INTRO_END)
    layers.append(
        {
            "sprite": "owl.pxl",
            "anim": "intro",
            "x": ox,
            "y": oy,
            "start_tick": tick(SETTLED),
            "keyframes": fade((APPEAR, 0.0), (SETTLED, 1.0))
            + [{"t": intro_end, "opacity": 1.0}, {"t": intro_end + 1, "opacity": 0.0}],
        }
    )
    layers.append(
        {
            "sprite": "owl.pxl",
            "anim": "watch",
            "x": ox,
            "y": oy,
            "start_tick": intro_end + 1,
            "keyframes": [
                {"t": intro_end, "opacity": 0.0},
                {"t": intro_end + 1, "opacity": 1.0},
                {"t": capture, "opacity": 1.0},
                {"t": capture + 1, "opacity": 0.0},
            ],
        }
    )
    layers.append(
        {
            "sprite": "owl.pxl",
            "anim": "bubble-happy",
            "start_tick": capture + 1,
            "keyframes": shown_between(capture + 1, gone + 10, inside),
        }
    )
    layers.append({"sprite": "bubble.pxl", "anim": "wobble", "keyframes": bubble})

    return {
        "width": W,
        "height": H,
        "background": "#05060d",
        "tick_ms": TICK,
        "ticks": tick(CHAT_BACK + 500),
        "loop": True,
        "scale": 3,
        "layers": layers,
    }


if __name__ == "__main__":
    (HERE / "scene.json").write_text(json.dumps(build(), indent=1) + "\n", encoding="utf-8")
