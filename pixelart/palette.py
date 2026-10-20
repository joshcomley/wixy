"""Colour maths (sRGB / OKLab / OKLCH), hue-shifted ramps and built-in palettes."""

from __future__ import annotations

import math
import re
from pathlib import Path

RGB = tuple[int, int, int]
Lab = tuple[float, float, float]
Lch = tuple[float, float, float]

PALETTE_DIR = Path(__file__).parent / "palettes"
_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")

SHADOW_HUE = 285.0  # shadows drift toward blue/purple
LIGHT_HUE = 95.0  # highlights drift toward yellow


def hex_to_rgb(h: str) -> RGB:
    m = _HEX_RE.match(h.strip())
    if not m:
        raise ValueError(f"not a #rrggbb colour: {h!r}")
    v = m.group(1)
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


def rgb_to_hex(rgb: RGB) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def _to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _from_linear(c: float) -> float:
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def srgb_to_oklab(rgb: RGB) -> Lab:
    r, g, b = (_to_linear(c / 255.0) for c in rgb)
    l_ = math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m_ = math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s_ = math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def oklab_to_linear(lab: Lab) -> tuple[float, float, float]:
    big_l, a, b = lab
    l_ = (big_l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (big_l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (big_l - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    )


def in_gamut(lab: Lab) -> bool:
    return all(-1e-4 <= c <= 1 + 1e-4 for c in oklab_to_linear(lab))


def oklab_to_srgb(lab: Lab) -> RGB:
    lin = oklab_to_linear(lab)
    out = [round(max(0.0, min(1.0, _from_linear(max(0.0, min(1.0, c))))) * 255) for c in lin]
    return (out[0], out[1], out[2])


def oklab_to_oklch(lab: Lab) -> Lch:
    big_l, a, b = lab
    return (big_l, math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360.0)


def oklch_to_oklab(lch: Lch) -> Lab:
    big_l, c, h = lch
    return (big_l, c * math.cos(math.radians(h)), c * math.sin(math.radians(h)))


def srgb_to_oklch(rgb: RGB) -> Lch:
    return oklab_to_oklch(srgb_to_oklab(rgb))


def oklch_to_srgb(lch: Lch) -> RGB:
    """OKLCH -> sRGB, reducing chroma until the colour is inside the sRGB gamut."""
    big_l, c, h = lch
    big_l = max(0.0, min(1.0, big_l))
    lo, hi = 0.0, c
    if in_gamut(oklch_to_oklab((big_l, c, h))):
        return oklab_to_srgb(oklch_to_oklab((big_l, c, h)))
    for _ in range(24):
        mid = (lo + hi) / 2
        if in_gamut(oklch_to_oklab((big_l, mid, h))):
            lo = mid
        else:
            hi = mid
    return oklab_to_srgb(oklch_to_oklab((big_l, lo, h)))


def delta_e(a: RGB, b: RGB) -> float:
    """Euclidean distance in OKLab (0 = identical, ~1 = black vs white)."""
    la, lb = srgb_to_oklab(a), srgb_to_oklab(b)
    return math.dist(la, lb)


def hue_diff(a: float, b: float) -> float:
    """Signed shortest rotation from hue a to hue b, in degrees (-180, 180]."""
    d = (b - a) % 360.0
    return d - 360.0 if d > 180.0 else d


def ramp(
    base_hex: str,
    n: int,
    hue_shift_deg: float = 20.0,
    l_min: float = 0.22,
    l_max: float = 0.94,
    chroma_falloff: float = 0.35,
) -> list[str]:
    """A dark->light ramp of `n` colours around `base_hex`.

    Lightness is spaced evenly in OKLab L between l_min and l_max. The hue is
    rotated up to `hue_shift_deg` degrees toward blue/purple in the shadows and
    toward yellow in the highlights (never overshooting the target hue), and
    chroma tapers toward both ends so extremes do not go neon.
    """
    if n < 1:
        raise ValueError("n must be >= 1")
    _, c0, h0 = srgb_to_oklch(hex_to_rgb(base_hex))
    if n == 1:
        return [rgb_to_hex(hex_to_rgb(base_hex))]
    out: list[str] = []
    for i in range(n):
        t = i / (n - 1)
        big_l = l_min + (l_max - l_min) * t
        k = abs(t - 0.5) * 2  # 0 at the middle, 1 at the ends
        target = SHADOW_HUE if t < 0.5 else LIGHT_HUE
        want = hue_diff(h0, target)
        shift = max(-abs(want), min(abs(want), math.copysign(hue_shift_deg * k, want)))
        h = (h0 + shift) % 360.0
        c = c0 * (1.0 - chroma_falloff * k * k)
        out.append(rgb_to_hex(oklch_to_srgb((big_l, c, h))))
    return out


def luminance_key(rgb: RGB) -> float:
    return srgb_to_oklab(rgb)[0]


# ---------------------------------------------------------------------------
# palette files


def parse_pal(text: str) -> list[RGB]:
    cols: list[RGB] = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s or s.startswith("#") and not _HEX_RE.match(s.split()[0]):
            continue
        cols.append(hex_to_rgb(s.split()[0]))
    return cols


def palette_names() -> list[str]:
    return sorted(p.stem for p in PALETTE_DIR.glob("*.pal"))


def load_palette(name_or_path: str) -> list[RGB]:
    """Load a built-in palette by name, or a .pal file by path."""
    p = Path(name_or_path)
    if p.suffix == ".pal" or p.exists():
        return parse_pal(p.read_text(encoding="utf-8"))
    built_in = PALETTE_DIR / f"{name_or_path}.pal"
    if built_in.exists():
        return parse_pal(built_in.read_text(encoding="utf-8"))
    raise FileNotFoundError(
        f"no palette {name_or_path!r} (built-ins: {', '.join(palette_names())})"
    )
