import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinksPage } from "../src/server/api/links";
import type { Message } from "../src/server/api/messages";
import type { ServerIdentity } from "../src/server/identity";
import { textHasLink } from "../src/server/linkify";
import { createLinksView } from "../src/server/linksView";
import { mountServerThread } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";

const { getHistory, getUsage, getLinkMessages } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  getLinkMessages: vi.fn(),
}));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
}));
vi.mock("../src/server/api/links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/links")>()),
  getLinkMessages,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

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
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function setup(pages: LinksPage[]) {
  const fetchPage = vi.fn(async () => pages.shift() ?? { messages: [], hasMore: false });
  const lockNow = vi.fn();
  const view = createLinksView({
    document,
    hooks: { lockNow },
    getSession: () => SESSION,
    renderBubble: (m) => {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.text ?? "";
      return bubble;
    },
    disposeMedia: () => {},
    fetchPage,
  });
  document.body.appendChild(view.element);
  const seqs = () =>
    Array.from(view.element.querySelectorAll<HTMLElement>(".wx-srv-links-item")).map((n) => n.dataset["messageSeq"]);
  return { view, fetchPage, lockNow, seqs };
}

afterEach(() => document.body.replaceChildren());

describe("textHasLink", () => {
  it("matches what the thread would linkify", () => {
    expect(textHasLink("see https://example.com.")).toBe(true);
    expect(textHasLink("HTTP://EXAMPLE.COM")).toBe(true);
    expect(textHasLink("example.com or www.example.com")).toBe(false);
    expect(textHasLink("ftp://example.com")).toBe(false);
    expect(textHasLink(null)).toBe(false);
    expect(textHasLink("")).toBe(false);
    // The shared regex is global: a second call must not start from a stale lastIndex.
    expect(textHasLink("https://a.b")).toBe(true);
    expect(textHasLink("https://a.b")).toBe(true);
  });
});

describe("links view", () => {
  it("lists the server's link messages newest first and pages older ones in", async () => {
    const { view, fetchPage, seqs } = setup([
      { messages: [message(7, "https://seven.example"), message(9, "https://nine.example")], hasMore: true },
      { messages: [message(2, "https://two.example")], hasMore: false },
    ]);
    view.open(48);
    await flush();
    expect(view.element.hidden).toBe(false);
    expect(view.element.style.top).toBe("48px");
    expect(seqs()).toEqual(["9", "7"]);
    const more = view.element.querySelector<HTMLButtonElement>(".wx-srv-links-more")!;
    expect(more.hidden).toBe(false);

    more.click();
    await flush();
    expect(fetchPage).toHaveBeenLastCalledWith(SESSION, { before: 7, limit: 40 });
    expect(seqs()).toEqual(["9", "7", "2"]);
    expect(more.hidden).toBe(true);
  });

  it("says so when there are no links, and clears on close", async () => {
    const { view, seqs } = setup([{ messages: [], hasMore: false }]);
    view.open(0);
    await flush();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-links-empty")!.hidden).toBe(false);
    view.close();
    expect(view.element.hidden).toBe(true);
    expect(seqs()).toEqual([]);
  });

  it("slots in a link message that arrives live, ignores plain ones, and drops a deleted one", async () => {
    const { view, seqs } = setup([{ messages: [message(5, "https://five.example")], hasMore: false }]);
    view.open(0);
    await flush();
    view.messageChanged(message(6, "no link"));
    expect(seqs()).toEqual(["5"]);
    view.messageChanged(message(8, "new https://eight.example"));
    view.messageChanged(message(6, "late https://six.example"));
    expect(seqs()).toEqual(["8", "6", "5"]);
    // A reaction-style update replaces the bubble in place.
    view.messageChanged({ ...message(6, "late https://six.example"), reactions: [] });
    expect(seqs()).toEqual(["8", "6", "5"]);
    view.messageDeleted(6);
    expect(seqs()).toEqual(["8", "5"]);
  });

  it("leaves an older arrival to its page while more is still to load", async () => {
    const { view, seqs } = setup([{ messages: [message(50, "https://fifty.example")], hasMore: true }]);
    view.open(0);
    await flush();
    view.messageChanged(message(10, "old https://ten.example"));
    expect(seqs()).toEqual(["50"]);
  });

  it("shows a retry when loading fails, and ignores a response after close", async () => {
    const { view, fetchPage } = setup([]);
    fetchPage.mockRejectedValueOnce(new Error("Couldn't load the links (500)."));
    view.open(0);
    await flush();
    const error = view.element.querySelector<HTMLElement>(".wx-srv-links-error")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Couldn't load the links (500).");
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-links-more")!.textContent).toBe("Try again");

    let release: (page: LinksPage) => void = () => {};
    fetchPage.mockImplementationOnce(() => new Promise<LinksPage>((resolve) => (release = resolve)));
    view.element.querySelector<HTMLButtonElement>(".wx-srv-links-more")!.click();
    view.close();
    release({ messages: [message(1, "https://late.example")], hasMore: false });
    await flush();
    expect(view.element.querySelectorAll(".wx-srv-links-item")).toHaveLength(0);
  });
});

describe("⋯ menu Links entry", () => {
  beforeEach(() => {
    getHistory.mockReset().mockResolvedValue({ messages: [], hasMore: false, cursor: 0 });
    getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
    getLinkMessages.mockReset().mockResolvedValue({ messages: [message(3, "https://three.example")], hasMore: false });
  });

  it("opens the filtered list, and a lock closes it", async () => {
    const identity: ServerIdentity = {
      getName: () => "Josh",
      setName: vi.fn(),
      getDeviceId: () => "d1",
      isMine: (sender: string) => sender.toLowerCase() === "josh",
    };
    const hooks: LockHooks = {
      suspend: vi.fn(() => () => {}),
      lockNow: vi.fn(),
      adoptBoundSession: vi.fn(),
      getBoundGrantId: vi.fn(() => null),
    };
    const win = {
      crypto: { randomUUID: () => "uuid" },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      navigator: window.navigator,
    } as unknown as Window;
    const view = mountServerThread({ identity, hooks, win, onSettings: vi.fn() });
    document.body.appendChild(view.element);
    await view.attach(SESSION);
    await flush();

    const overlay = view.element.querySelector<HTMLElement>(".wx-srv-links-view")!;
    expect(overlay.hidden).toBe(true);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-links")!.click();
    await flush();
    expect(getLinkMessages).toHaveBeenCalledTimes(1);
    expect(overlay.hidden).toBe(false);
    expect(overlay.querySelectorAll(".wx-srv-links-item")).toHaveLength(1);
    expect(overlay.querySelector(".wx-srv-bubble")).not.toBeNull();

    view.teardown();
    expect(overlay.hidden).toBe(true);
  });
});
