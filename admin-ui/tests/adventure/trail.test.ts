import { describe, expect, it } from "vitest";
import {
  FADE_MS,
  TRAIL_MAX_POINTS,
  TRAIL_MAX_WIDTH_PX,
  Trail,
  drawTrail,
  freshness,
  trailSamples,
} from "../../src/server/adventure/trail";
import { recordingContext } from "../fixtures/stubContext";

describe("freshness", () => {
  it("is 1 when new, falls linearly and is 0 at the fade time", () => {
    expect(FADE_MS).toBe(450);
    expect(freshness(0)).toBe(1);
    expect(freshness(-20)).toBe(1);
    expect(freshness(225)).toBeCloseTo(0.5, 9);
    expect(freshness(449)).toBeCloseTo(1 / 450, 9);
    expect(freshness(450)).toBe(0);
    expect(freshness(9999)).toBe(0);
  });
});

describe("Trail", () => {
  it("stores points, ignores non-finite input and never lets time run backwards", () => {
    const trail = new Trail();
    trail.add(0.1, 0.2, 100);
    trail.add(Number.NaN, 0, 110);
    trail.add(0, Number.POSITIVE_INFINITY, 110);
    trail.add(0.3, 0.4, 90); // earlier than the last: clamped to 100
    expect(trail.size).toBe(2);
    expect(trail.points[1]?.t).toBe(100);
  });

  it("prunes points that have faded and reports whether any remain", () => {
    const trail = new Trail();
    trail.add(0, 0, 0);
    trail.add(0.1, 0, 200);
    trail.add(0.2, 0, 400);
    expect(trail.prune(449)).toBe(true);
    expect(trail.size).toBe(3);
    expect(trail.prune(450)).toBe(true); // the first has faded
    expect(trail.size).toBe(2);
    expect(trail.prune(10_000)).toBe(false);
    expect(trail.size).toBe(0);
  });

  it("bounds its size", () => {
    const trail = new Trail();
    for (let i = 0; i < TRAIL_MAX_POINTS + 50; i += 1) trail.add(i / 1000, 0, i);
    expect(trail.size).toBe(TRAIL_MAX_POINTS);
    expect(trail.points[trail.size - 1]?.x).toBeCloseTo((TRAIL_MAX_POINTS + 49) / 1000, 9);
  });

  it("back-dates a relayed batch so it keeps the dragger's pace", () => {
    const trail = new Trail();
    trail.addBatch(
      [
        [0.0, 0.0, 1000],
        [0.1, 0.0, 1040],
        [0.2, 0.0, 1090],
      ],
      5000,
    );
    expect(trail.points.map((p) => p.t)).toEqual([4910, 4950, 5000]);
    expect(trail.points.map((p) => p.x)).toEqual([0, 0.1, 0.2]);
  });

  it("ignores an empty batch and a non-finite arrival time", () => {
    const trail = new Trail();
    trail.addBatch([], 100);
    trail.addBatch([[0, 0, 0]], Number.NaN);
    expect(trail.size).toBe(0);
  });

  it("reports emptiness by the newest point's age", () => {
    const trail = new Trail();
    expect(trail.isEmpty(0)).toBe(true);
    trail.add(0, 0, 100);
    expect(trail.isEmpty(300)).toBe(false);
    expect(trail.isEmpty(550)).toBe(true);
    trail.clear();
    expect(trail.size).toBe(0);
  });
});

describe("trailSamples", () => {
  function line(): Trail {
    const trail = new Trail();
    for (let i = 0; i <= 10; i += 1) trail.add(i * 0.05, 0.1, i * 40); // 400 ms of swipe, 0.5 radius long
    return trail;
  }

  it("maps globe-radius units to pixels around the globe centre", () => {
    const trail = new Trail();
    trail.add(0.5, -0.25, 0);
    const [s] = trailSamples(trail, 0, 200, 300, 100);
    expect(s?.x).toBeCloseTo(250, 9);
    expect(s?.y).toBeCloseTo(275, 9);
  });

  it("tapers from 9 px at the newest point to nothing at the tail, and fades the same way", () => {
    const samples = trailSamples(line(), 400, 0, 0, 160);
    expect(samples.length).toBeGreaterThan(2);
    const newest = samples[samples.length - 1];
    const tail = samples[0];
    expect(newest?.width).toBeCloseTo(TRAIL_MAX_WIDTH_PX, 9);
    expect(newest?.alpha).toBeCloseTo(1, 9);
    expect(tail?.width).toBeLessThan(TRAIL_MAX_WIDTH_PX * 0.2);
    expect(tail?.alpha).toBeLessThan(0.2);
    for (let i = 1; i < samples.length; i += 1) {
      expect((samples[i] as { width: number }).width).toBeGreaterThan((samples[i - 1] as { width: number }).width);
      expect((samples[i] as { alpha: number }).alpha).toBeGreaterThan((samples[i - 1] as { alpha: number }).alpha);
    }
  });

  it("drops points that have faded completely, and everything once the swipe is over", () => {
    const trail = line();
    expect(trailSamples(trail, 400 + 449, 0, 0, 100).length).toBe(1);
    expect(trailSamples(trail, 400 + 450, 0, 0, 100)).toEqual([]);
  });

  it("merges points a hair apart and keeps the fresher of two coincident points", () => {
    const trail = new Trail();
    trail.add(0.1, 0.1, 0);
    trail.add(0.1001, 0.1, 10);
    trail.add(0.1002, 0.1, 20);
    const samples = trailSamples(trail, 20, 0, 0, 100);
    expect(samples.length).toBe(1);
    expect(samples[0]?.alpha).toBeCloseTo(1, 9);
  });

  it("does not modify the trail", () => {
    const trail = line();
    const before = trail.size;
    trailSamples(trail, 100_000, 0, 0, 100);
    expect(trail.size).toBe(before);
  });
});

describe("drawTrail", () => {
  it("draws one tapered ribbon with a soft shadow and a gradient", () => {
    const rec = recordingContext();
    const trail = new Trail();
    for (let i = 0; i <= 10; i += 1) trail.add(i * 0.05, 0.1 * Math.sin(i), i * 40);
    drawTrail(rec.ctx, trail, { cx: 200, cy: 300, radiusPx: 160, nowMs: 400, dpr: 2 });
    expect(rec.count("fill")).toBe(1);
    expect(rec.count("createLinearGradient")).toBe(1);
    expect(rec.count("arc")).toBe(1); // the round cap
    expect(rec.count("save")).toBe(rec.count("restore"));
    expect(rec.props["shadowBlur"]).toBe(14); // 7 px x dpr 2
  });

  it("draws nothing under reduced motion", () => {
    const rec = recordingContext();
    const trail = new Trail();
    trail.add(0, 0, 0);
    trail.add(0.1, 0, 20);
    drawTrail(rec.ctx, trail, { cx: 0, cy: 0, radiusPx: 100, nowMs: 20, reducedMotion: true });
    expect(rec.calls).toEqual([]);
  });

  it("draws nothing for an empty or fully faded trail", () => {
    const rec = recordingContext();
    drawTrail(rec.ctx, new Trail(), { cx: 0, cy: 0, radiusPx: 100, nowMs: 0 });
    const trail = new Trail();
    trail.add(0, 0, 0);
    drawTrail(rec.ctx, trail, { cx: 0, cy: 0, radiusPx: 100, nowMs: 5000 });
    expect(rec.calls).toEqual([]);
  });

  it("draws a lone point (a finger that has not moved yet) as a dot", () => {
    const rec = recordingContext();
    const trail = new Trail();
    trail.add(0, 0, 0);
    drawTrail(rec.ctx, trail, { cx: 50, cy: 50, radiusPx: 100, nowMs: 0 });
    expect(rec.count("arc")).toBe(1);
    expect(rec.count("fill")).toBe(1);
  });

  it("draws a remote trail the same way (points arrive in a batch)", () => {
    const rec = recordingContext();
    const trail = new Trail();
    trail.addBatch(
      Array.from({ length: 12 }, (_, i) => [i * 0.04, 0.2, i * 12] as const),
      1000,
    );
    drawTrail(rec.ctx, trail, { cx: 100, cy: 100, radiusPx: 80, nowMs: 1000 });
    expect(rec.count("fill")).toBe(1);
  });
});
