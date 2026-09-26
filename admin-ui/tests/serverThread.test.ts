import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactionRequestError, type Attachment, type HistoryPage, type Message, type SendMessageResult, type SendViewOnceResult } from "../src/server/api/messages";
import { ServerErasureOutcomeUnknownError, ServerLockedError } from "../src/server/api/http";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerSettingsSheet } from "../src/server/settingsSheet";
import { mountServerThread, type ViewOnceDraftSettings } from "../src/server/thread";
import { UploadError, type UploadAttachment } from "../src/server/upload";
import type { ServerStreamEvent } from "../src/server/stream";
import type { LockHooks, ServerSession } from "../src/server/types";

const { createVoiceRecorder, deleteMessage, getHistory, getUsage, sendMessage, sendViewOnceMessage, setReaction, transcribeAttachment, wipeChat, uploadServerAttachment } = vi.hoisted(() => ({
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
  sendViewOnceMessage: vi.fn(),
  setReaction: vi.fn(),
  transcribeAttachment: vi.fn(),
  wipeChat: vi.fn(),
  uploadServerAttachment: vi.fn(),
}));
vi.mock("../src/server/recorder", () => ({ createVoiceRecorder }));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
  sendMessage,
  sendViewOnceMessage,
  setReaction,
  transcribeAttachment,
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
    adoptBoundSession: vi.fn(),
    getBoundGrantId: vi.fn(() => null),
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
    replyTo: null,
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
    transcribeAttachment.mockReset();
    deleteMessage.mockReset();
    wipeChat.mockReset();
    uploadServerAttachment.mockReset();
    sendViewOnceMessage.mockReset();
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
    const hooks: LockHooks = {
      suspend: vi.fn(() => release),
      lockNow: vi.fn(),
      adoptBoundSession: vi.fn(),
      getBoundGrantId: vi.fn(() => null),
    };
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

  describe("voice-note transcription", () => {
    const VOICE_ID = "e".repeat(32);
    type Transcript = NonNullable<Message["attachments"][number]["transcript"]>;
    const voiceMessage = (transcript: Transcript | null = null, overrides: Partial<Message> = {}): Message =>
      fakeMessage({
        seq: 7,
        clientId: "c7",
        text: null,
        createdAt: 1_700_000_000, // fixed: a real server repeats it on every update of the message
        attachments: [{
          id: VOICE_ID, kind: "voice", status: "ready", width: null, height: null,
          durationS: 6, peaks: [0.2, 0.9], urls: { play: "/voice?exp=1&sig=a" }, transcript,
        }],
        ...overrides,
      });
    const usage = (flag: boolean | undefined) =>
      getUsage.mockResolvedValue({
        mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false,
        ...(flag === undefined ? {} : { transcriptionAvailable: flag }),
      });
    const mount = (hooks: LockHooks = fakeHooks()) =>
      mountServerThread({ identity: fakeIdentity(), hooks, win: fakeWindow(), onSettings: vi.fn() });

    it("offers Transcribe only once the server says cmd's private mode is live", async () => {
      usage(true);
      getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage()] }));
      const view = mount();
      await view.attach(SESSION);
      await flush();
      expect(view.element.querySelector(".wx-srv-transcript-start")?.textContent).toBe("Transcribe");
      view.teardown();
    });

    it.each([
      ["says it is not", false],
      ["does not say", undefined],
    ])("shows no control while the server %s available", async (_name, flag) => {
      usage(flag);
      getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage()] }));
      const view = mount();
      await view.attach(SESSION);
      await flush();
      expect(view.element.querySelector(".wx-srv-transcript-start")).toBeNull();
      expect(view.element.querySelector<HTMLElement>(".wx-srv-transcript")?.hidden).toBe(true);
      view.teardown();
    });

    it("a failing usage read leaves the control hidden and never breaks the thread", async () => {
      getUsage.mockRejectedValue(new Error("offline"));
      getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage()] }));
      const hooks = fakeHooks();
      const view = mount(hooks);
      await view.attach(SESSION);
      await flush();
      expect(view.element.querySelector(".wx-srv-transcript-start")).toBeNull();
      expect(view.element.querySelector(".wx-srv-voice")).not.toBeNull();
      expect(hooks.lockNow).not.toHaveBeenCalled();
      view.teardown();
    });

    it("a 401 while reading the flag locks the chat", async () => {
      getUsage.mockRejectedValue(new ServerLockedError());
      getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage()] }));
      const hooks = fakeHooks();
      const view = mount(hooks);
      await view.attach(SESSION);
      await flush();
      expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized");
      view.teardown();
    });

    it("clicking Transcribe asks the server for that note with the current session, and only then", async () => {
      usage(true);
      transcribeAttachment.mockResolvedValue({ kind: "started", transcript: { status: "pending" } });
      getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage()] }));
      const view = mount();
      await view.attach(SESSION);
      await flush();
      expect(transcribeAttachment).not.toHaveBeenCalled();

      view.element.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
      await flush();

      expect(transcribeAttachment).toHaveBeenCalledExactlyOnceWith(SESSION, VOICE_ID);
      expect(view.element.querySelector(".wx-srv-transcript-pending")).not.toBeNull();
      view.teardown();
    });

    it("a 401 on the request locks the chat", async () => {
      usage(true);
      transcribeAttachment.mockRejectedValue(new ServerLockedError());
      getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage()] }));
      const hooks = fakeHooks();
      const view = mount(hooks);
      await view.attach(SESSION);
      await flush();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
      await flush();
      expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized");
      view.teardown();
    });

    it("a transcript arriving over the stream never cuts off a note that is playing", async () => {
      usage(true);
      getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage()] }));
      const release = vi.fn();
      const hooks: LockHooks = {
      suspend: vi.fn(() => release),
      lockNow: vi.fn(),
      adoptBoundSession: vi.fn(),
      getBoundGrantId: vi.fn(() => null),
    };
      const view = mount(hooks);
      await view.attach(SESSION);
      await flush();

      const bubble = view.element.querySelector<HTMLElement>('[data-message-seq="7"]')!;
      const audio = view.element.querySelector<HTMLAudioElement>("audio")!;
      const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
      const load = vi.spyOn(audio, "load").mockImplementation(() => {});
      Object.defineProperty(audio, "currentTime", { value: 3.5, writable: true });
      audio.dispatchEvent(new Event("play"));

      // pending (the other device asked), then done: each a NEW message object from the stream
      view.handleStreamEvent({ type: "message_updated", message: voiceMessage({ status: "pending" }) });
      expect(view.element.querySelector(".wx-srv-transcript-pending")).not.toBeNull();
      view.handleStreamEvent({
        type: "message_updated",
        message: voiceMessage({ status: "done", text: "hello from the note" }),
      });

      expect(view.element.querySelector(".wx-srv-transcript-text")?.textContent).toBe("hello from the note");
      expect(view.element.querySelector('[data-message-seq="7"]')).toBe(bubble);
      expect(view.element.querySelector("audio")).toBe(audio);
      expect(audio.currentTime).toBe(3.5);
      expect(pause).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(audio.getAttribute("src")).toBe("/voice?exp=1&sig=a");
      view.teardown();
    });

    it("an update that changes more than the transcript still rebuilds the bubble", async () => {
      usage(true);
      getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage()] }));
      const view = mount();
      await view.attach(SESSION);
      await flush();
      const bubble = view.element.querySelector('[data-message-seq="7"]')!;

      view.handleStreamEvent({
        type: "message_updated",
        message: voiceMessage({ status: "done", text: "words" }, { text: "caption added" }),
      });

      expect(view.element.querySelector('[data-message-seq="7"]')).not.toBe(bubble);
      expect(view.element.textContent).toContain("caption added");
      expect(view.element.querySelector(".wx-srv-transcript-text")?.textContent).toBe("words");
      view.teardown();
    });

    it("a failed transcript from the stream shows the error and Retry, and Retry asks again", async () => {
      usage(true);
      transcribeAttachment.mockResolvedValue({ kind: "started", transcript: { status: "pending" } });
      getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage()] }));
      const view = mount();
      await view.attach(SESSION);
      await flush();

      view.handleStreamEvent({ type: "message_updated", message: voiceMessage({ status: "failed" }) });
      expect(view.element.querySelector(".wx-srv-transcript-error")?.textContent).toBe(
        "Couldn't transcribe this voice note.",
      );
      view.element.querySelector<HTMLButtonElement>(".wx-srv-transcript-retry")!.click();
      await flush();
      expect(transcribeAttachment).toHaveBeenCalledExactlyOnceWith(SESSION, VOICE_ID);
      view.teardown();
    });

    it("Hide survives the next transcript-only update and a re-unlock's refreshed history", async () => {
      usage(true);
      getHistory.mockResolvedValue(
        emptyHistory({ messages: [voiceMessage({ status: "done", text: "private words" })] }),
      );
      const view = mount();
      await view.attach(SESSION);
      await flush();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-transcript-toggle")!.click();
      expect(view.element.textContent).not.toContain("private words");

      view.handleStreamEvent({
        type: "message_updated",
        message: voiceMessage({ status: "done", text: "private words" }),
      });
      expect(view.element.textContent).not.toContain("private words");

      view.detach();
      await view.attach(SESSION);
      await flush();
      expect(view.element.textContent).not.toContain("private words");
      expect(view.element.querySelector(".wx-srv-transcript-toggle")?.textContent).toBe("Show transcript");
      view.teardown();
    });

    describe("the New messages pill", () => {
      async function mountScrolledUp(): Promise<ReturnType<typeof mount>> {
        usage(true);
        getHistory.mockResolvedValue(emptyHistory({ messages: [voiceMessage(null, { sender: "Purdy" })] }));
        const view = mount();
        await view.attach(SESSION);
        await flush();
        const thread = view.element.querySelector<HTMLElement>(".wx-srv-thread")!;
        Object.defineProperty(thread, "scrollTop", { value: 0, configurable: true, writable: true });
        Object.defineProperty(thread, "scrollHeight", { value: 2000, configurable: true });
        Object.defineProperty(thread, "clientHeight", { value: 300, configurable: true });
        thread.dispatchEvent(new Event("scroll")); // the reader is scrolled up
        return view;
      }
      const pill = (view: ReturnType<typeof mount>) =>
        view.element.querySelector<HTMLButtonElement>(".wx-srv-jump-pill")!;

      it("is not raised by a transcript arriving on someone else's older note", async () => {
        const view = await mountScrolledUp();
        view.handleStreamEvent({
          type: "message_updated",
          message: voiceMessage({ status: "pending" }, { sender: "Purdy" }),
        });
        view.handleStreamEvent({
          type: "message_updated",
          message: voiceMessage({ status: "done", text: "words" }, { sender: "Purdy" }),
        });
        expect(pill(view).hidden).toBe(true);
        view.teardown();
      });

      it("is still raised by a genuinely new message from someone else", async () => {
        const view = await mountScrolledUp();
        view.handleStreamEvent({
          type: "message",
          message: fakeMessage({ seq: 99, clientId: "c99", sender: "Purdy", text: "new" }),
        });
        expect(pill(view).hidden).toBe(false);
        view.teardown();
      });
    });

    it("a deleted message takes its transcript with it", async () => {
      usage(true);
      getHistory.mockResolvedValue(
        emptyHistory({ messages: [voiceMessage({ status: "done", text: "gone soon" })] }),
      );
      const view = mount();
      await view.attach(SESSION);
      await flush();
      expect(view.element.textContent).toContain("gone soon");
      view.handleStreamEvent({ type: "message_deleted", seq: 7 });
      expect(view.element.textContent).not.toContain("gone soon");
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
      const hooks: LockHooks = {
      suspend: vi.fn(() => release),
      lockNow: vi.fn(),
      adoptBoundSession: vi.fn(),
      getBoundGrantId: vi.fn(() => null),
    };
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
      const hooks: LockHooks = {
      suspend: vi.fn(() => release),
      lockNow: vi.fn(),
      adoptBoundSession: vi.fn(),
      getBoundGrantId: vi.fn(() => null),
    };
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

describe("reply to a message (round 2 ruling item 10)", () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
    createVoiceRecorder.mockClear();
    getHistory.mockReset();
    getUsage.mockReset().mockResolvedValue({
      mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false,
    });
    sendMessage.mockReset();
    setReaction.mockReset();
    transcribeAttachment.mockReset();
    deleteMessage.mockReset();
    wipeChat.mockReset();
    uploadServerAttachment.mockReset();
    sendViewOnceMessage.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function replyToOf(target: Message): NonNullable<Message["replyTo"]> {
    return { seq: target.seq, sender: target.sender, text: target.text, truncated: false, media: null };
  }

  it("picking Reply from the message menu shows the composer bar and focuses the input", async () => {
    const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    document.body.appendChild(view.element);
    await view.attach(SESSION);

    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();

    const bar = view.element.querySelector<HTMLElement>(".wx-srv-reply-bar");
    expect(bar?.hidden).toBe(false);
    expect(bar?.querySelector(".wx-srv-reply-bar-label")?.textContent).toBe("Replying to Purdy");
    expect(bar?.querySelector(".wx-srv-quote-text")?.textContent).toBe("quote me");
    expect(view.element.querySelector("textarea")).toBe(document.activeElement);
    view.teardown();
  });

  it("shows 'You' in the reply bar when replying to the viewer's own message", async () => {
    const target = fakeMessage({ seq: 1, sender: "Josh", text: "my own message" });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();
    expect(view.element.querySelector(".wx-srv-reply-bar-label")?.textContent).toBe("Replying to You");
    view.teardown();
  });

  it("the ✕ button cancels the pending reply", async () => {
    const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(false);

    view.element.querySelector<HTMLButtonElement>(".wx-srv-reply-bar-cancel")?.click();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(true);
    view.teardown();
  });

  it("picking Reply on a different message replaces the current target", async () => {
    const first = fakeMessage({ seq: 1, sender: "Purdy", text: "first" });
    const second = fakeMessage({ seq: 2, clientId: "c2", sender: "Josh", text: "second" });
    getHistory.mockResolvedValue(emptyHistory({ messages: [first, second], cursor: 2 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);

    const triggers = view.element.querySelectorAll<HTMLButtonElement>(".wx-srv-message-actions-trigger");
    triggers[0]?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();
    expect(view.element.querySelector(".wx-srv-quote-text")?.textContent).toBe("first");

    triggers[1]?.click();
    view.element.querySelectorAll<HTMLButtonElement>(".wx-srv-message-action-reply")[1]?.click();
    expect(view.element.querySelector(".wx-srv-quote-text")?.textContent).toBe("second");
    view.teardown();
  });

  it("sending a reply includes replyToSeq and the echo shows the quote", async () => {
    const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
    let resolveSend!: (result: SendMessageResult) => void;
    sendMessage.mockReturnValue(new Promise((resolve) => { resolveSend = resolve; }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();

    const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "my reply";
    view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
    await flush();

    // The bar clears at once, same moment the text is lifted out.
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(true);
    const [, sent] = sendMessage.mock.calls[0] as [ServerSession, { replyToSeq?: number }];
    expect(sent.replyToSeq).toBe(1);
    const echoQuote = view.element.querySelector(".wx-srv-echo .wx-srv-quote-text");
    expect(echoQuote?.textContent).toBe("quote me");

    resolveSend({ ok: true, message: fakeMessage({ clientId: "generated-uuid-1234", text: "my reply", replyTo: replyToOf(target) }) });
    await flush();
    view.teardown();
  });

  it("a message with no reply target omits replyToSeq entirely", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    sendMessage.mockResolvedValue({ ok: true, message: fakeMessage({ clientId: "generated-uuid-1234" }) } satisfies SendMessageResult);
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "ordinary message";
    view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
    await flush();
    const [, sent] = sendMessage.mock.calls[0] as [ServerSession, { replyToSeq?: number }];
    expect("replyToSeq" in sent).toBe(false);
    view.teardown();
  });

  it("a failed send restores the reply target along with the text", async () => {
    const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
    sendMessage.mockResolvedValue({ ok: false, kind: "unavailable" } satisfies SendMessageResult);
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();

    view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
    await flush();

    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(false);
    expect(view.element.querySelector(".wx-srv-reply-bar .wx-srv-quote-text")?.textContent).toBe("quote me");
    view.teardown();
  });

  it("a sent bubble renders its quote with an accessible name naming the sender", async () => {
    const target = fakeMessage({ seq: 1, sender: "Purdy", text: "the original" });
    const reply = fakeMessage({ seq: 2, clientId: "c2", sender: "Josh", text: "the reply", replyTo: replyToOf(target) });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target, reply], cursor: 2 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);

    const replyBubble = view.element.querySelector('[data-message-seq="2"]')!;
    const quote = replyBubble.querySelector<HTMLButtonElement>(".wx-srv-quote");
    expect(quote?.tagName).toBe("BUTTON");
    expect(quote?.getAttribute("aria-label")).toBe("Show the original message from Purdy");
    expect(quote?.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    expect(quote?.querySelector(".wx-srv-quote-text")?.textContent).toBe("the original");
    view.teardown();
  });

  it("a message with no reply renders no quote", async () => {
    getHistory.mockResolvedValue(emptyHistory({ messages: [fakeMessage({ seq: 1, text: "plain" })], cursor: 1 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    expect(view.element.querySelector(".wx-srv-quote")).toBeNull();
    view.teardown();
  });

  describe("tapping the quote scrolls to the original", () => {
    it("scrolls immediately and highlights it when already loaded", async () => {
      vi.useFakeTimers();
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "the original" });
      const reply = fakeMessage({ seq: 2, clientId: "c2", sender: "Josh", text: "the reply", replyTo: replyToOf(target) });
      getHistory.mockResolvedValue(emptyHistory({ messages: [target, reply], cursor: 2 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const targetBubble = view.element.querySelector('[data-message-seq="1"]')!;
      const scrollSpy = vi.spyOn(targetBubble, "scrollIntoView");
      view.element.querySelector<HTMLButtonElement>(".wx-srv-quote")?.click();
      await flush();

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(targetBubble.classList.contains("wx-srv-bubble-highlighted")).toBe(true);
      expect(getHistory).toHaveBeenCalledTimes(1); // only the initial attach — no paging needed

      vi.advanceTimersByTime(1_500);
      expect(targetBubble.classList.contains("wx-srv-bubble-highlighted")).toBe(false);
      view.teardown();
      vi.useRealTimers();
    });

    it("pages backwards with limit 100 until the target is found", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "old original" });
      const reply = fakeMessage({ seq: 5, clientId: "c5", sender: "Josh", text: "the reply", replyTo: replyToOf(target) });
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [reply], hasMore: true, cursor: 5 }))
        .mockResolvedValueOnce(emptyHistory({ messages: [target], hasMore: false, cursor: 5 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      expect(view.element.querySelector('[data-message-seq="1"]')).toBeNull();

      view.element.querySelector<HTMLButtonElement>(".wx-srv-quote")?.click();
      await flush();

      expect(getHistory).toHaveBeenLastCalledWith(SESSION, { before: 5, limit: 100 });
      expect(view.element.querySelector('[data-message-seq="1"]')).not.toBeNull();
      view.teardown();
    });

    it("shows busy while paging and clears it once resolved", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "old original" });
      const reply = fakeMessage({ seq: 5, clientId: "c5", sender: "Josh", text: "the reply", replyTo: replyToOf(target) });
      getHistory.mockResolvedValueOnce(emptyHistory({ messages: [reply], hasMore: true, cursor: 5 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      let resolvePage!: (page: HistoryPage) => void;
      getHistory.mockReturnValueOnce(new Promise((resolve) => { resolvePage = resolve; }));
      const quote = view.element.querySelector<HTMLButtonElement>(".wx-srv-quote")!;
      void quote.click();
      await flush();
      expect(quote.classList.contains("wx-srv-quote-busy")).toBe(true);

      resolvePage(emptyHistory({ messages: [target], hasMore: false, cursor: 5 }));
      await flush();
      expect(quote.classList.contains("wx-srv-quote-busy")).toBe(false);
      view.teardown();
    });

    it("removes the quote when the target is never found (deleted in the meantime)", async () => {
      const reply = fakeMessage({ seq: 5, sender: "Josh", text: "the reply", replyTo: { seq: 1, sender: "Purdy", text: "gone", truncated: false, media: null } });
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [reply], hasMore: true, cursor: 5 }))
        .mockResolvedValueOnce(emptyHistory({ messages: [], hasMore: false, cursor: 5 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-quote")?.click();
      await flush();

      expect(view.element.querySelector(".wx-srv-quote")).toBeNull();
      view.teardown();
    });

    it("aborts an in-flight paging run when a different quote is tapped", async () => {
      const targetA = fakeMessage({ seq: 1, sender: "Purdy", text: "target A" });
      const targetB = fakeMessage({ seq: 2, clientId: "cB", sender: "Purdy", text: "target B" });
      const replyToA = fakeMessage({ seq: 10, clientId: "r10", sender: "Josh", text: "reply to A", replyTo: replyToOf(targetA) });
      const replyToB = fakeMessage({ seq: 11, clientId: "r11", sender: "Josh", text: "reply to B", replyTo: replyToOf(targetB) });
      getHistory.mockResolvedValueOnce(
        emptyHistory({ messages: [replyToA, replyToB], hasMore: true, cursor: 11 }),
      );
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      let resolveFirstPage!: (page: HistoryPage) => void;
      getHistory.mockReturnValueOnce(new Promise((resolve) => { resolveFirstPage = resolve; }));
      const quotes = view.element.querySelectorAll<HTMLButtonElement>(".wx-srv-quote");
      void quotes[0]?.click(); // starts paging for target A, never resolved yet
      await flush();

      // B's tap while A's request is still in flight: the single history-load
      // slot is busy, so B's own loop retries rather than giving up.
      quotes[1]?.click(); // bumps generation, aborts A's continuation, starts B's
      await flush();
      expect(view.element.querySelector('[data-message-seq="2"]')).toBeNull(); // still blocked

      // A's stale page finally arrives — its own continuation must abort
      // (generation moved on to B) rather than scrolling/highlighting for A,
      // but it does free the history-load slot for B's retry loop to use.
      resolveFirstPage(emptyHistory({ messages: [targetA, targetB], hasMore: false, cursor: 11 }));
      await vi.waitFor(() => {
        expect(view.element.querySelector('[data-message-seq="2"]')).not.toBeNull();
      });
      const bBubble = view.element.querySelector('[data-message-seq="2"]');
      const aBubble = view.element.querySelector('[data-message-seq="1"]');
      expect(bBubble?.classList.contains("wx-srv-bubble-highlighted")).toBe(true);
      expect(aBubble?.classList.contains("wx-srv-bubble-highlighted")).toBe(false);
      expect(getHistory).toHaveBeenCalledTimes(2);
      view.teardown();
    });

    it(
      "a second tap on the SAME quote while the first is still paging does not freeze (audit F2)",
      async () => {
        // The old retry for "blocked" was `await Promise.resolve()` — a microtask-only
        // yield that never lets a REAL in-flight fetch (a macrotask) get a turn to
        // resolve, so `historyLoading` never clears and the loop spins forever. Using
        // a real `setTimeout` here (not a directly-resolved Promise, which settles via
        // microtask and would hide the bug — see the previous test's own comment) is
        // what actually exercises that starvation.
        const target = fakeMessage({ seq: 1, sender: "Purdy", text: "old original" });
        const reply = fakeMessage({ seq: 5, clientId: "c5", sender: "Josh", text: "the reply", replyTo: replyToOf(target) });
        getHistory.mockResolvedValueOnce(emptyHistory({ messages: [reply], hasMore: true, cursor: 5 }));
        const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
        await view.attach(SESSION);

        getHistory.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(emptyHistory({ messages: [target], hasMore: false, cursor: 5 })), 20);
            }),
        );
        const quote = view.element.querySelector<HTMLButtonElement>(".wx-srv-quote")!;
        quote.click(); // starts paging, historyLoading=true, in flight for a real 20ms
        await flush();
        quote.click(); // a second tap on the SAME quote while the first is still in flight

        await vi.waitFor(
          () => expect(view.element.querySelector('[data-message-seq="1"]')).not.toBeNull(),
          { timeout: 2_000 },
        );
        view.teardown();
      },
      4_000,
    );

    it("a network error while paging leaves the quote alone, unlike genuinely running out of history (audit F6)", async () => {
      const reply = fakeMessage({ seq: 5, sender: "Josh", text: "the reply", replyTo: { seq: 1, sender: "Purdy", text: "still there", truncated: false, media: null } });
      getHistory
        .mockResolvedValueOnce(emptyHistory({ messages: [reply], hasMore: true, cursor: 5 }))
        .mockRejectedValueOnce(new Error("network down"));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.element.querySelector<HTMLButtonElement>(".wx-srv-quote")?.click();
      await flush();

      // loadOlderPage's own catch swallows the error and returns "error", not
      // "exhausted" -- the quote must survive, since the target may well still
      // exist; only genuinely running out of history (the sibling test above)
      // means "not found".
      expect(view.element.querySelector(".wx-srv-quote")).not.toBeNull();
      view.teardown();
    });
  });

  it("wipe cancels the pending reply", async () => {
    const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
    wipeChat.mockResolvedValue(false);
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(false);

    await view.wipe();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(true);
    view.teardown();
  });

  it("a lock (detach) keeps the pending reply in memory, unlike a wipe", async () => {
    const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();

    view.detach();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(false);
    expect(view.element.querySelector(".wx-srv-quote-text")?.textContent).toBe("quote me");
    view.teardown();
  });

  describe("message_deleted patches quotes in place (never a full bubble re-render)", () => {
    it("removes just the quote from a bubble that quotes the deleted message", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "will be deleted" });
      const reply = fakeMessage({ seq: 2, clientId: "c2", sender: "Josh", text: "quoting it", replyTo: replyToOf(target) });
      getHistory.mockResolvedValue(emptyHistory({ messages: [target, reply], cursor: 2 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const replyBubble = view.element.querySelector('[data-message-seq="2"]')!;
      expect(replyBubble.querySelector(".wx-srv-quote")).not.toBeNull();

      view.handleStreamEvent({ type: "message_deleted", seq: 1 } as ServerStreamEvent);

      expect(view.element.querySelector('[data-message-seq="2"]')).toBe(replyBubble); // same node, not re-rendered
      expect(replyBubble.querySelector(".wx-srv-quote")).toBeNull();
      expect(replyBubble.querySelector(".wx-srv-bubble-text")?.textContent).toBe("quoting it"); // rest is untouched
      view.teardown();
    });

    it("keeps a playing <audio> element's identity and currentTime in the reply bubble", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "will be deleted" });
      const reply = fakeMessage({
        seq: 2,
        clientId: "c2",
        sender: "Josh",
        text: null,
        replyTo: replyToOf(target),
        attachments: [{
          id: "voice-1", kind: "voice", status: "ready", width: null, height: null,
          durationS: 5, peaks: null, urls: { play: "/voice" },
        }],
      });
      getHistory.mockResolvedValue(emptyHistory({ messages: [target, reply], cursor: 2 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      const audio = view.element.querySelector<HTMLAudioElement>('[data-message-seq="2"] audio')!;
      Object.defineProperty(audio, "currentTime", { value: 2.5, writable: true, configurable: true });
      const pauseSpy = vi.spyOn(audio, "pause");

      view.handleStreamEvent({ type: "message_deleted", seq: 1 } as ServerStreamEvent);

      expect(view.element.querySelector('[data-message-seq="2"] audio')).toBe(audio); // same node
      expect(audio.currentTime).toBe(2.5);
      expect(pauseSpy).not.toHaveBeenCalled();
      view.teardown();
    });

    it("removes the quote from a pending echo that targets the deleted message", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "will be deleted" });
      getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
      let resolveSend!: (result: SendMessageResult) => void;
      sendMessage.mockReturnValue(new Promise((resolve) => { resolveSend = resolve; }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();
      const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "quoting it";
      view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();
      expect(view.element.querySelector(".wx-srv-echo .wx-srv-quote")).not.toBeNull();

      view.handleStreamEvent({ type: "message_deleted", seq: 1 } as ServerStreamEvent);
      expect(view.element.querySelector(".wx-srv-echo .wx-srv-quote")).toBeNull();

      resolveSend({ ok: true, message: fakeMessage({ clientId: "generated-uuid-1234", text: "hi" }) });
      await flush();
      view.teardown();
    });

    it("cancels the composer's pending reply if it targets the deleted message, clearing the bar's content, not just hiding it (audit F8)", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "SENTINEL-WILL-BE-DELETED" });
      getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();
      expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(false);
      expect(view.element.querySelector(".wx-srv-reply-bar-quote")?.textContent).toContain("SENTINEL-WILL-BE-DELETED");

      view.handleStreamEvent({ type: "message_deleted", seq: 1 } as ServerStreamEvent);

      expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(true);
      // Hidden is not erased: ruling item 10 (2) requires no DOM node contain the
      // sentinel at all, and a hidden node whose content survives is exactly what
      // audit F8 found (three separate cancel paths all missed this).
      expect(view.element.querySelector(".wx-srv-reply-bar-label")?.textContent).toBe("");
      expect(view.element.querySelector(".wx-srv-reply-bar-quote")?.textContent).toBe("");
      view.teardown();
    });
  });

  it("message_updated for a replyTo-only change (a target's attachment finishing) patches the quote in place (audit F4)", async () => {
    const target = fakeMessage({
      seq: 1, sender: "Purdy", text: null,
      attachments: [{
        id: "vid-1", kind: "video", status: "processing", width: null, height: null,
        durationS: null, peaks: null, urls: {},
      }],
    });
    const processingReplyTo = { seq: 1, sender: "Purdy", text: null, truncated: false, media: { kind: "video" as const, count: 1, durationS: null, thumbUrl: null } };
    const reply = fakeMessage({
      seq: 2, clientId: "c2", sender: "Josh", text: null, replyTo: processingReplyTo,
      attachments: [{
        id: "voice-1", kind: "voice", status: "ready", width: null, height: null,
        durationS: 5, peaks: null, urls: { play: "/voice" },
      }],
    });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target, reply], cursor: 2 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);

    const replyBubble = view.element.querySelector('[data-message-seq="2"]')!;
    const audio = replyBubble.querySelector<HTMLAudioElement>("audio")!;
    expect(replyBubble.querySelector(".wx-srv-quote-thumb")).toBeNull();

    // Only replyTo changed (the target's video finished processing) -- text,
    // attachments, sender and createdAt on the REPLY itself are unchanged, so
    // sameExceptReactions is true and the safe-patch branch runs.
    const readyReplyTo = { ...processingReplyTo, media: { ...processingReplyTo.media, thumbUrl: "/poster.jpg" } };
    view.handleStreamEvent({
      type: "message_updated",
      message: { ...reply, replyTo: readyReplyTo },
    } as ServerStreamEvent);

    expect(view.element.querySelector('[data-message-seq="2"]')).toBe(replyBubble); // same node
    expect(replyBubble.querySelector<HTMLAudioElement>("audio")).toBe(audio); // media untouched
    const thumb = replyBubble.querySelector<HTMLImageElement>(".wx-srv-quote-thumb");
    expect(thumb).not.toBeNull();
    expect(thumb?.src).toContain("/poster.jpg");
    view.teardown();
  });

  describe("reattach after a lock re-validates reply data the missed stream events can't (audit F3)", () => {
    it("a reply bubble kept alive across reattach drops a quote whose target was deleted during the lock", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "will be deleted while locked" });
      const reply = fakeMessage({ seq: 2, clientId: "c2", sender: "Josh", text: "quoting it", replyTo: replyToOf(target) });
      getHistory.mockResolvedValueOnce(emptyHistory({ messages: [target, reply], cursor: 2 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      const replyBubble = view.element.querySelector('[data-message-seq="2"]')!;
      expect(replyBubble.querySelector(".wx-srv-quote")).not.toBeNull();

      view.detach();
      // The target was deleted while locked -- the stream's own message_deleted
      // never arrives (the stream resumes from a fresh cursor on reattach), but
      // the server resolves replyTo fresh on every read, so the refreshed page
      // already carries replyTo: null for the reply. The reply's own text and
      // attachments are unchanged, so it's a "safe patch" candidate, not a rebuild.
      getHistory.mockResolvedValueOnce(
        emptyHistory({ messages: [{ ...reply, replyTo: null }], cursor: 2 }),
      );
      await view.attach(SESSION);

      expect(view.element.querySelector('[data-message-seq="2"]')).toBe(replyBubble); // same node
      expect(replyBubble.querySelector(".wx-srv-quote")).toBeNull();
      expect(replyBubble.querySelector(".wx-srv-bubble-text")?.textContent).toBe("quoting it");
      view.teardown();
    });

    it("a pending (not-yet-sent) reply targeting a message deleted during the lock is cancelled on reattach", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
      getHistory.mockResolvedValueOnce(emptyHistory({ messages: [target], cursor: 1 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();
      expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(false);

      view.detach();
      // Target gone from the refreshed history -- deleted while locked.
      getHistory.mockResolvedValueOnce(emptyHistory({ messages: [], cursor: 1 }));
      await view.attach(SESSION);

      expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(true);
      view.teardown();
    });

    it("a lock with no deletions during it leaves a pending reply exactly as it was", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
      getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();

      view.detach();
      await view.attach(SESSION); // same target still in every refreshed page

      expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(false);
      view.teardown();
    });
  });

  describe("in-flight data can never resurrect a deleted target's words (audit F5)", () => {
    it("a message arriving (e.g. a stale history page) whose replyTo targets an already-deleted seq has that replyTo stripped", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "will be deleted" });
      getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);

      view.handleStreamEvent({ type: "message_deleted", seq: 1 } as ServerStreamEvent);

      // A page read before the delete but delivered after it -- exactly what a
      // slow/racing fetch or a queued stream frame looks like.
      view.handleStreamEvent({
        type: "message",
        message: fakeMessage({ seq: 2, clientId: "c2", sender: "Josh", text: "quoting it", replyTo: replyToOf(target) }),
      } as ServerStreamEvent);

      expect(view.element.querySelector('[data-message-seq="2"] .wx-srv-quote')).toBeNull();
      view.teardown();
    });

    it("a failed send does not restore the reply bar for a target deleted while the send was in flight", async () => {
      const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
      getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
      let resolveSend!: (result: SendMessageResult) => void;
      sendMessage.mockReturnValue(new Promise((resolve) => { resolveSend = resolve; }));
      const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
      await view.attach(SESSION);
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();
      const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "a reply";
      view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();
      expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(true); // cleared while sending

      // The target is deleted while the send is still in flight.
      view.handleStreamEvent({ type: "message_deleted", seq: 1 } as ServerStreamEvent);
      resolveSend({ ok: false, kind: "unavailable" });
      await flush();

      expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(true);
      view.teardown();
    });
  });

  it("a stopped voice note captures the reply target and clears the bar", async () => {
    const target = fakeMessage({ seq: 1, sender: "Purdy", text: "quote me" });
    getHistory.mockResolvedValue(emptyHistory({ messages: [target], cursor: 1 }));
    uploadServerAttachment.mockResolvedValue({
      id: "voice-id", kind: "voice", status: "processing", width: null, height: null,
      durationS: 2, peaks: null, urls: {},
    } satisfies UploadAttachment);
    sendMessage.mockResolvedValue({
      ok: true,
      message: fakeMessage({ clientId: "generated-uuid-1234", text: null, replyTo: replyToOf(target) }),
    } satisfies SendMessageResult);
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: fakeWindow(), onSettings: vi.fn() });
    await view.attach(SESSION);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-message-action-reply")?.click();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(false);

    view.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")?.click();
    await flush();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")?.click();
    await flush();

    expect(view.element.querySelector<HTMLElement>(".wx-srv-reply-bar")?.hidden).toBe(true);
    const [, sent] = sendMessage.mock.calls[0] as [ServerSession, { replyToSeq?: number }];
    expect(sent.replyToSeq).toBe(1);
    view.teardown();
  });

  it("renders view-once recipient placeholder card with 'Tap to view' button carrying gesture boundary", async () => {
    const voMsg = fakeMessage({
      seq: 201,
      sender: "Purdy",
      text: null,
      attachments: [{
        id: "att-vo-1",
        kind: "photo",
        status: "ready",
        width: 800,
        height: 600,
        durationS: null,
        peaks: null,
        urls: {},
      }],
      viewOnce: { durationS: 5, spotlight: true },
    });
    getHistory.mockResolvedValue(emptyHistory({ messages: [voMsg], cursor: 201 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const card = view.element.querySelector(".wx-srv-view-once-recipient-card");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("View once · 5 s");
    expect(card?.textContent).toContain("Spotlight");

    const tapBtn = card?.querySelector<HTMLButtonElement>(".wx-srv-view-once-tap-btn");
    expect(tapBtn).toBeTruthy();
    expect(tapBtn?.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    expect(tapBtn?.textContent).toContain("Tap to view");

    const warning = card?.querySelector(".wx-srv-view-once-card-warning");
    expect(warning).toBeTruthy();
    expect(warning?.textContent).toContain("Opening it uses it up.");

    view.teardown();
  });

  it("renders view-once sender placeholder card without 'Tap to view' button", async () => {
    const voMsg = fakeMessage({
      seq: 202,
      sender: "Josh",
      text: null,
      attachments: [{
        id: "att-vo-2",
        kind: "photo",
        status: "ready",
        width: 800,
        height: 600,
        durationS: null,
        peaks: null,
        urls: {},
      }],
      viewOnce: { durationS: 30, spotlight: false },
    });
    getHistory.mockResolvedValue(emptyHistory({ messages: [voMsg], cursor: 202 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const card = view.element.querySelector(".wx-srv-view-once-sender-card");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("View-once photo · 30 s · Not opened yet");
    const tapBtn = card?.querySelector(".wx-srv-view-once-tap-btn");
    expect(tapBtn).toBeNull();

    view.teardown();
  });

  it("tapping 'Tap to view' opens the viewer; message_deleted removes bubble but leaves viewer OPEN", async () => {
    const voMsg = fakeMessage({
      seq: 203,
      sender: "Purdy",
      text: null,
      attachments: [{
        id: "att-vo-3",
        kind: "photo",
        status: "ready",
        width: 800,
        height: 600,
        durationS: null,
        peaks: null,
        urls: {},
      }],
      viewOnce: { durationS: 5, spotlight: false },
    });
    getHistory.mockResolvedValue(emptyHistory({ messages: [voMsg], cursor: 203 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const tapBtn = view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-tap-btn");
    expect(tapBtn).toBeTruthy();

    tapBtn?.click();
    await flush();

    const overlay = document.body.querySelector(".wx-srv-view-once-overlay");
    expect(overlay).toBeTruthy();

    // Now emit message_deleted event for this message seq
    view.handleStreamEvent({ type: "message_deleted", seq: 203 } as ServerStreamEvent);
    await flush();

    // The bubble in the message list must be removed
    expect(view.element.querySelector(".wx-srv-view-once-recipient-card")).toBeNull();

    // CRITICAL REQUIREMENT: The viewer MUST NOT close on message_deleted!
    expect(document.body.querySelector(".wx-srv-view-once-overlay")).toBeTruthy();

    // Calling detach (lock) closes the active viewer
    view.detach();
    expect(document.body.querySelector(".wx-srv-view-once-overlay")).toBeNull();

    view.teardown();
  });

  it("chat wipe closes the active viewOnce viewer", async () => {
    const voMsg = fakeMessage({
      seq: 204,
      sender: "Purdy",
      text: null,
      attachments: [{
        id: "att-vo-4",
        kind: "photo",
        status: "ready",
        width: 800,
        height: 600,
        durationS: null,
        peaks: null,
        urls: {},
      }],
      viewOnce: { durationS: 5, spotlight: false },
    });
    getHistory.mockResolvedValue(emptyHistory({ messages: [voMsg], cursor: 204 }));
    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-tap-btn")?.click();
    await flush();

    expect(document.body.querySelector(".wx-srv-view-once-overlay")).toBeTruthy();

    // Wipe chat event arrives
    view.handleStreamEvent({ type: "wiped" } as ServerStreamEvent);
    await flush();

    expect(document.body.querySelector(".wx-srv-view-once-overlay")).toBeNull();
    view.teardown();
  });

  it("a full-size composer button (not a per-chip badge) shows the targeted file's thumbnail, and the choice STICKS to its file — staging another file never moves it (Architect ratification, decisions/00169 condition #3, superseding the earlier 'always retarget to newest' design)", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment
      .mockResolvedValueOnce({
        id: "att-1", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment)
      .mockResolvedValueOnce({
        id: "att-2", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment);

    const injectedVoSettings = new WeakMap<File, ViewOnceDraftSettings>();
    const view = mountServerThread({
      identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn(),
      fileViewOnceSettings: injectedVoSettings,
    });
    await view.attach(SESSION);

    const viewOnceButton = view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!;
    // Condition #2: always visible (never `hidden`), just disabled when nothing is eligible.
    expect(viewOnceButton.hidden).toBe(false);
    expect(viewOnceButton.disabled).toBe(true);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photoA = new File(["photoA"], "photoA.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photoA], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    expect(viewOnceButton.disabled).toBe(false);
    expect(viewOnceButton.textContent).toBe("⏱ View once");

    // Open the sheet (a real DOM element, appended to document.body — never clipped by a chip)
    // and confirm it shows the targeted file's thumbnail (condition #1) before setting A to 2s.
    viewOnceButton.click();
    await flush();
    const sheetA = document.body.querySelector(".wx-srv-view-once-sheet")!;
    expect(sheetA).toBeTruthy();
    expect(sheetA.querySelector(".wx-srv-view-once-sheet-thumb img")).toBeTruthy();
    expect(sheetA.querySelector(".wx-srv-view-once-sheet-filename")?.textContent).toBe("photoA.jpg");
    sheetA.querySelector<HTMLButtonElement>(".wx-srv-view-once-dur-btn:nth-child(1)")!.click();
    await flush();

    expect(viewOnceButton.classList.contains("wx-srv-view-once-toggle-active")).toBe(true);
    expect(viewOnceButton.textContent).toContain("2s");
    expect(injectedVoSettings.get(photoA)?.enabled).toBe(true);
    expect(document.body.querySelector(".wx-srv-view-once-sheet")).toBeNull(); // closes on pick
    // Condition #4: the chip itself now shows a status marker, drawn inside its own box.
    expect(
      view.element.querySelector(".wx-chat-attachment-chip .wx-srv-view-once-chip-marker")?.textContent,
    ).toBe("⏱ 2s");

    // Staging a SECOND, different photo must NOT move the flag (condition #3 — a direct reversal
    // of the earlier "always retarget to newest" design). The button keeps showing A's setting.
    const photoB = new File(["photoB"], "photoB.jpg", { type: "image/jpeg" });
    const inputAgain = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(inputAgain, "files", { value: [photoB], configurable: true });
    inputAgain.dispatchEvent(new Event("change"));
    await flush();

    expect(viewOnceButton.classList.contains("wx-srv-view-once-toggle-active")).toBe(true);
    expect(viewOnceButton.textContent).toContain("2s");
    expect(injectedVoSettings.get(photoA)?.enabled).toBe(true);
    expect(injectedVoSettings.get(photoB)?.enabled ?? false).toBe(false);

    // Opening the sheet now still targets A (the sticky, flagged file), not B.
    viewOnceButton.click();
    await flush();
    const sheetStillA = document.body.querySelector(".wx-srv-view-once-sheet")!;
    expect(sheetStillA.querySelector(".wx-srv-view-once-sheet-filename")?.textContent).toBe("photoA.jpg");

    // "Send normally" clears A's flag; the target then falls back to the most recently staged
    // eligible file (B), matching "removal clears" — clearing via the sheet behaves the same way.
    sheetStillA.querySelector<HTMLButtonElement>(".wx-srv-view-once-send-normally")!.click();
    await flush();

    expect(injectedVoSettings.get(photoA)?.enabled).toBe(false);
    expect(viewOnceButton.classList.contains("wx-srv-view-once-toggle-active")).toBe(false);
    expect(viewOnceButton.textContent).toBe("⏱ View once");
    expect(
      view.element.querySelector(".wx-chat-attachment-chip .wx-srv-view-once-chip-marker")?.textContent,
    ).toBe("");

    viewOnceButton.click();
    await flush();
    const sheetB = document.body.querySelector(".wx-srv-view-once-sheet")!;
    expect(sheetB.querySelector(".wx-srv-view-once-sheet-filename")?.textContent).toBe("photoB.jpg");
    sheetB.querySelector<HTMLButtonElement>(".wx-srv-view-once-dur-btn:nth-child(2)")!.click();
    await flush();

    expect(injectedVoSettings.get(photoB)?.enabled).toBe(true);
    expect(viewOnceButton.textContent).toContain("5s");

    view.teardown();
  });

  it("removing the specifically-flagged chip clears its flag and falls back to the next staged file (condition #3's 'removal clears'), while removing a DIFFERENT chip leaves the flag untouched, and the button disables (never hides) once nothing is staged", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment
      .mockResolvedValueOnce({
        id: "att-1", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment)
      .mockResolvedValueOnce({
        id: "att-2", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment);

    const injectedVoSettings = new WeakMap<File, ViewOnceDraftSettings>();
    const view = mountServerThread({
      identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn(),
      fileViewOnceSettings: injectedVoSettings,
    });
    await view.attach(SESSION);

    const viewOnceButton = view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!;
    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photoA = new File(["photoA"], "photoA.jpg", { type: "image/jpeg" });
    const photoB = new File(["photoB"], "photoB.jpg", { type: "image/jpeg" });

    // Stage and flag A first (the sticky target), THEN stage B — proving a later staging never
    // moves an already-sticky flag (condition #3), unlike an index/"latest" based target.
    Object.defineProperty(input, "files", { value: [photoA], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    viewOnceButton.click();
    await flush();
    document.body.querySelector<HTMLButtonElement>(".wx-srv-view-once-durations button:nth-child(1)")!.click();
    await flush();
    expect(injectedVoSettings.get(photoA)?.enabled).toBe(true);

    const inputAgain = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(inputAgain, "files", { value: [photoB], configurable: true });
    inputAgain.dispatchEvent(new Event("change"));
    await flush();
    expect(injectedVoSettings.get(photoA)?.enabled).toBe(true); // still sticky after staging B

    // Removing B (a DIFFERENT chip from the flagged one) must leave A's flag untouched.
    const chips = view.element.querySelectorAll<HTMLButtonElement>(".wx-chat-attachment-chip");
    expect(chips).toHaveLength(2);
    chips[1]!.querySelector<HTMLButtonElement>(".wx-chat-attachment-remove")!.click();
    await flush();
    expect(injectedVoSettings.get(photoA)?.enabled).toBe(true);
    expect(viewOnceButton.classList.contains("wx-srv-view-once-toggle-active")).toBe(true);

    // Removing A itself (the flagged chip, with nothing else staged) clears the flag, and the
    // button DISABLES — it is never `hidden` (condition #2: its position never jumps).
    const removeButton = view.element.querySelector<HTMLButtonElement>(".wx-chat-attachment-remove")!;
    removeButton.click();
    await flush();

    expect(viewOnceButton.hidden).toBe(false);
    expect(viewOnceButton.disabled).toBe(true);
    expect(document.body.querySelector(".wx-srv-view-once-sheet")).toBeNull();

    view.teardown();
  });

  it("reopening the sheet is a real, unclipped body-level element (operator report, round 2)", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment.mockResolvedValueOnce({
      id: "att-1", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
    } satisfies UploadAttachment);

    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const viewOnceButton = view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!;
    expect(viewOnceButton.hidden).toBe(false);
    expect(viewOnceButton.disabled).toBe(true);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photo = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photo], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    expect(viewOnceButton.disabled).toBe(false);

    viewOnceButton.click();
    await flush();
    const sheet = document.body.querySelector(".wx-srv-view-once-sheet");
    expect(sheet).not.toBeNull();
    // Genuinely reachable in real layout, not merely present in the DOM (the exact class of bug
    // that shipped: the old picker existed in the DOM but was clipped to zero visible area by an
    // ancestor's `overflow: hidden`).
    expect(sheet!.closest(".wx-chat-attachment-chip")).toBeNull();
    expect(document.body.contains(sheet)).toBe(true);

    const removeButton = view.element.querySelector<HTMLButtonElement>(".wx-chat-attachment-remove")!;
    removeButton.click();
    await flush();

    expect(viewOnceButton.disabled).toBe(true);
    expect(document.body.querySelector(".wx-srv-view-once-sheet")).toBeNull();

    view.teardown();
  });

  it("hard guard: aborts send and sends nothing if multiple chips are flagged view-once (bypass UI) (Item 2)", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment
      .mockResolvedValueOnce({
        id: "att-1", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment)
      .mockResolvedValueOnce({
        id: "att-2", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment);

    const injectedVoSettings = new WeakMap<File, any>();
    const view = mountServerThread({
      identity: fakeIdentity("Josh"),
      hooks: fakeHooks(),
      win: window,
      onSettings: vi.fn(),
      fileViewOnceSettings: injectedVoSettings,
    });
    await view.attach(SESSION);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photoA = new File(["photoA"], "photoA.jpg", { type: "image/jpeg" });
    const photoB = new File(["photoB"], "photoB.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photoA, photoB], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    // Bypass UI: force both chips to have view-once enabled
    injectedVoSettings.set(photoA, { enabled: true, durationS: 5, spotlight: false });
    injectedVoSettings.set(photoB, { enabled: true, durationS: 5, spotlight: false });

    // Reset mocks to monitor what gets sent
    sendMessage.mockClear();
    sendViewOnceMessage.mockClear();

    // Tap Send
    const sendBtn = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    sendBtn.click();
    await flush();

    // Nothing must be sent!
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendViewOnceMessage).not.toHaveBeenCalled();

    // Error shown and draft restored
    const errEl = view.element.querySelector(".wx-chat-composer-error");
    expect(errEl?.textContent).toBeTruthy();
    expect(view.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(2);

    view.teardown();
  });

  it("bounds preparing retry loop to 60s cap and restores draft (Item 5)", async () => {
    vi.useFakeTimers();
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment.mockResolvedValueOnce({
      id: "att-prep-1", kind: "photo", status: "processing", width: 800, height: 600, durationS: null, peaks: null, urls: {},
    } satisfies UploadAttachment);
    sendViewOnceMessage.mockResolvedValue({ ok: false, kind: "not_ready" });

    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photo = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photo], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    const chip = view.element.querySelector(".wx-chat-attachment-chip")!;
    view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!.click();
    await flush();
    document.body.querySelector<HTMLButtonElement>(".wx-srv-view-once-durations button:nth-child(1)")!.click();
    await flush();

    const sendBtn = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    sendBtn.click();
    await flush();

    // While preparing, button text changes to Preparing… AND button is disabled (Item 18)
    expect(sendBtn.textContent).toBe("Preparing…");
    expect(sendBtn.disabled).toBe(true);

    // Advance past 60s
    await vi.advanceTimersByTimeAsync(61_000);
    await flush();

    expect(sendBtn.disabled).toBe(false);
    const errEl = view.element.querySelector(".wx-chat-composer-error");
    expect(errEl?.textContent).toContain("Still preparing");
    expect(view.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(1);

    view.teardown();
    vi.useRealTimers();
  });

  it("stops preparing retry loop immediately on lock mid-wait (Item 5)", async () => {
    vi.useFakeTimers();
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment.mockResolvedValueOnce({
      id: "att-prep-2", kind: "photo", status: "processing", width: 800, height: 600, durationS: null, peaks: null, urls: {},
    } satisfies UploadAttachment);
    sendViewOnceMessage.mockResolvedValue({ ok: false, kind: "not_ready" });

    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photo = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photo], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    const chip = view.element.querySelector(".wx-chat-attachment-chip")!;
    view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!.click();
    await flush();
    document.body.querySelector<HTMLButtonElement>(".wx-srv-view-once-durations button:nth-child(1)")!.click();
    await flush();

    const sendBtn = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    sendBtn.click();
    await flush();

    await vi.advanceTimersByTimeAsync(600);
    const countBeforeLock = sendViewOnceMessage.mock.calls.length;
    expect(countBeforeLock).toBeGreaterThan(0);

    // Lock occurs mid-wait
    view.detach();
    await flush();

    // Advance time further
    await vi.advanceTimersByTimeAsync(5000);
    await flush();

    // Must not continue polling after lock
    expect(sendViewOnceMessage.mock.calls.length).toBe(countBeforeLock);

    view.teardown();
    vi.useRealTimers();
  });

  it("partial failure (a): ordinary companion fails -> does NOT send view-once and restores whole draft (Item 6)", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment
      .mockResolvedValueOnce({
        id: "att-ord-1", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment)
      .mockResolvedValueOnce({
        id: "att-vo-1", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment);

    sendMessage.mockResolvedValueOnce({ ok: false, kind: "network" });
    sendViewOnceMessage.mockClear();

    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Companion text";
    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photoA = new File(["photoA"], "photoA.jpg", { type: "image/jpeg" });
    const photoB = new File(["photoB"], "photoB.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photoA, photoB], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    // Flag chip B as view-once
    const chips = view.element.querySelectorAll(".wx-chat-attachment-chip");
    expect(chips).toHaveLength(2);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!.click();
    await flush();
    document.body.querySelector<HTMLButtonElement>(".wx-srv-view-once-durations button:nth-child(1)")!.click();
    await flush();

    const sendBtn = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    sendBtn.click();
    await flush();

    // Ordinary message was attempted
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // CRITICAL: view-once MUST NOT have been sent!
    expect(sendViewOnceMessage).not.toHaveBeenCalled();

    // Whole draft restored (both text and both chips)
    expect(textarea.value).toBe("Companion text");
    expect(view.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(2);
    expect(view.element.querySelector(".wx-chat-composer-error")?.textContent).toBeTruthy();

    view.teardown();
  });

  it("partial failure (b): ordinary succeeds, view-once fails -> restores ONLY view-once chip (Item 6)", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment
      .mockResolvedValueOnce({
        id: "att-ord-2", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment)
      .mockResolvedValueOnce({
        id: "att-vo-2", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
      } satisfies UploadAttachment);

    sendMessage.mockResolvedValueOnce({
      ok: true,
      message: fakeMessage({ text: "Companion text", attachments: [] }),
    });
    sendViewOnceMessage.mockResolvedValueOnce({ ok: false, kind: "invalid", detail: "Bad VO" });

    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Companion text";
    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photoA = new File(["photoA"], "photoA.jpg", { type: "image/jpeg" });
    const photoB = new File(["photoB"], "photoB.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photoA, photoB], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    // Flag chip B as view-once
    const chips = view.element.querySelectorAll(".wx-chat-attachment-chip");
    expect(chips).toHaveLength(2);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!.click();
    await flush();
    document.body.querySelector<HTMLButtonElement>(".wx-srv-view-once-durations button:nth-child(1)")!.click();
    await flush();

    const sendBtn = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    sendBtn.click();
    await flush();

    // Ordinary message succeeded
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // View-once message was attempted and failed
    expect(sendViewOnceMessage).toHaveBeenCalledTimes(1);

    // CRITICAL: Draft restored must contain ONLY the view-once chip!
    expect(textarea.value).toBe("");
    const restoredChips = view.element.querySelectorAll(".wx-chat-attachment-chip");
    expect(restoredChips).toHaveLength(1);
    const viewOnceButton = view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!;
    expect(viewOnceButton.hidden).toBe(false);
    expect(viewOnceButton.classList.contains("wx-srv-view-once-toggle-active")).toBe(true);

    view.teardown();
  });

  it("F3: lock during view-once send clears composer busy and restores draft", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment.mockResolvedValueOnce({
      id: "att-vo-lock", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
    } satisfies UploadAttachment);

    sendViewOnceMessage.mockRejectedValueOnce(new ServerLockedError());

    const hooks = fakeHooks();
    const lockNowSpy = vi.spyOn(hooks, "lockNow");

    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks, win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photo = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photo], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    const chip = view.element.querySelector(".wx-chat-attachment-chip")!;
    view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!.click();
    await flush();
    document.body.querySelector<HTMLButtonElement>(".wx-srv-view-once-durations button:nth-child(1)")!.click();
    await flush();

    const sendBtn = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    sendBtn.click();
    await flush();

    expect(lockNowSpy).toHaveBeenCalledWith("unauthorized");

    // The draft must be restored!
    const restoredChips = view.element.querySelectorAll(".wx-chat-attachment-chip");
    expect(restoredChips).toHaveLength(1);

    // Composer must not be stuck busy (send button not disabled by busy flag)
    expect(sendBtn.disabled).toBe(false);

    view.teardown();
  });

  it("F4: view-once send reuses the same clientId across retries of the same attempt", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment.mockResolvedValueOnce({
      id: "att-vo-retry", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
    } satisfies UploadAttachment);

    // First attempt fails (dropped response / network timeout)
    sendViewOnceMessage.mockRejectedValueOnce(new Error("network timeout"));
    // Retry succeeds
    sendViewOnceMessage.mockResolvedValueOnce({
      ok: true,
      message: fakeMessage({ text: null, attachments: [] }),
    });

    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photo = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photo], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    const chip = view.element.querySelector(".wx-chat-attachment-chip")!;
    view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!.click();
    await flush();
    document.body.querySelector<HTMLButtonElement>(".wx-srv-view-once-durations button:nth-child(1)")!.click();
    await flush();

    const sendBtn = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;

    // First send attempt
    sendBtn.click();
    await flush();

    expect(sendViewOnceMessage).toHaveBeenCalledTimes(1);
    const firstClientId = (sendViewOnceMessage.mock.calls[0] as any)[1].clientId;
    expect(typeof firstClientId).toBe("string");

    // Retry send
    sendBtn.click();
    await flush();

    expect(sendViewOnceMessage).toHaveBeenCalledTimes(2);
    const secondClientId = (sendViewOnceMessage.mock.calls[1] as any)[1].clientId;

    // Must reuse the exact same clientId for idempotency!
    expect(secondClientId).toBe(firstClientId);

    view.teardown();
  });

  it("F9: lock mid-request discards draft on success and clears clientIds", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment.mockResolvedValueOnce({
      id: "att-vo-f9-succ", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
    } satisfies UploadAttachment);

    let resolveSend!: (res: SendViewOnceResult) => void;
    sendViewOnceMessage.mockReturnValueOnce(new Promise((resolve) => {
      resolveSend = resolve;
    }));

    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photo = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photo], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    const chip = view.element.querySelector(".wx-chat-attachment-chip")!;
    view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!.click();
    await flush();
    document.body.querySelector<HTMLButtonElement>(".wx-srv-view-once-durations button:nth-child(1)")!.click();
    await flush();

    const sendBtn = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    sendBtn.click();
    await flush();

    // Lock lands while send is in flight:
    view.detach();

    // Server responds with success
    resolveSend({
      ok: true,
      message: fakeMessage({ text: null, attachments: [] }),
    });
    await flush();

    // Draft must NOT be restored (it succeeded!)
    const restoredChips = view.element.querySelectorAll(".wx-chat-attachment-chip");
    expect(restoredChips).toHaveLength(0);

    view.teardown();
  });

  it("F9: lock mid-request preserves clientId on failure so retry reuses it", async () => {
    getHistory.mockResolvedValue(emptyHistory());
    uploadServerAttachment.mockResolvedValueOnce({
      id: "att-vo-f9-fail", kind: "photo", status: "ready", width: 800, height: 600, durationS: null, peaks: null, urls: {},
    } satisfies UploadAttachment);

    let resolveSend!: (res: SendViewOnceResult) => void;
    sendViewOnceMessage.mockReturnValueOnce(new Promise((resolve) => {
      resolveSend = resolve;
    }));
    sendViewOnceMessage.mockResolvedValueOnce({
      ok: true,
      message: fakeMessage({ text: null, attachments: [] }),
    });

    const view = mountServerThread({ identity: fakeIdentity("Josh"), hooks: fakeHooks(), win: window, onSettings: vi.fn() });
    await view.attach(SESSION);

    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const photo = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [photo], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();

    const chip = view.element.querySelector(".wx-chat-attachment-chip")!;
    view.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-toggle-button")!.click();
    await flush();
    document.body.querySelector<HTMLButtonElement>(".wx-srv-view-once-durations button:nth-child(1)")!.click();
    await flush();

    const sendBtn = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    sendBtn.click();
    await flush();

    expect(sendViewOnceMessage).toHaveBeenCalledTimes(1);
    const firstClientId = (sendViewOnceMessage.mock.calls[0] as any)[1].clientId;

    // Lock lands while send is in flight:
    view.detach();

    // Server responds with failure (network error / unavailable)
    resolveSend({ ok: false, kind: "unavailable" });
    await flush();

    // Reattach (simulate unlock)
    await view.attach(SESSION);
    await flush();

    // Draft was restored:
    const restoredChips = view.element.querySelectorAll(".wx-chat-attachment-chip");
    expect(restoredChips).toHaveLength(1);

    // Retry send
    sendBtn.click();
    await flush();

    expect(sendViewOnceMessage).toHaveBeenCalledTimes(2);
    const secondClientId = (sendViewOnceMessage.mock.calls[1] as any)[1].clientId;
    expect(secondClientId).toBe(firstClientId);

    view.teardown();
  });
});


