// The would-you-rather game's client-side record (workspace 00045): the latest viewer-filtered
// view of each round, the not-yet-sent picks of the round being answered, and the rule that
// decides when a view must be (re)fetched.
//
// A `Message`'s `wyr` summary (`{state, rev}`) only ever TRIGGERS a fetch of
// `GET /wyr/{seq}?as=<me>`; the view is the authority on what a card shows. Mutations answer
// with the fresh view, applied directly. A view is never replaced by an older one (`rev` only
// moves forward), and a change of viewer name drops everything: the server filters per viewer,
// so a view fetched for someone else must never be drawn for this person.

import type { Message } from "./api/messages";
import type { WyrChoice, WyrOutcome, WyrView } from "./api/wyr";
import type { ServerSession } from "./types";

export interface WyrDraft {
  readonly choice: WyrChoice | null;
  readonly guess: WyrChoice | null;
}

export interface WyrModelDeps {
  session(): ServerSession | null;
  /** The current display name; null until the person has set one. */
  viewer(): string | null;
  fetchRound(session: ServerSession, seq: number, viewer: string): Promise<WyrOutcome>;
  /** A card for `seq` should be redrawn. */
  onChange(seq: number): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface WyrModel {
  view(seq: number): WyrView | undefined;
  draft(seq: number): WyrDraft;
  setDraft(seq: number, patch: Partial<WyrDraft>): void;
  /** A mutation's fresh view, applied immediately. */
  apply(view: WyrView): void;
  /** Look at the thread's messages and fetch whatever is stale. */
  observe(messages: readonly Message[]): void;
  /** Drop one round (its message is gone). */
  forget(seq: number): void;
  /** Drop everything (lock, wipe, name change, teardown). */
  reset(): void;
}

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;

interface Pending {
  inflight: boolean;
  /** A newer summary arrived while a fetch was out: fetch once more afterwards. */
  again: boolean;
  attempts: number;
  timer: number | null;
}

export function createWyrModel(deps: WyrModelDeps): WyrModel {
  const views = new Map<number, WyrView>();
  const drafts = new Map<number, WyrDraft>();
  const pending = new Map<number, Pending>();
  const latest = new Map<number, { readonly state: string; readonly rev: number }>();
  let generation = 0;
  let viewerKey: string | null = null;

  function stateFor(seq: number): Pending {
    let entry = pending.get(seq);
    if (entry === undefined) {
      entry = { inflight: false, again: false, attempts: 0, timer: null };
      pending.set(seq, entry);
    }
    return entry;
  }

  function isStale(seq: number): boolean {
    const summary = latest.get(seq);
    if (summary === undefined) return false;
    const have = views.get(seq);
    // `rev` only moves forward, so a held view at the summary's rev or later is current — even
    // when the thread's summary lags it (a mutation answered before its stream frame arrived).
    // Comparing `state` as well would refetch in a tight loop until a newer summary came.
    return have === undefined || have.rev < summary.rev;
  }

  function schedule(seq: number, entry: Pending): void {
    if (entry.timer !== null) return;
    const delay = RETRY_DELAYS_MS[Math.min(entry.attempts, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    entry.attempts += 1;
    entry.timer = deps.setTimeout(() => {
      entry.timer = null;
      void fetchIfStale(seq);
    }, delay);
  }

  async function fetchIfStale(seq: number): Promise<void> {
    const session = deps.session();
    const viewer = deps.viewer();
    if (session === null || viewer === null || !isStale(seq)) return;
    const entry = stateFor(seq);
    if (entry.inflight) {
      entry.again = true;
      return;
    }
    entry.inflight = true;
    const startedIn = generation;
    let outcome: WyrOutcome;
    try {
      outcome = await deps.fetchRound(session, seq, viewer);
    } catch {
      // A lock surfaces through the thread's own calls; here it is just a failed fetch.
      outcome = { ok: false, kind: "unavailable" };
    }
    entry.inflight = false;
    if (startedIn !== generation) return;
    if (outcome.ok) {
      entry.attempts = 0;
      apply(outcome.view);
    } else if (outcome.kind === "not_found") {
      forget(seq);
      return;
    } else {
      schedule(seq, entry);
      return;
    }
    if (entry.again || isStale(seq)) {
      entry.again = false;
      void fetchIfStale(seq);
    }
  }

  function apply(view: WyrView): void {
    const have = views.get(view.seq);
    if (have !== undefined && have.rev > view.rev) return;
    views.set(view.seq, view);
    const draft = drafts.get(view.seq);
    // Once the round has moved past answering (or the server already holds this person's
    // answer), the unsent draft is meaningless.
    if (draft !== undefined && (view.state !== "answering" || view.you?.choice != null)) {
      drafts.delete(view.seq);
    }
    deps.onChange(view.seq);
  }

  function forget(seq: number): void {
    const entry = pending.get(seq);
    if (entry?.timer != null) deps.clearTimeout(entry.timer);
    pending.delete(seq);
    views.delete(seq);
    drafts.delete(seq);
    latest.delete(seq);
  }

  function reset(): void {
    generation += 1;
    for (const entry of pending.values()) {
      if (entry.timer !== null) deps.clearTimeout(entry.timer);
    }
    pending.clear();
    views.clear();
    drafts.clear();
    latest.clear();
  }

  return {
    view: (seq) => views.get(seq),
    draft: (seq) => drafts.get(seq) ?? { choice: null, guess: null },
    setDraft(seq, patch) {
      const current = drafts.get(seq) ?? { choice: null, guess: null };
      drafts.set(seq, { ...current, ...patch });
      deps.onChange(seq);
    },
    apply,
    observe(messages) {
      const viewer = deps.viewer();
      const key = viewer === null ? null : viewer.trim().toLowerCase();
      if (key !== viewerKey) {
        const hadViewer = viewerKey !== null;
        viewerKey = key;
        if (hadViewer) reset();
      }
      const seen = new Set<number>();
      for (const message of messages) {
        const summary = message.wyr;
        if (summary === undefined || summary === null) continue;
        seen.add(message.seq);
        latest.set(message.seq, summary);
        if (isStale(message.seq)) void fetchIfStale(message.seq);
      }
      for (const seq of [...latest.keys()]) {
        if (!seen.has(seq)) forget(seq);
      }
    },
    forget,
    reset,
  };
}
