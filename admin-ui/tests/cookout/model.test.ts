import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import { parseCookoutView, type CookoutOutcome, type CookoutView } from "../../src/server/cookout/api";
import { createCookoutModel, pendingKey, pollDelayMs, POLL_MAX_MS } from "../../src/server/cookout/model";
import type { ServerSession } from "../../src/server/types";
import { finishedView, pickingView, type Json } from "./fixtures";

// The Cookout model (spec 09 §5.2): a per-round view cache whose `rev` only moves forward, that reads a
// round when its message's summary says it moved, and that polls on an exponential backoff while the
// chef, the pictures or a recipe is still pending.

function v(raw: Json): CookoutView {
  const view = parseCookoutView(raw);
  if (view === null) throw new Error("fixture did not parse");
  return view;
}

function message(seq: number, rev: number, extra: Json = {}): Message {
  return {
    seq,
    sender: "Josh",
    text: null,
    attachments: [],
    reactions: [],
    createdAt: 1,
    replyTo: null,
    cookout: { state: "picking", blind: false, pickedCount: 0, concepts: "none", bankedCount: 0, rev, ...extra },
  } as unknown as Message;
}

interface Timer {
  readonly fn: () => void;
  readonly ms: number;
  cleared: boolean;
}

function harness(fetchRound: (seq: number, viewer: string) => Promise<CookoutOutcome>) {
  const timers: Timer[] = [];
  let viewer: string | null = "Josh";
  let session: ServerSession | null = { token: "tok", expiresAt: 9e9 } as ServerSession;
  const onChange = vi.fn<(seq: number) => void>();
  const fetches: Array<[number, string]> = [];
  const model = createCookoutModel({
    session: () => session,
    viewer: () => viewer,
    fetchRound: (_s, seq, who) => {
      fetches.push([seq, who]);
      return fetchRound(seq, who);
    },
    onChange,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      const t = timers[id - 1];
      if (t !== undefined) t.cleared = true;
    },
  });
  return {
    model,
    timers,
    fetches,
    onChange,
    setViewer: (name: string | null) => (viewer = name),
    setSession: (s: ServerSession | null) => (session = s),
    /** Fires the newest live timer. */
    fire(): number {
      for (let i = timers.length - 1; i >= 0; i -= 1) {
        const t = timers[i];
        if (t !== undefined && !t.cleared) {
          t.cleared = true;
          t.fn();
          return t.ms;
        }
      }
      throw new Error("no live timer");
    },
    live: () => timers.filter((t) => !t.cleared),
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("rev only moves forward", () => {
  it("an older view never replaces a newer one; an equal or newer one does", () => {
    const h = harness(async () => ({ ok: false, kind: "unavailable" }));
    h.model.apply(v(pickingView({ rev: 5 })));
    h.model.apply(v(pickingView({ rev: 4, turn: 2 })));
    expect(h.model.view(41)?.rev).toBe(5);
    expect(h.model.view(41)?.current?.turn).toBe(1);
    h.model.apply(v(pickingView({ rev: 6, turn: 2 })));
    expect(h.model.view(41)?.current?.turn).toBe(2);
    expect(h.onChange).toHaveBeenCalledTimes(2);
  });

  it("reads a round when its summary is ahead of the view, never when the view is current", async () => {
    const h = harness(async () => ({ ok: true, view: v(pickingView({ rev: 3 })) }));
    h.model.observe([message(41, 3)]);
    await flush();
    expect(h.fetches).toEqual([[41, "Josh"]]);
    h.model.observe([message(41, 3)]);
    await flush();
    expect(h.fetches).toHaveLength(1);
    // A summary that LAGS the view (a mutation answered first) does not trigger a read either.
    h.model.apply(v(pickingView({ rev: 7 })));
    h.model.observe([message(41, 6)]);
    await flush();
    expect(h.fetches).toHaveLength(1);
  });

  it("ignores a message whose cookout summary is malformed", async () => {
    const h = harness(async () => ({ ok: true, view: v(pickingView({ rev: 3 })) }));
    h.model.observe([{ ...message(41, 3), cookout: { state: "weird", rev: 3 } } as unknown as Message]);
    await flush();
    expect(h.fetches).toHaveLength(0);
  });

  it("a different viewer name drops every held view and reads them as the new name", async () => {
    const h = harness(async (_seq, who) => ({ ok: true, view: v(pickingView({ rev: who === "Josh" ? 3 : 3 })) }));
    h.model.observe([message(41, 3)]);
    await flush();
    expect(h.model.view(41)).toBeDefined();
    h.setViewer("Cupcake");
    h.model.observe([message(41, 3)]);
    await flush();
    expect(h.fetches).toEqual([
      [41, "Josh"],
      [41, "Cupcake"],
    ]);
  });

  it("forgets a round whose message is gone or whose read says not found", async () => {
    const h = harness(async () => ({ ok: false, kind: "not_found" }));
    h.model.apply(v(pickingView({ rev: 3 })));
    h.model.observe([]);
    expect(h.model.view(41)).toBeUndefined();
    h.model.observe([message(42, 2)]);
    await flush();
    expect(h.model.view(42)).toBeUndefined();
    expect(h.live()).toHaveLength(0);
  });

  it("a mutation answered after a reset (lock, wipe, new viewer) is not applied", async () => {
    const h = harness(async () => ({ ok: false, kind: "unavailable" }));
    let answer: (o: CookoutOutcome) => void = () => {};
    const pending = h.model.run(() => new Promise<CookoutOutcome>((r) => (answer = r)));
    h.model.reset();
    answer({ ok: true, view: v(pickingView({ rev: 9 })) });
    await pending;
    expect(h.model.view(41)).toBeUndefined();
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it("a failed read is retried later, and reset() cancels everything", async () => {
    const h = harness(async () => ({ ok: false, kind: "unavailable" }));
    h.model.observe([message(41, 3)]);
    await flush();
    expect(h.live().map((t) => t.ms)).toEqual([2_000]);
    h.model.reset();
    expect(h.live()).toHaveLength(0);
  });
});

describe("polling while something is pending", () => {
  it("knows what is pending", () => {
    expect(pendingKey(v(pickingView()))).toBe("");
    expect(pendingKey(v(finishedView({ concepts: "pending", images: "none" })))).toBe("concepts");
    expect(pendingKey(v(finishedView({ concepts: "ready", images: "pending" })))).toBe("images");
    const recipes = finishedView({ concepts: "ready", images: "done" });
    ((recipes["recipes"] as Json)["b"] as Json)["state"] = "pending";
    expect(pendingKey(v(recipes))).toBe("recipe-b");
    expect(pendingKey(v(finishedView({ concepts: "ready", images: "done" })))).toBe("");
  });

  it("backs off 2 s, 4 s, 8 s, 16 s, then holds at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(pollDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, POLL_MAX_MS, POLL_MAX_MS, POLL_MAX_MS]);
  });

  it("polls a pending round on the growing backoff, and stops once nothing is pending", async () => {
    let answer = v(finishedView({ concepts: "pending", images: "none", rev: 9 }));
    const h = harness(async () => ({ ok: true, view: answer }));
    h.model.apply(answer);
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      delays.push(h.fire());
      await flush();
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(h.fetches).toHaveLength(4);
    answer = v(finishedView({ concepts: "ready", images: "done", rev: 10 }));
    h.fire();
    await flush();
    expect(h.model.view(41)?.concepts.state).toBe("ready");
    expect(h.live()).toHaveLength(0);
  });

  it("starts the backoff again when what is pending changes", async () => {
    const h = harness(async () => ({ ok: false, kind: "unavailable" }));
    h.model.apply(v(finishedView({ concepts: "pending", images: "none", rev: 9 })));
    expect(h.live().map((t) => t.ms)).toEqual([2_000]);
    h.model.apply(v(finishedView({ concepts: "ready", images: "pending", rev: 10 })));
    expect(h.live().map((t) => t.ms)).toEqual([2_000]);
    expect(h.timers.filter((t) => t.cleared)).toHaveLength(1);
  });

  it("never polls a round that is being picked", () => {
    const h = harness(async () => ({ ok: false, kind: "unavailable" }));
    h.model.apply(v(pickingView()));
    expect(h.live()).toHaveLength(0);
  });
});
