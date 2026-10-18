import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, SendMessageResult } from "../src/server/api/messages";
import type { WyrOutcome, WyrView } from "../src/server/api/wyr";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerThread } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";
import { createWyrCards } from "../src/server/wyrCard";
import { createWyrControls, wyrStatusLine } from "../src/server/wyrControls";
import { createWyrGame, type WyrGameDeps } from "../src/server/wyrGame";
import { createWyrModel, type WyrModel } from "../src/server/wyrModel";

const {
  getHistory,
  getUsage,
  sendMessage,
  sendViewOnceMessage,
  uploadServerAttachment,
  createVoiceRecorder,
  createWyrRound,
  getWyrRound,
  voteWyr,
  answerWyr,
  revealWyr,
} = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  sendMessage: vi.fn(),
  sendViewOnceMessage: vi.fn(),
  uploadServerAttachment: vi.fn(),
  createVoiceRecorder: vi.fn((options: { onStop?: (r: { blob: Blob; durationMs: number; mimeType: string }) => void }) => {
    let state: "idle" | "recording" = "idle";
    return {
      get state() { return state; },
      elapsedMs: 2000,
      supportsPause: true,
      start: vi.fn(async () => { state = "recording"; }),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(() => {
        state = "idle";
        options.onStop?.({ blob: new Blob(["voice"]), durationMs: 2000, mimeType: "audio/webm;codecs=opus" });
      }),
      cancel: vi.fn(),
      toggle: vi.fn(async () => {}),
      detach: vi.fn(),
    };
  }),
  createWyrRound: vi.fn(),
  getWyrRound: vi.fn(),
  voteWyr: vi.fn(),
  answerWyr: vi.fn(),
  revealWyr: vi.fn(),
}));
vi.mock("../src/server/recorder", () => ({ createVoiceRecorder }));
vi.mock("../src/server/api/uploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/uploads")>()),
  uploadServerAttachment,
}));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
  sendMessage,
  sendViewOnceMessage,
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
    revealDeadline: null,
    question: { id: "q0001", category: "food-meals", a: "A classic cheeseburger", b: "A spicy pizza" },
    images: "none",
    players: [{ name: "Josh", vote: "play", answered: false, revealed: false }],
    you: { slot: 1, vote: "play", choice: null, guess: null, revealed: false },
    result: null,
    ...overrides,
  };
}

function photos(): Message["attachments"] {
  return [0, 1].map((i) => ({
    id: `att${i}`,
    kind: "photo" as const,
    status: "ready" as const,
    width: 100,
    height: 100,
    durationS: null,
    peaks: null,
    urls: { full: `https://example.invalid/full${i}.jpg`, thumb: `https://example.invalid/thumb${i}.jpg` },
  }));
}

function message(seq: number, extra: Partial<Message> = {}): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender: "Josh",
    text: null,
    attachments: [],
    reactions: [],
    createdAt: Date.now() / 1000,
    replyTo: null,
    wyr: { state: "voting", rev: 1 },
    ...extra,
  };
}

function chatMessage(seq: number, wyrRef: number | null, text: string, sender = "Rose"): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender,
    text,
    attachments: [],
    reactions: [],
    createdAt: Date.now() / 1000,
    replyTo: null,
    wyrRef,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function newModel(v: WyrView): WyrModel {
  const model = createWyrModel({
    session: () => SESSION,
    viewer: () => "Josh",
    fetchRound: async () => ({ ok: true, view: v }),
    onChange: () => {},
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => globalThis.clearTimeout(id),
  });
  model.apply(v);
  return model;
}

describe("wyr controls", () => {
  function make(v: WyrView) {
    const model = newModel(v);
    const vote = vi.fn<(seq: number, vote: "play" | "skip") => Promise<WyrOutcome>>();
    const answer = vi.fn<(seq: number, c: "a" | "b", g: "a" | "b") => Promise<WyrOutcome>>();
    const reveal = vi.fn<(seq: number) => Promise<WyrOutcome>>();
    const host = document.createElement("div");
    document.body.appendChild(host);
    let controls: ReturnType<typeof createWyrControls>;
    const redraw = (seq: number) => controls.render(host, seq, model.view(seq) ?? v);
    controls = createWyrControls({
      model,
      document,
      viewer: () => "Josh",
      vote,
      answer,
      reveal,
      redraw,
      afterChange: () => {},
    });
    controls.render(host, 7, v);
    return { host, model, vote, answer, reveal };
  }
  afterEach(() => document.body.replaceChildren());

  it("lets the second player join the active Reveal countdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const revealDeadline = Date.now() / 1000 + 30;
    const { host, reveal } = make(
      view({
        state: "revealing",
        rev: 4,
        revealDeadline,
        players: [
          { name: "Josh", vote: "play", answered: true, revealed: true },
          { name: "Rose", vote: "play", answered: true, revealed: false },
        ],
        you: { slot: 2, vote: "play", choice: "a", guess: "b", revealed: false },
      }),
    );
    reveal.mockResolvedValue({ ok: true, view: view({ state: "revealed", rev: 5 }) });
    const countdown = host.querySelector<HTMLButtonElement>("button.wx-srv-wyr-countdown");
    expect(countdown?.textContent).toContain("Tap to reveal together · 30s");
    expect(host.querySelector<HTMLElement>(".wx-srv-wyr-countdown-fill")?.style.transform).toBe(
      "scaleX(1)",
    );
    vi.advanceTimersByTime(15_000);
    expect(host.querySelector<HTMLElement>(".wx-srv-wyr-countdown-fill")?.style.transform).toBe(
      "scaleX(0.5)",
    );
    countdown?.click();
    expect(reveal).toHaveBeenCalledWith(7);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("returns the requester to a fresh Reveal action after the countdown expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const { host } = make(
      view({
        state: "revealing",
        rev: 4,
        revealDeadline: Date.now() / 1000 + 30,
        players: [
          { name: "Josh", vote: "play", answered: true, revealed: true },
          { name: "Rose", vote: "play", answered: true, revealed: false },
        ],
        you: { slot: 1, vote: "play", choice: "a", guess: "b", revealed: true },
      }),
    );
    expect(host.querySelector(".wx-srv-wyr-countdown")).not.toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(host.querySelector(".wx-srv-wyr-countdown")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".wx-srv-wyr-primary")?.textContent).toBe("Reveal");
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("lets the second person Play or Skip", async () => {
    const { host, vote } = make(
      view({ you: null, players: [{ name: "Rose", vote: "play", answered: false, revealed: false }] }),
    );
    expect(host.textContent).toContain("Rose wants to play");
    vote.mockResolvedValue({ ok: true, view: view({ rev: 2, state: "answering" }) });
    host.querySelectorAll<HTMLButtonElement>(".wx-srv-wyr-primary")[0]!.click();
    await flush();
    expect(vote).toHaveBeenCalledWith(7, "play");
  });

  it("answering needs both a pick and a guess before Send, then posts them", async () => {
    const answering = view({
      state: "answering",
      rev: 2,
      players: [
        { name: "Josh", vote: "play", answered: false, revealed: false },
        { name: "Rose", vote: "play", answered: false, revealed: false },
      ],
    });
    const { host, answer } = make(answering);
    const send = () =>
      [...host.querySelectorAll<HTMLButtonElement>(".wx-srv-wyr-primary")].find((b) => b.textContent === "Send my answer")!;
    expect(host.textContent).toContain("Which would YOU rather?");
    expect(host.textContent).toContain("Which will Rose pick?");
    expect(send().disabled).toBe(true);
    const groups = host.querySelectorAll(".wx-srv-wyr-group");
    (groups[0]!.querySelectorAll("button")[0] as HTMLButtonElement).click();
    expect(send().disabled).toBe(true);
    (groups[1]!.querySelectorAll("button")[1] as HTMLButtonElement).click();
    expect(send().disabled).toBe(false);
    answer.mockResolvedValue({ ok: true, view: view({ rev: 3, state: "answering" }) });
    send().click();
    await flush();
    expect(answer).toHaveBeenCalledWith(7, "a", "b");
  });

  it("shows no answers before both pressed Reveal, and both people's answers after", () => {
    const base = view({
      state: "revealing",
      rev: 4,
      players: [
        { name: "Josh", vote: "play", answered: true, revealed: false },
        { name: "Rose", vote: "play", answered: true, revealed: false },
      ],
      you: { slot: 1, vote: "play", choice: "a", guess: "b", revealed: false },
    });
    const waiting = make(base);
    expect([...waiting.host.querySelectorAll("button")].some((b) => b.textContent === "Reveal")).toBe(true);
    expect(waiting.host.querySelector(".wx-srv-wyr-result")).toBeNull();
    document.body.replaceChildren();
    const revealed = make(
      view({
        state: "revealed",
        rev: 6,
        players: base.players,
        you: { slot: 1, vote: "play", choice: "a", guess: "b", revealed: true },
        result: {
          players: [
            { name: "Josh", choice: "a", guess: "b" },
            { name: "Rose", choice: "b", guess: "a" },
          ],
          guessed: [true, true],
          agree: false,
        },
      }),
    );
    expect(revealed.host.textContent).toContain("You read each other");
    expect(revealed.host.textContent).toContain("Picked: A classic cheeseburger");
    expect(revealed.host.textContent).toContain("Picked: A spicy pizza");
  });

  it("describes every state in one plain line", () => {
    expect(wyrStatusLine(view())).toContain("Waiting for the other person");
    expect(wyrStatusLine(view({ state: "skipped" }))).toBe("Skipped.");
    expect(wyrStatusLine(view({ you: null, players: [{ name: "Rose", vote: "play", answered: false, revealed: false }] }))).toBe(
      "Rose wants to play.",
    );
  });
});

describe("wyr preview card", () => {
  afterEach(() => document.body.replaceChildren());

  function make(v: WyrView, msg: Message) {
    const model = newModel(v);
    const openGame = vi.fn();
    const cards = createWyrCards({ model, document, openGame });
    const el = cards.create(msg);
    document.body.appendChild(el);
    return { el, openGame };
  }

  it("shows both pictures, one status line and an Open button — no answer controls", () => {
    const { el, openGame } = make(view(), message(7, { attachments: photos() }));
    expect(el.querySelectorAll("img.wx-srv-wyr-img")).toHaveLength(2);
    expect(el.textContent).toContain("A classic cheeseburger");
    expect(el.textContent).toContain("A spicy pizza");
    expect(el.querySelector(".wx-srv-wyr-group")).toBeNull();
    expect(el.querySelector(".wx-srv-wyr-open")).not.toBeNull();
    el.querySelector<HTMLButtonElement>(".wx-srv-wyr-open")!.click();
    expect(openGame).toHaveBeenCalledWith(7);
  });

  it("shows a tappable Reveal countdown in the chat card and opens that round", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const { el, openGame } = make(
      view({
        state: "revealing",
        rev: 4,
        revealDeadline: Date.now() / 1000 + 30,
        players: [
          { name: "Josh", vote: "play", answered: true, revealed: true },
          { name: "Rose", vote: "play", answered: true, revealed: false },
        ],
      }),
      message(7, { wyr: { state: "revealing", rev: 4 } }),
    );
    const countdown = el.querySelector<HTMLButtonElement>("button.wx-srv-wyr-countdown");
    expect(countdown?.textContent).toContain("Reveal together · 30s");
    expect(el.querySelector(".wx-srv-wyr-open")).toBeNull();
    countdown?.click();
    expect(openGame).toHaveBeenCalledWith(7);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("restores the ordinary game shortcut when the chat countdown expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const { el } = make(
      view({
        state: "revealing",
        rev: 4,
        revealDeadline: Date.now() / 1000 + 30,
        players: [
          { name: "Josh", vote: "play", answered: true, revealed: true },
          { name: "Rose", vote: "play", answered: true, revealed: false },
        ],
      }),
      message(7, { wyr: { state: "revealing", rev: 4 } }),
    );
    expect(el.querySelector(".wx-srv-wyr-countdown")).not.toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(el.querySelector(".wx-srv-wyr-countdown")).toBeNull();
    expect(el.querySelector(".wx-srv-wyr-open")).not.toBeNull();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("waits with a placeholder only while the pictures are being painted", () => {
    expect(make(view({ images: "pending" }), message(7)).el.textContent).toContain("Painting");
    document.body.replaceChildren();
    const text = make(view({ images: "none" }), message(7));
    expect(text.el.textContent).not.toContain("Painting");
    expect(text.el.querySelectorAll(".wx-srv-wyr-frame")).toHaveLength(0);
    document.body.replaceChildren();
    expect(make(view({ images: "failed" }), message(7)).el.textContent).not.toContain("Painting");
  });

  it("a skipped round is muted and offers no Open button", () => {
    const { el } = make(view({ state: "skipped", rev: 2 }), message(7, { wyr: { state: "skipped", rev: 2 } }));
    expect(el.textContent).toContain("Skipped");
    expect(el.querySelector(".wx-srv-wyr-open")).toBeNull();
  });
});

describe("wyr game tab", () => {
  interface Harness {
    game: ReturnType<typeof createWyrGame>;
    deps: WyrGameDeps;
    composer: HTMLElement;
    thread: HTMLElement;
    state: { round: Message | undefined; messages: Message[]; echoes: { clientId: string; text: string | null }[] };
    renderBubble: ReturnType<typeof vi.fn>;
    mounts: (HTMLElement | null)[];
    layout: ReturnType<typeof vi.fn>;
    next: ReturnType<typeof vi.fn>;
  }

  function make(v: WyrView = view(), roundMessage: Message = message(7, { attachments: photos() })): Harness {
    const model = newModel(v);
    const state = { round: roundMessage as Message | undefined, messages: [] as Message[], echoes: [] as { clientId: string; text: string | null }[] };
    const composer = document.createElement("div");
    composer.className = "fake-composer";
    const thread = document.createElement("div");
    thread.appendChild(composer);
    document.body.appendChild(thread);
    const mounts: (HTMLElement | null)[] = [];
    const renderBubble = vi.fn((m: Message) => {
      const b = document.createElement("div");
      b.className = "wx-srv-bubble";
      b.textContent = m.text ?? "";
      return b;
    });
    const layout = vi.fn();
    const next = vi.fn();
    let controls: ReturnType<typeof createWyrControls>;
    const deps: WyrGameDeps = {
      document,
      model,
      controls: {
        render: (container, seq, vw) => controls.render(container, seq, vw),
      },
      isMine: (sender) => sender === "Josh",
      roundMessage: () => state.round,
      gameMessages: (seq) => state.messages.filter((m) => m.wyrRef === seq),
      gameEchoes: () => state.echoes,
      renderBubble,
      disposeBubble: () => {},
      mountComposer: (host) => {
        mounts.push(host);
        if (host !== null) host.appendChild(composer);
        else thread.appendChild(composer);
      },
      startNextRound: next,
      onLayoutChange: layout,
      afterChange: () => {},
    };
    const game = createWyrGame(deps);
    controls = createWyrControls({
      model,
      document,
      viewer: () => "Josh",
      vote: async () => ({ ok: true, view: v }),
      answer: async () => ({ ok: true, view: v }),
      reveal: async () => ({ ok: true, view: v }),
      redraw: () => game.refresh(),
      afterChange: () => {},
    });
    thread.append(game.pane, game.tabBar, game.popup);
    return { game, deps, composer, thread, state, renderBubble, mounts, layout, next };
  }

  afterEach(() => document.body.replaceChildren());

  it("has no tabs until a game is opened; opening shows the WYR tab, closing removes both", () => {
    const h = make();
    expect(h.game.tabBar.hidden).toBe(true);
    expect(h.game.pane.hidden).toBe(true);
    h.game.open(7);
    expect(h.game.tabBar.hidden).toBe(false);
    expect(h.game.tabBar.textContent).toContain("Chat");
    expect(h.game.tabBar.textContent).toContain("WYR");
    expect(h.game.pane.hidden).toBe(false);
    expect(h.game.activeTab()).toBe("wyr");
    h.game.showTab("chat");
    expect(h.game.pane.hidden).toBe(true);
    expect(h.game.tabBar.hidden).toBe(false);
    h.game.close();
    expect(h.game.tabBar.hidden).toBe(true);
    expect(h.game.gameSeq()).toBeNull();
    expect(h.layout).toHaveBeenCalled();
  });

  it("an offered round adds the tab with a dot but leaves the chat showing; a closed one is not re-offered", () => {
    const h = make();
    h.game.offer(7);
    expect(h.game.tabBar.hidden).toBe(false);
    expect(h.game.activeTab()).toBe("chat");
    expect(h.game.pane.hidden).toBe(true);
    expect(h.game.tabBar.querySelector(".wx-srv-tab-wyr .wx-srv-tab-dot:not([hidden])")).not.toBeNull();
    h.game.showTab("wyr");
    expect(h.game.tabBar.querySelector(".wx-srv-tab-dot:not([hidden])")).toBeNull();
    h.game.close();
    h.game.offer(7);
    expect(h.game.tabBar.hidden).toBe(true);
    h.game.open(7); // tapping the card always reopens it
    expect(h.game.gameSeq()).toBe(7);
  });

  it("tapping the picture flips between the two options", () => {
    const h = make();
    h.game.open(7);
    const caption = () => h.game.pane.querySelector(".wx-srv-game-caption-text")!.textContent;
    const on = () => [...h.game.pane.querySelectorAll(".wx-srv-game-img-on")].map((i) => i.getAttribute("src"));
    expect(caption()).toBe("A classic cheeseburger");
    expect(on()).toEqual(["https://example.invalid/full0.jpg"]);
    h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-stage")!.click();
    expect(caption()).toBe("A spicy pizza");
    expect(on()).toEqual(["https://example.invalid/full1.jpg"]);
    h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-stage")!.click();
    expect(caption()).toBe("A classic cheeseburger");
  });

  it("maximizes both pictures with their option labels and returns to the answer controls", () => {
    const answering = view({
      state: "answering",
      rev: 2,
      players: [
        { name: "Josh", vote: "play", answered: false, revealed: false },
        { name: "Rose", vote: "play", answered: false, revealed: false },
      ],
      you: { slot: 1, vote: "play", choice: null, guess: null, revealed: false },
    });
    const h = make(answering, message(7, { attachments: photos() }));
    h.game.open(7);
    const maximize = h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-maximize")!;
    expect(maximize.hidden).toBe(false);

    const dialog = h.game.pane.querySelector<HTMLDialogElement>(".wx-srv-game-pictures")!;
    const showModal = vi.fn(() => dialog.setAttribute("open", ""));
    Object.defineProperty(dialog, "showModal", { configurable: true, value: showModal });
    Object.defineProperty(dialog, "close", {
      configurable: true,
      value: () => dialog.removeAttribute("open"),
    });
    expect(dialog.open).toBe(false);
    maximize.click();
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelectorAll(".wx-srv-game-pictures-image:not([hidden])")).toHaveLength(2);
    expect(dialog.textContent).toContain("Option A: A classic cheeseburger");
    expect(dialog.textContent).toContain("Option B: A spicy pizza");

    dialog.querySelector<HTMLButtonElement>(".wx-srv-game-pictures-close")!.click();
    expect(dialog.open).toBe(false);
    expect(maximize.ownerDocument.activeElement).toBe(maximize);
    expect(h.game.pane.querySelector(".wx-srv-game-controls .wx-srv-wyr-group")).not.toBeNull();

    maximize.click();
    expect(dialog.open).toBe(true);
    h.game.showTab("chat");
    expect(dialog.open).toBe(false);
  });

  it("hides maximize pictures while the round has no ready image", () => {
    const h = make(view({ images: "pending" }), message(7));
    h.game.open(7);
    expect(h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-maximize")?.hidden).toBe(true);
  });

  it("a round without pictures shows the option as text, and 'Painting…' while they are coming", () => {
    const text = make(view({ images: "none" }), message(7));
    text.game.open(7);
    expect(text.game.pane.querySelector(".wx-srv-game-placeholder")!.textContent).toBe("A classic cheeseburger");
    document.body.replaceChildren();
    const painting = make(view({ images: "pending" }), message(7));
    painting.game.open(7);
    expect(painting.game.pane.querySelector(".wx-srv-game-placeholder")!.textContent).toBe("Painting…");
  });

  it("the mini chat shows only this card's last two messages (and echoes), never other chat", () => {
    const h = make();
    h.state.messages = [
      chatMessage(10, null, "main chat, not this card"),
      chatMessage(11, 7, "first about the card"),
      chatMessage(12, 7, "second about the card", "Josh"),
      chatMessage(13, 7, "third about the card"),
      chatMessage(14, 9, "a different round"),
    ];
    h.game.open(7);
    const rows = [...h.game.pane.querySelectorAll(".wx-srv-game-mini-msg")].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("second about the card");
    expect(rows[0]).not.toContain("Josh:"); // my own messages carry no name
    expect(rows[1]).toContain("Rose: third about the card");
    expect(h.game.pane.textContent).not.toContain("main chat, not this card");
    h.state.echoes = [{ clientId: "e1", text: "sending this" }];
    h.game.refresh();
    const after = [...h.game.pane.querySelectorAll(".wx-srv-game-mini-msg")].map((r) => r.textContent);
    expect(after).toHaveLength(2);
    expect(after[1]).toContain("sending this");
  });

  it("an empty card chat invites a message; attachments show as tiny tappable thumbnails", () => {
    const h = make();
    h.game.open(7);
    expect(h.game.pane.querySelector(".wx-srv-game-mini-empty")!.textContent).toContain("Chat about this one");
    h.state.messages = [{ ...chatMessage(11, 7, "look"), attachments: [photos()[0]!] }];
    h.game.refresh();
    const thumb = h.game.pane.querySelector<HTMLImageElement>(".wx-srv-game-mini-thumb")!;
    expect(thumb.getAttribute("src")).toBe("https://example.invalid/thumb0.jpg");
    thumb.parentElement!.click(); // tapping the message (or its thumbnail) opens the pop-up
    expect(h.game.isPopupOpen()).toBe(true);
  });

  it("the pop-up borrows the one composer and returns it; it shows the card's whole history", () => {
    const h = make();
    h.state.messages = [chatMessage(11, 7, "one"), chatMessage(12, 7, "two"), chatMessage(13, 7, "three")];
    h.game.open(7);
    expect(h.game.popup.hidden).toBe(true);
    h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-mini-msg")!.click();
    expect(h.game.popup.hidden).toBe(false);
    expect(h.game.popup.querySelector(".wx-srv-gamepop-composer")!.contains(h.composer)).toBe(true);
    expect(h.game.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(3);
    expect(h.game.chatTarget()).toBe(7);
    h.game.closePopup();
    expect(h.game.popup.hidden).toBe(true);
    expect(h.thread.contains(h.composer)).toBe(true);
    expect(h.game.popup.contains(h.composer)).toBe(false);
    expect(h.mounts[h.mounts.length - 1]).toBeNull();
  });

  it("the pop-up adds new messages without rebuilding the ones already there", () => {
    const h = make();
    h.state.messages = [chatMessage(11, 7, "one")];
    h.game.open(7);
    h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-mini-msg")!.click();
    expect(h.renderBubble).toHaveBeenCalledTimes(1);
    h.state.messages = [chatMessage(11, 7, "one"), chatMessage(12, 7, "two")];
    h.game.refresh();
    expect(h.renderBubble).toHaveBeenCalledTimes(2); // only the new one
    expect(h.game.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(2);
  });

  it("the close button and the backdrop close the pop-up; Escape is left to the panic lock", () => {
    const h = make();
    h.game.open(7);
    h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-mini-expand")!.click();
    expect(h.game.isPopupOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(h.game.isPopupOpen()).toBe(true); // not ours: the panel's panic key handles Escape
    h.game.popup.querySelector<HTMLButtonElement>(".wx-srv-gamepop-close")!.click();
    expect(h.game.isPopupOpen()).toBe(false);
    h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-mini-expand")!.click();
    h.game.popup.querySelector<HTMLButtonElement>(".wx-srv-gamepop-backdrop")!.click();
    expect(h.game.isPopupOpen()).toBe(false);
  });

  it("sends go to the game chat only while the WYR tab (or its pop-up) is the one in use", () => {
    const h = make();
    expect(h.game.chatTarget()).toBeNull();
    h.game.open(7);
    expect(h.game.chatTarget()).toBe(7);
    h.game.showTab("chat");
    expect(h.game.chatTarget()).toBeNull();
    h.game.close();
    expect(h.game.chatTarget()).toBeNull();
  });

  it("closing the game while the pop-up is open returns the composer", () => {
    const h = make();
    h.game.open(7);
    h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-mini-expand")!.click();
    h.game.close();
    expect(h.thread.contains(h.composer)).toBe(true);
    expect(h.game.popup.hidden).toBe(true);
  });

  it("closes itself when its round vanishes (deleted or wiped)", () => {
    const h = make();
    h.game.open(7);
    h.state.round = undefined;
    h.game.refresh();
    expect(h.game.gameSeq()).toBeNull();
    expect(h.game.tabBar.hidden).toBe(true);
  });

  it("a finished round offers the next one; Chat gets a dot for main-chat activity while playing", () => {
    const h = make(view({ state: "revealed", rev: 5, result: { players: [{ name: "Josh", choice: "a", guess: "b" }, { name: "Rose", choice: "b", guess: "a" }], guessed: [true, true], agree: false } }));
    h.game.open(7);
    const next = h.game.pane.querySelector<HTMLButtonElement>(".wx-srv-game-next")!;
    expect(next.hidden).toBe(false);
    next.click();
    expect(h.next).toHaveBeenCalledTimes(1);
    h.game.noteChatActivity();
    expect(h.game.tabBar.querySelector(".wx-srv-tab-chat .wx-srv-tab-dot:not([hidden])")).not.toBeNull();
    h.game.showTab("chat");
    expect(h.game.tabBar.querySelector(".wx-srv-tab-chat .wx-srv-tab-dot:not([hidden])")).toBeNull();
  });

  it("reset forgets the game and the dismissal", () => {
    const h = make();
    h.game.open(7);
    h.game.close();
    h.game.reset();
    h.game.offer(7);
    expect(h.game.gameSeq()).toBe(7);
  });
});

describe("thread wiring", () => {
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
  async function mount(
    messages: Message[] = [],
    viewOnce?: WeakMap<File, { enabled: boolean; durationS: 2 | 5 | 30 | null; tease: boolean }>,
  ) {
    getHistory.mockResolvedValue({ messages, hasMore: false, cursor: 0 });
    const h = hooks();
    const thread = mountServerThread({
      identity: identity(),
      hooks: h,
      win: win(),
      onSettings: vi.fn(),
      ...(viewOnce === undefined ? {} : { fileViewOnceSettings: viewOnce }),
    });
    document.body.appendChild(thread.element);
    await thread.attach(SESSION);
    await flush();
    return thread;
  }
  function startRoundFromMenu(thread: Awaited<ReturnType<typeof mount>>): void {
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-wyr")!.click();
  }
  function send(thread: Awaited<ReturnType<typeof mount>>, text: string): void {
    const textarea = thread.element.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = text;
    thread.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!.click();
  }

  beforeEach(() => {
    getHistory.mockReset();
    getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
    sendMessage.mockReset();
    sendViewOnceMessage.mockReset();
    uploadServerAttachment.mockReset();
    createVoiceRecorder.mockClear();
    createWyrRound.mockReset();
    getWyrRound.mockReset();
  });
  afterEach(() => document.body.replaceChildren());

  it("the menu has a Would you rather? item; starting a round opens the WYR tab with a preview card in the chat", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9, { attachments: photos() }) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const thread = await mount();
    expect(thread.element.querySelector(".wx-srv-tabs")!.hasAttribute("hidden")).toBe(true);
    startRoundFromMenu(thread);
    await flush();
    expect(createWyrRound).toHaveBeenCalledWith(SESSION, { clientId: "wyr-uuid-0001", sender: "Josh", deviceId: "device-1234" });
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-more-menu")!.hidden).toBe(true);
    // The game tab is open and showing; the thread underneath is hidden but holds the preview.
    expect(thread.element.querySelector(".wx-srv-tabs")!.hasAttribute("hidden")).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-game")!.hidden).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(true);
    expect(thread.element.classList.contains("wx-srv-in-game")).toBe(true);
    const bubble = thread.element.querySelector<HTMLElement>('.wx-srv-thread [data-message-seq="9"]')!;
    expect(bubble.classList.contains("wx-srv-bubble-wyr")).toBe(true);
    expect(bubble.querySelectorAll("img.wx-srv-wyr-img")).toHaveLength(2);
    expect(thread.element.querySelector(".wx-srv-game-caption-text")!.textContent).toBe("A classic cheeseburger");
    thread.teardown();
  });

  it("switching tabs hides and restores the thread; closing the game removes the tab bar", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const thread = await mount();
    startRoundFromMenu(thread);
    await flush();
    const wrap = thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!;
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!.click();
    expect(wrap.hidden).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-game")!.hidden).toBe(true);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-wyr")!.click();
    expect(wrap.hidden).toBe(true);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-game-close")!.click();
    expect(thread.element.querySelector(".wx-srv-tabs")!.hasAttribute("hidden")).toBe(true);
    expect(wrap.hidden).toBe(false);
    thread.teardown();
  });

  it("messages sent in the WYR tab carry wyrSeq; in the Chat tab they do not", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    sendMessage.mockResolvedValue({ ok: true, message: chatMessage(20, 9, "hi", "Josh") } satisfies SendMessageResult);
    const thread = await mount();
    startRoundFromMenu(thread);
    await flush();
    send(thread, "about the card");
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toMatchObject({ text: "about the card", wyrSeq: 9 });
    // The card chat's own message shows in the mini chat, tagged in the main chat.
    expect(thread.element.querySelector(".wx-srv-game-mini")!.textContent).toContain("hi");
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!.click();
    sendMessage.mockClear();
    sendMessage.mockResolvedValue({ ok: true, message: chatMessage(21, null, "hello", "Josh") } satisfies SendMessageResult);
    send(thread, "plain chat");
    await flush();
    expect(sendMessage.mock.calls[0]![1]).not.toHaveProperty("wyrSeq");
    expect(thread.element.querySelector('.wx-srv-thread [data-message-seq="20"] .wx-srv-bubble-wyrtag')).not.toBeNull();
    expect(thread.element.querySelector('.wx-srv-thread [data-message-seq="21"] .wx-srv-bubble-wyrtag')).toBeNull();
    thread.teardown();
  });

  it("an unfinished round from history offers the tab without taking over; the card's Play opens it", async () => {
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 5, you: null, players: [{ name: "Rose", vote: "play", answered: false, revealed: false }] }) });
    const thread = await mount([message(5, { sender: "Rose" })]);
    await flush();
    expect(thread.element.querySelector(".wx-srv-tabs")!.hasAttribute("hidden")).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false); // still in the chat
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-game")!.hidden).toBe(true);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-wyr-open")!.click();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-game")!.hidden).toBe(false);
    thread.teardown();
  });

  it("a finished round from history does not pop a tab", async () => {
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 5, state: "skipped", rev: 2 }) });
    const thread = await mount([message(5, { wyr: { state: "skipped", rev: 2 } })]);
    await flush();
    expect(thread.element.querySelector(".wx-srv-tabs")!.hasAttribute("hidden")).toBe(true);
    thread.teardown();
  });

  it("explains when the server cannot start a round, and opens no tab", async () => {
    createWyrRound.mockResolvedValue({ ok: false, kind: "unavailable" });
    const thread = await mount();
    startRoundFromMenu(thread);
    await flush();
    expect(thread.element.textContent).toContain("Couldn't start a round");
    expect(thread.element.querySelector(".wx-srv-tabs")!.hasAttribute("hidden")).toBe(true);
    thread.teardown();
  });

  // -- Audit round 3 (F3): a lock or a wipe while the WYR tab shows must give the chat back ------

  it("a lock while the WYR tab shows leaves the chat visible after the next unlock", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const thread = await mount();
    startRoundFromMenu(thread);
    await flush();
    const wrap = thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!;
    expect(wrap.hidden).toBe(true);
    thread.detach(); // the panic lock
    expect(wrap.hidden).toBe(false);
    expect(thread.element.classList.contains("wx-srv-in-game")).toBe(false);
    expect(thread.element.querySelector(".wx-srv-tabs")!.hasAttribute("hidden")).toBe(true);
    // ...and after the unlock, with a history whose only round is already finished (no tab offered):
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9, state: "skipped", rev: 3 }) });
    getHistory.mockResolvedValue({ messages: [message(9, { wyr: { state: "skipped", rev: 3 } })], hasMore: false, cursor: 0 });
    await thread.attach(SESSION);
    await flush();
    expect(wrap.hidden).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-game")!.hidden).toBe(true);
    thread.teardown();
  });

  it("a wipe while the WYR tab shows leaves the chat visible and drops the tab", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const thread = await mount();
    startRoundFromMenu(thread);
    await flush();
    const wrap = thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!;
    expect(wrap.hidden).toBe(true);
    thread.handleStreamEvent({ type: "wiped" } as Parameters<typeof thread.handleStreamEvent>[0]);
    await flush();
    expect(wrap.hidden).toBe(false);
    expect(thread.element.classList.contains("wx-srv-in-game")).toBe(false);
    expect(thread.element.querySelector(".wx-srv-tabs")!.hasAttribute("hidden")).toBe(true);
    thread.teardown();
  });

  // -- F1: a voice note's chat is fixed when recording stops ----------------------------------------

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }
  const VOICE_ATTACHMENT = { id: "voice-id", kind: "voice", status: "processing", width: null, height: null, durationS: 2, peaks: null, urls: {} } as const;

  async function recordVoiceNote(thread: Awaited<ReturnType<typeof mount>>): Promise<void> {
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")!.click();
    await flush();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")!.click();
    await flush();
  }

  it("a voice note recorded in the game chat stays in it even if the tab changes during the upload", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const upload = deferred<typeof VOICE_ATTACHMENT>();
    uploadServerAttachment.mockReturnValue(upload.promise);
    sendMessage.mockResolvedValue({ ok: true, message: chatMessage(30, 9, "", "Josh") } satisfies SendMessageResult);
    const thread = await mount();
    startRoundFromMenu(thread);
    await flush();
    await recordVoiceNote(thread); // recorded under the WYR tab
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!.click(); // switch while it uploads
    upload.resolve(VOICE_ATTACHMENT);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toMatchObject({ attachmentIds: ["voice-id"], wyrSeq: 9 });
    thread.teardown();
  });

  it("a voice note recorded in the main chat is not pulled into the game chat by a tab switch", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const upload = deferred<typeof VOICE_ATTACHMENT>();
    uploadServerAttachment.mockReturnValue(upload.promise);
    sendMessage.mockResolvedValue({ ok: true, message: chatMessage(31, null, "", "Josh") } satisfies SendMessageResult);
    const thread = await mount();
    startRoundFromMenu(thread);
    await flush();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!.click();
    await recordVoiceNote(thread); // recorded in the main chat
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-wyr")!.click(); // switch while it uploads
    upload.resolve(VOICE_ATTACHMENT);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).not.toHaveProperty("wyrSeq");
    thread.teardown();
  });

  it("a game-chat voice note whose round was deleted before it sent is kept and goes to the main chat", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const upload = deferred<typeof VOICE_ATTACHMENT>();
    uploadServerAttachment.mockReturnValue(upload.promise);
    sendMessage
      .mockResolvedValueOnce({ ok: false, kind: "rejected", status: 404 } satisfies SendMessageResult) // the round is gone
      .mockResolvedValueOnce({ ok: true, message: chatMessage(32, null, "", "Josh") } satisfies SendMessageResult);
    const thread = await mount();
    startRoundFromMenu(thread);
    await flush();
    await recordVoiceNote(thread); // recorded under the WYR tab
    upload.resolve(VOICE_ATTACHMENT);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]![1]).toMatchObject({ attachmentIds: ["voice-id"], wyrSeq: 9 });
    expect(sendMessage.mock.calls[1]![1]).toMatchObject({ attachmentIds: ["voice-id"], clientId: sendMessage.mock.calls[0]![1].clientId });
    expect(sendMessage.mock.calls[1]![1]).not.toHaveProperty("wyrSeq");
    expect(thread.element.querySelector(".wx-chat-composer-error")?.textContent ?? "").not.toContain("discarded");
    thread.teardown();
  });

  // -- F4: view-once is a main-chat feature ---------------------------------------------------------

  async function stagePhoto(thread: Awaited<ReturnType<typeof mount>>): Promise<File> {
    uploadServerAttachment.mockResolvedValue({ id: "photo-id", kind: "photo", status: "processing", width: 10, height: 10, durationS: null, peaks: null, urls: {} });
    const input = thread.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photo = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photo], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();
    return photo;
  }

  it("the view-once control is offered in the Chat tab and not in the game chat", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const thread = await mount();
    startRoundFromMenu(thread);
    await flush();
    await stagePhoto(thread);
    const button = thread.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!;
    expect(button.disabled).toBe(true); // game chat
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!.click();
    expect(button.disabled).toBe(false);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-wyr")!.click();
    expect(button.disabled).toBe(true);
    thread.teardown();
  });

  it("a view-once draft is refused in the game chat — nothing is sent and the draft stays", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: message(9) });
    getWyrRound.mockResolvedValue({ ok: true, view: view({ seq: 9 }) });
    const settings = new WeakMap<File, { enabled: boolean; durationS: 2 | 5 | 30 | null; tease: boolean }>();
    const thread = await mount([], settings);
    startRoundFromMenu(thread);
    await flush();
    const photo = await stagePhoto(thread);
    settings.set(photo, { enabled: true, durationS: 5, tease: false }); // chosen earlier, in the main chat
    thread.element.querySelector<HTMLTextAreaElement>("textarea")!.value = "a caption";
    thread.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!.click();
    await flush();
    expect(sendViewOnceMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(thread.element.querySelector(".wx-chat-composer-error")!.textContent).toContain("main chat");
    expect(thread.element.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("a caption"); // draft restored
    thread.teardown();
  });
});
