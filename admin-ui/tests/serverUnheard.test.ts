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
    getBoundGrantId: vi.fn(() => null), suspendLive: vi.fn(() => ({ touch() {}, release() {} })), activityCount: vi.fn(() => 0),
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

  it("counts a note as listened at 90% of the way through", async () => {
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

  it("drops a listened note from the open list live, once it stops playing", async () => {
    stubLayout(new Set(["1", "2"]));
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1"), voiceMessage(2, "Cupcake", "a2")]);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.click();
    const overlay = view.element.querySelector<HTMLElement>(".wx-srv-unheard-view")!;
    expect(overlay.querySelectorAll(".wx-srv-unheard-item")).toHaveLength(2);
    const audio = overlay.querySelector<HTMLAudioElement>(".wx-srv-unheard-item audio")!;
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    let paused = false;
    Object.defineProperty(audio, "paused", { get: () => paused, configurable: true });
    audio.currentTime = 95;
    audio.dispatchEvent(new Event("timeupdate"));
    // Still playing: it must not vanish from under the listener.
    expect(overlay.querySelectorAll(".wx-srv-unheard-item")).toHaveLength(2);
    paused = true;
    audio.dispatchEvent(new Event("ended"));
    expect(overlay.querySelectorAll(".wx-srv-unheard-item")).toHaveLength(1);
    expect(overlay.querySelector<HTMLElement>(".wx-srv-unheard-item")!.dataset["messageSeq"]).toBe("2");
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

describe("unheard voice notes: going to each one in the chat", () => {
  /** jsdom has no scrolling: record which bubble each jump scrolled to. */
  function trackScrolls(): string[] {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push((this as HTMLElement).dataset["messageSeq"] ?? "?");
    });
    return scrolled;
  }

  function nav(view: { element: HTMLElement }) {
    const bar = view.element.querySelector<HTMLElement>(".wx-srv-unheard-nav")!;
    return {
      bar,
      prev: bar.querySelector<HTMLButtonElement>(".wx-srv-unheard-prev")!,
      next: bar.querySelector<HTMLButtonElement>(".wx-srv-unheard-next")!,
      pos: bar.querySelector<HTMLElement>(".wx-srv-unheard-pos")!,
      close: bar.querySelector<HTMLButtonElement>(".wx-srv-unheard-nav-close")!,
    };
  }

  function bubble(view: { element: HTMLElement }, seq: number): HTMLElement {
    return view.element.querySelector<HTMLElement>(`.wx-srv-message-list [data-message-seq="${seq}"]`)!;
  }

  /** Plays it past 90% (a paused note dragged to the end does not count as listened). */
  function listen(audio: HTMLAudioElement): void {
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    audio.currentTime = 95;
    audio.dispatchEvent(new Event("timeupdate"));
  }

  async function openListAndGoTo(view: { element: HTMLElement }, seq: number): Promise<void> {
    view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.click();
    const item = view.element.querySelector<HTMLElement>(`.wx-srv-unheard-item[data-message-seq="${seq}"]`)!;
    item.querySelector<HTMLButtonElement>(".wx-srv-unheard-goto")!.click();
    await flush();
  }

  it("Go to message closes the list, scrolls the chat to that note and highlights it; a bar shows where it is", async () => {
    stubLayout(new Set(["1", "2", "3"]));
    const scrolled = trackScrolls();
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1"), voiceMessage(2, "Cupcake", "a2"), voiceMessage(3, "Cupcake", "a3")]);
    expect(nav(view).bar.hidden).toBe(true);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.click();
    const goto = view.element.querySelector<HTMLButtonElement>('.wx-srv-unheard-item[data-message-seq="2"] .wx-srv-unheard-goto')!;
    expect(goto.textContent).toBe("Go to message");
    // It closes a view and moves the chat under the finger: a gesture boundary, like Back to chat.
    expect(goto.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    goto.click();
    await flush();

    expect(view.element.querySelector<HTMLElement>(".wx-srv-unheard-view")!.hidden).toBe(true);
    expect(scrolled).toEqual(["2"]);
    expect(bubble(view, 2).classList.contains("wx-srv-bubble-highlighted")).toBe(true);
    const n = nav(view);
    expect(n.bar.hidden).toBe(false);
    expect(n.pos.textContent).toBe("2 of 3 unread voice notes");
    expect(n.prev.hidden).toBe(false);
    expect(n.next.hidden).toBe(false);
    // The count tab makes way for the bar.
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unheard-tab")!.hidden).toBe(true);
    view.teardown();
  });

  it("Previous and Next walk the unheard notes oldest to newest; at either end that button goes", async () => {
    stubLayout(new Set(["1", "2", "3"]));
    const scrolled = trackScrolls();
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1"), voiceMessage(2, "Cupcake", "a2"), voiceMessage(3, "Cupcake", "a3")]);
    await openListAndGoTo(view, 2);
    const n = nav(view);
    n.next.click();
    expect(scrolled.at(-1)).toBe("3");
    expect(n.pos.textContent).toBe("3 of 3 unread voice notes");
    expect(n.next.hidden).toBe(true);
    expect(n.prev.hidden).toBe(false);
    n.prev.click();
    n.prev.click();
    expect(scrolled).toEqual(["2", "3", "2", "1"]);
    expect(n.pos.textContent).toBe("1 of 3 unread voice notes");
    expect(n.prev.hidden).toBe(true);
    expect(bubble(view, 1).classList.contains("wx-srv-bubble-highlighted")).toBe(true);
    view.teardown();
  });

  it("listening to the note keeps the bar for the rest; it goes once none are left; ✕ closes it", async () => {
    stubLayout(new Set(["1", "2"]));
    trackScrolls();
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1"), voiceMessage(2, "Cupcake", "a2")]);
    await openListAndGoTo(view, 1);
    const n = nav(view);
    listen(bubble(view, 1).querySelector<HTMLAudioElement>("audio")!);
    expect(n.bar.hidden).toBe(false);
    expect(n.pos.textContent).toBe("1 more unread voice note");
    expect(n.prev.hidden).toBe(true);
    n.next.click();
    expect(n.pos.textContent).toBe("1 of 1 unread voice note");
    listen(bubble(view, 2).querySelector<HTMLAudioElement>("audio")!);
    expect(n.bar.hidden).toBe(true);
    view.teardown();

    document.body.replaceChildren();
    const again = await mount([voiceMessage(1, "Cupcake", "b1"), voiceMessage(2, "Cupcake", "b2")]);
    await openListAndGoTo(again.view, 2);
    const m = nav(again.view);
    // Never just "Close": that is the panic ✕ (which locks) to a screen reader and to the tests.
    expect(m.close.getAttribute("aria-label")).toBe("Close the voice notes bar");
    m.close.click();
    expect(m.bar.hidden).toBe(true);
    again.view.teardown();
  });

  it("the bar's buttons never count toward the double-tap lock (Next is tapped quickly on purpose)", async () => {
    stubLayout(new Set(["1", "2"]));
    trackScrolls();
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1"), voiceMessage(2, "Cupcake", "a2")]);
    await openListAndGoTo(view, 1);
    expect(nav(view).bar.hasAttribute("data-srv-gesture-exempt")).toBe(true);
    view.teardown();
  });

  it("a lock closes the bar", async () => {
    stubLayout(new Set(["1", "2"]));
    trackScrolls();
    const { view } = await mount([voiceMessage(1, "Cupcake", "a1"), voiceMessage(2, "Cupcake", "a2")]);
    await openListAndGoTo(view, 1);
    view.detach();
    expect(nav(view).bar.hidden).toBe(true);
    view.teardown();
  });
});
