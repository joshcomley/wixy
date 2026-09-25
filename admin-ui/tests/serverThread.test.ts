import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactionRequestError, type Attachment, type HistoryPage, type Message, type SendMessageResult } from "../src/server/api/messages";
import { ServerErasureOutcomeUnknownError, ServerLockedError } from "../src/server/api/http";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerSettingsSheet } from "../src/server/settingsSheet";
import { mountServerThread } from "../src/server/thread";
import { UploadError, type UploadAttachment } from "../src/server/upload";
import type { ServerStreamEvent } from "../src/server/stream";
import type { LockHooks, ServerSession } from "../src/server/types";

const { createVoiceRecorder, deleteMessage, getHistory, getUsage, sendMessage, setReaction, wipeChat, uploadServerAttachment } = vi.hoisted(() => ({
  createVoiceRecorder: vi.fn((options: {
    onStop?: (recording: { blob: Blob; durationMs: number; mimeType: string }) => void;
    onCancel?: () => void;
  }) => {
    let state: "idle" | "recording" = "idle";
    return {
      get state() { return state; },
      elapsedMs: 2000,
      start: vi.fn(async () => { state = "recording"; }),
      stop: vi.fn(() => {
        state = "idle";
        options.onStop?.({ blob: new Blob(["voice"]), durationMs: 2000, mimeType: "audio/webm;codecs=opus" });
      }),
      cancel: vi.fn(() => { state = "idle"; options.onCancel?.(); }),
      detach: vi.fn(),
    };
  }),
  deleteMessage: vi.fn(),
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  sendMessage: vi.fn(),
  setReaction: vi.fn(),
  wipeChat: vi.fn(),
  uploadServerAttachment: vi.fn(),
}));
vi.mock("../src/server/recorder", () => ({ createVoiceRecorder }));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
  sendMessage,
  setReaction,
  deleteMessage,
  wipeChat,
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

function fakeWindow(randomUUID: () => string = () => "generated-uuid-1234"): Window {
  return {
    crypto: { randomUUID },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  } as unknown as Window;
}

function fakeWindowWithIntersection(): { win: Window; intersect: () => void } {
  let callback: IntersectionObserverCallback | null = null;
  const FakeIntersectionObserver = class {
    constructor(onIntersect: IntersectionObserverCallback) {
      callback = onIntersect;
    }
    observe(): void {}
    disconnect(): void {}
  } as unknown as typeof IntersectionObserver;
  const win = fakeWindow();
  Object.defineProperty(win, "IntersectionObserver", { value: FakeIntersectionObserver });
  return {
    win,
    intersect: () => callback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
  };
}

function touchPointer(type: string, x: number, y: number): PointerEvent {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: "touch" },
    pointerId: { value: 1 },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
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
    reactions: [],
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
    createVoiceRecorder.mockClear();
    getHistory.mockReset();
    getUsage.mockReset().mockResolvedValue({
      mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false,
    });
    sendMessage.mockReset();
    setReaction.mockReset();
    deleteMessage.mockReset();
    wipeChat.mockReset();
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

  it("ordinary updates preserve active media while detach stops it", async () => {
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

    expect(view.element.querySelector(".wx-srv-video")).toBe(firstVideo);
    expect(firstVideo.closest(".wx-srv-message-list")).not.toBeNull();
    expect(pauseFirst).not.toHaveBeenCalled();
    expect(loadFirst).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    view.detach();
    expect(pauseFirst).toHaveBeenCalledTimes(1);
    expect(loadFirst).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
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

  it("sends a stopped voice note alone immediately and preserves the current draft", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment.mockImplementation(async (_file, kind) => ({
      id: kind === "voice" ? "voice-id" : "photo-id",
      kind,
      status: "processing",
      width: null,
      height: null,
      durationS: kind === "voice" ? 2 : null,
      peaks: null,
      urls: {},
    } satisfies UploadAttachment));
    sendMessage.mockResolvedValue({
      ok: true,
      message: fakeMessage({
        clientId: "generated-uuid-1234",
        text: null,
        attachments: [{
          id: "voice-id", kind: "voice", status: "processing", width: null, height: null,
          durationS: 2, peaks: null, urls: {},
        }],
      }),
    } satisfies SendMessageResult);
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);

    const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "draft text";
    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const stagedPhoto = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [stagedPhoto], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    view.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")?.click();
    await flush();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")?.click();
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, sent] = sendMessage.mock.calls[0] as [ServerSession, { text: string | null; attachmentIds: string[] }];
    expect(sent.text).toBeNull();
    expect(sent.attachmentIds).toEqual(["voice-id"]);
    expect(textarea.value).toBe("draft text");
    expect(view.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(1);
    expect((uploadServerAttachment.mock.calls[0] as [File])[0]).toBe(stagedPhoto);
    view.teardown();
  });

  it("shows a retry control when a voice-note upload fails", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment
      .mockRejectedValueOnce(new Error("upload broke"))
      .mockResolvedValueOnce({
        id: "voice-id", kind: "voice", status: "processing", width: null, height: null,
        durationS: 2, peaks: null, urls: {},
      } satisfies UploadAttachment);
    sendMessage.mockResolvedValue({
      ok: true,
      message: fakeMessage({ clientId: "generated-uuid-1234", text: null }),
    } satisfies SendMessageResult);
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")?.click();
    await flush();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")?.click();
    await flush();

    expect(view.element.querySelector(".wx-chat-composer-error")?.textContent).toContain("voice note");
    const retry = view.element.querySelector<HTMLButtonElement>(".wx-srv-retry-voice-button");
    expect(retry).not.toBeNull();
    retry?.click();
    await flush();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-retry-voice-button")?.hidden).toBe(true);
    view.teardown();
  });

  // F17 (audit round 4): a failed voice note used to disable the mic until the owner
  // routed away and back (which also locks). A resend that can never succeed — a 422
  // because the attachment failed processing or was reaped — left "Retry voice note"
  // failing forever with no way out.
  describe("a voice note that cannot be sent (F17)", () => {
    const voiceAttachment = (id = "voice-id"): UploadAttachment => ({
      id, kind: "voice", status: "processing", width: null, height: null, durationS: 2, peaks: null, urls: {},
    });
    const button = (view: { element: HTMLElement }, selector: string) =>
      view.element.querySelector<HTMLButtonElement>(selector);
    const mic = (view: { element: HTMLElement }) => button(view, ".wx-srv-record-button");
    const retry = (view: { element: HTMLElement }) => button(view, ".wx-srv-retry-voice-button");
    const discard = (view: { element: HTMLElement }) => button(view, ".wx-srv-discard-voice-button");
    const composerError = (view: { element: HTMLElement }) =>
      view.element.querySelector(".wx-chat-composer-error")?.textContent ?? "";

    async function recordVoiceNote(view: { element: HTMLElement }): Promise<void> {
      mic(view)?.click();
      await flush();
      mic(view)?.click();
      await flush();
      await flush();
    }

    // An INCREMENTING UUID (L7): with the shared constant, "same clientId" assertions were
    // vacuous - a mutant that minted a fresh clientId on every retry survived.
    async function mountView(hooks: LockHooks = fakeHooks()) {
      getHistory.mockResolvedValue(emptyHistory());
      let minted = 0;
      const view = mountServerThread({
        identity: fakeIdentity("Josh"),
        hooks,
        win: fakeWindow(() => `client-uuid-${++minted}`),
        onSettings: vi.fn(),
      });
      await view.attach(SESSION);
      return view;
    }
    const sentInputs = () =>
      sendMessage.mock.calls.map((call) => call[1] as { clientId: string; attachmentIds: string[] });

    // M1 (reviewer): the 401 path is the property that matters most - a dead token must
    // lock the chat and KEEP the recording, which the next unlock resends automatically.
    // It was only covered at the sendMessage level, so a refactor that dropped lockNow or
    // discarded the note on ServerLockedError still passed every test.
    describe("a 401 while a voice note is going out (M1)", () => {
      const okSend = (seq: number): SendMessageResult => ({
        ok: true,
        message: fakeMessage({ seq, clientId: "client-uuid-1", text: null }),
      });

      it("on the SEND: locks, keeps the note, and the next unlock resends it with the same clientId and attachment", async () => {
        uploadServerAttachment.mockResolvedValue(voiceAttachment());
        sendMessage.mockRejectedValueOnce(new ServerLockedError()).mockResolvedValueOnce(okSend(11));
        const hooks = fakeHooks();
        const view = await mountView(hooks);
        await recordVoiceNote(view);

        expect(hooks.lockNow).toHaveBeenCalledOnce();
        expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized");
        // Kept, not discarded: no discard message, no second recording while it is pending.
        expect(composerError(view)).toBe("");
        expect(mic(view)?.disabled).toBe(true);

        view.detach(); // the lock
        await view.attach({ token: "fresh", expiresAt: 9_999_999_999 }); // the next unlock
        await flush();
        await flush();

        const inputs = sentInputs();
        expect(inputs).toHaveLength(2);
        expect(inputs[1]?.clientId).toBe(inputs[0]?.clientId);
        expect(inputs[0]?.attachmentIds).toEqual(["voice-id"]);
        expect(inputs[1]?.attachmentIds).toEqual(["voice-id"]);
        expect(uploadServerAttachment).toHaveBeenCalledOnce(); // not re-uploaded
        expect(sendMessage.mock.calls[1]?.[0]).toMatchObject({ token: "fresh" });
        expect(mic(view)?.disabled).toBe(false);
        expect(view.element.querySelectorAll(".wx-srv-bubble-mine")).toHaveLength(1);
        view.teardown();
      });

      it("on the UPLOAD: locks, keeps the recording, and the next unlock uploads and sends it", async () => {
        uploadServerAttachment
          .mockRejectedValueOnce(new ServerLockedError())
          .mockResolvedValueOnce(voiceAttachment());
        sendMessage.mockResolvedValueOnce(okSend(12));
        const hooks = fakeHooks();
        const view = await mountView(hooks);
        await recordVoiceNote(view);

        expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized");
        expect(composerError(view)).toBe("");
        expect(sendMessage).not.toHaveBeenCalled();

        view.detach();
        await view.attach({ token: "fresh", expiresAt: 9_999_999_999 });
        await flush();
        await flush();

        expect(uploadServerAttachment).toHaveBeenCalledTimes(2); // the same recording, uploaded afresh
        expect(sentInputs()).toHaveLength(1);
        expect(mic(view)?.disabled).toBe(false);
        view.teardown();
      });

      it("on a RETRY after a transient failure: locks and still keeps the note", async () => {
        uploadServerAttachment.mockResolvedValue(voiceAttachment());
        sendMessage
          .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
          .mockRejectedValueOnce(new ServerLockedError())
          .mockResolvedValueOnce(okSend(13));
        const hooks = fakeHooks();
        const view = await mountView(hooks);
        await recordVoiceNote(view);
        expect(retry(view)?.hidden).toBe(false);

        retry(view)?.click();
        await flush();
        await flush();
        expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized");
        expect(composerError(view)).toBe("");

        view.detach();
        await view.attach({ token: "fresh", expiresAt: 9_999_999_999 });
        await flush();
        await flush();

        const inputs = sentInputs();
        expect(inputs).toHaveLength(3);
        expect(new Set(inputs.map((input) => input.clientId)).size).toBe(1);
        expect(uploadServerAttachment).toHaveBeenCalledOnce();
        view.teardown();
      });
    });

    it("offers Discard next to Retry after a transient failure, and discarding frees the mic for a new note", async () => {
      uploadServerAttachment.mockResolvedValue(voiceAttachment());
      sendMessage
        .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
        .mockResolvedValueOnce({
          ok: true,
          message: fakeMessage({ seq: 5, clientId: "generated-uuid-1234", text: null }),
        } satisfies SendMessageResult);
      const view = await mountView();
      await recordVoiceNote(view);

      expect(retry(view)?.hidden).toBe(false);
      expect(discard(view)?.hidden).toBe(false);
      expect(discard(view)?.textContent).toBe("Discard");
      expect(mic(view)?.disabled).toBe(true); // a note is pending: no second recording yet

      discard(view)?.click();
      await flush();

      expect(retry(view)?.hidden).toBe(true);
      expect(discard(view)?.hidden).toBe(true);
      expect(composerError(view)).toBe("");
      expect(mic(view)?.disabled).toBe(false);
      expect(view.element.querySelector(".wx-srv-record-status")?.hasAttribute("hidden")).toBe(true);

      await recordVoiceNote(view);
      expect(uploadServerAttachment).toHaveBeenCalledTimes(2); // the discarded note is not resent
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(discard(view)?.hidden).toBe(true);
      expect(mic(view)?.disabled).toBe(false);
      view.teardown();
    });

    it("a transient failure keeps the retry path: same clientId, no second upload", async () => {
      uploadServerAttachment.mockResolvedValue(voiceAttachment());
      sendMessage
        .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
        .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
        .mockResolvedValueOnce({
          ok: true,
          message: fakeMessage({ seq: 6, clientId: "generated-uuid-1234", text: null }),
        } satisfies SendMessageResult);
      const view = await mountView();
      await recordVoiceNote(view);
      retry(view)?.click();
      await flush();
      await flush();
      // A second transient failure: still retryable, still discardable.
      expect(retry(view)?.hidden).toBe(false);
      expect(discard(view)?.hidden).toBe(false);
      expect(composerError(view)).toBe("Couldn't send voice note. Try again.");

      retry(view)?.click();
      await flush();
      await flush();

      const inputs = sendMessage.mock.calls.map((call) => call[1] as { clientId: string; attachmentIds: string[] });
      expect(inputs).toHaveLength(3);
      expect(new Set(inputs.map((input) => input.clientId)).size).toBe(1);
      expect(inputs.every((input) => input.attachmentIds[0] === "voice-id")).toBe(true);
      expect(uploadServerAttachment).toHaveBeenCalledOnce();
      expect(retry(view)?.hidden).toBe(true);
      expect(discard(view)?.hidden).toBe(true);
      expect(mic(view)?.disabled).toBe(false);
      view.teardown();
    });

    it.each([
      ["a 422 (the attachment failed processing or was reaped)",
        { ok: false, kind: "invalid", detail: "attachment voice-id is unknown, already used, or failed" }],
      ["a 404", { ok: false, kind: "rejected", status: 404 }],
    ] as const)("%s on the retry is definitive: it is discarded with a clear message and the mic is free", async (_name, rejection) => {
      uploadServerAttachment.mockResolvedValue(voiceAttachment());
      sendMessage
        .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
        .mockResolvedValueOnce(rejection as SendMessageResult)
        .mockResolvedValueOnce({
          ok: true,
          message: fakeMessage({ seq: 7, clientId: "generated-uuid-1234", text: null }),
        } satisfies SendMessageResult);
      const view = await mountView();
      await recordVoiceNote(view);
      expect(retry(view)?.hidden).toBe(false);

      retry(view)?.click();
      await flush();
      await flush();

      expect(composerError(view)).toBe(
        "The server couldn't accept that voice note, so it was discarded. Record it again.",
      );
      expect(composerError(view)).not.toContain("voice-id"); // no raw server detail / ids
      expect(retry(view)?.hidden).toBe(true);
      expect(discard(view)?.hidden).toBe(true);
      expect(mic(view)?.disabled).toBe(false);

      await recordVoiceNote(view);
      expect(uploadServerAttachment).toHaveBeenCalledTimes(2);
      expect(sendMessage).toHaveBeenCalledTimes(3);
      expect(composerError(view)).toBe("");
      view.teardown();
    });

    it("a definitive rejection on the FIRST send is discarded straight away, not left to retry forever", async () => {
      uploadServerAttachment.mockResolvedValue(voiceAttachment());
      sendMessage.mockResolvedValue({ ok: false, kind: "invalid", detail: "bad attachment" } satisfies SendMessageResult);
      const view = await mountView();
      await recordVoiceNote(view);

      expect(retry(view)?.hidden).toBe(true);
      expect(discard(view)?.hidden).toBe(true);
      expect(mic(view)?.disabled).toBe(false);
      expect(composerError(view)).toBe(
        "The server couldn't accept that voice note, so it was discarded. Record it again.",
      );
      view.teardown();
    });

    it("an upload the server rejects (413) is discarded with the upload's own message", async () => {
      uploadServerAttachment.mockRejectedValue(new UploadError("This file is too large.", 413));
      const view = await mountView();
      await recordVoiceNote(view);

      expect(composerError(view)).toBe(
        "This file is too large. The voice note was discarded — record it again.",
      );
      expect(retry(view)?.hidden).toBe(true);
      expect(discard(view)?.hidden).toBe(true);
      expect(mic(view)?.disabled).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
      view.teardown();
    });

    // L8 (reviewer): the accessible name of Retry ("Retry sending voice note") did not
    // contain its visible text ("Retry voice note"), which breaks voice-control users
    // (WCAG 2.5.3), and pressing Retry/Discard hid the focused button so keyboard and
    // screen-reader focus fell back to the top of the page.
    describe("accessibility of the failed-note controls (L8)", () => {
      afterEach(() => {
        document.body.innerHTML = "";
      });

      it("Retry and Discard are named by their visible text", async () => {
        uploadServerAttachment.mockResolvedValue(voiceAttachment());
        sendMessage.mockResolvedValue({ ok: false, kind: "unavailable" } satisfies SendMessageResult);
        const view = await mountView();
        await recordVoiceNote(view);

        for (const control of [retry(view), discard(view)]) {
          const visible = control?.textContent ?? "";
          const label = control?.getAttribute("aria-label") ?? null;
          expect(visible).not.toBe("");
          // Either no aria-label (the text IS the name) or one that contains the visible text.
          expect(label === null || label.includes(visible)).toBe(true);
        }
        view.teardown();
      });

      it("keeps focus on Retry when it fails again, and moves it to the mic once resolved", async () => {
        uploadServerAttachment.mockResolvedValue(voiceAttachment());
        sendMessage
          .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
          .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
          .mockResolvedValueOnce({
            ok: true,
            message: fakeMessage({ seq: 21, clientId: "client-uuid-1", text: null }),
          } satisfies SendMessageResult);
        const view = await mountView();
        document.body.appendChild(view.element);
        await recordVoiceNote(view);

        retry(view)?.focus();
        retry(view)?.click();
        await flush();
        await flush();
        expect(document.activeElement).toBe(retry(view)); // failed again: stay put

        retry(view)?.focus();
        retry(view)?.click();
        await flush();
        await flush();
        expect(retry(view)?.hidden).toBe(true);
        expect(document.activeElement).toBe(mic(view)); // sent: the mic is free
        view.teardown();
      });

      it("Discard hands focus to the mic instead of dropping it", async () => {
        uploadServerAttachment.mockResolvedValue(voiceAttachment());
        sendMessage.mockResolvedValue({ ok: false, kind: "unavailable" } satisfies SendMessageResult);
        const view = await mountView();
        document.body.appendChild(view.element);
        await recordVoiceNote(view);

        discard(view)?.focus();
        discard(view)?.click();
        await flush();

        expect(discard(view)?.hidden).toBe(true);
        expect(document.activeElement).toBe(mic(view));
        view.teardown();
      });
    });

    // M2: auto-discard is for a verdict on the FILE itself (400/413/415: it will be judged
    // the same way every time). A 403 (Cloudflare Access / WAF) or a 404/409/422 at the
    // upload stage is about the session or the gateway - the recording is still held
    // locally, so a fresh upload can succeed and the note must be kept for Retry.
    it.each([403, 404, 409, 422])(
      "an upload refused with a %i keeps the recording for Retry instead of discarding it",
      async (status) => {
        uploadServerAttachment
          .mockRejectedValueOnce(new UploadError("The upload could not be completed. Please try again.", status))
          .mockResolvedValueOnce(voiceAttachment());
        sendMessage.mockResolvedValue({
          ok: true,
          message: fakeMessage({ seq: 9, clientId: "generated-uuid-1234", text: null }),
        } satisfies SendMessageResult);
        const view = await mountView();
        await recordVoiceNote(view);

        expect(retry(view)?.hidden).toBe(false);
        expect(discard(view)?.hidden).toBe(false);
        expect(composerError(view)).toContain("Couldn't send voice note");
        expect(composerError(view)).not.toContain("discarded");

        retry(view)?.click();
        await flush();
        await flush();
        expect(uploadServerAttachment).toHaveBeenCalledTimes(2); // the SAME recording, re-uploaded
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(retry(view)?.hidden).toBe(true);
        expect(mic(view)?.disabled).toBe(false);
        view.teardown();
      },
    );

    it.each([400, 413, 415])("an upload refused with a %i (a verdict on the file) is discarded", async (status) => {
      uploadServerAttachment.mockRejectedValue(new UploadError("This file type isn't supported.", status));
      const view = await mountView();
      await recordVoiceNote(view);

      expect(composerError(view)).toBe(
        "This file type isn't supported. The voice note was discarded — record it again.",
      );
      expect(retry(view)?.hidden).toBe(true);
      expect(mic(view)?.disabled).toBe(false);
      view.teardown();
    });

    it("an upload that fails without a verdict (network) stays retryable and discardable", async () => {
      uploadServerAttachment.mockRejectedValue(new TypeError("Failed to fetch"));
      const view = await mountView();
      await recordVoiceNote(view);

      expect(composerError(view)).toContain("Couldn't send voice note");
      expect(retry(view)?.hidden).toBe(false);
      expect(discard(view)?.hidden).toBe(false);
      discard(view)?.click();
      await flush();
      expect(mic(view)?.disabled).toBe(false);
      view.teardown();
    });
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

    it("does not restore an older history page after a wipe", async () => {
      let resolveOlder!: (page: HistoryPage) => void;
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 2, text: "current" })], hasMore: true }))
        .mockImplementationOnce(() => new Promise<HistoryPage>((resolve) => { resolveOlder = resolve; }));
      const { win, intersect } = fakeWindowWithIntersection();
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win, onSettings: vi.fn() });
      await view.attach(SESSION);
      intersect();
      await flush();

      view.handleStreamEvent({ type: "wiped" } as ServerStreamEvent);
      resolveOlder(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "stale older message" })] }));
      await flush();

      expect(view.element.textContent).not.toContain("current");
      expect(view.element.textContent).not.toContain("stale older message");
      view.teardown();
    });

    it("does not restore a separately deleted message from a pending older page", async () => {
      let resolveOlder!: (page: HistoryPage) => void;
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 2, text: "keep" })], hasMore: true }))
        .mockImplementationOnce(() => new Promise<HistoryPage>((resolve) => { resolveOlder = resolve; }));
      const { win, intersect } = fakeWindowWithIntersection();
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win, onSettings: vi.fn() });
      await view.attach(SESSION);
      intersect();
      await flush();

      view.handleStreamEvent({ type: "message_deleted", seq: 1 } as ServerStreamEvent);
      resolveOlder(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "deleted elsewhere" })] }));
      await flush();

      expect(view.element.textContent).toContain("keep");
      expect(view.element.textContent).not.toContain("deleted elsewhere");
      view.teardown();
    });

    it("keeps an in-flight local delete tombstoned against a stale history page", async () => {
      let resolveOlder!: (page: HistoryPage) => void;
      let resolveDelete!: () => void;
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "delete this" })], hasMore: true }))
        .mockImplementationOnce(() => new Promise<HistoryPage>((resolve) => { resolveOlder = resolve; }));
      deleteMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
      const { win, intersect } = fakeWindowWithIntersection();
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win, onSettings: vi.fn() });
      await view.attach(SESSION);
      intersect();
      await flush();

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-delete")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-delete-confirm-button")?.click();
      resolveOlder(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "stale delete this" })] }));
      await flush();
      view.handleStreamEvent({ type: "message_deleted", seq: 1 } as ServerStreamEvent);
      resolveDelete();
      await flush();

      expect(view.element.textContent).not.toContain("delete this");
      expect(view.element.textContent).not.toContain("stale delete this");
      view.teardown();
    });

    it("does not restore a failed optimistic delete after a wipe", async () => {
      let rejectDelete!: (error: Error) => void;
      getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage({ text: "deleted by wipe" })] }));
      deleteMessage.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectDelete = reject; }));
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-delete")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-delete-confirm-button")?.click();
      view.handleStreamEvent({ type: "wiped" } as ServerStreamEvent);
      rejectDelete(new Error("network"));
      await flush();

      expect(view.element.textContent).not.toContain("deleted by wipe");
      expect(view.element.textContent).not.toContain("Couldn't delete message");
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

    it("deletes optimistically from the message action sheet", async () => {
      vi.useFakeTimers();
      getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage({ text: "remove me" })] }));
      deleteMessage.mockResolvedValue(undefined);
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-delete")?.click();
      expect(view.element.textContent).toContain("Delete this message for everyone?");
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-delete-confirm-button")?.click();
      await flush();

      expect(deleteMessage).toHaveBeenCalledWith(SESSION, 1);
      expect(view.element.querySelector(".wx-srv-bubble")?.classList.contains("wx-srv-bubble-deleting")).toBe(true);
      vi.advanceTimersByTime(200);
      await flush();
      expect(view.element.textContent).not.toContain("remove me");
      view.teardown();
    });

    it("restores a failed optimistic delete with an error line", async () => {
      getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage({ text: "keep on error" })] }));
      deleteMessage.mockRejectedValue(new Error("network"));
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-delete")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-delete-confirm-button")?.click();
      await flush();

      expect(view.element.textContent).toContain("keep on error");
      expect(view.element.textContent).toContain("Couldn't delete message. Try again.");
      view.teardown();
    });

    it("restores an unknown DELETE after retry exhaustion with the confirm copy", async () => {
      getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage({ text: "remove me" })] }));
      deleteMessage.mockRejectedValue(new ServerErasureOutcomeUnknownError());
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-delete")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-delete-confirm-button")?.click();
      await flush();

      expect(view.element.textContent).toContain("remove me");
      expect(view.element.querySelector(".wx-srv-message-delete-error")?.textContent)
        .toBe("Couldn't confirm the delete — try again");
      view.teardown();
    });

    it("removes a restored delete bubble when its late message_deleted event arrives", async () => {
      getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage({ text: "late delete" })] }));
      deleteMessage.mockRejectedValue(new ServerErasureOutcomeUnknownError());
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-delete")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-delete-confirm-button")?.click();
      await flush();
      expect(view.element.textContent).toContain("late delete");

      view.handleStreamEvent({ type: "message_deleted", seq: 1 });
      expect(view.element.textContent).not.toContain("late delete");
      view.teardown();
    });

    it("the settings sheet's wipe call clears local history after success", async () => {
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "gone" })] }))
        .mockResolvedValueOnce(emptyHistory());
      wipeChat.mockResolvedValue(false);
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      await view.wipe();

      expect(wipeChat).toHaveBeenCalledWith(SESSION);
      expect(view.element.textContent).not.toContain("gone");
      view.teardown();
    });

    it.each(["committed", "not committed"] as const)(
      "shows wipe outcome checking before slow history reconciliation completes (%s)",
      async (outcome) => {
        const oldMessage = fakeMessage({ seq: 1, text: "old before wipe" });
        let resolveHistory!: (page: HistoryPage) => void;
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [oldMessage] }))
          .mockImplementationOnce(() => new Promise<HistoryPage>((resolve) => { resolveHistory = resolve; }));
        wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
        const identity = fakeIdentity();
        const hooks = fakeHooks();
        const view = mountServerThread({ identity, hooks, win: fakeWindow(), onSettings: vi.fn() });
        await view.attach(SESSION);
        const sheet = mountServerSettingsSheet({
          identity,
          hooks,
          win: window,
          getSession: () => SESSION,
          onWipe: (onOutcomeUnknown) => view.wipe(onOutcomeUnknown),
          onNameChanged: vi.fn(),
          onClose: vi.fn(),
        });
        document.body.appendChild(sheet.element);
        sheet.open();
        await flush();

        sheet.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe")?.click();
        sheet.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")?.click();
        await flush();
        expect(sheet.element.querySelector(".wx-srv-sheet-wipe-status")?.textContent)
          .toBe("Couldn't confirm — checking…");
        expect(sheet.element.querySelector<HTMLDivElement>(".wx-srv-sheet-wipe-confirm")?.hidden).toBe(true);

        resolveHistory(outcome === "committed" ? emptyHistory() : emptyHistory({ messages: [oldMessage] }));
        if (outcome === "committed") {
          await vi.waitFor(() => expect(sheet.element.querySelector(".wx-srv-sheet-wipe-status")?.textContent)
            .toBe("Deleted. Erasing leftover traces…"));
        } else {
          await vi.waitFor(() => expect(sheet.element.querySelector(".wx-srv-sheet-wipe-error")?.textContent)
            .toBe("Couldn't delete everything — try again"));
          expect(sheet.element.querySelector<HTMLDivElement>(".wx-srv-sheet-wipe-confirm")?.hidden).toBe(false);
        }
        expect(wipeChat).toHaveBeenCalledOnce();
        sheet.teardown();
        view.teardown();
      },
    );

    // F16 (audit round 4): a wipe whose outcome cannot be confirmed used to leave the
    // sheet on "Couldn't confirm — checking…" with the wipe control disabled for good,
    // because nothing told it about the stream's `wiped` event or a later successful
    // history load. These drive the REAL thread + REAL sheet together.
    describe("an unconfirmed wipe that cannot be reconciled straight away (F16)", () => {
      const CHECKING = "Couldn't confirm — checking…";

      async function startUnconfirmedWipe() {
        const identity = fakeIdentity();
        const hooks = fakeHooks();
        const view = mountServerThread({ identity, hooks, win: fakeWindow(), onSettings: vi.fn() });
        await view.attach(SESSION);
        const sheet = mountServerSettingsSheet({
          identity,
          hooks,
          win: window,
          getSession: () => SESSION,
          onWipe: (onOutcomeUnknown) => view.wipe(onOutcomeUnknown),
          onNameChanged: vi.fn(),
          onClose: vi.fn(),
        });
        document.body.appendChild(sheet.element);
        sheet.open();
        await vi.advanceTimersByTimeAsync(0);
        sheet.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe")?.click();
        sheet.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")?.click();
        await vi.advanceTimersByTimeAsync(0);
        return {
          view,
          sheet,
          status: () => sheet.element.querySelector(".wx-srv-sheet-wipe-status")?.textContent,
          statusHidden: () => sheet.element.querySelector<HTMLElement>(".wx-srv-sheet-wipe-status")?.hidden,
          wipeButton: () => sheet.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe"),
          confirmHidden: () => sheet.element.querySelector<HTMLElement>(".wx-srv-sheet-wipe-confirm")?.hidden,
          errorText: () => sheet.element.querySelector(".wx-srv-sheet-wipe-error")?.textContent,
        };
      }

      beforeEach(() => {
        vi.useFakeTimers();
        wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
      });
      afterEach(() => {
        document.body.innerHTML = "";
      });

      it("a gateway 504 on the wipe is reconciled, not shown as a failure that invites a second wipe (M3)", async () => {
        // The REAL wipeChat status mapping (only the mocked module boundary is replaced):
        // a committed wipe answered with a gateway timeout looks exactly like this.
        const { wipeChat: realWipeChat } = await vi.importActual<typeof import("../src/server/api/messages")>(
          "../src/server/api/messages",
        );
        vi.stubGlobal("fetch", vi.fn(async () => new Response("gateway timeout", { status: 504 })));
        wipeChat.mockImplementation((session: ServerSession) => realWipeChat(session));
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "old before wipe" })] }))
          .mockResolvedValueOnce(emptyHistory()); // the wipe DID commit
        try {
          const wipe = await startUnconfirmedWipe();
          await vi.advanceTimersByTimeAsync(0);
          expect(wipe.errorText() ?? "").not.toContain("try again");
          expect(wipe.status()).toBe("Deleted. Erasing leftover traces…");
          expect(wipe.wipeButton()?.disabled).toBe(false);
          expect(wipe.view.element.textContent).not.toContain("old before wipe");
          expect(vi.mocked(fetch)).toHaveBeenCalledOnce(); // one POST, never re-sent
          wipe.sheet.teardown();
          wipe.view.teardown();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      // L5 (reviewer): behaviours that were correct but unpinned (mutants survived).
      it("backs off 1, 2, 4, 8 s and then holds at a 15 s cap (not doubling forever)", async () => {
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "old before wipe" })] }))
          .mockRejectedValue(new Error("offline"));
        const wipe = await startUnconfirmedWipe();
        const reconciliations = () => getHistory.mock.calls.length - 1; // minus the attach load
        expect(reconciliations()).toBe(1); // immediately
        await vi.advanceTimersByTimeAsync(1_000);
        expect(reconciliations()).toBe(2);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(reconciliations()).toBe(3);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(reconciliations()).toBe(4);
        await vi.advanceTimersByTimeAsync(8_000);
        expect(reconciliations()).toBe(5); // t = 15 s
        await vi.advanceTimersByTimeAsync(15_000);
        expect(reconciliations()).toBe(6); // capped: +15 s, not +16 s
        await vi.advanceTimersByTimeAsync(14_999);
        expect(reconciliations()).toBe(6);
        await vi.advanceTimersByTimeAsync(1);
        expect(reconciliations()).toBe(7); // and again +15 s
        wipe.sheet.teardown();
        wipe.view.teardown();
      });

      it("teardown abandons the reconciliation: no more requests, and the caller is told", async () => {
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "old before wipe" })] }))
          .mockRejectedValue(new Error("offline"));
        const identity = fakeIdentity();
        const view = mountServerThread({ identity, hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
        await view.attach(SESSION);
        wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
        const outcome = view.wipe().then(
          () => "resolved",
          (error: unknown) => (error as Error).name,
        );
        await vi.advanceTimersByTimeAsync(3_000);
        const callsBefore = getHistory.mock.calls.length;

        view.teardown();

        await expect(outcome).resolves.toBe("ServerWipeAbandonedError");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(getHistory.mock.calls.length).toBe(callsBefore);
        expect(wipeChat).toHaveBeenCalledOnce();
      });

      it("a history response that lands AFTER a wiped event cannot resurrect the messages", async () => {
        let resolveHistory!: (page: HistoryPage) => void;
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "old before wipe" })] }))
          .mockImplementationOnce(() => new Promise<HistoryPage>((resolve) => { resolveHistory = resolve; }));
        const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
        await view.attach(SESSION);
        wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
        const outcome = view.wipe().then(
          (value) => ({ resolved: value }),
          (error: unknown) => ({ rejected: (error as Error).name }),
        );
        await vi.advanceTimersByTimeAsync(0); // the first reconciliation request is now in flight

        view.handleStreamEvent({ type: "wiped" } as ServerStreamEvent);
        await expect(outcome).resolves.toEqual({ resolved: true });
        // The stale answer (snapshotted BEFORE the wipe) arrives late: it must be ignored.
        resolveHistory(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "old before wipe" })] }));
        await vi.advanceTimersByTimeAsync(0);

        expect(view.element.textContent).not.toContain("old before wipe");
        view.teardown();
      });

      it("keeps retrying the reconciliation with backoff, never the wipe, and stays 'checking' meanwhile", async () => {
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "old before wipe" })] }))
          .mockRejectedValue(new Error("offline"));
        const wipe = await startUnconfirmedWipe();
        expect(wipe.status()).toBe(CHECKING);
        expect(wipe.wipeButton()?.disabled).toBe(true);
        const afterFirstAttempt = getHistory.mock.calls.length;

        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(getHistory.mock.calls.length).toBeGreaterThan(afterFirstAttempt + 1);
        expect(getHistory.mock.calls.length).toBeLessThan(afterFirstAttempt + 5); // backoff, not a hot loop
        expect(wipe.status()).toBe(CHECKING);
        expect(wipe.wipeButton()?.disabled).toBe(true);
        expect(wipeChat).toHaveBeenCalledOnce();
        wipe.sheet.teardown();
        wipe.view.teardown();
      });

      it("a wiped stream event settles it: the sheet leaves 'checking' and the wipe control is usable again", async () => {
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "old before wipe" })] }))
          .mockRejectedValue(new Error("offline"));
        const wipe = await startUnconfirmedWipe();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(wipe.status()).toBe(CHECKING);
        expect(wipe.wipeButton()?.disabled).toBe(true);

        wipe.view.handleStreamEvent({ type: "wiped" } as ServerStreamEvent);
        await vi.advanceTimersByTimeAsync(0);

        expect(wipe.status()).toBe("Deleted. Erasing leftover traces…");
        expect(wipe.wipeButton()?.disabled).toBe(false);
        expect(wipe.confirmHidden()).toBe(true);
        expect(wipe.view.element.textContent).not.toContain("old before wipe");
        // Settled means settled: no more reconciliation requests, no re-POST.
        const settledCalls = getHistory.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(getHistory.mock.calls.length).toBe(settledCalls);
        expect(wipe.status()).toBe("Done");
        expect(wipeChat).toHaveBeenCalledOnce();
        wipe.sheet.teardown();
        wipe.view.teardown();
      });

      it("a later successful history load settles it as committed", async () => {
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "old before wipe" })] }))
          .mockRejectedValueOnce(new Error("offline")) // first reconciliation, immediately
          .mockRejectedValueOnce(new Error("offline")) // after 1 s
          .mockResolvedValueOnce(emptyHistory()); // after 2 s more
        const wipe = await startUnconfirmedWipe();
        expect(wipe.status()).toBe(CHECKING);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(wipe.status()).toBe(CHECKING);
        expect(wipe.wipeButton()?.disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(2_000);

        expect(wipe.status()).toBe("Deleted. Erasing leftover traces…");
        expect(wipe.wipeButton()?.disabled).toBe(false);
        expect(getHistory).toHaveBeenCalledTimes(4);
        expect(wipe.view.element.textContent).not.toContain("old before wipe");
        expect(wipeChat).toHaveBeenCalledOnce();
        wipe.sheet.teardown();
        wipe.view.teardown();
      });

      it("a later history load that still holds older messages settles it as NOT committed and offers a retry", async () => {
        const old = fakeMessage({ seq: 1, text: "still here" });
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [old] }))
          .mockRejectedValueOnce(new Error("offline"))
          .mockResolvedValueOnce(emptyHistory({ messages: [old] }));
        const wipe = await startUnconfirmedWipe();
        expect(wipe.status()).toBe(CHECKING);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(wipe.errorText()).toBe("Couldn't delete everything — try again");
        expect(wipe.confirmHidden()).toBe(false);
        expect(wipe.wipeButton()?.disabled).toBe(false);
        expect(wipe.statusHidden()).toBe(true);
        expect(wipe.view.element.textContent).toContain("still here");
        expect(wipeChat).toHaveBeenCalledOnce();
        wipe.sheet.teardown();
        wipe.view.teardown();
      });

      it("locking while the outcome is unconfirmed stops reconciling and leaves the wipe control usable", async () => {
        getHistory
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "old before wipe" })] }))
          .mockRejectedValue(new Error("offline"));
        const wipe = await startUnconfirmedWipe();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(wipe.wipeButton()?.disabled).toBe(true);

        wipe.view.detach();
        wipe.sheet.close();
        await vi.advanceTimersByTimeAsync(0);
        const callsAtLock = getHistory.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(getHistory.mock.calls.length).toBe(callsAtLock);

        // The next unlock finds an ordinary sheet, not a control stuck on 'checking'.
        wipe.sheet.open();
        await vi.advanceTimersByTimeAsync(0);
        expect(wipe.wipeButton()?.disabled).toBe(false);
        expect(wipe.statusHidden()).toBe(true);
        wipe.sheet.teardown();
        wipe.view.teardown();
      });
    });

    // L3 (reviewer): the wipe boundary is the newest seq the client KNEW about. When the
    // history never loaded it is 0, so "nothing at or before 0" was vacuously true and a
    // wipe that never committed was reported as deleted while messages remained.
    describe("an unknown wipe boundary (L3)", () => {
      it("history never loaded + messages still there: NOT reported as deleted", async () => {
        getHistory
          .mockRejectedValueOnce(new Error("offline")) // the attach load fails: boundary unknown
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 5, text: "still here" })] }));
        wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
        const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
        await view.attach(SESSION);

        await expect(view.wipe()).rejects.toMatchObject({ name: "ServerWipeNotCommittedError" });

        expect(view.element.textContent).toContain("still here");
        expect(wipeChat).toHaveBeenCalledOnce();
        view.teardown();
      });

      it("history never loaded + nothing left: the wipe did commit", async () => {
        getHistory
          .mockRejectedValueOnce(new Error("offline"))
          .mockResolvedValueOnce(emptyHistory());
        wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
        const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
        await view.attach(SESSION);

        await expect(view.wipe()).resolves.toBe(true);
        view.teardown();
      });

      it("history loaded but EMPTY: a message that appears afterwards is newer, so it is a commit", async () => {
        getHistory
          .mockResolvedValueOnce(emptyHistory())
          .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 5, text: "sent after the wipe" })] }));
        wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
        const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
        await view.attach(SESSION);

        await expect(view.wipe()).resolves.toBe(true);
        expect(view.element.textContent).toContain("sent after the wipe");
        view.teardown();
      });
    });

    it("reconciles an unknown wipe to empty history without re-POSTing", async () => {
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "old before wipe" })] }))
        .mockResolvedValueOnce(emptyHistory());
      wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      await expect(view.wipe()).resolves.toBe(true);

      expect(wipeChat).toHaveBeenCalledOnce();
      expect(view.element.textContent).not.toContain("old before wipe");
      view.teardown();
    });

    it("uses server sequence when the browser clock is ahead during unknown wipe reconciliation", async () => {
      vi.useFakeTimers();
      const serverTimeS = 1_800_000_000;
      vi.setSystemTime((serverTimeS + 3_600) * 1000);
      const oldMessage = fakeMessage({ seq: 1, text: "old before wipe", createdAt: serverTimeS });
      const sentAfterRequest = fakeMessage({
        seq: 2,
        clientId: "after-1234",
        text: "sent after wipe started",
        createdAt: serverTimeS + 10,
      });
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [oldMessage] }))
        .mockResolvedValueOnce(emptyHistory({ messages: [sentAfterRequest] }));
      wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      await expect(view.wipe()).resolves.toBe(true);

      expect(view.element.textContent).not.toContain("old before wipe");
      expect(view.element.textContent).toContain("sent after wipe started");
      expect(wipeChat).toHaveBeenCalledOnce();
      view.teardown();
    });

    it("uses server sequence when the browser clock is behind during unknown wipe reconciliation", async () => {
      vi.useFakeTimers();
      const serverTimeS = 1_800_000_000;
      vi.setSystemTime((serverTimeS - 3_600) * 1000);
      const oldMessage = fakeMessage({ seq: 1, text: "still here after failed wipe", createdAt: serverTimeS });
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [oldMessage] }))
        .mockResolvedValueOnce(emptyHistory({ messages: [oldMessage] }));
      wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      await expect(view.wipe()).rejects.toMatchObject({ name: "ServerWipeNotCommittedError" });

      expect(view.element.textContent).toContain("still here after failed wipe");
      expect(wipeChat).toHaveBeenCalledOnce();
      view.teardown();
    });

    it("preserves a post-request stream message while reconciling an unknown wipe", async () => {
      let resolveHistory!: (page: HistoryPage) => void;
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "old before wipe" })] }))
        .mockImplementationOnce(() => new Promise<HistoryPage>((resolve) => { resolveHistory = resolve; }));
      wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const request = view.wipe();
      await flush();
      view.handleStreamEvent({
        type: "message",
        message: fakeMessage({ seq: 2, text: "new while reconciling", createdAt: Date.now() / 1000 + 1 }),
      });
      resolveHistory(emptyHistory());
      await expect(request).resolves.toBe(true);

      expect(view.element.textContent).not.toContain("old before wipe");
      expect(view.element.textContent).toContain("new while reconciling");
      view.teardown();
    });

    it("restores history and reports a non-committed wipe after an unknown outcome", async () => {
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "still here" })] }))
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "still here" })] }));
      wipeChat.mockRejectedValue(new ServerErasureOutcomeUnknownError());
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      await expect(view.wipe()).rejects.toMatchObject({ name: "ServerWipeNotCommittedError" });

      expect(wipeChat).toHaveBeenCalledOnce();
      expect(view.element.textContent).toContain("still here");
      view.teardown();
    });

    it("does not clear a new message when the wipe SSE precedes its HTTP response", async () => {
      let resolveWipe!: () => void;
      let resolveRefresh!: (page: HistoryPage) => void;
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "old" })] }))
        .mockImplementationOnce(() => new Promise<HistoryPage>((resolve) => { resolveRefresh = resolve; }));
      wipeChat.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveWipe = resolve; }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const request = view.wipe();
      view.handleStreamEvent({ type: "wiped" } as ServerStreamEvent);
      resolveWipe();
      await flush(); // the post-wipe history reconciliation is now in flight
      view.handleStreamEvent({ type: "message", message: fakeMessage({ seq: 2, text: "after wipe" }) } as ServerStreamEvent);
      resolveRefresh(emptyHistory()); // snapshot began before the message event
      await request;

      expect(view.element.textContent).not.toContain("old");
      expect(view.element.textContent).toContain("after wipe");
      view.teardown();
    });

    it("preserves a message event that arrives during the successful wipe refresh", async () => {
      let resolveRefresh!: (page: HistoryPage) => void;
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [fakeMessage({ text: "old" })] }))
        .mockImplementationOnce(() => new Promise<HistoryPage>((resolve) => { resolveRefresh = resolve; }));
      wipeChat.mockResolvedValue(false);
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const request = view.wipe();
      await flush(); // local clear is complete; history refresh is pending
      view.handleStreamEvent({ type: "message", message: fakeMessage({ seq: 2, text: "arrived during refresh" }) } as ServerStreamEvent);
      resolveRefresh(emptyHistory()); // this earlier snapshot does not include the message
      await request;

      expect(view.element.textContent).not.toContain("old");
      expect(view.element.textContent).toContain("arrived during refresh");
      view.teardown();
    });

    it("opens on a 500ms touch hold and cancels after movement over 10px", async () => {
      vi.useFakeTimers();
      getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage()] }));
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      const bubble = view.element.querySelector<HTMLElement>(".wx-srv-bubble");
      const menu = view.element.querySelector<HTMLElement>(".wx-srv-message-actions");
      expect(bubble).not.toBeNull();
      expect(menu?.hidden).toBe(true);

      bubble?.dispatchEvent(touchPointer("pointerdown", 10, 10));
      vi.advanceTimersByTime(499);
      expect(menu?.hidden).toBe(true);
      bubble?.dispatchEvent(touchPointer("pointermove", 18, 18));
      vi.advanceTimersByTime(1);
      expect(menu?.hidden).toBe(true);

      bubble?.dispatchEvent(touchPointer("pointerdown", 10, 10));
      vi.advanceTimersByTime(500);
      expect(menu?.hidden).toBe(false);
      view.teardown();
    });

    it("closes message actions when the panel locks", async () => {
      getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage()] }));
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      const view = mountServerThread({ identity: fakeIdentity(), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      const menu = view.element.querySelector<HTMLElement>(".wx-srv-message-actions");
      expect(menu?.hidden).toBe(false);

      view.detach();

      expect(menu?.hidden).toBe(true);
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

// -- Reactions (spec/server-chat/04-reactions.md) ------------------------------------------

const THUMBS_UP = "\u{1F44D}";
const HEART = "❤️";
const PRAY = "\u{1F64F}";

const VOICE_ATTACHMENT: Attachment = {
  id: "voice-1",
  kind: "voice",
  status: "ready",
  width: null,
  height: null,
  durationS: 30,
  peaks: [0.2, 0.9, 0.5],
  urls: { play: "/voice-1.m4a" },
};

/** Finds one emoji button in a bubble's menu by its `data-reaction`. jsdom's selector engine
 * mishandles astral-plane emoji inside an attribute selector, so compare the dataset instead. */
function reactionButton(root: ParentNode, emoji: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>(".wx-srv-message-react")].find(
    (button) => button.dataset["reaction"] === emoji,
  );
}

function pickReaction(view: { element: HTMLElement }, emoji: string): void {
  reactionButton(view.element, emoji)!.click();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function chips(view: { element: HTMLElement }, seq = 1): HTMLButtonElement[] {
  return [
    ...view.element.querySelectorAll<HTMLButtonElement>(
      `[data-message-seq="${seq}"] .wx-srv-reaction-chip`,
    ),
  ];
}

function chipSummary(view: { element: HTMLElement }, seq = 1): string[] {
  return chips(view, seq).map(
    (chip) => `${chip.dataset["reaction"]}:${chip.querySelector(".wx-srv-reaction-count")?.textContent}`,
  );
}

/** A promise the test resolves or rejects by hand, to hold a reaction request "in flight". */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mountServerThread reactions", () => {
  beforeEach(() => {
    getHistory.mockReset();
    setReaction.mockReset();
    getUsage.mockReset().mockResolvedValue({
      mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function mountWith(
    messages: Message[],
    opts: { identity?: ServerIdentity; hooks?: LockHooks } = {},
  ) {
    getHistory.mockResolvedValue(emptyHistory({ messages }));
    const view = mountServerThread({
      identity: opts.identity ?? fakeIdentity("Josh"),
      hooks: opts.hooks ?? fakeHooks(),
      win: fakeWindow(),
      onSettings: vi.fn(),
    });
    await view.attach(SESSION);
    return view;
  }

  it("shows each reaction as a chip with its count, marks the reader's own, and lists who reacted", async () => {
    const view = await mountWith([
      fakeMessage({
        sender: "Purdy",
        reactions: [
          { emoji: THUMBS_UP, count: 2, senders: ["Josh", "Purdy"] },
          { emoji: PRAY, count: 1, senders: ["Purdy"] },
        ],
      }),
    ]);

    expect(chipSummary(view)).toEqual([`${THUMBS_UP}:2`, `${PRAY}:1`]);
    const [mine, theirs] = chips(view);
    expect(mine?.getAttribute("aria-pressed")).toBe("true");
    expect(mine?.classList.contains("wx-srv-reaction-mine")).toBe(true);
    expect(mine?.title).toBe("Josh, Purdy");
    expect(mine?.getAttribute("aria-label")).toBe("Thumbs up, 2 reactions, including yours. Tap to remove yours");
    expect(theirs?.getAttribute("aria-pressed")).toBe("false");
    expect(theirs?.getAttribute("aria-label")).toBe("Folded hands, 1 reaction. Tap to add yours");
    view.teardown();
  });

  it("matches the reader's name case-insensitively, like the bubble alignment does", async () => {
    const view = await mountWith([
      fakeMessage({ reactions: [{ emoji: HEART, count: 1, senders: ["JOSH"] }] }),
    ]);
    expect(chips(view)[0]?.getAttribute("aria-pressed")).toBe("true");
    view.teardown();
  });

  it("hides the reactions row when a message has none", async () => {
    const view = await mountWith([fakeMessage()]);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reactions")?.hidden).toBe(true);
    expect(chips(view)).toHaveLength(0);
    view.teardown();
  });

  it("reads a message from a server that predates reactions as having none", async () => {
    const { reactions: _omitted, ...legacy } = fakeMessage();
    const view = await mountWith([legacy as unknown as Message]);
    expect(chips(view)).toHaveLength(0);
    view.handleStreamEvent({ type: "message_updated", message: legacy as unknown as Message });
    expect(view.element.querySelectorAll(".wx-srv-bubble")).toHaveLength(1);
    view.teardown();
  });

  it("tapping a chip I hold asks the server to REMOVE mine (desired state), then shows the answer", async () => {
    const message = fakeMessage({ reactions: [{ emoji: THUMBS_UP, count: 1, senders: ["Josh"] }] });
    setReaction.mockResolvedValue({ ...message, reactions: [] });
    const view = await mountWith([message]);

    chips(view)[0]?.click();
    await settle();

    expect(setReaction).toHaveBeenCalledWith(SESSION, 1, { emoji: THUMBS_UP, sender: "Josh", reacted: false });
    expect(chips(view)).toHaveLength(0);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reactions")?.hidden).toBe(true);
    view.teardown();
  });

  it("tapping a chip I don't hold asks the server to ADD mine", async () => {
    const message = fakeMessage({ sender: "Purdy", reactions: [{ emoji: PRAY, count: 1, senders: ["Purdy"] }] });
    setReaction.mockResolvedValue({ ...message, reactions: [{ emoji: PRAY, count: 2, senders: ["Purdy", "Josh"] }] });
    const view = await mountWith([message]);

    chips(view)[0]?.click();
    await settle();

    expect(setReaction).toHaveBeenCalledWith(SESSION, 1, { emoji: PRAY, sender: "Josh", reacted: true });
    expect(chipSummary(view)).toEqual([`${PRAY}:2`]);
    expect(chips(view)[0]?.getAttribute("aria-pressed")).toBe("true");
    view.teardown();
  });

  it("an emoji picked from the menu adds a reaction, showing a dimmed chip at once", async () => {
    const message = fakeMessage({ sender: "Purdy" });
    const inFlight = deferred<Message>();
    setReaction.mockReturnValue(inFlight.promise);
    const view = await mountWith([message]);

    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")!.click();
    pickReaction(view, HEART);

    expect(setReaction).toHaveBeenCalledWith(SESSION, 1, { emoji: HEART, sender: "Josh", reacted: true });
    const [pending] = chips(view);
    expect(pending?.dataset["reaction"]).toBe(HEART);
    expect(pending?.classList.contains("wx-srv-reaction-pending")).toBe(true);
    expect(pending?.getAttribute("aria-busy")).toBe("true");
    expect(pending?.disabled).toBe(true);

    inFlight.resolve({ ...message, reactions: [{ emoji: HEART, count: 1, senders: ["Josh"] }] });
    await settle();
    const [settled] = chips(view);
    expect(settled?.classList.contains("wx-srv-reaction-pending")).toBe(false);
    expect(settled?.disabled).toBe(false);
    expect(settled?.getAttribute("aria-pressed")).toBe("true");
    view.teardown();
  });

  it("ignores a second tap on the same chip while its request is in flight", async () => {
    const message = fakeMessage({ reactions: [{ emoji: THUMBS_UP, count: 1, senders: ["Purdy"] }], sender: "Purdy" });
    const inFlight = deferred<Message>();
    setReaction.mockReturnValue(inFlight.promise);
    const view = await mountWith([message]);

    chips(view)[0]?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")!.click();
    pickReaction(view, THUMBS_UP);

    expect(setReaction).toHaveBeenCalledTimes(1);
    inFlight.resolve(message);
    await settle();
    view.teardown();
  });

  it("does nothing until the reader has a display name", async () => {
    const message = fakeMessage({ sender: "Purdy", reactions: [{ emoji: PRAY, count: 1, senders: ["Purdy"] }] });
    const view = await mountWith([message], { identity: fakeIdentity(null) });
    chips(view)[0]?.click();
    await settle();
    expect(setReaction).not.toHaveBeenCalled();
    view.teardown();
  });

  it("another person's reaction arrives over the stream and updates the chips", async () => {
    const view = await mountWith([fakeMessage()]);
    view.handleStreamEvent({
      type: "message_updated",
      message: fakeMessage({ reactions: [{ emoji: PRAY, count: 1, senders: ["Purdy"] }] }),
    });
    expect(chipSummary(view)).toEqual([`${PRAY}:1`]);
    view.teardown();
  });

  it("orders chips by the allowlist, whatever order the server sent", async () => {
    const view = await mountWith([
      fakeMessage({
        reactions: [
          { emoji: PRAY, count: 1, senders: ["Purdy"] },
          { emoji: THUMBS_UP, count: 1, senders: ["Purdy"] },
        ],
      }),
    ]);
    expect(chips(view).map((chip) => chip.dataset["reaction"])).toEqual([THUMBS_UP, PRAY]);
    view.teardown();
  });

  describe("in-place patching (a reaction must never cut off media)", () => {
    it("keeps a PLAYING voice note's <audio> element, its position, its suspension and an open menu across a reaction", async () => {
      const voice = fakeMessage({ seq: 1, sender: "Purdy", text: null, attachments: [VOICE_ATTACHMENT] });
      const release = vi.fn();
      const hooks: LockHooks = { suspend: vi.fn(() => release), lockNow: vi.fn() };
      const view = await mountWith([voice], { hooks });

      const audio = view.element.querySelector<HTMLAudioElement>("audio")!;
      const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
      const load = vi.spyOn(audio, "load").mockImplementation(() => {});
      Object.defineProperty(audio, "currentTime", { value: 12.5, writable: true, configurable: true });
      audio.dispatchEvent(new Event("play"));
      expect(hooks.suspend).toHaveBeenCalledWith("mediaPlaying");
      const bubble = view.element.querySelector<HTMLElement>('[data-message-seq="1"]')!;
      bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")!.click();
      const menu = bubble.querySelector<HTMLElement>(".wx-srv-message-actions")!;
      expect(menu.hidden).toBe(false);

      view.handleStreamEvent({
        type: "message_updated",
        message: { ...voice, reactions: [{ emoji: THUMBS_UP, count: 1, senders: ["Josh"] }] },
      });

      expect(view.element.querySelector("audio")).toBe(audio);
      expect(view.element.querySelector('[data-message-seq="1"]')).toBe(bubble);
      expect(audio.currentTime).toBe(12.5);
      expect(pause).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(menu.hidden).toBe(false);
      expect(chipSummary(view)).toEqual([`${THUMBS_UP}:1`]);
      // The still-open menu now shows that I hold the thumbs-up.
      expect(reactionButton(menu, THUMBS_UP)?.getAttribute("aria-checked")).toBe("true");

      view.teardown();
    });

    it("keeps the same audio element when my own reaction comes back in the response", async () => {
      const voice = fakeMessage({ seq: 1, sender: "Purdy", text: null, attachments: [VOICE_ATTACHMENT] });
      setReaction.mockResolvedValue({ ...voice, reactions: [{ emoji: PRAY, count: 1, senders: ["Josh"] }] });
      const view = await mountWith([voice]);
      const audio = view.element.querySelector("audio");

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")!.click();
      pickReaction(view, PRAY);
      await settle();

      expect(chipSummary(view)).toEqual([`${PRAY}:1`]);
      expect(view.element.querySelector("audio")).toBe(audio);
      view.teardown();
    });

    it("still rebuilds the bubble when something OTHER than the reactions changed", async () => {
      const voice = fakeMessage({ seq: 1, sender: "Purdy", text: null, attachments: [VOICE_ATTACHMENT] });
      const release = vi.fn();
      const hooks: LockHooks = { suspend: vi.fn(() => release), lockNow: vi.fn() };
      const view = await mountWith([voice], { hooks });
      const audio = view.element.querySelector<HTMLAudioElement>("audio")!;
      vi.spyOn(audio, "pause").mockImplementation(() => {});
      vi.spyOn(audio, "load").mockImplementation(() => {});
      audio.dispatchEvent(new Event("play"));

      view.handleStreamEvent({
        type: "message_updated",
        message: {
          ...voice,
          attachments: [{ ...VOICE_ATTACHMENT, urls: { play: "/voice-1.m4a?exp=2" } }],
          reactions: [{ emoji: THUMBS_UP, count: 1, senders: ["Purdy"] }],
        },
      });

      expect(view.element.querySelector("audio")).not.toBe(audio);
      expect(release).toHaveBeenCalledTimes(1);
      expect(chipSummary(view)).toEqual([`${THUMBS_UP}:1`]);
      view.teardown();
    });
  });

  describe("the stream is the one ordered source of truth", () => {
    it("does not let a stale response overwrite a newer stream frame", async () => {
      const message = fakeMessage({ sender: "Purdy" });
      const inFlight = deferred<Message>();
      setReaction.mockReturnValue(inFlight.promise);
      const view = await mountWith([message]);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")!.click();
      pickReaction(view, THUMBS_UP);

      // While mine is out, Purdy's reaction lands and streams in (it includes mine).
      view.handleStreamEvent({
        type: "message_updated",
        message: {
          ...message,
          reactions: [{ emoji: THUMBS_UP, count: 2, senders: ["Josh", "Purdy"] }],
        },
      });
      // Then the (older) response for my own request finally arrives, missing Purdy's.
      inFlight.resolve({ ...message, reactions: [{ emoji: THUMBS_UP, count: 1, senders: ["Josh"] }] });
      await settle();

      expect(chipSummary(view)).toEqual([`${THUMBS_UP}:2`]);
      view.teardown();
    });

    it("ignores a response that lands after the chat was wiped (it must not bring the message back)", async () => {
      const message = fakeMessage({ sender: "Purdy" });
      const inFlight = deferred<Message>();
      setReaction.mockReturnValue(inFlight.promise);
      const view = await mountWith([message]);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")!.click();
      pickReaction(view, THUMBS_UP);
      view.handleStreamEvent({ type: "wiped" });
      inFlight.resolve({ ...message, reactions: [{ emoji: THUMBS_UP, count: 1, senders: ["Josh"] }] });
      await settle();

      expect(view.element.querySelectorAll(".wx-srv-bubble")).toHaveLength(0);
      view.teardown();
    });

    it("ignores a response for a message that was deleted while it was in flight", async () => {
      const message = fakeMessage({ sender: "Purdy" });
      const inFlight = deferred<Message>();
      setReaction.mockReturnValue(inFlight.promise);
      const view = await mountWith([message]);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")!.click();
      pickReaction(view, HEART);
      view.handleStreamEvent({ type: "message_deleted", seq: 1 });
      inFlight.resolve({ ...message, reactions: [{ emoji: HEART, count: 1, senders: ["Josh"] }] });
      await settle();

      expect(view.element.querySelectorAll(".wx-srv-bubble")).toHaveLength(0);
      view.teardown();
    });
  });

  describe("failures", () => {
    it("shows an inline error, keeps the old state, and clears the error after five seconds", async () => {
      vi.useFakeTimers();
      const message = fakeMessage({ sender: "Purdy", reactions: [{ emoji: PRAY, count: 1, senders: ["Purdy"] }] });
      getHistory.mockResolvedValue(emptyHistory({ messages: [message] }));
      const view = mountServerThread({
        identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn(),
      });
      await view.attach(SESSION);
      setReaction.mockRejectedValue(new ReactionRequestError(503));

      chips(view)[0]?.click();
      await settle();

      expect(view.element.querySelector(".wx-srv-reaction-error")?.textContent).toBe(
        "Couldn't update the reaction. Try again.",
      );
      expect(chipSummary(view)).toEqual([`${PRAY}:1`]);
      expect(chips(view)[0]?.disabled).toBe(false);

      vi.advanceTimersByTime(5_000);
      expect(view.element.querySelector(".wx-srv-reaction-error")).toBeNull();
      view.teardown();
    });

    it("says so when the message is gone (404)", async () => {
      const message = fakeMessage({ sender: "Purdy", reactions: [{ emoji: PRAY, count: 1, senders: ["Purdy"] }] });
      setReaction.mockRejectedValue(new ReactionRequestError(404));
      const view = await mountWith([message]);

      chips(view)[0]?.click();
      await settle();

      expect(view.element.querySelector(".wx-srv-reaction-error")?.textContent).toBe("That message was deleted.");
      view.teardown();
    });

    it("a network failure gets the generic error", async () => {
      const message = fakeMessage({ sender: "Purdy", reactions: [{ emoji: PRAY, count: 1, senders: ["Purdy"] }] });
      setReaction.mockRejectedValue(new TypeError("Failed to fetch"));
      const view = await mountWith([message]);

      chips(view)[0]?.click();
      await settle();

      expect(view.element.querySelector(".wx-srv-reaction-error")?.textContent).toBe(
        "Couldn't update the reaction. Try again.",
      );
      view.teardown();
    });

    it("a 401 locks the chat instead of showing an error", async () => {
      const hooks = fakeHooks();
      const message = fakeMessage({ sender: "Purdy", reactions: [{ emoji: PRAY, count: 1, senders: ["Purdy"] }] });
      setReaction.mockRejectedValue(new ServerLockedError());
      const view = await mountWith([message], { hooks });

      chips(view)[0]?.click();
      await settle();

      expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized");
      expect(view.element.querySelector(".wx-srv-reaction-error")).toBeNull();
      view.teardown();
    });

    it("a successful retry after an error clears the error", async () => {
      const message = fakeMessage({ sender: "Purdy", reactions: [{ emoji: PRAY, count: 1, senders: ["Purdy"] }] });
      setReaction
        .mockRejectedValueOnce(new ReactionRequestError(500))
        .mockResolvedValueOnce({ ...message, reactions: [{ emoji: PRAY, count: 2, senders: ["Purdy", "Josh"] }] });
      const view = await mountWith([message]);

      chips(view)[0]?.click();
      await settle();
      expect(view.element.querySelector(".wx-srv-reaction-error")).not.toBeNull();
      chips(view)[0]?.click();
      await settle();

      expect(view.element.querySelector(".wx-srv-reaction-error")).toBeNull();
      expect(chipSummary(view)).toEqual([`${PRAY}:2`]);
      view.teardown();
    });
  });
});
