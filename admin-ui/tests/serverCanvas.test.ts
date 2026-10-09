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
    getBoundGrantId: vi.fn(() => null),
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

function canvasMessage(seq: number): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender: "Josh",
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

async function mount() {
  getHistory.mockResolvedValue({ messages: [], hasMore: false, cursor: 0 });
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
