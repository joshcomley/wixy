import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallController, type CallAudioHandle } from "../../src/server/call/controller";
import { CallAudio } from "../../src/server/call/audio";

class Socket {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close = vi.fn();
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
const ID = "a".repeat(32);
const TARGET = "b".repeat(32);
type Factory = NonNullable<Parameters<typeof createCallController>[0]["audioFactory"]>;
type Capture = (pcm: ArrayBuffer, lease: number) => void;
type Ready = (until: number, remainingMs: number) => void;

function setup(isMicBusy: () => boolean = () => false, failAudio = false) {
  const socket = new Socket();
  const graphs: { audio: CallAudioHandle; capture: Capture; ready: Ready }[] = [];
  const factory = vi.fn((capture: Capture, _ack: unknown, _fail: unknown, ready: Ready) => {
    if (failAudio) throw new Error("AudioContext refused");
    const audio = {
      prepare: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), setMuted: vi.fn(),
      pulse: vi.fn(), play: vi.fn(), captureLease: vi.fn(),
    } as unknown as CallAudioHandle;
    graphs.push({ audio, capture, ready });
    return audio;
  });
  const busy = vi.fn();
  const controller = createCallController({ win: window, isMicBusy, onBusy: busy,
    hooks: { suspend: () => vi.fn(), lockNow: vi.fn() },
    socketFactory: () => socket as unknown as WebSocket,
    audioFactory: factory as unknown as Factory,
  });
  controller.attach({ token: "secret", expiresAt: Date.now() / 1000 + 3600 }, "A");
  socket.onopen?.();
  socket.receive({ type: "welcome", deadline: Date.now() / 1000 + 3600 });
  socket.receive({ type: "presence", peers: [{ id: TARGET, label: "B", available: true }] });
  const button = (text: string) => [...controller.element.querySelectorAll("button")].find((b) => b.textContent === text);
  const click = (text: string) => {
    const found = button(text);
    if (!found || found.hidden) throw new Error(`Missing ${text}`);
    found.click();
    const dialog = controller.element.querySelector<HTMLElement>(".wx-srv-call-dialog");
    if (text === "Call" && dialog && !dialog.hidden) {
      dialog.querySelector<HTMLButtonElement>(".wx-srv-call-confirm")?.click();
    }
  };
  const controls = () => socket.sent.filter((s): s is string => typeof s === "string")
    .map((s) => JSON.parse(s) as Record<string, unknown>);
  const requestId = () => controls().find((m) => m["type"] === "invite")?.["requestId"];
  return { controller, socket, graphs, click, button, controls, requestId, busy };
}

async function connected() {
  const f = setup();
  f.click("Call");
  f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.requestId() });
  f.socket.receive({ type: "prepare", callId: ID });
  await Promise.resolve();
  f.socket.receive({ type: "connected", callId: ID });
  return f;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("round 2 terminal and microphone boundaries", () => {
  it("retires only the matching pending request when terminal precedes outgoing", () => {
    const f = setup();
    try {
      f.click("Call");
      const requestId = f.requestId();
      f.socket.receive({ type: "ended", callId: ID, requestId: "wrong" });
      expect(f.graphs[0]?.audio.stop).not.toHaveBeenCalled();
      f.socket.receive({ type: "ended", callId: ID, requestId });
      expect(f.graphs[0]?.audio.stop).toHaveBeenCalledTimes(1);
      expect(f.busy).toHaveBeenLastCalledWith(false);
      expect(f.button("Call")?.disabled).toBe(false);
      f.socket.receive({ type: "outgoing", callId: ID, requestId });
      expect(f.button("End call")?.hidden).toBe(true);
    } finally { f.controller.dispose(); }
  });
  it("a losing request terminal preserves a newer Answer graph", () => {
    const f = setup();
    try {
      f.click("Call");
      const requestId = f.requestId();
      f.socket.receive({ type: "incoming", callId: TARGET, peer: "B" });
      f.click("Answer");
      f.socket.receive({ type: "ended", callId: ID, requestId });
      f.socket.receive({ type: "prepare", callId: TARGET });
      expect(f.graphs[1]?.audio.stop).not.toHaveBeenCalled();
      expect(f.graphs[1]?.audio.prepare).toHaveBeenCalledTimes(1);
    } finally { f.controller.dispose(); }
  });
  it("construction failure declines Answer but fabricates no action before invite", () => {
    const f = setup(() => false, true);
    try {
      f.click("Call");
      expect(f.controls().map((m) => m["type"])).toEqual(["auth"]);
      f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
      f.click("Answer");
      expect(f.controls().at(-1)).toEqual({ type: "decline", callId: ID });
    } finally { f.controller.dispose(); }
  });
  it("updates recorder ownership without presence events", () => {
    let recording = true;
    const f = setup(() => recording);
    try {
      expect(f.button("Call")?.disabled).toBe(true);
      recording = false;
      vi.advanceTimersByTime(100);
      expect(f.button("Call")?.disabled).toBe(false);
      recording = true;
      vi.advanceTimersByTime(100);
      expect(f.button("Call")?.disabled).toBe(true);
    } finally { f.controller.dispose(); }
  });
  it.each(["onerror", "onclose"] as const)("%s leaves presence reconnection usable during recording", (event) => {
    const f = setup(() => true);
    try {
      // Even a still-OPEN fake socket must be cleared before final UI rendering.
      f.socket.receive({ type: "presence", peers: [] });
      if (event === "onerror") f.socket.onerror?.();
      else f.socket.onclose?.({ code: 1006 });
      const reconnect = event === "onclose" ? "Reconnect calls" : "Call";
      expect(f.button(reconnect)?.disabled).toBe(false);
      f.click(reconnect);
      expect(f.graphs).toHaveLength(0);
    } finally { f.controller.dispose(); }
  });
});

describe("M3 crossing invitations", () => {
  it("preserves the explicitly selected device while it is busy, never silently selects the observer", () => {
    const f = setup();
    f.button("Call")!.click();
    const selected = () => f.controller.element.querySelector<HTMLInputElement>("input:checked")?.value;
    expect(selected()).toBe(TARGET);
    f.socket.receive({ type: "presence", peers: [
      { id: TARGET, label: "B", available: false }, { id: "c".repeat(32), label: "Observer", available: true },
    ] });
    expect(selected()).toBeUndefined();
    const confirm = f.controller.element.querySelector<HTMLButtonElement>(".wx-srv-call-confirm")!;
    expect(confirm.disabled).toBe(true);
    confirm.click();
    expect(f.controls().some((m) => m["type"] === "invite")).toBe(false);
    f.socket.receive({ type: "presence", peers: [
      { id: TARGET, label: "B", available: true }, { id: "c".repeat(32), label: "Observer", available: true },
    ] });
    expect(selected()).toBe(TARGET);
    f.controller.dispose();
  });
  it("keeps Answer pending across pulses until preparation arrives", () => {
    const f = setup();
    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    f.click("Answer");
    vi.advanceTimersByTime(100);
    f.click("Answer");
    expect(f.controls().filter((m) => m["type"] === "accept")).toHaveLength(1);
    expect(f.graphs).toHaveLength(1);
    f.controller.dispose();
  });
  it("incoming then busy: keeps the winning call; Answer is a separate gesture and graph", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
    expect(f.controller.element.textContent).toContain("Incoming call from B");
    expect(f.button("Answer")?.hidden).toBe(false);
    expect(f.controls().some((m) => m["type"] === "accept")).toBe(false); // never auto-answered
    f.click("Answer");
    expect(f.controls().at(-1)).toEqual({ type: "accept", callId: ID });
    expect(f.graphs).toHaveLength(2);
    expect(f.graphs[0]?.audio.stop).toHaveBeenCalledTimes(1); // only the losing Call graph
    expect(f.graphs[1]?.audio.stop).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("Answer then late busy: the newer Answer graph survives", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    f.click("Answer");
    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
    f.socket.receive({ type: "prepare", callId: ID });
    expect(f.graphs[1]?.audio.stop).not.toHaveBeenCalled();
    expect(f.graphs[1]?.audio.prepare).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });
  it("busy then incoming (defensive order): the incoming call is still offered, not answered", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    expect(f.controller.element.textContent).toContain("Incoming call from B");
    expect(f.button("Answer")?.hidden).toBe(false);
    expect(f.controls().some((m) => m["type"] === "accept")).toBe(false);
    expect(f.graphs[0]?.audio.stop).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });
  it("busy for another request is ignored; its own busy tears down", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "unavailable", requestId: "older" });
    expect(f.controller.element.textContent).not.toContain("unavailable");
    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
    expect(f.controller.element.textContent).toContain("That person is unavailable");
    f.controller.dispose();
  });
  it("Decline then late busy: nothing revived or re-sent", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
    f.click("Decline");
    const sent = f.controls().length;
    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
    expect(f.controls()).toHaveLength(sent);
    expect(f.controls().at(-1)).toEqual({ type: "decline", callId: ID });
    expect(f.button("Answer")?.hidden).toBe(true);
    expect(f.controller.element.textContent).not.toContain("unavailable");
    f.controller.dispose();
  });
  it("opposite role: an outgoing reply must answer this tab's pending request", () => {
    const f = setup();
    f.click("Call");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: "someone-else" });
    expect(f.controller.element.textContent).not.toContain("Calling");
    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.requestId() });
    expect(f.controller.element.textContent).toContain("Calling");
    f.controller.dispose();
  });
});

describe("M1 capture provenance and M4 lease issuance at the controller", () => {
  it("sends the lease bound at production, never the newest one", async () => {
    const f = await connected();
    f.socket.receive({ type: "capture", callId: ID, lease: 1 });
    f.socket.receive({ type: "capture", callId: ID, lease: 2 });
    f.graphs[0]?.capture(new ArrayBuffer(960), 1);
    const frames = f.socket.sent.filter((s): s is ArrayBuffer => s instanceof ArrayBuffer);
    expect(frames.map((b) => new DataView(b).getUint32(32))).toEqual([1]);
    f.controller.dispose();
  });
  it("pulses the graph but issues a receiver lease only on a rendered acknowledgement", async () => {
    const f = await connected();
    vi.advanceTimersByTime(500);
    expect(f.graphs[0]?.audio.pulse).toHaveBeenCalled();
    expect(f.controls().some((m) => m["type"] === "lease")).toBe(false);
    f.graphs[0]?.ready(0.3, 250);
    expect(f.controls().filter((m) => m["type"] === "lease")).toHaveLength(1);
    f.graphs[0]?.ready(0.4, 0);
    expect(f.controller.element.textContent).toContain("Audio unavailable");
    f.controller.dispose();
  });
});

function stubGraph() {
  const posted: Record<string, unknown>[] = [];
  const port = { onmessage: null as ((e: { data: Record<string, unknown> }) => void) | null,
    postMessage: (m: Record<string, unknown>) => posted.push(m), close: vi.fn() };
  const context = { state: "running", currentTime: 0, resume: async () => {}, close: async () => {},
    audioWorklet: { addModule: async () => {} }, destination: {},
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }), onstatechange: null };
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  vi.stubGlobal("AudioWorkletNode", class { port = port; connect = vi.fn(); disconnect = vi.fn(); onprocessorerror = null; });
  const track = { readyState: "live", enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
  const states = () => posted.filter((m) => m["type"] === "state");
  const ack = (seq: unknown) => port.onmessage?.({ data: { type: "state", seq } });
  return { posted, port, context, track, states, ack };
}

async function graph() {
  const g = stubGraph();
  const failed = vi.fn();
  const ready = vi.fn();
  const captured = vi.fn();
  const audio = new CallAudio(captured, vi.fn(), failed, ready);
  await audio.prepare();
  audio.start();
  return { ...g, audio, failed, ready, captured };
}

describe("M4 graph control bound", () => {
  it("keeps the original wall-clock expiry when a render ack is delayed and the audio clock stops", async () => {
    const g = await graph();
    g.audio.pulse();
    vi.advanceTimersByTime(200); // Context currentTime deliberately remains at zero.
    g.ack(g.states()[0]?.["seq"]);
    expect(g.ready).toHaveBeenCalledTimes(1);
    expect(g.ready.mock.calls[0]?.[1]).toBeLessThanOrEqual(100);
    g.audio.stop();
  });

  it("recycles an owned capture buffer even if the consumer throws", async () => {
    const g = await graph();
    g.audio.pulse();
    g.context.currentTime = 0.1;
    g.captured.mockImplementation(() => { throw new Error("consumer stopped"); });
    expect(() => g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960),
      lease: 1, revision: g.states()[0]?.["revision"], at: 0.05 } })).toThrow("consumer stopped");
    expect(g.posted.filter((m) => m["type"] === "buffer")).toHaveLength(6);
    g.audio.stop();
  });
  it("start posts nothing; a muted call keeps one coalesced control and fails a stalled render", async () => {
    const g = await graph();
    expect(g.states()).toHaveLength(0);
    g.audio.pulse();
    g.audio.setMuted(true);
    expect(g.track.enabled).toBe(false); // Mute is immediate at the track, not queued.
    for (let i = 0; i < 10_000; i++) { g.audio.pulse(); g.audio.captureLease(i + 1); g.audio.setMuted(i % 2 === 0); }
    expect(g.posted.filter((m) => m["type"] !== "buffer")).toHaveLength(1);
    expect(g.failed).not.toHaveBeenCalled();
    expect(g.ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    g.audio.pulse();
    expect(g.failed).toHaveBeenCalledTimes(1);
  });
  it("a rendered ack issues one receiver lease and sends the newest coalesced state", async () => {
    const g = await graph();
    g.audio.pulse();
    g.audio.captureLease(7);
    g.audio.setMuted(true);
    g.ack(g.states()[0]?.["seq"]);
    expect(g.ready).toHaveBeenCalledTimes(1);
    expect(g.ready.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(g.ready.mock.calls[0]?.[1]).toBeLessThanOrEqual(300);
    expect(g.states()).toHaveLength(2);
    expect(g.states()[1]).toMatchObject({ captureLease: 7, enabled: false });
    g.ack(g.states()[1]?.["seq"]); // Same playUntil: no second receiver lease.
    expect(g.ready).toHaveBeenCalledTimes(1);
  });
  it("a late acknowledgement fails; a stale one after stop revives nothing", async () => {
    const g = await graph();
    g.audio.pulse();
    vi.advanceTimersByTime(300);
    g.ack(g.states()[0]?.["seq"]);
    expect(g.failed).toHaveBeenCalledTimes(1);
    const h = await graph();
    h.audio.pulse();
    h.audio.stop();
    h.ack(h.states()[0]?.["seq"]);
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.failed).not.toHaveBeenCalled();
    expect(h.posted.filter((m) => m["type"] === "stop")).toHaveLength(1);
  });
  it("drops capture from an old mute revision or older than its lease, and recycles every buffer", async () => {
    const g = await graph();
    g.audio.pulse();
    const revision = g.states()[0]?.["revision"];
    g.context.currentTime = 1;
    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, revision, at: 0.5 } });
    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, revision: -1, at: 0.9 } });
    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, revision, at: 1.2 } });
    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, revision, at: 0.9 } });
    expect(g.captured.mock.calls.map((c) => c[1])).toEqual([3]);
    expect(g.posted.filter((m) => m["type"] === "buffer")).toHaveLength(9);
  });
});
