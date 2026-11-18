import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServerLockedError } from "../src/server/api/http";
import type { HistoryPage, Message, SendMessageResult } from "../src/server/api/messages";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerThread } from "../src/server/thread";
import type { UploadAttachment } from "../src/server/upload";
import type { LockHooks, ServerSession } from "../src/server/types";

// Long voice notes, uploaded live (spec/server-chat/06 §2.3): how the thread drives the live
// uploader around a recording, and the "Unsent voice note" cards beside the composer.

interface RecorderOptions {
  onStop?: (recording: { blob: Blob; durationMs: number; mimeType: string }) => void;
  onCancel?: () => void;
  onStart?: (info: { mimeType: string }) => void;
  onSlice?: (blob: Blob, index: number, elapsedMs: number) => void;
  onTimer?: (elapsedMs: number) => void;
}

const { createVoiceRecorder, getHistory, getUsage, sendMessage, uploadServerAttachment, createServerLiveUploader, listUnsentUploads, completeUnsentUpload, discardUpload } = vi.hoisted(() => ({
  createVoiceRecorder: vi.fn((options: RecorderOptions) => {
    let state: "idle" | "starting" | "recording" | "paused" | "stopping" = "idle";
    return {
      get state() { return state; },
      elapsedMs: 2000,
      supportsPause: true,
      start: vi.fn(async () => { state = "recording"; }),
      pause: vi.fn(() => { state = "paused"; }),
      resume: vi.fn(() => { state = "recording"; }),
      stop: vi.fn(() => {
        state = "idle";
        options.onStop?.({ blob: new Blob(["voice"]), durationMs: 2000, mimeType: "audio/webm;codecs=opus" });
      }),
      cancel: vi.fn(() => { state = "idle"; options.onCancel?.(); }),
      toggle: vi.fn(async () => { state = "idle"; }),
      detach: vi.fn(() => { if (state !== "idle") { state = "idle"; options.onCancel?.(); } }),
    };
  }),
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  sendMessage: vi.fn(),
  uploadServerAttachment: vi.fn(),
  createServerLiveUploader: vi.fn(),
  listUnsentUploads: vi.fn(),
  completeUnsentUpload: vi.fn(),
  discardUpload: vi.fn(),
}));
vi.mock("../src/server/recorder", () => ({ createVoiceRecorder }));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
  sendMessage,
}));
vi.mock("../src/server/api/uploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/uploads")>()),
  uploadServerAttachment,
  createServerLiveUploader,
  listUnsentUploads,
  completeUnsentUpload,
  discardUpload,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function fakeIdentity(): ServerIdentity {
  return {
    getName: () => "Josh",
    setName: vi.fn(),
    getDeviceId: () => "device-1",
    isMine: (sender: string) => sender.toLowerCase() === "josh",
  };
}

function fakeHooks(): LockHooks & { lockNow: ReturnType<typeof vi.fn> } {
  return {
    suspend: vi.fn(() => () => {}),
    lockNow: vi.fn(),
    adoptBoundSession: vi.fn(),
    getBoundGrantId: vi.fn(() => null),
    suspendLive: vi.fn(() => ({ touch() {}, release() {} })),
    activityCount: vi.fn(() => 0),
  } as unknown as LockHooks & { lockNow: ReturnType<typeof vi.fn> };
}

function fakeWindow(): Window {
  let n = 0;
  return {
    crypto: { randomUUID: () => `generated-uuid-${(n += 1)}` },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  } as unknown as Window;
}

const emptyHistory = (): HistoryPage => ({ messages: [], hasMore: false, cursor: 0 });

function voiceAttachment(id: string): UploadAttachment {
  return { id, kind: "voice", status: "processing", width: null, height: null, durationS: 2, peaks: null, urls: {} };
}

function sentMessage(id: string, clientId = "c"): SendMessageResult {
  return {
    ok: true,
    message: {
      seq: 5, clientId, sender: "Josh", text: null, reactions: [], createdAt: Date.now() / 1000, replyTo: null,
      attachments: [{ ...voiceAttachment(id), status: "processing" }],
    } as Message,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function fakeLive(overrides: Partial<{ uploadId: string | null; finish: () => Promise<UploadAttachment | null> }> = {}) {
  return {
    uploadId: overrides.uploadId ?? "live-1",
    push: vi.fn(),
    finish: vi.fn(overrides.finish ?? (async () => voiceAttachment("live-att"))),
    cancel: vi.fn(async () => undefined),
    abandon: vi.fn(),
  };
}

async function mount(hooks = fakeHooks()) {
  const view = mountServerThread({ identity: fakeIdentity(), hooks, win: fakeWindow(), onSettings: vi.fn() });
  await view.attach(SESSION);
  await flush();
  return { view, hooks };
}

const recorderOptions = (): RecorderOptions => createVoiceRecorder.mock.calls.at(-1)?.[0] as RecorderOptions;
const recordButton = (view: { element: HTMLElement }) => view.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")!;

/** Start a recording the way the recorder would: tap record, then the recorder reports it began. */
async function startRecording(view: { element: HTMLElement }, mimeType = "audio/webm;codecs=opus") {
  recordButton(view).click();
  await flush();
  recorderOptions().onStart?.({ mimeType });
}

beforeEach(() => {
  createVoiceRecorder.mockClear();
  getHistory.mockReset().mockResolvedValue(emptyHistory());
  getUsage.mockReset().mockResolvedValue({
    mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false,
  });
  sendMessage.mockReset();
  uploadServerAttachment.mockReset();
  createServerLiveUploader.mockReset();
  listUnsentUploads.mockReset().mockResolvedValue([]);
  completeUnsentUpload.mockReset();
  discardUpload.mockReset();
});

describe("a voice note uploaded live while it is recorded", () => {
  it("opens a live upload when recording begins, feeds it every slice, and sends the attachment its complete returned", async () => {
    const live = fakeLive();
    createServerLiveUploader.mockReturnValue(live);
    sendMessage.mockResolvedValue(sentMessage("live-att"));
    const { view } = await mount();

    await startRecording(view, "audio/webm;codecs=opus");
    expect(createServerLiveUploader).toHaveBeenCalledTimes(1);
    const [getSession, options] = createServerLiveUploader.mock.calls[0] as [() => ServerSession | null, { mimeType: string; deviceId: string }];
    expect(getSession()).toBe(SESSION);
    expect(options).toMatchObject({ mimeType: "audio/webm", deviceId: "device-1" });

    const slice = new Blob(["s"]);
    recorderOptions().onSlice?.(slice, 0, 15000);
    expect(live.push).toHaveBeenCalledWith(slice, 0, 15000);

    recordButton(view).click(); // stop and send
    await flush();

    expect(live.finish).toHaveBeenCalledOnce();
    expect(uploadServerAttachment).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ text: null, attachmentIds: ["live-att"], deviceId: "device-1" });
    view.teardown();
  });

  it("falls back to uploading the whole kept recording when the live upload failed for good", async () => {
    const live = fakeLive({ finish: async () => null });
    createServerLiveUploader.mockReturnValue(live);
    uploadServerAttachment.mockResolvedValue(voiceAttachment("whole-att"));
    sendMessage.mockResolvedValue(sentMessage("whole-att"));
    const { view } = await mount();

    await startRecording(view);
    recordButton(view).click();
    await flush();

    expect(live.finish).toHaveBeenCalledOnce();
    expect(uploadServerAttachment).toHaveBeenCalledTimes(1);
    const [file, kind] = uploadServerAttachment.mock.calls[0] as [File, string];
    expect(kind).toBe("voice");
    expect(file.size).toBe("voice".length);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ attachmentIds: ["whole-att"] });
    view.teardown();
  });

  it("uploads the whole recording the ordinary way when no live upload was ever opened", async () => {
    uploadServerAttachment.mockResolvedValue(voiceAttachment("whole-att"));
    sendMessage.mockResolvedValue(sentMessage("whole-att"));
    const { view } = await mount();

    recordButton(view).click(); // the recorder never reports onStart
    await flush();
    recordButton(view).click();
    await flush();

    expect(createServerLiveUploader).not.toHaveBeenCalled();
    expect(uploadServerAttachment).toHaveBeenCalledTimes(1);
    view.teardown();
  });

  it("Cancel discards the server's partial recording, and sends nothing", async () => {
    const live = fakeLive();
    createServerLiveUploader.mockReturnValue(live);
    const { view } = await mount();
    await startRecording(view);

    view.element.querySelector<HTMLButtonElement>(".wx-srv-record-cancel")!.click();
    await flush();

    expect(live.cancel).toHaveBeenCalledOnce();
    expect(live.abandon).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    view.teardown();
  });

  it("a recording too short to send is deleted from the server too", async () => {
    const live = fakeLive();
    createServerLiveUploader.mockReturnValue(live);
    const { view } = await mount();
    await startRecording(view);
    // The mock recorder always reports 2 s, so report this stop (0.5 s) the way the real one would.
    recorderOptions().onStop?.({ blob: new Blob(["v"]), durationMs: 500, mimeType: "audio/webm" });
    await flush();
    expect(live.cancel).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    view.teardown();
  });

  it("a lock mid-recording leaves what was uploaded on the server (to be offered back) rather than deleting it", async () => {
    const live = fakeLive();
    createServerLiveUploader.mockReturnValue(live);
    const { view } = await mount();
    await startRecording(view);

    view.detach();
    await flush();

    expect(live.abandon).toHaveBeenCalledOnce();
    expect(live.cancel).not.toHaveBeenCalled();
    view.teardown();
  });

  it("a session that dies while the note is going out locks the chat, and the next unlock carries on without re-uploading", async () => {
    let dead = true;
    const live = fakeLive({
      finish: async () => {
        if (dead) throw new ServerLockedError();
        return voiceAttachment("live-att");
      },
    });
    createServerLiveUploader.mockReturnValue(live);
    sendMessage.mockResolvedValue(sentMessage("live-att"));
    const { view, hooks } = await mount();
    await startRecording(view);

    recordButton(view).click();
    await flush();
    expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized");
    expect(sendMessage).not.toHaveBeenCalled();

    view.detach();
    dead = false;
    await view.attach(SESSION);
    await flush();

    expect(live.finish).toHaveBeenCalledTimes(2);
    expect(uploadServerAttachment).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ attachmentIds: ["live-att"] });
    view.teardown();
  });

  it("shows the recording time as h:mm:ss past one hour", async () => {
    createServerLiveUploader.mockReturnValue(fakeLive());
    const { view } = await mount();
    await startRecording(view);

    recorderOptions().onTimer?.(3_723_000);
    expect(view.element.querySelector(".wx-srv-record-status")?.textContent).toBe("Recording 1:02:03");
    recorderOptions().onTimer?.(754_000);
    expect(view.element.querySelector(".wx-srv-record-status")?.textContent).toBe("Recording 12:34");
    view.teardown();
  });
});

describe("unsent voice note cards", () => {
  const cards = (view: { element: HTMLElement }) => [...view.element.querySelectorAll<HTMLElement>(".wx-srv-unsent-card")];
  const unsent = (id: string, durationMs: number) => ({ uploadId: id, durationMs, sizeBytes: 9, startedAt: 1, lastChunkAt: 2 });

  it("asks for this device's unsent uploads after the chat loads and shows one card each", async () => {
    listUnsentUploads.mockResolvedValue([unsent("u1", 751_000), unsent("u2", 3_723_000)]);
    const { view } = await mount();

    expect(listUnsentUploads).toHaveBeenCalledWith(SESSION, "device-1");
    expect(cards(view).map((c) => c.querySelector(".wx-srv-unsent-label")?.textContent)).toEqual([
      "Unsent voice note · 12:31",
      "Unsent voice note · 1:02:03",
    ]);
    expect(sendMessage).not.toHaveBeenCalled(); // never auto-sent
    expect(completeUnsentUpload).not.toHaveBeenCalled();
    view.teardown();
  });

  it("shows nothing when there is nothing unsent, or when the endpoint is not there (an older server)", async () => {
    const { view } = await mount();
    expect(cards(view)).toHaveLength(0);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-unsent-list")?.hidden).toBe(true);
    view.teardown();

    listUnsentUploads.mockRejectedValue(new Error("Couldn't load unsent voice notes (500)."));
    const failed = await mount();
    expect(cards(failed.view)).toHaveLength(0);
    expect(failed.hooks.lockNow).not.toHaveBeenCalled();
    failed.view.teardown();
  });

  it("a dead session while listing locks the chat", async () => {
    listUnsentUploads.mockRejectedValue(new ServerLockedError());
    const { view, hooks } = await mount();
    expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized");
    view.teardown();
  });

  it("Send completes the upload, sends it as a normal voice message from this sender, and removes the card", async () => {
    listUnsentUploads.mockResolvedValue([unsent("u1", 60_000)]);
    completeUnsentUpload.mockResolvedValue(voiceAttachment("att-u1"));
    sendMessage.mockResolvedValue(sentMessage("att-u1"));
    const { view } = await mount();

    view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-send")!.click();
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-send")?.textContent).toBe("Sending…");
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-send")?.disabled).toBe(true);
    await flush();

    expect(completeUnsentUpload).toHaveBeenCalledWith(SESSION, "u1");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      sender: "Josh", deviceId: "device-1", text: null, attachmentIds: ["att-u1"],
    });
    expect(cards(view)).toHaveLength(0);
    view.teardown();
  });

  it("a Send whose message failed keeps the card, and retrying sends the SAME completed note without completing twice", async () => {
    listUnsentUploads.mockResolvedValue([unsent("u1", 60_000)]);
    completeUnsentUpload.mockResolvedValue(voiceAttachment("att-u1"));
    sendMessage
      .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
      .mockResolvedValueOnce(sentMessage("att-u1"));
    const { view } = await mount();

    view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-send")!.click();
    await flush();
    expect(cards(view)).toHaveLength(1);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-unsent-error")?.hidden).toBe(false);
    expect(view.element.querySelector(".wx-srv-unsent-error")?.textContent).not.toBe("");
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-send")?.disabled).toBe(false);

    view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-send")!.click();
    await flush();

    expect(completeUnsentUpload).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[1]).toMatchObject({ clientId: (sendMessage.mock.calls[0]?.[1] as { clientId: string }).clientId });
    expect(cards(view)).toHaveLength(0);
    view.teardown();
  });

  it("a Send the server refuses to complete shows a short error and leaves the card with Discard available", async () => {
    listUnsentUploads.mockResolvedValue([unsent("u1", 60_000)]);
    const { UploadError } = await import("../src/server/upload");
    completeUnsentUpload.mockRejectedValue(new UploadError("x", 404));
    const { view } = await mount();

    view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-send")!.click();
    await flush();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(cards(view)).toHaveLength(1);
    expect(view.element.querySelector(".wx-srv-unsent-error")?.textContent).toContain("no longer on the server");
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-discard")?.disabled).toBe(false);
    view.teardown();
  });

  it("Discard deletes the upload and removes the card", async () => {
    listUnsentUploads.mockResolvedValue([unsent("u1", 60_000), unsent("u2", 90_000)]);
    discardUpload.mockResolvedValue(undefined);
    const { view } = await mount();

    view.element.querySelector<HTMLButtonElement>('[data-upload-id="u1"] .wx-srv-unsent-discard')!.click();
    expect(view.element.querySelector('[data-upload-id="u1"] .wx-srv-unsent-discard')?.textContent).toBe("Discarding…");
    await flush();

    expect(discardUpload).toHaveBeenCalledWith(SESSION, "u1");
    expect(cards(view).map((c) => c.dataset.uploadId)).toEqual(["u2"]);
    expect(sendMessage).not.toHaveBeenCalled();
    view.teardown();
  });

  it("a failed Discard re-enables the buttons with an error line", async () => {
    listUnsentUploads.mockResolvedValue([unsent("u1", 60_000)]);
    discardUpload.mockRejectedValue(new Error("500"));
    const { view } = await mount();

    view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-discard")!.click();
    await flush();

    expect(cards(view)).toHaveLength(1);
    expect(view.element.querySelector<HTMLButtonElement>(".wx-srv-unsent-discard")?.disabled).toBe(false);
    expect(view.element.querySelector(".wx-srv-unsent-error")?.textContent).toBe("Couldn't discard. Try again.");
    view.teardown();
  });

  it("does not offer this device's own recording that is in progress (a long pause looks idle to the server)", async () => {
    const live = fakeLive({ uploadId: "own" });
    createServerLiveUploader.mockReturnValue(live);
    const { view } = await mount();
    await startRecording(view);

    listUnsentUploads.mockResolvedValue([unsent("own", 20_000), unsent("old", 60_000)]);
    await view.attach(SESSION);
    await flush();

    expect(cards(view).map((c) => c.dataset.uploadId)).toEqual(["old"]);
    view.teardown();
  });

  it("a lock removes the cards; the next unlock asks again", async () => {
    listUnsentUploads.mockResolvedValue([unsent("u1", 60_000)]);
    const { view } = await mount();
    expect(cards(view)).toHaveLength(1);

    view.detach();
    expect(cards(view)).toHaveLength(0);

    await view.attach(SESSION);
    await flush();
    expect(listUnsentUploads).toHaveBeenCalledTimes(2);
    expect(cards(view)).toHaveLength(1);
    view.teardown();
  });
});
