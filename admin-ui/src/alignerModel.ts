// Pure, DOM-free math for the before/after aligner (decisions/00109) — the
// transform model, coverage rules, and clamping behind `alignerDialog.ts`,
// kept separate so the geometry is unit-testable with vitest without a canvas
// (mirrors the `sectionPanelModel.ts` / `opQueue.ts` "framework-free core"
// convention).
//
// THE ONE RULE EVERYTHING HANGS ON: after any adjustment the drawn image must
// still COVER THE WHOLE CANVAS — a gap of bare canvas along an edge would
// bake into the exported photo as a visible border. Identity (no pan, zoom 1,
// no tilt) is exactly the site's own `object-fit: cover` rendering, so it
// always covers; every interaction starts from a covered state and is clamped
// back into coverage by bisection, so coverage holds by induction.

/** One side's adjustment. */
export interface AlignTransform {
  /** Pan offsets as FRACTIONS OF THE CANVAS WIDTH on both axes (never of the
   * height — a 16:9 canvas would make a y-step in "height fractions" a
   * different pixel size than an x-step). +dx moves the image right, +dy
   * moves it down. */
  dx: number;
  dy: number;
  /** Zoom multiplier on top of the cover-fit baseline: 1 = exactly what the
   * site's `object-fit: cover` shows today, 2 = twice as close. */
  zoom: number;
  /** Small straightening angle in degrees (clockwise), clamped to
   * ±MAX_ROT_DEG — photo pairs are handheld, so a degree or two of relative
   * tilt is common; large rotations are not what this tool is for. */
  rotDeg: number;
}

export const IDENTITY_TRANSFORM: AlignTransform = { dx: 0, dy: 0, zoom: 1, rotDeg: 0 };

/** Tilt is clamped to ±this many degrees — beyond it the corner-coverage zoom
 * compensation grows visible and the tool stops being "line up the photos". */
export const MAX_ROT_DEG = 10;

/** Zoom slider ceiling (the floor is dynamic — `minCoveringZoom`). */
export const MAX_ZOOM = 3;

/** One micro-pad tap's pan step, as a canvas-width fraction: ≈1 CSS px on the
 * ≈560px-wide live frame, ≈3 px in the 1920px export — a genuine "nudge". */
export const MICRO_PAN_STEP = 0.0015;

/** One micro zoom tap's multiplier (and its inverse for zoom-out). */
export const MICRO_ZOOM_FACTOR = 1.01;

/** One micro tilt tap's step in degrees. */
export const MICRO_ROT_STEP_DEG = 0.25;

/** The bake's pixel width (height follows the configured frame aspect). 1920
 * keeps the exported photo sharp on any display the frame is shown at (the
 * live frame is ≤560 CSS px wide) while staying under the upload pipeline's
 * 2000px long-side cap, so the server's re-encode never resizes it again. */
export const EXPORT_WIDTH = 1920;

/** The canvas-source image's natural pixel size. */
export interface NaturalSize {
  width: number;
  height: number;
}

/** Where a transform places the image on the canvas, in canvas pixels. */
export interface DrawPlacement {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotDeg: number;
}

export function isIdentityTransform(t: AlignTransform): boolean {
  return t.dx === 0 && t.dy === 0 && t.zoom === 1 && t.rotDeg === 0;
}

export function clampRot(rotDeg: number): number {
  return Math.max(-MAX_ROT_DEG, Math.min(MAX_ROT_DEG, rotDeg));
}

/** The `object-fit: cover` scale factor: the image fills the canvas on both
 * axes, cropping whichever dimension overflows. */
export function coverScale(nat: NaturalSize, canvasW: number, canvasH: number): number {
  return Math.max(canvasW / nat.width, canvasH / nat.height);
}

export function placementFor(
  nat: NaturalSize,
  canvasW: number,
  canvasH: number,
  t: AlignTransform,
): DrawPlacement {
  const scale = coverScale(nat, canvasW, canvasH) * t.zoom;
  return {
    centerX: canvasW / 2 + t.dx * canvasW,
    centerY: canvasH / 2 + t.dy * canvasW,
    width: nat.width * scale,
    height: nat.height * scale,
    rotDeg: t.rotDeg,
  };
}

/** Fraction of a pixel tolerated on the coverage test so the exact-cover
 * identity state (drawn edge == canvas edge) never fails on floating-point
 * dust. Bisection always approaches from the covered side, so the tolerance
 * only ever makes the test MORE permissive at the exact boundary. */
const COVER_EPSILON_PX = 0.02;

/** The load-bearing rule: every canvas corner must land inside the drawn
 * (possibly rotated) image rect, or a bare-canvas gap would show — and bake. */
export function coversCanvas(
  nat: NaturalSize,
  canvasW: number,
  canvasH: number,
  t: AlignTransform,
): boolean {
  const p = placementFor(nat, canvasW, canvasH, t);
  const theta = (p.rotDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const corners: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [canvasW, 0],
    [0, canvasH],
    [canvasW, canvasH],
  ];
  for (const [cornerX, cornerY] of corners) {
    const relX = cornerX - p.centerX;
    const relY = cornerY - p.centerY;
    // Inverse-rotate the corner into the rect's own frame, where the test is
    // a plain axis-aligned bounds check.
    const localX = relX * cos + relY * sin;
    const localY = -relX * sin + relY * cos;
    if (
      Math.abs(localX) > p.width / 2 + COVER_EPSILON_PX ||
      Math.abs(localY) > p.height / 2 + COVER_EPSILON_PX
    ) {
      return false;
    }
  }
  return true;
}

function lerpTransform(a: AlignTransform, b: AlignTransform, alpha: number): AlignTransform {
  return {
    dx: a.dx + (b.dx - a.dx) * alpha,
    dy: a.dy + (b.dy - a.dy) * alpha,
    zoom: a.zoom + (b.zoom - a.zoom) * alpha,
    rotDeg: a.rotDeg + (b.rotDeg - a.rotDeg) * alpha,
  };
}

/** Moves from `base` (known-covered) toward `target`, returning the transform
 * that goes as far as possible WITHOUT breaking coverage — the whole move if
 * it covers, otherwise the bisection-found furthest covered point on the way.
 * A non-covered `base` "can't happen" by induction (identity covers and every
 * mutation passes through here) but falls back to identity rather than
 * propagate a gap into the bake. */
export function clampedToCoverage(
  nat: NaturalSize,
  canvasW: number,
  canvasH: number,
  base: AlignTransform,
  target: AlignTransform,
): AlignTransform {
  if (coversCanvas(nat, canvasW, canvasH, target)) return target;
  if (!coversCanvas(nat, canvasW, canvasH, base)) return { ...IDENTITY_TRANSFORM };
  let lo = 0; // covered (base)
  let hi = 1; // not covered (target)
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (coversCanvas(nat, canvasW, canvasH, lerpTransform(base, target, mid))) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lerpTransform(base, target, lo);
}

/** The smallest zoom that still covers at the current pan/tilt — the zoom
 * slider's dynamic floor. Coverage shrinks monotonically as zoom shrinks
 * (fixed pan/tilt), so the boundary bisects cleanly. Tilting or panning
 * RAISES this floor, which is why the slider's min is recomputed on every
 * redraw rather than fixed at 1. */
export function minCoveringZoom(
  nat: NaturalSize,
  canvasW: number,
  canvasH: number,
  t: AlignTransform,
): number {
  if (!coversCanvas(nat, canvasW, canvasH, t)) return t.zoom;
  const floor = 0.01;
  if (coversCanvas(nat, canvasW, canvasH, { ...t, zoom: floor })) return floor;
  let lo = floor; // not covered
  let hi = t.zoom; // covered
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (coversCanvas(nat, canvasW, canvasH, { ...t, zoom: mid })) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/** Applies a pan WITH auto-compensation, so a nudge always visibly moves the
 * photo: at zoom 1 a width-limited image has NO horizontal overflow, so a
 * plain coverage-clamp would bisect every ←/→ nudge back to ≈zero — a dead
 * button, and the first thing Purdi would report. Instead the pan lands in
 * full and is paid for with the smallest zoom that re-covers (bisection —
 * coverage grows monotonically with zoom at fixed pan/tilt). Only when even
 * `maxZoom` can't hold the requested pan does the pan itself clamp (at
 * `maxZoom`). The zoom cost is tiny in practice: a 1.5%-of-width nudge costs
 * ≈1.003×, and she was going to zoom a little to match framing anyway. */
export function withPanCompensated(
  nat: NaturalSize,
  canvasW: number,
  canvasH: number,
  base: AlignTransform,
  targetDx: number,
  targetDy: number,
  maxZoom: number,
): AlignTransform {
  const atCurrentZoom: AlignTransform = { ...base, dx: targetDx, dy: targetDy };
  if (coversCanvas(nat, canvasW, canvasH, atCurrentZoom)) return atCurrentZoom;
  const atMaxZoom: AlignTransform = { ...atCurrentZoom, zoom: maxZoom };
  if (!coversCanvas(nat, canvasW, canvasH, atMaxZoom)) {
    // Beyond the photo's reach entirely — clamp the pan at max zoom.
    return clampedToCoverage(nat, canvasW, canvasH, { ...base, zoom: maxZoom }, atMaxZoom);
  }
  let lo = base.zoom; // not covered at the requested pan
  let hi = maxZoom; // covered
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (coversCanvas(nat, canvasW, canvasH, { ...atCurrentZoom, zoom: mid })) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return { ...atCurrentZoom, zoom: hi };
}

/** Applies a tilt WITH the auto-compensation a tilt needs: a rotated rect no
 * longer covers the canvas corners at the same zoom, so the smallest zoom
 * that re-covers is found by bisection (coverage grows monotonically with
 * zoom at fixed pan/tilt, so the boundary bisects cleanly). Without this a
 * plain coverage-clamp would bisect the tilt itself back to ≈0° at zoom 1 —
 * a Straighten button that visibly does nothing. Returns `null` when even
 * `maxZoom` can't hold the tilt with the current pan (a state she can only
 * reach by panning far first — the tilt is then refused, never baked). */
export function withRotationCompensated(
  nat: NaturalSize,
  canvasW: number,
  canvasH: number,
  base: AlignTransform,
  targetRotDeg: number,
  maxZoom: number,
): AlignTransform | null {
  const rotDeg = clampRot(targetRotDeg);
  const targetFor = (zoom: number): AlignTransform => ({ ...base, rotDeg, zoom });
  if (coversCanvas(nat, canvasW, canvasH, targetFor(base.zoom))) {
    return targetFor(base.zoom);
  }
  if (!coversCanvas(nat, canvasW, canvasH, targetFor(maxZoom))) return null;
  let lo = base.zoom; // not covered
  let hi = maxZoom; // covered
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (coversCanvas(nat, canvasW, canvasH, targetFor(mid))) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return targetFor(hi);
}

/** The bake's pixel size: EXPORT_WIDTH wide, height from the registry's frame
 * aspect (16:9 → 1920×1080), so the exported photo maps 1:1 onto the live
 * frame with no further cover-crop — what she aligned is exactly what
 * publishes. */
export function exportSize(aspectW: number, aspectH: number): { width: number; height: number } {
  return { width: EXPORT_WIDTH, height: Math.round((EXPORT_WIDTH * aspectH) / aspectW) };
}
