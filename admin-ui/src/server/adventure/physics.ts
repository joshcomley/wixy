// Adventure Time — the spin physics (spec/server-chat/08-adventure-time.md §3.1).
//
// Pure maths, no DOM: a finger drags the globe (the globe follows it, `dragDeltaDeg`), and on release
// the finger's angular speed decides whether it was a flick and, if so, how far and for how long the
// globe keeps turning. The plan is a function of two numbers (`from`, `omega`), so the screen that
// made the move posts `{from, delta, durationMs}` and every other screen replays exactly the same
// motion from those stored values with `spinAngleAt`.
//
// The ease-out cubic starts at speed 3·Δ/D, and `D = 3·|Δ|/|ω|` before clamping, so the globe leaves
// the finger at the finger's own speed — the hand-off from drag to spin has no jerk.

/** Below this release speed (degrees per second) the globe just stays where it was dragged. */
export const MIN_FLICK_DEG_S = 120;

/** Spin distance bounds, degrees. The server validates the same numbers (spec §3.1). */
export const MIN_SPIN_DELTA_DEG = 720;
export const MAX_SPIN_DELTA_DEG = 3600;
/** Spin duration bounds, milliseconds (the server validates these too). */
export const MIN_SPIN_MS = 3500;
export const MAX_SPIN_MS = 7000;

/** Distance multiplier: a 1000°/s flick travels 1500°. */
const DISTANCE_PER_SPEED = 1.5;

/** A release velocity is taken over roughly this much of the drag's tail. */
export const VELOCITY_WINDOW_MS = 80;
/** A finger that stopped moving this long before it lifted released at (about) zero speed. */
export const PAUSE_BEFORE_RELEASE_MS = 60;
/** A speed needs at least this much time between its two end samples (unless the drag is shorter). */
const MIN_VELOCITY_SPAN_MS = 16;
/** Older samples are never useful; they are dropped as new ones arrive. */
const SAMPLE_HORIZON_MS = 400;

export interface SpinPlan {
  /** The angle (degrees) the spin starts from: where the finger let go. */
  readonly from: number;
  /** Signed distance to travel, degrees: `720 ≤ |delta| ≤ 3600`. */
  readonly delta: number;
  /** How long the whole spin takes, milliseconds: `3500 ≤ durationMs ≤ 7000`. */
  readonly durationMs: number;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

/** Smooth start and finish: the camera moves use this. */
export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * The spin a release at `omegaDegPerS` (signed) makes from angle `from`, or `null` when the release
 * was too slow to count as a flick (or `omega` is not a finite number).
 */
export function planSpin(from: number, omegaDegPerS: number): SpinPlan | null {
  if (!Number.isFinite(from) || !Number.isFinite(omegaDegPerS)) return null;
  const speed = Math.abs(omegaDegPerS);
  if (speed < MIN_FLICK_DEG_S) return null;
  const magnitude = clamp(speed * DISTANCE_PER_SPEED, MIN_SPIN_DELTA_DEG, MAX_SPIN_DELTA_DEG);
  const delta = Math.sign(omegaDegPerS) * magnitude;
  const durationMs = clamp(((3 * magnitude) / speed) * 1000, MIN_SPIN_MS, MAX_SPIN_MS);
  return { from, delta, durationMs };
}

/** The angle `elapsedMs` after the spin began; clamped to the start and to the end. */
export function spinAngleAt(plan: SpinPlan, elapsedMs: number): number {
  return plan.from + plan.delta * easeOutCubic(elapsedMs / plan.durationMs);
}

/** The angle the spin finishes on. */
export function spinEndAngle(plan: SpinPlan): number {
  return plan.from + plan.delta;
}

/** True once `elapsedMs` has reached the end of the spin. */
export function spinFinished(plan: SpinPlan, elapsedMs: number): boolean {
  return elapsedMs >= plan.durationMs;
}

/** Angular speed of the spin `elapsedMs` in (degrees per second, signed); 0 once finished. */
export function spinSpeedAt(plan: SpinPlan, elapsedMs: number): number {
  const t = elapsedMs / plan.durationMs;
  if (t >= 1) return 0;
  const u = 1 - clamp(t, 0, 1);
  return ((3 * plan.delta * u * u) / plan.durationMs) * 1000;
}

/**
 * How far (degrees) the globe turns when the finger moves `pixels` across a globe of `radiusPx`.
 * The sign is the caller's: dragging right/down by `dx`/`dy` is `rotation[0] += dragDeltaDeg(dx)` and
 * `rotation[1] -= dragDeltaDeg(dy)` (d3's φ lifts the content UP as it grows).
 */
export function dragDeltaDeg(pixels: number, radiusPx: number): number {
  if (!(radiusPx > 0) || !Number.isFinite(pixels)) return 0;
  return (pixels / radiusPx) * (180 / Math.PI);
}

interface Sample {
  readonly angle: number;
  readonly t: number;
}

/**
 * Release velocity of a drag. Feed it `(angle, time)` for every pointer move; ask `release(now)` when
 * the finger lifts. The speed is taken over the last `VELOCITY_WINDOW_MS` of movement, and a finger
 * that rested for more than `PAUSE_BEFORE_RELEASE_MS` before lifting releases at zero — it was held,
 * not flicked, however fast it travelled earlier.
 */
export class VelocityTracker {
  private samples: Sample[] = [];

  /** Forget everything (a new drag begins). */
  reset(): void {
    this.samples.length = 0;
  }

  /** Records that the dragged angle (degrees, unwrapped) was `angle` at time `tMs`. */
  add(angle: number, tMs: number): void {
    if (!Number.isFinite(angle) || !Number.isFinite(tMs)) return;
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && tMs < last.t) return; // a clock that stepped backwards: ignore the sample
    if (last !== undefined && tMs === last.t) {
      this.samples[this.samples.length - 1] = { angle, t: tMs };
    } else {
      this.samples.push({ angle, t: tMs });
    }
    let drop = 0;
    while (drop < this.samples.length - 2 && tMs - (this.samples[drop + 1] as Sample).t > SAMPLE_HORIZON_MS) drop += 1;
    if (drop > 0) this.samples.splice(0, drop);
  }

  /** Number of samples currently held (tests). */
  get size(): number {
    return this.samples.length;
  }

  /**
   * The signed angular velocity (degrees per second) at the moment of release `releaseMs`. Zero when
   * there are fewer than two samples or the finger paused before lifting.
   */
  release(releaseMs: number): number {
    const n = this.samples.length;
    if (n < 2) return 0;
    const last = this.samples[n - 1] as Sample;
    if (releaseMs - last.t > PAUSE_BEFORE_RELEASE_MS) return 0;
    // The oldest sample inside the window; if only the newest is inside it, the one before it, so a
    // slow, sparse drag still has two points to take a speed from.
    let first = n - 1;
    while (first > 0 && last.t - (this.samples[first - 1] as Sample).t <= VELOCITY_WINDOW_MS) first -= 1;
    if (first === n - 1) first = n - 2;
    // Two events a couple of milliseconds apart are mostly rounding noise: reach back for a longer span.
    while (first > 0 && last.t - (this.samples[first] as Sample).t < MIN_VELOCITY_SPAN_MS) first -= 1;
    const a = this.samples[first] as Sample;
    const dt = last.t - a.t;
    if (!(dt > 0)) return 0;
    return ((last.angle - a.angle) / dt) * 1000;
  }
}
