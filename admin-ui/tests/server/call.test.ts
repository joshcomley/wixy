import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallController, type CallAudioHandle } from "../../src/server/call/controller";
import { decodeFrame, encodeFrame } from "../../src/server/call/protocol";

class Socket {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close = vi.fn();
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
const ID = "a".repeat(32);
const TARGET = "b".repeat(32);

function setup(prepare: () => Promise<void> = async () => {}) {
  const socket = new Socket();
  const releases: { reason: string; release: ReturnType<typeof vi.fn> }[] = [];
  const audio: CallAudioHandle = {
    prepare: vi.fn(prepare), start: vi.fn(), stop: vi.fn(), setMuted: vi.fn(),
    pulse: vi.fn(), play: vi.fn(), captureLease: vi.fn(),
  };
  const lock = vi.fn();
  const controller = createCallController({ win: window, isMicBusy: () => false, onBusy: vi.fn(),
    hooks: { suspend: (reason) => { const release = vi.fn(); releases.push({ reason, release }); return release; }, lockNow: lock },
    socketFactory: () => socket as unknown as WebSocket, audioFactory: () => audio,
  });
  controller.attach({ token: "secret", expiresAt: Date.now() / 1000 + 3600 }, "A");
  socket.onopen?.();
  socket.receive({ type: "welcome", deadline: Date.now() / 1000 + 3600 });
  socket.receive({ type: "presence", peers: [{ id: TARGET, label: "B", available: true }] });
  const click = (text: string) => {
    const button = [...controller.element.querySelectorAll("button")].find((b) => b.textContent === text);
    if (!button) throw new Error(`Missing ${text}`);
    button.click();
    const dialog = controller.element.querySelector<HTMLElement>(".wx-srv-call-dialog");
    if (text === "Call" && dialog && !dialog.hidden) {
      dialog.querySelector<HTMLButtonElement>(".wx-srv-call-confirm")?.click();
    }
  };
  const controls = () => socket.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  return { controller, socket, audio, releases, lock, click, controls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("live-call consent and lifetime", () => {
  it("reports a connected stall first observed by a socket message and drops that message", async () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, requestId: f.controls().find((m) => m["type"] === "invite")?.["requestId"] });
    f.socket.receive({ type: "prepare", callId: ID });
    await Promise.resolve();
    f.socket.receive({ type: "connected", callId: ID });
    const clock = vi.spyOn(window.performance, "now").mockReturnValue(window.performance.now() + 1000);
    try {
      f.socket.receive({ type: "capture", callId: ID, lease: 99 });
      expect(f.audio.captureLease).not.toHaveBeenCalled();
      expect(f.controls().at(-1)).toEqual({ type: "failed", callId: ID });
      const notice = f.controller.element.querySelector<HTMLElement>(".wx-srv-call-notice")!;
      expect(notice.hidden).toBe(false);
      expect(notice.textContent).toContain("browser paused");
      notice.querySelector<HTMLButtonElement>("button")!.click();
      await Promise.resolve();
      expect(notice.querySelector("pre")?.textContent).toContain("main-thread-stalled");
      f.click("Dismiss call details");
      expect(notice.hidden).toBe(true);
    } finally { f.controller.dispose(); clock.mockRestore(); }
  });
  it("starts an incoming failure trace fresh and leaves idle connection failures out of the thread overlay", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = setup();
    try {
      f.click("Call");
      f.socket.receive({ type: "outgoing", callId: ID, requestId: f.controls().find((m) => m["type"] === "invite")?.["requestId"] });
      f.socket.receive({ type: "ended", callId: ID, reason: "audio_unavailable" });
      f.socket.receive({ type: "incoming", callId: TARGET, peer: "B" });
      f.socket.onclose?.({ code: 1006 });
      expect(log).toHaveBeenCalledTimes(2);
      const trace = String(log.mock.calls[1]?.[1]);
      expect(trace).toContain("incoming");
      expect(trace).not.toContain("confirm");
      f.click("Reconnect calls");
      f.socket.onclose?.({ code: 1006 });
      expect(f.controller.element.querySelector<HTMLElement>(".wx-srv-call-notice")!.hidden).toBe(true);
      expect(log).toHaveBeenCalledTimes(3);
      expect(String(log.mock.calls[2]?.[1])).not.toContain("incoming");
    } finally { f.controller.dispose(); log.mockRestore(); }
  });
  it("starts a fresh liveness clock after a permission-dialog stall during setup", async () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.controls().find((m) => m["type"] === "invite")?.["requestId"] });
    f.socket.receive({ type: "prepare", callId: ID });
    await Promise.resolve();
    const clock = vi.spyOn(window.performance, "now").mockReturnValue(window.performance.now() + 1000);
    try {
      f.socket.receive({ type: "connected", callId: ID });
      expect(f.audio.start).toHaveBeenCalledTimes(1);
      expect(f.audio.stop).not.toHaveBeenCalled();
      expect(f.releases.find((r) => r.reason === "voiceCall")?.release).not.toHaveBeenCalled();
    } finally { f.controller.dispose(); clock.mockRestore(); }
  });
  it("shows a microphone failure and technical details without copying private payloads", async () => {
    const f = setup(async () => { throw new DOMException("private-token private-message", "NotAllowedError"); });
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.controls().find((m) => m["type"] === "invite")?.["requestId"] });
    f.socket.receive({ type: "prepare", callId: ID });
    await Promise.resolve();
    await Promise.resolve();
    const notice = f.controller.element.querySelector<HTMLElement>(".wx-srv-call-notice")!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("permission was denied");
    expect(f.controls().at(-1)).toEqual({ type: "failed", callId: ID });
    notice.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    const copied = notice.querySelector("pre")?.textContent ?? "";
    expect(copied).toContain("NotAllowedError");
    expect(copied).not.toContain("private-token");
    expect(copied).not.toContain("private-message");
    expect(copied).not.toContain(ID);
    f.controller.detach();
    expect(notice.hidden).toBe(true);
    expect(notice.querySelector("pre")?.textContent).toBe("");
    f.controller.dispose();
  });
  it("explains a peer's audio failure instead of silently returning to Call", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.controls().find((m) => m["type"] === "invite")?.["requestId"] });
    f.socket.receive({ type: "ended", callId: ID, reason: "audio_unavailable" });
    const notice = f.controller.element.querySelector<HTMLElement>(".wx-srv-call-notice")!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("other device couldn't connect the call");
    expect(notice.textContent).not.toContain("microphone permission");
    f.controller.dispose();
  });
  it("requires a separate confirmation and allows cancellation without calling or audio", () => {
    const f = setup();
    const call = f.controller.element.querySelector<HTMLButtonElement>('button[aria-label="Call"]')!;
    const dialog = f.controller.element.querySelector<HTMLElement>(".wx-srv-call-dialog")!;
    call.click();
    expect(dialog.hidden).toBe(false);
    expect(f.controls().some((m) => m["type"] === "invite")).toBe(false);
    expect(f.audio.prepare).not.toHaveBeenCalled();
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    expect(dialog.hidden).toBe(true);
    expect(f.controls().some((m) => m["type"] === "invite")).toBe(false);
    call.click();
    dialog.querySelector<HTMLButtonElement>(".wx-srv-call-confirm")!.click();
    expect(f.controls().filter((m) => m["type"] === "invite")).toEqual([
      expect.objectContaining({ targetConnectionId: TARGET }),
    ]);
    expect(dialog.hidden).toBe(true);
    expect(f.controller.element.querySelector("select")).toBeNull();
    f.controller.dispose();
  });
  it("closes an unconfirmed call picker on detach and cannot confirm afterwards", () => {
    const f = setup();
    f.controller.element.querySelector<HTMLButtonElement>('button[aria-label="Call"]')!.click();
    f.controller.detach();
    f.controller.element.querySelector<HTMLButtonElement>(".wx-srv-call-confirm")!.click();
    expect(f.controls().some((m) => m["type"] === "invite")).toBe(false);
    f.controller.dispose();
  });
  it("declines a targeted invitation without acquiring audio", () => {
    const f = setup();
    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    f.click("Decline");
    expect(f.controls().at(-1)).toEqual({ type: "decline", callId: ID });
    expect(f.audio.prepare).not.toHaveBeenCalled();
    // The ring held the idle pause (Inv 55); declining releases it.
    expect(f.releases.map((r) => r.reason)).toEqual(["voiceCall"]);
    expect(f.releases[0]?.release).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });
  it("waits for acceptance before preparing mic; connected/muted owns one idle pause", async () => {
    const f = setup();
    f.click("Call");
    expect(f.audio.prepare).not.toHaveBeenCalled();
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.controls().find((m) => m["type"] === "invite")?.["requestId"] });
    expect(f.releases.map((r) => r.reason)).toEqual(["voiceCall"]); // held while ringing, not first at connect
    f.socket.receive({ type: "prepare", callId: ID });
    await Promise.resolve();
    expect(f.controls().some((m) => m["type"] === "ready")).toBe(true);
    f.socket.receive({ type: "connected", callId: ID });
    f.click("Mute");
    expect(f.audio.setMuted).toHaveBeenCalledWith(true);
    const pause = f.releases.find((r) => r.reason === "voiceCall");
    expect(pause).toBeDefined();
    expect(pause?.release).not.toHaveBeenCalled();
    f.click("End call");
    expect([...f.controller.element.querySelectorAll("button")].find((b) => b.textContent === "Mute")?.getAttribute("aria-pressed")).toBe("false");
    expect(pause?.release).toHaveBeenCalledTimes(1);
    expect(f.audio.stop).toHaveBeenCalledTimes(1);
    f.controller.detach();
    expect(pause?.release).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });

  it("detach during permission stops immediately and late readiness cannot revive it", async () => {
    let resolve!: () => void;
    const f = setup(() => new Promise<void>((done) => { resolve = done; }));
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.controls().find((m) => m["type"] === "invite")?.["requestId"] });
    f.socket.receive({ type: "prepare", callId: ID });
    f.controller.detach();
    expect(f.audio.stop).toHaveBeenCalledTimes(1);
    expect(f.releases.map((r) => r.reason)).toEqual(["voiceCall", "micPermission"]);
    for (const r of f.releases) expect(r.release).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    expect(f.controls().some((m) => m["type"] === "ready")).toBe(false);
    expect(f.releases).toHaveLength(2); // late readiness takes no new pause
    f.controller.dispose();
  });

  it("same-token attach is idempotent, replacement closes the old authorization", () => {
    const f = setup();
    f.controller.attach({ token: "secret", expiresAt: Date.now() / 1000 + 3600 }, "A");
    expect(f.socket.close).not.toHaveBeenCalled();
    f.controller.attach({ token: "new", expiresAt: Date.now() / 1000 + 3600 }, "A");
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });

  it("authorization failure tears down before invoking the lock hook", () => {
    const f = setup();
    f.click("Call");
    f.socket.onclose?.({ code: 4401 });
    expect(f.audio.stop).toHaveBeenCalled();
    expect(f.lock).toHaveBeenCalledWith("unauthorized");
    expect(vi.mocked(f.audio.stop).mock.invocationCallOrder[0]).toBeLessThan(f.lock.mock.invocationCallOrder[0]!);
    f.controller.dispose();
  });

  it.each([1001, 4408, 4429])("operational close %s ends audio without locking the owner", (code) => {
    const f = setup();
    f.click("Call");
    f.socket.onclose?.({ code });
    expect(f.audio.stop).toHaveBeenCalledTimes(1);
    expect(f.lock).not.toHaveBeenCalled();
    f.controller.dispose();
  });
});

it("media envelope preserves call identity, sample clock and PCM without URL credentials", () => {
  const packet = encodeFrame(ID, 5, 7, new ArrayBuffer(960));
  new DataView(packet).setUint32(36, 9);
  const frame = decodeFrame(packet);
  expect(frame).toMatchObject({ callId: ID, sequence: 5, lease: 9 });
  expect(frame.pcm.byteLength).toBe(960);
  expect(new DataView(packet).getBigUint64(24)).toBe(2400n);
});

describe("a ringing or connecting call holds the idle-lock pause (Inv 55)", () => {
  /** How many `voiceCall` pauses are held right now (taken and not yet released). */
  const held = (f: ReturnType<typeof setup>) =>
    f.releases.filter((r) => r.reason === "voiceCall" && r.release.mock.calls.length === 0).length;
  const total = (f: ReturnType<typeof setup>) => f.releases.filter((r) => r.reason === "voiceCall").length;
  const requestId = (f: ReturnType<typeof setup>) => f.controls().filter((m) => m["type"] === "invite").at(-1)?.["requestId"];
  const ringOut = (f: ReturnType<typeof setup>, seconds: number) => {
    for (let i = 0; i < seconds; i++) { vi.advanceTimersByTime(1000); f.socket.receive({ type: "ping" }); }
  };

  it("holds one pause from the moment an outgoing invite is sent, through ringing, connecting and connected", async () => {
    const f = setup();
    f.click("Call");
    expect(held(f)).toBe(1);
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: requestId(f) });
    expect(held(f)).toBe(1);
    f.socket.receive({ type: "prepare", callId: ID });
    await Promise.resolve();
    expect(held(f)).toBe(1);
    f.socket.receive({ type: "connected", callId: ID });
    expect(held(f)).toBe(1);
    expect(total(f)).toBe(1); // one continuous pause: no gap in which the countdown could restart
    f.click("End call");
    expect(held(f)).toBe(0);
    f.controller.dispose();
  });
  it("holds one pause from the moment an incoming call is shown until it is declined", () => {
    const f = setup();
    expect(held(f)).toBe(0);
    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    expect(held(f)).toBe(1);
    f.click("Decline");
    expect(held(f)).toBe(0);
    f.controller.dispose();
  });
  it("holds one pause across an incoming call's answer and connect", async () => {
    const f = setup();
    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    f.click("Answer");
    f.socket.receive({ type: "prepare", callId: ID });
    await Promise.resolve();
    f.socket.receive({ type: "connected", callId: ID });
    expect(total(f)).toBe(1);
    expect(held(f)).toBe(1);
    f.controller.dispose();
  });
  it("releases when the caller cancels while calling", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: requestId(f) });
    f.click("Cancel call");
    expect(held(f)).toBe(0);
    f.controller.dispose();
  });
  it("releases when the other device declines or the server ends the ring", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: requestId(f) });
    f.socket.receive({ type: "ended", callId: ID, reason: "declined" });
    expect(held(f)).toBe(0);
    f.controller.dispose();
  });
  it("releases when the server ends an invite before any call id exists, and when the target is unavailable", () => {
    const f = setup();
    f.click("Call");
    expect(held(f)).toBe(1);
    f.socket.receive({ type: "unavailable", requestId: requestId(f) });
    expect(held(f)).toBe(0);
    f.click("Call");
    expect(held(f)).toBe(1);
    f.socket.receive({ type: "ended", callId: TARGET, requestId: requestId(f), reason: "timeout" });
    expect(held(f)).toBe(0);
    f.controller.dispose();
  });
  it("releases when the invite cannot be sent", () => {
    const f = setup();
    f.socket.bufferedAmount = 9000;
    f.click("Call");
    expect(held(f)).toBe(0);
    f.controller.dispose();
  });
  it("releases when an incoming call is never answered and the ring times out", () => {
    const f = setup();
    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    ringOut(f, 31);
    expect(held(f)).toBe(0);
    f.controller.dispose();
  });
  it("releases when an outgoing call's ring times out on this device", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: requestId(f) });
    ringOut(f, 31);
    expect(held(f)).toBe(0);
    f.controller.dispose();
  });
  it("releases when connecting audio fails or times out", async () => {
    const f = setup(async () => { throw new DOMException("x", "NotAllowedError"); });
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: requestId(f) });
    f.socket.receive({ type: "prepare", callId: ID });
    await Promise.resolve();
    await Promise.resolve();
    expect(held(f)).toBe(0);
    f.controller.dispose();
    const g = setup(() => new Promise<void>(() => {}));
    g.click("Call");
    g.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: requestId(g) });
    g.socket.receive({ type: "prepare", callId: ID });
    ringOut(g, 21);
    expect(held(g)).toBe(0);
    g.controller.dispose();
  });
  it("releases on socket close, detach and dispose while ringing", () => {
    const a = setup();
    a.click("Call");
    a.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: requestId(a) });
    a.socket.onclose?.({ code: 1006 });
    expect(held(a)).toBe(0);
    a.controller.dispose();
    const b = setup();
    b.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    b.controller.detach();
    expect(held(b)).toBe(0);
    b.controller.dispose();
    const c = setup();
    c.click("Call");
    c.controller.dispose();
    expect(held(c)).toBe(0);
  });
  it("takes only one pause when a crossing incoming call replaces a pending invite", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "incoming", callId: TARGET, peer: "B" });
    expect(held(f)).toBe(1);
    f.click("Decline");
    expect(held(f)).toBe(0);
    f.controller.dispose();
  });
});
