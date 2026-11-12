/** MediaRecorder controller for the Server voice-note composer. */

/** A runaway guard for a phone left recording, not a product limit (spec/server-chat/06 §1). */
export const VOICE_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
/** How often MediaRecorder hands over a slice for the live upload (spec/server-chat/06 §2). */
export const VOICE_SLICE_MS = 15_000;
/** A live voice note (spec/server-chat/07 §2): a slice every second, so listeners hear it almost at once. */
export const LIVE_SLICE_MS = 1_000;
/** Voice quality; a browser may ignore it, and the size caps hold either way. */
export const VOICE_BITS_PER_SECOND = 64_000;
export const VOICE_MIME_PREFERENCES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

export type RecorderState = "idle" | "starting" | "recording" | "paused" | "stopping";
export type SuspendReason = "recording" | "micPermission" | "filePicker" | "mediaPlaying";

export interface LockHooks {
  suspend(reason: SuspendReason): () => void;
}

interface MediaRecorderLike {
  readonly mimeType: string;
  state: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
  pause?(): void;
  resume?(): void;
  requestData?(): void;
}

interface MediaRecorderConstructor {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorderLike;
  isTypeSupported?: (mimeType: string) => boolean;
}

export interface VoiceRecording {
  readonly blob: Blob;
  readonly durationMs: number;
  readonly mimeType: string;
}

export interface VoiceRecorderOptions {
  readonly hooks: LockHooks;
  readonly mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  readonly mediaRecorder?: MediaRecorderConstructor;
  /** Screen Wake Lock, held for the whole recording so the phone's own display timeout cannot
   * background the page (which locks the chat and discards the note). Defaults to
   * `navigator.wakeLock`; absent or refused is silently fine. */
  readonly wakeLock?: Pick<WakeLock, "request">;
  /** The recording really began (the microphone is open and the recorder is running). The
   * recorder's actual `mimeType` is known now, which is what the live upload is opened with. */
  readonly onStart?: (info: { readonly mimeType: string }) => void;
  /** The slice length for the recording that is about to begin, read at each `start()`:
   * `VOICE_SLICE_MS` (15 s) for an ordinary voice note, `LIVE_SLICE_MS` (1 s) for a live one
   * (spec/server-chat/07 §2). */
  readonly sliceMs?: () => number;
  /** Ask the browser for the audio recorded so far just before pausing, so a listener to a live
   * note is not left missing the last moment before the pause until the sender resumes. */
  readonly flushOnPause?: () => boolean;
  /** One 15 s slice, in order, as the browser emits it (the last one arrives just before
   * `onStop`). `elapsedMs` is the recording time so far, paused time excluded. The slices stay
   * in memory in the recorder until the finished `VoiceRecording` is dropped, so a failed live
   * upload can still upload the whole blob. */
  readonly onSlice?: (blob: Blob, index: number, elapsedMs: number) => void;
  readonly onStop?: (recording: VoiceRecording) => void;
  readonly onCancel?: () => void;
  readonly onTimer?: (elapsedMs: number) => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export interface VoiceRecorder {
  readonly state: RecorderState;
  readonly elapsedMs: number;
  readonly supportsPause: boolean;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  cancel(): void;
  toggle(): Promise<void>;
  detach(): void;
}

/**
 * Create a tap-to-start/tap-to-stop recorder. The returned controller is
 * deliberately UI-agnostic so the chat composer can put its own button and
 * accessible status text around it.
 */
export function createVoiceRecorder(options: VoiceRecorderOptions): VoiceRecorder {
  const mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
  const MediaRecorderCtor = options.mediaRecorder ?? globalThis.MediaRecorder as unknown as MediaRecorderConstructor;
  const now = options.now ?? (() => Date.now());
  const setIntervalFn = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;

  let state: RecorderState = "idle";
  let elapsed = 0;
  let accumulatedMs = 0;
  let segmentStartedAt = 0;
  let recorder: MediaRecorderLike | null = null;
  let stream: MediaStream | null = null;
  let releaseRecording: (() => void) | null = null;
  let wakeSentinel: WakeLockSentinel | null = null;
  /** Bumped on every acquire/release so a request that resolves after the recording ended
   * releases itself instead of holding the screen on. */
  let wakeEpoch = 0;
  let timerId: ReturnType<typeof setInterval> | null = null;
  let maxDurationId: ReturnType<typeof setTimeout> | null = null;
  let chunks: Blob[] = [];
  let sliceIndex = 0;
  let cancelled = false;
  let detached = false;
  let cancelNotified = false;

  const controller: VoiceRecorder = {
    get state() {
      return state;
    },
    get elapsedMs() {
      return elapsed;
    },
    get supportsPause() {
      const ctorProto = (MediaRecorderCtor as unknown as { prototype?: { pause?: unknown } })?.prototype;
      return (recorder !== null && typeof recorder.pause === "function") || typeof ctorProto?.pause === "function";
    },
    start,
    pause,
    resume,
    stop,
    cancel,
    toggle: async () => {
      if (state === "idle") await start();
      else if (state === "recording" || state === "paused") stop();
    },
    detach,
  };

  async function start(): Promise<void> {
    if (state !== "idle" || detached) return;
    state = "starting";
    cancelled = false;
    cancelNotified = false;
    chunks = [];
    elapsed = 0;
    accumulatedMs = 0;
    options.onTimer?.(0);

    const releasePermission = options.hooks.suspend("micPermission");
    let acquiredStream: MediaStream | null = null;
    try {
      acquiredStream = await mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      state = "idle";
      releasePermission();
      options.onError?.(error);
      return;
    }
    releasePermission();

    if (detached || cancelled) {
      stopTracks(acquiredStream);
      state = "idle";
      return;
    }

    stream = acquiredStream;
    const mimeType = chooseMimeType(MediaRecorderCtor);
    try {
      recorder = constructRecorder(MediaRecorderCtor, stream, mimeType);
      sliceIndex = 0;
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        chunks.push(event.data);
        const index = sliceIndex;
        sliceIndex += 1;
        // A cancelled or detached recording is being thrown away: nothing more to upload.
        if (cancelled || detached) return;
        try {
          options.onSlice?.(event.data, index, currentElapsed());
        } catch (error) {
          // A consumer fault must never cost the recording itself.
          options.onError?.(error);
        }
      };
      recorder.onerror = (event) => {
        options.onError?.(event);
        finish();
      };
      recorder.onstop = finish;
      releaseRecording = options.hooks.suspend("recording");
      recorder.start(options.sliceMs?.() ?? VOICE_SLICE_MS);
    } catch (error) {
      options.onError?.(error);
      releaseRecording?.();
      releaseRecording = null;
      stopTracks(stream);
      stream = null;
      recorder = null;
      state = "idle";
      return;
    }

    state = "recording";
    segmentStartedAt = now();
    try {
      options.onStart?.({ mimeType: recorder.mimeType || mimeType || "audio/webm" });
    } catch (error) {
      options.onError?.(error);
    }
    holdScreenAwake();
    timerId = setIntervalFn(() => {
      elapsed = Math.min(accumulatedMs + Math.max(0, now() - segmentStartedAt), VOICE_MAX_DURATION_MS);
      options.onTimer?.(elapsed);
    }, 1000);
    maxDurationId = setTimeoutFn(() => stop(), VOICE_MAX_DURATION_MS);
  }

  /** Recording time so far, paused time excluded. */
  function currentElapsed(): number {
    const running = state === "recording" ? Math.max(0, now() - segmentStartedAt) : 0;
    return Math.min(accumulatedMs + running, VOICE_MAX_DURATION_MS);
  }

  function pause(): void {
    if (state !== "recording") return;
    state = "paused";
    accumulatedMs = Math.min(accumulatedMs + Math.max(0, now() - segmentStartedAt), VOICE_MAX_DURATION_MS);
    elapsed = accumulatedMs;
    if (timerId !== null) clearIntervalFn(timerId);
    if (maxDurationId !== null) clearTimeoutFn(maxDurationId);
    timerId = null;
    maxDurationId = null;
    try {
      if (options.flushOnPause?.() === true) recorder?.requestData?.();
      recorder?.pause?.();
    } catch (error) {
      options.onError?.(error);
    }
    options.onTimer?.(elapsed);
  }

  function resume(): void {
    if (state !== "paused") return;
    state = "recording";
    segmentStartedAt = now();
    const remaining = Math.max(0, VOICE_MAX_DURATION_MS - accumulatedMs);
    if (remaining <= 0) {
      stop();
      return;
    }
    timerId = setIntervalFn(() => {
      elapsed = Math.min(accumulatedMs + Math.max(0, now() - segmentStartedAt), VOICE_MAX_DURATION_MS);
      options.onTimer?.(elapsed);
    }, 1000);
    maxDurationId = setTimeoutFn(() => stop(), remaining);
    try {
      recorder?.resume?.();
    } catch (error) {
      options.onError?.(error);
    }
    options.onTimer?.(elapsed);
  }

  function stop(): void {
    if (state !== "recording" && state !== "starting" && state !== "paused") return;
    if (state === "starting") {
      cancelled = true;
      return;
    }
    if (state === "recording") {
      accumulatedMs = Math.min(accumulatedMs + Math.max(0, now() - segmentStartedAt), VOICE_MAX_DURATION_MS);
    }
    state = "stopping";
    try {
      recorder?.stop();
    } catch (error) {
      options.onError?.(error);
      finish();
    }
  }

  function cancel(): void {
    if (state === "idle") return;
    cancelled = true;
    if (!cancelNotified) {
      cancelNotified = true;
      options.onCancel?.();
    }
    if (state === "starting") return;
    state = "stopping";
    try {
      recorder?.stop();
    } catch (error) {
      options.onError?.(error);
    } finally {
      // Do not wait for a browser's asynchronous `stop` event to release the
      // microphone: cancellation and detach are privacy-sensitive paths.
      finish();
    }
  }

  function detach(): void {
    detached = true;
    if (state !== "idle") cancel();
    else cleanup();
  }

  function finish(): void {
    if (state === "idle") return;
    elapsed = Math.min(accumulatedMs, VOICE_MAX_DURATION_MS);
    options.onTimer?.(elapsed);
    const currentRecorder = recorder;
    const result = !cancelled && !detached
      ? {
          blob: new Blob(chunks, { type: currentRecorder?.mimeType || "audio/webm" }),
          durationMs: elapsed,
          mimeType: currentRecorder?.mimeType || "audio/webm",
        }
      : null;
    cleanup();
    state = "idle";
    if (result) options.onStop?.(result);
  }

  function cleanup(): void {
    if (timerId !== null) clearIntervalFn(timerId);
    if (maxDurationId !== null) clearTimeoutFn(maxDurationId);
    timerId = null;
    maxDurationId = null;
    releaseRecording?.();
    releaseRecording = null;
    releaseScreenAwake();
    stopTracks(stream);
    stream = null;
    recorder = null;
    chunks = [];
    accumulatedMs = 0;
    segmentStartedAt = 0;
  }

  function holdScreenAwake(): void {
    const wakeLock = options.wakeLock ?? (typeof navigator !== "undefined" ? navigator.wakeLock : undefined);
    if (!wakeLock) return;
    const epoch = ++wakeEpoch;
    void (async () => {
      try {
        const sentinel = await wakeLock.request("screen");
        if (epoch !== wakeEpoch) await sentinel.release();
        else wakeSentinel = sentinel;
      } catch {
        // Unsupported, refused (battery saver) or not allowed here: recording carries on.
      }
    })();
  }

  function releaseScreenAwake(): void {
    wakeEpoch += 1;
    const sentinel = wakeSentinel;
    wakeSentinel = null;
    if (sentinel) void sentinel.release().catch(() => undefined);
  }

  return controller;
}

/** Ask for the voice bitrate, and carry on without it if this browser's constructor rejects the
 * option (a recorder that cannot honour a bitrate is still a recorder). */
function constructRecorder(
  ctor: MediaRecorderConstructor,
  stream: MediaStream,
  mimeType: string | undefined,
): MediaRecorderLike {
  const base: MediaRecorderOptions = mimeType ? { mimeType } : {};
  try {
    return new ctor(stream, { ...base, audioBitsPerSecond: VOICE_BITS_PER_SECOND });
  } catch {
    return mimeType ? new ctor(stream, base) : new ctor(stream);
  }
}

function chooseMimeType(ctor: MediaRecorderConstructor): string | undefined {
  if (!ctor.isTypeSupported) return undefined;
  return VOICE_MIME_PREFERENCES.find((mimeType) => ctor.isTypeSupported?.(mimeType));
}

function stopTracks(currentStream: MediaStream | null): void {
  if (!currentStream) return;
  for (const track of currentStream.getTracks()) track.stop();
}
