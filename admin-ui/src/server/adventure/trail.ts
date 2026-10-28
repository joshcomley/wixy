// Adventure Time — the swipe trail (spec/server-chat/08-adventure-time.md §3.5).
//
// While one person drags the globe, their finger leaves a pen-like stroke: 9 px wide at the newest
// point, tapering to nothing at the tail, each point fading out over 450 ms. The same stroke is drawn
// on the other person's screen from the points the dragger's phone relays, so the points live in
// GLOBE-RADIUS UNITS relative to the globe's centre (one unit = the globe's on-screen radius): any
// screen size maps them to its own pixels. A trail is never stored — it is cosmetic and gone in under
// half a second.
//
// `Trail` is the point store (local timestamps; remote batches are back-dated so a late-arriving batch
// still fades on schedule); `trailSamples` turns it into drawable points (position, width, alpha), pure
// and testable; `drawTrail` paints them as ONE tapered ribbon with a soft shadow (a single fill, so the
// translucent stroke has no darker joints). Under `prefers-reduced-motion` nothing is drawn.

/** A point fades out completely this long after it was added. */
export const FADE_MS = 450;
/** Stroke width at the newest point, CSS pixels. */
export const TRAIL_MAX_WIDTH_PX = 9;
/** A trail never holds more than this many points (a hostile or very fast source cannot grow it). */
export const TRAIL_MAX_POINTS = 256;
/** Points closer than this on screen (pixels) are one point as far as the ribbon is concerned. */
const MIN_SEGMENT_PX = 0.75;

export interface TrailPoint {
  /** Globe-radius units from the globe's centre (x right, y down). */
  readonly x: number;
  readonly y: number;
  /** Local time (ms, any monotonic origin shared with `nowMs`) the point was made or arrived. */
  readonly t: number;
}

/** What the live relay carries: `[x, y, t]`, `t` = ms since the drag began. */
export type RelayedPoint = readonly [number, number, number];

export class Trail {
  private list: TrailPoint[] = [];

  get size(): number {
    return this.list.length;
  }

  get points(): readonly TrailPoint[] {
    return this.list;
  }

  /** Adds a point made at local time `atMs`. Non-finite input is dropped; time never runs backwards. */
  add(x: number, y: number, atMs: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(atMs)) return;
    const last = this.list[this.list.length - 1];
    const t = last !== undefined && atMs < last.t ? last.t : atMs;
    this.list.push({ x, y, t });
    if (this.list.length > TRAIL_MAX_POINTS) this.list.splice(0, this.list.length - TRAIL_MAX_POINTS);
  }

  /**
   * Adds a relayed batch that has just arrived at local time `nowMs`: the batch's last point is "now",
   * earlier ones are back-dated by their gaps in the sender's clock (`t` ms since the drag began), so
   * the stroke keeps the shape and pace the dragger's finger had.
   */
  addBatch(points: readonly RelayedPoint[], nowMs: number): void {
    const last = points[points.length - 1];
    if (last === undefined || !Number.isFinite(nowMs)) return;
    for (const [x, y, t] of points) this.add(x, y, nowMs - Math.max(0, last[2] - t));
  }

  /** Drops points that have faded out completely by `nowMs`. Returns true while any remain. */
  prune(nowMs: number): boolean {
    let drop = 0;
    while (drop < this.list.length && nowMs - (this.list[drop] as TrailPoint).t >= FADE_MS) drop += 1;
    if (drop > 0) this.list.splice(0, drop);
    return this.list.length > 0;
  }

  clear(): void {
    this.list.length = 0;
  }

  /** True when nothing would be drawn at `nowMs`. */
  isEmpty(nowMs: number): boolean {
    const newest = this.list[this.list.length - 1];
    return newest === undefined || nowMs - newest.t >= FADE_MS;
  }
}

export interface TrailSample {
  /** Pixels. */
  readonly x: number;
  readonly y: number;
  /** Full stroke width at this point, pixels: 9 when brand new, 0 at `FADE_MS`. */
  readonly width: number;
  /** 0..1: 1 when brand new, 0 at `FADE_MS`. */
  readonly alpha: number;
}

/** 1 for a brand-new point, falling smoothly to 0 at `FADE_MS`. */
export function freshness(ageMs: number): number {
  if (!(ageMs < FADE_MS)) return 0;
  return ageMs <= 0 ? 1 : 1 - ageMs / FADE_MS;
}

/**
 * The drawable points of the trail at `nowMs`, oldest first: pixel positions around the globe centre
 * `(cx, cy)` of radius `radiusPx`, widths tapering from `TRAIL_MAX_WIDTH_PX` (newest) to 0 (the tail),
 * alpha fading with age. Points that have fully faded, and points a hair from the previous one, are
 * left out; the newest point is always kept. Does not modify the trail.
 */
export function trailSamples(trail: Trail, nowMs: number, cx: number, cy: number, radiusPx: number): TrailSample[] {
  const out: TrailSample[] = [];
  const source = trail.points;
  for (let i = 0; i < source.length; i += 1) {
    const p = source[i] as TrailPoint;
    const f = freshness(nowMs - p.t);
    if (f <= 0) continue;
    const x = cx + p.x * radiusPx;
    const y = cy + p.y * radiusPx;
    const previous = out[out.length - 1];
    const isNewest = i === source.length - 1;
    if (previous !== undefined && !isNewest && Math.hypot(x - previous.x, y - previous.y) < MIN_SEGMENT_PX) continue;
    if (previous !== undefined && isNewest && Math.hypot(x - previous.x, y - previous.y) < MIN_SEGMENT_PX) {
      out.pop(); // keep the newer (fresher) of two coincident points
    }
    out.push({ x, y, width: TRAIL_MAX_WIDTH_PX * f, alpha: f });
  }
  return out;
}

export interface TrailDrawOptions {
  /** Globe centre and radius in CSS pixels. */
  readonly cx: number;
  readonly cy: number;
  readonly radiusPx: number;
  readonly nowMs: number;
  /** `prefers-reduced-motion`: draw nothing. */
  readonly reducedMotion?: boolean;
  /** Device pixel ratio (the shadow blur is in device pixels). Default 1. */
  readonly dpr?: number;
}

/** Paints the trail as one tapered, round-capped, white ribbon with a soft shadow. */
export function drawTrail(ctx: CanvasRenderingContext2D, trail: Trail, o: TrailDrawOptions): void {
  if (o.reducedMotion === true) return;
  const s = trailSamples(trail, o.nowMs, o.cx, o.cy, o.radiusPx);
  const n = s.length;
  if (n === 0) return;
  const head = s[n - 1] as TrailSample;
  const dpr = o.dpr ?? 1;
  ctx.save();
  ctx.shadowColor = "rgba(0, 24, 52, 0.55)";
  ctx.shadowBlur = 7 * dpr;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1.5 * dpr;
  if (n === 1) {
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.95 * head.alpha).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(head.x, head.y, Math.max(0.5, head.width / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  const tail = s[0] as TrailSample;
  const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
  grad.addColorStop(0, `rgba(255, 255, 255, ${(0.95 * tail.alpha * 0.5).toFixed(3)})`);
  grad.addColorStop(1, `rgba(255, 255, 255, ${(0.95 * head.alpha).toFixed(3)})`);
  ctx.fillStyle = grad;

  // Offsets of both edges from the smoothed direction at each point.
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const a = s[Math.max(0, i - 1)] as TrailSample;
    const b = s[Math.min(n - 1, i + 1)] as TrailSample;
    const p = s[i] as TrailSample;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
    const half = p.width / 2;
    left.push([p.x - dy * half, p.y + dx * half]);
    right.push([p.x + dy * half, p.y - dx * half]);
  }
  ctx.beginPath();
  ctx.moveTo((left[0] as [number, number])[0], (left[0] as [number, number])[1]);
  traceSmooth(ctx, left);
  // Round cap on the newest point.
  const lastLeft = left[n - 1] as [number, number];
  const lastRight = right[n - 1] as [number, number];
  const capAngle = Math.atan2(lastLeft[1] - head.y, lastLeft[0] - head.x);
  ctx.arc(head.x, head.y, head.width / 2, capAngle, capAngle - Math.PI, true);
  ctx.lineTo(lastRight[0], lastRight[1]);
  traceSmooth(ctx, right.slice().reverse());
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Continues the current subpath through `pts` with quadratic curves between midpoints. */
function traceSmooth(ctx: CanvasRenderingContext2D, pts: ReadonlyArray<[number, number]>): void {
  const n = pts.length;
  if (n < 2) return;
  for (let i = 1; i < n - 1; i += 1) {
    const p = pts[i] as [number, number];
    const q = pts[i + 1] as [number, number];
    ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  const end = pts[n - 1] as [number, number];
  ctx.lineTo(end[0], end[1]);
}
