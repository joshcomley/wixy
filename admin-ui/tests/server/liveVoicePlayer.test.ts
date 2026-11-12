import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveVoiceAudio } from "../../src/server/liveVoice/player";

// The live-voice audio graph around the worklet: one context, one node, frames held until the
// worklet is loaded, epochs so a late report from before a clear is ignored.

class FakePort {
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  postMessage(message: Record<string, unknown>): void { this.sent.push(message); }
  close(): void { this.closed = true; }
  receive(data: Record<string, unknown>): void { this.onmessage?.({ data }); }
}
class FakeNode {
  static last: FakeNode;
  readonly port = new FakePort();
  onprocessorerror: (() => void) | null = null;
  connected = false;
  constructor(readonly context: unknown, readonly name: string) { FakeNode.last = this; }
  connect(): void { this.connected = true; }
  disconnect(): void { this.connected = false; }
}
class FakeContext {
  static last: FakeContext;
  state = "suspended";
  closed = false;
  modules: string[] = [];
  destination = {};
  audioWorklet = { addModule: vi.fn(async (url: string) => { this.modules.push(url); }) };
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.closed = true; });
  constructor() { FakeContext.last = this; }
}

const frame = () => new ArrayBuffer(960);

function make() {
  const progress: number[] = [];
  const callbacks = { onProgress: vi.fn((n: number) => progress.push(n)), onDrained: vi.fn(), onFailure: vi.fn() };
  const audio = new LiveVoiceAudio(callbacks);
  return { audio, callbacks, progress };
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
});
afterEach(() => vi.unstubAllGlobals());

describe("LiveVoiceAudio", () => {
  it("activates one context and resumes it synchronously (inside the tap)", () => {
    const { audio } = make();
    audio.activate();
    audio.activate();
    expect(FakeContext.last.resume).toHaveBeenCalledOnce();
  });

  it("loads the worklet module once and builds a wixy-live-voice node connected to the output", async () => {
    const { audio } = make();
    audio.activate();
    await Promise.all([audio.prepare(), audio.prepare()]);
    expect(FakeContext.last.audioWorklet.addModule).toHaveBeenCalledOnce();
    expect(FakeContext.last.modules[0]).toMatch(/call-worklet\.js/);
    expect(FakeNode.last.name).toBe("wixy-live-voice");
    expect(FakeNode.last.connected).toBe(true);
  });

  it("holds frames until the graph is built, then transfers them in order", async () => {
    const { audio } = make();
    audio.activate();
    audio.push(frame());
    audio.push(frame());
    const prepared = audio.prepare();
    await prepared;
    const sent = FakeNode.last.port.sent;
    expect(sent[0]).toMatchObject({ type: "clear" });
    expect(sent.filter((m) => m["type"] === "frame")).toHaveLength(2);
    audio.push(frame());
    expect(FakeNode.last.port.sent.filter((m) => m["type"] === "frame")).toHaveLength(3);
  });

  it("ignores a frame of the wrong size, and bounds what it will hold while loading", async () => {
    const { audio } = make();
    audio.activate();
    audio.push(new ArrayBuffer(100));
    for (let i = 0; i < 400; i++) audio.push(frame());
    await audio.prepare();
    expect(FakeNode.last.port.sent.filter((m) => m["type"] === "frame").length).toBe(150);
  });

  it("reports progress and drain only for the current epoch, and clear restarts the played count", async () => {
    const { audio, callbacks, progress } = make();
    audio.activate();
    await audio.prepare();
    const port = FakeNode.last.port;
    const epoch = (port.sent[0] as { epoch: number }).epoch;
    port.receive({ type: "progress", epoch, played: 960 });
    expect(audio.playedSamples()).toBe(960);
    audio.clear();
    expect(audio.playedSamples()).toBe(0);
    port.receive({ type: "progress", epoch, played: 1920 }); // the old epoch
    port.receive({ type: "drained", epoch });
    expect(progress).toEqual([960]);
    expect(callbacks.onDrained).not.toHaveBeenCalled();
    const next = (port.sent.at(-1) as { epoch: number }).epoch;
    port.receive({ type: "drained", epoch: next });
    expect(callbacks.onDrained).toHaveBeenCalledOnce();
  });

  it("markEof reaches the worklet, even when asked before it is built", async () => {
    const { audio } = make();
    audio.activate();
    audio.markEof();
    await audio.prepare();
    expect(FakeNode.last.port.sent.some((m) => m["type"] === "eof")).toBe(true);
  });

  it("reports a failure when the processor errors, and tears everything down on stop", async () => {
    const { audio, callbacks } = make();
    audio.activate();
    await audio.prepare();
    FakeNode.last.onprocessorerror?.();
    expect(callbacks.onFailure).toHaveBeenCalledOnce();
    audio.stop();
    expect(FakeNode.last.port.closed).toBe(true);
    expect(FakeContext.last.closed).toBe(true);
    audio.push(frame()); // nothing after stop
    expect(FakeNode.last.port.sent.filter((m) => m["type"] === "frame")).toHaveLength(0);
  });

  it("a context that cannot be created is a failure, not an exception", () => {
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("no audio"); } });
    const { audio, callbacks } = make();
    expect(() => audio.activate()).not.toThrow();
    expect(callbacks.onFailure).toHaveBeenCalledOnce();
  });
});
