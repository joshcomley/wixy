import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, SendMessageResult } from "../src/server/api/messages";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerThread, type ServerThreadView } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";
import type { AdventureOutcome, AdventureView } from "../src/server/adventure/api";
import { resetWorldCache } from "../src/server/adventure/world";
import { NOW, readyPack, spin, testTopology, view, wire } from "./adventure/adventureFixtures";

const {
  getHistory,
  getUsage,
  sendMessage,
  sendViewOnceMessage,
  uploadServerAttachment,
  createVoiceRecorder,
  createWyrRound,
  getWyrRound,
  createAdventure,
  getAdventure,
  getAdventureBank,
  decideAdventure,
} = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  sendMessage: vi.fn(),
  sendViewOnceMessage: vi.fn(),
  uploadServerAttachment: vi.fn(),
  createVoiceRecorder: vi.fn(() => ({
    state: "idle",
    elapsedMs: 0,
    supportsPause: true,
    start: vi.fn(async () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    toggle: vi.fn(async () => {}),
    detach: vi.fn(),
  })),
  createWyrRound: vi.fn(),
  getWyrRound: vi.fn(),
  createAdventure: vi.fn(),
  getAdventure: vi.fn(),
  getAdventureBank: vi.fn(),
  decideAdventure: vi.fn(),
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
}));
vi.mock("../src/server/adventure/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/adventure/api")>()),
  createAdventure,
  getAdventure,
  getAdventureBank,
  decideAdventure,
}));
const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function adventureMessage(seq: number, state: NonNullable<Message["adventure"]>["state"] = "spin_lng", rev = 1, sender = "Josh"): Message {
  return { seq, clientId: `c${seq}`, sender, text: null, attachments: [], reactions: [], createdAt: 1_800_000_000, replyTo: null, adventure: { state, pack: "none", rev } };
}

function wyrMessage(seq: number, state: "voting" | "revealed" = "voting"): Message {
  return { seq, clientId: `c${seq}`, sender: "Josh", text: null, attachments: [], reactions: [], createdAt: Date.now() / 1000, replyTo: null, wyr: { state, rev: 1 } };
}

function chatMessage(seq: number, wyrRef: number | null, text: string, wyrRefKind?: "wyr" | "adventure" | null, sender = "Rose"): Message {
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
    ...(wyrRefKind === undefined ? {} : { wyrRefKind }),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function identity(): ServerIdentity {
  return { getName: () => "Josh", setName: vi.fn(), getDeviceId: () => "device-1234", isMine: (sender: string) => sender.toLowerCase() === "josh" };
}

function hooks(): LockHooks & { suspend: ReturnType<typeof vi.fn> } {
  return { suspend: vi.fn(() => () => {}), lockNow: vi.fn(), adoptBoundSession: vi.fn(), getBoundGrantId: vi.fn(() => null) };
}

/** A window stand-in whose animation frames only run when a test says so. */
function win(frames: Array<(t: number) => void>): Window {
  return {
    crypto: { randomUUID: () => "adv-uuid-0001" },
    localStorage: window.localStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (cb: (t: number) => void) => frames.push(cb),
    cancelAnimationFrame: () => {},
    navigator: window.navigator,
  } as unknown as Window;
}

interface Mounted {
  thread: ServerThreadView;
  hooks: ReturnType<typeof hooks>;
  frames: Array<(t: number) => void>;
}

async function mount(messages: Message[] = []): Promise<Mounted> {
  getHistory.mockResolvedValue({ messages, hasMore: false, cursor: 0 });
  const h = hooks();
  const frames: Array<(t: number) => void> = [];
  const thread = mountServerThread({ identity: identity(), hooks: h, win: win(frames), onSettings: vi.fn() });
  document.body.appendChild(thread.element);
  await thread.attach(SESSION);
  await flush();
  return { thread, hooks: h, frames };
}

function openMenu(thread: ServerThreadView): void {
  thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
}

function startAdventure(thread: ServerThreadView): void {
  openMenu(thread);
  thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-adventure")!.click();
}

function tabs(thread: ServerThreadView): string[] {
  return [...thread.element.querySelectorAll<HTMLButtonElement>(".wx-srv-tab")].filter((b) => !b.hidden).map((b) => b.getAttribute("aria-label") ?? "");
}

function send(thread: ServerThreadView, text: string): void {
  const textarea = thread.element.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.value = text;
  thread.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!.click();
}

function answer(v: AdventureView): AdventureOutcome {
  return { ok: true, view: v };
}

beforeEach(() => {
  for (const mock of [getHistory, getUsage, sendMessage, sendViewOnceMessage, uploadServerAttachment, createWyrRound, getWyrRound, createAdventure, getAdventure, getAdventureBank, decideAdventure]) mock.mockReset();
  getUsage.mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
  getAdventure.mockImplementation(async (_s: ServerSession, seq: number) => answer(view("spin_lng", { seq })));
  getWyrRound.mockResolvedValue({ ok: false, kind: "unavailable" });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // The world map is a static file the game fetches: serve the small test world instead.
  resetWorldCache();
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(testTopology()), { status: 200, headers: { "Content-Type": "application/json" } }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("adventure: the menu", () => {
  it("has Adventure Time (after Would you rather?) and Holiday bank, with their one-line hints", async () => {
    const { thread } = await mount();
    const items = [...thread.element.querySelectorAll(".wx-srv-more-item")].map((i) => [i.querySelector(".wx-srv-more-item-title")?.textContent, i.querySelector(".wx-srv-more-item-hint")?.textContent]);
    const titles = items.map((i) => i[0]);
    expect(titles.indexOf("Adventure Time")).toBe(titles.indexOf("Would you rather?") + 1);
    expect(items.find((i) => i[0] === "Adventure Time")?.[1]).toBe("Spin the globe, find your next holiday");
    expect(items.find((i) => i[0] === "Holiday bank")?.[1]).toBe("Places you've saved");
    thread.teardown();
  });
});

describe("adventure: starting a round", () => {
  it("POSTs the round, adds its card to the chat and lands the starter in the Adventure tab", async () => {
    createAdventure.mockResolvedValue({ ok: true, message: adventureMessage(9) });
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 9 })));
    const { thread } = await mount();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    startAdventure(thread);
    await flush();
    expect(createAdventure).toHaveBeenCalledWith(SESSION, { clientId: "adv-uuid-0001", sender: "Josh", deviceId: "device-1234" });
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-more-menu")!.hidden).toBe(true);
    expect(tabs(thread)).toEqual(["Chat", "Adventure Time game"]);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-adv")!.hidden).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(true);
    expect(thread.element.classList.contains("wx-srv-in-game")).toBe(true);
    const bubble = thread.element.querySelector<HTMLElement>('.wx-srv-thread [data-message-seq="9"]')!;
    expect(bubble.classList.contains("wx-srv-bubble-adv")).toBe(true);
    expect(bubble.querySelector(".wx-srv-adv-mcard-status")?.textContent).toBe("Spin the globe!");
    expect(bubble.querySelector(".wx-srv-adv-mcard-open")?.textContent).toBe("Play");
    thread.teardown();
  });

  it("explains when the server cannot start one, and opens no tab", async () => {
    const { thread } = await mount();
    for (const [kind, text] of [["unavailable", "Couldn't start an adventure"], ["unsupported", "isn't available yet"], ["game_unavailable", "no places left"]] as const) {
      createAdventure.mockResolvedValue({ ok: false, kind });
      startAdventure(thread);
      await flush();
      expect(thread.element.textContent).toContain(text);
      expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    }
    thread.teardown();
  });

  it("a lock while starting locks the chat", async () => {
    const { thread, hooks: h } = await mount();
    const { ServerLockedError } = await import("../src/server/api/http");
    createAdventure.mockRejectedValue(new ServerLockedError());
    startAdventure(thread);
    await flush();
    expect(h.lockNow).toHaveBeenCalledWith("unauthorized");
    thread.teardown();
  });

  it("the card's Play opens the tab; Chat and the tab swap the thread and the pane", async () => {
    createAdventure.mockResolvedValue({ ok: true, message: adventureMessage(9) });
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 9 })));
    const { thread } = await mount();
    startAdventure(thread);
    await flush();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!.click();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-adv")!.hidden).toBe(true);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-adv-mcard-open")!.click();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-adv")!.hidden).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(true);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-adv-close")!.click();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false);
    thread.teardown();
  });

  it("the pane's New starts the next adventure", async () => {
    createAdventure.mockResolvedValueOnce({ ok: true, message: adventureMessage(9) }).mockResolvedValueOnce({ ok: true, message: adventureMessage(10) });
    getAdventure.mockImplementation(async (_s: ServerSession, seq: number) => answer(view("spin_lng", { seq })));
    const { thread } = await mount();
    startAdventure(thread);
    await flush();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-adv-new")!.click();
    await flush();
    expect(createAdventure).toHaveBeenCalledTimes(2);
    expect(thread.element.querySelectorAll(".wx-srv-bubble-adv")).toHaveLength(2);
    expect(tabs(thread)).toEqual(["Chat", "Adventure Time game"]);
    thread.teardown();
  });
});

describe("adventure: an adventure someone else started", () => {
  it("an unfinished one from history is OFFERED (a dot) without taking the chat over; the card opens it", async () => {
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 5 })));
    const { thread } = await mount([adventureMessage(5, "spin_lng", 1, "Rose")]);
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(false);
    expect(thread.element.querySelector(".wx-srv-tab-adventure .wx-srv-tab-dot:not([hidden])")).not.toBeNull();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-adv")!.hidden).toBe(true);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-adv-mcard-open")!.click();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-adv")!.hidden).toBe(false);
    thread.teardown();
  });

  it("a finished one (banked, rejected, replaced) is not offered", async () => {
    for (const state of ["banked", "rejected", "abandoned"] as const) {
      getAdventure.mockImplementation(async (_s: ServerSession, seq: number) => answer(view("spin_lng", { seq })));
      const { thread } = await mount([adventureMessage(5, state, 3, "Rose")]);
      await flush();
      expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden, state).toBe(true);
      thread.teardown();
      document.body.replaceChildren();
    }
  });

  it("a round that arrives live is offered once; the game's card shows the view once it is read", async () => {
    const { thread } = await mount();
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 12 })));
    thread.handleStreamEvent({ type: "message", message: adventureMessage(12, "spin_lng", 1, "Rose") });
    await flush();
    expect(thread.element.querySelector(".wx-srv-tab-adventure .wx-srv-tab-dot:not([hidden])")).not.toBeNull();
    expect(getAdventure).toHaveBeenCalledWith(SESSION, 12);
    expect(thread.element.querySelector('[data-message-seq="12"] .wx-srv-adv-mcard-status')?.textContent).toBe("Spin the globe!");
    thread.teardown();
  });

  it("a newer summary (message_updated) re-reads the view and redraws the card in place", async () => {
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 5, rev: 1 })));
    const { thread } = await mount([adventureMessage(5, "spin_lng", 1, "Rose")]);
    await flush();
    const before = thread.element.querySelector('.wx-srv-thread [data-message-seq="5"]');
    getAdventure.mockResolvedValue(answer(view("chosen", { seq: 5, rev: 4, pack: readyPack(), lat: spin("Bea", -15, 900, 4000, NOW - 60) })));
    thread.handleStreamEvent({ type: "message_updated", message: adventureMessage(5, "chosen", 4, "Rose") });
    await flush();
    expect(thread.element.querySelector('.wx-srv-thread [data-message-seq="5"]')).toBe(before); // the bubble is patched, not rebuilt
    expect(before?.querySelector(".wx-srv-adv-mcard-status")?.textContent).toBe("Alpha, Aland: Sun and tiles");
    thread.teardown();
  });
});

describe("adventure and would-you-rather share one tab bar", () => {
  it("starting an adventure while a WYR round is open replaces the WYR tab (only Chat + one game, ever)", async () => {
    createWyrRound.mockResolvedValue({ ok: true, message: wyrMessage(3) });
    createAdventure.mockResolvedValue({ ok: true, message: adventureMessage(9) });
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 9 })));
    const { thread } = await mount();
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-wyr")!.click();
    await flush();
    expect(tabs(thread)).toEqual(["Chat", "Would you rather game"]);
    startAdventure(thread);
    await flush();
    expect(tabs(thread)).toEqual(["Chat", "Adventure Time game"]);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-game:not(.wx-srv-adv)")!.hidden).toBe(true);
    // And back: a WYR round replaces the adventure.
    createWyrRound.mockResolvedValue({ ok: true, message: wyrMessage(11) });
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-wyr")!.click();
    await flush();
    expect(tabs(thread)).toEqual(["Chat", "Would you rather game"]);
    thread.teardown();
  });

  it("an older unfinished round of one game never pushes the other game's newer tab out on later renders", async () => {
    // History: an unfinished WYR round (3) and a newer unfinished adventure (5). The newer is offered...
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 5 })));
    const { thread } = await mount([wyrMessage(3), adventureMessage(5, "spin_lng", 1, "Rose")]);
    await flush();
    expect(tabs(thread)).toEqual(["Chat", "Adventure Time game"]);
    // ...and stays, however many more times the thread is redrawn (a reaction, a new message).
    for (let i = 0; i < 3; i += 1) {
      thread.handleStreamEvent({ type: "message", message: chatMessage(20 + i, null, `hello ${i}`) });
      await flush();
    }
    expect(tabs(thread)).toEqual(["Chat", "Adventure Time game"]);
    thread.teardown();
  });
});

describe("adventure: the game chat", () => {
  it("a message sent in the Adventure tab carries wyrSeq = the round's anchor; in Chat it does not", async () => {
    createAdventure.mockResolvedValue({ ok: true, message: adventureMessage(9) });
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 9 })));
    sendMessage.mockResolvedValue({ ok: true, message: chatMessage(20, 9, "hi", "adventure", "Josh") } satisfies SendMessageResult);
    const { thread } = await mount();
    startAdventure(thread);
    await flush();
    send(thread, "about the trip");
    await flush();
    expect(sendMessage.mock.calls[0]![1]).toMatchObject({ text: "about the trip", wyrSeq: 9 });
    expect(thread.element.querySelector(".wx-srv-adv .wx-srv-game-mini")!.textContent).toContain("hi"); // the shared mini chat
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!.click();
    sendMessage.mockClear();
    sendMessage.mockResolvedValue({ ok: true, message: chatMessage(21, null, "hello", null, "Josh") } satisfies SendMessageResult);
    send(thread, "plain chat");
    await flush();
    expect(sendMessage.mock.calls[0]![1]).not.toHaveProperty("wyrSeq");
    thread.teardown();
  });

  it("tags the message in the main chat with its game: the server's wyrRefKind wins, the loaded anchor is the fallback", async () => {
    const thread = (
      await mount([
        adventureMessage(5, "chosen", 2),
        wyrMessage(6),
        chatMessage(20, 5, "about the trip", "adventure"),
        chatMessage(21, 6, "about the question", "wyr"),
        chatMessage(22, 5, "an older server did not say"), // no wyrRefKind: the loaded anchor says Adventure
        chatMessage(23, 99, "anchor not loaded, no kind", null), // kind null with a ref: the old default
        chatMessage(24, 77, "anchor not loaded, but the server knows", "adventure"),
      ])
    ).thread;
    const tag = (seq: number): { text: string | null; wyrClass: boolean; game: string | undefined } | null => {
      const el = thread.element.querySelector<HTMLElement>(`.wx-srv-thread [data-message-seq="${seq}"] .wx-srv-bubble-gametag`);
      return el === null ? null : { text: el.textContent, wyrClass: el.classList.contains("wx-srv-bubble-wyrtag"), game: el.dataset["game"] };
    };
    expect(tag(20)).toEqual({ text: "Adventure", wyrClass: false, game: "adventure" });
    expect(tag(21)).toEqual({ text: "WYR", wyrClass: true, game: "wyr" });
    expect(tag(22)).toEqual({ text: "Adventure", wyrClass: false, game: "adventure" });
    expect(tag(23)?.text).toBe("WYR");
    expect(tag(24)).toEqual({ text: "Adventure", wyrClass: false, game: "adventure" });
    thread.teardown();
  });
});

describe("adventure: the Holiday bank", () => {
  it("the menu item opens the screen, which lists the trips; a tap closes it and opens that trip in the game", async () => {
    const trip = { seq: 5, unitId: "AAA", unitName: "Aland", destination: { id: "AAA.alpha", name: "Alpha", region: "Alpha region", lat: 3, lng: 3, kind: "city", blurb: "Lovely." }, headline: "Sun and tiles", pack: "ready" };
    getAdventureBank.mockResolvedValue({ ok: true, trips: [trip] });
    getAdventure.mockResolvedValue(answer(view("banked", { seq: 5, rev: 4, lat: spin("Bea", -15, 900, 4000, NOW - 60) })));
    const { thread } = await mount([adventureMessage(5, "banked", 4)]);
    await flush();
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-bank")!.click();
    await flush();
    const bank = thread.element.querySelector<HTMLElement>(".wx-srv-bank-view")!;
    expect(bank.hidden).toBe(false);
    expect(bank.textContent).toContain("Alpha");
    expect(bank.textContent).toContain("Sun and tiles");
    bank.querySelector<HTMLButtonElement>(".wx-srv-bank-trip")!.click();
    await flush();
    expect(bank.hidden).toBe(true);
    expect(tabs(thread)).toEqual(["Chat", "Adventure Time game"]);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-adv")!.hidden).toBe(false);
    thread.teardown();
  });

  it("a trip older than the loaded history is paged in first, so its card and its chat are there when the tab opens", async () => {
    const trip = { seq: 2, unitId: "AAA", unitName: "Aland", destination: { id: "AAA.alpha", name: "Alpha", region: "r", lat: 3, lng: 3, kind: "city", blurb: "b" }, headline: null, pack: "ready" };
    getAdventureBank.mockResolvedValue({ ok: true, trips: [trip] });
    getAdventure.mockResolvedValue(answer(view("banked", { seq: 2, rev: 4, lat: spin("Bea", -15, 900, 4000, NOW - 60) })));
    getHistory.mockResolvedValueOnce({ messages: [chatMessage(60, null, "recent")], hasMore: true, cursor: 0 });
    getHistory.mockResolvedValueOnce({ messages: [adventureMessage(2, "banked", 4), chatMessage(3, 2, "about that trip", "adventure")], hasMore: false, cursor: 0 });
    const h = hooks();
    const thread = mountServerThread({ identity: identity(), hooks: h, win: win([]), onSettings: vi.fn() });
    document.body.appendChild(thread.element);
    await thread.attach(SESSION);
    await flush();
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-bank")!.click();
    await flush();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-bank-trip")!.click();
    await flush();
    await flush();
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(getHistory.mock.calls[1]![1]).toMatchObject({ before: 60 });
    expect(tabs(thread)).toEqual(["Chat", "Adventure Time game"]);
    expect(thread.element.querySelector(".wx-srv-adv .wx-srv-game-mini")!.textContent).toContain("about that trip");
    thread.teardown();
  });

  it("says so when the trip's message cannot be found (it was deleted)", async () => {
    const trip = { seq: 2, unitId: "AAA", unitName: "Aland", destination: { id: "AAA.alpha", name: "Alpha", region: "r", lat: 3, lng: 3, kind: "city", blurb: "b" }, headline: null, pack: "ready" };
    getAdventureBank.mockResolvedValue({ ok: true, trips: [trip] });
    const { thread } = await mount([chatMessage(60, null, "recent")]); // no more history, and no round 2
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-bank")!.click();
    await flush();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-bank-trip")!.click();
    await flush();
    expect(thread.element.textContent).toContain("Couldn't open that trip");
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true); // nothing opened
    thread.teardown();
  });
});

describe("adventure: live trail, lock and wipe", () => {
  it("routes the stream's `adventure_live` frames to the game: the other person's finger shows on the open pane", async () => {
    createAdventure.mockResolvedValue({ ok: true, message: adventureMessage(9, "spin_lng", 1, "Rose") });
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 9 })));
    const { thread, frames } = await mount();
    startAdventure(thread);
    await flush();
    // The pane's frame loop runs through the window's requestAnimationFrame.
    const run = (): void => {
      const due = frames.splice(0);
      for (const cb of due) cb(performance.now());
    };
    run();
    const pane = thread.element.querySelector<HTMLElement>(".wx-srv-adv")!;
    expect(pane.getAttribute("data-phase")).toBe("idle");
    thread.handleStreamEvent({
      type: "adventure_live",
      frame: { anchorSeq: 9, clientId: "rose-drag-0001", axis: "lng", rotation: [30, -15], points: [[0.1, 0.1, 0]], frame: 0, end: false },
    });
    run();
    run();
    expect(pane.getAttribute("data-remote")).toBe("1");
    thread.teardown();
  });

  it("a lock closes the game and the bank and gives the chat back; the next unlock offers the round again", async () => {
    createAdventure.mockResolvedValue({ ok: true, message: adventureMessage(9) });
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 9 })));
    getAdventureBank.mockResolvedValue({ ok: true, trips: [] });
    const { thread } = await mount();
    startAdventure(thread);
    await flush();
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-bank")!.click();
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-bank-view")!.hidden).toBe(false);
    thread.detach();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-bank-view")!.hidden).toBe(true);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false);
    expect(thread.element.querySelector(".wx-srv-adv canvas")).toBeNull();
    // The next unlock: the chat's history still has the round, so its tab is offered again.
    getHistory.mockResolvedValue({ messages: [adventureMessage(9)], hasMore: false, cursor: 0 });
    await thread.attach(SESSION);
    await flush();
    expect(tabs(thread)).toEqual(["Chat", "Adventure Time game"]);
    thread.teardown();
  });

  it("a wipe forgets the rounds and the bank screen", async () => {
    createAdventure.mockResolvedValue({ ok: true, message: adventureMessage(9) });
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 9 })));
    const { thread } = await mount();
    startAdventure(thread);
    await flush();
    thread.handleStreamEvent({ type: "wiped" });
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    expect(thread.element.querySelector(".wx-srv-bubble-adv")).toBeNull();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false);
    thread.teardown();
  });

  it("deleting the round's message closes its tab", async () => {
    createAdventure.mockResolvedValue({ ok: true, message: adventureMessage(9) });
    getAdventure.mockResolvedValue(answer(view("spin_lng", { seq: 9 })));
    const { thread } = await mount();
    startAdventure(thread);
    await flush();
    thread.handleStreamEvent({ type: "message_deleted", seq: 9 });
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    thread.teardown();
  });
});

void decideAdventure;
void wire;
