// The shell-owned draft op queue (spec/05-editor.md §2): "The shell owns state: it
// PATCHes /api/admin/draft (optimistic, queued, coalesced at 300 ms; 409 -> refetch
// overlay + replay queue) and echoes accepted ops back down."
//
// Kept framework-free and DOM-free on purpose — this is pure queueing/retry logic,
// unit-testable with vitest's fake timers without a real iframe or network.

import type { DraftOp } from "./protocol";

export const DEFAULT_COALESCE_MS = 300;

export type PatchResult = { kind: "ok"; rev: number } | { kind: "conflict" };

export interface OpQueueCallbacks {
  /** PATCH /api/admin/draft — resolves "ok" on 200, "conflict" on 409. Any other
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
  private pending: DraftOp[] = [];
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
    this.pending.push(op);
    this.maybeScheduleFlush();
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
        try {
          const result = await this.callbacks.sendPatch(this.currentRev, batch);
          if (result.kind === "ok") {
            this.currentRev = result.rev;
            this.callbacks.onAccepted?.(batch, result.rev);
          } else {
            this.currentRev = await this.callbacks.fetchCurrentRev();
            this.pending = [...batch, ...this.pending];
          }
        } catch (error) {
          this.pending = [...batch, ...this.pending];
          this.callbacks.onError?.(error);
          break;
        }
      }
    } finally {
      this.flushing = false;
      this.maybeScheduleFlush();
    }
  }
}
