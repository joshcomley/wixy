import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, SendMessageResult } from "../../src/server/api/messages";
import type { ServerIdentity } from "../../src/server/identity";
import { mountServerThread, type ServerThreadView } from "../../src/server/thread";
import type { LockHooks, ServerSession } from "../../src/server/types";
import { parseCookoutView, parseRecipeBook, type CookoutOutcome } from "../../src/server/cookout/api";
import { bankedRecipes, bookBody, finishedView, pickingView, type Json } from "./fixtures";
import { STYLE_COSY, setup } from "./twistFixtures";
import { SOURDOUGH, classicOptionWire, optionsBody, toastieFinished, toastiePicking } from "./modeFixtures";

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

  it("a lost answer whose round the stream already brought opens that round, with no error and no second request", async () => {
    // The request timed out after the server made the round; the stream's copy arrived first.
    createCookout.mockImplementation(async () => {
      thread.handleStreamEvent({ type: "message", message: { ...cookoutMessage(9), clientId: "ck-uuid-0001" } });
      return { ok: false, kind: "lost" };
    });
    const { thread } = await mount();
    await startCookout(thread);
    expect(createCookout).toHaveBeenCalledTimes(1);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!.hidden).toBe(true);
    expect(tabs(thread)).toEqual(["Chat", "Cookout game"]);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck")!.hidden).toBe(false);
    thread.teardown();
  });

  it("a lost answer is asked again with the same clientId, and the replay's round opens", async () => {
    createCookout.mockResolvedValueOnce({ ok: false, kind: "lost" }).mockResolvedValueOnce({ ok: true, message: cookoutMessage(9) });
    const { thread } = await mount();
    await startCookout(thread);
    expect(createCookout).toHaveBeenCalledTimes(2);
    expect(createCookout.mock.calls[1]![1]).toEqual(createCookout.mock.calls[0]![1]);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!.hidden).toBe(true);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck")!.hidden).toBe(false);
    thread.teardown();
  });

  it("when the replay is lost too the sheet says so, and the round arriving later still opens it", async () => {
    createCookout.mockResolvedValue({ ok: false, kind: "lost" });
    const { thread } = await mount();
    await startCookout(thread);
    expect(createCookout).toHaveBeenCalledTimes(2);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!.hidden).toBe(false);
    expect(thread.element.querySelector(".wx-srv-ck-start-error")!.textContent).toBe("Couldn't start a Cookout — try again.");
    // The round this start made arrives on the stream: the sheet closes and the starter lands in it.
    thread.handleStreamEvent({ type: "message", message: { ...cookoutMessage(9), clientId: "ck-uuid-0001" } });
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!.hidden).toBe(true);
    expect(tabs(thread)).toEqual(["Chat", "Cookout game"]);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck")!.hidden).toBe(false);
    thread.teardown();
  });

  it("someone else's round arriving after a lost start is only offered, not opened over the sheet", async () => {
    createCookout.mockResolvedValue({ ok: false, kind: "lost" });
    const { thread } = await mount();
    await startCookout(thread);
    thread.handleStreamEvent({ type: "message", message: cookoutMessage(9, {}, "Rose") });
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!.hidden).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck")!.hidden).toBe(true);
    thread.teardown();
  });

  it("a real refusal is not asked again (only a lost answer is)", async () => {
    createCookout.mockResolvedValue({ ok: false, kind: "unavailable" });
    const { thread } = await mount();
    await startCookout(thread);
    expect(createCookout).toHaveBeenCalledTimes(1);
    expect(thread.element.querySelector(".wx-srv-ck-start-error")!.textContent).toBe("Couldn't start a Cookout — try again.");
    // Nor does a round that turns up later take over: the refusal made none.
    thread.handleStreamEvent({ type: "message", message: { ...cookoutMessage(9), clientId: "ck-uuid-0001" } });
    await flush();
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!.hidden).toBe(false);
    thread.teardown();
  });

  it("a lost start's round landing after the sheet was closed and opened again leaves the new sheet alone", async () => {
    createCookout.mockResolvedValue({ ok: false, kind: "lost" });
    const { thread } = await mount();
    await startCookout(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-start-cancel")!.click();
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-cookout")!.click();
    await flush();
    const sheet = thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!;
    expect(sheet.hidden).toBe(false);
    thread.handleStreamEvent({ type: "message", message: { ...cookoutMessage(9), clientId: "ck-uuid-0001" } });
    await flush();
    expect(sheet.hidden).toBe(false);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck")?.hidden ?? true).toBe(true);
    thread.teardown();
  });

  it("a lost start's round landing while a new start is in flight does not close the sheet under it", async () => {
    createCookout.mockResolvedValueOnce({ ok: false, kind: "lost" }).mockResolvedValueOnce({ ok: false, kind: "lost" });
    const { thread } = await mount();
    await startCookout(thread);
    // A different choice is a different start (a new clientId); its answer is still on its way.
    let answerSecond: (value: unknown) => void = () => {};
    createCookout.mockImplementationOnce(() => new Promise((resolve) => (answerSecond = resolve)));
    thread.element.querySelector<HTMLButtonElement>('.wx-srv-ck-mode[data-mode="blind"]')!.click();
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-start-go")!.click();
    await flush();
    const sheet = thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!;
    thread.handleStreamEvent({ type: "message", message: { ...cookoutMessage(9), clientId: "ck-uuid-0001" } });
    await flush();
    expect(sheet.hidden).toBe(false);
    answerSecond({ ok: true, message: cookoutMessage(10, { blind: true }) });
    await flush();
    expect(sheet.hidden).toBe(true);
    expect(thread.element.querySelector<HTMLElement>(".wx-srv-ck")!.hidden).toBe(false);
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

// -- Game modes (spec/server-chat/09c-cookout-modes.md §5.4, §6.1) ---------------------------------------------
// The thread reads the REAL options and ingredient-search requests here (only `fetch` is stubbed), so the
// requests' URLs are the ones the server would see.

describe("cookout: game modes", () => {
  interface Wire {
    optionsReads: number;
    ingredientUrls: string[];
  }

  /** Stubs `fetch`: `/cookout/options` answers `options()`, `/cookout/ingredients` answers a bread; nothing else is reachable. */
  function stubFetch(options: () => Json): Wire {
    const wire: Wire = { optionsReads: 0, ingredientUrls: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/cookout/options")) {
          wire.optionsReads += 1;
          return new Response(JSON.stringify(options()), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/cookout/ingredients")) {
          wire.ingredientUrls.push(url);
          return new Response(JSON.stringify({ ingredients: [SOURDOUGH] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new TypeError("offline");
      }),
    );
    return wire;
  }

  async function openSheet(thread: ServerThreadView): Promise<HTMLElement> {
    openMenu(thread);
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-more-cookout")!.click();
    await flush();
    await flush();
    return thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!;
  }

  const tileOf = (sheet: HTMLElement, id: string): HTMLButtonElement | null => sheet.querySelector<HTMLButtonElement>(`.wx-srv-ck-mtile[data-mode-id="${id}"]`);
  const goOf = (sheet: HTMLElement): HTMLButtonElement => sheet.querySelector<HTMLButtonElement>(".wx-srv-ck-start-go")!;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a Classic start sends no `mode` at all, even when the server lists the other game", async () => {
    stubFetch(() => optionsBody());
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    const { thread } = await mount();
    const sheet = await openSheet(thread);
    expect(tileOf(sheet, "classic")?.getAttribute("aria-checked")).toBe("true");
    goOf(sheet).click();
    await flush();
    expect(createCookout).toHaveBeenCalledTimes(1);
    const body = createCookout.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["blind", "clientId", "deviceId", "sender"]);
    expect(body).toEqual({ clientId: "ck-uuid-0001", sender: "Josh", deviceId: "device-1234", blind: false });
    thread.teardown();
  });

  it("with Classic the only listed game there are no tiles and the start is the same core request", async () => {
    stubFetch(() => optionsBody([classicOptionWire()]));
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    const { thread } = await mount();
    const sheet = await openSheet(thread);
    expect(sheet.querySelectorAll(".wx-srv-ck-mtile")).toHaveLength(0);
    expect(sheet.querySelector<HTMLElement>(".wx-srv-ck-start-what")!.hidden).toBe(true);
    goOf(sheet).click();
    await flush();
    expect(createCookout.mock.calls[0]![1]).toEqual({ clientId: "ck-uuid-0001", sender: "Josh", deviceId: "device-1234", blind: false });
    thread.teardown();
  });

  it("choosing the Toasted sandwich tile starts the round with mode \"toastie\", and the card and tab follow", async () => {
    stubFetch(() => optionsBody());
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9, { mode: "toastie" }) });
    getCookout.mockResolvedValue(answer(toastiePicking({ seq: 9 })));
    const { thread } = await mount();
    const sheet = await openSheet(thread);
    tileOf(sheet, "toastie")!.click();
    goOf(sheet).click();
    await flush();
    expect(createCookout).toHaveBeenCalledWith(SESSION, { clientId: "ck-uuid-0001", sender: "Josh", deviceId: "device-1234", blind: false, mode: "toastie" });
    expect(sheet.hidden).toBe(true);
    expect(tabs(thread)).toEqual(["Chat", "Cookout game"]);
    await flush();
    expect(thread.element.querySelector(".wx-srv-ck-turn")?.textContent).toBe("Your turn — pick the bread");
    expect(thread.element.querySelector(".wx-srv-ck-mcard-mode")?.textContent).toBe("Toasted sandwich");
    expect(thread.element.querySelector(".wx-srv-ck-mcard-status")?.textContent).toBe("Picking ingredients (0/8)…");
    thread.teardown();
  });

  it("the mode rides along with Blind and the chosen twists", async () => {
    stubFetch(() => optionsBody());
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9, { mode: "toastie", blind: true }) });
    getCookout.mockResolvedValue(answer(toastiePicking({ seq: 9, blind: true })));
    const { thread } = await mount();
    const sheet = await openSheet(thread);
    tileOf(sheet, "toastie")!.click();
    sheet.querySelector<HTMLButtonElement>('.wx-srv-ck-mode[data-mode="blind"]')!.click();
    sheet.querySelector<HTMLButtonElement>(".wx-srv-ck-twist-stars")!.click();
    goOf(sheet).click();
    await flush();
    expect(createCookout.mock.calls[0]![1]).toMatchObject({ blind: true, stars: true, mode: "toastie" });
    thread.teardown();
  });

  it("a 503 on a toastie start says \"That game isn't available right now\", drops the tile, and the next options read hits the server again", async () => {
    let listed = true;
    const wire = stubFetch(() => optionsBody(listed ? undefined : [classicOptionWire()]));
    createCookout.mockResolvedValue({ ok: false, kind: "game_unavailable" });
    const { thread } = await mount();
    const sheet = await openSheet(thread);
    expect(wire.optionsReads).toBe(1);
    tileOf(sheet, "toastie")!.click();
    listed = false; // the operator switched the mode off meanwhile
    goOf(sheet).click();
    await flush();
    await flush();
    expect(sheet.hidden).toBe(false);
    expect(sheet.querySelector(".wx-srv-ck-start-error")!.textContent).toBe("That game isn't available right now");
    expect(tabs(thread)).not.toContain("Cookout game");
    // The cached options were cleared and read again, so the gone mode's tile is gone and Classic is chosen.
    expect(wire.optionsReads).toBe(2);
    expect(sheet.querySelectorAll(".wx-srv-ck-mtile")).toHaveLength(0);
    // A later open reads them from the cache of that second read (and the third open would too).
    sheet.querySelector<HTMLButtonElement>(".wx-srv-ck-start-cancel")!.click();
    await openSheet(thread);
    expect(wire.optionsReads).toBe(2);
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9) });
    goOf(sheet).click();
    await flush();
    expect(createCookout.mock.calls[1]![1]).not.toHaveProperty("mode");
    thread.teardown();
  });

  it("the cached options are dropped by a toastie 503 even when the re-read is what shows the new list", async () => {
    const wire = stubFetch(() => optionsBody());
    createCookout.mockResolvedValue({ ok: false, kind: "game_unavailable" });
    const { thread } = await mount();
    const sheet = await openSheet(thread);
    tileOf(sheet, "toastie")!.click();
    goOf(sheet).click();
    await flush();
    await flush();
    // Still listed on the second read: the tile stays, the message stays, and a retry is possible.
    expect(wire.optionsReads).toBe(2);
    expect(sheet.querySelector(".wx-srv-ck-start-error")!.textContent).toBe("That game isn't available right now");
    expect(tileOf(sheet, "toastie")?.getAttribute("aria-checked")).toBe("true");
    thread.teardown();
  });

  it("a 503 on a Classic start keeps its own words and does not re-read the options", async () => {
    const wire = stubFetch(() => optionsBody());
    createCookout.mockResolvedValue({ ok: false, kind: "game_unavailable" });
    const { thread } = await mount();
    const sheet = await openSheet(thread);
    goOf(sheet).click();
    await flush();
    await flush();
    expect(sheet.querySelector(".wx-srv-ck-start-error")!.textContent).toBe("Cookout isn't available on this server right now.");
    expect(wire.optionsReads).toBe(1);
    thread.teardown();
  });

  it("the fridge raid in Toasted sandwich mode searches /cookout/ingredients?q=…&mode=toastie; Classic asks without a mode", async () => {
    const wire = stubFetch(() => optionsBody());
    const { thread } = await mount();
    const sheet = await openSheet(thread);
    sheet.querySelector<HTMLButtonElement>(".wx-srv-ck-twists-toggle")!.click();
    const type = (text: string): void => {
      const input = sheet.querySelector<HTMLInputElement>(".wx-srv-ck-fridge-input")!;
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // Classic first: no mode parameter.
    type("sour");
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flush();
    expect(wire.ingredientUrls).toHaveLength(1);
    expect(wire.ingredientUrls[0]).toMatch(/\/cookout\/ingredients\?q=sour$/);
    tileOf(sheet, "toastie")!.click();
    type("sour");
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flush();
    expect(wire.ingredientUrls).toHaveLength(2);
    expect(wire.ingredientUrls[1]).toMatch(/\/cookout\/ingredients\?q=sour&mode=toastie$/);
    expect([...sheet.querySelectorAll<HTMLElement>(".wx-srv-ck-fridge-option")].map((o) => o.dataset["ingredient"])).toEqual(["sourdough-loaf"]);
    sheet.querySelector<HTMLButtonElement>('.wx-srv-ck-fridge-option[data-ingredient="sourdough-loaf"]')!.click();
    createCookout.mockResolvedValue({ ok: true, message: cookoutMessage(9, { mode: "toastie" }) });
    getCookout.mockResolvedValue(answer(toastiePicking({ seq: 9 })));
    goOf(sheet).click();
    await flush();
    expect(createCookout.mock.calls[0]![1]).toMatchObject({ mode: "toastie", fridgeSeedId: "sourdough-loaf" });
    thread.teardown();
  });

  it("\"New\" in a toasted sandwich round preselects that mode; a toastie message's card is badged in the thread", async () => {
    stubFetch(() => optionsBody());
    getCookout.mockResolvedValue(answer(toastieFinished({ seq: 9, images: "done" })));
    const { thread } = await mount([cookoutMessage(9, { mode: "toastie", state: "finished", concepts: "ready", pickedCount: 8, rev: 12 })]);
    await flush();
    expect(thread.element.querySelector(".wx-srv-ck-mcard-status")!.textContent).toBe("3 toasted sandwich ideas ready");
    expect(thread.element.querySelector(".wx-srv-ck-mcard-mode")!.textContent).toBe("Toasted sandwich");
    thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-mcard-open")!.click();
    await flush();
    const newButton = thread.element.querySelector<HTMLButtonElement>(".wx-srv-ck-new")!;
    expect(newButton.hidden).toBe(false);
    newButton.click();
    await flush();
    await flush();
    const sheet = thread.element.querySelector<HTMLElement>(".wx-srv-ck-start")!;
    expect(sheet.hidden).toBe(false);
    expect(tileOf(sheet, "toastie")?.getAttribute("aria-checked")).toBe("true");
    thread.teardown();
  });
});


describe("cookout: a mode card's numbers from the options", () => {
  let reads = 0;
  let release: (response: Response) => void = () => {};

  /** `/cookout/options` waits for `release`; counts the reads. */
  function stubOptions(status = 200): void {
    reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/cookout/options")) {
          reads += 1;
          return new Promise<Response>((resolve) => {
            release = (response) => resolve(response);
            void status;
          });
        }
        throw new TypeError("offline");
      }),
    );
  }

  const ok = (body: Json): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const statusLine = (thread: ServerThreadView): string | undefined => thread.element.querySelector(".wx-srv-ck-mcard-status")?.textContent ?? undefined;

  beforeEach(() => {
    getCookout.mockImplementation(async () => ({ ok: false, kind: "unavailable" }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes exactly one options read however many renders and frames happen while it is in flight, then shows (n/8)", async () => {
    stubOptions();
    const { thread } = await mount([cookoutMessage(9, { mode: "toastie", pickedCount: 3, rev: 2 })]);
    expect(reads).toBe(1);
    expect(statusLine(thread)).toBe("Picking ingredients…");
    for (let n = 4; n <= 6; n += 1) {
      thread.handleStreamEvent({ type: "message_updated", message: cookoutMessage(9, { mode: "toastie", pickedCount: n, rev: n }) });
      await flush();
    }
    expect(reads).toBe(1);
    expect(statusLine(thread)).toBe("Picking ingredients…");
    release(ok(optionsBody()));
    await flush();
    await flush();
    expect(reads).toBe(1);
    expect(statusLine(thread)).toBe("Picking ingredients (6/8)…");
    thread.teardown();
  });

  it("a Classic-only thread makes no options read for its card", async () => {
    stubOptions();
    const { thread } = await mount([cookoutMessage(9, { pickedCount: 3 })]);
    thread.handleStreamEvent({ type: "message_updated", message: cookoutMessage(9, { pickedCount: 4, rev: 3 }) });
    await flush();
    expect(reads).toBe(0);
    expect(statusLine(thread)).toBe("Picking ingredients (4/10)…");
    thread.teardown();
  });

  it("a failed read is not retried by the card within the same unlock", async () => {
    stubOptions();
    const { thread } = await mount([cookoutMessage(9, { mode: "toastie", pickedCount: 3, rev: 2 })]);
    release(new Response("{}", { status: 500 }));
    await flush();
    await flush();
    expect(reads).toBe(1);
    for (let n = 4; n <= 6; n += 1) {
      thread.handleStreamEvent({ type: "message_updated", message: cookoutMessage(9, { mode: "toastie", pickedCount: n, rev: n }) });
      await flush();
    }
    expect(reads).toBe(1);
    expect(statusLine(thread)).toBe("Picking ingredients…");
    thread.teardown();
  });
});
