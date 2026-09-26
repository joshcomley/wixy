// Live drawing — keeping the model in step with the server (spec/server-chat/07-live-drawing.md
// §2, §4): storing each finished stroke, deleting a drawing, and fetching the drawings a
// message's `drawings` summary says this client lacks.
//
// Storing (§2: "Each stroke is stored the moment it ends"; the task: "never lose a stroke on a
// flaky network"): each own drawing has a FIFO of strokes to store, sent one at a time — the
// first as `POST /drawings` (which creates the drawing), the rest as `POST .../strokes`. A write
// whose outcome is unknown is retried, with the same `clientId`/`strokeId`, after 1, 2, 4, 8 and
// then every 15 s: both routes are idempotent, so a retry can never store a stroke twice. Only a
// verdict on the stroke itself ends it early (the drawing or its message is gone, it is full, or
// the server refused the payload). A lock pauses the queue — timers cleared, nothing new sent
// with a token the client has let go of — and the next unlock resumes it with the fresh one.
//
// Fetching: a summary that says something new schedules one `GET /messages/{seq}/drawings`
// after a short pause (`FETCH_DEBOUNCE_MS`), re-checked when it fires — usually this client's
// own create answer has arrived by then and there is nothing left to fetch. At most one fetch
// per message is in flight (a newer summary meanwhile re-runs it once afterwards), and at most
// `MAX_CONCURRENT_FETCHES` overall.

import { ServerLockedError } from "./api/http";
import type {
  AppendStrokeResult,
  CreateDrawingInput,
  CreateDrawingResult,
  DeleteDrawingResult,
  DrawingStroke,
  DrawingSummary,
  StoredDrawing,
} from "./api/drawings";
import type { ApplyResult, DrawingModel, ModelDrawing, ModelStroke } from "./drawingModel";
import type { ServerSession } from "./types";

export interface DrawingSyncApi {
  createDrawing(session: ServerSession, input: CreateDrawingInput): Promise<CreateDrawingResult>;
  appendStroke(session: ServerSession, drawingId: number, stroke: DrawingStroke): Promise<AppendStrokeResult>;
  deleteDrawing(session: ServerSession, drawingId: number): Promise<DeleteDrawingResult>;
  getDrawings(session: ServerSession, seq: number): Promise<readonly StoredDrawing[]>;
}

/** Why an own drawing (or one stroke of it) could not be kept. */
export type DrawingLossReason =
  /** The drawing, or the message it was anchored to, no longer exists. */
  | "gone"
  /** The message already carries the maximum number of drawings. */
  | "anchorFull"
  /** The server refused the stroke itself (it would refuse it again). */
  | "invalid";

export interface DrawingSyncDeps {
  readonly model: DrawingModel;
  readonly api: DrawingSyncApi;
  session(): ServerSession | null;
  sender(): string;
  deviceId(): string;
  newId(): string;
  /** Whether `seq` is still a message this client shows (a fetch for a deleted one is dropped). */
  anchorAlive(seq: number): boolean;
  /** The model changed: redraw `changed`, take down `removed`, end the previews of `storedStrokeIds`. */
  onApplied(result: Pick<ApplyResult, "changed" | "removed" | "storedStrokeIds">): void;
  /** An own drawing (or one of its strokes) was dropped; the layer tells the owner if it matters. */
  onLost(drawing: ModelDrawing, reason: DrawingLossReason, strokeId: string | null): void;
  /** A full drawing's remaining strokes moved to `to` (the pen session continues in it). */
  onSplit(from: ModelDrawing, to: ModelDrawing): void;
  onLocked(): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export type DeleteOutcome = "ok" | "failed" | "locked";

export interface DrawingSync {
  /** Queue a finished stroke of an own drawing for storing. */
  storeStroke(drawing: ModelDrawing, stroke: ModelStroke): void;
  /** A message's current summary list: fetch its drawings if it says something new. */
  observe(seq: number, summaries: readonly DrawingSummary[]): void;
  /** Fetch `seq`'s drawings even if the summary looks settled (after a failed delete). */
  refetch(seq: number): void;
  /** Delete a drawing for everyone (the caller has already taken it off the screen). Drops the
   * drawing's unsent strokes; a create still in flight is deleted as soon as it answers. */
  deleteDrawing(drawing: ModelDrawing): Promise<DeleteOutcome>;
  /** Stop storing and fetching anything for `drawing` (its message went away). */
  forgetDrawing(key: string): void;
  forgetAnchor(seq: number): void;
  /** Lock: clear every timer and send nothing new until `resume`. In-flight answers still apply. */
  pause(): void;
  resume(): void;
  /** Wipe: drop every queue and fetch. */
  clear(): void;
  teardown(): void;
  /** For tests: strokes still waiting to be stored, per drawing key. */
  pendingCount(key: string): number;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const DELETE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const FETCH_DEBOUNCE_MS = 60;
const MAX_CONCURRENT_FETCHES = 4;

interface StoreQueue {
  readonly strokeIds: string[];
  running: boolean;
  attempts: number;
  timer: number | null;
  /** The drawing was deleted while its create was in flight: delete it once that answers. */
  deleteAfterCreate: boolean;
}

interface FetchState {
  timer: number | null;
  inFlight: boolean;
  dirty: boolean;
  force: boolean;
  attempts: number;
}

function retryDelay(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)] ?? 15_000;
}

function wireStroke(stroke: ModelStroke): DrawingStroke {
  return { strokeId: stroke.strokeId, color: stroke.color, width: stroke.width, points: stroke.points };
}

export function createDrawingSync(deps: DrawingSyncDeps): DrawingSync {
  const { model } = deps;
  const queues = new Map<string, StoreQueue>();
  const fetches = new Map<number, FetchState>();
  const latestSummaries = new Map<number, readonly DrawingSummary[]>();
  const waitingFetches: number[] = [];
  let activeFetches = 0;
  let paused = true;
  let generation = 0;

  // -- Storing ---------------------------------------------------------------------------

  function queueFor(key: string): StoreQueue {
    let queue = queues.get(key);
    if (queue === undefined) {
      queue = { strokeIds: [], running: false, attempts: 0, timer: null, deleteAfterCreate: false };
      queues.set(key, queue);
    }
    return queue;
  }

  function dropQueue(key: string): void {
    const queue = queues.get(key);
    if (queue === undefined) return;
    if (queue.timer !== null) deps.clearTimeout(queue.timer);
    queues.delete(key);
  }

  function kick(key: string): void {
    const queue = queues.get(key);
    if (queue === undefined || queue.running || queue.timer !== null || paused) return;
    if (queue.strokeIds.length === 0) {
      queues.delete(key);
      return;
    }
    void runHead(key, queue);
  }

  function scheduleRetry(key: string, queue: StoreQueue): void {
    const delay = retryDelay(queue.attempts);
    queue.attempts += 1;
    if (paused) return; // `resume` restarts it
    queue.timer = deps.setTimeout(() => {
      queue.timer = null;
      kick(key);
    }, delay);
  }

  async function runHead(key: string, queue: StoreQueue): Promise<void> {
    const drawing = model.get(key);
    const strokeId = queue.strokeIds[0];
    const session = deps.session();
    if (drawing === undefined || strokeId === undefined) {
      dropQueue(key);
      return;
    }
    if (session === null) return;
    const stroke = drawing.strokes.find((candidate) => candidate.strokeId === strokeId);
    if (stroke === undefined) {
      queue.strokeIds.shift();
      kick(key);
      return;
    }
    queue.running = true;
    const startGeneration = generation;
    stroke.sent = true;
    const creating = drawing.id === null;
    /** The server id this write created (a create) or wrote to (an append), when it succeeded. */
    let writtenId: number | null = null;
    let rev = 0;
    let kind: CreateDrawingResult["kind"] | AppendStrokeResult["kind"];
    try {
      if (creating) {
        const created = await deps.api.createDrawing(session, {
          clientId: drawing.clientId ?? "",
          anchorSeq: drawing.anchorSeq,
          columnWidth: drawing.columnWidth,
          sender: deps.sender(),
          deviceId: deps.deviceId(),
          stroke: wireStroke(stroke),
        });
        kind = created.kind;
        if (created.kind === "ok") {
          writtenId = created.id;
          rev = created.rev;
        }
      } else {
        const appended = await deps.api.appendStroke(session, drawing.id!, wireStroke(stroke));
        kind = appended.kind;
        if (appended.kind === "ok") {
          writtenId = drawing.id;
          rev = appended.rev;
        }
      }
    } catch (error) {
      queue.running = false;
      if (startGeneration !== generation) return;
      if (error instanceof ServerLockedError) {
        deps.onLocked();
        return;
      }
      scheduleRetry(key, queue);
      return;
    }
    queue.running = false;
    if (startGeneration !== generation) return;

    if (queue.deleteAfterCreate) {
      // Deleted while this write was out: whatever it made (or added to) must go too.
      dropQueue(key);
      if (writtenId !== null) void deleteWithRetries(session, writtenId);
      return;
    }

    switch (kind) {
      case "ok": {
        queue.attempts = 0;
        queue.strokeIds.shift();
        if (creating && writtenId !== null) {
          const confirmed = model.confirmCreate(key, writtenId, rev);
          if (confirmed !== undefined) model.confirmStroke(key, strokeId, rev);
        } else {
          model.confirmStroke(key, strokeId, rev);
        }
        const current = model.get(key);
        if (current !== undefined) {
          deps.onApplied({ changed: [key], removed: [], storedStrokeIds: [strokeId] });
          // A summary seen while this was out may now be fully accounted for — or not.
          const summaries = latestSummaries.get(current.anchorSeq);
          if (summaries !== undefined) observe(current.anchorSeq, summaries);
        }
        kick(key);
        return;
      }
      case "retry":
        scheduleRetry(key, queue);
        return;
      case "not_found": {
        dropQueue(key);
        const removed = model.remove(key);
        if (removed !== undefined) {
          if (removed.id !== null) model.tombstone(removed.id);
          deps.onApplied({ changed: [], removed: [removed], storedStrokeIds: [] });
          deps.onLost(removed, "gone", null);
        }
        return;
      }
      case "full": {
        if (creating) {
          dropQueue(key);
          const removed = model.remove(key);
          if (removed !== undefined) {
            deps.onApplied({ changed: [], removed: [removed], storedStrokeIds: [] });
            deps.onLost(removed, "anchorFull", null);
          }
          return;
        }
        // The drawing holds the maximum number of strokes: the rest start a new drawing on
        // the same message, at the same scale.
        const remaining = queue.strokeIds.splice(0);
        dropQueue(key);
        const moved = model.split(key, remaining, deps.newId());
        if (moved === undefined) return;
        deps.onSplit(drawing, moved);
        deps.onApplied({ changed: [key, moved.key], removed: [], storedStrokeIds: [] });
        for (const id of remaining) queueFor(moved.key).strokeIds.push(id);
        kick(moved.key);
        return;
      }
      case "invalid": {
        queue.strokeIds.shift();
        queue.attempts = 0;
        drawing.strokes = drawing.strokes.filter((candidate) => candidate.strokeId !== strokeId);
        deps.onLost(drawing, "invalid", strokeId);
        if (drawing.strokes.length === 0 && drawing.id === null) {
          dropQueue(key);
          model.remove(key);
          deps.onApplied({ changed: [], removed: [drawing], storedStrokeIds: [] });
          return;
        }
        deps.onApplied({ changed: [key], removed: [], storedStrokeIds: [] });
        kick(key);
        return;
      }
    }
  }

  // -- Deleting ----------------------------------------------------------------------------

  async function deleteWithRetries(session: ServerSession, drawingId: number): Promise<DeleteOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      let result: DeleteDrawingResult;
      try {
        result = await deps.api.deleteDrawing(session, drawingId);
      } catch (error) {
        if (error instanceof ServerLockedError) return "locked";
        result = { kind: "retry" };
      }
      if (result.kind === "ok") return "ok";
      if (result.kind === "failed" || attempt >= DELETE_RETRY_DELAYS_MS.length) return "failed";
      const delay = DELETE_RETRY_DELAYS_MS[attempt] ?? 4_000;
      await new Promise<void>((resolve) => deps.setTimeout(resolve, delay));
    }
  }

  async function deleteDrawing(drawing: ModelDrawing): Promise<DeleteOutcome> {
    const queue = queues.get(drawing.key);
    if (queue !== undefined) {
      if (queue.running) {
        // A write for it is out right now; whatever it creates or appends is deleted when it
        // answers (`runHead`). Unsent strokes are simply never sent.
        queue.deleteAfterCreate = true;
        queue.strokeIds.splice(1);
      } else {
        dropQueue(drawing.key);
      }
    }
    if (drawing.id === null) return "ok";
    const session = deps.session();
    if (session === null) return "failed";
    const outcome = await deleteWithRetries(session, drawing.id);
    if (outcome === "locked") deps.onLocked();
    return outcome;
  }

  // -- Fetching ----------------------------------------------------------------------------

  function fetchStateFor(seq: number): FetchState {
    let state = fetches.get(seq);
    if (state === undefined) {
      state = { timer: null, inFlight: false, dirty: false, force: false, attempts: 0 };
      fetches.set(seq, state);
    }
    return state;
  }

  function scheduleFetch(seq: number, delayMs: number): void {
    const state = fetchStateFor(seq);
    if (state.inFlight) {
      state.dirty = true;
      return;
    }
    if (state.timer !== null || paused) return;
    state.timer = deps.setTimeout(() => {
      state.timer = null;
      startFetch(seq);
    }, delayMs);
  }

  function startFetch(seq: number): void {
    const state = fetches.get(seq);
    if (state === undefined || paused) return;
    if (!deps.anchorAlive(seq)) {
      fetches.delete(seq);
      return;
    }
    const summaries = latestSummaries.get(seq) ?? [];
    if (!state.force && !model.needsFetch(seq, summaries)) {
      state.attempts = 0;
      return;
    }
    if (activeFetches >= MAX_CONCURRENT_FETCHES) {
      if (!waitingFetches.includes(seq)) waitingFetches.push(seq);
      return;
    }
    const session = deps.session();
    if (session === null) return;
    state.force = false;
    state.inFlight = true;
    activeFetches += 1;
    const requestEpoch = model.nextEpoch();
    const startGeneration = generation;
    deps.api
      .getDrawings(session, seq)
      .then((drawings) => {
        if (startGeneration !== generation) return;
        state.attempts = 0;
        if (!deps.anchorAlive(seq)) return;
        const result = model.applyFetched(seq, drawings, requestEpoch);
        if (!result.stale) deps.onApplied(result);
      })
      .catch((error: unknown) => {
        if (startGeneration !== generation) return;
        if (error instanceof ServerLockedError) {
          deps.onLocked();
          return;
        }
        state.dirty = true;
        state.attempts += 1;
      })
      .finally(() => {
        if (startGeneration !== generation) return;
        activeFetches -= 1;
        state.inFlight = false;
        if (state.dirty) {
          state.dirty = false;
          scheduleFetch(seq, state.attempts > 0 ? retryDelay(state.attempts - 1) : FETCH_DEBOUNCE_MS);
        }
        const next = waitingFetches.shift();
        if (next !== undefined) startFetch(next);
      });
  }

  function observe(seq: number, summaries: readonly DrawingSummary[]): void {
    latestSummaries.set(seq, summaries);
    if (model.needsFetch(seq, summaries)) scheduleFetch(seq, FETCH_DEBOUNCE_MS);
  }

  function clearFetchTimers(): void {
    for (const state of fetches.values()) {
      if (state.timer !== null) deps.clearTimeout(state.timer);
      state.timer = null;
    }
    waitingFetches.length = 0;
  }

  return {
    storeStroke(drawing: ModelDrawing, stroke: ModelStroke): void {
      const queue = queueFor(drawing.key);
      if (!queue.strokeIds.includes(stroke.strokeId)) queue.strokeIds.push(stroke.strokeId);
      kick(drawing.key);
    },
    observe,
    refetch(seq: number): void {
      fetchStateFor(seq).force = true;
      scheduleFetch(seq, 0);
    },
    deleteDrawing,
    forgetDrawing(key: string): void {
      dropQueue(key);
    },
    forgetAnchor(seq: number): void {
      const state = fetches.get(seq);
      if (state?.timer !== null && state?.timer !== undefined) deps.clearTimeout(state.timer);
      fetches.delete(seq);
      latestSummaries.delete(seq);
      const index = waitingFetches.indexOf(seq);
      if (index !== -1) waitingFetches.splice(index, 1);
      for (const [key] of queues) {
        const drawing = model.get(key);
        if (drawing === undefined || drawing.anchorSeq === seq) dropQueue(key);
      }
    },
    pause(): void {
      paused = true;
      for (const queue of queues.values()) {
        if (queue.timer !== null) deps.clearTimeout(queue.timer);
        queue.timer = null;
      }
      clearFetchTimers();
    },
    resume(): void {
      paused = false;
      for (const key of Array.from(queues.keys())) kick(key);
      for (const [seq, summaries] of latestSummaries) observe(seq, summaries);
    },
    clear(): void {
      generation += 1;
      for (const key of Array.from(queues.keys())) dropQueue(key);
      clearFetchTimers();
      fetches.clear();
      latestSummaries.clear();
      activeFetches = 0;
    },
    teardown(): void {
      paused = true;
      generation += 1;
      for (const key of Array.from(queues.keys())) dropQueue(key);
      clearFetchTimers();
      fetches.clear();
      latestSummaries.clear();
      activeFetches = 0;
    },
    pendingCount(key: string): number {
      return queues.get(key)?.strokeIds.length ?? 0;
    },
  };
}
