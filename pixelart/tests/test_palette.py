from __future__ import annotations

from pathlib import Path

import pytest

from pixelart import palette as P


def test_oklab_known_values() -> None:
    white = P.srgb_to_oklab((255, 255, 255))
    assert white == pytest.approx((1.0, 0.0, 0.0), abs=1e-4)
    assert P.srgb_to_oklab((0, 0, 0)) == pytest.approx((0.0, 0.0, 0.0), abs=1e-6)
    # reference values from Ottosson's OKLab article
    assert P.srgb_to_oklab((255, 0, 0)) == pytest.approx((0.62796, 0.22486, 0.12585), abs=1e-3)
    assert P.srgb_to_oklab((0, 255, 0)) == pytest.approx((0.86644, -0.23389, 0.17950), abs=1e-3)
    assert P.srgb_to_oklab((0, 0, 255)) == pytest.approx((0.45201, -0.03246, -0.31153), abs=1e-3)


def test_oklch_known_values() -> None:
    L, c, h = P.srgb_to_oklch((255, 0, 0))
    assert L == pytest.approx(0.628, abs=1e-3)
    assert c == pytest.approx(0.2577, abs=1e-3)
    assert h == pytest.approx(29.23, abs=0.1)
    assert P.srgb_to_oklch((128, 128, 128))[1] == pytest.approx(0.0, abs=1e-4)


@pytest.mark.parametrize("name", ["pico-8", "sweetie-16", "endesga-32", "night-owl"])
def test_roundtrip_every_builtin_colour(name: str) -> None:
    for rgb in P.load_palette(name):
        assert P.oklab_to_srgb(P.srgb_to_oklab(rgb)) == rgb
        assert P.oklch_to_srgb(P.srgb_to_oklch(rgb)) == rgb


def test_hex_helpers() -> None:
    assert P.hex_to_rgb("#1a1c2c") == (26, 28, 44)
    assert P.hex_to_rgb("FFFFFF") == (255, 255, 255)
    assert P.rgb_to_hex((26, 28, 44)) == "#1a1c2c"
    with pytest.raises(ValueError):
        P.hex_to_rgb("#12345")


def test_delta_e() -> None:
    assert P.delta_e((10, 20, 30), (10, 20, 30)) == 0.0
    assert P.delta_e((0, 0, 0), (255, 255, 255)) == pytest.approx(1.0, abs=1e-4)
    a, b = (200, 30, 30), (30, 200, 30)
    assert P.delta_e(a, b) == pytest.approx(P.delta_e(b, a))
    assert P.delta_e((100, 100, 100), (101, 100, 100)) < P.delta_e((100, 100, 100), (110, 100, 100))


def test_hue_diff_shortest_arc() -> None:
    assert P.hue_diff(350, 10) == pytest.approx(20)
    assert P.hue_diff(10, 350) == pytest.approx(-20)
    assert P.hue_diff(0, 180) == pytest.approx(180)


def test_gamut_clipping_keeps_in_range() -> None:
    rgb = P.oklch_to_srgb((0.9, 0.4, 150.0))  # wildly out of gamut
    assert all(0 <= c <= 255 for c in rgb)
    assert P.srgb_to_oklch(rgb)[0] == pytest.approx(0.9, abs=0.03)


def test_ramp_lightness_strictly_increasing_and_even() -> None:
    cols = P.ramp("#c0502a", 5, 20)
    assert len(cols) == 5
    ls = [P.srgb_to_oklab(P.hex_to_rgb(c))[0] for c in cols]
    assert all(b > a for a, b in zip(ls, ls[1:], strict=False))
    steps = [b - a for a, b in zip(ls, ls[1:], strict=False)]
    assert max(steps) - min(steps) < 0.02  # evenly spaced in OKLab L


def test_ramp_hue_shift_direction() -> None:
    base = "#c0502a"
    h0 = P.srgb_to_oklch(P.hex_to_rgb(base))[2]
    cols = P.ramp(base, 5, 25)
    h_dark = P.srgb_to_oklch(P.hex_to_rgb(cols[0]))[2]
    h_light = P.srgb_to_oklch(P.hex_to_rgb(cols[-1]))[2]
    assert abs(P.hue_diff(h_dark, P.SHADOW_HUE)) < abs(P.hue_diff(h0, P.SHADOW_HUE))
    assert abs(P.hue_diff(h_light, P.LIGHT_HUE)) < abs(P.hue_diff(h0, P.LIGHT_HUE))


def test_ramp_zero_shift_keeps_hue() -> None:
    cols = P.ramp("#c0502a", 5, 0)
    hues = [P.srgb_to_oklch(P.hex_to_rgb(c))[2] for c in cols[1:-1]]
    h0 = P.srgb_to_oklch(P.hex_to_rgb("#c0502a"))[2]
    assert all(abs(P.hue_diff(h0, h)) < 4 for h in hues)


def test_ramp_edge_cases() -> None:
    assert P.ramp("#336699", 1) == ["#336699"]
    assert len(P.ramp("#336699", 2)) == 2
    with pytest.raises(ValueError):
        P.ramp("#336699", 0)


def test_builtin_palettes() -> None:
    assert P.palette_names() == ["endesga-32", "night-owl", "pico-8", "sweetie-16"]
    assert len(P.load_palette("pico-8")) == 16
    assert len(P.load_palette("sweetie-16")) == 16
    assert len(P.load_palette("endesga-32")) == 32
    owl = P.load_palette("night-owl")
    assert len(owl) == 16 and len(set(owl)) == 16
    assert P.load_palette("pico-8")[8] == (255, 0, 77)


def test_night_owl_is_moody_with_warm_accents() -> None:
    owl = P.load_palette("night-owl")
    lch = [P.srgb_to_oklch(c) for c in owl]
    dark = [x for x in lch if x[0] < 0.5]
    assert len(dark) >= 7  # mostly dark
    cool = [x for x in lch if x[1] > 0.03 and 170 <= x[2] <= 300]
    warm = [x for x in lch if x[1] > 0.06 and (x[2] <= 100 or x[2] >= 340) and x[0] > 0.6]
    assert len(cool) >= 8 and len(warm) >= 2


def test_load_palette_from_file_and_errors(tmp_path: Path) -> None:
    f = tmp_path / "mine.pal"
    f.write_text("# my colours\n#ff0000\n00ff00  # green\n\n", encoding="utf-8")
    assert P.load_palette(str(f)) == [(255, 0, 0), (0, 255, 0)]
    with pytest.raises(FileNotFoundError, match="no palette"):
        P.load_palette("nope")
