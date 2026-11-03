import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerLockedError } from "../src/server/api/http";
import type { Message } from "../src/server/api/messages";
import type { SearchPage, SearchResult } from "../src/server/api/search";
import type { ServerIdentity } from "../src/server/identity";
import { findMarkRanges } from "../src/server/searchMarks";
import { createSearchView } from "../src/server/searchView";
import { mountServerThread } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";

const { getHistory, getUsage, searchMessages } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  searchMessages: vi.fn(),
}));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
}));
vi.mock("../src/server/api/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/search")>()),
  searchMessages,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function hit(seq: number, source: SearchResult["source"] = "text"): SearchResult {
  return {
    seq,
    sender: "Cupcake",
    createdAt: 1_700_000_000 + seq,
    source,
    parts: [
      { text: "before ", match: false },
      { text: "milk", match: true },
    ],
    matched: ["milk"],
  };
}

function page(seqs: number[], total = seqs.length, hasMore = false): SearchPage {
  return { results: seqs.map((seq) => hit(seq)), hasMore, total };
}

function message(seq: number, text: string | null): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender: "Cupcake",
    text,
    attachments: [],
    reactions: [],
    createdAt: 1000 + seq,
    replyTo: null,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function setup(pages: SearchPage[]) {
  const fetchPage = vi.fn(async (): Promise<SearchPage> => pages.shift() ?? page([]));
  const reveal = vi.fn(async () => "shown" as const);
  const lockNow = vi.fn();
  const clearReveal = vi.fn();
  const onNavChange = vi.fn();
  const view = createSearchView({
    document,
    win: window,
    hooks: { lockNow },
    getSession: () => SESSION,
    senderLabel: (sender) => (sender === "Josh" ? "You" : sender),
    reveal,
    clearReveal,
    onNavChange,
    fetchPage: fetchPage as never,
  });
  document.body.append(view.element, view.nav);
  const input = view.element.querySelector<HTMLInputElement>(".wx-srv-search-input")!;
  const seqs = () =>
    Array.from(view.element.querySelectorAll<HTMLElement>(".wx-srv-search-item")).map((n) => Number(n.dataset["messageSeq"]));
  const item = (seq: number) => view.element.querySelector<HTMLButtonElement>(`.wx-srv-search-item[data-message-seq="${seq}"]`)!;
  const nav = {
    older: view.nav.querySelector<HTMLButtonElement>(".wx-srv-search-older")!,
    newer: view.nav.querySelector<HTMLButtonElement>(".wx-srv-search-newer")!,
    pos: view.nav.querySelector<HTMLButtonElement>(".wx-srv-search-pos")!,
    close: view.nav.querySelector<HTMLButtonElement>(".wx-srv-search-nav-close")!,
  };
  async function type(text: string): Promise<void> {
    input.value = text;
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    await flush();
  }
  return { view, input, seqs, item, nav, type, fetchPage, reveal, lockNow, clearReveal, onNavChange };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("search screen", () => {
  it("waits for a pause in typing, then lists results newest first with the words marked", async () => {
    const { view, input, seqs, item, type, fetchPage } = setup([page([9, 4], 2)]);
    view.open(48);
    expect(view.element.hidden).toBe(false);
    expect(view.element.style.top).toBe("48px");
    expect(document.activeElement).toBe(input);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-search-hint")!.hidden).toBe(false);

    input.value = "mi";
    input.dispatchEvent(new Event("input"));
    input.value = "milk";
    input.dispatchEvent(new Event("input"));
    expect(fetchPage).not.toHaveBeenCalled();
    await type("milk");
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(SESSION, "milk", { limit: 30 });
    expect(seqs()).toEqual([9, 4]);
    expect(item(9).querySelector("mark")!.textContent).toBe("milk");
    expect(item(9).querySelector(".wx-srv-search-item-sender")!.textContent).toBe("Cupcake");
    expect(view.element.querySelector(".wx-srv-search-summary")!.textContent).toBe("2 messages");
    expect(view.element.querySelector<HTMLElement>(".wx-srv-search-hint")!.hidden).toBe(true);
  });

  it("renders message text as text, never as markup", async () => {
    const dangerous: SearchResult = {
      ...hit(1),
      sender: "<b>x</b>",
      parts: [{ text: "<img src=x onerror=alert(1)>", match: false }],
    };
    const { view, item, type } = setup([{ results: [dangerous], hasMore: false, total: 1 }]);
    view.open(0);
    await type("x");
    expect(item(1).querySelector("img")).toBeNull();
    expect(item(1).querySelector("b")).toBeNull();
    expect(item(1).textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("labels a voice note found by its transcript", async () => {
    const { view, item, type } = setup([{ results: [hit(3, "transcript")], hasMore: false, total: 1 }]);
    view.open(0);
    await type("milk");
    expect(item(3).querySelector(".wx-srv-search-item-source")!.textContent).toBe("Voice note: ");
  });

  it("says when nothing was found", async () => {
    const { view, type } = setup([page([])]);
    view.open(0);
    await type("zzz");
    expect(view.element.querySelector(".wx-srv-search-summary")!.textContent).toBe("No messages found.");
  });

  it("pages older results in", async () => {
    const { view, seqs, type, fetchPage } = setup([page([9, 7], 3, true), page([2], 3)]);
    view.open(0);
    await type("milk");
    const more = view.element.querySelector<HTMLButtonElement>(".wx-srv-search-more")!;
    expect(more.hidden).toBe(false);
    more.click();
    await flush();
    expect(fetchPage).toHaveBeenLastCalledWith(SESSION, "milk", { before: 7, limit: 30 });
    expect(seqs()).toEqual([9, 7, 2]);
    expect(more.hidden).toBe(true);
  });

  it("drops an answer to an earlier query", async () => {
    const { view, seqs, input, type, fetchPage } = setup([]);
    let release: (value: SearchPage) => void = () => {};
    fetchPage.mockImplementationOnce(() => new Promise<SearchPage>((resolve) => (release = resolve)));
    fetchPage.mockImplementationOnce(async () => page([5]));
    view.open(0);
    await type("mi");
    input.value = "milk";
    await type("milk");
    release(page([1]));
    await flush();
    expect(seqs()).toEqual([5]);
  });

  it("a change noticed while the first page is loading doesn't jump the queue", async () => {
    const { view, seqs, input, fetchPage } = setup([]);
    let release: (value: SearchPage) => void = () => {};
    fetchPage.mockImplementationOnce(() => new Promise<SearchPage>((resolve) => (release = resolve)));
    view.open(0);
    input.value = "milk";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    view.messageChanged(message(2, "reacted to"));
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    release(page([9, 7], 3, true));
    await flush();
    expect(seqs()).toEqual([9, 7]);
  });

  it("one failed check doesn't lose the others", async () => {
    const { view, seqs, type, fetchPage } = setup([page([5])]);
    view.open(0);
    await type("milk");
    fetchPage.mockReset();
    fetchPage.mockRejectedValueOnce(new Error("offline"));
    fetchPage.mockImplementationOnce((async () => page([8], 2)) as never);
    view.messageChanged(message(6, "milk"));
    view.messageChanged(message(8, "milk"));
    await flush();
    await flush();
    expect(seqs()).toEqual([8, 5]);
  });

  it("a delete that failed gives the message back to the results", async () => {
    const { view, seqs, type, fetchPage } = setup([page([9, 5], 2)]);
    view.open(0);
    await type("milk");
    view.messageDeleted(9);
    expect(seqs()).toEqual([5]);
    fetchPage.mockImplementationOnce((async () => page([9], 2)) as never);
    view.messageChanged(message(9, "milk"));
    await flush();
    expect(seqs()).toEqual([9, 5]);
  });

  it("Older waits for a page already on its way", async () => {
    const { view, item, nav, type, reveal, fetchPage } = setup([page([9], 2, true)]);
    view.open(0);
    await type("milk");
    item(9).click();
    await flush();
    let release: (value: SearchPage) => void = () => {};
    fetchPage.mockImplementationOnce(() => new Promise<SearchPage>((resolve) => (release = resolve)));
    view.element.querySelector<HTMLButtonElement>(".wx-srv-search-more")!.click();
    nav.older.click();
    release(page([3], 2));
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(reveal).toHaveBeenLastCalledWith(3, ["milk"]);
  });

  it("offers a retry when a search fails, and a lost session locks the chat", async () => {
    const { view, type, fetchPage, lockNow } = setup([]);
    fetchPage.mockRejectedValueOnce(new Error("Couldn't search the messages (500)."));
    view.open(0);
    await type("milk");
    expect(view.element.querySelector(".wx-srv-search-error")!.textContent).toBe("Couldn't search the messages (500).");
    expect(view.element.querySelector(".wx-srv-search-more")!.textContent).toBe("Try again");
    expect(lockNow).not.toHaveBeenCalled();

    fetchPage.mockRejectedValueOnce(new ServerLockedError());
    view.element.querySelector<HTMLButtonElement>(".wx-srv-search-more")!.click();
    await flush();
    expect(lockNow).toHaveBeenCalledWith("unauthorized");
  });

  it("a deleted message leaves the results at once, and a page read before the delete can't bring it back", async () => {
    const { view, seqs, type, fetchPage } = setup([page([9, 7, 5], 4, true)]);
    view.open(0);
    await type("milk");
    view.messageDeleted(7);
    expect(seqs()).toEqual([9, 5]);
    expect(view.element.querySelector(".wx-srv-search-summary")!.textContent).toBe("3 messages");

    fetchPage.mockImplementationOnce(async () => page([3, 1], 3));
    view.messageDeleted(3);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-search-more")!.click();
    await flush();
    expect(seqs()).toEqual([9, 5, 1]);
  });

  it("asks about a message that arrives, one at a time, and places it", async () => {
    const { view, seqs, type, fetchPage } = setup([page([5])]);
    view.open(0);
    await type("milk");
    fetchPage.mockReset();
    let inFlight = 0;
    let most = 0;
    fetchPage.mockImplementation((async (_s: unknown, _q: unknown, opts: { only: number }) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return opts.only === 8 ? page([8], 2) : page([], 2);
    }) as never);
    view.messageChanged(message(6, "plain"));
    view.messageChanged(message(7, "plain"));
    view.messageChanged(message(8, "milk"));
    await flush();
    await flush();
    expect(most).toBe(1);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(seqs()).toEqual([8, 5]);
    expect(view.element.querySelector(".wx-srv-search-summary")!.textContent).toBe("2 messages");
  });

  it("never asks about a view-once message, or when nothing is being searched", async () => {
    const { view, type, fetchPage } = setup([page([5])]);
    view.messageChanged(message(6, "milk"));
    expect(fetchPage).not.toHaveBeenCalled();
    view.open(0);
    await type("milk");
    fetchPage.mockClear();
    view.messageChanged({ ...message(7, null), viewOnce: { durationS: 5, tease: false } } as Message);
    await flush();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("reset forgets everything", async () => {
    const { view, input, seqs, type, fetchPage } = setup([page([5])]);
    view.open(0);
    await type("milk");
    view.reset();
    expect(view.isOpen()).toBe(false);
    expect(view.element.hidden).toBe(true);
    expect(input.value).toBe("");
    expect(seqs()).toEqual([]);
    expect(view.element.textContent).not.toContain("milk");
    fetchPage.mockClear();
    view.messageChanged(message(6, "milk"));
    await flush();
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

describe("going to a result", () => {
  it("closes the list, shows the message and offers its neighbours", async () => {
    const { view, item, nav, type, reveal, onNavChange } = setup([page([9, 7, 5], 3)]);
    view.open(0);
    await type("milk");
    expect(view.nav.hidden).toBe(true);

    item(7).click();
    expect(view.element.hidden).toBe(true);
    expect(view.nav.hidden).toBe(false);
    expect(nav.pos.textContent).toBe("Finding it…");
    expect(onNavChange).toHaveBeenCalledTimes(1);
    await flush();
    expect(reveal).toHaveBeenCalledWith(7, ["milk"]);
    expect(nav.pos.textContent).toBe("2 of 3");

    nav.newer.click();
    await flush();
    expect(reveal).toHaveBeenLastCalledWith(9, ["milk"]);
    expect(nav.pos.textContent).toBe("1 of 3");
    expect(nav.newer.hidden).toBe(true);

    nav.older.click();
    await flush();
    nav.older.click();
    await flush();
    expect(reveal).toHaveBeenLastCalledWith(5, ["milk"]);
    expect(nav.pos.textContent).toBe("3 of 3");
    expect(nav.older.hidden).toBe(true);
  });

  it("Older loads the next page when it runs out of held results", async () => {
    const { view, item, nav, type, reveal, fetchPage } = setup([page([9], 2, true), page([3], 2)]);
    view.open(0);
    await type("milk");
    item(9).click();
    await flush();
    expect(nav.older.hidden).toBe(false);
    nav.older.click();
    await flush();
    expect(fetchPage).toHaveBeenLastCalledWith(SESSION, "milk", { before: 9, limit: 30 });
    expect(reveal).toHaveBeenLastCalledWith(3, ["milk"]);
    expect(nav.pos.textContent).toBe("2 of 2");
  });

  it("the position button goes back to the list as it was", async () => {
    const { view, input, seqs, item, nav, type } = setup([page([9, 7], 2)]);
    view.open(0);
    await type("milk");
    item(7).click();
    await flush();
    nav.pos.click();
    expect(view.element.hidden).toBe(false);
    expect(input.value).toBe("milk");
    expect(seqs()).toEqual([9, 7]);
    expect(view.nav.hidden).toBe(false);
  });

  it("✕ closes the bar and forgets the search", async () => {
    const { view, seqs, item, nav, type, clearReveal } = setup([page([9], 1)]);
    view.open(0);
    await type("milk");
    item(9).click();
    await flush();
    clearReveal.mockClear();
    nav.close.click();
    expect(view.nav.hidden).toBe(true);
    expect(view.navActive()).toBe(false);
    expect(clearReveal).toHaveBeenCalled();
    expect(seqs()).toEqual([]);
  });

  it("a result that has gone is dropped, and the steps still work from where it was", async () => {
    const { view, seqs, item, nav, type, reveal } = setup([page([9, 7, 5], 3)]);
    reveal.mockImplementationOnce(async () => "gone" as never);
    view.open(0);
    await type("milk");
    item(7).click();
    await flush();
    expect(seqs()).toEqual([9, 5]);
    expect(nav.pos.textContent).toBe("2 results");
    expect(nav.older.hidden).toBe(false);
    expect(nav.newer.hidden).toBe(false);
    nav.older.click();
    await flush();
    expect(reveal).toHaveBeenLastCalledWith(5, ["milk"]);
  });

  it("says so when it can't get there, without dropping the result", async () => {
    const { view, seqs, item, nav, type, reveal } = setup([page([9], 1)]);
    reveal.mockImplementationOnce(async () => "failed" as never);
    view.open(0);
    await type("milk");
    item(9).click();
    await flush();
    expect(nav.pos.textContent).toBe("Couldn't get to that one");
    expect(seqs()).toEqual([9]);
  });

  it("only the newest step may update the bar", async () => {
    const { view, item, nav, type, reveal } = setup([page([9, 7], 2)]);
    let finishFirst: (value: "shown") => void = () => {};
    reveal.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
    view.open(0);
    await type("milk");
    item(9).click();
    nav.older.click();
    await flush();
    expect(nav.pos.textContent).toBe("2 of 2");
    finishFirst("shown");
    await flush();
    expect(nav.pos.textContent).toBe("2 of 2");
  });

  it("the bar goes when every result has gone", async () => {
    const { view, item, type } = setup([page([9], 1)]);
    view.open(0);
    await type("milk");
    item(9).click();
    await flush();
    view.messageDeleted(9);
    expect(view.nav.hidden).toBe(true);
  });
});

describe("marks", () => {
  it("finds the matched words in a bubble's text and transcript, and nowhere else", () => {
    const bubble = document.createElement("div");
    bubble.innerHTML =
      '<div class="wx-srv-quote">milk in a quote</div>' +
      '<div class="wx-srv-bubble-text">Milk then <a href="#">milk</a> and Milk</div>' +
      '<div class="wx-srv-transcript"><p>got milk</p></div>';
    const found = findMarkRanges(bubble, ["Milk", "milk"]).map((range) => range.toString());
    expect(found).toEqual(["Milk", "milk", "Milk", "milk"]);
  });
});

describe("in the thread", () => {
  const observers: Array<(entries: IntersectionObserverEntry[]) => void> = [];
  const identity: ServerIdentity = {
    getName: () => "Josh",
    setName: vi.fn(),
    getDeviceId: () => "d1",
    isMine: (sender: string) => sender.toLowerCase() === "josh",
  };

  function mount() {
    const hooks: LockHooks = {
      suspend: vi.fn(() => () => {}),
      lockNow: vi.fn(),
      adoptBoundSession: vi.fn(),
      getBoundGrantId: vi.fn(() => null),
      suspendLive: vi.fn(() => ({ touch() {}, release() {} })),
      activityCount: vi.fn(() => 0),
    };
    const win = {
      crypto: { randomUUID: () => "uuid" },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      navigator: window.navigator,
      IntersectionObserver: class {
        constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
          observers.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    } as unknown as Window;
    const view = mountServerThread({ identity, hooks, win, onSettings: vi.fn() });
    document.body.appendChild(view.element);
    return view;
  }

  function newerEntry(view: ReturnType<typeof mount>): IntersectionObserverEntry[] {
    const target = view.element.querySelector(".wx-srv-thread-sentinel-newer")!;
    return [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry];
  }

  async function search(view: ReturnType<typeof mount>): Promise<void> {
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-search")!.click();
    const input = view.element.querySelector<HTMLInputElement>(".wx-srv-search-input")!;
    input.value = "milk";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    await flush();
  }

  function row(view: ReturnType<typeof mount>, seq: number): HTMLButtonElement {
    return view.element.querySelector<HTMLButtonElement>(`.wx-srv-search-item[data-message-seq="${seq}"]`)!;
  }

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    observers.length = 0;
    getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
    getHistory.mockReset();
    searchMessages.mockReset();
  });

  it("is in the ⋯ menu, straight after the gallery", () => {
    const view = mount();
    const items = view.element.querySelector(".wx-srv-more-menu")!.children;
    expect(items[1]!.className).toContain("wx-srv-more-search");
    view.teardown();
  });

  /** The bubbles on screen, oldest first. */
  function onScreen(view: ReturnType<typeof mount>): number[] {
    return Array.from(view.element.querySelectorAll<HTMLElement>(".wx-srv-message-list .wx-srv-bubble")).map((n) =>
      Number(n.dataset["messageSeq"]),
    );
  }

  async function detachAt100(): Promise<ReturnType<typeof mount>> {
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    searchMessages.mockResolvedValue(page([100], 1));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    getHistory.mockResolvedValueOnce({
      messages: [message(99, "older"), message(100, "milk"), message(101, "newer")],
      hasMore: true,
      hasNewer: true,
      cursor: 0,
    });
    row(view, 100).click();
    await flush();
    return view;
  }

  function pill(view: ReturnType<typeof mount>): HTMLButtonElement {
    return view.element.querySelector<HTMLButtonElement>(".wx-srv-jump-pill")!;
  }

  it("shows an old message in its own neighbourhood, in one request, and offers the way back", async () => {
    const view = await detachAt100();
    expect(getHistory.mock.calls.slice(1)).toEqual([[SESSION, { around: 100, limit: 50 }]]);
    expect(onScreen(view)).toEqual([99, 100, 101]);
    const bubble = view.element.querySelector<HTMLElement>('.wx-srv-bubble[data-message-seq="100"]')!;
    expect(bubble.classList.contains("wx-srv-bubble-highlighted")).toBe(true);
    expect(view.element.querySelector(".wx-srv-search-pos")!.textContent).toBe("1 of 1");
    expect(pill(view).hidden).toBe(false);
    expect(pill(view).textContent).toBe("\u2193 Latest messages");
    view.teardown();
  });

  it("a new message waits off screen, and the pill goes back to the latest and forgets the old stretch", async () => {
    const view = await detachAt100();
    view.handleStreamEvent({ type: "message", message: message(5001, "just in") } as never);
    expect(onScreen(view)).toEqual([99, 100, 101]);
    pill(view).click();
    expect(onScreen(view)).toEqual([5000, 5001]);
    expect(pill(view).hidden).toBe(true);
    expect(pill(view).textContent).toBe("\u2193 New messages");
    view.teardown();
  });

  it("an update to a message in the gap neither side holds is not taken in", async () => {
    const view = await detachAt100();
    view.handleStreamEvent({ type: "message_updated", message: message(3000, "elsewhere") } as never);
    pill(view).click();
    expect(onScreen(view)).toEqual([5000]);
    view.teardown();
  });

  it("a result already in the newest messages leaves the old stretch without a request", async () => {
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "milk")], hasMore: true, cursor: 0 });
    searchMessages.mockResolvedValue(page([5000, 100], 2));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    getHistory.mockResolvedValueOnce({ messages: [message(100, "milk")], hasMore: true, hasNewer: true, cursor: 0 });
    row(view, 100).click();
    await flush();
    expect(onScreen(view)).toEqual([100]);
    const calls = getHistory.mock.calls.length;
    view.element.querySelector<HTMLButtonElement>(".wx-srv-search-newer")!.click();
    await flush();
    expect(getHistory.mock.calls.length).toBe(calls);
    expect(onScreen(view)).toEqual([5000]);
    view.teardown();
  });

  it("going to one old result from another replaces the stretch on screen", async () => {
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    searchMessages.mockResolvedValue(page([100, 50], 2));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    getHistory.mockResolvedValueOnce({ messages: [message(100, "milk")], hasMore: true, hasNewer: true, cursor: 0 });
    row(view, 100).click();
    await flush();
    getHistory.mockResolvedValueOnce({ messages: [message(50, "milk")], hasMore: true, hasNewer: true, cursor: 0 });
    view.element.querySelector<HTMLButtonElement>(".wx-srv-search-older")!.click();
    await flush();
    expect(onScreen(view)).toEqual([50]);
    view.teardown();
  });

  it("a neighbourhood that reaches the newest messages is simply the chat", async () => {
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    searchMessages.mockResolvedValue(page([4990], 1));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    getHistory.mockResolvedValueOnce({ messages: [message(4990, "milk"), message(5000, "latest")], hasMore: true, hasNewer: false, cursor: 0 });
    row(view, 4990).click();
    await flush();
    expect(onScreen(view)).toEqual([4990, 5000]);
    expect(pill(view).hidden).toBe(true);
    view.teardown();
  });

  it("scrolling to the end pages newer until it meets the newest messages", async () => {
    const view = await detachAt100();
    getHistory.mockResolvedValueOnce({ messages: [message(102, "next")], hasMore: true, hasNewer: true, cursor: 0 });
    observers[0]!(newerEntry(view));
    await flush();
    expect(getHistory).toHaveBeenLastCalledWith(SESSION, { after: 101, limit: 50 });
    expect(onScreen(view)).toEqual([99, 100, 101, 102]);
    expect(pill(view).hidden).toBe(false);

    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, hasNewer: false, cursor: 0 });
    observers[0]!(newerEntry(view));
    await flush();
    expect(getHistory).toHaveBeenLastCalledWith(SESSION, { after: 102, limit: 50 });
    expect(onScreen(view)).toEqual([99, 100, 101, 102, 5000]);
    expect(pill(view).hidden).toBe(true);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-thread-sentinel-newer")!.hidden).toBe(true);
    view.teardown();
  });

  it("a lock leaves the old stretch, so the next unlock never pages across the gap", async () => {
    const view = await detachAt100();
    view.detach();
    getHistory.mockClear();
    getHistory.mockResolvedValue({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    await view.attach(SESSION);
    await flush();
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(onScreen(view)).toEqual([5000]);
    view.teardown();
  });

  it("a deleted message's words don't come back in a quote when the newest messages return", async () => {
    getHistory.mockResolvedValueOnce({
      messages: [
        message(4999, "secret words"),
        {
          ...message(5000, "a reply"),
          replyTo: { seq: 4999, sender: "Cupcake", text: "secret words", truncated: false, media: null },
        },
      ],
      hasMore: true,
      cursor: 0,
    });
    searchMessages.mockResolvedValue(page([100], 1));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    getHistory.mockResolvedValueOnce({ messages: [message(100, "milk")], hasMore: true, hasNewer: true, cursor: 0 });
    row(view, 100).click();
    await flush();
    view.handleStreamEvent({ type: "message_deleted", seq: 4999 } as never);
    pill(view).click();
    expect(onScreen(view)).toEqual([5000]);
    expect(view.element.textContent).not.toContain("secret words");
    view.teardown();
  });

  it("an older page arriving after the view was left is dropped, leaving the gap to be paged", async () => {
    const view = await detachAt100();
    let release: (value: unknown) => void = () => {};
    getHistory.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    observers[0]!([{ isIntersecting: true, target: view.element.querySelector(".wx-srv-thread-sentinel")! } as never]);
    pill(view).click();
    release({ messages: [message(50, "old")], hasMore: true, cursor: 0 });
    await flush();
    expect(onScreen(view)).toEqual([5000]);
    view.teardown();
  });

  it("an update to a message older than anything held isn't taken in, in or out of a view", async () => {
    const view = await detachAt100();
    view.handleStreamEvent({ type: "message_updated", message: message(50, "reacted to") } as never);
    expect(onScreen(view)).toEqual([99, 100, 101]);
    pill(view).click();
    view.handleStreamEvent({ type: "message_updated", message: message(101, "reacted to") } as never);
    expect(onScreen(view)).toEqual([5000]);
    getHistory.mockClear();
    getHistory.mockResolvedValueOnce({ messages: [], hasMore: false, cursor: 0 });
    observers[0]!([{ isIntersecting: true, target: view.element.querySelector(".wx-srv-thread-sentinel")! } as never]);
    await flush();
    expect(getHistory).toHaveBeenCalledWith(SESSION, { before: 5000, limit: 50 });
    view.teardown();
  });

  it("joining the newest messages doesn't carry the reader to the end", async () => {
    const view = await detachAt100();
    const thread = view.element.querySelector<HTMLElement>(".wx-srv-thread")!;
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(thread, "clientHeight", { configurable: true, value: 500 });
    thread.scrollTop = 500;
    thread.dispatchEvent(new Event("scroll"));
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 2000 });
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, hasNewer: false, cursor: 0 });
    observers[0]!(newerEntry(view));
    await flush();
    expect(onScreen(view)).toEqual([99, 100, 101, 5000]);
    expect(thread.scrollTop).toBe(500);
    view.teardown();
  });

  it("a send during a jump wins: the answer that arrives later changes nothing", async () => {
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    searchMessages.mockResolvedValue(page([100], 1));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    let release: (value: unknown) => void = () => {};
    getHistory.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    row(view, 100).click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-search-nav-close")!.click();
    release({ messages: [message(100, "milk")], hasMore: true, hasNewer: true, cursor: 0 });
    await flush();
    expect(onScreen(view)).toEqual([5000]);
    expect(pill(view).hidden).toBe(true);
    view.teardown();
  });

  it("a renewed token leaves the old stretch instead of walking the gap", async () => {
    const view = await detachAt100();
    getHistory.mockClear();
    getHistory.mockResolvedValue({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    await view.attach({ ...SESSION, token: "renewed" });
    await flush();
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(onScreen(view)).toEqual([5000]);
    view.teardown();
  });

  it("a quote whose original is above the gap is found by its neighbourhood, not declared deleted", async () => {
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    searchMessages.mockResolvedValue(page([100], 1));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    getHistory.mockResolvedValueOnce({
      messages: [
        {
          ...message(100, "milk"),
          replyTo: { seq: 90, sender: "Cupcake", text: "original", truncated: false, media: null },
        },
      ],
      hasMore: true,
      hasNewer: true,
      cursor: 0,
    });
    row(view, 100).click();
    await flush();
    getHistory.mockResolvedValueOnce({ messages: [message(90, "original")], hasMore: true, hasNewer: true, cursor: 0 });
    view.element.querySelector<HTMLButtonElement>(".wx-srv-quote")!.click();
    await flush();
    expect(getHistory).toHaveBeenLastCalledWith(SESSION, { around: 90, limit: 50 });
    expect(onScreen(view)).toEqual([90]);
    view.teardown();
  });

  it("a pending reply to a message in the old stretch is cancelled if it was deleted across a lock", async () => {
    const view = await detachAt100();
    const bubble = view.element.querySelector<HTMLElement>('.wx-srv-bubble[data-message-seq="100"]')!;
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")!.click();
    const bar = view.element.querySelector<HTMLElement>(".wx-srv-reply-bar");
    expect(bar).not.toBeNull();
    expect(bar!.hidden).toBe(false);
    view.detach();

    getHistory.mockClear();
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    getHistory.mockResolvedValueOnce({ messages: [message(101, "a neighbour")], hasMore: true, hasNewer: true, cursor: 0 });
    await view.attach(SESSION);
    await flush();
    expect(getHistory).toHaveBeenLastCalledWith(SESSION, { around: 100, limit: 1 });
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")!.hidden).toBe(true);
    view.teardown();
  });

  it("a result no longer there is dropped", async () => {
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    searchMessages.mockResolvedValue(page([100, 50], 2));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);

    getHistory.mockResolvedValueOnce({ messages: [message(99, "other")], hasMore: true, hasNewer: true, cursor: 0 });
    row(view, 100).click();
    await flush();
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(row(view, 100)).toBeNull();
    expect(row(view, 50)).not.toBeNull();
    expect(onScreen(view)).toEqual([5000]);
    view.teardown();
  });

  it("a failed load says so and stays where it was", async () => {
    getHistory.mockResolvedValueOnce({ messages: [message(5000, "latest")], hasMore: true, cursor: 0 });
    searchMessages.mockResolvedValue(page([100], 1));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    getHistory.mockRejectedValueOnce(new Error("offline"));
    row(view, 100).click();
    await flush();
    expect(view.element.querySelector(".wx-srv-search-pos")!.textContent).toBe("Couldn't get to that one");
    expect(onScreen(view)).toEqual([5000]);
    view.teardown();
  });

  it("a lock and a wipe both forget the search", async () => {
    getHistory.mockResolvedValue({ messages: [message(1, "hello")], hasMore: false, cursor: 0 });
    searchMessages.mockResolvedValue(page([1], 1));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    const screen = view.element.querySelector<HTMLElement>(".wx-srv-search-view")!;
    expect(row(view, 1)).not.toBeNull();

    view.detach();
    expect(screen.hidden).toBe(true);
    expect(row(view, 1)).toBeNull();
    expect(view.element.querySelector<HTMLInputElement>(".wx-srv-search-input")!.value).toBe("");

    await view.attach(SESSION);
    await flush();
    await search(view);
    expect(row(view, 1)).not.toBeNull();
    view.handleStreamEvent({ type: "wiped" } as never);
    expect(screen.hidden).toBe(true);
    expect(row(view, 1)).toBeNull();
    view.teardown();
  });

  it("a deleted message leaves the open results from the stream", async () => {
    getHistory.mockResolvedValue({ messages: [message(1, "milk"), message(2, "milk")], hasMore: false, cursor: 0 });
    searchMessages.mockResolvedValue(page([2, 1], 2));
    const view = mount();
    await view.attach(SESSION);
    await flush();
    await search(view);
    view.handleStreamEvent({ type: "message_deleted", seq: 2 } as never);
    expect(row(view, 2)).toBeNull();
    expect(row(view, 1)).not.toBeNull();
    view.teardown();
  });
});
