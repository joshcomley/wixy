/** MediaRecorder controller for the Server voice-note composer. */

export const VOICE_MAX_DURATION_MS = 15 * 60 * 1000;
export const VOICE_MIME_PREFERENCES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

export type RecorderState = "idle" | "starting" | "recording" | "stopping";
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
  start(): void;
  stop(): void;
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
  start(): Promise<void>;
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
  let recorder: MediaRecorderLike | null = null;
  let stream: MediaStream | null = null;
  let releaseRecording: (() => void) | null = null;
  let timerId: ReturnType<typeof setInterval> | null = null;
  let maxDurationId: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  let chunks: Blob[] = [];
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
    start,
    stop,
    cancel,
    toggle: async () => {
      if (state === "idle") await start();
      else if (state === "recording") stop();
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
      recorder = mimeType
        ? new MediaRecorderCtor(stream, { mimeType })
        : new MediaRecorderCtor(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = (event) => {
        options.onError?.(event);
        finish();
      };
      recorder.onstop = finish;
      releaseRecording = options.hooks.suspend("recording");
      recorder.start();
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
    startedAt = now();
    timerId = setIntervalFn(() => {
      elapsed = Math.min(now() - startedAt, VOICE_MAX_DURATION_MS);
      options.onTimer?.(elapsed);
    }, 1000);
    maxDurationId = setTimeoutFn(() => stop(), VOICE_MAX_DURATION_MS);
  }

  function stop(): void {
    if (state !== "recording" && state !== "starting") return;
    if (state === "starting") {
      cancelled = true;
      return;
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
    elapsed = Math.min(Math.max(now() - startedAt, elapsed), VOICE_MAX_DURATION_MS);
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
    stopTracks(stream);
    stream = null;
    recorder = null;
    chunks = [];
  }

  return controller;
}

function chooseMimeType(ctor: MediaRecorderConstructor): string | undefined {
  if (!ctor.isTypeSupported) return undefined;
  return VOICE_MIME_PREFERENCES.find((mimeType) => ctor.isTypeSupported?.(mimeType));
}

function stopTracks(currentStream: MediaStream | null): void {
  if (!currentStream) return;
  for (const track of currentStream.getTracks()) track.stop();
}
