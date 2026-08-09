// The shell-owned draft op queue (spec/05-editor.md §2): "The shell owns state: it
// PATCHes /api/admin/draft (optimistic, queued, coalesced at 300 ms; 409 -> refetch
// overlay + replay queue) and echoes accepted ops back down."
//
// Kept framework-free and DOM-free on purpose — this is pure queueing/retry logic,
// unit-testable with vitest's fake timers without a real iframe or network.

import type { DraftOp } from "./protocol";

export const DEFAULT_COALESCE_MS = 300;

export type PatchResult =
  | { kind: "ok"; rev: number }
  | { kind: "conflict" }
  | { kind: "rejected"; message: string };

/** The real, per-batch fate of an `enqueueTracked` op — `accepted: true` only
 * once a PATCH actually landed (200), never inferred from a side-effect like
 * `rev` advancing (decisions/00119: a 409-refetch immediately followed by a
 * network error also advances `rev` via `fetchCurrentRev`, without the batch
 * landing — the gap decisions/00118's `saveNow()` originally papered over). */
export type EnqueueOutcome = { accepted: true; rev: number } | { accepted: false };

interface PendingEntry {
  op: DraftOp;
  onSettle: ((outcome: EnqueueOutcome) => void) | null;
}

export interface OpQueueCallbacks {
  /** PATCH /api/admin/draft — resolves "ok" on 200, "conflict" on 409, "rejected"
   * on 422 (decisions/00095: the draft-write gate found a structural problem —
   * this batch can never succeed by retrying, unlike a conflict). Any OTHER
   * failure (network error, 5xx) should reject the promise. */
  sendPatch: (expectedRev: number, ops: DraftOp[]) => Promise<PatchResult>;
  /** Re-read the overlay's current rev (e.g. from GET /api/admin/state) after a 409,
   * so the queued batch can be replayed against the real current rev. */
  fetchCurrentRev: () => Promise<number>;
  /** Called once a batch is accepted — the shell echoes these back to the overlay via
   * `applyOps` (spec/05 §2). */
  onAccepted?: (ops: DraftOp[], rev: number) => void;
  /** Called when `sendPatch`/`fetchCurrentRev` rejects — the batch is kept queued and
   * retried on the next flush. */
  onError?: (error: unknown) => void;
  /** Called when the server permanently rejects a batch (422 — decisions/00095).
   * The batch is DROPPED, not re-queued: unlike a conflict or a transient
   * network/5xx error, retrying an op the write gate found structurally
   * invalid can only loop forever. The caller (shell.ts) tells the owner and
   * reloads the preview so the live DOM reconverges with the real draft. */
  onRejected?: (ops: DraftOp[], message: string) => void;
}

/** Injectable in place of the real `setTimeout`/`clearTimeout` so tests can control
 * coalescing without real wall-clock waits (vitest's fake timers already patch the
 * globals, but an explicit seam keeps this module honest about the dependency). */
export interface Scheduler {
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
}

const realScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
};

export class OpQueue {
  private pending: PendingEntry[] = [];
  private currentRev: number;
  private timer: number | null = null;
  private flushing = false;
  private readonly coalesceMs: number;
  private readonly callbacks: OpQueueCallbacks;
  private readonly scheduler: Scheduler;

  constructor(
    initialRev: number,
    callbacks: OpQueueCallbacks,
    options?: { coalesceMs?: number; scheduler?: Scheduler },
  ) {
    this.currentRev = initialRev;
    this.callbacks = callbacks;
    this.coalesceMs = options?.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.scheduler = options?.scheduler ?? realScheduler;
  }

  /** The rev this queue currently believes is live — for tests/inspection only. */
  get rev(): number {
    return this.currentRev;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  enqueue(op: DraftOp): void {
    this.pending.push({ op, onSettle: null });
    this.maybeScheduleFlush();
  }

  /** Like `enqueue`, but resolves once THIS op's batch is either accepted or
   * this flush attempt gives up on it (a network/5xx error, or a permanent
   * 422 rejection) — bounded to the SAME attempt `flushNow()` triggers, never
   * left waiting on a future automatic background retry, so a caller
   * awaiting this gets an answer on the same timeline it would from a single
   * `flushNow()` call today, not an indefinitely-deferred one. Use this
   * instead of `enqueue` + comparing `rev` before/after when the caller
   * actually needs to know whether the write landed. */
  enqueueTracked(op: DraftOp): Promise<EnqueueOutcome> {
    return new Promise((resolve) => {
      this.pending.push({ op, onSettle: resolve });
      this.maybeScheduleFlush();
    });
  }

  private maybeScheduleFlush(): void {
    if (this.timer !== null || this.flushing || this.pending.length === 0) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.coalesceMs);
  }

  /** Flush immediately, bypassing the coalescing delay — e.g. before navigating away
   * from the edit view, so no queued op is silently lost. */
  async flushNow(): Promise<void> {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // A loop, not recursion: a 409 mid-flush re-fetches the rev and retries the
      // SAME batch immediately (no extra coalescing delay), and any op enqueued
      // during an in-flight request is picked up by the next iteration since
      // `this.pending` is read fresh each time, not snapshotted up front.
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        const ops = batch.map((entry) => entry.op);
        try {
          const result = await this.callbacks.sendPatch(this.currentRev, ops);
          if (result.kind === "ok") {
            this.currentRev = result.rev;
            this.callbacks.onAccepted?.(ops, result.rev);
            const rev = result.rev;
            batch.forEach((entry) => entry.onSettle?.({ accepted: true, rev }));
          } else if (result.kind === "rejected") {
            // Dropped, not re-queued (unlike "conflict" below) — a batch the
            // write gate found structurally invalid will fail the same way
            // every retry, so re-queuing it is an infinite loop, not a retry
            // (decisions/00095). currentRev is untouched: this batch never
            // actually landed, so the rev the queue believes is live didn't
            // change.
            this.callbacks.onRejected?.(ops, result.message);
            batch.forEach((entry) => entry.onSettle?.({ accepted: false }));
          } else {
            this.currentRev = await this.callbacks.fetchCurrentRev();
            this.pending = [...batch, ...this.pending];
          }
        } catch (error) {
          this.pending = [...batch, ...this.pending];
          this.callbacks.onError?.(error);
          // This attempt gives up on `batch` (a future automatic retry will
          // still pick it up via `maybeScheduleFlush` below, unchanged) — but
          // a tracked caller must not hang waiting for that eventual retry,
          // so settle it as "not accepted" now and detach the resolver so
          // the eventual retry's own settle (if any) is a harmless no-op.
          batch.forEach((entry) => {
            entry.onSettle?.({ accepted: false });
            entry.onSettle = null;
          });
          break;
        }
      }
    } finally {
      this.flushing = false;
      this.maybeScheduleFlush();
    }
  }
}
