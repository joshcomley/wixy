// Live drawing — the lossy "live" channel (spec/server-chat/07-live-drawing.md §4): the drawer's
// sender, which batches in-progress points into `POST /drawings/live`, and every other screen's
// receiver, which turns the relayed `drawing_live` frames back into strokes. Neither side ever
// stores a live point: the stored stroke (`POST .../strokes` on pointer-up) replaces the preview.
//
// Sender rules:
// - At most ONE live request in flight, and at most one every `LIVE_BATCH_INTERVAL_MS` (so at
//   most 20 a second, inside the server's 30): a slow network then carries more points per batch
//   instead of queueing requests, and batches can never overtake each other on the way.
// - Each batch after a stroke's first starts with the previous batch's last point, so the
//   receiver draws the batches as connected pieces, and a batch lost on the way shows as a gap
//   rather than an invented straight line.
// - `batch` increases per stroke — also across a cancel — so a receiver ignores anything older
//   than what it has already drawn.
// - A 429 pauses sending for the `Retry-After` the server gave; the points wait and go afterwards.
// - A finger held still re-sends its last point every `LIVE_KEEPALIVE_MS`, so the other screen
//   never takes a pause for a drawer who vanished (it drops a stroke idle for 5 s).
//
// Receiver rules: frames for this screen's OWN drawings are ignored (the server relays to every
// stream, the drawer's included); so is a frame for a stroke already stored, cancelled, or older
// than one already drawn; a stroke not updated for `LIVE_STROKE_TIMEOUT_MS` is dropped.

import type { LivePostResult, LiveFrame } from "./api/drawings";
import type { DrawPoint } from "./drawingGeometry";
import {
  LIVE_BATCH_INTERVAL_MS,
  LIVE_KEEPALIVE_MS,
  LIVE_STROKE_TIMEOUT_MS,
  MAX_LIVE_POINTS_PER_BATCH,
  type DrawingColor,
  type DrawingWidth,
} from "./drawings";

/** What never changes over one stroke's live batches. */
export interface LiveStrokeMeta {
  readonly drawingClientId: string;
  readonly anchorSeq: number;
  readonly columnWidth: number;
  readonly strokeId: string;
  readonly color: DrawingColor;
  readonly width: DrawingWidth;
}

export interface OutgoingLiveFrame extends LiveStrokeMeta {
  readonly batch: number;
  readonly points: readonly DrawPoint[];
  readonly cancel?: true;
}

export interface LiveSenderDeps {
  /** Posts one frame. Resolves "locked" for a 401 (the caller locks the chat). */
  post(frame: OutgoingLiveFrame): Promise<LivePostResult | "locked">;
  onLocked(): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  now(): number;
}

export interface LiveSender {
  /** A new stroke starts at `first` (draw space, already a wire point). */
  begin(meta: LiveStrokeMeta, first: DrawPoint): void;
  /** The current stroke reached `point`. */
  push(point: DrawPoint): void;
  /** The current stroke ended normally (pointer up): its remaining points still go out. */
  end(): void;
  /** The current stroke was withdrawn (§5: a second finger, a lock, the page hiding): anything
   * not yet sent is dropped, and a `cancel` frame follows if any batch already went out. */
  cancel(): void;
  /** An already-finished stroke was undone: sends a live cancel frame so receivers drop it immediately. */
  cancelStroke(meta: LiveStrokeMeta): void;
  /** Lock or teardown: posts any owed `cancel` at once (bypassing the pacing, because nothing
   * will run afterwards), then forgets everything and clears every timer. */
  shutdown(): void;
  /** True while anything is still owed to the network (tests and teardown checks). */
  readonly busy: boolean;
}

interface OutStroke {
  readonly meta: LiveStrokeMeta;
  buffer: DrawPoint[];
  lastSent: DrawPoint | null;
  nextBatch: number;
  sentAny: boolean;
  ended: boolean;
  cancelled: boolean;
  lastSendAt: number;
}

function samePoint(a: DrawPoint | null | undefined, b: DrawPoint): boolean {
  return a !== null && a !== undefined && a[0] === b[0] && a[1] === b[1];
}

export function createLiveSender(deps: LiveSenderDeps): LiveSender {
  const queue: OutStroke[] = [];
  let active: OutStroke | null = null;
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

  function frameOf(stroke: OutStroke, points: readonly DrawPoint[], cancel: boolean): OutgoingLiveFrame {
    const frame: OutgoingLiveFrame = {
      ...stroke.meta,
      batch: stroke.nextBatch,
      points,
      ...(cancel ? { cancel: true as const } : {}),
    };
    stroke.nextBatch += 1;
    return frame;
  }

  function send(stroke: OutStroke, frame: OutgoingLiveFrame): void {
    inFlight = true;
    const sentAt = deps.now();
    lastFrameAt = sentAt;
    stroke.lastSendAt = sentAt;
    if (frame.cancel !== true) stroke.sentAny = true;
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

  /** The next thing owed, oldest stroke first; strokes with nothing left are dropped. */
  function nextFrame(now: number): { stroke: OutStroke; frame: OutgoingLiveFrame } | null {
    while (queue.length > 0) {
      const stroke = queue[0]!;
      if (stroke.cancelled) {
        queue.shift();
        if (stroke.sentAny) return { stroke, frame: frameOf(stroke, [], true) };
        continue;
      }
      if (stroke.buffer.length > 0) {
        const room = MAX_LIVE_POINTS_PER_BATCH - (stroke.lastSent === null ? 0 : 1);
        const fresh = stroke.buffer.splice(0, room);
        const points = stroke.lastSent === null ? fresh : [stroke.lastSent, ...fresh];
        stroke.lastSent = points[points.length - 1] ?? stroke.lastSent;
        return { stroke, frame: frameOf(stroke, points, false) };
      }
      if (stroke.ended) {
        queue.shift();
        continue;
      }
      // The finger is down but still: keep the preview alive on the other screen.
      if (stroke.lastSent !== null && now - stroke.lastSendAt >= LIVE_KEEPALIVE_MS) {
        return { stroke, frame: frameOf(stroke, [stroke.lastSent], false) };
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
    if (next !== null) send(next.stroke, next.frame);
    else schedule();
  }

  /** Arms the timer for the EARLIEST thing now owed. An armed timer due later is re-armed — a
   * keepalive armed while the finger was still must never hold back the points, the end or the
   * next stroke that arrive meanwhile (measured: a "draw, pause, lift, draw again" held the new
   * stroke's preview back until the old keepalive fired, up to `LIVE_KEEPALIVE_MS`). */
  function schedule(): void {
    if (inFlight) return; // the response re-schedules
    if (queue.length === 0) {
      clearTimer();
      return;
    }
    const now = deps.now();
    const head = queue[0]!;
    let at = Math.max(pausedUntil, lastFrameAt + LIVE_BATCH_INTERVAL_MS);
    if (!head.cancelled && head.buffer.length === 0 && !head.ended) {
      // Only a keepalive is owed; it is due one keepalive period after the stroke's last frame.
      at = Math.max(at, head.lastSendAt + LIVE_KEEPALIVE_MS);
    }
    if (timer !== null && timerAt <= at) return;
    clearTimer();
    timerAt = at;
    timer = deps.setTimeout(tick, Math.max(0, at - now));
  }

  return {
    begin(meta: LiveStrokeMeta, first: DrawPoint): void {
      if (active !== null) active.ended = true;
      active = {
        meta,
        buffer: [first],
        lastSent: null,
        nextBatch: 0,
        sentAny: false,
        ended: false,
        cancelled: false,
        lastSendAt: deps.now(),
      };
      queue.push(active);
      schedule();
    },
    push(point: DrawPoint): void {
      if (active === null) return;
      const last = active.buffer[active.buffer.length - 1] ?? active.lastSent;
      if (samePoint(last, point)) return;
      active.buffer.push(point);
      schedule();
    },
    end(): void {
      if (active === null) return;
      active.ended = true;
      active = null;
      schedule();
    },
    cancel(): void {
      if (active === null) return;
      active.cancelled = true;
      active.buffer = [];
      active = null;
      schedule();
    },
    cancelStroke(meta: LiveStrokeMeta): void {
      const frame: OutgoingLiveFrame = {
        ...meta,
        batch: 999_999,
        points: [],
        cancel: true,
      };
      void deps.post(frame).catch(() => {});
    },
    shutdown(): void {
      if (active !== null) {
        active.cancelled = true;
        active.buffer = [];
        active = null;
      }
      const owed = queue.filter((stroke) => stroke.cancelled && stroke.sentAny);
      generation += 1;
      queue.length = 0;
      inFlight = false;
      pausedUntil = 0;
      clearTimer();
      for (const stroke of owed) {
        void deps.post(frameOf(stroke, [], true)).catch(() => {});
      }
    },
    get busy(): boolean {
      return queue.length > 0 || inFlight;
    },
  };
}

// -- Receiver ------------------------------------------------------------------------------

/** Another screen's stroke while it is being drawn. `segments` are its batches in order. */
export interface LiveStroke {
  readonly strokeId: string;
  readonly drawingClientId: string;
  readonly anchorSeq: number;
  readonly columnWidth: number;
  readonly color: DrawingColor;
  readonly width: DrawingWidth;
  readonly segments: DrawPoint[][];
  lastBatch: number;
  updatedAt: number;
}

export type LiveApplyResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "updated"; readonly stroke: LiveStroke }
  | { readonly kind: "removed"; readonly strokeId: string };

export interface LiveReceiverDeps {
  /** A drawing this screen is drawing itself (§4: "A client ignores live frames for a drawing
   * it is drawing itself"). */
  isOwnDrawing(drawingClientId: string): boolean;
  /** A stroke this screen already shows as stored (or is drawing): its preview is over. */
  isKnownStroke(strokeId: string): boolean;
}

export interface LiveReceiver {
  apply(frame: LiveFrame, now: number): LiveApplyResult;
  /** Drops strokes not updated for `LIVE_STROKE_TIMEOUT_MS`; returns their ids. */
  sweep(now: number): string[];
  /** The stored version arrived: drop the preview for good. */
  finish(strokeId: string, now: number): boolean;
  /** The anchor message is gone: drop every preview anchored to it. */
  removeForAnchor(seq: number): string[];
  clear(): void;
  strokes(): IterableIterator<LiveStroke>;
  readonly size: number;
}

/** How long a finished (stored or cancelled) stroke id is remembered, so a straggling frame
 * relayed after it can never bring the preview back. Far past any realistic relay delay. */
const FINISHED_MEMORY_MS = 60_000;

export function createLiveReceiver(deps: LiveReceiverDeps): LiveReceiver {
  const live = new Map<string, LiveStroke>();
  const finished = new Map<string, number>();

  function markFinished(strokeId: string, now: number): void {
    finished.set(strokeId, now);
  }

  return {
    apply(frame: LiveFrame, now: number): LiveApplyResult {
      if (deps.isOwnDrawing(frame.drawingClientId)) return { kind: "ignored" };
      if (finished.has(frame.strokeId) || deps.isKnownStroke(frame.strokeId)) return { kind: "ignored" };
      const existing = live.get(frame.strokeId);
      if (existing !== undefined && frame.batch <= existing.lastBatch) return { kind: "ignored" };
      if (frame.cancel) {
        markFinished(frame.strokeId, now);
        if (existing === undefined) return { kind: "ignored" };
        live.delete(frame.strokeId);
        return { kind: "removed", strokeId: frame.strokeId };
      }
      if (existing === undefined) {
        const stroke: LiveStroke = {
          strokeId: frame.strokeId,
          drawingClientId: frame.drawingClientId,
          anchorSeq: frame.anchorSeq,
          columnWidth: frame.columnWidth,
          color: frame.color,
          width: frame.width,
          segments: [frame.points.slice()],
          lastBatch: frame.batch,
          updatedAt: now,
        };
        live.set(frame.strokeId, stroke);
        return { kind: "updated", stroke };
      }
      existing.segments.push(frame.points.slice());
      existing.lastBatch = frame.batch;
      existing.updatedAt = now;
      return { kind: "updated", stroke: existing };
    },
    sweep(now: number): string[] {
      const dropped: string[] = [];
      for (const [strokeId, stroke] of live) {
        if (now - stroke.updatedAt > LIVE_STROKE_TIMEOUT_MS) {
          live.delete(strokeId);
          dropped.push(strokeId);
        }
      }
      for (const [strokeId, at] of finished) {
        if (now - at > FINISHED_MEMORY_MS) finished.delete(strokeId);
      }
      return dropped;
    },
    finish(strokeId: string, now: number): boolean {
      markFinished(strokeId, now);
      return live.delete(strokeId);
    },
    removeForAnchor(seq: number): string[] {
      const dropped: string[] = [];
      for (const [strokeId, stroke] of live) {
        if (stroke.anchorSeq === seq) {
          live.delete(strokeId);
          dropped.push(strokeId);
        }
      }
      return dropped;
    },
    clear(): void {
      live.clear();
      finished.clear();
    },
    strokes(): IterableIterator<LiveStroke> {
      return live.values();
    },
    get size(): number {
      return live.size;
    },
  };
}
