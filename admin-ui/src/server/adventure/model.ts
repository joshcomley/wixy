// Adventure Time's client-side record (workspace 00056; the `wyrModel.ts` precedent): the latest view
// of each round, the rule that decides when a view must be (re)fetched, and the clock.
//
// A `Message`'s `adventure` summary (`{state, pack, rev}`) only ever TRIGGERS a fetch of
// `GET /adventure/{seq}`; the view is the authority on what a card, the pane or the bank draws. A
// mutation answers with the fresh view, applied directly. A view is never replaced by an older one
// (`rev` only moves forward).
//
// THE CLOCK (spec §4.4). Every animation and both roulettes are driven by SERVER time so two screens
// agree and a late joiner lands mid-flight. Each view carries `serverNow`; the model keeps
// `offset = serverNow − localNow` from the response with the SMALLEST round trip (that sample's
// midpoint is the least wrong, because the error is at most half the round trip), and `serverNowS()`
// is local time plus that offset. An old best sample is let go after a while, so a drifting clock
// still tracks.

import type { Message } from "../api/messages";
import type { ServerSession } from "../types";
import type { AdventureOutcome, AdventureView } from "./api";

export interface AdventureModelDeps {
  session(): ServerSession | null;
  fetchRound(session: ServerSession, seq: number): Promise<AdventureOutcome>;
  /** A round's view changed: redraw its card and, if it is open, the pane. */
  onChange(seq: number): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** Local wall clock, milliseconds since the epoch (injectable for tests). Default `Date.now`. */
  now?(): number;
}

export interface AdventureModel {
  view(seq: number): AdventureView | undefined;
  /** A mutation's fresh view, applied immediately. */
  apply(view: AdventureView): void;
  /**
   * Runs a call that answers with a view (a mutation or a read), times it for the clock, and applies
   * the view when it succeeds. Rethrows whatever the call throws (a lock).
   */
  run(call: () => Promise<AdventureOutcome>): Promise<AdventureOutcome>;
  /** Look at the thread's messages and fetch whatever is stale. */
  observe(messages: readonly Message[]): void;
  /** Read the round again now (a 409 said somebody else moved; a setting changed). */
  refetch(seq: number): void;
  /** Drop one round (its message is gone). */
  forget(seq: number): void;
  /** Drop everything (lock, wipe, teardown). */
  reset(): void;
  /** The server's clock now, in epoch SECONDS (what every stored time is in). */
  serverNowS(): number;
  /** `serverNow − localNow` in milliseconds from the best sample, or null before the first view. */
  clockOffsetMs(): number | null;
}

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
/** A round trip longer than this says nothing useful about the clock. */
const MAX_SAMPLE_RTT_MS = 5_000;
/** The best sample is replaced by a fresher, noisier one after this long, so drift is followed. */
const SAMPLE_MAX_AGE_MS = 10 * 60_000;

interface Pending {
  inflight: boolean;
  /** A newer summary arrived while a fetch was out: fetch once more afterwards. */
  again: boolean;
  attempts: number;
  timer: number | null;
}

interface ClockSample {
  readonly offsetMs: number;
  readonly rttMs: number;
  readonly takenAt: number;
}

export function createAdventureModel(deps: AdventureModelDeps): AdventureModel {
  const clock = deps.now ?? (() => Date.now());
  const views = new Map<number, AdventureView>();
  const pending = new Map<number, Pending>();
  const latest = new Map<number, { readonly rev: number }>();
  /** Rounds to read again regardless of `rev` (a forced refetch, a renewed token). */
  const forced = new Set<number>();
  let generation = 0;
  let best: ClockSample | null = null;
  /** The token the held views' signed URLs were minted for. */
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
    // `rev` only moves forward, so a held view at the summary's rev or later is current — even when
    // the thread's summary lags it (a mutation answered before its stream frame arrived).
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

  function sample(startedAt: number, endedAt: number, view: AdventureView): void {
    const rttMs = endedAt - startedAt;
    if (!(rttMs >= 0) || rttMs > MAX_SAMPLE_RTT_MS) return;
    const offsetMs = view.serverNow * 1000 - (startedAt + endedAt) / 2;
    if (best === null || rttMs <= best.rttMs || endedAt - best.takenAt > SAMPLE_MAX_AGE_MS) {
      best = { offsetMs, rttMs, takenAt: endedAt };
    }
  }

  function apply(view: AdventureView): void {
    const have = views.get(view.seq);
    if (have !== undefined && have.rev > view.rev) return;
    views.set(view.seq, view);
    forced.delete(view.seq);
    viewsToken = deps.session()?.token ?? viewsToken;
    deps.onChange(view.seq);
  }

  async function fetchIfStale(seq: number): Promise<void> {
    const session = deps.session();
    if (session === null || !isStale(seq)) return;
    const entry = stateFor(seq);
    if (entry.inflight) {
      entry.again = true;
      return;
    }
    entry.inflight = true;
    const startedIn = generation;
    const startedAt = clock();
    let outcome: AdventureOutcome;
    try {
      outcome = await deps.fetchRound(session, seq);
    } catch {
      // A lock surfaces through the thread's own calls; here it is just a failed fetch.
      outcome = { ok: false, kind: "unavailable" };
    }
    entry.inflight = false;
    if (startedIn !== generation) return;
    if (outcome.ok) {
      entry.attempts = 0;
      sample(startedAt, clock(), outcome.view);
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

  function forget(seq: number): void {
    const entry = pending.get(seq);
    if (entry?.timer != null) deps.clearTimeout(entry.timer);
    pending.delete(seq);
    views.delete(seq);
    latest.delete(seq);
    forced.delete(seq);
  }

  function reset(): void {
    generation += 1;
    for (const entry of pending.values()) {
      if (entry.timer !== null) deps.clearTimeout(entry.timer);
    }
    pending.clear();
    views.clear();
    latest.clear();
    forced.clear();
    best = null;
    viewsToken = null;
  }

  return {
    view: (seq) => views.get(seq),
    apply,
    async run(call) {
      const startedAt = clock();
      const outcome = await call();
      if (outcome.ok) {
        sample(startedAt, clock(), outcome.view);
        apply(outcome.view);
      }
      return outcome;
    },
    observe(messages) {
      // A renewed unlock token signs fresh picture URLs: the views held were signed for the old one.
      const token = deps.session()?.token ?? null;
      if (token !== null && viewsToken !== null && token !== viewsToken) {
        viewsToken = token;
        for (const seq of views.keys()) forced.add(seq);
      }
      const seen = new Set<number>();
      for (const message of messages) {
        const summary = message.adventure;
        if (summary === undefined || summary === null) continue;
        seen.add(message.seq);
        latest.set(message.seq, summary);
        if (isStale(message.seq)) void fetchIfStale(message.seq);
      }
      for (const seq of [...latest.keys()]) {
        if (!seen.has(seq)) forget(seq);
      }
    },
    refetch(seq) {
      forced.add(seq);
      void fetchIfStale(seq);
    },
    forget,
    reset,
    serverNowS: () => (clock() + (best?.offsetMs ?? 0)) / 1000,
    clockOffsetMs: () => best?.offsetMs ?? null,
  };
}
