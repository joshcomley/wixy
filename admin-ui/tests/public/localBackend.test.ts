import { beforeEach, describe, expect, it } from "vitest";
import type { AdventureGamePaneApi } from "../../src/server/adventure/adventureGame";
import type { AdventureOutcome, AdventureView, SpinInput } from "../../src/server/adventure/api";
import { PACK_POLL_MS, RATE_LIMITED_NOTICE, VIEWER, createLocalBackend, type LocalBackend } from "../../src/public/localBackend";
import type { Memory } from "../../src/public/memory";
import {
  T0,
  fakeStorage,
  fixtureBank,
  fixtureMemory,
  landingResult,
  ok,
  packView,
  readyPackView,
  scriptedPacks,
  type ScriptedPacks,
} from "./publicFixtures";

// ---- the rig ---------------------------------------------------------------------------------------

interface Rig {
  backend: LocalBackend;
  memory: Memory;
  packs: ScriptedPacks;
  changes: number[];
  clock: { t: number };
  /** Runs `ms` of local time: due timers fire in order, with the promises they start settling in between. */
  advance(ms: number): Promise<void>;
  view(): AdventureView;
  /** The pane's calls, the way the pane makes them: through the model, which applies the answer's view. */
  api: AdventureGamePaneApi;
  /** Starts a round and takes it to the country roulette (the landing's candidates are AAA, BBB, DDD). */
  toCountry(candidates?: string[]): Promise<number>;
  /** ... to the destination roulette having stopped on AAA (five places). */
  toDestination(): Promise<number>;
  /** ... to `chosen` on AAA.a1. */
  toChosen(): Promise<number>;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function rig(options: { storage?: Storage } = {}): Rig {
  const clock = { t: T0 };
  const timers: Array<{ id: number; at: number; fn: () => void; live: boolean }> = [];
  let ids = 0;
  const { memory } = fixtureMemory(options.storage ?? fakeStorage());
  const packs = scriptedPacks();
  const changes: number[] = [];
  let seeds = 1000;
  const backend = createLocalBackend({
    bank: fixtureBank(),
    memory,
    packs,
    now: () => clock.t,
    random32: () => (seeds += 1),
    setTimeout: (fn, ms) => {
      ids += 1;
      timers.push({ id: ids, at: clock.t + ms, fn, live: true });
      return ids;
    },
    clearTimeout: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t !== undefined) t.live = false;
    },
    onChange: (seq) => changes.push(seq),
  });
  const model = backend.model;
  const api: AdventureGamePaneApi = {
    ...backend.api,
    spin: (seq, input) => model.run(() => backend.api.spin(seq, input)),
    stop: (seq, input) => model.run(() => backend.api.stop(seq, input)),
    decide: (seq, decision) => model.run(() => backend.api.decide(seq, decision)),
    retryPack: (seq) => model.run(() => backend.api.retryPack(seq)),
  };
  const r: Rig = {
    backend,
    memory,
    packs,
    changes,
    clock,
    async advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        await settle();
        const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        clock.t = Math.max(clock.t, due.at);
        due.fn();
      }
      clock.t = end;
      await settle();
    },
    view() {
      const seq = backend.currentSeq();
      const v = seq === null ? undefined : backend.model.view(seq);
      if (v === undefined) throw new Error("no round on show");
      return v;
    },
    api,
    async toCountry(candidates = ["AAA", "BBB", "DDD"]) {
      const seq = backend.startRound();
      await api.spin(seq, LNG);
      await api.spin(seq, latSpin(candidates));
      return seq;
    },
    async toDestination() {
      const seq = await r.toCountry();
      clock.t += 8_000; // past the roulette start
      await api.stop(seq, { stage: "country", choice: "AAA" });
      return seq;
    },
    async toChosen() {
      const seq = await r.toDestination();
      clock.t += 4_000;
      await api.stop(seq, { stage: "destination", choice: "AAA.a1" });
      return seq;
    },
  };
  return r;
}

const LNG: Omit<SpinInput, "sender"> = { axis: "lng", from: 10, delta: 1000, durationMs: 4000 };
function latSpin(candidates: string[], over: Partial<Omit<SpinInput, "sender">> = {}): Omit<SpinInput, "sender"> {
  return { axis: "lat", from: -15, delta: 900, durationMs: 4000, result: landingResult({ candidates }), ...over };
}

async function ex(call: Promise<AdventureOutcome>): Promise<AdventureOutcome> {
  return call;
}

function okView(outcome: AdventureOutcome): AdventureView {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.view;
}

let r: Rig;
beforeEach(() => {
  r = rig();
});

// ---- a round starts --------------------------------------------------------------------------------

describe("local backend: a round starts", () => {
  it("is a spin_lng round started by You, with the server's clock being the local clock", () => {
    const seq = r.backend.startRound();
    const v = r.view();
    expect(v.seq).toBe(seq);
    expect(v.state).toBe("spin_lng");
    expect(v.rev).toBe(1);
    expect(v.startedBy).toBe(VIEWER);
    expect(v.serverNow).toBe(T0 / 1000);
    expect(v.spins).toEqual({ lng: null, lat: null });
    expect(v.landing).toBeNull();
    expect(v.country).toBeNull();
    expect(v.destination).toBeNull();
    expect(v.pack.state).toBe("none");
    expect(r.backend.currentSeq()).toBe(seq);
    expect(r.changes).toContain(seq);
  });

  it("lists the eligible units: playable ones with a place left, advised units out unless switched on", async () => {
    r.backend.startRound();
    expect(r.view().eligible).toEqual(["AAA", "BBB", "DDD"]);
    await r.api.putSettings(true);
    r.backend.model.refetch(r.backend.currentSeq() as number);
    await settle();
    expect(r.view().eligible).toEqual(["AAA", "BBB", "CCC", "DDD"]);
  });

  it("a place banked or rejected in this browser is out of play: a unit with nothing left is not eligible", () => {
    r.memory.bank({ code: "bbbbb1", destinationId: "BBB.b1", unitId: "BBB", at: 1 });
    r.memory.reject("DDD.d1");
    r.memory.reject("DDD.d2");
    r.backend.startRound();
    expect(r.view().eligible).toEqual(["AAA"]);
  });

  it("a new round replaces the one on show (its view is forgotten, a stale seq is not_found)", async () => {
    const first = r.backend.startRound();
    const second = r.backend.startRound();
    expect(second).not.toBe(first);
    expect(r.backend.model.view(first)).toBeUndefined();
    expect((await ex(r.api.spin(first, LNG))).ok).toBe(false);
    const outcome = await r.api.spin(first, LNG);
    expect(outcome).toEqual({ ok: false, kind: "not_found" });
    expect(r.backend.currentSeq()).toBe(second);
  });
});

// ---- spins ---------------------------------------------------------------------------------------

describe("local backend: the two spins", () => {
  it("the sideways spin is stored by You at the local time and moves the round to spin_lat", async () => {
    const seq = r.backend.startRound();
    r.clock.t += 500;
    const v = okView(await r.api.spin(seq, LNG));
    expect(v.state).toBe("spin_lat");
    expect(v.rev).toBe(2);
    expect(v.spins.lng).toEqual({ by: VIEWER, from: 10, delta: 1000, durationMs: 4000, at: (T0 + 500) / 1000 });
    expect(v.eligible).toEqual(["AAA", "BBB", "DDD"]);
    expect(r.backend.model.view(seq)?.rev).toBe(2);
  });

  it("the second spin stores the landing and the candidate countries and starts the country roulette 5 s after it ends", async () => {
    const seq = r.backend.startRound();
    await r.api.spin(seq, LNG);
    r.clock.t += 5_000;
    const v = okView(await r.api.spin(seq, latSpin(["AAA", "BBB", "DDD"])));
    const at = (T0 + 5_000) / 1000;
    expect(v.state).toBe("country");
    expect(v.spins.lat).toEqual({ by: VIEWER, from: -15, delta: 900, durationMs: 4000, at });
    expect(v.landing).toEqual({ point: [1, 1], sea: false, land: [1, 1], centre: [2, 2], landUnit: "AAA", landUnitName: "Aland" });
    expect(v.country?.candidates).toEqual([
      { id: "AAA", name: "Aland" },
      { id: "BBB", name: "Bland" },
      { id: "DDD", name: "Dland" },
    ]);
    expect(v.country?.rouletteAt).toBe(at + 4 + 5);
    expect(v.country?.chosen).toBeNull();
    expect(Number.isInteger(v.country?.seed)).toBe(true);
    expect(v.country?.seed).toBeGreaterThanOrEqual(0);
    expect(v.country?.seed).toBeLessThanOrEqual(4294967295);
    expect(v.eligible).toBeNull();
  });

  it("repeating the SAME spin after the state moved is an idempotent success (no new revision); a different one is bad_state", async () => {
    const seq = r.backend.startRound();
    const first = okView(await r.api.spin(seq, LNG));
    // Same move, same state: stored once, replayed.
    const again = okView(await r.api.spin(seq, LNG));
    expect(again.state).toBe("spin_lat");
    expect(again.rev).toBe(first.rev);
    expect(again.spins.lng).toEqual(first.spins.lng);
    // A different sideways spin now loses.
    expect(await r.api.spin(seq, { ...LNG, delta: 1100 })).toEqual({ ok: false, kind: "bad_state" });
    // The second spin, then the first replayed after the round is in `country`.
    const second = okView(await r.api.spin(seq, latSpin(["AAA"])));
    const replay = okView(await r.api.spin(seq, latSpin(["AAA"])));
    expect(replay.rev).toBe(second.rev);
    expect(replay.state).toBe("country");
    expect(await r.api.spin(seq, latSpin(["AAA"], { delta: -1500 }))).toEqual({ ok: false, kind: "bad_state" });
    expect(okView(await r.api.spin(seq, LNG)).rev).toBe(second.rev);
  });

  it("the second spin before the first is bad_state", async () => {
    const seq = r.backend.startRound();
    expect(await r.api.spin(seq, latSpin(["AAA"]))).toEqual({ ok: false, kind: "bad_state" });
  });

  it("refuses a spin outside the server's bounds as invalid", async () => {
    const seq = r.backend.startRound();
    for (const bad of [
      { ...LNG, delta: 700 },
      { ...LNG, delta: 4000 },
      { ...LNG, delta: -4000 },
      { ...LNG, durationMs: 3000 },
      { ...LNG, durationMs: 7500 },
      { ...LNG, from: 2e6 },
      { ...LNG, from: Number.NaN },
      { ...LNG, delta: Number.POSITIVE_INFINITY },
    ]) {
      expect(await r.api.spin(seq, bad)).toEqual({ ok: false, kind: "invalid" });
    }
    expect(r.view().state).toBe("spin_lng");
    // The bounds themselves are fine, either direction.
    expect((await r.api.spin(seq, { ...LNG, delta: -720, durationMs: 3500 })).ok).toBe(true);
  });

  it("the sideways spin takes no result; the second spin needs a sound one", async () => {
    const seq = r.backend.startRound();
    expect(await r.api.spin(seq, { ...LNG, result: landingResult() })).toEqual({ ok: false, kind: "invalid" });
    await r.api.spin(seq, LNG);
    const {
      axis,
      from,
      delta,
      durationMs,
    } = latSpin(["AAA"]);
    expect(await r.api.spin(seq, { axis, from, delta, durationMs })).toEqual({ ok: false, kind: "invalid" });
    for (const result of [
      landingResult({ point: [200, 0] }),
      landingResult({ land: [0, 95] }),
      landingResult({ centre: [Number.NaN, 0] }),
      landingResult({ candidates: [] }),
      landingResult({ candidates: Array.from({ length: 11 }, () => "AAA") }),
      landingResult({ candidates: ["AAA", "AAA"] }),
      landingResult({ candidates: ["AAA", "ZZZ"] }),
      landingResult({ candidates: ["AAA", "CCC"] }), // advised and the setting is off
      landingResult({ landUnit: "DDD", candidates: ["AAA", "BBB"] }), // landUnit not among the candidates
      landingResult({ landUnit: "CCC", candidates: ["CCC"] }),
    ]) {
      expect(await r.api.spin(seq, { axis, from, delta, durationMs, result })).toEqual({ ok: false, kind: "invalid" });
    }
    expect(r.view().state).toBe("spin_lat");
  });

  it("an advised country is a fine candidate once the setting is on", async () => {
    const seq = r.backend.startRound();
    await r.api.putSettings(true);
    await r.api.spin(seq, LNG);
    const v = okView(await r.api.spin(seq, latSpin(["CCC", "AAA"], { result: landingResult({ landUnit: "CCC", candidates: ["CCC", "AAA"] }) })));
    expect(v.country?.candidates.map((c) => c.id)).toEqual(["CCC", "AAA"]);
  });
});

// ---- the stops -----------------------------------------------------------------------------------

describe("local backend: the country Stop", () => {
  it("is too_early before the roulette starts (with 1 s of tolerance), invalid for a non-candidate", async () => {
    const seq = await r.toCountry();
    const at = r.view().country?.rouletteAt as number;
    r.clock.t = (at - 1.5) * 1000;
    expect(await r.api.stop(seq, { stage: "country", choice: "AAA" })).toEqual({ ok: false, kind: "too_early" });
    expect(await r.api.stop(seq, { stage: "country", choice: "ZZZ" })).toEqual({ ok: false, kind: "invalid" });
    r.clock.t = (at - 0.9) * 1000;
    expect((await r.api.stop(seq, { stage: "country", choice: "AAA" })).ok).toBe(true);
  });

  it("draws the country's top five (spaced), starts the destination roulette 3.5 s later", async () => {
    const seq = await r.toCountry();
    r.clock.t += 9_000;
    const v = okView(await r.api.stop(seq, { stage: "country", choice: "AAA" }));
    expect(v.state).toBe("destination");
    expect(v.country?.chosen).toEqual({ id: "AAA", name: "Aland" });
    expect(v.country?.by).toBe(VIEWER);
    expect(v.destination?.candidates.map((d) => d.id)).toEqual(["AAA.a1", "AAA.a3", "AAA.a4", "AAA.a5", "AAA.a6"]);
    expect(v.destination?.rouletteAt).toBe(r.clock.t / 1000 + 3.5);
    expect(Number.isInteger(v.destination?.seed)).toBe(true);
    expect(v.destination?.chosen).toBeNull();
    // The destination objects are the plain wire shape, no code.
    expect(Object.keys(v.destination?.candidates[0] ?? {}).sort()).toEqual(["blurb", "id", "kind", "lat", "lng", "name", "region"]);
  });

  it("with exactly one place left it skips straight to chosen (no destination roulette) and starts the pack", async () => {
    const seq = await r.toCountry();
    r.clock.t += 9_000;
    const v = okView(await r.api.stop(seq, { stage: "country", choice: "BBB" }));
    expect(v.state).toBe("chosen");
    expect(v.destination?.chosen?.id).toBe("BBB.b1");
    expect(v.destination?.seed).toBeNull();
    expect(v.destination?.rouletteAt).toBeNull();
    expect(v.destination?.candidates.map((d) => d.id)).toEqual(["BBB.b1"]);
    expect(v.pack.state).toBe("pending");
    await r.advance(0);
    expect(r.packs.calls[0]).toEqual({ method: "get", code: "bbbbb1" });
  });

  it("the remaining places honour this browser's bank and never-again list", async () => {
    r.memory.reject("AAA.a1");
    r.memory.bank({ code: "aaaaa3", destinationId: "AAA.a3", unitId: "AAA", at: 1 });
    const seq = await r.toCountry();
    r.clock.t += 9_000;
    const v = okView(await r.api.stop(seq, { stage: "country", choice: "AAA" }));
    expect(v.destination?.candidates.map((d) => d.id)).toEqual(["AAA.a2", "AAA.a4", "AAA.a5", "AAA.a6", "AAA.a7"]);
  });

  it("is exhausted (the round stays in country) when nothing is left in the country", async () => {
    const seq = await r.toCountry();
    r.clock.t += 9_000;
    for (const id of ["DDD.d1", "DDD.d2"]) r.memory.reject(id);
    expect(await r.api.stop(seq, { stage: "country", choice: "DDD" })).toEqual({ ok: false, kind: "exhausted" });
    expect(r.view().state).toBe("country");
    // ...and another country can still be chosen.
    expect((await r.api.stop(seq, { stage: "country", choice: "AAA" })).ok).toBe(true);
  });

  it("is exhausted when the country became advised-and-off between the spin and the Stop (the setting is honoured now)", async () => {
    await r.api.putSettings(true);
    const seq = r.backend.startRound();
    await r.api.spin(seq, LNG);
    await r.api.spin(seq, latSpin(["CCC", "AAA"], { result: landingResult({ landUnit: "CCC", candidates: ["CCC", "AAA"] }) }));
    await r.api.putSettings(false);
    r.clock.t += 9_000;
    expect(await r.api.stop(seq, { stage: "country", choice: "CCC" })).toEqual({ ok: false, kind: "exhausted" });
    expect(r.view().state).toBe("country");
  });

  it("repeating the country Stop after the state moved is an idempotent success; another choice is bad_state", async () => {
    const seq = await r.toDestination();
    const v = r.view();
    const again = okView(await r.api.stop(seq, { stage: "country", choice: "AAA" }));
    expect(again.rev).toBe(v.rev);
    expect(again.state).toBe("destination");
    expect(await r.api.stop(seq, { stage: "country", choice: "BBB" })).toEqual({ ok: false, kind: "bad_state" });
  });
});

describe("local backend: the destination Stop", () => {
  it("is too_early, invalid for a non-candidate, then chooses the place and starts the pack", async () => {
    const seq = await r.toDestination();
    const roulette = r.view().destination?.rouletteAt as number;
    r.clock.t = (roulette - 1.5) * 1000;
    expect(await r.api.stop(seq, { stage: "destination", choice: "AAA.a1" })).toEqual({ ok: false, kind: "too_early" });
    r.clock.t = roulette * 1000;
    expect(await r.api.stop(seq, { stage: "destination", choice: "AAA.a2" })).toEqual({ ok: false, kind: "invalid" });
    const v = okView(await r.api.stop(seq, { stage: "destination", choice: "AAA.a4" }));
    expect(v.state).toBe("chosen");
    expect(v.destination?.chosen?.id).toBe("AAA.a4");
    expect(v.destination?.by).toBe(VIEWER);
    expect(v.pack).toEqual({ state: "pending", data: null, error: null, canRetry: false, images: "none", pictures: null });
  });

  it("repeating it is idempotent; another choice after chosen is bad_state; a Stop at the wrong stage is bad_state", async () => {
    const seq = await r.toChosen();
    const v = r.view();
    expect(okView(await r.api.stop(seq, { stage: "destination", choice: "AAA.a1" })).rev).toBe(v.rev);
    expect(await r.api.stop(seq, { stage: "destination", choice: "AAA.a3" })).toEqual({ ok: false, kind: "bad_state" });
    expect(await r.api.stop(seq, { stage: "country", choice: "DDD" })).toEqual({ ok: false, kind: "bad_state" });
    const early = r.backend.startRound();
    expect(await r.api.stop(early, { stage: "destination", choice: "AAA.a1" })).toEqual({ ok: false, kind: "bad_state" });
  });
});

// ---- Yay and Nay -----------------------------------------------------------------------------------

describe("local backend: Yay and Nay", () => {
  it("Yay banks the place in this browser's memory and moves the round to banked", async () => {
    const seq = await r.toChosen();
    r.clock.t += 1_000;
    const v = okView(await r.api.decide(seq, "bank"));
    expect(v.state).toBe("banked");
    expect(v.decidedBy).toBe(VIEWER);
    expect(r.memory.banked()).toEqual([{ code: "aaaaa1", destinationId: "AAA.a1", unitId: "AAA", at: r.clock.t / 1000 }]);
    // A replay is an idempotent success; the opposite decision is bad_state.
    expect(okView(await r.api.decide(seq, "bank")).rev).toBe(v.rev);
    expect(r.memory.banked().length).toBe(1);
    expect(await r.api.decide(seq, "reject")).toEqual({ ok: false, kind: "bad_state" });
  });

  it("Nay adds the place to the never-again list and ends the wait for its pack", async () => {
    const seq = await r.toChosen();
    await r.advance(0);
    expect(r.packs.calls.length).toBeGreaterThan(0);
    const v = okView(await r.api.decide(seq, "reject"));
    expect(v.state).toBe("rejected");
    expect(v.decidedBy).toBe(VIEWER);
    expect(r.memory.rejected().has("AAA.a1")).toBe(true);
    expect(v.pack.state).toBe("failed");
    expect(v.pack.error).toBe("The research was stopped");
    expect(v.pack.canRetry).toBe(false);
    const calls = r.packs.calls.length;
    await r.advance(60_000);
    expect(r.packs.calls.length).toBe(calls); // nothing polls any more
    expect(await r.api.decide(seq, "bank")).toEqual({ ok: false, kind: "bad_state" });
  });

  it("deciding before a place is chosen is bad_state", async () => {
    const seq = await r.toCountry();
    expect(await r.api.decide(seq, "bank")).toEqual({ ok: false, kind: "bad_state" });
  });

  it("a banked or rejected place never comes up again in the next draw", async () => {
    const seq = await r.toChosen();
    await r.api.decide(seq, "bank");
    const next = await r.toCountry();
    r.clock.t += 9_000;
    const v = okView(await r.api.stop(next, { stage: "country", choice: "AAA" }));
    expect(v.destination?.candidates.map((d) => d.id)).not.toContain("AAA.a1");
    expect(v.destination?.candidates.map((d) => d.id)).toContain("AAA.a2");
  });

  it("a whole country banked or rejected away is no longer eligible", async () => {
    await r.toChosen();
    const seq = await r.toCountry();
    r.clock.t += 9_000;
    await r.api.stop(seq, { stage: "country", choice: "BBB" });
    await r.api.decide(seq, "bank");
    r.backend.startRound();
    expect(r.view().eligible).toEqual(["AAA", "DDD"]);
  });
});

// ---- settings ------------------------------------------------------------------------------------

describe("local backend: settings", () => {
  it("reads and writes the advised switch through the memory, listing the advised units by name", async () => {
    const first = await r.api.getSettings();
    expect(first).toEqual({ ok: true, settings: { includeAdvised: false, advisedUnits: [{ id: "CCC", name: "Cland" }] } });
    const put = await r.api.putSettings(true);
    expect(put).toEqual({ ok: true, settings: { includeAdvised: true, advisedUnits: [{ id: "CCC", name: "Cland" }] } });
    expect(r.memory.includeAdvised()).toBe(true);
  });

  it("there is no live trail on the public page", () => {
    expect(r.backend.api.postLive).toBeUndefined();
  });
});

// ---- the holiday pack -------------------------------------------------------------------------------

describe("local backend: the holiday pack", () => {
  function packOf(): AdventureView["pack"] {
    return r.view().pack;
  }

  it("reads the place's pack by its code and shows a ready one at once, with no POST and no more polling", async () => {
    r.packs.script("get", ok(readyPackView()));
    await r.toChosen();
    await r.advance(0);
    expect(r.packs.calls).toEqual([{ method: "get", code: "aaaaa1" }]);
    expect(packOf().state).toBe("ready");
    expect(packOf().data?.headline).toBe("Sun and tiles");
    await r.advance(60_000);
    expect(r.packs.calls.length).toBe(1);
  });

  it("a pack nobody has researched (none) is requested with a POST, then polled every 5 s while pending", async () => {
    r.packs.script("get", ok(packView({ state: "none" })), ok(packView()), ok(packView()), ok(readyPackView({ images: "none" })));
    r.packs.script("post", ok(packView()));
    await r.toChosen();
    await r.advance(0);
    expect(r.packs.calls.map((c) => c.method)).toEqual(["get", "post"]);
    expect(packOf().state).toBe("pending");
    await r.advance(PACK_POLL_MS);
    expect(r.packs.calls.map((c) => c.method)).toEqual(["get", "post", "get"]);
    await r.advance(PACK_POLL_MS);
    expect(r.packs.calls.map((c) => c.method)).toEqual(["get", "post", "get", "get"]);
    expect(packOf().state).toBe("pending");
    await r.advance(PACK_POLL_MS);
    expect(packOf().state).toBe("ready");
  });

  it("keeps polling while the pack's pictures are pending, and stops once they are done", async () => {
    r.packs.script("get", ok(readyPackView({ images: "pending" })), ok(readyPackView({ images: "pending" })), ok(readyPackView({ images: "done" })));
    await r.toChosen();
    await r.advance(0);
    expect(packOf().images).toBe("pending");
    await r.advance(PACK_POLL_MS);
    expect(packOf().images).toBe("pending");
    await r.advance(PACK_POLL_MS);
    expect(packOf().images).toBe("done");
    const calls = r.packs.calls.length;
    await r.advance(60_000);
    expect(r.packs.calls.length).toBe(calls);
  });

  it("a ready pack that reports no pictures yet is asked a few more times, then left alone", async () => {
    r.packs.script("get", ok(readyPackView({ images: "none" })));
    await r.toChosen();
    await r.advance(0);
    await r.advance(60_000);
    expect(r.packs.calls.length).toBe(4); // the first read and three settle polls
  });

  it("every pack answer is published to the model as a new revision of the round", async () => {
    r.packs.script("get", ok(packView()), ok(readyPackView()));
    const seq = await r.toChosen();
    await r.advance(0);
    const before = r.view().rev;
    r.changes.length = 0;
    await r.advance(PACK_POLL_MS);
    expect(r.backend.model.view(seq)?.rev).toBeGreaterThan(before);
    expect(r.view().pack.state).toBe("ready");
    expect(r.changes).toContain(seq);
  });

  it("a 429 on the POST shows the friendly wait line, keeps polling the GET, and asks again once Retry-After has passed", async () => {
    r.packs.script("get", ok(packView({ state: "none" })));
    r.packs.script("post", { kind: "rate_limited", retryAfterS: 120 }, ok(packView()));
    await r.toChosen();
    await r.advance(0);
    expect(packOf().state).toBe("pending");
    expect(packOf().notice).toBe(RATE_LIMITED_NOTICE);
    expect(RATE_LIMITED_NOTICE).toContain("Lots of people are exploring right now");
    expect(RATE_LIMITED_NOTICE).toContain("try this place again in a few minutes");
    // Polls the GET every 5 s; no POST until 120 s.
    await r.advance(60_000);
    expect(r.packs.calls.filter((c) => c.method === "post").length).toBe(1);
    expect(r.packs.calls.filter((c) => c.method === "get").length).toBeGreaterThan(8);
    expect(packOf().notice).toBe(RATE_LIMITED_NOTICE);
    await r.advance(62_000);
    expect(r.packs.calls.filter((c) => c.method === "post").length).toBe(2);
  });

  it("someone else's request starting the research clears the wait line", async () => {
    r.packs.script("get", ok(packView({ state: "none" })), ok(packView({ state: "none" })), ok(packView()), ok(readyPackView()));
    r.packs.script("post", { kind: "rate_limited", retryAfterS: 600 });
    await r.toChosen();
    await r.advance(0);
    expect(packOf().notice).toBe(RATE_LIMITED_NOTICE);
    await r.advance(PACK_POLL_MS); // still none: the line stays
    expect(packOf().notice).toBe(RATE_LIMITED_NOTICE);
    await r.advance(PACK_POLL_MS); // pending: someone else is researching it
    expect(packOf().state).toBe("pending");
    expect(packOf().notice).toBeUndefined();
    await r.advance(PACK_POLL_MS);
    expect(packOf().state).toBe("ready");
  });

  it("a failed pack that can be retried is requested again once; one that cannot waits, and Try again appears by itself", async () => {
    r.packs.script("get", ok(packView({ state: "failed", error: "The research didn't finish.", canRetry: true })));
    r.packs.script("post", ok(packView({ state: "failed", error: "The research didn't finish.", canRetry: false }), 30));
    await r.toChosen();
    await r.advance(0);
    expect(r.packs.calls.map((c) => c.method)).toEqual(["get", "post"]);
    expect(packOf().state).toBe("failed");
    expect(packOf().canRetry).toBe(false);
    // 30 s later the server is asked again (and now allows a retry); the page does not POST by itself again.
    r.packs.script("get", ok(packView({ state: "failed", error: "The research didn't finish.", canRetry: true })));
    await r.advance(31_000);
    expect(packOf().canRetry).toBe(true);
    expect(r.packs.calls.filter((c) => c.method === "post").length).toBe(1);
  });

  it("Try again is a POST; pressing it while pending is an idempotent success; a ready pack cannot be retried", async () => {
    r.packs.script("get", ok(packView({ state: "failed", error: "The research didn't finish.", canRetry: false })));
    const seq = await r.toChosen();
    await r.advance(0);
    expect(packOf().state).toBe("failed");
    r.packs.calls.length = 0;
    r.packs.script("post", ok(packView()));
    r.packs.script("get", ok(packView()), ok(readyPackView()));
    const v = okView(await r.api.retryPack(seq));
    expect(v.pack.state).toBe("pending");
    await r.advance(0);
    expect(r.packs.calls[0]).toEqual({ method: "post", code: "aaaaa1" });
    const rev = r.view().rev;
    expect(okView(await r.api.retryPack(seq)).rev).toBe(rev);
    await r.advance(PACK_POLL_MS * 2);
    expect(packOf().state).toBe("ready");
    expect(await r.api.retryPack(seq)).toEqual({ ok: false, kind: "bad_state" });
  });

  it("retryPack before a place is chosen is bad_state", async () => {
    const seq = await r.toCountry();
    expect(await r.api.retryPack(seq)).toEqual({ ok: false, kind: "bad_state" });
  });

  it("network errors back off, then show the pack as failed with Try again after six in a row", async () => {
    r.packs.script("get", { kind: "error" });
    await r.toChosen();
    await r.advance(0);
    expect(packOf().state).toBe("pending");
    await r.advance(10 * 60_000);
    expect(packOf().state).toBe("failed");
    expect(packOf().canRetry).toBe(true);
    expect(r.packs.calls.length).toBe(6);
  });

  it("a code the server does not know is a failed pack without Try again", async () => {
    r.packs.script("get", { kind: "not_found" });
    await r.toChosen();
    await r.advance(0);
    expect(packOf().state).toBe("failed");
    expect(packOf().canRetry).toBe(false);
  });

  it("a new round stops the old round's polling", async () => {
    r.packs.script("get", ok(packView()));
    await r.toChosen();
    await r.advance(0);
    r.backend.startRound();
    const calls = r.packs.calls.length;
    await r.advance(60_000);
    expect(r.packs.calls.length).toBe(calls);
  });

  it("dispose stops the polling", async () => {
    r.packs.script("get", ok(packView()));
    await r.toChosen();
    await r.advance(0);
    r.backend.dispose();
    const calls = r.packs.calls.length;
    await r.advance(60_000);
    expect(r.packs.calls.length).toBe(calls);
  });
});

// ---- the deep link -----------------------------------------------------------------------------------

describe("local backend: a deep link", () => {
  it("builds a chosen round at the place: landing at its point in its own unit, no spins, no roulettes", () => {
    const seq = r.backend.openPlace("aaaaa4");
    expect(seq).not.toBeNull();
    const v = r.view();
    expect(v.state).toBe("chosen");
    expect(v.spins).toEqual({ lng: null, lat: null });
    expect(v.landing).toEqual({ point: [9, 9], sea: false, land: [9, 9], centre: [9, 9], landUnit: "AAA", landUnitName: "Aland" });
    expect(v.country?.chosen).toEqual({ id: "AAA", name: "Aland" });
    expect(v.country?.candidates).toEqual([{ id: "AAA", name: "Aland" }]);
    expect(v.destination?.chosen?.id).toBe("AAA.a4");
    expect(v.destination?.seed).toBeNull();
    expect(v.destination?.rouletteAt).toBeNull();
    expect(v.destination?.candidates.length).toBe(5);
    expect(v.destination?.candidates.map((d) => d.id)).toContain("AAA.a4");
    expect(v.eligible).toBeNull();
    expect(v.decidedBy).toBeNull();
    expect(r.backend.placeOf(v.seq)?.dest.id).toBe("AAA.a4");
    expect(r.backend.placeOf(v.seq)?.unitName).toBe("Aland");
  });

  it("a unit with fewer than five places lists them all", () => {
    r.backend.openPlace("ddddd2");
    expect(r.view().destination?.candidates.map((d) => d.id)).toEqual(["DDD.d1", "DDD.d2"]);
    r.backend.openPlace("bbbbb1");
    expect(r.view().destination?.candidates.map((d) => d.id)).toEqual(["BBB.b1"]);
  });

  it("an unknown code names no place", () => {
    expect(r.backend.openPlace("zzzzzz")).toBeNull();
    expect(r.backend.currentSeq()).toBeNull();
  });

  it("works for a place in an advised country, and for a place already banked or never-again (Yay and Nay still work)", async () => {
    r.memory.reject("CCC.c1");
    const seq = r.backend.openPlace("ccccc1") as number;
    expect(r.view().state).toBe("chosen");
    okView(await r.api.decide(seq, "bank"));
    expect(r.memory.banked().map((e) => e.destinationId)).toEqual(["CCC.c1"]);
    expect(r.memory.rejected().has("CCC.c1")).toBe(false);
  });

  it("starts the place's pack like a round that arrived there", async () => {
    r.packs.script("get", ok(readyPackView()));
    r.backend.openPlace("aaaaa4");
    await r.advance(0);
    expect(r.packs.calls[0]).toEqual({ method: "get", code: "aaaaa4" });
    expect(r.view().pack.state).toBe("ready");
  });

  it("replaces the round on show, and its pack polling", async () => {
    r.packs.script("get", ok(packView()));
    const first = r.backend.openPlace("aaaaa4") as number;
    await r.advance(0);
    const second = r.backend.openPlace("ddddd1") as number;
    expect(second).not.toBe(first);
    expect(r.backend.model.view(first)).toBeUndefined();
    await r.advance(PACK_POLL_MS);
    expect(r.packs.calls.filter((c) => c.code === "aaaaa4").length).toBe(1);
  });
});
