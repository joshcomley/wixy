import { describe, expect, it } from "vitest";
import {
  TEASE_CYCLE_MS,
  TEASE_SIZE_DEFAULT,
  TEASE_SIZE_MAX,
  TEASE_SIZE_MIN,
  TEASE_SPEED_DEFAULT,
  TEASE_SPEED_MAX,
  TEASE_SPEED_MIN,
  TEASE_SPEED_STEP,
  advanceTeasePhase,
  computeTeaseCoords,
  computeTeaseRadius,
  teaseGeometry,
} from "../../src/server/teasePaint";

/** The cut-out's position for a given animation-clock reading, on a 1024x768 canvas showing a
 * 400x300 photo at the default size, exactly as the viewer and the sender's preview compute it. */
function spotAt(elapsedMs: number): { x: number; y: number } {
  const geo = teaseGeometry(1024, 768, 400, 300);
  const radius = computeTeaseRadius(TEASE_SIZE_DEFAULT, geo.minSide);
  return computeTeaseCoords({
    cx: geo.cx,
    cy: geo.cy,
    Ax: Math.max(0, geo.drawW / 2 - radius),
    Ay: Math.max(0, geo.drawH / 2 - radius),
    drawX: geo.drawX,
    drawY: geo.drawY,
    drawW: geo.drawW,
    drawH: geo.drawH,
    radius,
    elapsedMs,
    prefersReducedMotion: false,
    isDragging: false,
  });
}

describe("advanceTeasePhase: the animation clock behind the speed control", () => {
  it("at speed 1 the clock equals wall time, i.e. the behaviour before the speed control existed", () => {
    let phase = 0;
    for (let i = 0; i < 60; i++) phase = advanceTeasePhase(phase, 1000 / 60, TEASE_SPEED_DEFAULT);
    expect(phase).toBeCloseTo(1000, 6);
  });

  it("runs N times as fast at speed N", () => {
    expect(advanceTeasePhase(0, 1000, 2)).toBe(2000);
    expect(advanceTeasePhase(0, 1000, 0.5)).toBe(500);
    expect(advanceTeasePhase(0, 1000, TEASE_SPEED_MAX)).toBe(3000);
  });

  it("never runs backwards, even if the frame gap is negative", () => {
    expect(advanceTeasePhase(5000, -40, 3)).toBe(5000);
  });

  it("a speed change never makes the cut-out jump: only the rate from then on changes", () => {
    // 2 s at speed 1, then the recipient drags the slider to 3x at that very instant.
    let phase = 0;
    phase = advanceTeasePhase(phase, 2000, 1);
    const before = spotAt(phase);
    phase = advanceTeasePhase(phase, 0, 3); // same instant, new speed
    const after = spotAt(phase);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    // ...and one second later it is three seconds further along the same path.
    phase = advanceTeasePhase(phase, 1000, 3);
    const later = spotAt(phase);
    const expected = spotAt(5000);
    expect(later.x).toBeCloseTo(expected.x, 9);
    expect(later.y).toBeCloseTo(expected.y, 9);
  });

  it("the naive alternative, wall time x speed, WOULD jump at the same moment (why the clock is accumulated)", () => {
    const wallMs = 2000;
    const beforeNaive = spotAt(wallMs * 1);
    const afterNaive = spotAt(wallMs * 3);
    const jump = Math.hypot(afterNaive.x - beforeNaive.x, afterNaive.y - beforeNaive.y);
    expect(jump).toBeGreaterThan(50);
  });
});

describe("Tease constants", () => {
  it("keep the defaults inside their ranges and the speed range on whole steps", () => {
    expect(TEASE_SPEED_DEFAULT).toBeGreaterThanOrEqual(TEASE_SPEED_MIN);
    expect(TEASE_SPEED_DEFAULT).toBeLessThanOrEqual(TEASE_SPEED_MAX);
    expect((TEASE_SPEED_MAX - TEASE_SPEED_MIN) / TEASE_SPEED_STEP).toBe(10);
    expect(TEASE_SIZE_DEFAULT).toBeGreaterThanOrEqual(TEASE_SIZE_MIN);
    expect(TEASE_SIZE_DEFAULT).toBeLessThanOrEqual(TEASE_SIZE_MAX);
    expect(TEASE_CYCLE_MS).toBe(16_000);
  });
});

describe("teaseGeometry", () => {
  it("letterboxes a 4:3 photo into a wider canvas, centred", () => {
    const geo = teaseGeometry(1000, 400, 400, 300);
    expect(geo.drawH).toBeCloseTo(400, 9);
    expect(geo.drawW).toBeCloseTo(533.3333333, 5);
    expect(geo.drawX).toBeCloseTo((1000 - geo.drawW) / 2, 9);
    expect(geo.drawY).toBeCloseTo(0, 9);
    expect(geo.cx).toBeCloseTo(500, 9);
    expect(geo.cy).toBeCloseTo(200, 9);
    expect(geo.minSide).toBeCloseTo(400, 9);
  });
});
