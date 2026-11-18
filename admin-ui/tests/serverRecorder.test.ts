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
  pause = vi.fn(() => {
    this.state = "paused";
  });
  resume = vi.fn(() => {
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

  it("holds a screen wake lock while recording, through pause, and releases it on stop", async () => {
    const release = vi.fn(async () => undefined);
    const wakeLock = { request: vi.fn(async () => ({ release }) as unknown as WakeLockSentinel) };
    const { hooks, stream } = setup();
    const recorder = createVoiceRecorder({
      hooks,
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
      mediaRecorder: FakeRecorder,
      wakeLock,
    });
    await recorder.start();
    await Promise.resolve();
    expect(wakeLock.request).toHaveBeenCalledWith("screen");
    recorder.pause();
    expect(release).not.toHaveBeenCalled();
    recorder.resume();
    recorder.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases a wake lock that resolves after the recording ended, and survives a refusal", async () => {
    const release = vi.fn(async () => undefined);
    let grant!: (s: WakeLockSentinel) => void;
    const late = new Promise<WakeLockSentinel>((r) => (grant = r));
    const { hooks, stream } = setup();
    const make = (wakeLock: Pick<WakeLock, "request">) =>
      createVoiceRecorder({
        hooks,
        mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
        mediaRecorder: FakeRecorder,
        wakeLock,
      });
    const slow = make({ request: vi.fn(() => late) });
    await slow.start();
    slow.stop();
    grant({ release } as unknown as WakeLockSentinel);
    await late;
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);

    const refused = make({
      request: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    });
    await refused.start();
    expect(refused.state).toBe("recording");
    refused.stop();
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

  it("auto-stops at four hours (a runaway guard, not the old fifteen-minute limit)", async () => {
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
    expect(withCallback.state).toBe("recording");
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 - 15 * 60 * 1000);
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

  it("pauses and resumes recording, freezing the timer and excluding paused time from duration", async () => {
    vi.useFakeTimers();
    let mockTime = 1000;
    const timerTicks: number[] = [];
    const onStop = vi.fn();
    const { stream, hooks } = setup();
    const recorder = createVoiceRecorder({
      hooks,
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
      mediaRecorder: FakeRecorder,
      now: () => mockTime,
      onTimer: (ms) => timerTicks.push(ms),
      onStop,
    });

    await recorder.start();
    expect(recorder.state).toBe("recording");
    expect(recorder.supportsPause).toBe(true);

    mockTime += 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(recorder.elapsedMs).toBe(2000);

    recorder.pause();
    expect(recorder.state).toBe("paused");
    expect(recorder.elapsedMs).toBe(2000);

    mockTime += 5000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(recorder.state).toBe("paused");
    expect(recorder.elapsedMs).toBe(2000);

    recorder.resume();
    expect(recorder.state).toBe("recording");
    expect(recorder.elapsedMs).toBe(2000);

    mockTime += 3000;
    await vi.advanceTimersByTimeAsync(3000);
    expect(recorder.elapsedMs).toBe(5000);

    recorder.stop();
    expect(recorder.state).toBe("idle");
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 5000 }));
  });

  it("allows stopping directly from paused state", async () => {
    vi.useFakeTimers();
    let mockTime = 1000;
    const onStop = vi.fn();
    const { stream, hooks } = setup();
    const recorder = createVoiceRecorder({
      hooks,
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
      mediaRecorder: FakeRecorder,
      now: () => mockTime,
      onStop,
    });

    await recorder.start();
    mockTime += 3000;
    await vi.advanceTimersByTimeAsync(3000);
    recorder.pause();
    expect(recorder.state).toBe("paused");
    expect(recorder.elapsedMs).toBe(3000);

    mockTime += 2000;
    recorder.stop();
    expect(recorder.state).toBe("idle");
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 3000 }));
  });

  it("allows cancelling from paused state", async () => {
    vi.useFakeTimers();
    let mockTime = 1000;
    const onCancel = vi.fn();
    const onStop = vi.fn();
    const { stream, hooks } = setup();
    const recorder = createVoiceRecorder({
      hooks,
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
      mediaRecorder: FakeRecorder,
      now: () => mockTime,
      onCancel,
      onStop,
    });

    await recorder.start();
    mockTime += 3000;
    recorder.pause();
    recorder.cancel();

    expect(recorder.state).toBe("idle");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
    expect(stream.track.stopped).toBe(true);
  });

  it("detects when MediaRecorder lacks pause support", async () => {
    class NoPauseRecorder extends FakeRecorder {
      override pause = undefined as unknown as typeof FakeRecorder.prototype.pause;
    }
    const { stream, hooks } = setup();
    const recorder = createVoiceRecorder({
      hooks,
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
      mediaRecorder: NoPauseRecorder as unknown as typeof FakeRecorder,
    });
    expect(recorder.supportsPause).toBe(false);
  });
});

describe("server voice recorder: live slices (spec/server-chat/06 §2.3)", () => {
  class SliceRecorder {
    static supported = new Set<string>(VOICE_MIME_PREFERENCES);
    static isTypeSupported = (mime: string) => SliceRecorder.supported.has(mime);
    static last: SliceRecorder | null = null;
    static constructed: Array<MediaRecorderOptions | undefined> = [];
    static rejectBitrate = false;
    readonly mimeType: string;
    state = "inactive";
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    start = vi.fn((_timeslice?: number) => { this.state = "recording"; });
    pause = vi.fn();
    resume = vi.fn();
    stop = vi.fn(() => {
      this.state = "inactive";
      this.emit("tail");
      this.onstop?.();
    });

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      SliceRecorder.constructed.push(options);
      if (SliceRecorder.rejectBitrate && options?.audioBitsPerSecond !== undefined) {
        throw new TypeError("audioBitsPerSecond is not supported");
      }
      this.mimeType = options?.mimeType ?? "audio/webm";
      SliceRecorder.last = this;
    }

    emit(text: string): void {
      this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) } as BlobEvent);
    }
  }

  afterEach(() => {
    SliceRecorder.constructed = [];
    SliceRecorder.rejectBitrate = false;
    SliceRecorder.supported = new Set(VOICE_MIME_PREFERENCES);
    SliceRecorder.last = null;
  });

  type RecorderOptions = Parameters<typeof createVoiceRecorder>[0];

  function make(extra: Partial<RecorderOptions> = {}) {
    let clock = 1000;
    const recorder = createVoiceRecorder({
      hooks: { suspend: vi.fn(() => () => undefined) },
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream() as unknown as MediaStream) },
      mediaRecorder: SliceRecorder as unknown as NonNullable<RecorderOptions["mediaRecorder"]>,
      now: () => clock,
      ...extra,
    });
    return { recorder, advance: (ms: number) => { clock += ms; } };
  }

  it("asks for a 15 s timeslice and 64 kbit/s, and says which container it recorded", async () => {
    const onStart = vi.fn();
    const { recorder } = make({ onStart });
    await recorder.start();
    expect(SliceRecorder.last?.start).toHaveBeenCalledWith(15000);
    expect(SliceRecorder.constructed[0]).toMatchObject({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64000 });
    expect(onStart).toHaveBeenCalledWith({ mimeType: "audio/webm;codecs=opus" });
    recorder.cancel();
  });

  it("carries on without the bitrate when the constructor rejects the option", async () => {
    SliceRecorder.rejectBitrate = true;
    const onError = vi.fn();
    const { recorder } = make({ onError });
    await recorder.start();
    expect(recorder.state).toBe("recording");
    expect(SliceRecorder.constructed).toHaveLength(2);
    expect(SliceRecorder.constructed[1]).toEqual({ mimeType: "audio/webm;codecs=opus" });
    expect(onError).not.toHaveBeenCalled();
    recorder.cancel();
  });

  it("hands over every slice in order with the elapsed time, including the last one at stop", async () => {
    const slices: Array<[number, number, number]> = [];
    const onStop = vi.fn();
    const { recorder, advance } = make({
      onSlice: (blob, index, elapsedMs) => { slices.push([blob.size, index, elapsedMs]); },
      onStop,
    });
    await recorder.start();
    advance(15000);
    SliceRecorder.last?.emit("aaaa");
    advance(15000);
    SliceRecorder.last?.emit("bbbbbb");
    advance(4000);
    recorder.stop();
    expect(slices).toEqual([[4, 0, 15000], [6, 1, 30000], [4, 2, 34000]]);
    // The whole recording is still there for the upload-at-stop fallback.
    const recording = onStop.mock.calls[0]?.[0] as { blob: Blob; durationMs: number };
    expect(recording.blob.size).toBe(4 + 6 + 4);
    expect(recording.durationMs).toBe(34000);
  });

  it("excludes paused time from a slice's elapsed figure", async () => {
    const elapsed: number[] = [];
    const { recorder, advance } = make({ onSlice: (_blob, _index, ms) => { elapsed.push(ms); } });
    await recorder.start();
    advance(10000);
    recorder.pause();
    advance(60000);
    recorder.resume();
    advance(5000);
    SliceRecorder.last?.emit("x");
    expect(elapsed).toEqual([15000]);
    recorder.cancel();
  });

  it("emits no slice for a cancelled recording and still releases the microphone", async () => {
    const onSlice = vi.fn();
    const stream = new FakeStream();
    const { recorder } = make({
      onSlice,
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
    });
    await recorder.start();
    recorder.cancel();
    expect(onSlice).not.toHaveBeenCalled();
    expect(stream.track.stopped).toBe(true);
  });

  it("a throwing slice consumer never costs the recording", async () => {
    const onError = vi.fn();
    const onStop = vi.fn();
    const { recorder } = make({ onSlice: () => { throw new Error("boom"); }, onError, onStop });
    await recorder.start();
    SliceRecorder.last?.emit("a");
    expect(recorder.state).toBe("recording");
    recorder.stop();
    expect(onStop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalled();
  });
});
