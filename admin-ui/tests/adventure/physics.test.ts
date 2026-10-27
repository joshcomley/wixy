import { describe, expect, it } from "vitest";
import {
  MAX_SPIN_DELTA_DEG,
  MAX_SPIN_MS,
  MIN_FLICK_DEG_S,
  MIN_SPIN_DELTA_DEG,
  MIN_SPIN_MS,
  VelocityTracker,
  dragDeltaDeg,
  easeInOutCubic,
  easeOutCubic,
  planSpin,
  spinAngleAt,
  spinEndAngle,
  spinFinished,
  spinSpeedAt,
} from "../../src/server/adventure/physics";

describe("planSpin", () => {
  it("refuses anything slower than a flick", () => {
    expect(MIN_FLICK_DEG_S).toBe(120);
    expect(planSpin(10, 119.9)).toBeNull();
    expect(planSpin(10, -119.9)).toBeNull();
    expect(planSpin(10, 0)).toBeNull();
    expect(planSpin(10, Number.NaN)).toBeNull();
    expect(planSpin(Number.POSITIVE_INFINITY, 500)).toBeNull();
  });

  it("accepts exactly the minimum flick and applies the 720-degree floor", () => {
    const plan = planSpin(0, 120);
    expect(plan).not.toBeNull();
    expect(plan?.delta).toBe(MIN_SPIN_DELTA_DEG); // 120 * 1.5 = 180 -> 720
    expect(plan?.durationMs).toBe(MAX_SPIN_MS); // 3 * 720 / 120 * 1000 = 18000 -> 7000
  });

  it("spins 1.5 x the speed in the middle of the range", () => {
    const plan = planSpin(30, 1000);
    expect(plan).toEqual({ from: 30, delta: 1500, durationMs: 4500 });
  });

  it("caps the distance at 3600 degrees and the time at the floor", () => {
    const plan = planSpin(0, 5000);
    expect(plan?.delta).toBe(MAX_SPIN_DELTA_DEG);
    expect(plan?.durationMs).toBe(MIN_SPIN_MS); // 3 * 3600 / 5000 * 1000 = 2160 -> 3500
  });

  it("keeps the sign of the release speed", () => {
    expect(planSpin(0, -1000)?.delta).toBe(-1500);
    expect(planSpin(0, 1000)?.delta).toBe(1500);
    expect(planSpin(-45, -300)?.from).toBe(-45);
  });

  it("always stays inside the bounds the server validates", () => {
    for (let speed = 120; speed <= 20000; speed *= 1.07) {
      for (const sign of [1, -1]) {
        const plan = planSpin(12.5, sign * speed);
        expect(plan).not.toBeNull();
        if (plan === null) continue;
        expect(Math.abs(plan.delta)).toBeGreaterThanOrEqual(MIN_SPIN_DELTA_DEG);
        expect(Math.abs(plan.delta)).toBeLessThanOrEqual(MAX_SPIN_DELTA_DEG);
        expect(plan.durationMs).toBeGreaterThanOrEqual(MIN_SPIN_MS);
        expect(plan.durationMs).toBeLessThanOrEqual(MAX_SPIN_MS);
        expect(Math.sign(plan.delta)).toBe(sign);
      }
    }
  });

  it("starts at the finger's own speed when nothing is clamped (no jerk on release)", () => {
    const plan = planSpin(0, 1000);
    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(spinSpeedAt(plan, 0)).toBeCloseTo(1000, 6);
  });
});

describe("spinAngleAt", () => {
  const plan = { from: 100, delta: 1500, durationMs: 4500 };

  it("eases out cubically from the start to the end", () => {
    expect(spinAngleAt(plan, 0)).toBe(100);
    expect(spinAngleAt(plan, 2250)).toBeCloseTo(100 + 1500 * (1 - 0.5 ** 3), 9);
    expect(spinAngleAt(plan, 4500)).toBe(1600);
  });

  it("clamps before the start and after the end", () => {
    expect(spinAngleAt(plan, -50)).toBe(100);
    expect(spinAngleAt(plan, 99999)).toBe(1600);
    expect(spinEndAngle(plan)).toBe(1600);
  });

  it("never moves backwards for a positive spin and decelerates throughout", () => {
    let last = spinAngleAt(plan, 0);
    let lastStep = Number.POSITIVE_INFINITY;
    for (let t = 100; t <= 4500; t += 100) {
      const angle = spinAngleAt(plan, t);
      expect(angle).toBeGreaterThanOrEqual(last);
      expect(angle - last).toBeLessThanOrEqual(lastStep + 1e-9);
      lastStep = angle - last;
      last = angle;
    }
  });

  it("reports finish and zero speed at the end", () => {
    expect(spinFinished(plan, 4499)).toBe(false);
    expect(spinFinished(plan, 4500)).toBe(true);
    expect(spinSpeedAt(plan, 4500)).toBe(0);
    expect(spinSpeedAt(plan, 9999)).toBe(0);
  });

  it("works for a negative spin", () => {
    const back = { from: 0, delta: -900, durationMs: 4000 };
    expect(spinAngleAt(back, 4000)).toBe(-900);
    expect(spinAngleAt(back, 1000)).toBeLessThan(0);
  });
});

describe("easing", () => {
  it("easeOutCubic runs 0 -> 1, clamped", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 9);
  });

  it("easeInOutCubic is symmetric and slow at both ends", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 9);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
  });
});

describe("dragDeltaDeg", () => {
  it("is pixels over radius, in degrees", () => {
    expect(dragDeltaDeg(100, 100)).toBeCloseTo(180 / Math.PI, 9);
    expect(dragDeltaDeg(-50, 200)).toBeCloseTo(-(0.25 * 180) / Math.PI, 9);
  });

  it("is zero for a degenerate radius or a non-finite drag", () => {
    expect(dragDeltaDeg(10, 0)).toBe(0);
    expect(dragDeltaDeg(10, -5)).toBe(0);
    expect(dragDeltaDeg(Number.NaN, 100)).toBe(0);
  });
});

describe("VelocityTracker", () => {
  it("is zero with fewer than two samples", () => {
    const tracker = new VelocityTracker();
    expect(tracker.release(0)).toBe(0);
    tracker.add(10, 0);
    expect(tracker.release(10)).toBe(0);
  });

  it("measures the speed over the last ~80 ms", () => {
    const tracker = new VelocityTracker();
    // Slow for 200 ms, then fast (600 deg/s) over the last 80 ms: only the fast part counts.
    for (let t = 0; t <= 200; t += 10) tracker.add(t * 0.05, t); // 50 deg/s
    for (let t = 210; t <= 280; t += 10) tracker.add(10 + (t - 200) * 0.6, t); // 600 deg/s
    const v = tracker.release(285);
    expect(v).toBeGreaterThan(450);
    expect(v).toBeLessThan(650);
  });

  it("carries the sign of the motion", () => {
    const tracker = new VelocityTracker();
    for (let t = 0; t <= 100; t += 10) tracker.add(-t * 2, t); // -2000 deg/s
    expect(tracker.release(105)).toBeCloseTo(-2000, 0);
  });

  it("is zero when the finger rested for more than 60 ms before lifting", () => {
    const tracker = new VelocityTracker();
    for (let t = 0; t <= 100; t += 10) tracker.add(t * 5, t); // fast...
    expect(tracker.release(105)).toBeGreaterThan(4000);
    expect(tracker.release(100 + 61)).toBe(0); // ...then held still for 61 ms
    expect(tracker.release(100 + 60)).toBeGreaterThan(0);
  });

  it("uses the sample before a sparse window so a slow drag still has a speed", () => {
    const tracker = new VelocityTracker();
    tracker.add(0, 0);
    tracker.add(10, 100); // only one sample inside the last 80 ms
    expect(tracker.release(110)).toBeCloseTo(100, 6);
  });

  it("ignores backwards time and non-finite samples, and replaces a same-time sample", () => {
    const tracker = new VelocityTracker();
    tracker.add(0, 100);
    tracker.add(5, 50); // time went backwards: ignored
    tracker.add(Number.NaN, 120);
    expect(tracker.size).toBe(1);
    tracker.add(2, 100); // same time: replaces
    expect(tracker.size).toBe(1);
    tracker.add(12, 200);
    expect(tracker.release(205)).toBeCloseTo(100, 6);
  });

  it("forgets everything on reset and bounds its memory", () => {
    const tracker = new VelocityTracker();
    for (let t = 0; t < 5000; t += 4) tracker.add(t, t);
    expect(tracker.size).toBeLessThan(150);
    tracker.reset();
    expect(tracker.size).toBe(0);
    expect(tracker.release(0)).toBe(0);
  });
});
