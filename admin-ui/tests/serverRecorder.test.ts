import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceRecorder, VOICE_MIME_PREFERENCES } from "../src/server/recorder";

class Track {
  stopped = false;

  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  readonly track = new Track();

  getTracks(): Track[] {
    return [this.track];
  }
}

class FakeRecorder {
  static supported = new Set<string>(VOICE_MIME_PREFERENCES);
  static isTypeSupported = vi.fn((mime: string) => FakeRecorder.supported.has(mime));
  readonly mimeType: string;
  state = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  });

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }
}

function setup() {
  const stream = new FakeStream();
  const releases: string[] = [];
  const hooks = {
    suspend: vi.fn((reason: string) => () => releases.push(reason)),
  };
  const recorder = createVoiceRecorder({
    hooks,
    mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
    mediaRecorder: FakeRecorder,
    now: () => 1000,
  });
  return { recorder, stream, hooks, releases };
}

afterEach(() => {
  vi.useRealTimers();
  FakeRecorder.supported = new Set(VOICE_MIME_PREFERENCES);
});

describe("server voice recorder", () => {
  it("uses the first supported MIME, suspends permission/recording, and releases the track", async () => {
    FakeRecorder.supported = new Set([VOICE_MIME_PREFERENCES[1]]);
    const { recorder, stream, hooks, releases } = setup();
    const stopped = vi.fn();

    await recorder.start();
    expect(recorder.state).toBe("recording");
    expect(hooks.suspend).toHaveBeenNthCalledWith(1, "micPermission");
    expect(hooks.suspend).toHaveBeenNthCalledWith(2, "recording");
    recorder.stop();

    expect(stopped).not.toHaveBeenCalled();
    expect(stream.track.stopped).toBe(true);
    expect(releases).toEqual(["micPermission", "recording"]);
    expect(FakeRecorder.isTypeSupported).toHaveBeenCalledWith(VOICE_MIME_PREFERENCES[0]);
  });

  it("delivers a recording on stop and a cancel never delivers a blob", async () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    const first = setup();
    const recorder = createVoiceRecorder({
      hooks: first.hooks,
      mediaDevices: { getUserMedia: vi.fn(async () => first.stream as unknown as MediaStream) },
      mediaRecorder: FakeRecorder,
      now: () => 1000,
      onStop,
      onCancel,
    });
    await recorder.start();
    recorder.stop();
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ blob: expect.any(Blob) }));

    const second = setup();
    const cancelled = createVoiceRecorder({
      hooks: second.hooks,
      mediaDevices: { getUserMedia: vi.fn(async () => second.stream as unknown as MediaStream) },
      mediaRecorder: FakeRecorder,
      onCancel,
    });
    await cancelled.start();
    cancelled.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(second.stream.track.stopped).toBe(true);
  });

  it("auto-stops at fifteen minutes", async () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const { recorder } = setup();
    const withCallback = createVoiceRecorder({
      hooks: { suspend: vi.fn(() => () => undefined) },
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream() as unknown as MediaStream) },
      mediaRecorder: FakeRecorder,
      onStop,
    });
    await withCallback.start();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(withCallback.state).toBe("idle");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(recorder.state).toBe("idle");
  });

  it("releases the microphone when permission is denied", async () => {
    const release = vi.fn();
    const onError = vi.fn();
    const recorder = createVoiceRecorder({
      hooks: { suspend: vi.fn(() => release) },
      mediaDevices: { getUserMedia: vi.fn(async () => { throw new Error("denied"); }) },
      mediaRecorder: FakeRecorder,
      onError,
    });
    await recorder.start();
    expect(release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(recorder.state).toBe("idle");
  });
});
