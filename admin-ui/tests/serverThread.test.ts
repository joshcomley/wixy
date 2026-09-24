import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPage, Message, SendMessageResult } from "../src/server/api/messages";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerThread } from "../src/server/thread";
import type { UploadAttachment } from "../src/server/upload";
import type { ServerStreamEvent } from "../src/server/stream";
import type { LockHooks, ServerSession } from "../src/server/types";

const { getHistory, sendMessage, uploadServerAttachment } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  sendMessage: vi.fn(),
  uploadServerAttachment: vi.fn(),
}));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  sendMessage,
}));
vi.mock("../src/server/api/uploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/uploads")>()),
  uploadServerAttachment,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function fakeIdentity(name: string | null = "Josh"): ServerIdentity {
  return {
    getName: () => name,
    setName: vi.fn(),
    getDeviceId: () => "device-1",
    isMine: (sender: string) => name !== null && sender.toLowerCase() === name.toLowerCase(),
  };
}

function fakeHooks(): LockHooks {
  return {
    suspend: vi.fn(() => () => {}),
    lockNow: vi.fn(),
  };
}

function fakeWindow(): Window {
  return {
    crypto: { randomUUID: () => "generated-uuid-1234" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  } as unknown as Window;
}

function emptyHistory(overrides: Partial<HistoryPage> = {}): HistoryPage {
  return { messages: [], hasMore: false, cursor: 0, ...overrides };
}

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    seq: 1,
    clientId: "c1",
    sender: "Josh",
    text: "hi",
    attachments: [],
    createdAt: Date.now() / 1000,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("mountServerThread", () => {
  beforeEach(() => {
    getHistory.mockReset();
    sendMessage.mockReset();
    uploadServerAttachment.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attach() reloads history on reattach to refresh signed media URLs", async () => {
    getHistory
      .mockResolvedValueOnce(emptyHistory({ cursor: 42 }))
      .mockResolvedValueOnce(emptyHistory({ cursor: 43 }));
    const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });

    const first = await view.attach(SESSION);
    expect(first).toBe(42);
    expect(getHistory).toHaveBeenCalledTimes(1);

    const second = await view.attach(SESSION);
    expect(second).toBe(43);
    expect(getHistory).toHaveBeenCalledTimes(2);
    view.teardown();
  });

  it("replaces retained media URLs with signatures from the fresh unlock session", async () => {
    const older = fakeMessage({
      seq: 1,
      text: null,
      attachments: [{
        id: "photo-1", kind: "photo", status: "ready", width: 100, height: 80,
        durationS: null, peaks: null, urls: { thumb: "/old-thumb?exp=1", full: "/old-full?exp=1" },
      }],
    });
    const refreshed = fakeMessage({
      ...older,
      attachments: [{
        id: "photo-1", kind: "photo", status: "ready", width: 100, height: 80,
        durationS: null, peaks: null, urls: { thumb: "/new-thumb?exp=2", full: "/new-full?exp=2" },
      }],
    });
    getHistory
      .mockResolvedValueOnce(emptyHistory({ messages: [older], cursor: 1 }))
      .mockResolvedValueOnce(emptyHistory({ messages: [refreshed], cursor: 1 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    expect(view.element.querySelector(".wx-srv-photo-thumb img")?.getAttribute("src")).toBe("/old-thumb?exp=1");

    view.detach();
    const renewedSession: ServerSession = { token: "renewed-token", expiresAt: 99_999_999 };
    await view.attach(renewedSession);

    expect(getHistory).toHaveBeenLastCalledWith(renewedSession, { limit: 50 });
    expect(view.element.querySelector(".wx-srv-photo-thumb img")?.getAttribute("src")).toBe("/new-thumb?exp=2");
    view.teardown();
  });

  it("reattach removes messages deleted while the chat was locked", async () => {
    const kept = fakeMessage({ seq: 1, text: "keep after unlock" });
    const deleted = fakeMessage({ seq: 2, clientId: "c2", text: "deleted while locked" });
    getHistory
      .mockResolvedValueOnce(emptyHistory({ messages: [kept, deleted], cursor: 2 }))
      .mockResolvedValueOnce(emptyHistory({ messages: [kept], cursor: 4 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    expect(view.element.textContent).toContain("deleted while locked");

    view.detach();
    const cursor = await view.attach(SESSION);

    expect(cursor).toBe(4);
    expect(view.element.textContent).toContain("keep after unlock");
    expect(view.element.textContent).not.toContain("deleted while locked");
    view.teardown();
  });

  it("reattach clears retained messages after the chat was wiped while locked", async () => {
    getHistory
      .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "before wipe" })], cursor: 2 }))
      .mockResolvedValueOnce(emptyHistory({ cursor: 5 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    expect(view.element.textContent).toContain("before wipe");

    view.detach();
    const cursor = await view.attach(SESSION);

    expect(cursor).toBe(5);
    expect(view.element.querySelectorAll(".wx-srv-bubble")).toHaveLength(0);
    expect(view.element.querySelector(".wx-srv-thread-empty")?.textContent).toMatch(/no messages yet/i);
    view.teardown();
  });

  it("empty history shows the empty-state message", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);

    expect(view.element.querySelector(".wx-srv-thread-empty")?.textContent).toMatch(/no messages yet/i);
    view.teardown();
  });

  it("redraw and detach stop active media and release its playback suspension", async () => {
    getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage({
      seq: 1,
      text: null,
      attachments: [{
        id: "video-1", kind: "video", status: "ready", width: 64, height: 48,
        durationS: 2, peaks: null, urls: { play: "/video" },
      }],
    })] }));
    const release = vi.fn();
    const hooks: LockHooks = { suspend: vi.fn(() => release), lockNow: vi.fn() };
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks, win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);

    const firstVideo = view.element.querySelector<HTMLVideoElement>(".wx-srv-video")!;
    const pauseFirst = vi.spyOn(firstVideo, "pause").mockImplementation(() => {});
    const loadFirst = vi.spyOn(firstVideo, "load").mockImplementation(() => {});
    firstVideo.dispatchEvent(new Event("play"));
    view.handleStreamEvent({ type: "message", message: fakeMessage({ seq: 2, sender: "Purdy" }) });

    expect(firstVideo.closest(".wx-srv-message-list")).toBeNull();
    expect(pauseFirst).toHaveBeenCalledTimes(1);
    expect(loadFirst).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    const redrawnVideo = view.element.querySelector<HTMLVideoElement>(".wx-srv-video")!;
    const pauseRedrawn = vi.spyOn(redrawnVideo, "pause").mockImplementation(() => {});
    const loadRedrawn = vi.spyOn(redrawnVideo, "load").mockImplementation(() => {});
    redrawnVideo.dispatchEvent(new Event("play"));
    view.detach();
    expect(pauseRedrawn).toHaveBeenCalledTimes(1);
    expect(loadRedrawn).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
    view.teardown();
  });

  describe("send() — the clientId regression (measured live bug, 2026-09-14)", () => {
    it("sends a clientId within the backend's 8-64 char bound, not deviceId+uuid (73 chars)", async () => {
      // Measured against the REAL P1 backend during integration testing:
      // `${deviceId}:${uuid}` produced a 73-char clientId, which
      // POST /messages's `SendMessageIn` (§5.3: 8-64 chars) rejected with a
      // 422 on EVERY send — masked entirely by the optimistic echo, which
      // paints regardless of whether the network call ever succeeds. This
      // test pins the fix: clientId must be a single UUID (36 chars).
      getHistory.mockResolvedValue(emptyHistory());
      sendMessage.mockResolvedValue({ ok: true, message: fakeMessage({ clientId: "generated-uuid-1234" }) } satisfies SendMessageResult);
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "hello";
      view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [, input] = sendMessage.mock.calls[0] as [ServerSession, { clientId: string }];
      expect(input.clientId.length).toBeGreaterThanOrEqual(8);
      expect(input.clientId.length).toBeLessThanOrEqual(64);
      expect(input.clientId).toBe("generated-uuid-1234"); // exactly one cryptoRandomId() call
      view.teardown();
    });
  });

  it("sends staged attachment IDs and keeps an upload alive across detach/attach", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    sendMessage.mockResolvedValue({ ok: true, message: fakeMessage({
      clientId: "generated-uuid-1234",
      text: null,
      attachments: [{
        id: "attachment-1", kind: "photo", status: "processing", width: null, height: null,
        durationS: null, peaks: null, urls: {},
      }],
    }) } satisfies SendMessageResult);
    let resolveUpload!: (value: UploadAttachment) => void;
    uploadServerAttachment.mockReturnValue(new Promise((resolve) => { resolveUpload = resolve; }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();
    const [, , , uploadOptions] = uploadServerAttachment.mock.calls[0] as [File, "photo", ServerSession, { signal: AbortSignal }];

    view.detach();
    expect(uploadOptions.signal.aborted).toBe(false);
    resolveUpload({
      id: "attachment-1", kind: "photo", status: "processing", width: null, height: null,
      durationS: null, peaks: null, urls: {},
    });
    await flush();
    await view.attach(SESSION);
    view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
    await flush();

    const [, sent] = sendMessage.mock.calls[0] as [ServerSession, { attachmentIds: string[] }];
    expect(sent.attachmentIds).toEqual(["attachment-1"]);
    expect(view.element.querySelector(".wx-srv-bubble-mine .wx-srv-attachment-processing")?.textContent).toBe("Processing…");
    view.teardown();
  });

  describe("send() — optimistic echo", () => {
    it("paints an echo instantly, reconciled away once the send resolves", async () => {
      getHistory.mockResolvedValue(emptyHistory());
      let resolveSend!: (result: SendMessageResult) => void;
      sendMessage.mockReturnValue(new Promise((resolve) => { resolveSend = resolve; }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "hello there";
      view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();

      const echo = view.element.querySelector(".wx-srv-echo");
      expect(echo).not.toBeNull();
      expect(echo?.textContent).toContain("hello there");

      resolveSend({ ok: true, message: fakeMessage({ clientId: "generated-uuid-1234", sender: "Josh", text: "hello there" }) });
      await flush();

      expect(view.element.querySelector(".wx-srv-echo")).toBeNull();
      expect(view.element.querySelectorAll(".wx-srv-bubble-mine")).toHaveLength(1);
      view.teardown();
    });

    it("a failed send removes the echo, keeps the draft, and surfaces the error", async () => {
      getHistory.mockResolvedValue(emptyHistory());
      sendMessage.mockResolvedValue({ ok: false, kind: "invalid", detail: "text must be at most 4000 characters" } satisfies SendMessageResult);
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "too long";
      view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();

      expect(view.element.querySelector(".wx-srv-echo")).toBeNull();
      expect(textarea.value).toBe("too long");
      expect(view.element.querySelector(".wx-chat-composer-error")?.textContent).toBe(
        "text must be at most 4000 characters",
      );
      view.teardown();
    });

    it("a retry after failure reuses the same clientId; a new send after success mints a fresh one", async () => {
      getHistory.mockResolvedValue(emptyHistory());
      sendMessage
        .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
        .mockResolvedValueOnce({ ok: true, message: fakeMessage({ clientId: "uuid-1", text: "first" }) } satisfies SendMessageResult)
        .mockResolvedValueOnce({ ok: true, message: fakeMessage({ seq: 2, clientId: "uuid-2", text: "second" }) } satisfies SendMessageResult);
      let uuidCounter = 0;
      const win = { ...fakeWindow(), crypto: { randomUUID: () => `uuid-${++uuidCounter}` } } as unknown as Window;
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win, onSettings: vi.fn() });
      await view.attach(SESSION);

      const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
      const sendButton = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;

      textarea.value = "first";
      sendButton.click();
      await flush();
      const firstClientId = (sendMessage.mock.calls[0] as [ServerSession, { clientId: string }])[1].clientId;

      textarea.value = "first"; // retry, same text
      sendButton.click();
      await flush();
      const retryClientId = (sendMessage.mock.calls[1] as [ServerSession, { clientId: string }])[1].clientId;
      expect(retryClientId).toBe(firstClientId);

      textarea.value = "second";
      sendButton.click();
      await flush();
      const thirdClientId = (sendMessage.mock.calls[2] as [ServerSession, { clientId: string }])[1].clientId;
      expect(thirdClientId).not.toBe(firstClientId);
      view.teardown();
    });
  });

  describe("day separators + alignment", () => {
    it("groups messages by calendar day and aligns mine/theirs correctly", async () => {
      const day1 = new Date("2026-09-01T10:00:00Z").getTime() / 1000;
      const day2 = new Date("2026-09-02T10:00:00Z").getTime() / 1000;
      getHistory.mockResolvedValue(
        emptyHistory({
          messages: [
            fakeMessage({ seq: 1, sender: "Josh", text: "hi", createdAt: day1 }),
            fakeMessage({ seq: 2, sender: "Purdy", text: "hello", createdAt: day1 + 60 }),
            fakeMessage({ seq: 3, sender: "Josh", text: "next day", createdAt: day2 }),
          ],
        }),
      );
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      expect(view.element.querySelectorAll(".wx-srv-day-separator")).toHaveLength(2);
      const bubbles = view.element.querySelectorAll(".wx-srv-message-list .wx-srv-bubble");
      expect(bubbles).toHaveLength(3);
      expect(bubbles[0]?.className).toContain("wx-srv-bubble-mine");
      expect(bubbles[1]?.className).toContain("wx-srv-bubble-theirs");
      expect(bubbles[1]?.querySelector(".wx-srv-bubble-sender")?.textContent).toBe("Purdy");
      expect(bubbles[2]?.className).toContain("wx-srv-bubble-mine");
      view.teardown();
    });
  });

  describe("handleStreamEvent", () => {
    it("a message event adds the message to the thread", async () => {
      getHistory.mockResolvedValue(emptyHistory());
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.handleStreamEvent({ type: "message", message: fakeMessage({ sender: "Purdy", text: "live!" }) } as ServerStreamEvent);

      expect(view.element.textContent).toContain("live!");
      view.teardown();
    });

    it("a wiped event clears every message", async () => {
      getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage()] }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      expect(view.element.querySelectorAll(".wx-srv-bubble").length).toBeGreaterThan(0);

      view.handleStreamEvent({ type: "wiped" } as ServerStreamEvent);

      expect(view.element.querySelectorAll(".wx-srv-bubble")).toHaveLength(0);
      view.teardown();
    });

    it("a message_deleted event removes just that message", async () => {
      getHistory.mockResolvedValue(
        emptyHistory({ messages: [fakeMessage({ seq: 1, text: "keep" }), fakeMessage({ seq: 2, text: "delete me" })] }),
      );
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.handleStreamEvent({ type: "message_deleted", seq: 2 } as ServerStreamEvent);

      expect(view.element.textContent).toContain("keep");
      expect(view.element.textContent).not.toContain("delete me");
      view.teardown();
    });

    it("an unrecognized-but-locked event is handled without throwing (chatView owns the actual lock)", async () => {
      getHistory.mockResolvedValue(emptyHistory());
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      expect(() => view.handleStreamEvent({ type: "locked" } as ServerStreamEvent)).not.toThrow();
      view.teardown();
    });
  });

  describe("history load failure", () => {
    it("shows a retry affordance on a non-lock failure", async () => {
      getHistory.mockRejectedValueOnce(new Error("network down"));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const errorRow = view.element.querySelector<HTMLElement>(".wx-srv-history-error");
      expect(errorRow?.hidden).toBe(false);
      expect(errorRow?.textContent).toContain("network down");

      getHistory.mockResolvedValueOnce(emptyHistory({ cursor: 5 }));
      errorRow?.querySelector("button")?.click();
      await flush();

      expect(view.element.querySelector<HTMLElement>(".wx-srv-history-error")?.hidden).toBe(true);
      view.teardown();
    });
  });

  describe("settings + header", () => {
    it("renders the header with title, name chip, settings and panic buttons", () => {
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      expect(view.element.querySelector(".wx-srv-thread-title")?.textContent).toBe("Server");
      expect(view.element.querySelector(".wx-srv-name-chip")?.textContent).toBe("Josh");
      expect(view.element.querySelector(".wx-srv-panic-button")?.getAttribute("aria-label")).toBe("Close");
      view.teardown();
    });

    it("the settings button calls onSettings", () => {
      const onSettings = vi.fn();
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings });
      const settingsButton = view.element.querySelector<HTMLButtonElement>(".wx-srv-settings-button");
      expect(settingsButton?.hasAttribute("data-srv-gesture-boundary")).toBe(true);
      settingsButton?.click();
      expect(onSettings).toHaveBeenCalledTimes(1);
      view.teardown();
    });

    it("the panic button locks with cause panic", () => {
      const hooks = fakeHooks();
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks, win: fakeWindow(), onSettings: vi.fn() });
      view.element.querySelector<HTMLButtonElement>(".wx-srv-panic-button")?.click();
      expect(hooks.lockNow).toHaveBeenCalledWith("panic");
      view.teardown();
    });

    it("refreshNameChip re-reads the identity's current name", () => {
      let currentName = "Josh";
      const identity: ServerIdentity = {
        getName: () => currentName,
        setName: vi.fn(),
        getDeviceId: () => "device-1",
        isMine: (sender) => sender.toLowerCase() === currentName.toLowerCase(),
      };
      const view = mountServerThread({ identity, hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      currentName = "Renamed";
      view.refreshNameChip();
      expect(view.element.querySelector(".wx-srv-name-chip")?.textContent).toBe("Renamed");
      view.teardown();
    });
  });
});
