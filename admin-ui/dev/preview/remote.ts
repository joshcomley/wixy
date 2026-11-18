// Adventure Time preview — "play the other person": a recorded-style swipe replayed exactly the way
// the watching phone will see it.
//
// What goes over the wire (spec §3.5): every <= 50 ms the dragger's phone sends the finger points made
// since the last frame (globe-radius units, `t` = ms since the drag began) and the globe's rotation.
// A frame arrives 60-140 ms later, unevenly. Drawn the moment they arrive, the rotation would stutter at
// 20 Hz, so the watcher keeps a small JITTER BUFFER: it shows the dragger's state as it was
// `BUFFER_MS` ago, and because the buffer is longer than the worst latency every frame it needs has
// already arrived. The trail uses the same buffer, so the pen stroke and the turning globe stay in step.
// When the dragger lets go, the committed spin starts from the last rotation they sent — seamless.

import { VelocityTracker, dragDeltaDeg, planSpin, type SpinPlan } from "../../src/server/adventure/physics";
import type { Trail } from "../../src/server/adventure/trail";

export type Axis = "lng" | "lat";

/** The watcher shows the dragger's state this long after it happened. */
export const BUFFER_MS = 160;
/** The sender's frame period (<= 20 frames a second). */
export const FRAME_MS = 50;

interface FingerPoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
  /** The globe angle (degrees, along the axis) the finger had dragged it to at `t`. */
  readonly angle: number;
}

function between(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export class RemoteSwipe {
  readonly plan: SpinPlan;
  /** Local time (ms) the committed spin starts: release time plus the buffer. */
  readonly planStartMs: number;
  /** Rotation along the axis the instant the finger lifts. */
  readonly releaseAngle: number;

  private readonly points: FingerPoint[] = [];
  private readonly frameTimes: number[] = [];
  private readonly frameAngles: number[] = [];
  private nextPoint = 0;
  private readonly startMs: number;
  private readonly startAngle: number;

  /**
   * @param axis which way this swipe goes
   * @param startAngle the globe angle along the axis when the finger lands
   * @param startMs local time the dragger's finger lands
   */
  constructor(readonly axis: Axis, startAngle: number, startMs: number, rng: () => number) {
    this.startMs = startMs;
    this.startAngle = startAngle;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      this.points.length = 0;
      const plan = this.generate(rng);
      if (plan !== null) {
        this.plan = plan;
        this.releaseAngle = this.points[this.points.length - 1]?.angle ?? startAngle;
        this.planStartMs = startMs + BUFFER_MS + (this.points[this.points.length - 1]?.t ?? 0);
        this.buildFrames();
        return;
      }
    }
    // Practically unreachable (the generator aims well above the flick threshold): fall back to a hard swipe.
    this.points.length = 0;
    const plan = this.generate(rng, 1.4);
    this.plan = plan ?? { from: startAngle, delta: 900, durationMs: 4500 };
    this.releaseAngle = this.points[this.points.length - 1]?.angle ?? startAngle;
    this.planStartMs = startMs + BUFFER_MS + (this.points[this.points.length - 1]?.t ?? 0);
    this.buildFrames();
  }

  /** Total drag time, ms. */
  get dragMs(): number {
    return this.points[this.points.length - 1]?.t ?? 0;
  }

  private generate(rng: () => number, boost = 1): SpinPlan | null {
    const durationMs = between(rng, 150, 270);
    const length = between(rng, 0.5, 0.85) * boost; // globe radii
    const sign = rng() < 0.5 ? -1 : 1;
    const power = between(rng, 1.7, 2.3); // the finger accelerates into the flick
    const across = between(rng, 0.2, 0.5) * (rng() < 0.5 ? -1 : 1); // where on the globe the swipe happens
    const wobble = between(rng, 0.02, 0.06);
    const tracker = new VelocityTracker();
    const stepMs = 8;
    for (let t = 0; ; t += stepMs) {
      const tt = Math.min(t, durationMs);
      const u = tt / durationMs;
      const travelled = sign * length * u ** power;
      const sideways = wobble * Math.sin(u * Math.PI * 1.3);
      let x: number;
      let y: number;
      let angle: number;
      if (this.axis === "lng") {
        x = -sign * length * 0.5 + travelled;
        y = across + sideways;
        angle = this.startAngle + dragDeltaDeg(travelled, 1);
      } else {
        // Dragging UP raises phi: the finger moves to negative y.
        x = across * 0.6 + sideways;
        y = sign * length * 0.5 - travelled;
        angle = this.startAngle + dragDeltaDeg(travelled, 1);
      }
      this.points.push({ x, y, t: tt, angle });
      tracker.add(angle, tt);
      if (tt >= durationMs) break;
    }
    return planSpin(this.points[this.points.length - 1]?.angle ?? this.startAngle, tracker.release(durationMs + 4), this.axis, rng());
  }

  private buildFrames(): void {
    // The rotation the dragger sends in each frame (and at the very start and end).
    const end = this.dragMs;
    this.frameTimes.push(0);
    this.frameAngles.push(this.startAngle);
    for (let t = FRAME_MS; t < end; t += FRAME_MS) {
      this.frameTimes.push(t);
      this.frameAngles.push(this.angleAtSender(t));
    }
    this.frameTimes.push(end);
    this.frameAngles.push(this.releaseAngle);
  }

  private angleAtSender(t: number): number {
    let last: FingerPoint | undefined;
    for (const p of this.points) {
      if (p.t > t) break;
      last = p;
    }
    return last?.angle ?? this.startAngle;
  }

  /**
   * Advances the replay to local time `nowMs`: adds the finger points that are due to the watcher's
   * `trail` and returns the globe angle to show. Before the finger lands it returns the start angle;
   * after the lift it holds the release angle (the committed spin takes over at `planStartMs`).
   */
  update(nowMs: number, trail: Trail): number {
    const shown = nowMs - this.startMs - BUFFER_MS; // sender time the watcher is showing
    while (this.nextPoint < this.points.length) {
      const p = this.points[this.nextPoint] as FingerPoint;
      if (p.t > shown) break;
      trail.add(p.x, p.y, this.startMs + BUFFER_MS + p.t);
      this.nextPoint += 1;
    }
    if (shown <= 0) return this.startAngle;
    const n = this.frameTimes.length;
    if (shown >= (this.frameTimes[n - 1] as number)) return this.releaseAngle;
    let i = 1;
    while (i < n && (this.frameTimes[i] as number) < shown) i += 1;
    const t0 = this.frameTimes[i - 1] as number;
    const t1 = this.frameTimes[i] as number;
    const a0 = this.frameAngles[i - 1] as number;
    const a1 = this.frameAngles[i] as number;
    return a0 + ((a1 - a0) * (shown - t0)) / Math.max(1, t1 - t0);
  }

  /** The finger points, for the recorded-swipe replay in the debug view. */
  get recorded(): ReadonlyArray<readonly [number, number, number]> {
    return this.points.map((p) => [p.x, p.y, p.t] as const);
  }
}
