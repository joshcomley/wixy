import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPage, Message, SendMessageResult } from "../src/server/api/messages";
import type { ServerIdentity } from "../src/server/identity";
import type { LiveOpenResult } from "../src/server/liveUpload";
import type { LiveVoiceHub, LiveWatcher } from "../src/server/liveVoice/hub";
import { mountServerThread } from "../src/server/thread";
import type { UploadAttachment } from "../src/server/upload";
import type { LockHooks, ServerSession } from "../src/server/types";

// Live voice notes, the sender (spec/server-chat/07 §1, §6.1): the mic's mode switch and the
// live recording flow in the thread.

interface RecorderOptions {
  onStop?: (recording: { blob: Blob; durationMs: number; mimeType: string }) => void;
  onCancel?: () => void;
  onStart?: (info: { mimeType: string }) => void;
  onSlice?: (blob: Blob, index: number, elapsedMs: number) => void;
  onTimer?: (elapsedMs: number) => void;
  sliceMs?: () => number;
  flushOnPause?: () => boolean;
}

const {
  createVoiceRecorder, getHistory, getUsage, sendMessage, deleteMessage, uploadServerAttachment,
  createServerLiveUploader, listUnsentUploads, completeUnsentUpload, discardUpload,
} = vi.hoisted(() => ({
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
  deleteMessage: vi.fn(),
  uploadServerAttachment: vi.fn(),
  createServerLiveUploader: vi.fn(),
  listUnsentUploads: vi.fn(),
  completeUnsentUpload: vi.fn(),
  discardUpload: vi.fn(),
}));
vi.mock("../src/server/recorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/recorder")>()),
  createVoiceRecorder,
}));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
  sendMessage,
  deleteMessage,
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
const LIVE_ID = "e".repeat(32);

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
    localStorage: window.localStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  } as unknown as Window;
}

function fakeHub() {
  const watched: string[] = [];
  const hub: LiveVoiceHub = {
    attach: vi.fn(),
    detach: vi.fn(),
    dispose: vi.fn(),
    watch: vi.fn((id: string, _watcher: LiveWatcher) => { watched.push(id); return () => undefined; }),
    play: vi.fn(),
    stop: vi.fn(() => null),
    isOnline: () => false,
    rememberHandover: vi.fn(),
    takeHandover: vi.fn(() => null),
  };
  return { hub, watched };
}

const emptyHistory = (): HistoryPage => ({ messages: [], hasMore: false, cursor: 0 });

function liveAttachment(): UploadAttachment {
  return { id: LIVE_ID, kind: "voice", status: "live", liveState: "recording", width: null, height: null, durationS: 0, peaks: [], urls: {} };
}
function processingAttachment(): UploadAttachment {
  return { ...liveAttachment(), status: "processing" };
}
function voiceAttachment(id: string): UploadAttachment {
  return { id, kind: "voice", status: "processing", width: null, height: null, durationS: 2, peaks: null, urls: {} };
}

function sentLive(clientId = "c", seq = 7): SendMessageResult {
  return {
    ok: true,
    message: {
      seq, clientId, sender: "Josh", text: null, reactions: [], createdAt: Date.now() / 1000, replyTo: null,
      attachments: [liveAttachment()],
    } as unknown as Message,
  };
}
function sentOrdinary(id: string, seq = 9): SendMessageResult {
  return {
    ok: true,
    message: {
      seq, clientId: "n", sender: "Josh", text: null, reactions: [], createdAt: Date.now() / 1000, replyTo: null,
      attachments: [voiceAttachment(id)],
    } as unknown as Message,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function fakeListen(over: {
  open?: () => Promise<LiveOpenResult>;
  finish?: () => Promise<UploadAttachment | null>;
} = {}) {
  return {
    uploadId: LIVE_ID,
    listening: true,
    opened: vi.fn(over.open ?? (async (): Promise<LiveOpenResult> => ({ kind: "opened", attachment: liveAttachment() }))),
    push: vi.fn(),
    finish: vi.fn(over.finish ?? (async () => processingAttachment())),
    cancel: vi.fn(async () => undefined),
    abandon: vi.fn(),
    setLiveState: vi.fn(),
  };
}

function fakeNormal(uploadId = "normal-up") {
  return {
    uploadId,
    listening: false,
    opened: vi.fn(),
    push: vi.fn(),
    finish: vi.fn(async () => voiceAttachment("normal-att")),
    cancel: vi.fn(async () => undefined),
    abandon: vi.fn(),
    setLiveState: vi.fn(),
  };
}

async function mount(hooks = fakeHooks()) {
  const { hub, watched } = fakeHub();
  const view = mountServerThread({ identity: fakeIdentity(), hooks, win: fakeWindow(), onSettings: vi.fn(), liveVoiceHub: hub });
  document.body.appendChild(view.element);
  await view.attach(SESSION);
  await flush();
  return { view, hooks, hub, watched };
}

const recorderOptions = (): RecorderOptions => createVoiceRecorder.mock.calls.at(-1)?.[0] as RecorderOptions;
const mic = (view: { element: HTMLElement }) => view.element.querySelector<HTMLButtonElement>(".wx-srv-record-button")!;
const cancelButton = (view: { element: HTMLElement }) => view.element.querySelector<HTMLButtonElement>(".wx-srv-record-cancel")!;
const pauseButton = (view: { element: HTMLElement }) => view.element.querySelector<HTMLButtonElement>(".wx-srv-record-pause")!;
const status = (view: { element: HTMLElement }) => view.element.querySelector(".wx-srv-record-status")!;
const menu = () => document.querySelector<HTMLElement>(".wx-srv-voice-mode-menu");
const pointer = (target: Element, type: string) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));

/** Hold the mic long enough to open the menu, then let go and click as a browser would. */
function longPress(view: { element: HTMLElement }) {
  pointer(mic(view), "pointerdown");
  vi.advanceTimersByTime(600);
  pointer(mic(view), "pointerup");
  mic(view).click();
}

async function chooseLive(view: { element: HTMLElement }) {
  longPress(view);
  document.querySelector<HTMLButtonElement>(".wx-srv-voice-mode-item-live")!.click();
}

async function startLive(view: { element: HTMLElement }, live = fakeListen()) {
  createServerLiveUploader.mockReturnValueOnce(live);
  await chooseLive(view);
  mic(view).click();
  await flush();
  recorderOptions().onStart?.({ mimeType: "audio/webm;codecs=opus" });
  await flush();
  return live;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  document.body.replaceChildren();
  createVoiceRecorder.mockClear();
  getHistory.mockReset().mockResolvedValue(emptyHistory());
  getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
  sendMessage.mockReset();
  deleteMessage.mockReset().mockResolvedValue(false);
  uploadServerAttachment.mockReset();
  createServerLiveUploader.mockReset();
  listUnsentUploads.mockReset().mockResolvedValue([]);
  completeUnsentUpload.mockReset();
  discardUpload.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("the microphone's mode switch", () => {
  it("long-pressing opens a menu of Voice note and Live voice note, and that press does not also start a recording", async () => {
    const { view } = await mount();
    longPress(view);
    expect(menu()).not.toBeNull();
    expect(menu()!.getAttribute("role")).toBe("menu");
    expect([...menu()!.querySelectorAll("[role=menuitemradio]")].map((el) => el.textContent)).toEqual(["Voice note", "Live voice note"]);
    expect(menu()!.querySelector("[aria-checked=true]")?.textContent).toBe("Voice note");
    expect(createServerLiveUploader).not.toHaveBeenCalled();
    expect(mic(view).getAttribute("aria-expanded")).toBe("true");
    // and nothing has been recorded: the click that followed the long press was swallowed
    expect(createVoiceRecorder.mock.results.every((r) => (r.value as { start: ReturnType<typeof vi.fn> }).start.mock.calls.length === 0)).toBe(true);
    view.teardown();
  });

  it("a short tap still starts a normal recording", async () => {
    const { view } = await mount();
    pointer(mic(view), "pointerdown");
    vi.advanceTimersByTime(100);
    pointer(mic(view), "pointerup");
    mic(view).click();
    await flush();
    expect(menu()).toBeNull();
    const started = createVoiceRecorder.mock.results.at(-1)!.value as { start: ReturnType<typeof vi.fn> };
    expect(started.start).toHaveBeenCalledOnce();
    view.teardown();
  });

  it("choosing Live voice note gives the mic a red LIVE dot and tint, and the next tap records live", async () => {
    const { view } = await mount();
    longPress(view);
    document.querySelector<HTMLButtonElement>(".wx-srv-voice-mode-item-live")!.click();
    expect(menu()).toBeNull();
    expect(mic(view).classList.contains("wx-srv-record-button--live")).toBe(true);
    expect(mic(view).getAttribute("aria-label")).toBe("Record a live voice note");
    expect(recorderOptions().sliceMs?.()).toBe(1000);
    longPress(view);
    expect(menu()!.querySelector("[aria-checked=true]")?.textContent).toBe("Live voice note");
    document.querySelector<HTMLButtonElement>(".wx-srv-voice-mode-item-voice")!.click();
    expect(mic(view).classList.contains("wx-srv-record-button--live")).toBe(false);
    expect(mic(view).getAttribute("aria-label")).toBe("Record a voice note");
    expect(recorderOptions().sliceMs?.()).toBe(15000);
    view.teardown();
  });

  it("the keyboard can reach it too: the context-menu key and the arrow keys", async () => {
    const { view } = await mount();
    mic(view).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(menu()).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Voice note");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(menu()).toBeNull();
    mic(view).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(menu()).not.toBeNull();
    menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toBe("Live voice note");
    (document.activeElement as HTMLButtonElement).click();
    expect(mic(view).getAttribute("aria-label")).toBe("Record a live voice note");
    view.teardown();
  });

  it("closes on an outside press and on lock, and cannot open while recording", async () => {
    const { view } = await mount();
    longPress(view);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu()).toBeNull();
    longPress(view);
    view.detach();
    expect(menu()).toBeNull();
    await view.attach(SESSION);
    await flush();
    mic(view).click();
    await flush();
    mic(view).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(menu()).toBeNull();
    view.teardown();
  });

  it("keeps the choice in memory only for the life of the page: nothing is written to browser storage, and it survives a lock", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const indexedOpen = vi.fn();
    vi.stubGlobal("indexedDB", { open: indexedOpen });
    const { view } = await mount();
    setItem.mockClear();
    await chooseLive(view);
    expect(mic(view).classList.contains("wx-srv-record-button--live")).toBe(true);
    view.detach();
    await view.attach(SESSION);
    await flush();
    expect(mic(view).classList.contains("wx-srv-record-button--live")).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(indexedOpen).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.entries(localStorage))).not.toMatch(/live/i);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toMatch(/live/i);
    // a brand new page (a new mount) starts in the ordinary mode again
    view.teardown();
    const fresh = await mount();
    expect(mic(fresh.view).classList.contains("wx-srv-record-button--live")).toBe(false);
    fresh.view.teardown();
    setItem.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("recording a live voice note", () => {
  it("opens a listened-to upload, and sends the message at once with the live attachment (even before Stop)", async () => {
    const { view, watched } = await mount();
    sendMessage.mockResolvedValue(sentLive());
    const live = await startLive(view);

    const options = createServerLiveUploader.mock.calls[0]?.[1] as { listen?: boolean; mimeType: string; deviceId: string };
    expect(options).toMatchObject({ listen: true, mimeType: "audio/webm", deviceId: "device-1" });
    expect(live.opened).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ text: null, attachmentIds: [LIVE_ID], sender: "Josh", deviceId: "device-1" });
    // the message is in the thread as a live voice note bubble (the sender's own: no Play)
    expect(view.element.querySelector(".wx-srv-voice-live")).not.toBeNull();
    expect(watched).toContain(LIVE_ID);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-voice-live .wx-srv-voice-play")?.hidden).toBe(true);
    view.teardown();
  });

  it("shows LIVE · 0:42 in the recording row, and slices go to the uploader", async () => {
    const { view } = await mount();
    sendMessage.mockResolvedValue(sentLive());
    const live = await startLive(view);
    recorderOptions().onTimer?.(42_000);
    expect(status(view).textContent).toBe("LIVE · 0:42");
    expect(status(view).querySelector(".wx-srv-live-dot")).not.toBeNull();
    expect(mic(view).getAttribute("aria-label")).toBe("Stop live voice note");
    const slice = new Blob(["s"]);
    recorderOptions().onSlice?.(slice, 0, 1000);
    expect(live.push).toHaveBeenCalledWith(slice, 0, 1000);
    view.teardown();
  });

  it("Pause and Resume go to the server as live-state, and the row says so", async () => {
    const { view } = await mount();
    sendMessage.mockResolvedValue(sentLive());
    const live = await startLive(view);
    pauseButton(view).click();
    expect(live.setLiveState).toHaveBeenLastCalledWith("paused");
    expect(recorderOptions().flushOnPause?.()).toBe(true);
    recorderOptions().onTimer?.(5_000);
    expect(status(view).textContent).toBe("LIVE · Paused 0:05");
    pauseButton(view).click();
    expect(live.setLiveState).toHaveBeenLastCalledWith("recording");
    expect(live.setLiveState).toHaveBeenCalledTimes(2);
    view.teardown();
  });

  it("Stop completes the upload and sends nothing more: the message already went out", async () => {
    const { view } = await mount();
    sendMessage.mockResolvedValue(sentLive());
    const live = await startLive(view);
    mic(view).click(); // stop
    await flush();
    expect(live.finish).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(uploadServerAttachment).not.toHaveBeenCalled();
    expect(mic(view).disabled).toBe(false);
    expect(view.element.querySelector(".wx-srv-voice-failure-row")).toHaveProperty("hidden", true);
    view.teardown();
  });

  it("Cancel is now Delete for everyone, behind a confirm that says they may have heard it; Keep recording changes nothing", async () => {
    const { view } = await mount();
    sendMessage.mockResolvedValue(sentLive());
    await startLive(view);
    expect(cancelButton(view).getAttribute("aria-label")).toBe("Delete for everyone");
    const confirm = view.element.querySelector<HTMLElement>(".wx-srv-live-delete-confirm")!;
    expect(confirm.hidden).toBe(true);
    cancelButton(view).click();
    expect(confirm.hidden).toBe(false);
    expect(confirm.getAttribute("role")).toBe("alertdialog");
    expect(confirm.textContent).toContain("They may already have heard part of it");
    view.element.querySelector<HTMLButtonElement>(".wx-srv-live-delete-no")!.click();
    expect(confirm.hidden).toBe(true);
    expect(deleteMessage).not.toHaveBeenCalled();
    const recorder = createVoiceRecorder.mock.results.at(-1)!.value as { cancel: ReturnType<typeof vi.fn> };
    expect(recorder.cancel).not.toHaveBeenCalled();
    view.teardown();
  });

  it("confirming deletes the message for everyone with the normal message delete, and does not delete the upload separately", async () => {
    const { view } = await mount();
    sendMessage.mockResolvedValue(sentLive("c", 7));
    const live = await startLive(view);
    cancelButton(view).click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-live-delete-yes")!.click();
    await flush();
    expect(deleteMessage).toHaveBeenCalledWith(SESSION, 7);
    expect(live.abandon).toHaveBeenCalledOnce();
    expect(live.cancel).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); // the delete fade
    expect(view.element.querySelector(".wx-srv-voice-live")).toBeNull();
    view.teardown();
  });

  it("before the message exists nobody can have heard it, so Cancel just cancels (and a message that lands afterwards is deleted)", async () => {
    const { view } = await mount();
    let release!: (r: SendMessageResult) => void;
    sendMessage.mockReturnValue(new Promise<SendMessageResult>((resolve) => { release = resolve; }));
    const live = await startLive(view);
    expect(cancelButton(view).getAttribute("aria-label")).toBe("Cancel recording");
    cancelButton(view).click();
    await flush();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-live-delete-confirm")?.hidden).toBe(true);
    expect(live.cancel).toHaveBeenCalledOnce();
    release(sentLive("c", 11));
    await flush();
    expect(deleteMessage).toHaveBeenCalledWith(SESSION, 11);
    view.teardown();
  });

  it("a recording too short to send is taken out of the chat too", async () => {
    const { view } = await mount();
    sendMessage.mockResolvedValue(sentLive("c", 7));
    const live = await startLive(view);
    recorderOptions().onStop?.({ blob: new Blob(["v"]), durationMs: 500, mimeType: "audio/webm" });
    await flush();
    expect(deleteMessage).toHaveBeenCalledWith(SESSION, 7);
    expect(live.abandon).toHaveBeenCalled();
    expect(view.element.textContent).toContain("Too short");
    view.teardown();
  });

  it("a lock mid-recording leaves the live note in the chat (the server ends it itself), and deletes nothing", async () => {
    const { view } = await mount();
    sendMessage.mockResolvedValue(sentLive());
    const live = await startLive(view);
    view.detach();
    await flush();
    expect(live.abandon).toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(live.cancel).not.toHaveBeenCalled();
    view.teardown();
  });

  it("a message that could not be sent is retried, with the same clientId", async () => {
    const { view } = await mount();
    sendMessage
      .mockResolvedValueOnce({ ok: false, kind: "unavailable" } satisfies SendMessageResult)
      .mockResolvedValueOnce(sentLive());
    await startLive(view);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const [first, second] = sendMessage.mock.calls.map((call) => (call[1] as { clientId: string }).clientId);
    expect(second).toBe(first);
    expect(view.element.querySelector(".wx-srv-voice-live")).not.toBeNull();
    view.teardown();
  });

  it("if the message never went out, Stop sends it with the same clientId once the upload is complete", async () => {
    const { view } = await mount();
    sendMessage.mockResolvedValue({ ok: false, kind: "rejected", status: 422 } satisfies SendMessageResult);
    await startLive(view);
    const firstClientId = (sendMessage.mock.calls[0]?.[1] as { clientId: string }).clientId;
    sendMessage.mockResolvedValue(sentLive(firstClientId));
    mic(view).click();
    await flush();
    expect(sendMessage.mock.calls.at(-1)?.[1]).toMatchObject({ clientId: firstClientId, attachmentIds: [LIVE_ID] });
    view.teardown();
  });
});

describe("when a live note cannot be opened or finished", () => {
  it("409 too_many_live: it carries on as a normal recording with a short notice, and no slice is lost", async () => {
    const { view } = await mount();
    let refuse!: () => void;
    const live = fakeListen({
      open: () => new Promise<LiveOpenResult>((resolve) => { refuse = () => resolve({ kind: "too_many_live" }); }),
    });
    const normal = fakeNormal();
    createServerLiveUploader.mockReturnValueOnce(live).mockReturnValueOnce(normal);
    await chooseLive(view);
    mic(view).click();
    await flush();
    recorderOptions().onStart?.({ mimeType: "audio/webm" });
    const first = new Blob(["a"]);
    const second = new Blob(["b"]);
    recorderOptions().onSlice?.(first, 0, 1000);
    recorderOptions().onSlice?.(second, 1, 2000);
    refuse();
    await flush();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(createServerLiveUploader.mock.calls[1]?.[1]).not.toHaveProperty("listen");
    expect(normal.push.mock.calls).toEqual([[first, 0, 1000], [second, 1, 2000]]);
    const notice = view.element.querySelector<HTMLElement>(".wx-srv-live-notice")!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("normal voice note");
    // it is an ordinary recording now: the row says Recording, and later slices go to the new uploader
    recorderOptions().onTimer?.(3000);
    expect(status(view).textContent).toBe("Recording 0:03");
    const third = new Blob(["c"]);
    recorderOptions().onSlice?.(third, 2, 3000);
    expect(normal.push).toHaveBeenLastCalledWith(third, 2, 3000);
    // and Stop sends it as an ordinary voice note
    sendMessage.mockResolvedValue(sentOrdinary("normal-att"));
    mic(view).click();
    await flush();
    expect(normal.finish).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ attachmentIds: ["normal-att"] });
    view.teardown();
  });

  it("any other failure to open: no live message, and Stop uploads the kept recording whole, as before", async () => {
    const { view } = await mount();
    const live = fakeListen({ open: async () => ({ kind: "failed" }), finish: async () => null });
    uploadServerAttachment.mockResolvedValue(voiceAttachment("whole-att"));
    sendMessage.mockResolvedValue(sentOrdinary("whole-att"));
    await startLive(view, live);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(mic(view).getAttribute("aria-label")).toBe("Stop and send recording");
    mic(view).click();
    await flush();
    expect(uploadServerAttachment).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ attachmentIds: ["whole-att"] });
    view.teardown();
  });

  it("if the live upload cannot be finished, the whole recording goes out once more as a NEW voice note, and the live one stays", async () => {
    const { view } = await mount();
    sendMessage.mockResolvedValueOnce(sentLive("c", 7));
    const live = fakeListen({ finish: async () => null });
    uploadServerAttachment.mockResolvedValue(voiceAttachment("whole-att"));
    await startLive(view, live);
    const liveClientId = (sendMessage.mock.calls[0]?.[1] as { clientId: string }).clientId;
    sendMessage.mockResolvedValueOnce(sentOrdinary("whole-att", 9));

    mic(view).click();
    await flush();

    expect(uploadServerAttachment).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const second = sendMessage.mock.calls[1]?.[1] as { clientId: string; attachmentIds: string[] };
    expect(second.attachmentIds).toEqual(["whole-att"]);
    expect(second.clientId).not.toBe(liveClientId);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(view.element.querySelector(".wx-srv-live-notice")?.textContent).toContain("cut short");
    view.teardown();
  });

  it("a dead session while finishing locks the chat and the next unlock carries on without a second message", async () => {
    const { ServerLockedError } = await import("../src/server/api/http");
    let dead = true;
    const { view, hooks } = await mount();
    sendMessage.mockResolvedValue(sentLive());
    const live = fakeListen({
      finish: async () => {
        if (dead) throw new ServerLockedError();
        return processingAttachment();
      },
    });
    await startLive(view, live);
    mic(view).click();
    await flush();
    expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized");
    view.detach();
    dead = false;
    await view.attach(SESSION);
    await flush();
    expect(live.finish).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    view.teardown();
  });
});
