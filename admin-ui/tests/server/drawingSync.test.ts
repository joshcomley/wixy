// Storing, deleting and fetching drawings (spec/server-chat/07-live-drawing.md §2, §4; the task's
// "never lose a stroke on a flaky network"): each finished stroke is stored in order, one write
// at a time per drawing, retried with the SAME idempotency keys until the server gives a verdict;
// a lock pauses everything and the next unlock resumes it; summaries trigger at most one fetch
// per message at a time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppendStrokeResult,
  CreateDrawingInput,
  CreateDrawingResult,
  DeleteDrawingResult,
  DrawingStroke,
  StoredDrawing,
} from "../../src/server/api/drawings";
import { ServerLockedError } from "../../src/server/api/http";
import { createDrawingModel, type DrawingModel, type ModelDrawing, type ModelStroke } from "../../src/server/drawingModel";
import { FETCH_DEBOUNCE_MS, createDrawingSync, type DrawingSync, type DrawingSyncDeps } from "../../src/server/drawingSync";
import type { ServerSession } from "../../src/server/types";

const SESSION: ServerSession = { token: "tok-1", expiresAt: 9_999_999_999 };
const RENEWED: ServerSession = { token: "tok-2", expiresAt: 9_999_999_999 };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

interface Harness {
  readonly model: DrawingModel;
  readonly sync: DrawingSync;
  readonly deps: DrawingSyncDeps;
  readonly creates: Array<{ session: ServerSession; input: CreateDrawingInput; reply: Deferred<CreateDrawingResult> }>;
  readonly appends: Array<{ session: ServerSession; id: number; stroke: DrawingStroke; reply: Deferred<AppendStrokeResult> }>;
  readonly deletes: Array<{ id: number; reply: Deferred<DeleteDrawingResult> }>;
  readonly fetches: Array<{ seq: number; reply: Deferred<readonly StoredDrawing[]> }>;
  session: ServerSession | null;
  alive: Set<number>;
}

function harness(): Harness {
  const model = createDrawingModel();
  let idCounter = 0;
  const h = {
    model,
    creates: [],
    appends: [],
    deletes: [],
    fetches: [],
    session: SESSION as ServerSession | null,
    alive: new Set<number>([7, 8]),
  } as unknown as Harness;
  const deps: DrawingSyncDeps = {
    model,
    api: {
      createDrawing: (session, input) => {
        const reply = deferred<CreateDrawingResult>();
        h.creates.push({ session, input, reply });
        return reply.promise;
      },
      appendStroke: (session, id, stroke) => {
        const reply = deferred<AppendStrokeResult>();
        h.appends.push({ session, id, stroke, reply });
        return reply.promise;
      },
      deleteDrawing: (_session, id) => {
        const reply = deferred<DeleteDrawingResult>();
        h.deletes.push({ id, reply });
        return reply.promise;
      },
      getDrawings: (_session, seq) => {
        const reply = deferred<readonly StoredDrawing[]>();
        h.fetches.push({ seq, reply });
        return reply.promise;
      },
    },
    session: () => h.session,
    sender: () => "Alice",
    deviceId: () => "device-alice",
    newId: () => {
      idCounter += 1;
      return `new-client-${idCounter}`;
    },
    anchorAlive: (seq) => h.alive.has(seq),
    onApplied: vi.fn(),
    onLost: vi.fn(),
    onSplit: vi.fn(),
    onLocked: vi.fn(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
  (h as { deps: DrawingSyncDeps }).deps = deps;
  (h as { sync: DrawingSync }).sync = createDrawingSync(deps);
  h.sync.resume();
  return h;
}

function addStroke(drawing: ModelDrawing, strokeId: string): ModelStroke {
  const stroke: ModelStroke = {
    strokeId,
    color: "#ff3b30",
    width: 4,
    points: [[1, 2], [3, 4]],
    state: "pending",
    sent: false,
  };
  drawing.strokes.push(stroke);
  return stroke;
}

function own(h: Harness, clientId = "client-1", anchorSeq = 7): ModelDrawing {
  return h.model.addOwn({ clientId, anchorSeq, columnWidth: 310, sender: "Alice" });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("drawingSync: storing strokes", () => {
  it("the first stroke creates the drawing; later ones wait for it, then append in order", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    h.sync.storeStroke(drawing, addStroke(drawing, "s2"));
    h.sync.storeStroke(drawing, addStroke(drawing, "s3"));
    await flush();

    expect(h.creates).toHaveLength(1);
    expect(h.appends).toHaveLength(0); // never two writes in flight for one drawing
    const create = h.creates[0]!;
    expect(create.session).toBe(SESSION);
    expect(create.input).toEqual({
      clientId: "client-1",
      anchorSeq: 7,
      columnWidth: 310,
      sender: "Alice",
      deviceId: "device-alice",
      stroke: { strokeId: "s1", color: "#ff3b30", width: 4, points: [[1, 2], [3, 4]] },
    });

    create.reply.resolve({ kind: "ok", id: 41, rev: 1 });
    await flush();
    expect(drawing.id).toBe(41);
    expect(drawing.strokes[0]?.state).toBe("stored");
    expect(h.appends.map((a) => [a.id, a.stroke.strokeId])).toEqual([[41, "s2"]]);

    h.appends[0]!.reply.resolve({ kind: "ok", rev: 2 });
    await flush();
    expect(h.appends.map((a) => a.stroke.strokeId)).toEqual(["s2", "s3"]);
    h.appends[1]!.reply.resolve({ kind: "ok", rev: 3 });
    await flush();
    expect(drawing.strokes.map((s) => s.state)).toEqual(["stored", "stored", "stored"]);
    expect(drawing.rev).toBe(3);
    expect(h.sync.pendingCount(drawing.key)).toBe(0);
  });

  it("a write with no verdict is retried with the SAME client id and stroke id, backing off 1, 2, 4, 8 then 15 s", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    await flush();
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      h.creates[attempt]!.reply.resolve({ kind: "retry" });
      await flush();
      await vi.advanceTimersByTimeAsync(delays[attempt]! - 1);
      expect(h.creates).toHaveLength(attempt + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.creates).toHaveLength(attempt + 2);
    }
    expect(new Set(h.creates.map((c) => c.input.clientId))).toEqual(new Set(["client-1"]));
    expect(new Set(h.creates.map((c) => c.input.stroke.strokeId))).toEqual(new Set(["s1"]));
    h.creates.at(-1)!.reply.resolve({ kind: "ok", id: 41, rev: 1 });
    await flush();
    expect(drawing.id).toBe(41);
  });

  it("a thrown network error is retried too; a 401 locks and schedules nothing", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    await flush();
    h.creates[0]!.reply.reject(new TypeError("Failed to fetch"));
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.creates).toHaveLength(2);
    h.creates[1]!.reply.reject(new ServerLockedError());
    await flush();
    expect(h.deps.onLocked).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.creates).toHaveLength(2);
    // The stroke is still owed: the next unlock stores it with the fresh token.
    h.sync.pause();
    h.session = RENEWED;
    h.sync.resume();
    await flush();
    expect(h.creates).toHaveLength(3);
    expect(h.creates[2]!.session).toBe(RENEWED);
  });

  it("a lock pauses the queue (timers cleared, nothing new sent) and the next unlock resumes it", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    await flush();
    h.creates[0]!.reply.resolve({ kind: "retry" });
    await flush();
    h.sync.pause();
    h.session = null;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.creates).toHaveLength(1);
    h.session = RENEWED;
    h.sync.resume();
    await flush();
    expect(h.creates).toHaveLength(2);
    expect(h.creates[1]!.session).toBe(RENEWED);
  });

  it("a write already out when the lock lands still applies its answer, but the next waits for the unlock", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    h.sync.storeStroke(drawing, addStroke(drawing, "s2"));
    await flush();
    h.sync.pause();
    h.creates[0]!.reply.resolve({ kind: "ok", id: 41, rev: 1 });
    await flush();
    expect(drawing.id).toBe(41);
    expect(h.appends).toHaveLength(0);
    h.sync.resume();
    await flush();
    expect(h.appends.map((a) => a.stroke.strokeId)).toEqual(["s2"]);
  });

  it("not found on create (the message is gone): the drawing is dropped and reported, nothing retried", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    h.sync.storeStroke(drawing, addStroke(drawing, "s2"));
    await flush();
    h.creates[0]!.reply.resolve({ kind: "not_found" });
    await flush();
    expect(h.model.get(drawing.key)).toBeUndefined();
    expect(h.deps.onLost).toHaveBeenCalledWith(drawing, "gone", null);
    expect(h.deps.onApplied).toHaveBeenCalledWith({ changed: [], removed: [drawing], storedStrokeIds: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.creates).toHaveLength(1);
    expect(h.appends).toHaveLength(0);
  });

  it("not found on append (deleted by the other person): dropped, tombstoned, never recreated", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    await flush();
    h.creates[0]!.reply.resolve({ kind: "ok", id: 41, rev: 1 });
    await flush();
    h.sync.storeStroke(drawing, addStroke(drawing, "s2"));
    await flush();
    h.appends[0]!.reply.resolve({ kind: "not_found" });
    await flush();
    expect(h.model.get(drawing.key)).toBeUndefined();
    expect(h.model.isTombstoned(41)).toBe(true);
    expect(h.creates).toHaveLength(1);
  });

  it("full on create (the message has 20 drawings): dropped and reported as such", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    await flush();
    h.creates[0]!.reply.resolve({ kind: "full" });
    await flush();
    expect(h.model.get(drawing.key)).toBeUndefined();
    expect(h.deps.onLost).toHaveBeenCalledWith(drawing, "anchorFull", null);
  });

  it("full on append (200 strokes): the stroke and every later one move to a new drawing, which is created", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    await flush();
    h.creates[0]!.reply.resolve({ kind: "ok", id: 41, rev: 200 });
    await flush();
    h.sync.storeStroke(drawing, addStroke(drawing, "s2"));
    h.sync.storeStroke(drawing, addStroke(drawing, "s3"));
    await flush();
    h.appends[0]!.reply.resolve({ kind: "full" });
    await flush();
    const moved = h.model.get("c:new-client-1");
    expect(moved?.strokes.map((s) => s.strokeId)).toEqual(["s2", "s3"]);
    expect(drawing.strokes.map((s) => s.strokeId)).toEqual(["s1"]);
    expect(h.deps.onSplit).toHaveBeenCalledWith(drawing, moved);
    expect(h.creates).toHaveLength(2);
    expect(h.creates[1]!.input.clientId).toBe("new-client-1");
    expect(h.creates[1]!.input.anchorSeq).toBe(7);
    expect(h.creates[1]!.input.stroke.strokeId).toBe("s2");
  });

  it("invalid (the server refused the stroke itself): that stroke alone is dropped and the next goes on", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    h.sync.storeStroke(drawing, addStroke(drawing, "s2"));
    await flush();
    h.creates[0]!.reply.resolve({ kind: "invalid", status: 422 });
    await flush();
    expect(h.deps.onLost).toHaveBeenCalledWith(drawing, "invalid", "s1");
    // The drawing was never created, so the next stroke creates it (same client id).
    expect(h.creates).toHaveLength(2);
    expect(h.creates[1]!.input.clientId).toBe("client-1");
    expect(h.creates[1]!.input.stroke.strokeId).toBe("s2");
    expect(drawing.strokes.map((s) => s.strokeId)).toEqual(["s2"]);
  });
});

describe("drawingSync: deleting", () => {
  it("deletes by id and resolves ok", async () => {
    const h = harness();
    h.model.applyFetched(7, [{ id: 5, rev: 1, sender: "Bob", columnWidth: 310, strokes: [] }], h.model.nextEpoch());
    const drawing = h.model.byId(5)!;
    const outcome = h.sync.deleteDrawing(drawing);
    await flush();
    expect(h.deletes.map((d) => d.id)).toEqual([5]);
    h.deletes[0]!.reply.resolve({ kind: "ok" });
    await expect(outcome).resolves.toBe("ok");
  });

  it("an unknown outcome is retried after 1, 2 and 4 s, then reported as failed", async () => {
    const h = harness();
    h.model.applyFetched(7, [{ id: 5, rev: 1, sender: "Bob", columnWidth: 310, strokes: [] }], h.model.nextEpoch());
    const outcome = h.sync.deleteDrawing(h.model.byId(5)!);
    for (const delay of [1_000, 2_000, 4_000]) {
      await flush();
      h.deletes.at(-1)!.reply.resolve({ kind: "retry" });
      await flush();
      await vi.advanceTimersByTimeAsync(delay);
    }
    await flush();
    expect(h.deletes).toHaveLength(4);
    h.deletes[3]!.reply.resolve({ kind: "retry" });
    await expect(outcome).resolves.toBe("failed");
  });

  it("a definite refusal is failed at once; a 401 is 'locked' and locks", async () => {
    const h = harness();
    h.model.applyFetched(7, [{ id: 5, rev: 1, sender: "Bob", columnWidth: 310, strokes: [] }], h.model.nextEpoch());
    const refused = h.sync.deleteDrawing(h.model.byId(5)!);
    await flush();
    h.deletes[0]!.reply.resolve({ kind: "failed", status: 400 });
    await expect(refused).resolves.toBe("failed");

    const locked = h.sync.deleteDrawing(h.model.byId(5)!);
    await flush();
    h.deletes[1]!.reply.reject(new ServerLockedError());
    await expect(locked).resolves.toBe("locked");
    expect(h.deps.onLocked).toHaveBeenCalled();
  });

  it("deleting while the create is still out: unsent strokes are never sent and the created drawing is deleted", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    h.sync.storeStroke(drawing, addStroke(drawing, "s2"));
    await flush();
    h.model.remove(drawing.key);
    await expect(h.sync.deleteDrawing(drawing)).resolves.toBe("ok");
    h.creates[0]!.reply.resolve({ kind: "ok", id: 41, rev: 1 });
    await flush();
    expect(h.deletes.map((d) => d.id)).toEqual([41]);
    expect(h.appends).toHaveLength(0);
  });

  it("deleting a drawing nothing was ever sent for just drops its queue", async () => {
    const h = harness();
    h.sync.pause();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    h.model.remove(drawing.key);
    await expect(h.sync.deleteDrawing(drawing)).resolves.toBe("ok");
    h.sync.resume();
    await flush();
    expect(h.creates).toHaveLength(0);
    expect(h.deletes).toHaveLength(0);
  });
});

describe("drawingSync: fetching what a summary says is new", () => {
  it("one fetch after a short pause, applied to the model and reported", async () => {
    const h = harness();
    h.sync.observe(7, [{ id: 5, rev: 1 }]);
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS - 1);
    expect(h.fetches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetches.map((f) => f.seq)).toEqual([7]);
    h.fetches[0]!.reply.resolve([
      { id: 5, rev: 1, sender: "Bob", columnWidth: 310, strokes: [{ strokeId: "x1", color: "#0a84ff", width: 2, points: [[1, 1], [2, 2]] }] },
    ]);
    await flush();
    expect(h.model.byId(5)?.strokes.map((s) => s.strokeId)).toEqual(["x1"]);
    expect(h.deps.onApplied).toHaveBeenCalledWith(expect.objectContaining({ changed: ["s:5"], storedStrokeIds: ["x1"] }));
  });

  it("re-checks when the pause ends: this client's own create answering meanwhile makes the fetch unnecessary", async () => {
    const h = harness();
    const drawing = own(h);
    h.sync.storeStroke(drawing, addStroke(drawing, "s1"));
    await flush();
    // The stream's message_updated for our own create can beat the create's answer.
    h.sync.observe(7, [{ id: 41, rev: 1 }]);
    h.creates[0]!.reply.resolve({ kind: "ok", id: 41, rev: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS * 4);
    expect(h.fetches).toHaveLength(0);
  });

  it("at most one fetch per message in flight; a newer summary meanwhile runs it once more afterwards", async () => {
    const h = harness();
    h.sync.observe(7, [{ id: 5, rev: 1 }]);
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS);
    h.sync.observe(7, [{ id: 5, rev: 2 }]);
    h.sync.observe(7, [{ id: 5, rev: 3 }]);
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS * 3);
    expect(h.fetches).toHaveLength(1);
    h.fetches[0]!.reply.resolve([{ id: 5, rev: 1, sender: "Bob", columnWidth: 310, strokes: [] }]);
    await flush();
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS);
    expect(h.fetches).toHaveLength(2);
  });

  it("a failed fetch is retried with backoff; a 401 locks instead", async () => {
    const h = harness();
    h.sync.observe(7, [{ id: 5, rev: 1 }]);
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS);
    h.fetches[0]!.reply.reject(new Error("Couldn't load drawings (500)."));
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetches).toHaveLength(2);
    h.fetches[1]!.reply.reject(new ServerLockedError());
    await flush();
    expect(h.deps.onLocked).toHaveBeenCalledTimes(1);
  });

  it("never fetches for a message that is gone, and drops an answer that arrives after it went", async () => {
    const h = harness();
    h.alive.delete(8);
    h.sync.observe(8, [{ id: 5, rev: 1 }]);
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS);
    expect(h.fetches).toHaveLength(0);

    h.sync.observe(7, [{ id: 6, rev: 1 }]);
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS);
    h.alive.delete(7);
    h.fetches[0]!.reply.resolve([{ id: 6, rev: 1, sender: "Bob", columnWidth: 310, strokes: [] }]);
    await flush();
    expect(h.model.byId(6)).toBeUndefined();
  });

  it("at most four fetches at once; the rest wait their turn", async () => {
    const h = harness();
    for (let seq = 1; seq <= 6; seq += 1) h.alive.add(seq);
    for (let seq = 1; seq <= 6; seq += 1) h.sync.observe(seq, [{ id: 100 + seq, rev: 1 }]);
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS);
    expect(h.fetches).toHaveLength(4);
    h.fetches[0]!.reply.resolve([]);
    await flush();
    expect(h.fetches).toHaveLength(5);
  });

  it("refetch fetches even when the summary looks settled (a failed delete coming back)", async () => {
    const h = harness();
    h.sync.refetch(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetches.map((f) => f.seq)).toEqual([7]);
  });

  it("a wipe (clear) discards answers still out", async () => {
    const h = harness();
    h.sync.observe(7, [{ id: 5, rev: 1 }]);
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS);
    h.sync.clear();
    h.fetches[0]!.reply.resolve([{ id: 5, rev: 1, sender: "Bob", columnWidth: 310, strokes: [] }]);
    await flush();
    expect(h.model.byId(5)).toBeUndefined();
    expect(h.deps.onApplied).not.toHaveBeenCalled();
  });

  it("while paused (locked), summaries are remembered and fetched on resume", async () => {
    const h = harness();
    h.sync.pause();
    h.sync.observe(7, [{ id: 5, rev: 1 }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.fetches).toHaveLength(0);
    h.sync.resume();
    await vi.advanceTimersByTimeAsync(FETCH_DEBOUNCE_MS);
    expect(h.fetches.map((f) => f.seq)).toEqual([7]);
  });
});
