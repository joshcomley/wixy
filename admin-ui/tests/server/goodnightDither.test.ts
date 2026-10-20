import { describe, expect, it } from "vitest";
import { BAYER4, ditherLevel, ditherVisible, ditherVisibleAt, mod4 } from "../../src/server/goodnight/dither";

describe("dither (pixelart/FORMAT.md Scenes)", () => {
  it("uses the ordered 4x4 Bayer matrix", () => {
    expect(BAYER4).toEqual([
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ]);
  });

  it("rounds opacity to 16 steps, half up", () => {
    expect(ditherLevel(0)).toBe(0);
    expect(ditherLevel(1)).toBe(16);
    expect(ditherLevel(0.5)).toBe(8);
    expect(ditherLevel(1 / 32)).toBe(1); // 0.5 steps rounds up
    expect(ditherLevel(-1)).toBe(0);
    expect(ditherLevel(3)).toBe(16);
  });

  it("draws nothing at 0, everything at 1, and one more cell of every 4x4 block per step", () => {
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        expect(ditherVisible(x, y, 0)).toBe(false);
        expect(ditherVisible(x, y, 1)).toBe(true);
      }
    }
    for (let level = 0; level <= 16; level += 1) {
      let shown = 0;
      for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) if (ditherVisibleAt(x, y, level)) shown += 1;
      expect(shown).toBe(level);
    }
  });

  it("shows pixel (x, y) iff BAYER4[y % 4][x % 4] < level, and the sets are nested", () => {
    for (let level = 0; level < 16; level += 1) {
      for (let y = 0; y < 9; y += 1) {
        for (let x = 0; x < 9; x += 1) {
          expect(ditherVisibleAt(x, y, level)).toBe(BAYER4[y % 4]![x % 4]! < level);
          if (ditherVisibleAt(x, y, level)) expect(ditherVisibleAt(x, y, level + 1)).toBe(true);
        }
      }
    }
  });

  it("is anchored to the scene: negative coordinates wrap like positive ones", () => {
    expect(mod4(-1)).toBe(3);
    expect(ditherVisibleAt(-1, -4, 9)).toBe(ditherVisibleAt(3, 0, 9));
  });
});
