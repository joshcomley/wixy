import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, SendMessageResult } from "../../src/server/api/messages";
import type { ServerIdentity } from "../../src/server/identity";
import { mountServerThread, type ServerThreadView } from "../../src/server/thread";
import type { LockHooks, ServerSession } from "../../src/server/types";
import { parseCookoutView, parseRecipeBook, type CookoutOutcome } from "../../src/server/cookout/api";
import { bankedRecipes, bookBody, finishedView, pickingView, type Json } from "./fixtures";
import { STYLE_COSY, setup } from "./twistFixtures";

// Cookout wired into the Server chat (spec 09 §5.1, §5.4): the ⋯ menu's Cookout and Recipe book, the start
// sheet, the card in the main chat, the game tab (one game at a time), the "Cookout" tag on the game's
// chat messages, the Recipe book's jump to a dish, and lock / wipe / delete.

const {
  getHistory,
  getUsage,
  sendMessage,
  createVoiceRecorder,
  getWyrRound,
  createCookout,
  getCookout,
  getRecipeBook,
} = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  sendMessage: vi.fn(),
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
  getWyrRound: vi.fn(),
  createCookout: vi.fn(),
  getCookout: vi.fn(),
  getRecipeBook: vi.fn(),
}));
vi.mock("../../src/server/recorder", () => ({ createVoiceRecorder }));
vi.mock("../../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/messages")>()),
  getHistory,
  getUsage,
  sendMessage,
}));
vi.mock("../../src/server/api/wyr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/wyr")>()),
  getWyrRound,
}));
vi.mock("../../src/server/cookout/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/cookout/api")>()),
  createCookout,
  getCookout,
  getRecipeBook,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function cookoutMessage(seq: number, patch: Json = {}, sender = "Josh"): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender,
    text: null,
    attachments: [],
    reactions: [],
    createdAt: Date.now() / 1000,
    replyTo: null,
    cookout: { state: "picking", blind: false, pickedCount: 0, concepts: "none", bankedCount: 0, rev: 1, ...patch },
  } as unknown as Message;
}

function chatMessage(seq: number, wyrRef: number | null, text: string, wyrRefKind?: string | null, sender = "Rose"): Message {
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
  } as unknown as Message;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function identity(): ServerIdentity {
  return { getName: () => "Josh", setName: vi.fn(), getDeviceId: () => "device-1234", isMine: (s: string) => s.toLowerCase() === "josh" };
}

function hooks(): LockHooks & { suspend: ReturnType<typeof vi.fn> } {
  return { suspend: vi.fn(() => () => {}), lockNow: vi.fn(), adoptBoundSession: vi.fn(), getBoundGrantId: vi.fn(() => null), suspendLive: vi.fn(() => ({ touch() {}, release() {} })), activityCount: vi.fn(() => 0) };
}

function win(): Window {
  return {
    crypto: { randomUUID: () => "ck-uuid-0001" },
    localStorage: window.localStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    navigator: window.navigator,
  } as unknown as Window;
}

async function mount(messages: Message[] = []): Promise<{ thread: ServerThreadView; hooks: ReturnType<typeof hooks> }> {
  getHistory.mockResolvedValue({ messages, hasMore: false, cursor: 0 });
  const h = hooks();
  const thread = mountServerThread({ identity: identity(), hooks: h, win: win(), onSettings: vi.fn() });
  document.body.appendChild(thread.element);
  await thread.attach(SESSION);
  await flush();
  return { thread, hooks: h };
}

function openMenu(thread: ServerThreadView): void {
  thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
}

function tabs(thread: ServerThreadView): string[] {
  return [...thread.element.querySelectorAll<HTMLButtonElement>(".wx-srv-tab")].filter((b) => !b.hidden).map((b) => b.getAttribute("aria-label") ?? "");
}

function answer(raw: Json): CookoutOutcome {
  const view = parseCookoutView(raw);
  if (view === null) throw new Error("fixture did not parse");
  return { ok: true, view };
}

/** Opens the start sheet from the menu and presses Start Cookout (in Blind mode if asked). */
async function startCookout(thread: ServerThreadView, blind = false): Promise<void> {
  openMenu(thread);
  thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-cookout")!.click();
  await flush(); // the twist options are read before Start is live
  if (blind) thread.element.querySelector<HTMLButtonElement>('.wx-srv-ck-mode[data-mode="blind"]')!.click();
  thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-start-go")!.click();
  await flush();
}

beforeEach(() => {
  for (const mock of [getHistory, getUsage, sendMessage, getWyrRound, createCookout, getCookout, getRecipeBook]) mock.mockReset();
  getUsage.mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
  getWyrRound.mockResolvedValue({ ok: false, kind: "unavailable" });
  getCookout.mockImplementation(async (_s: ServerSession, seq: number) => answer(pickingView({ seq, rev: 1 })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("cookout: the menu", () => {
  it("has Cookout and Recipe book with their one-line hints", async () => {
    const { thread } = await mount();
    const items = [...thread.element.querySelectorAll(".wx-srv-more-item")].map((i) => [
      i.querySelector(".wx-srv-more-item-title")?.textContent,
      i.querySelector(".wx-srv-more-item-hint")?.textContent,
    ]);
    expect(items.find((i) => i[0] === "Cookout")?.[1]).toBe("Pick 10 ingredients, see what the chef invents");
    expect(items.find((i) => i[0] === "Recipe book")?.[1]).toBe("Dishes you've banked together");
    thread.teardown();
  });
});

describe("cookout: starting a round", () => {
  it("the menu opens the start sheet; Start POSTs the round in the chosen mode, adds its card and opens the tab", async () => {
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9, { blind: true }) });
    getCookout.mockResolvedValue(answer(pickingView({ seq: 9, blind: true })));
    const { thread } = await mount();
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-cookout")!.click();
    await flush(); // the twist options are read before Start is live
    const sheet = thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!;
    expect(sheet.hidden).toBe(false);
    // Under the chat header, like the menu's other screens (jsdom lays nothing out: the header is 0 px).
    expect(sheet.style.top).toBe("0px");
    expect(createCookout).not.toHaveBeenCalled();
    thread.element.querySelector<HTMLButtonElement>('.wx-srv-ck-mode[data-mode="blind"]')!.click();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-start-go")!.click();
    await flush();
    expect(createCookout).toHaveBeenCalledWith(SESSION, { clientId: "ck-uuid-0001", sender: "Josh", deviceId: "device-1234", blind: true });
    expect(sheet.hidden).toBe(true);
    expect(tabs(thread)).toEqual(["Chat", "Cookout game"]);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck")!.hidden).toBe(false);
    expect(thread.element.querySelector(".wx-srv-bubble-ck .wx-srv-ck-mcard")).not.toBeNull();
    // Player 1 takes Turn 1 at once: the pair is on screen.
    expect(thread.element.querySelectorAll(".wx-srv-ck button.wx-srv-ck-card")).toHaveLength(2);
    expect(getCookout).toHaveBeenCalledWith(SESSION, 9, "Josh");
    thread.teardown();
  });

  it("the pane is in the chat only while its game is open: never a hidden second game pane", async () => {
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    const { thread } = await mount();
    expect(thread.element.querySelector(".wx-srv-ck")).toBeNull();
    expect(thread.element.querySelectorAll(".wx-srv-game")).toHaveLength(1); // the WYR pane only
    await startCookout(thread);
    expect(thread.element.querySelector(".wx-srv-ck")).not.toBeNull();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-close")!.click();
    expect(thread.element.querySelector(".wx-srv-ck")).toBeNull();
    thread.teardown();
  });

  it("explains in the sheet when the server cannot start one, and opens no tab", async () => {
    createCookout.mockResolvedValue({ ok: false, kind: "unsupported" });
    const { thread } = await mount();
    await startCookout(thread);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!.hidden).toBe(false);
    expect(thread.element.querySelector(".wx-srv-ck-start-error")!.textContent).toBe("Cookout isn't available yet — try again in a moment.");
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    thread.teardown();
  });

  it("starting Cookout while an Adventure or WYR tab is open replaces it (Chat + one game, ever)", async () => {
    getWyrRound.mockResolvedValue({ ok: false, kind: "unavailable" });
    const wyr = { seq: 4, clientId: "c4", sender: "Rose", text: null, attachments: [], reactions: [], createdAt: Date.now() / 1000, replyTo: null, wyr: { state: "voting", rev: 1 } } as unknown as Message;
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    const { thread } = await mount([wyr]);
    expect(tabs(thread)).toEqual(["Chat", "Would you rather game"]);
    await startCookout(thread);
    expect(tabs(thread)).toEqual(["Chat", "Cookout game"]);
    thread.teardown();
  });
});

describe("cookout: rounds in the thread", () => {
  it("a round someone else started is OFFERED (a dot) without taking over; the card opens it", async () => {
    const { thread } = await mount([cookoutMessage(9, {}, "Rose")]);
    expect(tabs(thread)).toEqual(["Chat", "Cookout game"]);
    expect(thread.element.querySelector(".wx-srv-tab-cookout .wx-srv-tab-dot:not([hidden])")).not.toBeNull();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck")!.hidden).toBe(true);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-mcard-open")!.click();
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck")!.hidden).toBe(false);
    thread.teardown();
  });

  it("a finished round with its dishes ready, or an ended one, is not offered", async () => {
    getCookout.mockImplementation(async (_s: ServerSession, seq: number) => answer(finishedView({ seq })));
    const { thread } = await mount([
      cookoutMessage(8, { state: "abandoned" }),
      cookoutMessage(9, { state: "finished", concepts: "ready", pickedCount: 10, rev: 12 }),
    ]);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    expect([...thread.element.querySelectorAll(".wx-srv-ck-mcard-status")].map((n) => n.textContent)).toEqual(["Ended", "3 dish ideas ready"]);
    thread.teardown();
  });

  it("a newer summary (message_updated) re-reads the view and redraws the card in place", async () => {
    const { thread } = await mount([cookoutMessage(9, { pickedCount: 1, rev: 2 })]);
    const card = thread.element.querySelector(".wx-srv-ck-mcard")!;
    expect(card.querySelector(".wx-srv-ck-mcard-status")!.textContent).toBe("Picking ingredients (1/10)…");
    getCookout.mockResolvedValue(answer(pickingView({ seq: 9, rev: 3, turn: 3 })));
    thread.handleStreamEvent({ type: "message_updated", message: cookoutMessage(9, { pickedCount: 2, rev: 3 }) });
    await flush();
    expect(getCookout).toHaveBeenLastCalledWith(SESSION, 9, "Josh");
    expect(thread.element.querySelector(".wx-srv-ck-mcard .wx-srv-ck-mcard-status")!.textContent).toBe("Picking ingredients (2/10)…");
    thread.teardown();
  });

  it("a message sent in the Cookout tab belongs to the round; its main-chat tag says Cookout", async () => {
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    sendMessage.mockResolvedValue({ ok: true, message: chatMessage(20, 9, "yum", "cookout", "Josh") } satisfies SendMessageResult);
    const { thread } = await mount([cookoutMessage(5), chatMessage(6, 5, "older server", undefined), chatMessage(7, 77, "far back", "cookout")]);
    const tag = (seq: number) => thread.element.querySelector<HTMLElement>(`.wx-srv-thread [data-message-seq="${seq}"] .wx-srv-bubble-gametag`);
    expect(tag(6)?.textContent).toBe("Cookout"); // the loaded anchor says so
    expect(tag(6)?.dataset["game"]).toBe("cookout");
    expect(tag(7)?.textContent).toBe("Cookout"); // the server's wyrRefKind says so
    await startCookout(thread);
    const textarea = thread.element.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "yum";
    thread.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!.click();
    await flush();
    expect(sendMessage.mock.calls[0]![1]).toMatchObject({ text: "yum", wyrSeq: 9 });
    thread.teardown();
  });
});

describe("cookout: the Recipe book", () => {
  it("the menu opens the book; a tap opens that round's dish with its full recipe", async () => {
    getRecipeBook.mockResolvedValue({ ok: true, recipes: parseRecipeBook(bookBody()) ?? [] });
    getCookout.mockResolvedValue(answer(finishedView({ seq: 41, recipes: bankedRecipes("a"), images: "done" })));
    const { thread } = await mount([cookoutMessage(41, { state: "finished", concepts: "ready", bankedCount: 1, rev: 12 })]);
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-recipes")!.click();
    await flush();
    const book = thread.element.querySelector<HTMLElement>(".wx-srv-ck-book-view")!;
    expect(book.hidden).toBe(false);
    expect(book.textContent).toContain("Espresso-Glazed Ribeye");
    book.querySelector<HTMLButtonElement>('.wx-srv-ck-book-entry[data-concept-id="a"]')!.click();
    await flush();
    expect(book.hidden).toBe(true);
    expect(tabs(thread)).toEqual(["Chat", "Cookout game"]);
    expect(thread.element.querySelector('.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-recipe')).not.toBeNull();
    thread.teardown();
  });

  it("says so when the dish's round cannot be found (it was deleted)", async () => {
    getRecipeBook.mockResolvedValue({ ok: true, recipes: parseRecipeBook(bookBody()) ?? [] });
    const { thread } = await mount([chatMessage(60, null, "recent")]);
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-recipes")!.click();
    await flush();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-book-entry")!.click();
    await flush();
    expect(thread.element.textContent).toContain("Couldn't open that recipe");
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    thread.teardown();
  });
});

describe("cookout: lock, wipe and delete", () => {
  it("a lock closes the game, the book and the start sheet, and gives the chat back", async () => {
    getRecipeBook.mockResolvedValue({ ok: true, recipes: [] });
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    const { thread } = await mount();
    await startCookout(thread);
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-recipes")!.click();
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-cookout")!.click();
    await flush(); // the twist options are read before Start is live
    thread.detach();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck-book-view")!.hidden).toBe(true);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!.hidden).toBe(true);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false);
    thread.teardown();
  });

  it("closing the tab keeps the played wheel; a lock forgets it, so the round's wheel lands once more", async () => {
    getCookout.mockImplementation(async (_s: ServerSession, seq: number) => answer({ ...finishedView({ seq }), setup: setup({ style: STYLE_COSY, styleSpun: true }) }));
    const { thread } = await mount([cookoutMessage(9, {}, "Rose")]);
    const openRound = async (): Promise<void> => {
      thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-mcard-open")!.click();
      await flush();
    };
    await openRound();
    expect(thread.element.querySelector(".wx-srv-ck-wheel")).not.toBeNull();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-close")!.click();
    await openRound();
    expect(thread.element.querySelector(".wx-srv-ck-wheel")).toBeNull();
    thread.detach();
    await thread.attach(SESSION);
    await flush();
    await openRound();
    expect(thread.element.querySelector(".wx-srv-ck-wheel")).not.toBeNull();
    thread.teardown();
  });

  it("a lock during the start (401) locks the chat", async () => {
    const { ServerLockedError } = await import("../../src/server/api/http");
    createCookout.mockRejectedValue(new ServerLockedError());
    const { thread, hooks: h } = await mount();
    await startCookout(thread);
    expect(h.lockNow).toHaveBeenCalledWith("unauthorized");
    thread.teardown();
  });

  it("a wipe forgets the rounds; deleting the round's message closes its tab", async () => {
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    const { thread } = await mount();
    await startCookout(thread);
    thread.handleStreamEvent({ type: "message_deleted", seq: 9 });
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    await startCookout(thread);
    thread.handleStreamEvent({ type: "wiped" });
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    expect(thread.element.querySelector(".wx-srv-bubble-ck")).toBeNull();
    thread.teardown();
  });

  it("the pane never asks to hold the idle lock off", async () => {
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    getCookout.mockResolvedValue(answer(finishedView({ seq: 9, concepts: "pending", images: "none" })));
    const { thread, hooks: h } = await mount();
    await startCookout(thread);
    expect(h.suspend).not.toHaveBeenCalled();
    thread.teardown();
  });
});

describe("cookout: game mode — full screen, the chat FAB, floating message and quick reply (decisions/00194)", () => {
  const fab = (thread: ServerThreadView) => thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck .wx-srv-float-fab")!;
  const bubble = (thread: ServerThreadView) => thread.element.querySelector<HTMLElement>(".wx-srv-ck .wx-srv-float-bubble")!;
  const quick = (thread: ServerThreadView) => thread.element.querySelector<HTMLElement>(".wx-srv-quick")!;
  function type(thread: ServerThreadView, text: string): void {
    const textarea = thread.element.querySelector<HTMLTextAreaElement>(".wx-srv-quick-composer textarea")!;
    textarea.value = text;
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-quick-composer .wx-chat-send-button")!.click();
  }

  it("the Cookout tab puts the thread in game mode; the overlay sits in a reserved chat row under the scrolling column", async () => {
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    const { thread } = await mount();
    await startCookout(thread);
    expect(thread.element.classList.contains("wx-srv-in-game")).toBe(true);
    expect(thread.element.querySelector(".wx-srv-ck > .wx-srv-ck-scroll + .wx-srv-game-chatrow > .wx-srv-float")).not.toBeNull();
    expect(fab(thread).getAttribute("aria-label")).toBe("Open this round's chat");
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!.click();
    expect(thread.element.classList.contains("wx-srv-in-game")).toBe(false);
    thread.teardown();
  });

  it("the partner's message in the round's chat floats and dots the FAB; its quick reply sends into the round", async () => {
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    sendMessage.mockResolvedValue({ ok: true, message: chatMessage(31, 9, "on it", "cookout", "Josh") } satisfies SendMessageResult);
    const { thread } = await mount();
    await startCookout(thread);
    thread.handleStreamEvent({ type: "message", message: chatMessage(30, 9, "more chilli?", "cookout", "Rose") });
    expect(bubble(thread).hidden).toBe(false);
    expect(bubble(thread).textContent).toContain("more chilli?");
    expect(fab(thread).getAttribute("aria-label")).toContain("new message");
    bubble(thread).querySelector<HTMLButtonElement>(".wx-srv-float-open")!.click();
    expect(quick(thread).hidden).toBe(false);
    type(thread, "on it");
    await flush();
    expect(sendMessage.mock.calls[0]![1]).toMatchObject({ text: "on it", wyrSeq: 9 });
    expect(quick(thread).hidden).toBe(true);
    thread.teardown();
  });

  it("the FAB opens the round's pop-up chat titled Cookout chat", async () => {
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    const { thread } = await mount();
    await startCookout(thread);
    fab(thread).click();
    const popup = thread.element.querySelector<HTMLElement>(".wx-srv-gamepop")!;
    expect(popup.hidden).toBe(false);
    expect(popup.textContent).toContain("Cookout chat");
    thread.teardown();
  });
});
