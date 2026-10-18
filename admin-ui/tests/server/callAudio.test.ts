import { afterEach, expect, it, vi } from "vitest";
import { CallAudio } from "../../src/server/call/audio";

afterEach(() => vi.unstubAllGlobals());

it("stops a microphone granted after a lock without installing a graph", async () => {
  let resolve!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>((done) => { resolve = done; }));
  const createNode = vi.fn();
  const close = vi.fn(async () => {});
  vi.stubGlobal("AudioContext", class {
    state = "running";
    resume = async () => {};
    close = close;
    audioWorklet = { addModule: async () => {} };
  });
  vi.stubGlobal("AudioWorkletNode", createNode);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const stop = vi.fn();
  const audio = new CallAudio(vi.fn(), vi.fn(), vi.fn());
  const preparation = audio.prepare();
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  audio.stop();
  resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await preparation;
  expect(stop).toHaveBeenCalledTimes(1);
  expect(createNode).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

it.each(["suspended", "interrupted"])("resumes capture-induced %s audio before building its graph", async (state) => {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  let context!: FakeContext;
  class FakeContext {
    state = "running";
    resume = vi.fn(async () => { this.state = "running"; });
    close = vi.fn(async () => {});
    audioWorklet = { addModule: vi.fn(async () => {}) };
    createMediaStreamSource = vi.fn(() => source);
    constructor() { context = this; }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  const node = { port: { postMessage: vi.fn(), close: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
  const makeNode = vi.fn(function () { return node; });
  vi.stubGlobal("AudioWorkletNode", makeNode);
  const track = { readyState: "live", stop: vi.fn(), addEventListener: vi.fn() };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => {
    context.state = state; // Capture can switch iOS's audio session after initial activation.
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  }) } });
  const audio = new CallAudio(vi.fn(), vi.fn(), vi.fn());
  try {
    await audio.prepare();
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(makeNode).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
  } finally { audio.stop(); }
});

it("stops capture during a pending post-capture resume and rejects late graph construction", async () => {
  let releaseResume!: () => void;
  const pendingResume = new Promise<void>((resolve) => { releaseResume = resolve; });
  let context!: FakeContext;
  class FakeContext {
    state = "running";
    resume = vi.fn(async () => {
      if (this.state === "suspended") await pendingResume;
      if (this.state !== "closed") this.state = "running";
    });
    close = vi.fn(async () => { this.state = "closed"; });
    audioWorklet = { addModule: async () => {} };
    constructor() { context = this; }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  const makeNode = vi.fn();
  vi.stubGlobal("AudioWorkletNode", makeNode);
  const track = { readyState: "live", stop: vi.fn(), addEventListener: vi.fn() };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => {
    context.state = "suspended";
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  }) } });
  const audio = new CallAudio(vi.fn(), vi.fn(), vi.fn());
  const preparing = audio.prepare();
  await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(2));
  audio.stop();
  expect(track.stop).toHaveBeenCalledTimes(1);
  releaseResume();
  await preparing;
  expect(makeNode).not.toHaveBeenCalled();
  expect(context.close).toHaveBeenCalledTimes(1);
});

it.each(["reject", "remain-suspended"])("fails closed if post-capture resume will %s", async (mode) => {
  let context!: FakeContext;
  class FakeContext {
    state = "running";
    resume = vi.fn(async () => {
      if (this.state === "suspended" && mode === "reject") throw new DOMException("private-detail", "NotAllowedError");
    });
    close = vi.fn(async () => { this.state = "closed"; });
    audioWorklet = { addModule: async () => {} };
    constructor() { context = this; }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  const makeNode = vi.fn();
  vi.stubGlobal("AudioWorkletNode", makeNode);
  const track = { readyState: "live", stop: vi.fn(), addEventListener: vi.fn() };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => {
    context.state = "suspended";
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  }) } });
  const audio = new CallAudio(vi.fn(), vi.fn(), vi.fn());
  await expect(audio.prepare()).rejects.toThrow();
  expect(context.resume).toHaveBeenCalledTimes(2);
  expect(makeNode).not.toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(context.close).toHaveBeenCalledTimes(1);
});
