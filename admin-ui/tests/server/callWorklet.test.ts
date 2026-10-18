import { afterEach, describe, expect, it, vi } from "vitest";

interface Processor {
  port: { onmessage: (event: { data: Record<string, unknown> }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
async function processor(rate: number) {
  const sent: Record<string, unknown>[] = [];
  let Constructor!: new () => Processor;
  vi.resetModules();
  vi.stubGlobal("sampleRate", rate);
  vi.stubGlobal("currentTime", 0);
  vi.stubGlobal("AudioWorkletProcessor", class {
    port = { onmessage: null, postMessage: (m: Record<string, unknown>) => sent.push(m), close: vi.fn() };
  });
  vi.stubGlobal("registerProcessor", (_name: string, ctor: new () => Processor) => { Constructor = ctor; });
  await import("../../src/server/call/worklet");
  const node = new Constructor();
  const message = (data: Record<string, unknown>) => node.port.onmessage({ data });
  return { node, sent, message };
}
afterEach(() => vi.unstubAllGlobals());

describe("bounded call audio worklet", () => {
  it.each([44_100, 48_000])("resamples a 440 Hz tone from %s Hz and caps capture at five transferred frames", async (rate) => {
    const { node, sent, message } = await processor(rate);
    for (let i = 0; i < 5; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
    message({ type: "state", seq: 1, playUntil: 0.3, captureLease: 1, captureUntil: 0.3, enabled: true, revision: 1 });
    const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 440 * i / rate) * 0.5);
    node.process([[input]], [[new Float32Array(128)]]);
    const frames = sent.filter((m) => m["type"] === "capture");
    expect(frames).toHaveLength(5);
    const values = frames.flatMap((m) => {
      const view = new DataView(m["pcm"] as ArrayBuffer);
      return Array.from({ length: 480 }, (_, i) => view.getInt16(i * 2, true));
    });
    const crossings = values.filter((value, i) => value >= 0 && (values[i - 1] ?? 0) < 0).length;
    expect(crossings).toBeGreaterThanOrEqual(42);
    expect(crossings).toBeLessThanOrEqual(45);
  });

  it("silences expired playout when the main thread never sends stop", async () => {
    const { node, message } = await processor(48_000);
    message({ type: "state", seq: 1, playUntil: 0.3, captureLease: 1, captureUntil: 0.3, enabled: true, revision: 1 });
    for (let sequence = 0; sequence < 3; sequence++) {
      const pcm = new ArrayBuffer(960);
      const view = new DataView(pcm);
      for (let i = 0; i < 480; i++) view.setInt16(i * 2, 16000, true);
      message({ type: "play", pcm, until: 0.3, sequence });
    }
    const output = new Float32Array(128);
    node.process([], [[output]]);
    expect(Math.max(...output)).toBeGreaterThan(0.4);
    vi.stubGlobal("currentTime", 0.31);
    node.process([], [[output]]);
    expect(output.every((value) => value === 0)).toBe(true);
    message({ type: "state", seq: 2, playUntil: 0.61, captureLease: 2, captureUntil: 0.61, enabled: false, revision: 1 });
    node.process([], [[output]]);
    expect(output.every((value) => value === 0)).toBe(true);
  });

  it("binds lease, mute revision and time at sample production; a later lease never relabels", async () => {
    const { node, sent, message } = await processor(48_000);
    for (let i = 0; i < 2; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
    message({ type: "state", seq: 1, playUntil: 1, captureLease: 1, captureUntil: 1, enabled: true, revision: 4 });
    node.process([[new Float32Array(480)]], [[new Float32Array(128)]]); // half of buffer one, lease 1
    message({ type: "state", seq: 2, playUntil: 1, captureLease: 2, captureUntil: 1, enabled: true, revision: 4 });
    node.process([[new Float32Array(1440)]], [[new Float32Array(128)]]);
    const frames = sent.filter((m) => m["type"] === "capture");
    expect(frames.map((m) => [m["lease"], m["revision"]])).toEqual([[1, 4], [2, 4]]);
    expect(sent.filter((m) => m["type"] === "state").map((m) => m["seq"])).toEqual([1, 2]);
    message({ type: "state", seq: 3, playUntil: 1, captureLease: 2, captureUntil: 0, enabled: true, revision: 4 });
    for (let i = 0; i < 2; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
    node.process([[new Float32Array(1920)]], [[new Float32Array(128)]]);
    expect(sent.filter((m) => m["type"] === "capture")).toHaveLength(2); // expired capture lease: no samples
  });

  it("acknowledges state only from a rendered quantum, never from the port handler alone", async () => {
    const { node, sent, message } = await processor(48_000);
    message({ type: "state", seq: 1, playUntil: 1, captureLease: 1, captureUntil: 1, enabled: false, revision: 1 });
    expect(sent.filter((m) => m["type"] === "state")).toHaveLength(0);
    node.process([], [[new Float32Array(128)]]);
    expect(sent.filter((m) => m["type"] === "state").map((m) => m["seq"])).toEqual([1]);
  });
  it("a mute revision discards the partial buffer and tags the next one with the new revision", async () => {
    const { node, sent, message } = await processor(48_000);
    for (let i = 0; i < 2; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
    message({ type: "state", seq: 1, playUntil: 1, captureLease: 1, captureUntil: 1, enabled: true, revision: 1 });
    node.process([[new Float32Array(480)]], [[new Float32Array(128)]]);
    message({ type: "state", seq: 2, playUntil: 1, captureLease: 1, captureUntil: 1, enabled: true, revision: 3 });
    node.process([[new Float32Array(960)]], [[new Float32Array(128)]]);
    const frames = sent.filter((m) => m["type"] === "capture");
    expect(frames.map((m) => m["revision"])).toEqual([3]);
  });
});
