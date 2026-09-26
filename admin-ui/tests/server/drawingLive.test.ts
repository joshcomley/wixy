// The live-drawing transport (spec/server-chat/07-live-drawing.md §4): the sender's pacing,
// batching, overlap, backpressure and lifecycle rules, and the receiver's ordering/ignore/timeout
// rules. `createLiveSender` takes injected time/timer/post functions, so every sender test below
// drives a small deterministic fake clock + timer queue instead of real timers or real network
// delay; `post()` resolves only when a test explicitly says so, so "one request in flight" can be
// held open for as long as a test needs. The receiver takes an explicit `now` per call, so its
// tests need no clock at all.

import { describe, expect, it, vi } from "vitest";
import type { DrawPoint } from "../../src/server/drawingGeometry";
import type { LiveFrame, LivePostResult } from "../../src/server/api/drawings";
import {
  LIVE_BATCH_INTERVAL_MS,
  LIVE_KEEPALIVE_MS,
  LIVE_STROKE_TIMEOUT_MS,
  MAX_LIVE_POINTS_PER_BATCH,
  type DrawingColor,
  type DrawingWidth,
} from "../../src/server/drawings";
import {
  createLiveReceiver,
  createLiveSender,
  type LiveApplyResult,
  type LiveReceiverDeps,
  type LiveSender,
  type LiveSenderDeps,
  type LiveStroke,
  type LiveStrokeMeta,
  type OutgoingLiveFrame,
} from "../../src/server/drawingLive";

// -- Shared fixtures -----------------------------------------------------------------------------

const COLOR: DrawingColor = "#ff3b30";
const WIDTH: DrawingWidth = 4;

function pt(x: number, y: number): DrawPoint {
  return [x, y];
}

function makeMeta(overrides: Partial<LiveStrokeMeta> = {}): LiveStrokeMeta {
  return {
    drawingClientId: "drawer-device-1",
    anchorSeq: 42,
    columnWidth: 400,
    strokeId: "stroke-1",
    color: COLOR,
    width: WIDTH,
    ...overrides,
  };
}

// -- Fake clock / timer queue (sender only) -------------------------------------------------------

/** A fully deterministic fake clock + timer queue for `LiveSenderDeps`. `advance(ms)` runs every
 * timer due at or before `now() + ms`, in due-time order — each seeing `now()` as its own due
 * time, exactly like a real scheduler stepping through time — then lands `now()` on the requested
 * end time. Promise settlement is a separate step (see `flushMicrotasks`): advancing time never
 * itself resolves a `post()` call. */
interface FakeClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly advance: (ms: number) => void;
}

function createFakeClock(): FakeClock {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { readonly due: number; readonly cb: () => void }>();

  function advance(ms: number): void {
    const end = t + ms;
    for (;;) {
      let earliestId: number | null = null;
      let earliestDue = Infinity;
      for (const [id, timer] of timers) {
        if (timer.due <= end && (earliestId === null || timer.due < earliestDue)) {
          earliestId = id;
          earliestDue = timer.due;
        }
      }
      if (earliestId === null) break;
      const timer = timers.get(earliestId)!;
      timers.delete(earliestId);
      t = timer.due;
      timer.cb();
    }
    t = end;
  }

  return {
    now: () => t,
    setTimeout: (callback: () => void, ms: number): number => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { due: t + Math.max(0, ms), cb: callback });
      return id;
    },
    clearTimeout: (id: number): void => {
      timers.delete(id);
    },
    advance,
  };
}

// -- post() spy (sender only) ---------------------------------------------------------------------

/** Records every frame `createLiveSender` posts and lets a test resolve or reject them one at a
 * time, independently of the fake clock. */
interface PostSpy {
  readonly post: (frame: OutgoingLiveFrame) => Promise<LivePostResult | "locked">;
  readonly calls: OutgoingLiveFrame[];
  readonly pendingCount: number;
  resolveNext(result?: LivePostResult | "locked"): void;
  rejectNext(error?: unknown): void;
}

function createPostSpy(): PostSpy {
  const calls: OutgoingLiveFrame[] = [];
  const resolvers: Array<{ resolve: (result: LivePostResult | "locked") => void; reject: (error: unknown) => void }> = [];
  return {
    post: (frame: OutgoingLiveFrame): Promise<LivePostResult | "locked"> => {
      calls.push(frame);
      return new Promise((resolve, reject) => {
        resolvers.push({ resolve, reject });
      });
    },
    calls,
    get pendingCount(): number {
      return resolvers.length;
    },
    resolveNext(result: LivePostResult | "locked" = { kind: "ok" }): void {
      const next = resolvers.shift();
      if (next === undefined) throw new Error("createPostSpy: no pending post() call to resolve");
      next.resolve(result);
    },
    rejectNext(error: unknown = new Error("network error")): void {
      const next = resolvers.shift();
      if (next === undefined) throw new Error("createPostSpy: no pending post() call to reject");
      next.reject(error);
    },
  };
}

/** Lets an already-settled promise's `.then` reaction actually run before the next assertion. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function makeSender(clock: FakeClock, post: PostSpy["post"], onLocked: () => void = vi.fn()): LiveSender {
  const deps: LiveSenderDeps = {
    post,
    onLocked,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  };
  return createLiveSender(deps);
}

// -- Sender ----------------------------------------------------------------------------------------

describe("createLiveSender", () => {
  it("begin() sends the first point promptly (no interval wait), at batch 0, with full meta and no cancel key", () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const m = makeMeta();
    const first = pt(10, 20);

    sender.begin(m, first);
    clock.advance(0);

    expect(post.calls).toHaveLength(1);
    const frame = post.calls[0]!;
    expect(frame.batch).toBe(0);
    expect(frame.points).toEqual([first]);
    expect(frame.drawingClientId).toBe(m.drawingClientId);
    expect(frame.anchorSeq).toBe(m.anchorSeq);
    expect(frame.columnWidth).toBe(m.columnWidth);
    expect(frame.strokeId).toBe(m.strokeId);
    expect(frame.color).toBe(m.color);
    expect(frame.width).toBe(m.width);
    expect("cancel" in frame).toBe(false);
  });

  it("never sends a second frame while one is in flight, however long we wait", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);

    sender.begin(makeMeta(), pt(0, 0));
    clock.advance(0);
    expect(post.calls).toHaveLength(1); // frame 0, unresolved

    sender.push(pt(1, 1));
    sender.push(pt(2, 2));
    clock.advance(LIVE_KEEPALIVE_MS * 10); // time passing alone changes nothing while in flight
    expect(post.calls).toHaveLength(1);

    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();
    clock.advance(0); // the response handler's own schedule() may have armed an immediate timer
    expect(post.calls).toHaveLength(2); // only now does the queued backlog go out
  });

  it("after an in-flight request resolves, the next frame goes out no sooner than LIVE_BATCH_INTERVAL_MS after the previous frame was sent", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const p0 = pt(0, 0);
    const p1 = pt(1, 1);

    sender.begin(makeMeta(), p0);
    clock.advance(0); // frame 0 sent at t=0
    sender.push(p1);
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks(); // resolved at t=0 too — the interval is measured from the send, not the response

    clock.advance(LIVE_BATCH_INTERVAL_MS - 1);
    expect(post.calls).toHaveLength(1); // one interval hasn't passed since t=0 yet

    clock.advance(1); // now exactly LIVE_BATCH_INTERVAL_MS after the first send
    expect(post.calls).toHaveLength(2);
  });

  it("each frame after the first begins with the previous frame's last point, and batch increases by 1 each time", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const p0 = pt(0, 0);
    const p1 = pt(1, 1);
    const p2 = pt(2, 2);
    const p3 = pt(3, 3);

    sender.begin(makeMeta(), p0);
    clock.advance(0);
    expect(post.calls[0]!.batch).toBe(0);
    expect(post.calls[0]!.points).toEqual([p0]);

    sender.push(p1);
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();
    clock.advance(LIVE_BATCH_INTERVAL_MS);
    expect(post.calls).toHaveLength(2);
    expect(post.calls[1]!.batch).toBe(1);
    expect(post.calls[1]!.points).toEqual([p0, p1]);

    sender.push(p2);
    sender.push(p3);
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();
    clock.advance(LIVE_BATCH_INTERVAL_MS);
    expect(post.calls).toHaveLength(3);
    expect(post.calls[2]!.batch).toBe(2);
    expect(post.calls[2]!.points).toEqual([p1, p2, p3]);
  });

  it("caps every frame at MAX_LIVE_POINTS_PER_BATCH points (including the overlap point) and splits a 450-point backlog across frames in order", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const p0 = pt(0, 0);
    const pushed: DrawPoint[] = [];
    for (let i = 1; i <= 450; i += 1) pushed.push(pt(i, i));

    sender.begin(makeMeta(), p0);
    clock.advance(0);
    expect(post.calls).toHaveLength(1); // frame 0: just the seed point, still in flight

    for (const point of pushed) sender.push(point);

    post.resolveNext({ kind: "ok" }); // drains frame 0
    await flushMicrotasks();

    // Expected split, derived from the real constant (not hardcoded): every frame after the first
    // carries at most one fewer than the cap in FRESH points, the rest being the overlap point.
    const freshPerFrame = MAX_LIVE_POINTS_PER_BATCH - 1;
    const expectedFrameLengths: number[] = [];
    let remaining = 450;
    while (remaining > 0) {
      const fresh = Math.min(freshPerFrame, remaining);
      expectedFrameLengths.push(fresh + 1);
      remaining -= fresh;
    }

    const frameLengths: number[] = [];
    const delivered: DrawPoint[] = [];
    while (sender.busy) {
      clock.advance(LIVE_BATCH_INTERVAL_MS);
      if (post.pendingCount === 0) break; // fully drained — nothing more was sent this round
      const frame = post.calls[post.calls.length - 1]!;
      expect(frame.points.length).toBeLessThanOrEqual(MAX_LIVE_POINTS_PER_BATCH);
      frameLengths.push(frame.points.length);
      delivered.push(...frame.points.slice(1)); // drop the overlap point (this stroke's own last-sent point)
      post.resolveNext({ kind: "ok" });
      await flushMicrotasks();
    }

    expect(frameLengths).toEqual(expectedFrameLengths);
    expect(delivered).toEqual(pushed);
    expect(delivered).toHaveLength(450);
  });

  it("does not queue a point identical to the buffer's pending last point, or (once drained) identical to the point actually last sent", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const p0 = pt(5, 5);
    const p1 = pt(6, 6);

    sender.begin(makeMeta(), p0);
    sender.push(pt(5, 5)); // identical to the buffered seed point — dropped
    sender.push(p1); // distinct — queued
    sender.push(pt(6, 6)); // identical to the point just queued — dropped

    clock.advance(0);
    expect(post.calls).toHaveLength(1);
    expect(post.calls[0]!.points).toEqual([p0, p1]);

    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();

    // The buffer is now empty; pushing the point that was last SENT is also treated as a duplicate.
    sender.push(pt(6, 6));
    clock.advance(LIVE_BATCH_INTERVAL_MS);
    expect(post.calls).toHaveLength(1); // nothing new
  });

  it("end() sends the remaining queued points, then sends nothing further for that stroke, and busy eventually goes false once fully drained", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const p0 = pt(0, 0);
    const p1 = pt(1, 1);

    sender.begin(makeMeta(), p0);
    clock.advance(0);
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();

    sender.push(p1);
    sender.end();
    expect(sender.busy).toBe(true); // p1 is still owed

    clock.advance(LIVE_BATCH_INTERVAL_MS); // sends the remaining point
    expect(post.calls).toHaveLength(2);
    expect(post.calls[1]!.points).toEqual([p0, p1]);
    expect(post.calls[1]!.cancel).toBeUndefined();

    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();

    // One more scheduling tick is needed to notice "ended + drained" and retire the stroke.
    clock.advance(LIVE_BATCH_INTERVAL_MS);
    expect(sender.busy).toBe(false);
    expect(post.calls).toHaveLength(2); // that tick sends nothing further

    // No keepalive, ever, for a stroke that has ended.
    clock.advance(LIVE_KEEPALIVE_MS * 10);
    expect(post.calls).toHaveLength(2);
  });

  // See the final report: this test documents a genuine discrepancy and is expected to fail.
  it("end() called with an already-drained buffer retires the stroke within one batch interval, not after a stale keepalive timer", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);

    sender.begin(makeMeta(), pt(0, 0));
    clock.advance(0); // frame 0 sent
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks(); // buffer now empty -> a LIVE_KEEPALIVE_MS keepalive timer gets armed

    sender.end(); // nothing left to send for this stroke, ever
    expect(sender.busy).toBe(true); // reasonable immediately after end()

    clock.advance(LIVE_BATCH_INTERVAL_MS); // one interval is how promptly every other path retires a stroke
    expect(post.calls).toHaveLength(1); // no keepalive frame is ever sent for an ended stroke
    expect(sender.busy).toBe(false); // the ended stroke re-armed the timer earlier instead of waiting it out

    clock.advance(LIVE_KEEPALIVE_MS);
    expect(sender.busy).toBe(false);
    expect(post.calls).toHaveLength(1);
  });

  it("draw, pause, lift, draw again: the new stroke's first frame is not held back by the old stroke's keepalive timer", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);

    sender.begin(makeMeta({ strokeId: "stroke-1" }), pt(0, 0));
    clock.advance(0);
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks(); // the finger holds still: a keepalive is armed LIVE_KEEPALIVE_MS out
    clock.advance(300);
    sender.end();
    clock.advance(100);
    sender.begin(makeMeta({ strokeId: "stroke-2" }), pt(5, 5));
    clock.advance(LIVE_BATCH_INTERVAL_MS);

    const second = post.calls.filter((frame) => frame.strokeId === "stroke-2");
    expect(second).toHaveLength(1);
    expect(second[0]!.batch).toBe(0);
    expect(second[0]!.points).toEqual([pt(5, 5)]);
  });

  it("a point arriving while a keepalive is armed goes out within one batch interval", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);

    sender.begin(makeMeta(), pt(0, 0));
    clock.advance(0);
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();
    clock.advance(500); // still, keepalive armed for later
    sender.push(pt(9, 9));
    clock.advance(LIVE_BATCH_INTERVAL_MS);
    expect(post.calls).toHaveLength(2);
    expect(post.calls[1]!.points).toEqual([pt(0, 0), pt(9, 9)]);
  });

  it("cancel() before any frame was sent sends nothing at all", () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);

    sender.begin(makeMeta(), pt(0, 0));
    sender.cancel(); // before the t=0 timer has even fired
    clock.advance(0);
    clock.advance(LIVE_KEEPALIVE_MS * 10);

    expect(post.calls).toHaveLength(0);
    expect(sender.busy).toBe(false);
  });

  it("cancel() after frames were sent drops unsent points and sends exactly one cancel frame with a batch higher than any already sent", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);

    sender.begin(makeMeta(), pt(0, 0));
    clock.advance(0);
    expect(post.calls).toHaveLength(1);
    expect(post.calls[0]!.batch).toBe(0);

    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();

    sender.push(pt(1, 1)); // queued, never sent
    sender.cancel();

    clock.advance(LIVE_BATCH_INTERVAL_MS);
    expect(post.calls).toHaveLength(2);
    const cancelFrame = post.calls[1]!;
    expect(cancelFrame.cancel).toBe(true);
    expect(cancelFrame.points).toEqual([]);
    expect(cancelFrame.batch).toBeGreaterThan(post.calls[0]!.batch);

    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();
    expect(sender.busy).toBe(false);
    expect(post.calls).toHaveLength(2); // nothing further, ever

    clock.advance(LIVE_KEEPALIVE_MS * 10);
    expect(post.calls).toHaveLength(2);
  });

  it("a rate_limited result pauses sending until retryAfterMs has passed; points pushed meanwhile go out once the pause ends", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const p0 = pt(0, 0);
    const p1 = pt(1, 1);

    sender.begin(makeMeta(), p0);
    clock.advance(0);
    expect(post.calls).toHaveLength(1);

    post.resolveNext({ kind: "rate_limited", retryAfterMs: 1000 });
    await flushMicrotasks();

    sender.push(p1); // arrives during the pause

    clock.advance(999);
    expect(post.calls).toHaveLength(1); // still paused

    clock.advance(1); // exactly at the pause's end
    expect(post.calls).toHaveLength(2);
    expect(post.calls[1]!.points).toEqual([p0, p1]);
  });

  it("a failed result is not retried — sending continues onward with whatever is queued next", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const p0 = pt(0, 0);
    const p1 = pt(1, 1);

    sender.begin(makeMeta(), p0);
    clock.advance(0);
    expect(post.calls).toHaveLength(1);
    expect(post.calls[0]!.points).toEqual([p0]);

    post.resolveNext({ kind: "failed" }); // frame 0 is lost for good
    await flushMicrotasks();

    sender.push(p1);
    clock.advance(LIVE_BATCH_INTERVAL_MS);

    expect(post.calls).toHaveLength(2); // no re-send of the lost frame — only the next batch
    expect(post.calls[1]!.batch).toBe(1);
    expect(post.calls[1]!.points).toEqual([p0, p1]);
  });

  it("a rejected post() (e.g. a network exception) is treated like a failed send: no retry, sending continues", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const p0 = pt(0, 0);
    const p1 = pt(1, 1);

    sender.begin(makeMeta(), p0);
    clock.advance(0);
    expect(post.calls).toHaveLength(1);

    post.rejectNext();
    await flushMicrotasks();

    sender.push(p1);
    clock.advance(LIVE_BATCH_INTERVAL_MS);

    expect(post.calls).toHaveLength(2);
    expect(post.calls[1]!.points).toEqual([p0, p1]);
  });

  it("a 'locked' result calls onLocked exactly once", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const onLocked = vi.fn();
    const sender = makeSender(clock, post.post, onLocked);

    sender.begin(makeMeta(), pt(0, 0));
    clock.advance(0);
    expect(post.calls).toHaveLength(1);

    post.resolveNext("locked");
    await flushMicrotasks();

    expect(onLocked).toHaveBeenCalledTimes(1);
  });

  it("keepalive: a finger held still re-sends the last point every LIVE_KEEPALIVE_MS, as a one-point frame", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const p0 = pt(7, 9);

    sender.begin(makeMeta(), p0);
    clock.advance(0);
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();
    expect(post.calls).toHaveLength(1);

    clock.advance(LIVE_KEEPALIVE_MS - 1);
    expect(post.calls).toHaveLength(1); // not due yet

    clock.advance(1); // exactly LIVE_KEEPALIVE_MS since the last send
    expect(post.calls).toHaveLength(2);
    expect(post.calls[1]!.points).toEqual([p0]);
    expect(post.calls[1]!.cancel).toBeUndefined();

    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();

    clock.advance(LIVE_KEEPALIVE_MS - 1);
    expect(post.calls).toHaveLength(2); // the next keepalive isn't due yet either

    clock.advance(1);
    expect(post.calls).toHaveLength(3); // it repeats
    expect(post.calls[2]!.points).toEqual([p0]);
  });

  it("a second stroke started while the first stroke's tail is still queued drains FIFO, each with its own batch numbering from 0", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);
    const meta1 = makeMeta({ strokeId: "stroke-1" });
    const meta2 = makeMeta({ strokeId: "stroke-2" });
    const p0 = pt(0, 0);
    const p1 = pt(1, 1);
    const q0 = pt(50, 50);

    sender.begin(meta1, p0);
    clock.advance(0);
    expect(post.calls).toHaveLength(1);
    expect(post.calls[0]!.strokeId).toBe("stroke-1");
    expect(post.calls[0]!.batch).toBe(0);

    sender.push(p1); // queued behind the in-flight request
    sender.end(); // stroke 1 is done, but p1 is still owed

    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();

    sender.begin(meta2, q0); // a new stroke starts before stroke 1's tail has gone out

    clock.advance(LIVE_BATCH_INTERVAL_MS); // sends stroke 1's remaining point
    expect(post.calls).toHaveLength(2);
    expect(post.calls[1]!.strokeId).toBe("stroke-1");
    expect(post.calls[1]!.batch).toBe(1);
    expect(post.calls[1]!.points).toEqual([p0, p1]);

    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();

    clock.advance(LIVE_BATCH_INTERVAL_MS); // retires stroke 1 and sends stroke 2's first frame
    expect(post.calls).toHaveLength(3);
    expect(post.calls[2]!.strokeId).toBe("stroke-2");
    expect(post.calls[2]!.batch).toBe(0); // its own numbering, independent of stroke 1's
    expect(post.calls[2]!.points).toEqual([q0]);
  });

  it("shutdown() with a stroke already sending posts its cancel frame immediately, bypassing both the in-flight response and the pacing interval", async () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);

    sender.begin(makeMeta(), pt(0, 0));
    clock.advance(0);
    expect(post.calls).toHaveLength(1); // frame 0 is in flight, unresolved

    sender.shutdown();

    expect(post.calls).toHaveLength(2); // the cancel frame was posted synchronously
    const cancelFrame = post.calls[1]!;
    expect(cancelFrame.cancel).toBe(true);
    expect(cancelFrame.points).toEqual([]);
    expect(cancelFrame.batch).toBeGreaterThan(post.calls[0]!.batch);
    expect(sender.busy).toBe(false);

    // A late response to the original (pre-shutdown) request causes nothing further.
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();
    expect(post.calls).toHaveLength(2);

    // The shutdown-issued cancel frame's own (also late) response is equally inert.
    post.resolveNext({ kind: "ok" });
    await flushMicrotasks();
    expect(post.calls).toHaveLength(2);

    // Every timer is gone too: advancing far past any interval/keepalive fires nothing.
    clock.advance(LIVE_KEEPALIVE_MS * 100);
    expect(post.calls).toHaveLength(2);
  });

  it("shutdown() with nothing sent yet posts nothing", () => {
    const clock = createFakeClock();
    const post = createPostSpy();
    const sender = makeSender(clock, post.post);

    sender.begin(makeMeta(), pt(0, 0));
    sender.shutdown(); // before the t=0 timer has even fired

    expect(post.calls).toHaveLength(0);
    expect(sender.busy).toBe(false);

    clock.advance(LIVE_KEEPALIVE_MS * 100);
    expect(post.calls).toHaveLength(0);
  });
});

// -- Receiver --------------------------------------------------------------------------------------

describe("createLiveReceiver", () => {
  function makeDeps(overrides: Partial<LiveReceiverDeps> = {}): LiveReceiverDeps {
    return {
      isOwnDrawing: () => false,
      isKnownStroke: () => false,
      ...overrides,
    };
  }

  function makeFrame(overrides: Partial<LiveFrame> = {}): LiveFrame {
    return {
      drawingClientId: "drawer-1",
      anchorSeq: 10,
      columnWidth: 400,
      strokeId: "stroke-1",
      batch: 0,
      color: COLOR,
      width: WIDTH,
      points: [pt(1, 1), pt(2, 2)],
      cancel: false,
      ...overrides,
    };
  }

  function expectUpdated(result: LiveApplyResult): LiveStroke {
    if (result.kind !== "updated") throw new Error(`expected an "updated" result, got "${result.kind}"`);
    return result.stroke;
  }

  it("a first frame creates a stroke (updated) with one segment; higher batches append segments in order", () => {
    const receiver = createLiveReceiver(makeDeps());

    const stroke1 = expectUpdated(receiver.apply(makeFrame({ batch: 0, points: [pt(1, 1), pt(2, 2)] }), 0));
    expect(stroke1.segments).toEqual([[pt(1, 1), pt(2, 2)]]);
    expect(stroke1.lastBatch).toBe(0);

    const stroke2 = expectUpdated(receiver.apply(makeFrame({ batch: 1, points: [pt(3, 3)] }), 10));
    expect(stroke2.segments).toEqual([[pt(1, 1), pt(2, 2)], [pt(3, 3)]]);
    expect(stroke2.lastBatch).toBe(1);
    expect(stroke2.updatedAt).toBe(10);
    expect(stroke2).toBe(stroke1); // the same LiveStroke object, mutated in place
  });

  it("ignores an out-of-order or duplicate batch (batch <= last seen) without mutating the stroke", () => {
    const receiver = createLiveReceiver(makeDeps());
    receiver.apply(makeFrame({ batch: 0 }), 0);
    receiver.apply(makeFrame({ batch: 1, points: [pt(3, 3)] }), 1);

    expect(receiver.apply(makeFrame({ batch: 1, points: [pt(99, 99)] }), 2)).toEqual({ kind: "ignored" }); // duplicate
    expect(receiver.apply(makeFrame({ batch: 0, points: [pt(99, 99)] }), 3)).toEqual({ kind: "ignored" }); // older

    const strokes = [...receiver.strokes()];
    expect(strokes).toHaveLength(1);
    expect(strokes[0]!.segments).toEqual([[pt(1, 1), pt(2, 2)], [pt(3, 3)]]); // unchanged by the ignored frames
    expect(strokes[0]!.lastBatch).toBe(1);
  });

  it("ignores a frame for this screen's own drawing and never creates a stroke for it", () => {
    const isOwnDrawing = vi.fn((id: string) => id === "own-drawing");
    const receiver = createLiveReceiver(makeDeps({ isOwnDrawing }));

    const result = receiver.apply(makeFrame({ drawingClientId: "own-drawing" }), 0);
    expect(result).toEqual({ kind: "ignored" });
    expect(isOwnDrawing).toHaveBeenCalledWith("own-drawing");
    expect(receiver.size).toBe(0);
  });

  it("ignores a frame for a stroke already known/stored elsewhere", () => {
    const isKnownStroke = vi.fn((id: string) => id === "stroke-1");
    const receiver = createLiveReceiver(makeDeps({ isKnownStroke }));

    const result = receiver.apply(makeFrame({ strokeId: "stroke-1" }), 0);
    expect(result).toEqual({ kind: "ignored" });
    expect(isKnownStroke).toHaveBeenCalledWith("stroke-1");
    expect(receiver.size).toBe(0);
  });

  it("a cancel removes the stroke and blocks any later frame for it, even at a higher batch", () => {
    const receiver = createLiveReceiver(makeDeps());
    receiver.apply(makeFrame({ batch: 0 }), 0);

    const cancelResult = receiver.apply(makeFrame({ batch: 1, cancel: true, points: [] }), 1);
    expect(cancelResult).toEqual({ kind: "removed", strokeId: "stroke-1" });
    expect(receiver.size).toBe(0);

    const later = receiver.apply(makeFrame({ batch: 99, points: [pt(5, 5)] }), 2);
    expect(later).toEqual({ kind: "ignored" });
    expect(receiver.size).toBe(0);
  });

  it("a cancel for an unknown stroke is itself ignored, but still blocks later frames for that id", () => {
    const receiver = createLiveReceiver(makeDeps());

    const cancelResult = receiver.apply(makeFrame({ strokeId: "never-seen", cancel: true, points: [], batch: 0 }), 0);
    expect(cancelResult).toEqual({ kind: "ignored" });

    const later = receiver.apply(makeFrame({ strokeId: "never-seen", batch: 0 }), 1);
    expect(later).toEqual({ kind: "ignored" });
  });

  it("finish(strokeId) removes a live stroke and blocks later frames for it", () => {
    const receiver = createLiveReceiver(makeDeps());
    receiver.apply(makeFrame({ batch: 0 }), 0);

    expect(receiver.finish("stroke-1", 5)).toBe(true);
    expect(receiver.size).toBe(0);

    const later = receiver.apply(makeFrame({ batch: 99 }), 6);
    expect(later).toEqual({ kind: "ignored" });
  });

  it("finish() on a stroke that was never live returns false but still blocks it going forward", () => {
    const receiver = createLiveReceiver(makeDeps());

    expect(receiver.finish("ghost", 0)).toBe(false);
    const later = receiver.apply(makeFrame({ strokeId: "ghost", batch: 0 }), 1);
    expect(later).toEqual({ kind: "ignored" });
  });

  it("sweep(now) drops a stroke not updated for more than LIVE_STROKE_TIMEOUT_MS, and keeps one refreshed inside the window", () => {
    const receiver = createLiveReceiver(makeDeps());
    receiver.apply(makeFrame({ strokeId: "stale", batch: 0 }), 0);
    receiver.apply(makeFrame({ strokeId: "fresh", batch: 0 }), 0);
    receiver.apply(makeFrame({ strokeId: "fresh", batch: 1, points: [pt(9, 9)] }), 4_000); // refreshed inside the window

    const dropped = receiver.sweep(LIVE_STROKE_TIMEOUT_MS + 1); // stale (updated at 0) times out; fresh (updated at 4000) doesn't
    expect(dropped).toEqual(["stale"]);
    expect(receiver.size).toBe(1);
    expect([...receiver.strokes()].map((s) => s.strokeId)).toEqual(["fresh"]);
  });

  it("sweep(now) does not drop a stroke at exactly LIVE_STROKE_TIMEOUT_MS — strictly more than, not at", () => {
    const receiver = createLiveReceiver(makeDeps());
    receiver.apply(makeFrame({ batch: 0 }), 0);

    expect(receiver.sweep(LIVE_STROKE_TIMEOUT_MS)).toEqual([]);
    expect(receiver.size).toBe(1);
  });

  it("a stroke dropped by sweep can come back if frames resume — a timeout is not a permanent block", () => {
    const receiver = createLiveReceiver(makeDeps());
    receiver.apply(makeFrame({ batch: 0 }), 0);

    const dropped = receiver.sweep(LIVE_STROKE_TIMEOUT_MS + 1);
    expect(dropped).toEqual(["stroke-1"]);
    expect(receiver.size).toBe(0);

    // Even batch 0 again is accepted — this id was never marked "finished" (unlike cancel/finish).
    const revived = receiver.apply(makeFrame({ batch: 0 }), LIVE_STROKE_TIMEOUT_MS + 2);
    expect(revived.kind).toBe("updated");
    expect(receiver.size).toBe(1);
  });

  it("removeForAnchor(seq) drops only that anchor's strokes and returns their ids; clear() empties everything", () => {
    const receiver = createLiveReceiver(makeDeps());
    receiver.apply(makeFrame({ strokeId: "a", anchorSeq: 10, batch: 0 }), 0);
    receiver.apply(makeFrame({ strokeId: "b", anchorSeq: 20, batch: 0 }), 0);
    expect(receiver.size).toBe(2);

    const dropped = receiver.removeForAnchor(10);
    expect(dropped).toEqual(["a"]);
    expect(receiver.size).toBe(1);
    expect([...receiver.strokes()].map((s) => s.strokeId)).toEqual(["b"]);

    receiver.clear();
    expect(receiver.size).toBe(0);
    expect([...receiver.strokes()]).toEqual([]);
  });
});
