// The local Adventure Time game of the public page (spec/adventure-public section 2.4): the SAME state
// machine the private game's server runs (docs/ai/livechat.md section 23; `LiveChatStore.spin_adventure`,
// `stop_adventure`, `decide_adventure`, `retry_adventure_pack` in wixy_server/livechat/store.py), kept in
// this page's memory for ONE round at a time and answering the pane's calls with the same `AdventureView`s
// the server would:
//
//   spin_lng -> spin_lat -> country -> destination -> chosen -> banked | rejected
//
//   - a spin is stored once; the SAME spin repeated after the state moved is an idempotent success, a
//     different one is `bad_state` (and a spin outside the server's bounds is `invalid`);
//   - the second spin carries where it landed and the candidate countries (every one a playable unit); the
//     country roulette starts at `at + duration + 5 s`, the destination roulette `3.5 s` after the country
//     Stop; a Stop before its roulette (less 1 s of tolerance) is `too_early`; a choice that is not a
//     candidate is `invalid`;
//   - the country Stop draws the country's top five places (`PublicBank.topDestinations`, the TS port of the
//     server's rule): none left, or the country not playable under the present setting, is `exhausted` (the
//     round stays in `country`); exactly one skips the roulette and goes straight to `chosen`;
//   - Yay banks into this browser's memory and Nay adds the place to the never-again list (and ends the
//     wait for its pack); "remaining" is the bank minus both lists;
//   - `eligible` (the units a landing may be in) is recomputed at READ time, so the Options switch applies
//     to the round on show.
//
// What the server does that this does not: nothing is stored anywhere but `memory.ts`; there is no partner,
// no live finger trail and no second round at once (a new round replaces the one on show).
//
// THE PACK. On entering `chosen` the place's holiday pack is read from the public cache and, when nobody has
// researched it yet, requested (`PackClient`): `GET /api/pack/{code}`; `none` or a retryable `failed` ->
// `POST`; then `GET` every 5 s while the pack or its pictures are pending. A 429 on the POST shows the
// friendly wait line and keeps polling the GET (someone else's request may already be researching the
// place), asking again once `Retry-After` has passed. Try again is a POST. Every answer becomes the view's
// `PackView` and a fresh view is published to the model.
//
// A DEEP LINK (`openPlace`) builds the round directly in `chosen`: the landing is the place's own point in
// its own unit, no spins, no roulettes; the scene's "late joiner sees the place at once" path draws it.

import type {
  AdventureAxis,
  AdventureDest,
  AdventureLanding,
  AdventureOutcome,
  AdventureSettings,
  AdventureSpin,
  AdventureState,
  AdventureView,
  PackView,
  SettingsResult,
  SpinInput,
} from "../server/adventure/api";
import type { AdventureGamePaneApi } from "../server/adventure/adventureGame";
import type { StopIntent } from "../server/adventure/scene";
import { createAdventureModel, type AdventureModel } from "../server/adventure/model";
import type { PublicBank, PublicDest } from "./bank";
import { TOP_DESTINATIONS } from "./bank";
import type { Memory } from "./memory";
import type { PackAnswer, PackClient } from "./packClient";

/** The one player's name in every view (`startedBy`, a spin's `by`, `decidedBy`). */
export const VIEWER = "You";

// The server's own bounds (wixy_server/livechat/adventure_game.py, store.py).
const SPIN_MIN_DELTA_DEG = 720;
const SPIN_MAX_DELTA_DEG = 3960;
const SPIN_MIN_DURATION_MS = 3500;
const SPIN_MAX_DURATION_MS = 7000;
const SPIN_MAX_ABS_FROM_DEG = 1e6;
const MIN_CANDIDATES = 1;
const MAX_CANDIDATES = 10;
const ROULETTE_SETTLE_S = 5;
const DESTINATION_SETTLE_S = 3.5;
const STOP_TOLERANCE_S = 1;

/** The pack poll interval (spec section 2.4). */
export const PACK_POLL_MS = 5_000;
/** Pictures are found after the text: a ready pack that says "no pictures yet" is asked this many more times. */
const SETTLE_POLLS = 3;
/** Consecutive failed requests after which the pack is shown as failed (with Try again). */
const MAX_PACK_ERRORS = 6;
const MAX_ERROR_BACKOFF_MS = 30_000;
const MAX_FAILED_RECHECK_S = 900;
const MIN_POST_SPACING_MS = 5_000;

export const RATE_LIMITED_NOTICE = "Lots of people are exploring right now — try this place again in a few minutes";
const PACK_STOPPED_TEXT = "The research was stopped";
const PACK_LOST_TEXT = "We couldn't reach the server to fetch the holiday pack. Try again.";
const PACK_GONE_TEXT = "That place has no holiday pack on this server.";

const PENDING_PACK: PackView = { state: "pending", data: null, error: null, canRetry: false, images: "none", pictures: null };

function failedPack(error: string, canRetry: boolean): PackView {
  return { state: "failed", data: null, error, canRetry, images: "none", pictures: null };
}

/** A ServerSession-shaped token for the model, which wants one (there is no session on the public page). */
const LOCAL_SESSION = { token: "public", expiresAt: Number.MAX_SAFE_INTEGER } as const;

export interface LocalBackendDeps {
  readonly bank: PublicBank;
  readonly memory: Memory;
  readonly packs: PackClient;
  /** Local wall clock, milliseconds since the epoch. */
  now(): number;
  /** A random unsigned 32-bit integer (the roulette seeds). */
  random32(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** A round's view changed (a call answered, or a pack answer arrived): redraw. */
  onChange(seq: number): void;
}

export interface LocalBackend {
  /** What the game pane calls. */
  readonly api: AdventureGamePaneApi;
  /** What the game pane reads (the pane's own model, over this backend instead of a server). */
  readonly model: AdventureModel;
  /** Starts a fresh round (the one on show is dropped) and returns its seq. */
  startRound(): number;
  /** Builds the round for a place's short code directly in `chosen`; null when the code names no place. */
  openPlace(code: string): number | null;
  /** The round on show, or null. */
  currentSeq(): number | null;
  /** The place the round on show has chosen, with its unit, or null. */
  placeOf(seq: number): { readonly dest: PublicDest; readonly unitName: string } | null;
  /** Stops everything in flight (a leaving page). */
  dispose(): void;
}

interface PackLoop {
  dead: boolean;
  readonly code: string;
  timer: number | null;
  /** Earliest local time (ms) a POST may be sent again. */
  nextPostAt: number;
  /** This loop has sent a POST: a pack that is `failed` afterwards waits for the person's Try again. */
  posted: boolean;
  /** A 429 is why the pack is waiting: the notice shows until a pending answer arrives. */
  rateLimited: boolean;
  errors: number;
  settlePolls: number;
}

interface Round {
  readonly seq: number;
  rev: number;
  state: AdventureState;
  spinLng: AdventureSpin | null;
  spinLat: AdventureSpin | null;
  landing: Omit<AdventureLanding, "landUnitName"> | null;
  countryCandidates: string[] | null;
  countrySeed: number | null;
  countryRouletteAt: number | null;
  countryId: string | null;
  countryBy: string | null;
  destCandidates: string[] | null;
  destSeed: number | null;
  destRouletteAt: number | null;
  destinationId: string | null;
  destinationBy: string | null;
  decidedBy: string | null;
  pack: PackView;
  loop: PackLoop | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validPoint(value: readonly number[]): boolean {
  const [lng, lat] = value;
  return isFiniteNumber(lng) && isFiniteNumber(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

function toDest(dest: PublicDest): AdventureDest {
  return { id: dest.id, name: dest.name, region: dest.region, lat: dest.lat, lng: dest.lng, kind: dest.kind, blurb: dest.blurb };
}

export function createLocalBackend(deps: LocalBackendDeps): LocalBackend {
  const { bank, memory, packs } = deps;
  const rounds = new Map<number, Round>();
  let current: Round | null = null;
  let nextSeq = 1;

  const nowS = (): number => deps.now() / 1000;

  // -- Views -------------------------------------------------------------------------------------------

  function viewOf(round: Round): AdventureView {
    const spinning = round.state === "spin_lng" || round.state === "spin_lat";
    const named = (id: string): { id: string; name: string } => ({ id, name: bank.unitName(id) });
    const destinations = (ids: readonly string[]): AdventureDest[] =>
      ids.flatMap((id) => {
        const dest = bank.destination(id);
        return dest === undefined ? [] : [toDest(dest)];
      });
    const chosenDest = round.destinationId === null ? undefined : bank.destination(round.destinationId);
    return {
      seq: round.seq,
      state: round.state,
      rev: round.rev,
      serverNow: nowS(),
      startedBy: VIEWER,
      eligible: spinning ? bank.eligibleUnits(memory.taken(), memory.includeAdvised()) : null,
      spins: { lng: round.spinLng, lat: round.spinLat },
      landing:
        round.landing === null ? null : { ...round.landing, landUnitName: bank.unitName(round.landing.landUnit) },
      country:
        round.countryCandidates === null
          ? null
          : {
              candidates: round.countryCandidates.map(named),
              seed: round.countrySeed ?? 0,
              rouletteAt: round.countryRouletteAt ?? 0,
              chosen: round.countryId === null ? null : named(round.countryId),
              by: round.countryBy,
            },
      destination:
        round.destCandidates === null
          ? null
          : {
              candidates: destinations(round.destCandidates),
              seed: round.destSeed,
              rouletteAt: round.destRouletteAt,
              chosen: chosenDest === undefined ? null : toDest(chosenDest),
              by: round.destinationBy,
            },
      pack: round.pack,
      decidedBy: round.decidedBy,
    };
  }

  const model: AdventureModel = createAdventureModel({
    session: () => LOCAL_SESSION,
    fetchRound: async (_session, seq): Promise<AdventureOutcome> => {
      const round = rounds.get(seq);
      return round === undefined ? { ok: false, kind: "not_found" } : { ok: true, view: viewOf(round) };
    },
    onChange: (seq) => deps.onChange(seq),
    setTimeout: (fn, ms) => deps.setTimeout(fn, ms),
    clearTimeout: (id) => deps.clearTimeout(id),
    now: () => deps.now(),
  });

  /** Publishes the round's present state to the model (which tells the page). */
  function publish(round: Round): void {
    if (rounds.get(round.seq) !== round) return;
    round.rev += 1;
    model.apply(viewOf(round));
  }

  function outcome(round: Round): AdventureOutcome {
    return { ok: true, view: viewOf(round) };
  }

  function emptyRound(state: AdventureState): Round {
    const seq = nextSeq;
    nextSeq += 1;
    return {
      seq,
      rev: 1,
      state,
      spinLng: null,
      spinLat: null,
      landing: null,
      countryCandidates: null,
      countrySeed: null,
      countryRouletteAt: null,
      countryId: null,
      countryBy: null,
      destCandidates: null,
      destSeed: null,
      destRouletteAt: null,
      destinationId: null,
      destinationBy: null,
      decidedBy: null,
      pack: { state: "none", data: null, error: null, canRetry: false, images: "none", pictures: null },
      loop: null,
    };
  }

  function replaceCurrent(next: Round): void {
    const previous = current;
    if (previous !== null) {
      stopPack(previous);
      rounds.delete(previous.seq);
      model.forget(previous.seq);
    }
    rounds.set(next.seq, next);
    current = next;
  }

  // -- The pack ------------------------------------------------------------------------------------------

  function stopPack(round: Round): void {
    const loop = round.loop;
    if (loop === null) return;
    loop.dead = true;
    if (loop.timer !== null) deps.clearTimeout(loop.timer);
    loop.timer = null;
    round.loop = null;
  }

  function codeOf(round: Round): string | null {
    return round.destinationId === null ? null : (bank.destination(round.destinationId)?.code ?? null);
  }

  /** Enters the pack phase of a round that has just chosen its place. */
  function startPack(round: Round, forcePost: boolean): void {
    stopPack(round);
    const code = codeOf(round);
    if (code === null) {
      round.pack = failedPack(PACK_GONE_TEXT, false);
      return;
    }
    round.pack = PENDING_PACK;
    const loop: PackLoop = { dead: false, code, timer: null, nextPostAt: 0, posted: false, rateLimited: false, errors: 0, settlePolls: 0 };
    round.loop = loop;
    void pump(round, loop, forcePost);
  }

  function schedule(round: Round, loop: PackLoop, ms: number): void {
    if (loop.dead) return;
    loop.timer = deps.setTimeout(() => {
      loop.timer = null;
      void pump(round, loop, false);
    }, ms);
  }

  function needsStart(view: PackView, loop: PackLoop): boolean {
    return view.state === "none" || (view.state === "failed" && view.canRetry && !loop.posted);
  }

  async function pump(round: Round, loop: PackLoop, forcePost: boolean): Promise<void> {
    if (loop.dead) return;
    let answer: PackAnswer;
    let posted = false;
    if (forcePost) {
      posted = true;
      loop.posted = true;
      loop.nextPostAt = deps.now() + MIN_POST_SPACING_MS;
      answer = await packs.post(loop.code);
    } else {
      answer = await packs.get(loop.code);
      if (loop.dead) return;
      // Nothing researched yet: ask for it. A pack that failed before this visit may be asked for once (the
      // server says when it may); one that failed after this loop's own request waits for Try again.
      if (answer.kind === "ok" && needsStart(answer.view, loop) && deps.now() >= loop.nextPostAt) {
        posted = true;
        loop.posted = true;
        loop.nextPostAt = deps.now() + MIN_POST_SPACING_MS;
        answer = await packs.post(loop.code);
      }
    }
    if (loop.dead) return;
    settle(round, loop, answer, posted);
  }

  function show(round: Round, view: PackView): void {
    round.pack = view;
    publish(round);
  }

  function settle(round: Round, loop: PackLoop, answer: PackAnswer, posted: boolean): void {
    switch (answer.kind) {
      case "rate_limited": {
        loop.errors = 0;
        loop.rateLimited = true;
        loop.nextPostAt = deps.now() + answer.retryAfterS * 1000;
        show(round, { ...PENDING_PACK, notice: RATE_LIMITED_NOTICE });
        schedule(round, loop, PACK_POLL_MS);
        return;
      }
      case "not_found": {
        show(round, failedPack(PACK_GONE_TEXT, false));
        stopPack(round);
        return;
      }
      case "error": {
        loop.errors += 1;
        if (loop.errors >= MAX_PACK_ERRORS) {
          show(round, failedPack(PACK_LOST_TEXT, true));
          stopPack(round);
          return;
        }
        schedule(round, loop, Math.min(MAX_ERROR_BACKOFF_MS, PACK_POLL_MS * loop.errors));
        return;
      }
      case "ok":
        break;
    }
    loop.errors = 0;
    const view = answer.view;
    if (view.state === "none") {
      // Nothing researched and nothing started (a POST just before was refused, or the server forgot):
      // wait as pending; the loop asks to start again once it may.
      show(round, loop.rateLimited ? { ...PENDING_PACK, notice: RATE_LIMITED_NOTICE } : PENDING_PACK);
      schedule(round, loop, PACK_POLL_MS);
      return;
    }
    if (view.state === "pending") loop.rateLimited = false;
    show(round, view);
    if (view.state === "pending" || view.images === "pending") {
      schedule(round, loop, PACK_POLL_MS);
    } else if (view.state === "ready" && view.images === "none" && loop.settlePolls < SETTLE_POLLS) {
      loop.settlePolls += 1;
      schedule(round, loop, PACK_POLL_MS);
    } else if (view.state === "failed" && !view.canRetry && answer.retryAfterS !== null) {
      // Not retryable yet: look again when the server says it may be, so Try again appears by itself.
      schedule(round, loop, Math.min(MAX_FAILED_RECHECK_S, answer.retryAfterS) * 1000 + 500);
    } else if (view.state === "failed" && view.canRetry && !posted && deps.now() < loop.nextPostAt) {
      schedule(round, loop, PACK_POLL_MS);
    } else {
      stopPack(round);
    }
  }

  // -- The moves -----------------------------------------------------------------------------------------

  function roundFor(seq: number): Round | null {
    return rounds.get(seq) ?? null;
  }

  function sameSpin(stored: AdventureSpin | null, input: { from: number; delta: number }): boolean {
    return stored !== null && stored.from === input.from && stored.delta === input.delta;
  }

  function spin(seq: number, input: Omit<SpinInput, "sender">): AdventureOutcome {
    const round = roundFor(seq);
    if (round === null) return { ok: false, kind: "not_found" };
    const axis: AdventureAxis = input.axis;
    if (axis !== "lng" && axis !== "lat") return { ok: false, kind: "invalid" };
    if (!isFiniteNumber(input.from) || Math.abs(input.from) > SPIN_MAX_ABS_FROM_DEG) return { ok: false, kind: "invalid" };
    if (!isFiniteNumber(input.delta) || Math.abs(input.delta) < SPIN_MIN_DELTA_DEG || Math.abs(input.delta) > SPIN_MAX_DELTA_DEG) {
      return { ok: false, kind: "invalid" };
    }
    if (!isFiniteNumber(input.durationMs) || input.durationMs < SPIN_MIN_DURATION_MS || input.durationMs > SPIN_MAX_DURATION_MS) {
      return { ok: false, kind: "invalid" };
    }
    const includeAdvised = memory.includeAdvised();
    let landing: Omit<AdventureLanding, "landUnitName"> | null = null;
    let candidates: string[] = [];
    if (axis === "lng") {
      if (input.result !== undefined) return { ok: false, kind: "invalid" };
    } else {
      const result = input.result;
      if (result === undefined) return { ok: false, kind: "invalid" };
      if (!validPoint(result.point) || !validPoint(result.land) || !validPoint(result.centre)) return { ok: false, kind: "invalid" };
      candidates = [...result.candidates];
      if (
        candidates.length < MIN_CANDIDATES ||
        candidates.length > MAX_CANDIDATES ||
        new Set(candidates).size !== candidates.length ||
        !candidates.every((c) => bank.isPlayable(c, includeAdvised)) ||
        !bank.isPlayable(result.landUnit, includeAdvised) ||
        !candidates.includes(result.landUnit)
      ) {
        return { ok: false, kind: "invalid" };
      }
      landing = {
        point: [result.point[0], result.point[1]],
        sea: result.sea,
        land: [result.land[0], result.land[1]],
        centre: [result.centre[0], result.centre[1]],
        landUnit: result.landUnit,
      };
    }
    const needed: AdventureState = axis === "lng" ? "spin_lng" : "spin_lat";
    if (round.state !== needed) {
      // The same move replayed after the state moved is an idempotent success; a different one lost.
      return sameSpin(axis === "lng" ? round.spinLng : round.spinLat, input) ? outcome(round) : { ok: false, kind: "bad_state" };
    }
    const at = nowS();
    const stored: AdventureSpin = { by: VIEWER, from: input.from, delta: input.delta, durationMs: input.durationMs, at };
    if (axis === "lng") {
      round.spinLng = stored;
      round.state = "spin_lat";
    } else {
      round.spinLat = stored;
      round.landing = landing;
      round.countryCandidates = candidates;
      round.countrySeed = deps.random32();
      round.countryRouletteAt = at + input.durationMs / 1000 + ROULETTE_SETTLE_S;
      round.state = "country";
    }
    round.rev += 1; // the caller's answer carries the new view to the model
    return outcome(round);
  }

  function enterChosen(round: Round, destinationId: string): void {
    round.destinationId = destinationId;
    round.destinationBy = VIEWER;
    round.state = "chosen";
    startPack(round, false);
  }

  function stop(seq: number, input: StopIntent): AdventureOutcome {
    const round = roundFor(seq);
    if (round === null) return { ok: false, kind: "not_found" };
    const now = nowS();
    if (input.stage === "country") {
      if (round.state !== "country") {
        return round.countryId !== null && round.countryId === input.choice ? outcome(round) : { ok: false, kind: "bad_state" };
      }
      if (!(round.countryCandidates ?? []).includes(input.choice)) return { ok: false, kind: "invalid" };
      if (round.countryRouletteAt !== null && now < round.countryRouletteAt - STOP_TOLERANCE_S) return { ok: false, kind: "too_early" };
      // The preference is honoured NOW, at the stop (it can change between the spin and the stop).
      const top = bank.isPlayable(input.choice, memory.includeAdvised())
        ? bank.topDestinations(input.choice, memory.taken(), TOP_DESTINATIONS)
        : [];
      const first = top[0];
      if (first === undefined) return { ok: false, kind: "exhausted" };
      round.countryId = input.choice;
      round.countryBy = VIEWER;
      round.destCandidates = top.map((d) => d.id);
      if (top.length === 1) {
        enterChosen(round, first.id);
      } else {
        round.destSeed = deps.random32();
        round.destRouletteAt = now + DESTINATION_SETTLE_S;
        round.state = "destination";
      }
      round.rev += 1; // the caller's answer carries the new view to the model
      return outcome(round);
    }
    if (round.state !== "destination") {
      return round.destinationId !== null && round.destinationId === input.choice ? outcome(round) : { ok: false, kind: "bad_state" };
    }
    if (!(round.destCandidates ?? []).includes(input.choice)) return { ok: false, kind: "invalid" };
    if (round.destRouletteAt !== null && now < round.destRouletteAt - STOP_TOLERANCE_S) return { ok: false, kind: "too_early" };
    enterChosen(round, input.choice);
    round.rev += 1; // the caller's answer carries the new view to the model
    return outcome(round);
  }

  function decide(seq: number, decision: "bank" | "reject"): AdventureOutcome {
    const round = roundFor(seq);
    if (round === null) return { ok: false, kind: "not_found" };
    const target: AdventureState = decision === "bank" ? "banked" : "rejected";
    if (round.state !== "chosen") return round.state === target ? outcome(round) : { ok: false, kind: "bad_state" };
    const destinationId = round.destinationId;
    const dest = destinationId === null ? undefined : bank.destination(destinationId);
    if (destinationId === null || dest === undefined) return { ok: false, kind: "bad_state" };
    if (decision === "bank") {
      memory.bank({ code: dest.code, destinationId, unitId: round.countryId ?? bank.unitOf(destinationId)?.id ?? "", at: nowS() });
    } else {
      memory.reject(destinationId);
      // The research is not wanted any more: stop waiting for it (the shared cache is not touched).
      if (round.pack.state === "pending" || round.pack.state === "none") {
        stopPack(round);
        round.pack = failedPack(PACK_STOPPED_TEXT, false);
      }
    }
    round.state = target;
    round.decidedBy = VIEWER;
    round.rev += 1; // the caller's answer carries the new view to the model
    return outcome(round);
  }

  function retryPack(seq: number): AdventureOutcome {
    const round = roundFor(seq);
    if (round === null) return { ok: false, kind: "not_found" };
    if (round.state !== "chosen" && round.state !== "banked") return { ok: false, kind: "bad_state" };
    if (round.pack.state === "pending") return outcome(round);
    if (round.pack.state !== "failed" && round.pack.state !== "unavailable") return { ok: false, kind: "bad_state" };
    startPack(round, true);
    round.rev += 1; // the caller's answer carries the new view to the model
    return outcome(round);
  }

  function settings(): AdventureSettings {
    return {
      includeAdvised: memory.includeAdvised(),
      advisedUnits: bank.advisedUnits().map((u) => ({ id: u.id, name: u.name })),
    };
  }

  const api: AdventureGamePaneApi = {
    spin: async (seq, input) => spin(seq, input),
    stop: async (seq, input) => stop(seq, input),
    decide: async (seq, decision) => decide(seq, decision),
    retryPack: async (seq) => retryPack(seq),
    getSettings: async (): Promise<SettingsResult> => ({ ok: true, settings: settings() }),
    putSettings: async (includeAdvised): Promise<SettingsResult> => {
      memory.setIncludeAdvised(includeAdvised);
      return { ok: true, settings: settings() };
    },
  };

  // -- Starting rounds -------------------------------------------------------------------------------------

  function startRound(): number {
    const round = emptyRound("spin_lng");
    replaceCurrent(round);
    model.apply(viewOf(round));
    return round.seq;
  }

  function openPlace(code: string): number | null {
    const found = bank.byCode(code);
    if (found === null) return null;
    const { unit, dest } = found;
    const round = emptyRound("chosen");
    const at = nowS();
    const point: [number, number] = [dest.lng, dest.lat];
    // The place's country's other top places show as small dots, like the draw would have left them.
    const top = bank.topDestinations(unit.id, new Set(), TOP_DESTINATIONS).map((d) => d.id);
    const ids = new Set([...top.slice(0, TOP_DESTINATIONS - 1), dest.id]);
    for (const id of top) if (ids.size < TOP_DESTINATIONS) ids.add(id);
    round.landing = { point, sea: false, land: point, centre: point, landUnit: unit.id };
    round.countryCandidates = [unit.id];
    round.countrySeed = 0;
    round.countryRouletteAt = at;
    round.countryId = unit.id;
    round.countryBy = VIEWER;
    round.destCandidates = unit.destinations.filter((d) => ids.has(d.id)).map((d) => d.id);
    round.destinationId = dest.id;
    round.destinationBy = VIEWER;
    replaceCurrent(round);
    startPack(round, false);
    model.apply(viewOf(round));
    return round.seq;
  }

  return {
    api,
    model,
    startRound,
    openPlace,
    currentSeq: () => current?.seq ?? null,
    placeOf(seq) {
      const round = roundFor(seq);
      const dest = round?.destinationId == null ? undefined : bank.destination(round.destinationId);
      if (round === null || dest === undefined) return null;
      return { dest, unitName: bank.unitName(round.countryId ?? bank.unitOf(dest.id)?.id ?? "") };
    },
    dispose() {
      if (current !== null) stopPack(current);
    },
  };
}
