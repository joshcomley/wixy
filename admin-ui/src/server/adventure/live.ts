// Adventure Time's live swipe trail (spec/server-chat/08-adventure-time.md §3.5): the dragger's
// sender, which batches the finger into `POST /adventure/live`, and every other screen's receiver,
// which turns the relayed `adventure_live` frames back into a turning globe and a pen stroke. The
// pacing rules are `drawingLive.ts`'s, deliberately. Neither side stores a live point: the committed
// spin (`POST …/spin` at release) is what decides the outcome, the live frames are cosmetic and lossy.
//
// Sender rules:
// - At most ONE live request in flight, and at most one every `LIVE_BATCH_INTERVAL_MS` (20 a second,
//   inside the server's 30), so a slow network carries more points per frame instead of queueing
//   requests, and frames can never overtake each other on the way.
// - A frame holds at most 32 points; the rest wait for the next one.
// - Each point travels with the globe rotation it was made at, so a frame's `rotation` always belongs to
//   its last point even when a long drag backs up.
// - A 429 pauses sending for the `Retry-After` the server gave; the points wait and go afterwards.
// - A finger held still re-sends the rotation every `LIVE_KEEPALIVE_MS`, so the other screen never takes
//   a pause for a dragger who vanished (it drops a drag idle for `LIVE_STROKE_TIMEOUT_MS`).
// - Every drag has its OWN `clientId`; the receiver tells drags apart by it and ignores its own.
//
// Receiver rules: a frame is ignored when it is this screen's own, for another round, for a spin the
// round no longer waits for (the context says so), or not newer than the last one of its drag. The
// receiver keeps a small JITTER BUFFER: it shows the dragger's state as it was `BUFFER_MS` ago, so the
// ~20 Hz frames arriving unevenly drive a globe that turns smoothly and a stroke that keeps the finger's
// own pace. The buffer is longer than the worst latency, so every frame it needs has already arrived.

import { LIVE_BATCH_INTERVAL_MS, LIVE_KEEPALIVE_MS, LIVE_STROKE_TIMEOUT_MS } from "../drawings";
import type { LivePostResult } from "../api/drawings";
import { LIVE_MAX_COORD, LIVE_MAX_POINTS, type AdventureAxis, type AdventureLiveFrame } from "./api";
import { Trail } from "./trail";

/** The longest drag the server accepts (`t` is at most this many ms after the drag began). */
const MAX_DRAG_MS = 600_000;
/** The watcher shows the dragger's state this long after it happened. */
export const BUFFER_MS = 160;
/** A finished drag's last rotation is held this long waiting for the committed spin to take over. */
export const HOLD_AFTER_END_MS = 8_000;
/** How many of this screen's own drag ids are remembered (to ignore the relay of them). */
const OWN_IDS = 16;

type Rotation = readonly [number, number];

// -- Sender --------------------------------------------------------------------------------------------

export interface LiveSenderDeps {
  /** Posts one frame. Resolves "locked" for a 401 (the caller locks the chat). */
  post(frame: AdventureLiveFrame): Promise<LivePostResult | "locked">;
  onLocked(): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  now(): number;
  /** A fresh 8..64 character id for each drag. */
  newId(): string;
}

export interface LiveSender {
  /**
   * A drag begins: `first` is the finger position in globe-radius units from the globe's centre and
   * `rotation` the globe's `[λ, φ]` now. Returns this drag's id.
   */
  begin(meta: { readonly anchorSeq: number; readonly axis: AdventureAxis }, first: Rotation, rotation: Rotation): string;
  /** The finger reached `point` and the globe is at `rotation`. */
  push(point: Rotation, rotation: Rotation): void;
  /** The finger lifted: the points still owed go out, closed with an `end` frame. */
  end(rotation: Rotation): void;
  /** The drag was withdrawn (a second finger, a lock, the page hiding): nothing more is sent but a
   * closing `end` frame, if any frame already went out. */
  cancel(): void;
  /** Lock or teardown: posts any owed `end` at once (bypassing the pacing, because nothing will run
   * afterwards), then forgets everything and clears every timer. */
  shutdown(): void;
  /** True for the id of a drag this screen made (recently). */
  owns(clientId: string): boolean;
  /** True while anything is still owed to the network (tests and teardown checks). */
  readonly busy: boolean;
}

interface OutPoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
  readonly rotation: Rotation;
}

interface OutDrag {
  readonly clientId: string;
  readonly anchorSeq: number;
  readonly axis: AdventureAxis;
  readonly startedAt: number;
  buffer: OutPoint[];
  rotation: Rotation;
  nextFrame: number;
  sentAny: boolean;
  finished: boolean;
  cancelled: boolean;
  endSent: boolean;
  lastSendAt: number;
}

function clampCoord(value: number): number {
  return Math.max(-LIVE_MAX_COORD, Math.min(LIVE_MAX_COORD, value));
}

export function createLiveSender(deps: LiveSenderDeps): LiveSender {
  const queue: OutDrag[] = [];
  const ownIds: string[] = [];
  let active: OutDrag | null = null;
  let inFlight = false;
  let pausedUntil = 0;
  let lastFrameAt = -Infinity;
  let timer: number | null = null;
  /** When the armed timer fires (`Infinity` with none armed). */
  let timerAt = Number.POSITIVE_INFINITY;
  let generation = 0;

  function clearTimer(): void {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    timerAt = Number.POSITIVE_INFINITY;
  }

  function pointOf(drag: OutDrag, point: Rotation, rotation: Rotation): OutPoint {
    const t = Math.max(0, Math.min(MAX_DRAG_MS, Math.round(deps.now() - drag.startedAt)));
    return { x: clampCoord(point[0]), y: clampCoord(point[1]), t, rotation };
  }

  function frameOf(drag: OutDrag, taken: readonly OutPoint[], end: boolean): AdventureLiveFrame {
    const last = taken[taken.length - 1];
    const frame: AdventureLiveFrame = {
      anchorSeq: drag.anchorSeq,
      clientId: drag.clientId,
      axis: drag.axis,
      rotation: last?.rotation ?? drag.rotation,
      points: taken.map((p) => [p.x, p.y, p.t] as const),
      frame: drag.nextFrame,
      end,
    };
    drag.nextFrame += 1;
    return frame;
  }

  function send(drag: OutDrag, frame: AdventureLiveFrame): void {
    inFlight = true;
    const sentAt = deps.now();
    lastFrameAt = sentAt;
    drag.lastSendAt = sentAt;
    drag.sentAny = true;
    if (frame.end) drag.endSent = true;
    const sentGeneration = generation;
    void deps.post(frame).then(
      (result) => {
        if (sentGeneration !== generation) return;
        inFlight = false;
        if (result === "locked") {
          deps.onLocked();
          return;
        }
        if (result.kind === "rate_limited") pausedUntil = deps.now() + result.retryAfterMs;
        schedule();
      },
      () => {
        if (sentGeneration !== generation) return;
        inFlight = false;
        schedule();
      },
    );
  }

  /** The next thing owed, oldest drag first; drags with nothing left are dropped. */
  function nextFrame(now: number): { drag: OutDrag; frame: AdventureLiveFrame } | null {
    while (queue.length > 0) {
      const drag = queue[0]!;
      if (drag.cancelled) {
        queue.shift();
        if (drag.sentAny && !drag.endSent) return { drag, frame: frameOf(drag, [], true) };
        continue;
      }
      if (drag.buffer.length > 0) {
        const taken = drag.buffer.splice(0, LIVE_MAX_POINTS);
        const closing = drag.finished && drag.buffer.length === 0;
        return { drag, frame: frameOf(drag, taken, closing) };
      }
      if (drag.finished) {
        if (!drag.endSent) return { drag, frame: frameOf(drag, [], true) };
        queue.shift();
        continue;
      }
      // The finger is down but still: keep the preview alive on the other screen.
      if (drag.sentAny && now - drag.lastSendAt >= LIVE_KEEPALIVE_MS) {
        return { drag, frame: frameOf(drag, [], false) };
      }
      return null;
    }
    return null;
  }

  function tick(): void {
    timer = null;
    timerAt = Number.POSITIVE_INFINITY;
    if (inFlight) return; // the response re-schedules
    const now = deps.now();
    if (now < pausedUntil || now - lastFrameAt < LIVE_BATCH_INTERVAL_MS) {
      schedule();
      return;
    }
    const next = nextFrame(now);
    if (next !== null) send(next.drag, next.frame);
    else schedule();
  }

  /** Arms the timer for the EARLIEST thing now owed (an armed timer due later is re-armed: a keepalive
   * armed while the finger was still must never hold back points or the end that arrive meanwhile). */
  function schedule(): void {
    if (inFlight) return; // the response re-schedules
    if (queue.length === 0) {
      clearTimer();
      return;
    }
    const now = deps.now();
    const head = queue[0]!;
    let at = Math.max(pausedUntil, lastFrameAt + LIVE_BATCH_INTERVAL_MS);
    const idle = !head.cancelled && head.buffer.length === 0 && !head.finished;
    if (idle) {
      // Only a keepalive is owed; it is due one keepalive period after the drag's last frame.
      at = Math.max(at, head.lastSendAt + LIVE_KEEPALIVE_MS);
    }
    if (timer !== null && timerAt <= at) return;
    clearTimer();
    timerAt = at;
    timer = deps.setTimeout(tick, Math.max(0, at - now));
  }

  return {
    begin(meta, first, rotation) {
      if (active !== null) active.finished = true;
      const clientId = deps.newId();
      ownIds.push(clientId);
      if (ownIds.length > OWN_IDS) ownIds.shift();
      const now = deps.now();
      active = {
        clientId,
        anchorSeq: meta.anchorSeq,
        axis: meta.axis,
        startedAt: now,
        buffer: [],
        rotation,
        nextFrame: 0,
        sentAny: false,
        finished: false,
        cancelled: false,
        endSent: false,
        lastSendAt: now,
      };
      active.buffer.push(pointOf(active, first, rotation));
      queue.push(active);
      schedule();
      return clientId;
    },
    push(point, rotation) {
      if (active === null) return;
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
      if (!Number.isFinite(rotation[0]) || !Number.isFinite(rotation[1])) return;
      if (Math.abs(rotation[0]) > 1e6 || Math.abs(rotation[1]) > 1e6) return;
      active.rotation = rotation;
      active.buffer.push(pointOf(active, point, rotation));
      schedule();
    },
    end(rotation) {
      if (active === null) return;
      if (Number.isFinite(rotation[0]) && Number.isFinite(rotation[1])) active.rotation = rotation;
      active.finished = true;
      active = null;
      schedule();
    },
    cancel() {
      if (active === null) return;
      active.cancelled = true;
      active.buffer = [];
      active = null;
      schedule();
    },
    shutdown() {
      if (active !== null) {
        active.cancelled = true;
        active.buffer = [];
        active = null;
      }
      const owed = queue.filter((drag) => drag.sentAny && !drag.endSent);
      generation += 1;
      queue.length = 0;
      inFlight = false;
      pausedUntil = 0;
      clearTimer();
      for (const drag of owed) void deps.post(frameOf(drag, [], true)).catch(() => {});
    },
    owns: (clientId) => ownIds.includes(clientId),
    get busy(): boolean {
      return queue.length > 0 || inFlight;
    },
  };
}

// -- Receiver ------------------------------------------------------------------------------------------

/** What the receiver needs to know about this screen's round to decide whether a frame still matters. */
export interface LiveContext {
  /** Whether this screen is showing round `anchorSeq` and is waiting for a spin on `axis` that has not
   * been committed yet. */
  waitingForSpin(anchorSeq: number, axis: AdventureAxis): boolean;
}

export interface LiveReceiverDeps {
  context: LiveContext;
  /** A drag this screen made itself (the server relays every frame to every stream, the sender's own
   * included). */
  isOwn(clientId: string): boolean;
}

export interface RemoteSwipe {
  readonly anchorSeq: number;
  readonly axis: AdventureAxis;
  /** The dragger's globe rotation as it should be shown now (the jitter-buffered one). */
  readonly rotation: Rotation;
  /** True while the finger is still down (not yet closed by an `end` frame or a timeout). */
  readonly fingerDown: boolean;
}

export type LiveApplyResult = "ignored" | "updated" | "ended";

interface RemoteDrag {
  readonly clientId: string;
  readonly anchorSeq: number;
  readonly axis: AdventureAxis;
  lastFrame: number;
  /** `localTime − senderTime` at the lowest latency seen: local time = sender time + offset. */
  offset: number;
  /** Rotation samples `[senderT, λ, φ]`, ascending in `t`. */
  samples: Array<readonly [number, number, number]>;
  /** Points not yet moved onto the trail, ascending in `t`. */
  waiting: Array<readonly [number, number, number]>;
  lastT: number;
  ended: boolean;
  endedAtLocal: number;
  updatedAt: number;
}

export interface LiveReceiver {
  apply(frame: AdventureLiveFrame, nowMs: number): LiveApplyResult;
  /** The jitter-buffered state at local time `nowMs` (moving due points onto `trail`), or null when
   * there is no drag to show. */
  current(nowMs: number): RemoteSwipe | null;
  /** The fading stroke of the drag being shown (`trail.prune` is the renderer's to call). */
  readonly trail: Trail;
  /** Drops a drag idle for `LIVE_STROKE_TIMEOUT_MS`, or a finished one held long enough. */
  sweep(nowMs: number): void;
  /** The committed spin took over (or the round moved on): forget the drag, keep the fading trail. */
  finish(): void;
  removeForAnchor(anchorSeq: number): void;
  clear(): void;
}

export function createLiveReceiver(deps: LiveReceiverDeps): LiveReceiver {
  const trail = new Trail();
  let drag: RemoteDrag | null = null;
  /** Ids of drags already finished or superseded: a straggling frame never revives them. */
  const finished: string[] = [];

  function remember(clientId: string): void {
    finished.push(clientId);
    if (finished.length > OWN_IDS * 2) finished.shift();
  }

  function sampleTime(frame: AdventureLiveFrame, previousT: number): number {
    const last = frame.points[frame.points.length - 1];
    return last === undefined ? previousT : last[2];
  }

  /** Rotation at sender time `t`, interpolated between the samples around it. */
  function rotationAt(d: RemoteDrag, t: number): Rotation {
    const first = d.samples[0];
    if (first === undefined) return [0, 0];
    if (t <= first[0]) return [first[1], first[2]];
    const last = d.samples[d.samples.length - 1] as readonly [number, number, number];
    if (t >= last[0]) return [last[1], last[2]];
    let i = 1;
    while (i < d.samples.length && (d.samples[i] as readonly [number, number, number])[0] < t) i += 1;
    const a = d.samples[i - 1] as readonly [number, number, number];
    const b = d.samples[i] as readonly [number, number, number];
    const span = Math.max(1, b[0] - a[0]);
    const k = (t - a[0]) / span;
    return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }

  /** Moves the points due at local time `nowMs` onto the trail, back-dated to when they are shown. */
  function flushPoints(d: RemoteDrag, nowMs: number): void {
    const shownT = nowMs - d.offset - BUFFER_MS;
    while (d.waiting.length > 0) {
      const p = d.waiting[0] as readonly [number, number, number];
      if (p[2] > shownT) break;
      d.waiting.shift();
      trail.add(p[0], p[1], d.offset + p[2] + BUFFER_MS);
    }
  }

  return {
    apply(frame, nowMs) {
      if (deps.isOwn(frame.clientId)) return "ignored";
      if (finished.includes(frame.clientId)) return "ignored";
      if (!deps.context.waitingForSpin(frame.anchorSeq, frame.axis)) return "ignored";
      let d = drag;
      if (d !== null && d.clientId === frame.clientId) {
        if (frame.frame <= d.lastFrame) return "ignored"; // not newer than what was already drawn
      } else {
        // A different drag (or the first one seen): the newest wins, whoever it was.
        if (d !== null) remember(d.clientId);
        const firstT = frame.points[0]?.[2] ?? 0;
        d = {
          clientId: frame.clientId,
          anchorSeq: frame.anchorSeq,
          axis: frame.axis,
          lastFrame: -1,
          offset: nowMs - firstT,
          samples: [],
          waiting: [],
          lastT: firstT,
          ended: false,
          endedAtLocal: 0,
          updatedAt: nowMs,
        };
        drag = d;
        trail.clear();
      }
      d.lastFrame = frame.frame;
      d.updatedAt = nowMs;
      const t = sampleTime(frame, d.lastT);
      // The lowest latency seen is the best estimate of the clock offset (later frames can only be late).
      d.offset = Math.min(d.offset, nowMs - t);
      d.lastT = Math.max(d.lastT, t);
      d.samples.push([t, frame.rotation[0], frame.rotation[1]]);
      for (const p of frame.points) d.waiting.push(p);
      if (frame.end) {
        d.ended = true;
        d.endedAtLocal = nowMs;
        return "ended";
      }
      return "updated";
    },
    current(nowMs) {
      const d = drag;
      if (d === null) return null;
      flushPoints(d, nowMs);
      const shownT = nowMs - d.offset - BUFFER_MS;
      return {
        anchorSeq: d.anchorSeq,
        axis: d.axis,
        rotation: rotationAt(d, shownT),
        fingerDown: !d.ended,
      };
    },
    trail,
    sweep(nowMs) {
      const d = drag;
      if (d === null) return;
      // A finger still down that stopped reporting is gone; a finished drag is held (below) instead.
      const idle = !d.ended && nowMs - d.updatedAt > LIVE_STROKE_TIMEOUT_MS;
      const held = d.ended && nowMs - d.endedAtLocal > HOLD_AFTER_END_MS;
      if (idle || held) {
        remember(d.clientId);
        drag = null;
      }
    },
    finish() {
      if (drag !== null) remember(drag.clientId);
      drag = null;
    },
    removeForAnchor(anchorSeq) {
      if (drag !== null && drag.anchorSeq === anchorSeq) {
        remember(drag.clientId);
        drag = null;
        trail.clear();
      }
    },
    clear() {
      drag = null;
      finished.length = 0;
      trail.clear();
    },
  };
}

