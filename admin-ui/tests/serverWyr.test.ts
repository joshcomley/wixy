import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/server/api/messages";
import {
  parseWyrSummary,
  parseWyrView,
  type WyrOutcome,
  type WyrView,
} from "../src/server/api/wyr";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerThread } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";
import { createWyrCards } from "../src/server/wyrCard";
import { createWyrModel } from "../src/server/wyrModel";

const { getHistory, getUsage, createWyrRound, getWyrRound, voteWyr, answerWyr, revealWyr } =
  vi.hoisted(() => ({
    getHistory: vi.fn(),
    getUsage: vi.fn(),
    createWyrRound: vi.fn(),
    getWyrRound: vi.fn(),
    voteWyr: vi.fn(),
    answerWyr: vi.fn(),
    revealWyr: vi.fn(),
  }));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
}));
vi.mock("../src/server/api/wyr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/wyr")>()),
  createWyrRound,
  getWyrRound,
  voteWyr,
  answerWyr,
  revealWyr,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function view(overrides: Partial<WyrView> = {}): WyrView {
  return {
    seq: 7,
    state: "voting",
    rev: 1,
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

describe("wyr card", () => {
  function make(v: WyrView, msg: Message) {
    const model = createWyrModel({
      session: () => SESSION,
      viewer: () => "Josh",
      fetchRound: async () => ({ ok: true, view: v }),
      onChange: () => {},
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => globalThis.clearTimeout(id),
    });
    model.apply(v);
    const vote = vi.fn<(seq: number, vote: "play" | "skip") => Promise<WyrOutcome>>();
    const answer = vi.fn<(seq: number, c: "a" | "b", g: "a" | "b") => Promise<WyrOutcome>>();
    const reveal = vi.fn<(seq: number) => Promise<WyrOutcome>>();
    const cards = createWyrCards({
      model,
      document,
      viewer: () => "Josh",
      vote,
      answer,
      reveal,
      afterChange: () => {},
    });
    const el = cards.create(msg);
    document.body.appendChild(el);
    return { el, model, vote, answer, reveal, cards };
  }

  afterEach(() => document.body.replaceChildren());

  it("lets the second person Play or Skip", async () => {
    const v = view({
      you: null,
      players: [{ name: "Rose", vote: "play", answered: false, revealed: false }],
    });
    const { el, vote } = make(v, message(7));
    expect(el.textContent).toContain("Rose wants to play");
    vote.mockResolvedValue({ ok: true, view: view({ rev: 2, state: "answering" }) });
    el.querySelectorAll<HTMLButtonElement>(".wx-srv-wyr-primary")[0]!.click();
    await flush();
    expect(vote).toHaveBeenCalledWith(7, "play");
  });

  it("answering needs both a pick and a guess before Send, then posts them", async () => {
    const v = view({ state: "answering", rev: 2, players: [
      { name: "Josh", vote: "play", answered: false, revealed: false },
      { name: "Rose", vote: "play", answered: false, revealed: false },
    ] });
    const { el, answer } = make(v, message(7, "answering", 2));
    const send = () => [...el.querySelectorAll<HTMLButtonElement>(".wx-srv-wyr-primary")].find((b) => b.textContent === "Send my answer")!;
    expect(el.textContent).toContain("Which would YOU rather?");
    expect(el.textContent).toContain("Which will Rose pick?");
    expect(send().disabled).toBe(true);
    const groups = el.querySelectorAll(".wx-srv-wyr-group");
    (groups[0]!.querySelectorAll("button")[0] as HTMLButtonElement).click();
    expect(send().disabled).toBe(true);
    (groups[1]!.querySelectorAll("button")[1] as HTMLButtonElement).click();
    expect(send().disabled).toBe(false);
    answer.mockResolvedValue({ ok: true, view: view({ rev: 3, state: "answering" }) });
    send().click();
    await flush();
    expect(answer).toHaveBeenCalledWith(7, "a", "b");
  });

  it("shows a Reveal button only until I have pressed it, and no answers before both did", async () => {
    const base = view({
      state: "revealing",
      rev: 4,
      players: [
        { name: "Josh", vote: "play", answered: true, revealed: false },
        { name: "Rose", vote: "play", answered: true, revealed: false },
      ],
      you: { slot: 1, vote: "play", choice: "a", guess: "b", revealed: false },
    });
    const { el, reveal } = make(base, message(7, "revealing", 4));
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Reveal")!;
    expect(button).toBeDefined();
    expect(el.querySelector(".wx-srv-wyr-result")).toBeNull();
    reveal.mockResolvedValue({ ok: true, view: base });
    button.click();
    await flush();
    expect(reveal).toHaveBeenCalledWith(7);

    const waiting = make(
      { ...base, you: { slot: 1, vote: "play", choice: "a", guess: "b", revealed: true } },
      message(7, "revealing", 4),
    );
    expect([...waiting.el.querySelectorAll("button")].some((b) => b.textContent === "Reveal")).toBe(false);
    expect(waiting.el.textContent).toContain("Waiting for Rose to press Reveal");
  });

  it("shows both people's picks and guesses once revealed", () => {
    const revealed = view({
      state: "revealed",
      rev: 6,
      players: [
        { name: "Josh", vote: "play", answered: true, revealed: true },
        { name: "Rose", vote: "play", answered: true, revealed: true },
      ],
      you: { slot: 1, vote: "play", choice: "a", guess: "b", revealed: true },
      result: {
        players: [
          { name: "Josh", choice: "a", guess: "b" },
          { name: "Rose", choice: "b", guess: "a" },
        ],
        guessed: [true, true],
        agree: false,
      },
    });
    const { el } = make(revealed, message(7, "revealed", 6));
    expect(el.textContent).toContain("You read each other");
    expect(el.textContent).toContain("Picked: A classic cheeseburger");
    expect(el.textContent).toContain("Picked: A spicy pizza");
  });

  it("renders a skipped round as muted with a hint", () => {
    const { el } = make(view({ state: "skipped", rev: 2 }), message(7, "skipped", 2));
    expect(el.textContent).toContain("Skipped");
    expect(el.querySelector(".wx-srv-wyr-actions")).toBeNull();
  });

  it("shows pictures when the anchor message has them and a placeholder while they paint", () => {
    const withPhotos: Message = {
      ...message(7),
      attachments: [0, 1].map((i) => ({
        id: `att${i}`,
        kind: "photo" as const,
        status: "ready" as const,
        width: 100,
        height: 100,
        durationS: null,
        peaks: null,
        urls: { full: `https://example.invalid/${i}.jpg` },
      })),
    };
    const done = make(view(), withPhotos);
    expect(done.el.querySelectorAll("img.wx-srv-wyr-img")).toHaveLength(2);
    document.body.replaceChildren();
    const painting = make(view(), message(7));
    expect(painting.el.querySelectorAll("img")).toHaveLength(0);
    expect(painting.el.textContent).toContain("Painting");
    document.body.replaceChildren();
    // A server that paints no pictures lays the round out as text: no placeholder frames.
    const textOnly = make(view({ images: "none" }), message(7));
    expect(textOnly.el.textContent).not.toContain("Painting");
    expect(textOnly.el.querySelectorAll(".wx-srv-wyr-frame")).toHaveLength(0);
    expect(textOnly.el.textContent).toContain("A classic cheeseburger");
    document.body.replaceChildren();
    document.body.replaceChildren();
    // The job ended without pictures: the card stops waiting at once.
    const failed = make(view({ images: "failed" }), message(7));
    expect(failed.el.textContent).not.toContain("Painting");
    expect(failed.el.querySelectorAll(".wx-srv-wyr-frame")).toHaveLength(0);
  });
});

describe("header menu and thread wiring", () => {
  function identity(): ServerIdentity {
    return {
      getName: () => "Josh",
      setName: vi.fn(),
      getDeviceId: () => "device-1234",
      isMine: (sender: string) => sender.toLowerCase() === "josh",
    };
  }
  function hooks(): LockHooks {
    return {
      suspend: vi.fn(() => () => {}),
      lockNow: vi.fn(),
      adoptBoundSession: vi.fn(),
      getBoundGrantId: vi.fn(() => null),
    };
  }
  function win(): Window {
    return {
      crypto: { randomUUID: () => "wyr-uuid-0001" },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      navigator: window.navigator,
    } as unknown as Window;
  }
  async function mount() {
    getHistory.mockResolvedValue({ messages: [], hasMore: false, cursor: 0 });
    const h = hooks();
    const thread = mountServerThread({ identity: identity(), hooks: h, win: win(), onSettings: vi.fn() });
    document.body.appendChild(thread.element);
    await thread.attach(SESSION);
    await flush();
    return thread;
  }

  beforeEach(() => {
    getHistory.mockReset();
    getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
    createWyrRound.mockReset();
    getWyrRound.mockReset();
  });
  afterEach(() => document.body.replaceChildren());

  it("the menu has a Would you rather? item that starts a round and shows its card", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const thread = await mount();
    const menu = thread.element.querySelector<HTMLElement>(".wx-srv-more-menu")!;
    expect(menu.textContent).toContain("Would you rather?");
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-wyr")!.click();
    await flush();
    expect(createWyrRound).toHaveBeenCalledWith(SESSION, {
      clientId: "wyr-uuid-0001",
      sender: "Josh",
      deviceId: "device-1234",
    });
    expect(menu.hidden).toBe(true);
    const bubble = thread.element.querySelector<HTMLElement>('[data-message-seq="9"]')!;
    expect(bubble.classList.contains("wx-srv-bubble-wyr")).toBe(true);
    await flush();
    expect(getWyrRound).toHaveBeenCalledWith(SESSION, 9, "Josh");
    expect(bubble.textContent).toContain("A classic cheeseburger");
    thread.teardown();
  });

  it("explains when the server cannot start a round", async () => {
    createWyrRound.mockResolvedValue({ ok: false, kind: "unavailable" });
    const thread = await mount();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-wyr")!.click();
    await flush();
    expect(thread.element.textContent).toContain("Couldn't start a round");
    expect(thread.element.querySelector(".wx-srv-wyr-card")).toBeNull();
    thread.teardown();
  });
});
