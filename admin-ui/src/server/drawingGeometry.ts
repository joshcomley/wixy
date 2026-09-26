// Live drawing — the pure geometry (spec/server-chat/07-live-drawing.md §1, §3, §5). No DOM, no
// timers: every function here takes plain numbers, so the mapping between screens, the anchor
// choice, the stroke simplification and Select-mode hit testing are unit-tested exactly.
//
// Two coordinate spaces:
// - VIEWER space: this screen's CSS px (client or thread-content coordinates).
// - DRAW space (§1): integer CSS px on the DRAWER's screen, `x` from the thread column's left edge
//   and `y` from the anchor bubble's top edge. A drawing also stores `columnWidth`, the drawer's
//   column width, so a viewer maps it with ONE uniform factor `s = viewer column / columnWidth`
//   applied to x, y and the stroke width alike: a circle stays a circle on every screen.

import {
  MAX_COLUMN_WIDTH,
  MAX_POINT_X_PAD,
  MAX_POINT_Y_ABS,
  MAX_POINTS_PER_STROKE,
  MIN_COLUMN_WIDTH,
  MIN_POINT_X,
  RDP_EPSILON_PX,
  SELECT_HIT_RADIUS_PX,
} from "./drawings";

export type DrawPoint = readonly [number, number];

/** An axis-aligned box in one coordinate space. */
export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The part of a stroke the geometry needs. */
export interface StrokeShape {
  readonly points: readonly DrawPoint[];
  readonly width: number;
}

/** The uniform draw-space -> viewer factor (§1). Never 0 or negative, even for a degenerate
 * input, so nothing downstream divides by zero. */
export function drawScale(viewerColumnWidth: number, drawingColumnWidth: number): number {
  if (!(viewerColumnWidth > 0) || !(drawingColumnWidth > 0)) return 1;
  return viewerColumnWidth / drawingColumnWidth;
}

/** The `columnWidth` a new drawing declares: the drawer's measured column, clamped into the
 * server's accepted range (a column narrower than 200 px still draws — its own scale then
 * differs from 1, which the uniform mapping handles like any other screen). */
export function declaredColumnWidth(measuredColumnWidth: number): number {
  const clamped = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, measuredColumnWidth));
  return Math.round(clamped * 100) / 100;
}

/** Viewer -> draw space for one point. `originX`/`originY` are where the draw-space origin
 * (the column's left edge, the anchor's top edge) currently sits in the same viewer
 * coordinates as `x`/`y`. */
export function toDrawSpace(x: number, y: number, originX: number, originY: number, scale: number): DrawPoint {
  return [(x - originX) / scale, (y - originY) / scale];
}

/** One point as the server accepts it (§3): integers, `x` within [-50, columnWidth + 50] and
 * `y` within ±20000. Only ever applied to points already inside a sane range — the column and
 * the anchor rule keep a real stroke far inside both bounds; this is the last guard. */
export function wirePoint(point: DrawPoint, columnWidth: number): DrawPoint {
  const maxX = Math.floor(columnWidth + MAX_POINT_X_PAD);
  const x = Math.min(maxX, Math.max(MIN_POINT_X, Math.round(point[0])));
  const y = Math.min(MAX_POINT_Y_ABS, Math.max(-MAX_POINT_Y_ABS, Math.round(point[1])));
  return [x, y];
}

function distanceToSegmentSquared(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** Ramer–Douglas–Peucker (§3), iterative so a long stroke cannot overflow the call stack.
 * Keeps the first and last points and every point further than `epsilon` from the chord of
 * the kept points around it. */
export function simplifyRdp(points: readonly DrawPoint[], epsilon: number): DrawPoint[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const epsilonSquared = epsilon * epsilon;
  const stack: Array<readonly [number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    const a = points[start]!;
    const b = points[end]!;
    let farthest = -1;
    let farthestDistance = epsilonSquared;
    for (let i = start + 1; i < end; i += 1) {
      const p = points[i]!;
      const d = distanceToSegmentSquared(p[0], p[1], a[0], a[1], b[0], b[1]);
      if (d > farthestDistance) {
        farthestDistance = d;
        farthest = i;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

function dedupeConsecutive(points: readonly DrawPoint[]): DrawPoint[] {
  const out: DrawPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last === undefined || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  return out;
}

/** A finished stroke's raw draw-space points, made ready to store (§3): simplified at
 * `RDP_EPSILON_PX`, rounded to integers inside the server's bounds, with consecutive duplicates
 * dropped. A tap (one distinct point) becomes a two-point dot. A stroke still over
 * `MAX_POINTS_PER_STROKE` points is re-simplified at a doubled tolerance until it fits, and
 * decimated evenly as a last resort, so a stroke is never refused for its length. Returns an
 * empty list only for an empty input. */
export function prepareStoredPoints(raw: readonly DrawPoint[], columnWidth: number): DrawPoint[] {
  const finite = raw.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (finite.length === 0) return [];
  let epsilon = RDP_EPSILON_PX;
  let points = dedupeConsecutive(simplifyRdp(finite, epsilon).map((point) => wirePoint(point, columnWidth)));
  for (let attempt = 0; points.length > MAX_POINTS_PER_STROKE && attempt < 12; attempt += 1) {
    epsilon *= 2;
    points = dedupeConsecutive(simplifyRdp(finite, epsilon).map((point) => wirePoint(point, columnWidth)));
  }
  if (points.length > MAX_POINTS_PER_STROKE) {
    const step = (points.length - 1) / (MAX_POINTS_PER_STROKE - 1);
    const decimated: DrawPoint[] = [];
    for (let i = 0; i < MAX_POINTS_PER_STROKE; i += 1) decimated.push(points[Math.round(i * step)]!);
    points = dedupeConsecutive(decimated);
  }
  if (points.length === 1) {
    const only = points[0]!;
    return [only, only];
  }
  return points;
}

/** The draw-space box that contains every stroke INCLUDING its thickness (half the width on
 * each side, plus 1 px for round caps' anti-aliasing), or null when there is nothing to show. */
export function strokesBounds(strokes: Iterable<StrokeShape>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    const pad = stroke.width / 2 + 1;
    for (const [x, y] of stroke.points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x - pad);
      minY = Math.min(minY, y - pad);
      maxX = Math.max(maxX, x + pad);
      maxY = Math.max(maxY, y + pad);
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/** Where one drawing's `<svg>` goes, in thread-content px, and the draw-space `viewBox` that
 * maps onto it at exactly `scale` (so the browser does the scaling, §1). Horizontally it is
 * clipped to `[clipLeft, clipRight]` (the thread's own width): a stroke that ran past the edge
 * must never widen the thread and give it a sideways scrollbar. Vertically it is never clipped —
 * a drawing below the last bubble is meant to grow the scrollable thread (§1). Null when
 * nothing of it is inside the clip. */
export interface SvgBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly viewBox: Bounds;
}

export function svgBox(
  bounds: Bounds,
  originX: number,
  originY: number,
  scale: number,
  clipLeft: number,
  clipRight: number,
): SvgBox | null {
  const left = Math.max(clipLeft, originX + bounds.minX * scale);
  const right = Math.min(clipRight, originX + bounds.maxX * scale);
  if (!(right > left)) return null;
  const top = originY + bounds.minY * scale;
  const height = (bounds.maxY - bounds.minY) * scale;
  if (!(height > 0)) return null;
  return {
    left,
    top,
    width: right - left,
    height,
    viewBox: {
      minX: (left - originX) / scale,
      minY: bounds.minY,
      maxX: (right - originX) / scale,
      maxY: bounds.maxY,
    },
  };
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** SVG path data for one polyline, built ONLY from finite numbers (§1: "Path data is built only
 * from validated numbers, never from a string the server echoes"). A single point draws a dot
 * (a zero-length segment with round caps). Empty for no usable point. */
export function pathData(points: readonly DrawPoint[]): string {
  const usable = points.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  const first = usable[0];
  if (first === undefined) return "";
  const parts = [`M${formatNumber(first[0])} ${formatNumber(first[1])}`];
  if (usable.length === 1) {
    parts.push(`L${formatNumber(first[0])} ${formatNumber(first[1])}`);
  } else {
    for (let i = 1; i < usable.length; i += 1) {
      const point = usable[i]!;
      parts.push(`L${formatNumber(point[0])} ${formatNumber(point[1])}`);
    }
  }
  return parts.join(" ");
}

/** Several polylines as one path (a live stroke arrives as separate batches — §4 — and a lost
 * batch then shows as a gap instead of an invented straight line). */
export function segmentsPathData(segments: readonly (readonly DrawPoint[])[]): string {
  return segments.map(pathData).filter((part) => part !== "").join(" ");
}

/** Distance from a point to a polyline (a single point is a dot). */
export function distanceToPolyline(x: number, y: number, points: readonly DrawPoint[]): number {
  const first = points[0];
  if (first === undefined) return Infinity;
  if (points.length === 1) return Math.hypot(x - first[0], y - first[1]);
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    best = Math.min(best, distanceToSegmentSquared(x, y, a[0], a[1], b[0], b[1]));
  }
  return Math.sqrt(best);
}

/** One drawing as Select mode sees it: its strokes in draw space, and where its origin sits on
 * THIS screen. */
export interface HitCandidate {
  readonly key: string;
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
  readonly strokes: readonly StrokeShape[];
}

/** §5 Select mode: the drawing with a stroke within `radiusPx` viewer px of the tap — measured
 * from the stroke's visible edge, so a thick line is as easy to hit as a thin one — or null.
 * When several qualify, the closest wins. */
export function hitTestDrawings(
  x: number,
  y: number,
  candidates: readonly HitCandidate[],
  radiusPx: number = SELECT_HIT_RADIUS_PX,
): string | null {
  let bestKey: string | null = null;
  let bestGap = Infinity;
  for (const candidate of candidates) {
    if (!(candidate.scale > 0)) continue;
    const [dx, dy] = toDrawSpace(x, y, candidate.originX, candidate.originY, candidate.scale);
    for (const stroke of candidate.strokes) {
      const halfWidth = (stroke.width * candidate.scale) / 2;
      const gap = distanceToPolyline(dx, dy, stroke.points) * candidate.scale - halfWidth;
      if (gap <= radiusPx && gap < bestGap) {
        bestGap = gap;
        bestKey = candidate.key;
      }
    }
  }
  return bestKey;
}

/** A message bubble a drawing could anchor to, with its top edge in the same viewer
 * coordinates as the point being tested. */
export interface AnchorCandidate {
  readonly seq: number;
  readonly top: number;
}

/** §1: the bubble whose top edge is the nearest one at or above `y`; if `y` is above every
 * bubble, the first (topmost) one — the drawing's offset is then negative. Null with no
 * bubbles at all (nothing to draw on). */
export function chooseAnchor(candidates: readonly AnchorCandidate[], y: number): AnchorCandidate | null {
  let above: AnchorCandidate | null = null;
  let topmost: AnchorCandidate | null = null;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.top)) continue;
    if (topmost === null || candidate.top < topmost.top) topmost = candidate;
    if (candidate.top <= y && (above === null || candidate.top > above.top)) above = candidate;
  }
  return above ?? topmost;
}
