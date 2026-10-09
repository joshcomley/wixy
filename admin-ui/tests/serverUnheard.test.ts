import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/server/api/messages";
import { createHeardStore } from "../src/server/heardStore";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerThread } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";

const { getHistory, getUsage, transcribeAttachment } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  transcribeAttachment: vi.fn(),
}));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
  transcribeAttachment,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };
const FUTURE = Date.now() / 1000 + 100;

function identity(): ServerIdentity {
  return {
    getName: () => "Josh",
    setName: vi.fn(),
    getDeviceId: () => "d1",
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

function memoryWindow(store: Map<string, string> = new Map()): Window {
  return {
    crypto: { randomUUID: () => "uuid" },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  } as unknown as Window;
}

function voiceMessage(seq: number, sender: string, id: string, offset = 0): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender,
    text: null,
    attachments: [
      { id, kind: "voice", status: "ready", width: null, height: null, durationS: 100, peaks: [0.5], urls: { play: "/v" } },
    ],
    reactions: [],
    createdAt: FUTURE + offset,
    replyTo: null,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

/** jsdom has no layout: the thread viewport starts at y=100, a bubble is "off the top" when its
 * seq is in `offTop`. */
function stubLayout(offTop: Set<string>): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("wx-srv-thread")) return { top: 100, bottom: 600, left: 0, right: 300, width: 300, height: 500 } as DOMRect;
    const seq = this.dataset["messageSeq"];
    if (seq !== undefined && offTop.has(seq)) return { top: 0, bottom: 50, left: 0, right: 300, width: 300, height: 50 } as DOMRect;
    return { top: 200, bottom: 300, left: 0, right: 300, width: 300, height: 100 } as DOMRect;
  });
}

async function mount(messages: Message[], store = new Map<string, string>()) {
  getHistory.mockResolvedValue({ messages, hasMore: false, cursor: 0 });
  const win = memoryWindow(store);
  const view = mountServerThread({ identity: identity(), hooks: hooks(), win, onSettings: vi.fn() });
  document.body.appendChild(view.element);
  await view.attach(SESSION);
  await flush();
  return { view, store };
}

beforeEach(() => {
  getHistory.mockReset();
  getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
  transcribeAttachment.mockReset().mockResolvedValue({ kind: "failed" });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("heard store", () => {
  it("remembers heard ids and a first-run baseline, and survives unreadable storage", () => {
    const store = new Map<string, string>();
    const win = memoryWindow(store);
    const a = createHeardStore(win, () => 5_000_000);
    expect(a.since()).toBe(5000);
    a.markHeard("x");
    const b = createHeardStore(win, () => 9_000_000);
    expect(b.since()).toBe(5000);
    expect(b.isHeard("x")).toBe(true);
    expect(b.isHeard("y")).toBe(false);

    store.set("wx-srv-voice-heard", "{not json");
    expect(createHeardStore(win, () => 7_000_000).since()).toBe(7000);
  });
});

describe("unheard voice notes", () => {
  it("shows a tab counting unheard notes that scrolled off the top, never your own", async () => {
    stubLayout(new Set(["1", "2", "3"]));
    const { view } = await mount([
      voiceMessage(1, "Cupcake", "a1"),
      voiceMessage(2, "Cupcake", "a2"),
      voiceMessage(3, "Josh", "mine"),
    ]);
    const tab = view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!;
    expect(tab.hidden).toBe(false);
    expect(tab.textContent).toBe("2 unread voice notes");
    view.teardown();
  });

  it("stays hidden while every unheard note is still on screen", async () => {
    stubLayout(new Set());
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1")]);
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.hidden).toBe(true);
    view.teardown();
  });

  it("ignores notes from before this device first ran the feature", async () => {
    stubLayout(new Set(["1"]));
    const { view } = await mount([voiceMessage(1, "Cupcake", "old", -1000)]);
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.hidden).toBe(true);
    view.teardown();
  });

  it("opens a full-screen list of the same players; dismissing removes one and persists", async () => {
    stubLayout(new Set(["1", "2"]));
    const { view, store } = await mount([voiceMessage(1, "Cupcake", "a1"), voiceMessage(2, "Cupcake", "a2")]);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.click();
    const overlay = view.element.querySelector<HTMLElement>(".wx-srv-unheard-view")!;
    expect(overlay.hidden).toBe(false);
    const items = overlay.querySelectorAll(".wx-srv-unheard-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector(".wx-srv-voice-skip-back")).not.toBeNull();
    expect(items[0]!.querySelector(".wx-srv-voice-scrub")).not.toBeNull();

    items[0]!.querySelector<HTMLButtonElement>(".wx-srv-unheard-dismiss")!.click();
    expect(overlay.querySelectorAll(".wx-srv-unheard-item")).toHaveLength(1);
    expect(JSON.parse(store.get("wx-srv-voice-heard")!).ids).toContain("a1");

    overlay.querySelector<HTMLButtonElement>(".wx-srv-unheard-close")!.click();
    expect(overlay.hidden).toBe(true);
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.textContent).toBe("1 unread voice note");
    view.teardown();
  });

  it("counts a note as listened at 90% of the way through, and keeps it in the open list", async () => {
    stubLayout(new Set(["1"]));
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1")]);
    const thread = view.element.querySelector<HTMLElement>(".wx-srv-message-list")!;
    const audio = thread.querySelector<HTMLAudioElement>("audio")!;
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    audio.currentTime = 50;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.hidden).toBe(false);
    audio.currentTime = 91;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.hidden).toBe(true);
    view.teardown();
  });

  it("does not count dragging a paused note to the end as listening", async () => {
    stubLayout(new Set(["1"]));
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1")]);
    const audio = view.element.querySelector<HTMLAudioElement>(".wx-srv-message-list audio")!;
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    audio.currentTime = 99;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.hidden).toBe(false);
    view.teardown();
  });

  it("asking for a transcript counts as dealt with", async () => {
    stubLayout(new Set(["1"]));
    getUsage.mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false, transcriptionAvailable: true });
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1")]);
    const button = view.element.querySelector<HTMLButtonElement>(".wx-srv-message-list .wx-srv-transcript button");
    expect(button).not.toBeNull();
    button!.click();
    await flush();
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.hidden).toBe(true);
    view.teardown();
  });
});
