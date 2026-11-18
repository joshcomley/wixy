/**
 * The page's one live-voice listener socket (spec/server-chat/07-live-voice-notes.md §6.2).
 *
 * Every visible live voice-note bubble `watch`es its attachment through this hub, which
 * multiplexes them over a single WebSocket, keeps each note's growing peaks, and plays at most one
 * audio stream at a time through the bounded live-voice worklet. Credit is the client's side of
 * the server's flow control: 50 frames at `play`, then top-ups that keep what is buffered plus
 * what has been granted and not yet received within two seconds (100 frames). A frame that
 * arrives beyond the credit granted is never played.
 *
 * Lifecycle: the socket opens only while something needs it (a watcher or an audio stream), and
 * `detach()` (every lock) closes it and stops audio, while keeping the watch registrations of
 * bubbles that are still on screen so the next `attach()` brings them back. A dropped socket
 * reconnects with backoff, re-watches, and resumes an audio stream from the sample after the last
 * one it received. Nothing is written to browser storage.
 */

import type { ServerSession } from "../types";
import { LiveVoiceAudio, type LiveVoiceAudioCallbacks, type LiveVoiceAudioHandle } from "./player";
import {
  decodeLiveFrame,
  FRAME_SAMPLES,
  INITIAL_CREDIT,
  LIVE_VOICE_PATH,
  LIVE_VOICE_PROTOCOL,
  MAX_BUFFER_FRAMES,
  MAX_CREDIT_PER_MESSAGE,
  MIN_GRANT_FRAMES,
  normalizeId,
  parseServerMessage,
  TOPUP_BELOW_FRAMES,
  type LiveStreamState,
  type LiveVoiceErrorCode,
  type PlayFrom,
} from "./protocol";

export type AudioPhase = "idle" | "connecting" | "playing" | "finished";

export interface LiveVoiceModel {
  readonly state: LiveStreamState;
  readonly durationMs: number;
  /** One bucket (0..255) per second, oldest first. */
  readonly peaks: readonly number[];
}

export interface LiveAudioStatus {
  readonly phase: AudioPhase;
  /** Absolute sample index (24 kHz) of what is playing, once known. */
  readonly positionSamples: number | null;
  readonly error: LiveVoiceErrorCode | "audio_failed" | null;
}

export interface LiveWatcher {
  onModel(model: LiveVoiceModel): void;
  onAudio(status: LiveAudioStatus): void;
  onConnection?(online: boolean): void;
  /** The server refused or could not follow this note (`not_found`, `not_live`, ...). */
  onError?(code: LiveVoiceErrorCode): void;
}

export interface LiveHandover {
  readonly positionS: number;
  readonly playing: boolean;
}

export interface LiveVoiceHub {
  /** Adopt a session (every unlock and every silent renewal). A new token reconnects. */
  attach(session: ServerSession): void;
  /** A lock: close the socket and stop audio. Registrations of bubbles still on screen are kept. */
  detach(): void;
  dispose(): void;
  watch(attachmentId: string, watcher: LiveWatcher): () => void;
  /** Start audio for a watched note. Call synchronously from the user's tap. */
  play(attachmentId: string, from: PlayFrom): void;
  /** Stop audio for the note; the position it reached (24 kHz samples), or `null` if it was not playing. */
  stop(attachmentId: string): number | null;
  isOnline(): boolean;
  /** A bubble that is being replaced by the finished file leaves its place for the successor. */
  rememberHandover(attachmentId: string, handover: LiveHandover): void;
  takeHandover(attachmentId: string): LiveHandover | null;
}

export interface LiveVoiceHubDeps {
  readonly win: Window;
  /** The name shown to the server in the first frame (the identity name, or a device label). */
  readonly getLabel: () => string;
  /** The server refused the token (close code 4401): lock the chat. */
  readonly lockNow: () => void;
  readonly socketFactory?: (url: string, protocol: string) => WebSocket;
  readonly audioFactory?: (callbacks: LiveVoiceAudioCallbacks) => LiveVoiceAudioHandle;
  readonly backoffMs?: readonly number[];
  readonly now?: () => number;
}

interface Watched {
  readonly id: string;
  readonly listeners: Set<LiveWatcher>;
  model: LiveVoiceModel | null;
  resyncing: boolean;
}

interface ActiveStream {
  readonly key: string;
  readonly id: string;
  readonly resume: PlayFrom;
  phase: AudioPhase;
  expectedSeq: number;
  nextSample: number | null;
  baseSample: number | null;
  /** Frames handed to the player since its last `clear()`. */
  received: number;
  /** Credit granted to the server and not yet used by a received frame. */
  outstanding: number;
  eof: boolean;
  /** The note's end, from the server's `eof` (the position a finished stream reports). */
  eofSample: number | null;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 15000];
const HANDOVER_TTL_MS = 15_000;
const WS_OPEN = 1;

export function createLiveVoiceHub(deps: LiveVoiceHubDeps): LiveVoiceHub {
  const { win } = deps;
  const backoff = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
  const now = deps.now ?? (() => Date.now());

  let session: ServerSession | null = null;
  let socket: WebSocket | null = null;
  let socketEpoch = 0;
  let ready = false;
  let retryTimer: number | null = null;
  let attempt = 0;
  let disposed = false;
  const watched = new Map<string, Watched>();
  let active: ActiveStream | null = null;
  let audio: LiveVoiceAudioHandle | null = null;
  const handovers = new Map<string, LiveHandover & { readonly at: number }>();

  // -- socket ---------------------------------------------------------------------------

  function needed(): boolean {
    return watched.size > 0 || active !== null;
  }

  function send(message: Record<string, unknown>): boolean {
    if (socket === null || socket.readyState !== WS_OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function openSocket(): void {
    if (disposed || socket !== null || retryTimer !== null || session === null || !needed()) return;
    const epoch = ++socketEpoch;
    const current = session;
    let next: WebSocket;
    try {
      const url = new URL(LIVE_VOICE_PATH, win.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      next = (deps.socketFactory ?? ((u, p) => new WebSocket(u, p)))(url.href, LIVE_VOICE_PROTOCOL);
    } catch {
      scheduleReconnect();
      return;
    }
    next.binaryType = "arraybuffer";
    socket = next;
    ready = false;
    next.onopen = () => {
      if (epoch !== socketEpoch) return;
      send({ type: "auth", v: 1, token: current.token, label: deps.getLabel().slice(0, 32) || "Device" });
    };
    next.onmessage = (event) => {
      if (epoch !== socketEpoch) return;
      if (event.data instanceof ArrayBuffer) handleFrame(event.data);
      else if (typeof event.data === "string") handleText(event.data);
    };
    next.onclose = (event) => {
      if (epoch !== socketEpoch) return;
      socket = null;
      setReady(false);
      if (event.code === 4401) {
        deps.lockNow();
        return;
      }
      scheduleReconnect();
    };
    next.onerror = () => {
      // The close event that follows does the work.
    };
  }

  function closeSocket(): void {
    socketEpoch++;
    if (retryTimer !== null) win.clearTimeout(retryTimer);
    retryTimer = null;
    const old = socket;
    socket = null;
    setReady(false);
    if (old !== null) {
      old.onopen = old.onmessage = old.onerror = old.onclose = null;
      try {
        old.close(1000);
      } catch {
        // Already closing.
      }
    }
  }

  function scheduleReconnect(): void {
    if (disposed || retryTimer !== null || session === null || !needed()) return;
    const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 15000;
    attempt++;
    retryTimer = win.setTimeout(() => {
      retryTimer = null;
      openSocket();
    }, delay);
  }

  function setReady(value: boolean): void {
    if (ready === value) return;
    ready = value;
    for (const entry of watched.values()) for (const watcher of entry.listeners) watcher.onConnection?.(value);
  }

  // -- messages -------------------------------------------------------------------------

  function handleText(text: string): void {
    const message = parseServerMessage(text);
    if (message === null) return;
    switch (message.type) {
      case "ready":
        attempt = 0;
        setReady(true);
        for (const [key, entry] of watched) {
          if (active === null || active.key !== key) send({ type: "watch", attachmentId: entry.id });
        }
        if (active !== null) sendPlay(active);
        return;
      case "ping":
        send({ type: "pong" });
        return;
      case "state":
        applyState(message);
        return;
      case "eof": {
        const stream = active;
        if (stream === null || stream.key !== normalizeId(message.attachmentId)) return;
        stream.eof = true;
        stream.eofSample = message.sampleIndex;
        audio?.markEof();
        return;
      }
      case "error":
        applyError(message.attachmentId, message.code);
        return;
    }
  }

  function applyState(message: Extract<ReturnType<typeof parseServerMessage>, { type: "state" }>): void {
    const entry = watched.get(normalizeId(message.attachmentId));
    if (entry === undefined) return;
    const previous = entry.model?.peaks ?? [];
    if (message.peaksFrom > previous.length) {
      // A gap: ask for the whole array again, once.
      if (!entry.resyncing) {
        entry.resyncing = true;
        send({ type: "unwatch", attachmentId: entry.id });
        send({ type: "watch", attachmentId: entry.id });
      }
      return;
    }
    entry.resyncing = false;
    const peaks = message.peaksFrom === previous.length
      ? [...previous, ...message.peaks]
      : [...previous.slice(0, message.peaksFrom), ...message.peaks];
    const model: LiveVoiceModel = { state: message.state, durationMs: message.durationMs, peaks };
    entry.model = model;
    for (const watcher of entry.listeners) watcher.onModel(model);
  }

  function applyError(attachmentId: string | null, code: LiveVoiceErrorCode): void {
    if (attachmentId === null) return;
    const key = normalizeId(attachmentId);
    const entry = watched.get(key);
    if (active !== null && active.key === key) {
      const position = positionOf(active);
      active = null;
      audio?.clear();
      notifyAudio(key, { phase: "idle", positionSamples: position, error: code });
    }
    if (entry !== undefined) for (const watcher of entry.listeners) watcher.onError?.(code);
  }

  // -- audio ----------------------------------------------------------------------------

  function positionOf(stream: ActiveStream): number | null {
    if (stream.baseSample !== null) return stream.baseSample + (audio?.playedSamples() ?? 0);
    return typeof stream.resume === "number" ? stream.resume : null;
  }

  function notifyAudio(key: string, status: LiveAudioStatus): void {
    const entry = watched.get(key);
    if (entry === undefined) return;
    for (const watcher of entry.listeners) watcher.onAudio(status);
  }

  function notifyStream(stream: ActiveStream, error: LiveAudioStatus["error"] = null): void {
    notifyAudio(stream.key, { phase: stream.phase, positionSamples: positionOf(stream), error });
  }

  function grant(stream: ActiveStream, frames: number): void {
    const buffered = stream.received - Math.floor((audio?.playedSamples() ?? 0) / FRAME_SAMPLES);
    const room = MAX_BUFFER_FRAMES - buffered - stream.outstanding;
    const count = Math.min(MAX_CREDIT_PER_MESSAGE, frames, room);
    if (count <= 0) return;
    if (send({ type: "credit", attachmentId: stream.id, frames: count })) stream.outstanding += count;
  }

  function sendPlay(stream: ActiveStream): void {
    const from: PlayFrom = stream.nextSample !== null ? stream.nextSample : stream.resume;
    stream.expectedSeq = 0;
    stream.outstanding = 0;
    if (!send({ type: "play", attachmentId: stream.id, from })) return;
    grant(stream, INITIAL_CREDIT);
  }

  function topUp(): void {
    const stream = active;
    if (stream === null || stream.eof || !ready || stream.outstanding >= TOPUP_BELOW_FRAMES) return;
    const buffered = stream.received - Math.floor((audio?.playedSamples() ?? 0) / FRAME_SAMPLES);
    const room = MAX_BUFFER_FRAMES - buffered - stream.outstanding;
    if (room < MIN_GRANT_FRAMES) return;
    grant(stream, room);
  }

  function handleFrame(packet: ArrayBuffer): void {
    const stream = active;
    if (stream === null) return;
    let frame;
    try {
      frame = decodeLiveFrame(packet);
    } catch {
      return;
    }
    if (frame.attachmentId !== stream.key) return;
    // Never trust a frame the server had no credit for, a repeat, or one out of position.
    if (stream.outstanding <= 0 || frame.sequence < stream.expectedSeq) return;
    if (stream.nextSample !== null && frame.sampleIndex !== stream.nextSample) return;
    stream.expectedSeq = frame.sequence + 1;
    stream.baseSample ??= frame.sampleIndex;
    stream.nextSample = frame.sampleIndex + FRAME_SAMPLES;
    stream.outstanding--;
    stream.received++;
    audio?.push(frame.pcm);
    if (stream.phase === "connecting") {
      stream.phase = "playing";
      notifyStream(stream);
    }
    topUp();
  }

  const audioCallbacks: LiveVoiceAudioCallbacks = {
    onProgress(): void {
      const stream = active;
      if (stream === null) return;
      if (stream.phase === "playing") notifyStream(stream);
      topUp();
    },
    onDrained(): void {
      const stream = active;
      if (stream === null || !stream.eof) return;
      stream.phase = "finished";
      // Everything the server sent has played: the position is the end of the note.
      notifyAudio(stream.key, { phase: "finished", positionSamples: stream.eofSample ?? positionOf(stream), error: null });
      active = null;
    },
    onFailure(): void {
      const stream = active;
      const old = audio;
      audio = null;
      old?.stop();
      if (stream === null) return;
      active = null;
      if (ready) send({ type: "stop", attachmentId: stream.id });
      notifyAudio(stream.key, { phase: "idle", positionSamples: positionOf(stream), error: "audio_failed" });
    },
  };

  function stopStream(stream: ActiveStream, tellServer: boolean): number | null {
    const position = positionOf(stream);
    if (tellServer && ready) send({ type: "stop", attachmentId: stream.id });
    audio?.clear();
    active = null;
    stream.phase = "idle";
    notifyAudio(stream.key, { phase: "idle", positionSamples: position, error: null });
    return position;
  }

  // -- public ---------------------------------------------------------------------------

  const hub: LiveVoiceHub = {
    attach(next: ServerSession): void {
      if (disposed) return;
      const changed = session !== null && session.token !== next.token;
      session = next;
      if (changed && (socket !== null || retryTimer !== null)) {
        closeSocket();
        attempt = 0;
      }
      openSocket();
    },

    detach(): void {
      closeSocket();
      attempt = 0;
      session = null;
      if (active !== null) stopStream(active, false);
      const old = audio;
      audio = null;
      old?.stop();
      handovers.clear();
    },

    dispose(): void {
      hub.detach();
      disposed = true;
      watched.clear();
    },

    watch(attachmentId: string, watcher: LiveWatcher): () => void {
      const key = normalizeId(attachmentId);
      let entry = watched.get(key);
      const fresh = entry === undefined;
      if (entry === undefined) {
        entry = { id: attachmentId, listeners: new Set(), model: null, resyncing: false };
        watched.set(key, entry);
      }
      entry.listeners.add(watcher);
      if (entry.model !== null) watcher.onModel(entry.model);
      if (ready) {
        if (fresh) send({ type: "watch", attachmentId });
      } else {
        openSocket();
      }
      return () => {
        const current = watched.get(key);
        if (current === undefined || !current.listeners.delete(watcher)) return;
        if (current.listeners.size > 0) return;
        watched.delete(key);
        if (active !== null && active.key === key) stopStream(active, true);
        else if (ready) send({ type: "unwatch", attachmentId: current.id });
        if (!needed()) closeSocket();
      };
    },

    play(attachmentId: string, from: PlayFrom): void {
      if (disposed || session === null) return;
      const key = normalizeId(attachmentId);
      if (!watched.has(key)) return;
      const resume: PlayFrom = typeof from === "number" ? Math.max(0, Math.floor(from / FRAME_SAMPLES) * FRAME_SAMPLES) : from;
      if (audio === null) {
        audio = (deps.audioFactory ?? ((callbacks) => new LiveVoiceAudio(callbacks)))(audioCallbacks);
      }
      // First thing, still inside the tap: the audio context must be started by a user gesture.
      audio.activate();
      if (active !== null) stopStream(active, true);
      audio.clear();
      active = {
        key,
        id: watched.get(key)?.id ?? attachmentId,
        resume,
        phase: "connecting",
        expectedSeq: 0,
        nextSample: null,
        baseSample: null,
        received: 0,
        outstanding: 0,
        eof: false,
        eofSample: null,
      };
      notifyStream(active);
      void audio.prepare().catch(() => audioCallbacks.onFailure());
      if (ready) sendPlay(active);
      else openSocket();
    },

    stop(attachmentId: string): number | null {
      const stream = active;
      if (stream === null || stream.key !== normalizeId(attachmentId)) return null;
      return stopStream(stream, true);
    },

    isOnline: () => ready,

    rememberHandover(attachmentId: string, handover: LiveHandover): void {
      const at = now();
      for (const [key, value] of handovers) if (at - value.at > HANDOVER_TTL_MS) handovers.delete(key);
      handovers.set(normalizeId(attachmentId), { ...handover, at });
    },

    takeHandover(attachmentId: string): LiveHandover | null {
      const key = normalizeId(attachmentId);
      const value = handovers.get(key);
      handovers.delete(key);
      if (value === undefined || now() - value.at > HANDOVER_TTL_MS) return null;
      return { positionS: value.positionS, playing: value.playing };
    },
  };
  return hub;
}
