import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/server/api/messages";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerThread } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";

const { getHistory, getUsage, sendCanvasMessage } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  sendCanvasMessage: vi.fn(),
}));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
  sendCanvasMessage,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

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
    getBoundGrantId: vi.fn(() => null), suspendLive: vi.fn(() => ({ touch() {}, release() {} })), activityCount: vi.fn(() => 0),
  };
}

function win(): Window {
  return {
    crypto: { randomUUID: () => "canvas-uuid-0001" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  } as unknown as Window;
}

function canvasMessage(seq: number, sender = "Josh"): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender,
    text: null,
    attachments: [],
    reactions: [],
    createdAt: Date.now() / 1000,
    replyTo: null,
    canvas: true,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function mount(history: Message[] = []) {
  getHistory.mockResolvedValue({ messages: history, hasMore: false, cursor: 0 });
  const h = hooks();
  const view = mountServerThread({ identity: identity(), hooks: h, win: win(), onSettings: vi.fn() });
  document.body.appendChild(view.element);
  await view.attach(SESSION);
  await flush();
  return { view, hooks: h };
}

beforeEach(() => {
  getHistory.mockReset();
  getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
  sendCanvasMessage.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("header ... menu and canvas", () => {
  it("opens a menu from the ellipsis button and closes it on an outside tap", async () => {
    const { view } = await mount();
    const button = view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!;
    const menu = view.element.querySelector<HTMLElement>(".wx-srv-more-menu")!;
    expect(menu.hidden).toBe(true);
    button.click();
    expect(menu.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(menu.textContent).toContain("Canvas");

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    view.teardown();
  });

  it("Canvas sends a canvas message and renders it as a blank drawing surface", async () => {
    sendCanvasMessage.mockResolvedValue({ ok: true, message: canvasMessage(5) });
    const { view } = await mount();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-canvas")!.click();
    await flush();

    expect(sendCanvasMessage).toHaveBeenCalledWith(SESSION, {
      clientId: "canvas-uuid-0001",
      sender: "Josh",
      deviceId: "device-1234",
    });
    expect(view.element.querySelector<HTMLElement>(".wx-srv-more-menu")!.hidden).toBe(true);
    const bubble = view.element.querySelector<HTMLElement>('[data-message-seq="5"]')!;
    expect(bubble.classList.contains("wx-srv-bubble-canvas")).toBe(true);
    expect(bubble.querySelector(".wx-srv-canvas-surface")).not.toBeNull();
    view.teardown();
  });

  it("shows an error when the server cannot add one", async () => {
    sendCanvasMessage.mockResolvedValue({ ok: false, kind: "unavailable" });
    const { view } = await mount();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-canvas")!.click();
    await flush();
    expect(view.element.textContent).toContain("Couldn’t add a canvas".replace("’", "'"));
    expect(view.element.querySelector(".wx-srv-canvas-surface")).toBeNull();
    view.teardown();
  });
});

/** The visible tab labels, in order. */
function tabs(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll<HTMLButtonElement>(".wx-srv-tab:not([hidden])")).map(
    (tab) => tab.getAttribute("aria-label") ?? "",
  );
}

function canvasTabShowing(element: HTMLElement): boolean {
  const pane = element.querySelector<HTMLElement>(".wx-srv-canvas-pane");
  return (
    element.querySelector(".wx-srv-tab-canvas")?.getAttribute("aria-selected") === "true" &&
    pane !== null &&
    pane.isConnected &&
    !pane.hidden &&
    element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden === true
  );
}

describe("the Canvas tab (decisions/00206)", () => {
  it("a new canvas opens in the Canvas tab, full screen, with the pen on; the chat keeps it with an Open button", async () => {
    sendCanvasMessage.mockResolvedValue({ ok: true, message: canvasMessage(5) });
    const { view } = await mount();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-canvas")!.click();
    await flush();

    expect(canvasTabShowing(view.element)).toBe(true);
    expect(tabs(view.element)).toEqual(["Chat", "Canvas"]);
    const pane = view.element.querySelector<HTMLElement>(".wx-srv-canvas-pane")!;
    expect(pane.querySelector(".wx-srv-canvas-title")!.textContent).toBe("Your canvas");
    expect(pane.querySelector<HTMLElement>(".wx-srv-pen-toolbar")!.hidden).toBe(false);
    expect(pane.querySelector(".wx-srv-canvas-frame .wx-srv-draw-surface")).not.toBeNull();
    // The thread's own pen is not on.
    expect(view.element.querySelector(".wx-srv-thread-wrap > .wx-srv-draw-surface")).toBeNull();
    const open = view.element.querySelector<HTMLButtonElement>('[data-message-seq="5"] .wx-srv-canvas-open')!;
    expect(open.textContent).toBe("Open");
    expect(open.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    view.teardown();
  });

  it("the FAB goes back to the chat (the pen session ends); Open brings the canvas back", async () => {
    sendCanvasMessage.mockResolvedValue({ ok: true, message: canvasMessage(5) });
    const { view } = await mount();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-canvas")!.click();
    await flush();
    const pane = view.element.querySelector<HTMLElement>(".wx-srv-canvas-pane")!;
    pane.querySelector<HTMLButtonElement>(".wx-srv-float-fab")!.click();
    expect(canvasTabShowing(view.element)).toBe(false);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false);
    expect(pane.querySelector<HTMLElement>(".wx-srv-pen-toolbar")!.hidden).toBe(true);
    // The tab stays (it is still open), Chat is the one showing.
    expect(tabs(view.element)).toEqual(["Chat", "Canvas"]);

    view.element.querySelector<HTMLButtonElement>('[data-message-seq="5"] .wx-srv-canvas-open')!.click();
    expect(canvasTabShowing(view.element)).toBe(true);
    expect(pane.querySelector<HTMLElement>(".wx-srv-pen-toolbar")!.hidden).toBe(false);
    view.teardown();
  });

  it("Open on an older canvas shows that one instead; the other person's canvas is named for them", async () => {
    const { view } = await mount([canvasMessage(3, "Purdy"), canvasMessage(4)]);
    view.element.querySelector<HTMLButtonElement>('[data-message-seq="4"] .wx-srv-canvas-open')!.click();
    const pane = view.element.querySelector<HTMLElement>(".wx-srv-canvas-pane")!;
    expect(pane.querySelector(".wx-srv-canvas-title")!.textContent).toBe("Your canvas");
    pane.querySelector<HTMLButtonElement>(".wx-srv-float-fab")!.click();
    view.element.querySelector<HTMLButtonElement>('[data-message-seq="3"] .wx-srv-canvas-open')!.click();
    expect(canvasTabShowing(view.element)).toBe(true);
    expect(pane.querySelector(".wx-srv-canvas-title")!.textContent).toBe("Purdy's canvas");
    expect(tabs(view.element)).toEqual(["Chat", "Canvas"]);
    view.teardown();
  });

  it("canvases already in the chat at unlock are not offered; one started elsewhere later is offered with a dot", async () => {
    const { view } = await mount([canvasMessage(3, "Purdy")]);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);

    view.handleStreamEvent({ type: "message", message: canvasMessage(8, "Purdy") });
    await flush();
    expect(tabs(view.element)).toEqual(["Chat", "Canvas"]);
    expect(view.element.querySelector(".wx-srv-tab-canvas .wx-srv-tab-dot:not([hidden])")).not.toBeNull();
    // Offered, not forced: the chat is still what shows.
    expect(view.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-tab-canvas")!.click();
    expect(canvasTabShowing(view.element)).toBe(true);
    expect(view.element.querySelector(".wx-srv-canvas-title")!.textContent).toBe("Purdy's canvas");
    view.teardown();
  });

  it("✕ closes the tab (the pen session ends, the pane leaves the chat); the canvas stays, and Open brings it back", async () => {
    const { view } = await mount([canvasMessage(4)]);
    view.element.querySelector<HTMLButtonElement>('[data-message-seq="4"] .wx-srv-canvas-open')!.click();
    const close = view.element.querySelector<HTMLButtonElement>(".wx-srv-canvas-close")!;
    expect(close.getAttribute("aria-label")).toBe("Close the canvas");
    expect(close.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    close.click();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    expect(view.element.querySelector(".wx-srv-canvas-pane")).toBeNull();
    expect(view.element.querySelector('[data-message-seq="4"] .wx-srv-canvas-surface')).not.toBeNull();
    view.element.querySelector<HTMLButtonElement>('[data-message-seq="4"] .wx-srv-canvas-open')!.click();
    expect(canvasTabShowing(view.element)).toBe(true);
    view.teardown();
  });

  it("a deleted canvas closes its tab", async () => {
    const { view } = await mount([canvasMessage(4)]);
    view.element.querySelector<HTMLButtonElement>('[data-message-seq="4"] .wx-srv-canvas-open')!.click();
    expect(canvasTabShowing(view.element)).toBe(true);
    view.handleStreamEvent({ type: "message_deleted", seq: 4 });
    await flush();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-tabs")!.hidden).toBe(true);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-thread-wrap")!.hidden).toBe(false);
    expect(view.element.querySelector(".wx-srv-canvas-pane")).toBeNull();
    view.teardown();
  });
});
