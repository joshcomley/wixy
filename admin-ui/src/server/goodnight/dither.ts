// Ordered-dither fades (pixelart/FORMAT.md "Scenes"): opacity is never alpha blending. A pixel at
// scene position (x, y) is drawn only if BAYER4[y % 4][x % 4] < round_half_up(opacity * 16).
// The pattern is anchored to the scene, not the sprite, so it does not swim as a sprite moves,
// and the shown sets are nested, so a fade-in only ever adds pixels.

export const BAYER4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** 0..16 whole dither steps for an opacity (round half up, clamped). */
export function ditherLevel(opacity: number): number {
  const level = Math.floor(opacity * 16 + 0.5);
  return level < 0 ? 0 : level > 16 ? 16 : level;
}

/** n mod 4, also right for negative scene coordinates. */
export function mod4(n: number): number {
  return ((n % 4) + 4) % 4;
}

/** Whether the scene pixel (x, y) is drawn at this dither level (0..16). */
export function ditherVisibleAt(x: number, y: number, level: number): boolean {
  const row = BAYER4[mod4(y)];
  const threshold = row === undefined ? 16 : (row[mod4(x)] ?? 16);
  return threshold < level;
}

/** Whether the scene pixel (x, y) is drawn at this opacity (0..1). */
export function ditherVisible(x: number, y: number, opacity: number): boolean {
  return ditherVisibleAt(x, y, ditherLevel(opacity));
}
