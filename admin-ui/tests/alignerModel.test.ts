import { describe, expect, it } from "vitest";
import {
  clampRot,
  clampedToCoverage,
  coversCanvas,
  exportSize,
  IDENTITY_TRANSFORM,
  MAX_ROT_DEG,
  MAX_ZOOM,
  MICRO_PAN_STEP,
  MICRO_ROT_STEP_DEG,
  MICRO_ZOOM_FACTOR,
  minCoveringZoom,
  placementFor,
  isIdentityTransform,
  withRotationCompensated,
  withPanCompensated,
  type AlignTransform,
} from "../src/alignerModel";

// A 4:3 source photo in a 16:9 frame — the shape behind Purdi's lips pair.
const NAT_4_3 = { width: 1600, height: 1200 };
const FRAME_W = 640;
const FRAME_H = 360;

function t(partial: Partial<AlignTransform> = {}): AlignTransform {
  return { ...IDENTITY_TRANSFORM, ...partial };
}

describe("isIdentityTransform", () => {
  it("is true only for the untouched transform", () => {
    expect(isIdentityTransform(IDENTITY_TRANSFORM)).toBe(true);
    expect(isIdentityTransform(t({ dx: 0.001 }))).toBe(false);
    expect(isIdentityTransform(t({ zoom: 1.01 }))).toBe(false);
    expect(isIdentityTransform(t({ rotDeg: 0.25 }))).toBe(false);
  });
});

describe("placementFor", () => {
  it("identity is exactly the site's object-fit:cover rendering — centred, overflowing only on the cropped axis", () => {
    const p = placementFor(NAT_4_3, FRAME_W, FRAME_H, IDENTITY_TRANSFORM);
    // 4:3 into 16:9: width-limited (scale = 640/1600 = 0.4), height overflows.
    expect(p.width).toBeCloseTo(FRAME_W, 6);
    expect(p.height).toBeCloseTo(480, 6);
    expect(p.centerX).toBeCloseTo(FRAME_W / 2, 6);
    expect(p.centerY).toBeCloseTo(FRAME_H / 2, 6);
    expect(p.rotDeg).toBe(0);
  });

  it("pan offsets are canvas-width fractions on BOTH axes (a y-step is the same pixels as an x-step)", () => {
    const p = placementFor(NAT_4_3, FRAME_W, FRAME_H, t({ dx: 0.1, dy: 0.1, zoom: 1.2 }));
    expect(p.centerX).toBeCloseTo(FRAME_W / 2 + 0.1 * FRAME_W, 6);
    expect(p.centerY).toBeCloseTo(FRAME_H / 2 + 0.1 * FRAME_W, 6); // width fraction, not height
  });
});

describe("coversCanvas", () => {
  it("identity always covers, for both orientations", () => {
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, IDENTITY_TRANSFORM)).toBe(true);
    expect(coversCanvas({ width: 1200, height: 1600 }, FRAME_W, FRAME_H, IDENTITY_TRANSFORM)).toBe(true);
  });

  it("a same-aspect image covers exactly at zoom 1 (the boundary the epsilon exists for)", () => {
    expect(coversCanvas({ width: 1600, height: 900 }, FRAME_W, FRAME_H, IDENTITY_TRANSFORM)).toBe(true);
  });

  it("panning past the cover-fit overflow fails", () => {
    // 4:3 in 16:9 overflows vertically by (480-360)/2 = 60px each side — a
    // vertical pan of 60/640 ≈ 0.094 is the exact limit; beyond it, a gap.
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, t({ dy: 0.09 }))).toBe(true);
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, t({ dy: 0.2 }))).toBe(false);
    // Any horizontal pan at zoom 1 gaps immediately (no horizontal overflow).
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, t({ dx: 0.01 }))).toBe(false);
  });

  it("zooming in re-earns pan room in both axes", () => {
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, t({ dx: 0.01, zoom: 1.1 }))).toBe(true);
  });

  it("tilting at zoom 1 breaks a corner; the same tilt with a compensating zoom covers", () => {
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, t({ rotDeg: 3 }))).toBe(false);
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, t({ rotDeg: 3, zoom: 1.08 }))).toBe(true);
  });
});

describe("clampedToCoverage", () => {
  it("passes a covering target through untouched", () => {
    const target = t({ dy: 0.05 });
    expect(clampedToCoverage(NAT_4_3, FRAME_W, FRAME_H, IDENTITY_TRANSFORM, target)).toEqual(target);
  });

  it("stops a too-far pan at the coverage boundary, keeping the valid part of the move", () => {
    const clamped = clampedToCoverage(NAT_4_3, FRAME_W, FRAME_H, IDENTITY_TRANSFORM, t({ dy: 0.5 }));
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, clamped)).toBe(true);
    // The limit is ≈0.094 (60px of vertical overflow); the bisection lands
    // just under it and must not overshoot into a gap.
    expect(clamped.dy).toBeGreaterThan(0.08);
    expect(clamped.dy).toBeLessThan(0.095);
  });

  it("clamps a zoom-OUT attempt to the covering floor instead of gapping", () => {
    const base = t({ zoom: 1.5 });
    const clamped = clampedToCoverage(NAT_4_3, FRAME_W, FRAME_H, base, t({ zoom: 0.5 }));
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, clamped)).toBe(true);
    expect(clamped.zoom).toBeGreaterThan(0.95);
    expect(clamped.zoom).toBeLessThanOrEqual(1.001);
  });

  it("falls back to identity if the base itself is somehow already invalid", () => {
    const clamped = clampedToCoverage(NAT_4_3, FRAME_W, FRAME_H, t({ dy: 5 }), t({ dy: 6 }));
    expect(clamped).toEqual(IDENTITY_TRANSFORM);
  });
});

describe("minCoveringZoom", () => {
  it("is 1 at identity", () => {
    expect(minCoveringZoom(NAT_4_3, FRAME_W, FRAME_H, IDENTITY_TRANSFORM)).toBeCloseTo(1, 2);
  });

  it("rises above 1 when tilted (the corner-coverage compensation)", () => {
    const min = minCoveringZoom(NAT_4_3, FRAME_W, FRAME_H, t({ rotDeg: 4, zoom: 1.2 }));
    expect(min).toBeGreaterThan(1.02);
    expect(min).toBeLessThan(1.2);
    // And it is genuinely the floor: a hair below it no longer covers.
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, t({ rotDeg: 4, zoom: min }))).toBe(true);
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, t({ rotDeg: 4, zoom: min - 0.02 }))).toBe(false);
  });
});

describe("clampRot", () => {
  it("clamps to ±MAX_ROT_DEG", () => {
    expect(clampRot(0.5)).toBe(0.5);
    expect(clampRot(99)).toBe(MAX_ROT_DEG);
    expect(clampRot(-99)).toBe(-MAX_ROT_DEG);
  });
});

describe("withPanCompensated", () => {
  it("costs no zoom while the pan stays inside the cover-fit overflow", () => {
    // 4:3 in 16:9 has ±60px (≈0.094 of width) of vertical overflow at zoom 1.
    const result = withPanCompensated(NAT_4_3, FRAME_W, FRAME_H, IDENTITY_TRANSFORM, 0, 0.05, MAX_ZOOM);
    expect(result).toEqual(t({ dy: 0.05 }));
  });

  it("pays for an impossible-at-zoom-1 nudge with a tiny zoom, so the arrows never feel dead", () => {
    // The width-limited 4:3 has NO horizontal overflow at zoom 1 — a plain
    // clamp would swallow this nudge entirely.
    const result = withPanCompensated(
      NAT_4_3,
      FRAME_W,
      FRAME_H,
      IDENTITY_TRANSFORM,
      MICRO_PAN_STEP,
      0,
      MAX_ZOOM,
    );
    expect(result.dx).toBeCloseTo(MICRO_PAN_STEP, 10); // the nudge LANDS in full
    expect(result.zoom).toBeGreaterThan(1); // paid for with a hair of zoom
    expect(result.zoom).toBeLessThan(1.01); // …but genuinely a hair
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, result)).toBe(true);
  });

  it("clamps the pan itself (at max zoom) when no zoom can hold it", () => {
    const result = withPanCompensated(NAT_4_3, FRAME_W, FRAME_H, IDENTITY_TRANSFORM, 5, 0, MAX_ZOOM);
    expect(result.zoom).toBe(MAX_ZOOM);
    expect(result.dx).toBeLessThan(5);
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, result)).toBe(true);
  });

  it("a long-press's worth of micro nudges costs only a few percent of zoom", () => {
    let current = IDENTITY_TRANSFORM;
    for (let i = 0; i < 20; i += 1) {
      current = withPanCompensated(
        NAT_4_3,
        FRAME_W,
        FRAME_H,
        current,
        current.dx + MICRO_PAN_STEP,
        current.dy,
        MAX_ZOOM,
      );
    }
    expect(current.dx).toBeCloseTo(20 * MICRO_PAN_STEP, 6);
    expect(current.zoom).toBeLessThan(1.1);
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, current)).toBe(true);
  });
});

describe("withRotationCompensated", () => {
  it("applies the FULL tilt at zoom 1 by raising the zoom just enough to keep the corners covered", () => {
    const result = withRotationCompensated(NAT_4_3, FRAME_W, FRAME_H, IDENTITY_TRANSFORM, 3, MAX_ZOOM);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unreachable");
    // The whole point: the tilt is NOT bisected back to ~0 (a dead-feeling
    // button) — it lands in full, paid for with a small auto-zoom.
    expect(result.rotDeg).toBe(3);
    expect(result.zoom).toBeGreaterThan(1.01);
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, result)).toBe(true);
  });

  it("costs no zoom when the tilt already fits (zoomed-in enough)", () => {
    const base = t({ zoom: 1.5 });
    const result = withRotationCompensated(NAT_4_3, FRAME_W, FRAME_H, base, 2, MAX_ZOOM);
    expect(result).toEqual({ ...base, rotDeg: 2 });
  });

  it("clamps the tilt to ±MAX_ROT_DEG", () => {
    const result = withRotationCompensated(NAT_4_3, FRAME_W, FRAME_H, IDENTITY_TRANSFORM, 45, MAX_ZOOM);
    expect(result?.rotDeg).toBe(MAX_ROT_DEG);
  });

  it("returns null when even max zoom can't hold the tilt with the current pan", () => {
    // 4:3 at 3× zoom, panned to 0.99 of the horizontal edge: the drawn rect
    // is 1920px wide, so the left canvas corners sit a hair inside the image
    // — until a 10° tilt swings corner (0,0) past the edge. No zoom headroom
    // remains, so the tilt must be refused (never baked), not clamped.
    const base = t({ dx: 0.99, zoom: MAX_ZOOM });
    expect(coversCanvas(NAT_4_3, FRAME_W, FRAME_H, base)).toBe(true); // premise: base itself covers
    expect(withRotationCompensated(NAT_4_3, FRAME_W, FRAME_H, base, MAX_ROT_DEG, MAX_ZOOM)).toBeNull();
  });
});

describe("exportSize", () => {
  it("is 1920×1080 for the 640:360 frame", () => {
    expect(exportSize(640, 360)).toEqual({ width: 1920, height: 1080 });
  });

  it("follows whatever aspect the registry declares", () => {
    expect(exportSize(1, 1)).toEqual({ width: 1920, height: 1920 });
  });
});

describe("the micro steps are genuinely micro", () => {
  it("a pan step is ≈1 CSS px on the live ≈560px frame and ≈3px in the bake", () => {
    expect(MICRO_PAN_STEP * 560).toBeLessThan(1.2);
    expect(MICRO_PAN_STEP * 1920).toBeLessThan(4);
  });

  it("a zoom step is 1% and tilt a quarter degree", () => {
    expect(MICRO_ZOOM_FACTOR).toBeCloseTo(1.01, 6);
    expect(MICRO_ROT_STEP_DEG).toBe(0.25);
  });

  it("the zoom ceiling leaves real headroom for cropping in", () => {
    expect(MAX_ZOOM).toBeGreaterThanOrEqual(2);
  });
});
