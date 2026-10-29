// How the Server chat thread triggers the good-night scene (spec/server-chat/goodnight-scene.md,
// "Trigger"): only when Bubble says good night - on her own screen as she sends it and on the
// other person's as it arrives live. Never when anyone else says it, and never a system row, an
// update, a history load, a stale message (reconnect catch-up) or inside the 10-minute cool-down.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPage, Message } from "../../src/server/api/messages";
import type { ServerIdentity } from "../../src/server/identity";
import { resetGoodnightCooldown } from "../../src/server/goodnight";
import { mountServerThread, type ServerThreadView } from "../../src/server/thread";
import type { LockHooks, ServerSession } from "../../src/server/types";
import { stubCanvas, type CanvasStub } from "./goodnightHelpers";

const { getHistory, getUsage, getDrawings, sendMessage } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  getDrawings: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("../../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/messages")>()),
  getHistory,
  getUsage,
  sendMessage,
}));
vi.mock("../../src/server/api/drawings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/drawings")>()),
  getDrawings,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function identity(name: string): ServerIdentity {
  return {
    getName: () => name,
    setName: vi.fn(),
    getDeviceId: () => "device-1",
    isMine: (sender) => sender.toLowerCase() === name.toLowerCase(),
  };
}

function makeHooks(): LockHooks & { suspend: ReturnType<typeof vi.fn> } {
  return {
    suspend: vi.fn(() => () => {}),
    lockNow: vi.fn(),
    adoptBoundSession: vi.fn(),
    getBoundGrantId: vi.fn(() => null), suspendLive: vi.fn(() => ({ touch() {}, release() {} })), activityCount: vi.fn(() => 0),
  };
}

function win(): Window {
  return {
    crypto: { randomUUID: () => "uuid-1" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  } as unknown as Window;
}

function message(seq: number, text: string | null, sender = "Bubble", ageS = 0): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender,
    text,
    attachments: [],
    reactions: [],
    createdAt: Date.now() / 1000 - ageS,
    replyTo: null,
  };
}

function page(messages: Message[]): HistoryPage {
  return { messages, hasMore: false, cursor: 10 };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

let stub: CanvasStub;
let hooks: ReturnType<typeof makeHooks>;
let view: ServerThreadView;

const scene = (): HTMLCanvasElement | null => document.body.querySelector(":scope > canvas.wx-srv-goodnight-canvas");

/** Mounted as Cupcake (the other person) unless told otherwise. */
async function mount(history: Message[] = [], me = "Cupcake"): Promise<void> {
  getHistory.mockResolvedValue(page(history));
  hooks = makeHooks();
  view = mountServerThread({ identity: identity(me), hooks, win: win(), onSettings: vi.fn() });
  document.body.appendChild(view.element);
  await view.attach(SESSION);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  stub = stubCanvas();
  resetGoodnightCooldown();
  getHistory.mockReset();
  getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 1, freeBytes: 1, erasurePending: false });
  getDrawings.mockReset().mockResolvedValue([]);
  sendMessage.mockReset();
});

async function sendAs(me: string, text: string): Promise<void> {
  sendMessage.mockResolvedValue({ ok: true, message: message(50, text, me) });
  const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.value = text;
  view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
  await flush();
}

afterEach(() => {
  view.teardown();
  stub.restore();
  vi.useRealTimers();
});

describe("good-night trigger", () => {
  it("fires when Bubble's good night arrives live, and suspends the idle lock", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "ok good night x") });
    expect(scene()).not.toBeNull();
    expect(hooks.suspend).toHaveBeenCalledWith("goodnight");
    expect(view.element.classList.contains("wx-srv-gn-hidden")).toBe(true);
  });

  it("does not fire on ordinary messages", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "see you tonight") });
    view.handleStreamEvent({ type: "message", message: message(2, null) });
    expect(scene()).toBeNull();
  });

  it("fires on Bubble's own screen when she sends good night", async () => {
    await mount([], "Bubble");
    await sendAs("Bubble", "night night x");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(scene()).not.toBeNull();
  });

  it("plays once when her own good night also comes back over the stream", async () => {
    await mount([], "Bubble");
    await sendAs("Bubble", "good night");
    view.handleStreamEvent({ type: "message", message: message(50, "good night", "Bubble") });
    expect(document.querySelectorAll("canvas.wx-srv-goodnight-canvas")).toHaveLength(1);
  });

  it("matches her name case-insensitively", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "good night", " bubble ") });
    expect(scene()).not.toBeNull();
  });

  it("never fires when Cupcake says good night, on either screen", async () => {
    await mount([], "Bubble"); // her screen, his message arriving
    view.handleStreamEvent({ type: "message", message: message(1, "good night", "Cupcake") });
    expect(scene()).toBeNull();
    view.teardown();
    await mount([], "Cupcake"); // his own screen, as he sends it
    await sendAs("Cupcake", "good night");
    view.handleStreamEvent({ type: "message", message: message(50, "good night", "Cupcake") });
    expect(scene()).toBeNull();
  });

  it("never fires for anyone else's good night", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "good night", "Somebody") });
    expect(scene()).toBeNull();
  });

  it("does not fire on a system row", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "good night", "") });
    expect(scene()).toBeNull();
  });

  it("does not fire on an update to a message", async () => {
    await mount();
    view.handleStreamEvent({ type: "message_updated", message: message(1, "good night") });
    expect(scene()).toBeNull();
    // ...nor an update to one already on screen
    view.handleStreamEvent({ type: "message", message: message(2, "hello") });
    view.handleStreamEvent({ type: "message_updated", message: message(2, "good night") });
    expect(scene()).toBeNull();
  });

  it("does not fire on history load", async () => {
    await mount([message(1, "good night")]);
    expect(scene()).toBeNull();
  });

  it("does not fire on an old message (a reconnect catching up)", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "good night", "Bubble", 121) });
    expect(scene()).toBeNull();
    view.handleStreamEvent({ type: "message", message: message(2, "good night", "Bubble", 100) });
    expect(scene()).not.toBeNull();
  });

  it("fires at most once per 10 minutes per tab", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "good night") });
    expect(scene()).not.toBeNull();
    view.detach(); // a lock removes the scene...
    expect(document.querySelector("canvas")).toBeNull();
    vi.advanceTimersByTime(9 * 60_000);
    view.handleStreamEvent({ type: "message", message: message(2, "night night") });
    expect(scene()).toBeNull(); // ...but the cool-down is still running
    vi.advanceTimersByTime(61_000);
    view.handleStreamEvent({ type: "message", message: message(3, "goodnight") });
    expect(scene()).not.toBeNull();
  });

  it("does nothing while the stars are already showing", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "good night") });
    const first = scene();
    vi.advanceTimersByTime(11 * 60_000);
    view.handleStreamEvent({ type: "message", message: message(2, "good night") });
    expect(document.querySelectorAll("canvas.wx-srv-goodnight-canvas")).toHaveLength(1);
    expect(scene()).toBe(first === null ? null : scene());
  });
});

describe("good-night teardown", () => {
  it("removes the scene on detach (lock) and releases the idle suspension", async () => {
    const release = vi.fn();
    await mount();
    hooks.suspend.mockImplementation(() => release);
    view.handleStreamEvent({ type: "message", message: message(1, "good night") });
    expect(scene()).not.toBeNull();
    view.detach();
    expect(document.querySelector("canvas")).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
    expect(view.element.classList.contains("wx-srv-gn-hidden")).toBe(false);
  });

  it("removes the background starfield on detach", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "good night") });
    scene()!.click(); // skip to background mode
    expect(view.element.querySelector(".wx-srv-thread-wrap > .wx-srv-goodnight-bg")).not.toBeNull();
    view.detach();
    expect(view.element.querySelector(".wx-srv-goodnight-bg")).toBeNull();
    expect(view.element.querySelector(".wx-srv-thread-wrap")!.classList.contains("wx-srv-gn-bg")).toBe(false);
  });

  it("removes everything on teardown", async () => {
    await mount();
    view.handleStreamEvent({ type: "message", message: message(1, "good night") });
    view.teardown();
    expect(document.querySelector("canvas")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
