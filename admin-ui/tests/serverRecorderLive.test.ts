import { describe, expect, it, vi } from "vitest";
import { createVoiceRecorder, LIVE_SLICE_MS, VOICE_SLICE_MS } from "../src/server/recorder";

// The recorder's two slice lengths and the flush before a pause (spec/server-chat/07 §2).

class FakeRecorder {
  readonly mimeType = "audio/webm";
  state = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  start = vi.fn((_timeslice?: number) => { this.state = "recording"; });
  pause = vi.fn(() => { this.state = "paused"; });
  resume = vi.fn(() => { this.state = "recording"; });
  requestData = vi.fn(() => { this.ondataavailable?.({ data: new Blob(["tail"]) } as BlobEvent); });
  stop = vi.fn(() => { this.state = "inactive"; this.onstop?.(); });
  static last: FakeRecorder;
  constructor() { FakeRecorder.last = this; }
}

function setup(options: { live: boolean }) {
  const slices: number[] = [];
  const recorder = createVoiceRecorder({
    hooks: { suspend: () => () => undefined },
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream) },
    mediaRecorder: FakeRecorder as never,
    sliceMs: () => (options.live ? LIVE_SLICE_MS : VOICE_SLICE_MS),
    flushOnPause: () => options.live,
    onSlice: (_blob, index) => slices.push(index),
    wakeLock: { request: vi.fn(async () => ({ release: vi.fn(async () => undefined) }) as never) },
    now: () => 0,
  });
  return { recorder, slices };
}

describe("recorder slice length and pause flush", () => {
  it("an ordinary voice note is sliced every 15 s", async () => {
    const { recorder } = setup({ live: false });
    await recorder.start();
    expect(FakeRecorder.last.start).toHaveBeenCalledWith(15_000);
    recorder.cancel();
  });

  it("a live voice note is sliced every second", async () => {
    const { recorder } = setup({ live: true });
    await recorder.start();
    expect(FakeRecorder.last.start).toHaveBeenCalledWith(1_000);
    recorder.cancel();
  });

  it("a live note flushes what it has just before pausing, in order, so listeners are not left waiting for the resume", async () => {
    const { recorder, slices } = setup({ live: true });
    await recorder.start();
    recorder.pause();
    const order = [FakeRecorder.last.requestData.mock.invocationCallOrder[0]!, FakeRecorder.last.pause.mock.invocationCallOrder[0]!];
    expect(order[0]).toBeLessThan(order[1]!);
    expect(slices).toEqual([0]);
    recorder.cancel();
  });

  it("an ordinary note does not flush on pause", async () => {
    const { recorder } = setup({ live: false });
    await recorder.start();
    recorder.pause();
    expect(FakeRecorder.last.requestData).not.toHaveBeenCalled();
    recorder.cancel();
  });
});
