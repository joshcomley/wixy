// Cookout's client-side record (workspace 00058; spec/server-chat/09-cookout.md §5.2, the `wyrModel.ts`
// and `adventure/model.ts` precedents): the latest viewer-filtered view of each round and the rule
// that decides when a view must be (re)fetched.
//
// A `Message`'s `cookout` summary (`{state, blind, pickedCount, concepts, bankedCount, rev}`) only ever
// TRIGGERS a fetch of `GET /cookout/{seq}?as=<viewer>`; the view is the authority on what the card,
// the pane and the book draw. A mutation answers with the fresh view, applied directly. A view is
// never replaced by an older one (`rev` only moves forward).
//
// THE VIEWER. A Blind round is filtered per viewer on the server, so a view belongs to the name it was
// asked as: a change of display name drops every view (they were someone else's) and reads again.
//
// POLLING. Each change the server makes publishes `message_updated`, so the stream normally drives
// everything. While the chef, the dish pictures or a recipe is still working (`pending`), the model
// also re-reads the round on an exponential backoff (2 s, 4 s, 8 s … 30 s), so a missed stream frame
// (a sleeping phone, a slot swap) can never leave a "Writing recipe…" spinner up forever. The backoff
// starts again whenever what is pending changes, and stops when nothing is.

import type { Message } from "../api/messages";
import type { ServerSession } from "../types";
import { parseCookoutSummary, type CookoutOutcome, type CookoutView } from "./api";

export interface CookoutModelDeps {
  session(): ServerSession | null;
  /** The name this screen plays as (the `?as=` of every read), or null before there is one. */
  viewer(): string | null;
  fetchRound(session: ServerSession, seq: number, viewer: string): Promise<CookoutOutcome>;
  /** A round's view changed: redraw its card and, if it is open, the pane. */
  onChange(seq: number): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface CookoutModel {
  view(seq: number): CookoutView | undefined;
  /** A mutation's fresh view, applied immediately. */
  apply(view: CookoutView): void;
  /** Runs a call that answers with a view and applies it when it succeeds. Rethrows a lock. */
  run(call: () => Promise<CookoutOutcome>): Promise<CookoutOutcome>;
  /** Look at the thread's messages and fetch whatever is stale. */
  observe(messages: readonly Message[]): void;
  /** Read the round again now (a 409 said somebody else moved). */
  refetch(seq: number): void;
  /** Drop one round (its message is gone). */
  forget(seq: number): void;
  /** Drop everything (lock, wipe, teardown). */
  reset(): void;
}

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
/** The poll backoff while something is pending: doubles from 2 s up to 30 s. */
export const POLL_FIRST_MS = 2_000;
export const POLL_MAX_MS = 30_000;

/** What of a round is still being worked on by the server, as a comparable key ("" = nothing). */
export function pendingKey(view: CookoutView): string {
  const parts: string[] = [];
  if (view.state !== "finished") return "";
  if (view.concepts.state === "pending") parts.push("concepts");
  if (view.images.state === "pending") parts.push("images");
  for (const id of ["a", "b", "c"] as const) {
    if (view.recipes[id].state === "pending") parts.push(`recipe-${id}`);
  }
  return parts.join(",");
}

/** The delay before the `attempt`-th poll (0-based): 2 s, 4 s, 8 s, 16 s, then 30 s. */
export function pollDelayMs(attempt: number): number {
  return Math.min(POLL_MAX_MS, POLL_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
}

interface Pending {
  inflight: boolean;
  /** A newer summary arrived while a fetch was out: fetch once more afterwards. */
  again: boolean;
  attempts: number;
  timer: number | null;
}

interface Poll {
  key: string;
  attempts: number;
  timer: number | null;
}

export function createCookoutModel(deps: CookoutModelDeps): CookoutModel {
  const views = new Map<number, CookoutView>();
  const pending = new Map<number, Pending>();
  const polls = new Map<number, Poll>();
  const latest = new Map<number, { readonly rev: number }>();
  /** Rounds to read again regardless of `rev` (a forced refetch, a renewed token, a poll). */
  const forced = new Set<number>();
  let generation = 0;
  let viewerKey: string | null = null;
  /** The token the held views' signed picture URLs were minted for. */
  let viewsToken: string | null = null;

  function stateFor(seq: number): Pending {
    let entry = pending.get(seq);
    if (entry === undefined) {
      entry = { inflight: false, again: false, attempts: 0, timer: null };
      pending.set(seq, entry);
    }
    return entry;
  }

  function isStale(seq: number): boolean {
    if (forced.has(seq)) return true;
    const summary = latest.get(seq);
    if (summary === undefined) return false;
    const have = views.get(seq);
    // `rev` only moves forward: a held view at the summary's rev or later is current, even when the
    // thread's summary lags it (a mutation answered before its stream frame arrived).
    return have === undefined || have.rev < summary.rev;
  }

  function scheduleRetry(seq: number, entry: Pending): void {
    if (entry.timer !== null) return;
    const delay = RETRY_DELAYS_MS[Math.min(entry.attempts, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    entry.attempts += 1;
    entry.timer = deps.setTimeout(() => {
      entry.timer = null;
      void fetchIfStale(seq);
    }, delay);
  }

  function stopPoll(seq: number): void {
    const poll = polls.get(seq);
    if (poll?.timer != null) deps.clearTimeout(poll.timer);
    polls.delete(seq);
  }

  /** (Re)arms the round's poll for what is pending in `view`; stops it when nothing is. */
  function armPoll(view: CookoutView): void {
    const key = pendingKey(view);
    if (key === "") {
      stopPoll(view.seq);
      return;
    }
    let poll = polls.get(view.seq);
    if (poll !== undefined && poll.key !== key) {
      // Something new is pending (or something finished): start the backoff again.
      if (poll.timer !== null) deps.clearTimeout(poll.timer);
      poll = undefined;
    }
    if (poll === undefined) {
      poll = { key, attempts: 0, timer: null };
      polls.set(view.seq, poll);
    }
    if (poll.timer !== null) return;
    const armed = poll;
    const delay = pollDelayMs(armed.attempts);
    armed.attempts += 1;
    armed.timer = deps.setTimeout(() => {
      armed.timer = null;
      if (polls.get(view.seq) !== armed) return;
      forced.add(view.seq);
      void fetchIfStale(view.seq);
    }, delay);
  }

  function apply(view: CookoutView): void {
    const have = views.get(view.seq);
    if (have !== undefined && have.rev > view.rev) return;
    views.set(view.seq, view);
    forced.delete(view.seq);
    viewsToken = deps.session()?.token ?? viewsToken;
    armPoll(view);
    deps.onChange(view.seq);
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
    let outcome: CookoutOutcome;
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
      // An equal-rev answer (a poll's, usually) is applied too: it re-arms the poll's backoff.
      apply(outcome.view);
      forced.delete(seq);
    } else if (outcome.kind === "not_found") {
      forget(seq);
      return;
    } else {
      scheduleRetry(seq, entry);
      return;
    }
    if (entry.again) {
      entry.again = false;
      void fetchIfStale(seq);
    } else if (isStale(seq)) {
      // The server answered with something older than its own summary says exists (a lagging replica
      // during a slot swap): look again after a pause, never in a tight loop.
      scheduleRetry(seq, entry);
    }
  }

  function forget(seq: number): void {
    const entry = pending.get(seq);
    if (entry?.timer != null) deps.clearTimeout(entry.timer);
    pending.delete(seq);
    stopPoll(seq);
    views.delete(seq);
    latest.delete(seq);
    forced.delete(seq);
  }

  function reset(): void {
    generation += 1;
    for (const entry of pending.values()) {
      if (entry.timer !== null) deps.clearTimeout(entry.timer);
    }
    for (const poll of polls.values()) {
      if (poll.timer !== null) deps.clearTimeout(poll.timer);
    }
    pending.clear();
    polls.clear();
    views.clear();
    latest.clear();
    forced.clear();
    viewsToken = null;
  }

  return {
    view: (seq) => views.get(seq),
    apply,
    async run(call) {
      const outcome = await call();
      if (outcome.ok) apply(outcome.view);
      return outcome;
    },
    observe(messages) {
      const viewer = deps.viewer();
      const key = viewer === null ? null : viewer.trim().toLowerCase();
      if (key !== viewerKey) {
        // Every held view was filtered for the old name (a Blind round especially): drop them all.
        const hadViewer = viewerKey !== null;
        viewerKey = key;
        if (hadViewer) reset();
      }
      // A renewed unlock token signs fresh picture URLs: the views held were signed for the old one.
      const token = deps.session()?.token ?? null;
      if (token !== null && viewsToken !== null && token !== viewsToken) {
        viewsToken = token;
        for (const seq of views.keys()) forced.add(seq);
      }
      const seen = new Set<number>();
      for (const message of messages) {
        const summary = parseCookoutSummary(message.cookout);
        if (summary === null) continue;
        seen.add(message.seq);
        latest.set(message.seq, summary);
        if (isStale(message.seq)) void fetchIfStale(message.seq);
      }
      // A round whose message is no longer in the thread (deleted, wiped) goes — including one held only
      // because a mutation answered with it — and so does its poll.
      for (const seq of new Set([...latest.keys(), ...views.keys()])) {
        if (!seen.has(seq)) forget(seq);
      }
    },
    refetch(seq) {
      forced.add(seq);
      void fetchIfStale(seq);
    },
    forget,
    reset,
  };
}
