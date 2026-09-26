// How the Server chat thread hosts the pen (spec/server-chat/07-live-drawing.md §1, §5, §6):
// the Pen button in the HEADER (never the composer), the drawing layer beside the message list
// (never inside it, where every render would remove it), the stream's `drawing_live` and
// `message_deleted` events reaching the drawings, a history page's summaries fetching drawing
// bodies, and a lock turning the pen off.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredDrawing } from "../../src/server/api/drawings";
import type { HistoryPage, Message } from "../../src/server/api/messages";
import type { ServerIdentity } from "../../src/server/identity";
import { mountServerThread } from "../../src/server/thread";
import type { LockHooks, ServerSession } from "../../src/server/types";

const { getHistory, getUsage, getDrawings } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  getDrawings: vi.fn(),
}));
vi.mock("../../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/messages")>()),
  getHistory,
  getUsage,
}));
vi.mock("../../src/server/api/drawings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/drawings")>()),
  getDrawings,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function identity(): ServerIdentity {
  return {
    getName: () => "Alice",
    setName: vi.fn(),
    getDeviceId: () => "device-1",
    isMine: (sender) => sender.toLowerCase() === "alice",
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
    crypto: { randomUUID: () => "uuid-1" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  } as unknown as Window;
}

function message(seq: number, drawings?: Array<{ id: number; rev: number }>): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender: "Bob",
    text: `hello ${seq}`,
    attachments: [],
    reactions: [],
    createdAt: Date.now() / 1000,
    replyTo: null,
    ...(drawings === undefined ? {} : { drawings }),
  };
}

function page(messages: Message[]): HistoryPage {
  return { messages, hasMore: false, cursor: 10 };
}

function storedDrawing(id: number): StoredDrawing {
  return {
    id,
    rev: 1,
    sender: "Bob",
    columnWidth: 310,
    strokes: [{ strokeId: `stroke-${id}`, color: "#0a84ff", width: 8, points: [[10, 10], [20, 20]] }],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  getHistory.mockReset();
  getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 1, freeBytes: 1, erasurePending: false });
  getDrawings.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("thread + pen", () => {
  it("puts the Pen button in the header, before Settings, and its toolbar between the header and the thread", () => {
    const view = mountServerThread({ identity: identity(), hooks: hooks(), win: win(), onSettings: vi.fn() });
    const header = view.element.querySelector(".wx-srv-thread-header")!;
    const buttons = Array.from(header.querySelectorAll("button"), (b) => b.className);
    expect(buttons).toEqual(["wx-srv-pen-button", "wx-srv-settings-button", "wx-srv-panic-button"]);
    // Not in the composer (decisions/00169: a third composer control squeezed the text box).
    expect(view.element.querySelector(".wx-chat-composer .wx-srv-pen-button, .wx-chatc-input-row .wx-srv-pen-button")).toBeNull();
    const children = Array.from(view.element.children, (child) => child.className);
    expect(children.indexOf("wx-srv-pen-toolbar")).toBe(children.indexOf("wx-srv-thread-header") + 1);
    expect(children.indexOf("wx-srv-thread-wrap")).toBe(children.indexOf("wx-srv-pen-toolbar") + 1);
    view.teardown();
  });

  it("keeps the drawing layer beside the message list, so re-renders never remove it", async () => {
    getHistory.mockResolvedValue(page([message(1), message(2)]));
    const view = mountServerThread({ identity: identity(), hooks: hooks(), win: win(), onSettings: vi.fn() });
    document.body.appendChild(view.element);
    await view.attach(SESSION);
    const content = view.element.querySelector(".wx-srv-thread > .wx-srv-thread-content")!;
    expect(content.querySelector(":scope > .wx-srv-message-list")).not.toBeNull();
    const layer = content.querySelector(":scope > .wx-srv-drawing-layer");
    expect(layer).not.toBeNull();
    view.handleStreamEvent({ type: "message", message: message(3) });
    expect(content.querySelector(":scope > .wx-srv-drawing-layer")).toBe(layer);
    view.teardown();
  });

  it("a message's drawings summary fetches the bodies; message_deleted removes them in place", async () => {
    getHistory.mockResolvedValue(page([message(1), message(2, [{ id: 9, rev: 1 }])]));
    getDrawings.mockResolvedValue([storedDrawing(9)]);
    const view = mountServerThread({ identity: identity(), hooks: hooks(), win: win(), onSettings: vi.fn() });
    document.body.appendChild(view.element);
    await view.attach(SESSION);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(getDrawings).toHaveBeenCalledWith(SESSION, 2);
    const bubble = view.element.querySelector('[data-message-seq="1"]');
    expect(view.element.querySelectorAll("svg.wx-srv-drawing")).toHaveLength(1);

    view.handleStreamEvent({ type: "message_deleted", seq: 2 });
    expect(view.element.querySelectorAll("svg.wx-srv-drawing")).toHaveLength(0);
    // Only that message's drawings: the rest of the thread is untouched.
    expect(view.element.querySelector('[data-message-seq="1"]')).toBe(bubble);
    view.teardown();
  });

  it("a drawing_live stream event draws the other person's stroke; a wipe clears it", async () => {
    getHistory.mockResolvedValue(page([message(1), message(2)]));
    const view = mountServerThread({ identity: identity(), hooks: hooks(), win: win(), onSettings: vi.fn() });
    document.body.appendChild(view.element);
    await view.attach(SESSION);
    view.handleStreamEvent({
      type: "drawing_live",
      frame: {
        drawingClientId: "theirs",
        anchorSeq: 2,
        columnWidth: 310,
        strokeId: "live-1",
        batch: 0,
        color: "#ff3b30",
        width: 4,
        points: [[1, 1], [5, 5]],
        cancel: false,
      },
    });
    expect(view.element.querySelectorAll("svg.wx-srv-drawing-live")).toHaveLength(1);
    view.handleStreamEvent({ type: "wiped" });
    expect(view.element.querySelectorAll("svg.wx-srv-drawing-live")).toHaveLength(0);
    view.teardown();
  });

  it("a lock (detach) turns the pen off and removes the Draw surface", async () => {
    getHistory.mockResolvedValue(page([message(1)]));
    const view = mountServerThread({ identity: identity(), hooks: hooks(), win: win(), onSettings: vi.fn() });
    document.body.appendChild(view.element);
    await view.attach(SESSION);
    const pen = view.element.querySelector<HTMLButtonElement>(".wx-srv-pen-button")!;
    pen.click();
    expect(view.element.querySelector(".wx-srv-draw-surface")).not.toBeNull();
    view.detach();
    expect(pen.getAttribute("aria-pressed")).toBe("false");
    expect(view.element.querySelector(".wx-srv-draw-surface")).toBeNull();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-pen-toolbar")!.hidden).toBe(true);
    view.teardown();
  });
});
