import { describe, expect, it, vi } from "vitest";
import type { Message } from "../src/server/api/messages";
import {
  parseWyrSummary,
  parseWyrView,
  type WyrOutcome,
  type WyrView,
} from "../src/server/api/wyr";
import type { ServerSession } from "../src/server/types";
import { createWyrModel } from "../src/server/wyrModel";

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function view(overrides: Partial<WyrView> = {}): WyrView {
  return {
    seq: 7,
    state: "voting",
    rev: 1,
    revealDeadline: null,
    question: { id: "q0001", category: "food-meals", a: "A classic cheeseburger", b: "A spicy pizza" },
    images: "pending",
    players: [{ name: "Josh", vote: "play", answered: false, revealed: false }],
    you: { slot: 1, vote: "play", choice: null, guess: null, revealed: false },
    result: null,
    ...overrides,
  };
}

function message(seq: number, state: WyrView["state"] = "voting", rev = 1): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender: "Josh",
    text: null,
    attachments: [],
    reactions: [],
    createdAt: Date.now() / 1000,
    replyTo: null,
    wyr: { state, rev },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("wyr api parsing", () => {
  it("accepts a well-formed summary and rejects junk", () => {
    expect(parseWyrSummary({ state: "answering", rev: 3 })).toEqual({ state: "answering", rev: 3 });
    expect(parseWyrSummary({ state: "nope", rev: 3 })).toBeNull();
    expect(parseWyrSummary({ state: "voting", rev: 0 })).toBeNull();
    expect(parseWyrSummary(null)).toBeNull();
  });

  it("parses a view and never honours a result on an unrevealed round", () => {
    const raw = {
      seq: 7,
      state: "answering",
      rev: 2,
      revealDeadline: 123.5,
      question: { id: "q1", category: "x", a: "A", b: "B" },
      players: [{ name: "Josh", vote: "play", answered: true, revealed: false }],
      you: { slot: 1, vote: "play", choice: "a", guess: "b", revealed: false },
      result: {
        players: [
          { name: "Josh", choice: "a", guess: "b" },
          { name: "Rose", choice: "b", guess: "a" },
        ],
        guessed: [true, true],
        agree: false,
      },
    };
    const parsed = parseWyrView(raw);
    expect(parsed?.result).toBeNull();
    expect(parsed?.you?.choice).toBe("a");
    expect(parsed?.revealDeadline).toBe(123.5);
  });

  it("rejects a revealed view with no readable result", () => {
    const raw = {
      seq: 7,
      state: "revealed",
      rev: 5,
      question: { id: "q1", category: "x", a: "A", b: "B" },
      players: [],
      you: null,
      result: null,
    };
    expect(parseWyrView(raw)).toBeNull();
  });
});

describe("wyr model", () => {
  function make(viewer: string | null = "Josh") {
    const changed: number[] = [];
    const fetchRound = vi.fn<(s: ServerSession, seq: number, v: string) => Promise<WyrOutcome>>();
    const model = createWyrModel({
      session: () => SESSION,
      viewer: () => viewer,
      fetchRound,
      onChange: (seq) => changed.push(seq),
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => globalThis.clearTimeout(id),
    });
    return { model, fetchRound, changed };
  }

  it("fetches a round the summary says it lacks, once, and notifies", async () => {
    const { model, fetchRound, changed } = make();
    fetchRound.mockResolvedValue({ ok: true, view: view({ rev: 1 }) });
    model.observe([message(7, "voting", 1)]);
    model.observe([message(7, "voting", 1)]);
    await flush();
    expect(fetchRound).toHaveBeenCalledTimes(1);
    expect(fetchRound).toHaveBeenCalledWith(SESSION, 7, "Josh");
    expect(model.view(7)?.rev).toBe(1);
    expect(changed).toContain(7);
  });

  it("refetches when the summary moves ahead, and never goes backwards", async () => {
    const { model, fetchRound } = make();
    fetchRound.mockResolvedValueOnce({ ok: true, view: view({ rev: 1 }) });
    model.observe([message(7, "voting", 1)]);
    await flush();
    fetchRound.mockResolvedValueOnce({ ok: true, view: view({ rev: 3, state: "answering" }) });
    model.observe([message(7, "answering", 3)]);
    await flush();
    expect(model.view(7)?.state).toBe("answering");
    model.apply(view({ rev: 2, state: "voting" }));
    expect(model.view(7)?.rev).toBe(3);
  });

  it("drops a round whose message vanished, and everything when the viewer changes", async () => {
    let viewer: string | null = "Josh";
    const fetchRound = vi.fn<(s: ServerSession, seq: number, v: string) => Promise<WyrOutcome>>();
    fetchRound.mockResolvedValue({ ok: true, view: view() });
    const model = createWyrModel({
      session: () => SESSION,
      viewer: () => viewer,
      fetchRound,
      onChange: () => {},
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => globalThis.clearTimeout(id),
    });
    model.observe([message(7)]);
    await flush();
    expect(model.view(7)).toBeDefined();
    model.observe([]);
    expect(model.view(7)).toBeUndefined();
    model.observe([message(7)]);
    await flush();
    viewer = "Rose";
    fetchRound.mockClear();
    model.observe([message(7)]);
    await flush();
    expect(fetchRound).toHaveBeenCalledWith(SESSION, 7, "Rose");
  });

  it("does not refetch in a loop when the held view is newer than the thread's summary", async () => {
    const { model, fetchRound } = make();
    model.apply(view({ state: "answering", rev: 3 }));
    // The thread's summary lags the mutation response that was applied first.
    model.observe([message(7, "voting", 1)]);
    model.observe([message(7, "voting", 1)]);
    await flush();
    expect(fetchRound).not.toHaveBeenCalled();
    // A genuinely newer summary does fetch, exactly once.
    fetchRound.mockResolvedValue({ ok: true, view: view({ state: "revealing", rev: 5 }) });
    model.observe([message(7, "revealing", 5)]);
    await flush();
    expect(fetchRound).toHaveBeenCalledTimes(1);
    expect(model.view(7)?.rev).toBe(5);
  });

  it("forgets a round the server says is gone", async () => {
    const { model, fetchRound } = make();
    fetchRound.mockResolvedValue({ ok: false, kind: "not_found" });
    model.observe([message(7)]);
    await flush();
    expect(model.view(7)).toBeUndefined();
  });

  it("keeps unsent picks as a draft and clears them once the server holds the answer", () => {
    const { model } = make();
    model.apply(view({ state: "answering", rev: 2 }));
    model.setDraft(7, { choice: "a" });
    model.setDraft(7, { guess: "b" });
    expect(model.draft(7)).toEqual({ choice: "a", guess: "b" });
    model.apply(
      view({
        state: "answering",
        rev: 3,
        you: { slot: 1, vote: "play", choice: "a", guess: "b", revealed: false },
      }),
    );
    expect(model.draft(7)).toEqual({ choice: null, guess: null });
  });
});
