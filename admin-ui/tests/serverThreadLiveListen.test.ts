import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPage, Message } from "../src/server/api/messages";
import type { ServerIdentity } from "../src/server/identity";
import type { LiveHandover, LiveVoiceHub, LiveWatcher } from "../src/server/liveVoice/hub";
import { mountServerThread } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";

// Live voice notes, the listener (spec/server-chat/07 §1): a live note from someone else in the
// thread, patched in place as it changes and replaced by the finished file when it is ready.

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
const ID = "f".repeat(32);

const identity = (): ServerIdentity => ({
  getName: () => "Josh",
  setName: vi.fn(),
  getDeviceId: () => "device-1",
  isMine: (sender: string) => sender.toLowerCase() === "josh",
});

const hooks = (): LockHooks =>
  ({
    suspend: vi.fn(() => () => {}),
    lockNow: vi.fn(),
    adoptBoundSession: vi.fn(),
    getBoundGrantId: vi.fn(() => null),
    suspendLive: vi.fn(() => ({ touch() {}, release() {} })),
    activityCount: vi.fn(() => 0),
  }) as unknown as LockHooks;

const fakeWindow = (): Window =>
  ({
    crypto: { randomUUID: () => "uuid" },
    localStorage: window.localStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  }) as unknown as Window;

function fakeHub() {
  const watchers = new Set<LiveWatcher>();
  const handovers = new Map<string, LiveHandover>();
  const hub: LiveVoiceHub = {
    attach: vi.fn(),
    detach: vi.fn(),
    dispose: vi.fn(),
    watch: vi.fn((_id: string, watcher: LiveWatcher) => { watchers.add(watcher); return () => { watchers.delete(watcher); }; }),
    play: vi.fn(),
    stop: vi.fn(() => null),
    isOnline: () => true,
    rememberHandover: vi.fn((id: string, handover: LiveHandover) => { handovers.set(id, handover); }),
    takeHandover: vi.fn((id: string) => { const v = handovers.get(id) ?? null; handovers.delete(id); return v; }),
  };
  return { hub, watchers };
}

function message(attachment: Partial<Message["attachments"][number]>, seq = 3): Message {
  return {
    seq, clientId: "c3", sender: "Bubble", text: null, reactions: [], createdAt: 1_790_000_000, replyTo: null,
    attachments: [{
      id: ID, kind: "voice", status: "live", liveState: "recording", width: null, height: null,
      durationS: 0, peaks: [], urls: {}, ...attachment,
    }],
  } as unknown as Message;
}

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

async function mount(history: Message[]) {
  getHistory.mockReset().mockResolvedValue({ messages: history, hasMore: false, cursor: 3 } satisfies HistoryPage);
  getUsage.mockReset().mockResolvedValue({
    mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false, transcriptionAvailable: true,
  });
  const { hub, watchers } = fakeHub();
  const view = mountServerThread({ identity: identity(), hooks: hooks(), win: fakeWindow(), onSettings: vi.fn(), liveVoiceHub: hub });
  document.body.appendChild(view.element);
  await view.attach(SESSION);
  await flush();
  return { view, hub, watchers };
}

const bubble = (view: { element: HTMLElement }) => view.element.querySelector<HTMLElement>(".wx-srv-voice-live");

beforeEach(() => document.body.replaceChildren());
afterEach(() => document.body.replaceChildren());

describe("a live voice note from someone else", () => {
  it("appears as a voice note with a LIVE badge and Play / Jump to live, registered with the hub", async () => {
    const { view, hub } = await mount([message({})]);
    expect(bubble(view)).not.toBeNull();
    expect(bubble(view)!.querySelector(".wx-srv-live-badge")).not.toBeNull();
    expect(bubble(view)!.querySelector<HTMLElement>(".wx-srv-voice-play")?.hidden).toBe(false);
    expect(bubble(view)!.querySelector<HTMLElement>(".wx-srv-voice-live-jump")?.hidden).toBe(false);
    expect(hub.watch).toHaveBeenCalledWith(ID, expect.anything());
    expect(hub.attach).toHaveBeenCalledWith(SESSION);
    view.teardown();
  });

  it("a pause or the stop arrives as message_updated and is patched into the SAME bubble, so a stream keeps playing", async () => {
    const { view, hub } = await mount([message({})]);
    const before = bubble(view)!;
    view.handleStreamEvent({ type: "message_updated", message: message({ liveState: "paused" }) });
    expect(bubble(view)).toBe(before);
    expect(before.dataset["state"]).toBe("paused");
    view.handleStreamEvent({ type: "message_updated", message: message({ status: "processing", liveState: undefined as never, durationS: 12 }) });
    expect(bubble(view)).toBe(before);
    expect(before.dataset["state"]).toBe("ended");
    expect(before.querySelector(".wx-srv-live-status")?.textContent).toBe("Finishing…");
    expect(hub.stop).not.toHaveBeenCalled();
    expect(hub.rememberHandover).not.toHaveBeenCalled();
    view.teardown();
  });

  it("when the note is ready the bubble is replaced by the ordinary player, handing over where the listener was", async () => {
    const { view, hub, watchers } = await mount([message({})]);
    bubble(view)!.querySelector<HTMLButtonElement>(".wx-srv-voice-play")!.click();
    expect(hub.play).toHaveBeenCalledWith(ID, "start");
    for (const watcher of [...watchers]) watcher.onAudio({ phase: "playing", positionSamples: 24_000 * 9, error: null });
    (hub.stop as ReturnType<typeof vi.fn>).mockReturnValueOnce(24_000 * 9);
    view.handleStreamEvent({
      type: "message_updated",
      message: message({ status: "ready", liveState: undefined as never, durationS: 30, peaks: [0.1], urls: { play: "/finished.m4a" } }),
    });
    expect(bubble(view)).toBeNull();
    const audio = view.element.querySelector<HTMLAudioElement>(".wx-srv-voice audio")!;
    expect(audio.getAttribute("src")).toBe("/finished.m4a");
    expect(hub.rememberHandover).toHaveBeenCalledWith(ID, { positionS: 9, playing: true });
    expect(hub.takeHandover).toHaveBeenCalledWith(ID);
    view.teardown();
  });

  it("a live transcript update is patched in place, tail greyed", async () => {
    const { view } = await mount([message({})]);
    const before = bubble(view)!;
    view.handleStreamEvent({
      type: "message_updated",
      message: message({ transcript: { status: "live", text: "Hello.", tail: "how are" } }),
    });
    expect(bubble(view)).toBe(before);
    const block = view.element.querySelector(".wx-srv-transcript")!;
    expect(block.querySelector(".wx-srv-transcript-final")?.textContent).toBe("Hello.");
    expect(block.querySelector(".wx-srv-transcript-tail")?.textContent).toBe("how are");
    view.teardown();
  });

  it("offers Transcribe on the live note, and asks the server for it", async () => {
    transcribeAttachment.mockReset().mockResolvedValue({ kind: "started", transcript: { status: "pending" } });
    const { view } = await mount([message({})]);
    const start = view.element.querySelector<HTMLButtonElement>(".wx-srv-transcript-start");
    expect(start).not.toBeNull();
    start!.click();
    await flush();
    expect(transcribeAttachment).toHaveBeenCalledWith(SESSION, ID);
    view.teardown();
  });

  it("a lock stops and unregisters the live bubbles; the socket is closed", async () => {
    const { view, hub, watchers } = await mount([message({})]);
    expect(watchers.size).toBe(1);
    view.detach();
    expect(watchers.size).toBe(0);
    expect(hub.detach).toHaveBeenCalled();
    view.teardown();
    expect(hub.dispose).toHaveBeenCalled();
  });

  it("a deleted live note leaves no registration behind", async () => {
    const { view, watchers } = await mount([message({})]);
    view.handleStreamEvent({ type: "message_deleted", seq: 3 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bubble(view)).toBeNull();
    expect(watchers.size).toBe(0);
    view.teardown();
  });
});
