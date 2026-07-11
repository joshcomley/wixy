import { describe, expect, it } from "vitest";
import { AA_LARGE_TEXT, AA_NORMAL_TEXT, contrastRatio, contrastRatioHex, parseHexColor, passesAA } from "../src/contrast";

describe("parseHexColor", () => {
  it("parses a valid 6-digit hex color", () => {
    expect(parseHexColor("#1e2430")).toEqual({ r: 0x1e, g: 0x24, b: 0x30 });
  });

  it("parses uppercase hex", () => {
    expect(parseHexColor("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseHexColor("  #000000  ")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("rejects a 3-digit shorthand (not the format this app's palette uses)", () => {
    expect(parseHexColor("#fff")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseHexColor("not-a-color")).toBeNull();
    expect(parseHexColor("#gggggg")).toBeNull();
    expect(parseHexColor("")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("black on white is the maximum possible ratio, 21:1", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 1);
  });

  it("identical colors have a ratio of exactly 1:1", () => {
    expect(contrastRatio({ r: 100, g: 100, b: 100 }, { r: 100, g: 100, b: 100 })).toBeCloseTo(1, 5);
  });

  it("is order-independent (same ratio regardless of argument order)", () => {
    const a = { r: 30, g: 36, b: 48 };
    const b = { r: 243, g: 245, b: 249 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  // Cross-checks against decisions/00045's hand-verified table (a fixed
  // historical record — a formula regression check against known-correct
  // numbers, independent of whatever style.css currently ships; ink,
  // danger, and the brand fill haven't changed since, but see the
  // decisions/00049 test below for --wx-muted, which has).
  it("matches decisions/00045's documented ratios for the light palette", () => {
    expect(contrastRatioHex("#1e2430", "#f3f5f9")).toBeCloseTo(14.25, 1); // ink/surface
    expect(contrastRatioHex("#667085", "#f3f5f9")).toBeCloseTo(4.56, 1); // muted/surface (slice 1's original color)
    expect(contrastRatioHex("#b91c1c", "#f3f5f9")).toBeCloseTo(5.93, 1); // danger/surface
    expect(contrastRatioHex("#ffffff", "#2563eb")).toBeCloseTo(5.17, 1); // white-on-brand-fill
  });

  // decisions/00049: slice 6's theme editor's live contrast checker caught
  // that slice 1's original --wx-muted (#667085) was never checked against
  // --wx-canvas (only --wx-surface, which it cleared at 4.56) — on canvas
  // it was actually 4.24, a real AA failure. Fixed to #616a7e, which clears
  // AA against BOTH light backgrounds it actually renders on.
  it("the fixed --wx-muted (#616a7e) clears AA against both light backgrounds it actually renders on", () => {
    expect(contrastRatioHex("#616a7e", "#f3f5f9")).toBeGreaterThanOrEqual(AA_NORMAL_TEXT); // surface
    expect(contrastRatioHex("#616a7e", "#eaedf3")).toBeGreaterThanOrEqual(AA_NORMAL_TEXT); // canvas — the one that used to fail
  });

  // decisions/00049: the same contrast checker found dark mode's single
  // --wx-danger (#f87171, tuned only for use as TEXT on surface/canvas at
  // 6.08:1) was never checked as a FILL under white text (.wx-toast-error,
  // .wx-chat-offline-banner) — only 2.77:1 there, well under even the
  // relaxed 3:1 bar. Split into --wx-danger (fill, #cf3a3a in dark mode)
  // and --wx-danger-text (unchanged #f87171) — the same fill/text split
  // decisions/00045 already used for --wx-brand-blue.
  it("the new dark-mode --wx-danger fill (#cf3a3a) clears AA for white text, unlike the original single value", () => {
    expect(contrastRatioHex("#ffffff", "#f87171")).toBeLessThan(AA_NORMAL_TEXT); // the old failure, preserved as a regression marker
    expect(contrastRatioHex("#ffffff", "#cf3a3a")).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("--wx-danger-text (dark, #f87171) still clears AA against every background it actually renders on as text", () => {
    expect(contrastRatioHex("#f87171", "#1a1d26")).toBeGreaterThanOrEqual(AA_NORMAL_TEXT); // surface
    expect(contrastRatioHex("#f87171", "#14161d")).toBeGreaterThanOrEqual(AA_NORMAL_TEXT); // canvas
    expect(contrastRatioHex("#f87171", "#3a1e1e")).toBeGreaterThanOrEqual(AA_NORMAL_TEXT); // danger-tint
  });

  it("matches decisions/00045's documented ratios for the dark palette", () => {
    expect(contrastRatioHex("#e4e7ed", "#1a1d26")).toBeCloseTo(13.59, 1); // ink/surface
    expect(contrastRatioHex("#9199aa", "#1a1d26")).toBeCloseTo(5.88, 1); // muted/surface
    expect(contrastRatioHex("#f87171", "#1a1d26")).toBeCloseTo(6.08, 1); // danger/surface
    expect(contrastRatioHex("#ffffff", "#3f6fcf")).toBeCloseTo(4.79, 1); // white-on-brand-fill
    expect(contrastRatioHex("#6fa0f5", "#1a1d26")).toBeCloseTo(6.43, 1); // brand-as-text/surface
  });
});

describe("contrastRatioHex", () => {
  it("returns null when either color is invalid rather than throwing", () => {
    expect(contrastRatioHex("#000000", "not-a-color")).toBeNull();
    expect(contrastRatioHex("nope", "#ffffff")).toBeNull();
  });
});

describe("passesAA", () => {
  it("uses the 4.5:1 normal-text threshold by default", () => {
    expect(passesAA(AA_NORMAL_TEXT)).toBe(true);
    expect(passesAA(AA_NORMAL_TEXT - 0.01)).toBe(false);
  });

  it("uses the 3:1 large-text/UI threshold when isLargeOrUi is true", () => {
    expect(passesAA(AA_LARGE_TEXT, true)).toBe(true);
    expect(passesAA(AA_LARGE_TEXT - 0.01, true)).toBe(false);
    // 3.5:1 fails normal text but passes large/UI
    expect(passesAA(3.5, false)).toBe(false);
    expect(passesAA(3.5, true)).toBe(true);
  });
});
