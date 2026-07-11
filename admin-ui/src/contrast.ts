// WCAG 2.x contrast-ratio math (relative luminance formula) — the same
// standard used to hand-verify every color pair in decisions/00045 when
// slice 1 built the base light/dark palettes, now a real function so
// themeEditor.ts (slice 6) can warn on a failing pair in real time instead
// of relying on a one-off calculation redone by hand for every future
// palette change.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** WCAG AA thresholds. Normal text needs 4.5:1; "large" text (>=18pt, or
 * >=14pt bold) and UI components/graphical objects only need 3:1. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;

export function parseHexColor(hex: string): RGB | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (match === null) return null;
  const value = match[1];
  if (value === undefined) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance per WCAG 2.x: L = 0.2126*R + 0.7152*G + 0.0722*B
 * (linearized sRGB channels). */
export function relativeLuminance(color: RGB): number {
  return (
    0.2126 * srgbChannelToLinear(color.r) +
    0.7152 * srgbChannelToLinear(color.g) +
    0.0722 * srgbChannelToLinear(color.b)
  );
}

/** (L_lighter + 0.05) / (L_darker + 0.05) — always >= 1, order-independent. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Same as `contrastRatio`, taking hex strings — returns null if either
 * isn't a valid `#rrggbb` color (a mid-edit invalid hex shouldn't crash the
 * live preview, just skip the reading until it's valid again). */
export function contrastRatioHex(hexA: string, hexB: string): number | null {
  const a = parseHexColor(hexA);
  const b = parseHexColor(hexB);
  if (a === null || b === null) return null;
  return contrastRatio(a, b);
}

export function passesAA(ratio: number, isLargeOrUi: boolean = false): boolean {
  return ratio >= (isLargeOrUi ? AA_LARGE_TEXT : AA_NORMAL_TEXT);
}
