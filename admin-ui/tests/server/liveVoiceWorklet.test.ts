import { afterEach, describe, expect, it, vi } from "vitest";

interface Processor {
  port: { onmessage: (event: { data: Record<string, unknown> }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

async function processor(rate = 24_000) {
  const sent: Record<string, unknown>[] = [];
  const registered: Array<{ name: string; ctor: new () => Processor }> = [];
  vi.resetModules();
  vi.stubGlobal("sampleRate", rate);
  vi.stubGlobal("AudioWorkletProcessor", class {
    port = { onmessage: null, postMessage: (m: Record<string, unknown>) => sent.push(m), close: vi.fn() };
  });
  vi.stubGlobal("registerProcessor", (name: string, ctor: new () => Processor) => registered.push({ name, ctor }));
  await import("../../src/server/liveVoice/worklet");
  const entry = registered[0]!;
  const node = new entry.ctor();
  const message = (data: Record<string, unknown>) => node.port.onmessage({ data });
  const frame = (value: number, epoch = 0) => {
    const pcm = new ArrayBuffer(960);
    const view = new DataView(pcm);
    for (let i = 0; i < 480; i++) view.setInt16(i * 2, value, true);
    message({ type: "frame", epoch, pcm });
  };
  const render = (quanta: number) => {
    const out: number[] = [];
    for (let i = 0; i < quanta; i++) {
      const output = new Float32Array(128);
      node.process([], [[output]]);
      out.push(...output);
    }
    return out;
  };
  return { registered, node, sent, message, frame, render };
}
afterEach(() => vi.unstubAllGlobals());

describe("live-voice playout worklet (spec/server-chat/07 §2)", () => {
  it("registers the wixy-live-voice processor, and the call worklet module registers the call's processor last", async () => {
    const live = await processor();
    expect(live.registered.map((entry) => entry.name)).toEqual(["wixy-live-voice"]);

    const names: string[] = [];
    vi.resetModules();
    vi.stubGlobal("sampleRate", 48_000);
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal("AudioWorkletProcessor", class { port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() }; });
    vi.stubGlobal("registerProcessor", (name: string) => names.push(name));
    await import("../../src/server/call/worklet");
    expect(names).toEqual(["wixy-live-voice", "wixy-call"]);
  });

  it("is silent until 100 ms are queued, then plays the queued samples", async () => {
    const { frame, render } = await processor();
    frame(16000);
    frame(16000);
    frame(16000);
    frame(16000);
    expect(Math.max(...render(2))).toBe(0); // 4 x 20 ms = 80 ms < 100 ms
    frame(16000);
    const heard = render(3);
    expect(Math.max(...heard)).toBeCloseTo(16000 / 32768, 3);
  });

  it("reports samples played, and drains after eof without ever growing the ring", async () => {
    const { frame, render, message, sent } = await processor();
    for (let i = 0; i < 5; i++) frame(8000);
    message({ type: "eof", epoch: 0 });
    render(10 * 30); // 24 kHz output: 128 samples per quantum, 2400 samples queued
    const progress = sent.filter((m) => m["type"] === "progress");
    expect(progress.length).toBeGreaterThan(0);
    const last = progress.at(-1)!;
    expect(last["played"]).toBe(2400);
    expect(sent.some((m) => m["type"] === "drained")).toBe(true);
  });

  it("drops a frame that does not fit the fixed 3 s ring and says so, instead of growing", async () => {
    const { frame, sent } = await processor();
    for (let i = 0; i < 150; i++) frame(1000); // exactly 3 s
    expect(sent.filter((m) => m["type"] === "overflow")).toHaveLength(0);
    frame(1000);
    expect(sent.filter((m) => m["type"] === "overflow")).toHaveLength(1);
  });

  it("ignores frames of a cleared epoch and restarts its count on clear", async () => {
    const { frame, render, message, sent } = await processor();
    for (let i = 0; i < 6; i++) frame(9000);
    render(40);
    message({ type: "clear", epoch: 1 });
    frame(9000, 0); // a late frame of the old epoch
    expect(Math.max(...render(4))).toBe(0);
    for (let i = 0; i < 6; i++) frame(9000, 1);
    message({ type: "eof", epoch: 1 });
    render(30);
    const progress = sent.filter((m) => m["type"] === "progress" && m["epoch"] === 1);
    expect(progress.length).toBeGreaterThan(0);
    // Counted from zero again after the clear: 2880 samples were queued, none of the old epoch's.
    expect(progress.at(-1)!["played"]).toBe(2880);
  });

  it("stops for good on stop", async () => {
    const { node, message } = await processor();
    message({ type: "stop" });
    expect(node.process([], [[new Float32Array(128)]])).toBe(false);
  });
});
