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
