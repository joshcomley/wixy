import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import type { AdventureOutcome, AdventureView } from "../../src/server/adventure/api";
import { createAdventureModel, type AdventureModelDeps } from "../../src/server/adventure/model";
import type { ServerSession } from "../../src/server/types";
import { NOW, view } from "./adventureFixtures";

const SESSION: ServerSession = { token: "tok-1", expiresAt: 9_999_999_999 };

function message(seq: number, rev: number, state: NonNullable<Message["adventure"]>["state"] = "spin_lng"): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender: "Ann",
    text: null,
    attachments: [],
    reactions: [],
    createdAt: 1,
    replyTo: null,
    adventure: { state, pack: "none", rev },
  };
}

interface Rig {
  readonly model: ReturnType<typeof createAdventureModel>;
  readonly fetchRound: ReturnType<typeof vi.fn<(session: ServerSession, seq: number) => Promise<AdventureOutcome>>>;
  readonly onChange: ReturnType<typeof vi.fn<(seq: number) => void>>;
  readonly timers: Array<{ fn: () => void; ms: number; id: number; cleared: boolean }>;
  clock: { t: number };
  session: { current: ServerSession | null };
}

function rig(options: { answer?: (seq: number) => AdventureOutcome } = {}): Rig {
  const clock = { t: 1_000_000 };
  const session: { current: ServerSession | null } = { current: SESSION };
  const timers: Rig["timers"] = [];
  const fetchRound = vi.fn<(session: ServerSession, seq: number) => Promise<AdventureOutcome>>(async (_s, seq) =>
    options.answer !== undefined ? options.answer(seq) : { ok: true, view: view("spin_lng", { seq, rev: 1 }) },
  );
  const onChange = vi.fn<(seq: number) => void>();
  const deps: AdventureModelDeps = {
    session: () => session.current,
    fetchRound,
    onChange,
    setTimeout: (fn, ms) => {
      const entry = { fn, ms, id: timers.length + 1, cleared: false };
      timers.push(entry);
      return entry.id;
    },
    clearTimeout: (id) => {
      const entry = timers.find((t) => t.id === id);
      if (entry !== undefined) entry.cleared = true;
    },
    now: () => clock.t,
  };
  return { model: createAdventureModel(deps), fetchRound, onChange, timers, clock, session };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("adventure model: when to fetch", () => {
  it("fetches the view of a round whose summary it has not seen, applies it and tells the screen", async () => {
    const r = rig();
    r.model.observe([message(7, 1)]);
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(1);
    expect(r.fetchRound).toHaveBeenCalledWith(SESSION, 7);
    expect(r.model.view(7)?.state).toBe("spin_lng");
    expect(r.onChange).toHaveBeenCalledWith(7);
  });

  it("does not fetch again while the held view is as new as the summary, but does when the summary's rev moves on", async () => {
    const r = rig({ answer: (seq) => ({ ok: true, view: view("spin_lng", { seq, rev: 2 }) }) });
    r.model.observe([message(7, 2)]);
    await flush();
    r.model.observe([message(7, 2)]);
    r.model.observe([message(7, 1)]); // a lagging summary
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(1);
    r.fetchRound.mockResolvedValueOnce({ ok: true, view: view("spin_lat", { rev: 3 }) });
    r.model.observe([message(7, 3, "spin_lat")]);
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(2);
    expect(r.model.view(7)?.rev).toBe(3);
  });

  it("a server that answers with something older than its own summary is asked again after a pause, never in a loop", async () => {
    const r = rig({ answer: () => ({ ok: true, view: view("spin_lng", { rev: 1 }) }) });
    r.model.observe([message(7, 5, "spin_lat")]);
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(1);
    expect(r.timers.map((t) => t.ms)).toEqual([2_000]);
  });

  it("never replaces a view with an older one, and takes an equal one (a re-read)", () => {
    const r = rig();
    r.model.apply(view("spin_lat", { rev: 5 }));
    r.model.apply(view("spin_lng", { rev: 4 }));
    expect(r.model.view(7)?.state).toBe("spin_lat");
    r.model.apply(view("country", { rev: 5 }));
    expect(r.model.view(7)?.state).toBe("country");
  });

  it("ignores a message without an adventure and forgets a round whose message has gone", async () => {
    const r = rig();
    r.model.observe([{ ...message(3, 1), adventure: null }, { ...message(4, 1) }]);
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(1);
    expect(r.model.view(4)).toBeDefined();
    r.model.observe([]); // the thread no longer has message 4
    expect(r.model.view(4)).toBeUndefined();
  });

  it("asks once more after a fetch in flight when a newer summary arrived meanwhile", async () => {
    let release: (() => void) | null = null;
    const r = rig();
    r.fetchRound.mockImplementationOnce(
      () =>
        new Promise<AdventureOutcome>((resolve) => {
          release = () => resolve({ ok: true, view: view("spin_lng", { rev: 1 }) });
        }),
    );
    r.model.observe([message(7, 1)]);
    r.model.observe([message(7, 2, "spin_lat")]); // while the first is out
    expect(r.fetchRound).toHaveBeenCalledTimes(1);
    r.fetchRound.mockResolvedValue({ ok: true, view: view("spin_lat", { rev: 2 }) });
    (release as (() => void) | null)?.();
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(2);
    expect(r.model.view(7)?.rev).toBe(2);
  });

  it("a deleted round (404) is forgotten; an unreachable server retries on a growing delay", async () => {
    const r = rig({ answer: () => ({ ok: false, kind: "not_found" }) });
    r.model.observe([message(7, 1)]);
    await flush();
    expect(r.model.view(7)).toBeUndefined();
    expect(r.timers).toHaveLength(0);

    const down = rig({ answer: () => ({ ok: false, kind: "unavailable" }) });
    down.model.observe([message(7, 1)]);
    await flush();
    expect(down.timers.map((t) => t.ms)).toEqual([2_000]);
    down.timers[0]?.fn();
    await flush();
    expect(down.timers.map((t) => t.ms)).toEqual([2_000, 5_000]);
    down.timers[1]?.fn();
    await flush();
    down.timers[2]?.fn();
    await flush();
    down.timers[3]?.fn();
    await flush();
    expect(down.timers.map((t) => t.ms).slice(-2)).toEqual([30_000, 30_000]); // capped
  });

  it("a thrown fetch is just a failed one; nothing is fetched without a session", async () => {
    const r = rig();
    r.fetchRound.mockRejectedValueOnce(new Error("boom"));
    r.model.observe([message(7, 1)]);
    await flush();
    expect(r.timers).toHaveLength(1);
    r.session.current = null;
    r.model.observe([message(8, 1)]);
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(1);
  });

  it("reset drops everything, cancels the retry timers and discards an answer still on its way", async () => {
    const down = rig({ answer: () => ({ ok: false, kind: "unavailable" }) });
    down.model.observe([message(7, 1)]);
    await flush();
    down.model.reset();
    expect(down.timers[0]?.cleared).toBe(true);

    let release: (() => void) | null = null;
    const r = rig();
    r.fetchRound.mockImplementationOnce(
      () =>
        new Promise<AdventureOutcome>((resolve) => {
          release = () => resolve({ ok: true, view: view("spin_lng", { rev: 1 }) });
        }),
    );
    r.model.observe([message(7, 1)]);
    r.model.reset(); // the chat locked
    (release as (() => void) | null)?.();
    await flush();
    expect(r.model.view(7)).toBeUndefined();
    expect(r.onChange).not.toHaveBeenCalled();
    expect(r.model.clockOffsetMs()).toBeNull();
  });

  it("refetch reads the round again even though its rev is current", async () => {
    const r = rig();
    r.model.observe([message(7, 1)]);
    await flush();
    r.model.refetch(7);
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(2);
  });

  it("a renewed unlock token re-reads the views it holds (their signed picture URLs were for the old one)", async () => {
    const r = rig();
    r.model.observe([message(7, 1)]);
    await flush();
    r.model.observe([message(7, 1)]);
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(1);
    r.session.current = { token: "tok-2", expiresAt: 9_999_999_999 };
    r.model.observe([message(7, 1)]);
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(2);
    expect(r.fetchRound).toHaveBeenLastCalledWith(r.session.current, 7);
    r.model.observe([message(7, 1)]);
    await flush();
    expect(r.fetchRound).toHaveBeenCalledTimes(2); // once per new token
  });
});

describe("adventure model: the clock (spec 4.4)", () => {
  /** A fetch that takes `rttMs` of local time and whose view says the server clock read `serverS`. */
  function timedFetch(r: Rig, rttMs: number, serverS: number): void {
    r.fetchRound.mockImplementationOnce(async (_s, seq) => {
      r.clock.t += rttMs;
      return { ok: true, view: view("spin_lng", { seq, rev: 1, serverNow: serverS }) };
    });
  }

  it("is the local clock until a view arrives", () => {
    const r = rig();
    expect(r.model.clockOffsetMs()).toBeNull();
    expect(r.model.serverNowS()).toBe(1_000);
  });

  it("takes the offset from the response midpoint", async () => {
    const r = rig();
    // Local 1_000_000 ms -> reply after 200 ms: midpoint 1_000_100 ms; the server said 1_800_000_000 s.
    timedFetch(r, 200, NOW);
    r.model.observe([message(7, 1)]);
    await flush();
    expect(r.model.clockOffsetMs()).toBeCloseTo(NOW * 1000 - 1_000_100, 6);
    expect(r.model.serverNowS()).toBeCloseTo((r.clock.t + (NOW * 1000 - 1_000_100)) / 1000, 6);
  });

  it("keeps the sample with the SMALLEST round trip, not the latest", async () => {
    const r = rig();
    timedFetch(r, 40, NOW); // best: offset = NOW*1000 - (1_000_000 + 20)
    r.model.observe([message(7, 1)]);
    await flush();
    const best = r.model.clockOffsetMs();
    r.clock.t += 5_000;
    timedFetch(r, 900, NOW + 3); // a slow, noisy one
    r.model.refetch(7);
    await flush();
    expect(r.model.clockOffsetMs()).toBe(best);
    r.clock.t += 5_000;
    timedFetch(r, 10, NOW + 10.5); // a better one wins
    r.model.refetch(7);
    await flush();
    expect(r.model.clockOffsetMs()).not.toBe(best);
    expect(r.model.clockOffsetMs()).toBeCloseTo((NOW + 10.5) * 1000 - (r.clock.t - 5), 6);
  });

  it("ignores a round trip too long to say anything, and lets an old best go after ten minutes", async () => {
    const r = rig();
    timedFetch(r, 6_000, NOW);
    r.model.observe([message(7, 1)]);
    await flush();
    expect(r.model.clockOffsetMs()).toBeNull();
    timedFetch(r, 30, NOW);
    r.model.refetch(7);
    await flush();
    const first = r.model.clockOffsetMs();
    expect(first).not.toBeNull();
    r.clock.t += 11 * 60_000;
    timedFetch(r, 400, NOW + 11 * 60);
    r.model.refetch(7);
    await flush();
    expect(r.model.clockOffsetMs()).not.toBe(first); // the drifting clock is followed
  });

  it("times a mutation the same way and applies the view it answers with", async () => {
    const r = rig();
    const outcome = await r.model.run(async () => {
      r.clock.t += 100;
      return { ok: true, view: view("spin_lat", { rev: 9, serverNow: NOW + 1 }) } as AdventureOutcome;
    });
    expect(outcome.ok).toBe(true);
    expect(r.model.view(7)?.rev).toBe(9);
    expect(r.model.clockOffsetMs()).toBeCloseTo((NOW + 1) * 1000 - (1_000_000 + 50), 6);
    const failed: AdventureView[] = [];
    const bad = await r.model.run(async () => ({ ok: false, kind: "bad_state" }) as AdventureOutcome);
    expect(bad).toEqual({ ok: false, kind: "bad_state" });
    expect(failed).toHaveLength(0);
    expect(r.model.view(7)?.rev).toBe(9); // a refusal changes nothing
  });

  it("rethrows what a mutation throws (a lock) and applies nothing", async () => {
    const r = rig();
    await expect(
      r.model.run(async () => {
        throw new Error("locked");
      }),
    ).rejects.toThrow("locked");
    expect(r.model.view(7)).toBeUndefined();
  });
});
