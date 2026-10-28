import { beforeEach, describe, expect, it } from "vitest";
import {
  ROULETTE_STEP_S,
  clearRouletteMemo,
  litIndexAt,
  litIndexNow,
  mulberry32,
  stepAt,
  stepStartS,
} from "../../src/server/adventure/roulette";

beforeEach(() => {
  clearRouletteMemo();
});

describe("mulberry32", () => {
  it("is deterministic and returns floats in [0, 1)", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 200; i += 1) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("matches the reference outputs for a known seed", () => {
    // The published mulberry32 sequence for seed 1 (computed with the reference implementation).
    const rng = mulberry32(1);
    expect(rng()).toBeCloseTo(0.6270739405881613, 12);
    expect(rng()).toBeCloseTo(0.002735721180215478, 12);
  });

  it("different seeds give different streams", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("stepAt", () => {
  it("is -1 before the roulette starts and counts quarter seconds after", () => {
    expect(ROULETTE_STEP_S).toBe(0.25);
    expect(stepAt(99.99, 100)).toBe(-1);
    expect(stepAt(100, 100)).toBe(0);
    expect(stepAt(100.24, 100)).toBe(0);
    expect(stepAt(100.25, 100)).toBe(1);
    expect(stepAt(110, 100)).toBe(40);
  });

  it("treats non-finite times as not started", () => {
    expect(stepAt(Number.NaN, 100)).toBe(-1);
    expect(stepAt(100, Number.POSITIVE_INFINITY)).toBe(-1);
  });

  it("gives the start time of a step", () => {
    expect(stepStartS(100, 4)).toBe(101);
  });
});

describe("litIndexAt", () => {
  it("is -1 before the start and for an impossible n", () => {
    expect(litIndexAt(7, 5, -1)).toBe(-1);
    expect(litIndexAt(7, 0, 3)).toBe(-1);
    expect(litIndexAt(7, 2.5, 3)).toBe(-1);
  });

  it("is always 0 for a single candidate", () => {
    for (let k = 0; k < 20; k += 1) expect(litIndexAt(99, 1, k)).toBe(0);
  });

  it("stays inside 0..n-1", () => {
    for (const n of [2, 3, 5, 10]) {
      for (let k = 0; k < 300; k += 1) {
        const i = litIndexAt(424242, n, k);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(n);
      }
    }
  });

  it("never lights the same item twice running", () => {
    for (const n of [2, 3, 4, 7, 10]) {
      let previous = litIndexAt(31337, n, 0);
      for (let k = 1; k < 600; k += 1) {
        const i = litIndexAt(31337, n, k);
        expect(i).not.toBe(previous);
        previous = i;
      }
    }
  });

  it("is a pure function of (seed, n, step): any order, any number of times", () => {
    const forward = Array.from({ length: 50 }, (_, k) => litIndexAt(2024, 6, k));
    clearRouletteMemo();
    const backward = Array.from({ length: 50 }, (_, k) => litIndexAt(2024, 6, 49 - k)).reverse();
    expect(backward).toEqual(forward);
    clearRouletteMemo();
    expect(litIndexAt(2024, 6, 37)).toBe(forward[37]); // a late joiner jumping straight in
  });

  it("follows the spec recurrence", () => {
    const seed = 555;
    const n = 6;
    const r = (k: number): number => mulberry32((seed + k) >>> 0)();
    let expected = Math.floor(r(0) * n);
    expect(litIndexAt(seed, n, 0)).toBe(expected);
    for (let k = 1; k < 40; k += 1) {
      expected = (expected + 1 + Math.floor(r(k) * (n - 1))) % n;
      expect(litIndexAt(seed, n, k)).toBe(expected);
    }
  });

  it("wraps a seed near 2^32 the way unsigned arithmetic does", () => {
    const seed = 4294967295;
    const r = (k: number): number => mulberry32((seed + k) >>> 0)();
    expect(litIndexAt(seed, 5, 0)).toBe(Math.floor(r(0) * 5));
    const second = (Math.floor(r(0) * 5) + 1 + Math.floor(r(1) * 4)) % 5;
    expect(litIndexAt(seed, 5, 1)).toBe(second);
  });

  it("differs between seeds and between candidate counts", () => {
    const a = Array.from({ length: 30 }, (_, k) => litIndexAt(1, 8, k));
    const b = Array.from({ length: 30 }, (_, k) => litIndexAt(2, 8, k));
    expect(a).not.toEqual(b);
  });

  it("makes a ten-minute roulette O(1) per frame after the first (memoised)", () => {
    const steps = 2400; // 10 minutes at four a second
    const first = litIndexAt(77, 9, steps);
    const started = performance.now();
    for (let frame = 0; frame < 20000; frame += 1) litIndexAt(77, 9, steps - (frame % 40));
    const elapsed = performance.now() - started;
    expect(litIndexAt(77, 9, steps)).toBe(first);
    expect(elapsed).toBeLessThan(150);
  });

  it("clamps an absurd step so a hostile value cannot exhaust memory, identically on every screen", () => {
    const a = litIndexAt(5, 7, 1e12);
    clearRouletteMemo();
    expect(litIndexAt(5, 7, 1e12)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
  });
});

describe("litIndexNow", () => {
  it("combines the step and the lit index", () => {
    expect(litIndexNow(3, 5, 100, 99)).toBe(-1);
    expect(litIndexNow(3, 5, 100, 100.6)).toBe(litIndexAt(3, 5, 2));
  });
});
