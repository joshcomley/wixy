import { describe, expect, it, vi } from "vitest";
import type { LivePostResult } from "../../src/server/api/drawings";
import type { AdventureLiveFrame } from "../../src/server/adventure/api";
import {
  BUFFER_MS,
  HOLD_AFTER_END_MS,
  createLiveReceiver,
  createLiveSender,
  type LiveContext,
} from "../../src/server/adventure/live";
import { FADE_MS } from "../../src/server/adventure/trail";

// ---- the sender -----------------------------------------------------------------------------------

interface Posted {
  readonly frame: AdventureLiveFrame;
  resolve(result: LivePostResult | "locked"): void;
}

function senderRig() {
  const clock = { t: 10_000 };
  const timers: Array<{ id: number; at: number; fn: () => void; live: boolean }> = [];
  const posted: Posted[] = [];
  const onLocked = vi.fn();
  let ids = 0;
  const sender = createLiveSender({
    post: (frame) =>
      new Promise((resolve) => {
        posted.push({ frame, resolve });
      }),
    onLocked,
    setTimeout: (fn, ms) => {
      const id = timers.length + 1;
      timers.push({ id, at: clock.t + ms, fn, live: true });
      return id;
    },
    clearTimeout: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t !== undefined) t.live = false;
    },
    now: () => clock.t,
    newId: () => `drag-id-${(ids += 1).toString().padStart(4, "0")}`,
  });
  /** Moves the clock to `t` firing every timer due on the way, in order. */
  async function advanceTo(t: number): Promise<void> {
    for (;;) {
      const due = timers.filter((x) => x.live && x.at <= t).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      clock.t = Math.max(clock.t, due.at);
      due.fn();
      await Promise.resolve();
    }
    clock.t = t;
  }
  async function answer(index: number, result: LivePostResult | "locked" = { kind: "ok" }): Promise<void> {
    posted[index]?.resolve(result);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  }
  return { sender, clock, posted, timers, onLocked, advanceTo, answer };
}

describe("live sender: pacing", () => {
  it("sends the first point at once, as frame 0 of a fresh drag id, in globe-radius units", async () => {
    const r = senderRig();
    const id = r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0.25, -0.5], [100, -15]);
    await r.advanceTo(r.clock.t);
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]?.frame).toEqual({
      anchorSeq: 7,
      clientId: id,
      axis: "lng",
      rotation: [100, -15],
      points: [[0.25, -0.5, 0]],
      frame: 0,
      end: false,
    });
    expect(r.sender.owns(id)).toBe(true);
    expect(r.sender.owns("someone-else-0001")).toBe(false);
  });

  it("keeps ONE request in flight: points made meanwhile wait for the answer, then go in one frame", async () => {
    const r = senderRig();
    r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t);
    for (let i = 1; i <= 5; i += 1) {
      await r.advanceTo(r.clock.t + 20);
      r.sender.push([i * 0.1, 0], [i, -15]);
    }
    await r.advanceTo(r.clock.t + 200);
    expect(r.posted).toHaveLength(1); // the first has not been answered
    await r.answer(0);
    await r.advanceTo(r.clock.t + 60);
    expect(r.posted).toHaveLength(2);
    expect(r.posted[1]?.frame.frame).toBe(1);
    expect(r.posted[1]?.frame.points).toHaveLength(5);
    expect(r.posted[1]?.frame.rotation).toEqual([5, -15]); // the rotation of its LAST point
  });

  it("sends at most one frame every 50 ms (20 a second)", async () => {
    const r = senderRig();
    r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t);
    await r.answer(0);
    r.sender.push([0.1, 0], [1, -15]);
    await r.advanceTo(r.clock.t + 10);
    expect(r.posted).toHaveLength(1); // 10 ms after the last frame: too soon
    await r.advanceTo(r.clock.t + 45);
    expect(r.posted).toHaveLength(2);
  });

  it("puts at most 32 points in a frame and the rest in the next", async () => {
    const r = senderRig();
    r.sender.begin({ anchorSeq: 7, axis: "lat" }, [0, 0], [0, 0]);
    await r.advanceTo(r.clock.t);
    for (let i = 1; i <= 70; i += 1) r.sender.push([0.01 * i, 0], [0, i]);
    await r.answer(0);
    await r.advanceTo(r.clock.t + 60);
    expect(r.posted[1]?.frame.points).toHaveLength(32);
    await r.answer(1);
    await r.advanceTo(r.clock.t + 60);
    expect(r.posted[2]?.frame.points).toHaveLength(32);
    expect(r.posted[2]?.frame.rotation).toEqual([0, 64]);
    await r.answer(2);
    await r.advanceTo(r.clock.t + 60);
    expect(r.posted[3]?.frame.points).toHaveLength(6);
  });

  it("stamps each point with the milliseconds since the drag began, and clamps what the server would refuse", async () => {
    const r = senderRig();
    r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t);
    await r.answer(0);
    await r.advanceTo(r.clock.t + 120);
    r.sender.push([9, -9], [3, -15]);
    r.sender.push([Number.NaN, 0], [3, -15]); // dropped
    r.sender.push([0, 0], [Number.POSITIVE_INFINITY, 0]); // dropped
    r.sender.push([0, 0], [1e9, 0]); // dropped: a rotation the server would refuse
    await r.advanceTo(r.clock.t + 60);
    const points = r.posted[1]?.frame.points ?? [];
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual([3, -3, 120]); // |x|, |y| <= 3
  });

  it("pauses for a 429's Retry-After, then sends what waited", async () => {
    const r = senderRig();
    r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t);
    r.sender.push([0.1, 0], [1, -15]);
    await r.answer(0, { kind: "rate_limited", retryAfterMs: 1500 });
    await r.advanceTo(r.clock.t + 1000);
    expect(r.posted).toHaveLength(1);
    await r.advanceTo(r.clock.t + 600);
    expect(r.posted).toHaveLength(2);
  });

  it("a failed or locked answer: failure just moves on, a lock tells the chat", async () => {
    const r = senderRig();
    r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t);
    await r.answer(0, { kind: "failed" });
    r.sender.push([0.1, 0], [1, -15]);
    await r.advanceTo(r.clock.t + 60);
    expect(r.posted).toHaveLength(2);
    expect(r.onLocked).not.toHaveBeenCalled();
    await r.answer(1, "locked");
    expect(r.onLocked).toHaveBeenCalledTimes(1);
  });

  it("a finger held still re-sends the rotation every 2 seconds so the other screen keeps the drag alive", async () => {
    const r = senderRig();
    r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [5, -15]);
    await r.advanceTo(r.clock.t);
    await r.answer(0);
    await r.advanceTo(r.clock.t + 1900);
    expect(r.posted).toHaveLength(1);
    await r.advanceTo(r.clock.t + 200);
    expect(r.posted).toHaveLength(2);
    expect(r.posted[1]?.frame.points).toEqual([]);
    expect(r.posted[1]?.frame.rotation).toEqual([5, -15]);
    expect(r.posted[1]?.frame.end).toBe(false);
  });
});

describe("live sender: ending a drag", () => {
  it("closes the drag with an `end` frame that carries the points still owed", async () => {
    const r = senderRig();
    const id = r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t);
    r.sender.push([0.1, 0], [1, -15]);
    r.sender.push([0.2, 0], [2, -15]);
    r.sender.end([2.5, -15]);
    await r.answer(0);
    await r.advanceTo(r.clock.t + 60);
    expect(r.posted[1]?.frame).toMatchObject({ clientId: id, end: true, frame: 1 });
    expect(r.posted[1]?.frame.points).toHaveLength(2);
    await r.answer(1);
    await r.advanceTo(r.clock.t + 5000);
    expect(r.posted).toHaveLength(2); // nothing more is owed
    expect(r.sender.busy).toBe(false);
  });

  it("sends a bare `end` when the finger lifted with nothing owed", async () => {
    const r = senderRig();
    r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t);
    await r.answer(0);
    r.sender.end([0, -15]);
    await r.advanceTo(r.clock.t + 60);
    expect(r.posted[1]?.frame).toMatchObject({ end: true, points: [] });
  });

  it("a cancelled drag sends only a closing `end`, and nothing at all if no frame went out", async () => {
    const r = senderRig();
    r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    r.sender.cancel(); // before the first frame left
    await r.advanceTo(r.clock.t + 100);
    expect(r.posted).toHaveLength(0);

    const s = senderRig();
    s.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await s.advanceTo(s.clock.t);
    await s.answer(0);
    s.sender.push([0.1, 0], [1, -15]);
    s.sender.cancel(); // the unsent point is withdrawn
    await s.advanceTo(s.clock.t + 100);
    expect(s.posted).toHaveLength(2);
    expect(s.posted[1]?.frame).toMatchObject({ end: true, points: [] });
  });

  it("every drag has its own id and frame counter; the sender remembers its own ids", async () => {
    const r = senderRig();
    const first = r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t);
    await r.answer(0);
    r.sender.end([0, -15]);
    await r.advanceTo(r.clock.t + 60);
    await r.answer(1);
    const second = r.sender.begin({ anchorSeq: 7, axis: "lat" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t + 60);
    expect(second).not.toBe(first);
    expect(r.posted[2]?.frame).toMatchObject({ clientId: second, frame: 0, axis: "lat" });
    expect(r.sender.owns(first)).toBe(true);
    expect(r.sender.owns(second)).toBe(true);
  });

  it("shutdown posts the owed `end` at once, forgets the rest and clears every timer", async () => {
    const r = senderRig();
    const id = r.sender.begin({ anchorSeq: 7, axis: "lng" }, [0, 0], [0, -15]);
    await r.advanceTo(r.clock.t);
    r.sender.push([0.1, 0], [1, -15]);
    r.sender.shutdown();
    expect(r.posted).toHaveLength(2);
    expect(r.posted[1]?.frame).toMatchObject({ clientId: id, end: true, points: [] });
    expect(r.timers.filter((t) => t.live)).toHaveLength(0);
    await r.advanceTo(r.clock.t + 10_000);
    expect(r.posted).toHaveLength(2);
    expect(r.sender.busy).toBe(false);
  });
});

// ---- the receiver -----------------------------------------------------------------------------------

function frameOf(patch: Partial<AdventureLiveFrame> & { frame: number }): AdventureLiveFrame {
  return {
    anchorSeq: 7,
    clientId: "drag-id-0001",
    axis: "lng",
    rotation: [0, -15],
    points: [],
    end: false,
    ...patch,
  };
}

function receiverRig(overrides: { waiting?: LiveContext["waitingForSpin"]; own?: (id: string) => boolean } = {}) {
  const waiting = vi.fn<LiveContext["waitingForSpin"]>(overrides.waiting ?? (() => true));
  const receiver = createLiveReceiver({
    context: { waitingForSpin: waiting },
    isOwn: overrides.own ?? (() => false),
  });
  return { receiver, waiting };
}

describe("live receiver: which frames count", () => {
  it("ignores this screen's own drag, whichever way it comes back", () => {
    const { receiver } = receiverRig({ own: (id) => id === "drag-id-0001" });
    expect(receiver.apply(frameOf({ frame: 0, points: [[0, 0, 0]] }), 1000)).toBe("ignored");
    expect(receiver.current(1000)).toBeNull();
  });

  it("ignores a frame for another round or a spin the round no longer waits for", () => {
    const { receiver, waiting } = receiverRig({ waiting: (seq, axis) => seq === 7 && axis === "lng" });
    expect(receiver.apply(frameOf({ frame: 0, anchorSeq: 8 }), 1000)).toBe("ignored");
    expect(receiver.apply(frameOf({ frame: 0, axis: "lat" }), 1000)).toBe("ignored");
    expect(waiting).toHaveBeenCalledWith(8, "lng");
    expect(receiver.apply(frameOf({ frame: 0, points: [[0, 0, 0]] }), 1000)).toBe("updated");
  });

  it("ignores a frame that is not newer than the last one of its drag", () => {
    const { receiver } = receiverRig();
    expect(receiver.apply(frameOf({ frame: 3, points: [[0, 0, 100]] }), 1000)).toBe("updated");
    expect(receiver.apply(frameOf({ frame: 3, points: [[0, 0, 110]] }), 1010)).toBe("ignored");
    expect(receiver.apply(frameOf({ frame: 2, points: [[0, 0, 90]] }), 1020)).toBe("ignored");
    expect(receiver.apply(frameOf({ frame: 4, points: [[0, 0, 120]] }), 1030)).toBe("updated");
  });

  it("a new drag id replaces the old drag (and clears its stroke); the superseded id never comes back", () => {
    const { receiver } = receiverRig();
    receiver.apply(frameOf({ frame: 0, points: [[0.5, 0, 0]], rotation: [10, -15] }), 1000);
    receiver.current(1000 + BUFFER_MS + 50);
    expect(receiver.trail.size).toBe(1);
    receiver.apply(frameOf({ frame: 0, clientId: "drag-id-0002", points: [[-0.5, 0, 0]], rotation: [50, -15] }), 2000);
    expect(receiver.trail.size).toBe(0);
    expect(receiver.apply(frameOf({ frame: 9, points: [[0, 0, 5]] }), 2010)).toBe("ignored"); // the old id
  });
});

describe("live receiver: the jitter buffer", () => {
  it("shows the dragger's rotation as it was BUFFER_MS ago, interpolated between frames", () => {
    const { receiver } = receiverRig();
    // Frames made at sender times 0, 50, 100 ms (rotation 0, 10, 20 degrees) arrive with ~30 ms latency.
    receiver.apply(frameOf({ frame: 0, points: [[0, 0, 0]], rotation: [0, -15] }), 1030);
    receiver.apply(frameOf({ frame: 1, points: [[0, 0, 50]], rotation: [10, -15] }), 1080);
    receiver.apply(frameOf({ frame: 2, points: [[0, 0, 100]], rotation: [20, -15] }), 1130);
    // At local 1030 + BUFFER + 25 the buffer shows sender time 25: halfway between frame 0 and frame 1.
    const shown = receiver.current(1030 + BUFFER_MS + 25);
    expect(shown?.rotation[0]).toBeCloseTo(5, 6);
    expect(shown?.fingerDown).toBe(true);
    expect(receiver.current(1030 + BUFFER_MS + 75)?.rotation[0]).toBeCloseTo(15, 6);
    // Before anything is old enough to show, it holds the first rotation; after the last it holds the last.
    expect(receiver.current(1030)?.rotation[0]).toBe(0);
    expect(receiver.current(1030 + BUFFER_MS + 5000)?.rotation[0]).toBe(20);
  });

  it("moves each finger point onto the stroke only when the buffer reaches it, back-dated so it fades on schedule", () => {
    const { receiver } = receiverRig();
    receiver.apply(frameOf({ frame: 0, points: [[0.1, 0.1, 0], [0.2, 0.2, 40], [0.3, 0.3, 80]], rotation: [3, -15] }), 1000);
    // The frame's last point (t = 80) is "now": the clock offset is 1000 - 80 = 920, so a point made at sender
    // time t is shown at local 920 + t + BUFFER_MS.
    receiver.current(1000);
    expect(receiver.trail.size).toBe(0); // nothing is old enough yet
    receiver.current(920 + BUFFER_MS + 5);
    expect(receiver.trail.size).toBe(1); // t = 0 is due
    receiver.current(920 + BUFFER_MS + 45);
    expect(receiver.trail.size).toBe(2); // t = 40 too, t = 80 is not
    receiver.current(920 + BUFFER_MS + 85);
    expect(receiver.trail.size).toBe(3);
    // Each point carries the local time it is SHOWN at.
    const times = receiver.trail.points.map((p) => p.t);
    expect(times[2]! - times[0]!).toBeCloseTo(80, 6);
    // And after FADE_MS of showing, the stroke is gone.
    expect(receiver.trail.isEmpty(times[2]! + FADE_MS + 1)).toBe(true);
  });

  it("a late frame's points go straight onto the stroke, already partly faded", () => {
    const { receiver } = receiverRig();
    receiver.apply(frameOf({ frame: 0, points: [[0, 0, 0]], rotation: [0, -15] }), 1000);
    receiver.apply(frameOf({ frame: 1, points: [[0.1, 0, 20]], rotation: [1, -15] }), 1000 + 900); // arrives very late
    receiver.current(1000 + 900);
    expect(receiver.trail.size).toBe(2);
  });

  it("uses the lowest latency it has seen as the clock offset (later frames can only be late)", () => {
    const { receiver } = receiverRig();
    receiver.apply(frameOf({ frame: 0, points: [[0, 0, 0]], rotation: [0, -15] }), 1100); // 100 ms late
    receiver.apply(frameOf({ frame: 1, points: [[0, 0, 100]], rotation: [10, -15] }), 1200); // also 100: no change
    receiver.apply(frameOf({ frame: 2, points: [[0, 0, 200]], rotation: [20, -15] }), 1400); // 200 late: ignored
    // offset stays 1100: sender t = 100 is shown at 1100 + 100 + BUFFER.
    expect(receiver.current(1100 + 100 + BUFFER_MS)?.rotation[0]).toBeCloseTo(10, 6);
  });

  it("an `end` frame closes the finger but the last rotation is held for the committed spin to take over", () => {
    const { receiver } = receiverRig();
    receiver.apply(frameOf({ frame: 0, points: [[0, 0, 0]], rotation: [0, -15] }), 1000);
    expect(receiver.apply(frameOf({ frame: 1, points: [[0.1, 0, 60]], rotation: [30, -15], end: true }), 1060)).toBe("ended");
    expect(receiver.current(1060 + BUFFER_MS + 100)).toMatchObject({ fingerDown: false, rotation: [30, -15], axis: "lng", anchorSeq: 7 });
    receiver.sweep(1060 + HOLD_AFTER_END_MS - 100);
    expect(receiver.current(1060 + HOLD_AFTER_END_MS - 100)).not.toBeNull();
    receiver.sweep(1060 + HOLD_AFTER_END_MS + 100); // nothing took over: it lets go
    expect(receiver.current(1060 + HOLD_AFTER_END_MS + 100)).toBeNull();
  });
});

describe("live receiver: lifetime", () => {
  it("drops a drag that has been silent for 5 seconds (a dragger who vanished)", () => {
    const { receiver } = receiverRig();
    receiver.apply(frameOf({ frame: 0, points: [[0, 0, 0]] }), 1000);
    receiver.sweep(5900);
    expect(receiver.current(5900)).not.toBeNull();
    receiver.sweep(6100);
    expect(receiver.current(6100)).toBeNull();
    // ...and a frame of that same drag cannot revive it.
    expect(receiver.apply(frameOf({ frame: 1, points: [[0, 0, 10]] }), 6200)).toBe("ignored");
  });

  it("finish forgets the drag but leaves the stroke to fade; clear and removeForAnchor drop it", () => {
    const { receiver } = receiverRig();
    receiver.apply(frameOf({ frame: 0, points: [[0.2, 0.2, 0]] }), 1000);
    receiver.current(1000 + BUFFER_MS + 10);
    expect(receiver.trail.size).toBe(1);
    receiver.finish();
    expect(receiver.current(1000 + BUFFER_MS + 20)).toBeNull();
    expect(receiver.trail.size).toBe(1);

    receiver.apply(frameOf({ frame: 0, clientId: "drag-id-0002", points: [[0, 0, 0]] }), 2000);
    receiver.removeForAnchor(99); // another round: untouched
    expect(receiver.current(2001)).not.toBeNull();
    receiver.removeForAnchor(7);
    expect(receiver.current(2002)).toBeNull();
    expect(receiver.trail.size).toBe(0);

    receiver.apply(frameOf({ frame: 0, clientId: "drag-id-0003", points: [[0, 0, 0]] }), 3000);
    receiver.clear();
    expect(receiver.current(3001)).toBeNull();
    expect(receiver.apply(frameOf({ frame: 0, clientId: "drag-id-0001", points: [[0, 0, 0]] }), 3002)).toBe("updated"); // memory cleared too
  });
});
