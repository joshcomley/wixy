/**
 * Main-thread owner of the live-voice playout graph: one AudioContext and one
 * `wixy-live-voice` AudioWorkletNode (`liveVoice/worklet.ts`, in the same self-hosted module as
 * the call's worklet). It plays 24 kHz mono frames and reports how many samples have actually
 * been consumed, which is what the hub's credit accounting and position are built on.
 *
 * `activate()` must run synchronously inside the user's tap: that is what lets iOS start audio.
 */

import { FRAME_SAMPLES } from "./protocol";

declare const WIXY_CALL_WORKLET_URL: string;

export interface LiveVoiceAudioCallbacks {
  /** Samples (24 kHz) played since the last `clear()`. */
  onProgress(playedSamples: number): void;
  /** The note ended (`markEof`) and every sample has been played. */
  onDrained(): void;
  /** The graph cannot play (no worklet, context closed, processor error). */
  onFailure(): void;
}

export interface LiveVoiceAudioHandle {
  /** Create the context and resume it. Synchronous, from a user gesture. Idempotent. */
  activate(): void;
  /** Load the worklet and build the graph. Safe to call again; resolves once ready. */
  prepare(): Promise<void>;
  /** Queue one 960-byte frame (the buffer is transferred). Held until the graph is ready. */
  push(pcm: ArrayBuffer): void;
  /** Drop everything queued and restart the played-sample count at 0. */
  clear(): void;
  /** No more frames will come: play out what is queued, then report `onDrained`. */
  markEof(): void;
  playedSamples(): number;
  stop(): void;
}

/** Frames held while the worklet is still loading: the credit window is 100 frames, with margin. */
const MAX_HELD_FRAMES = 150;

export class LiveVoiceAudio implements LiveVoiceAudioHandle {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private preparing: Promise<void> | null = null;
  private held: ArrayBuffer[] = [];
  private eofRequested = false;
  private epoch = 1;
  private played = 0;
  private stopped = false;

  constructor(private readonly callbacks: LiveVoiceAudioCallbacks) {}

  activate(): void {
    if (this.context !== null || this.stopped) return;
    try {
      this.context = new AudioContext();
      void this.context.resume().catch(() => {
        if (!this.stopped) this.callbacks.onFailure();
      });
    } catch {
      this.context = null;
      this.callbacks.onFailure();
    }
  }

  prepare(): Promise<void> {
    this.preparing ??= this.build();
    return this.preparing;
  }

  private async build(): Promise<void> {
    const context = this.context;
    if (context === null || this.stopped) throw new Error("Audio unavailable");
    await context.audioWorklet.addModule(
      typeof WIXY_CALL_WORKLET_URL === "string" ? WIXY_CALL_WORKLET_URL : "/admin/static/admin/call-worklet.js",
    );
    if (this.stopped) return;
    const node = new AudioWorkletNode(context, "wixy-live-voice", { outputChannelCount: [1] });
    node.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      const data = event.data;
      if (this.stopped || data["epoch"] !== this.epoch) return;
      if (data["type"] === "progress" && typeof data["played"] === "number") {
        this.played = data["played"];
        this.callbacks.onProgress(this.played);
      } else if (data["type"] === "drained") {
        this.callbacks.onDrained();
      }
    };
    node.onprocessorerror = () => {
      if (!this.stopped) this.callbacks.onFailure();
    };
    node.connect(context.destination);
    this.node = node;
    node.port.postMessage({ type: "clear", epoch: this.epoch });
    for (const pcm of this.held.splice(0)) node.port.postMessage({ type: "frame", epoch: this.epoch, pcm }, [pcm]);
    if (this.eofRequested) node.port.postMessage({ type: "eof", epoch: this.epoch });
    if (context.state === "suspended") void context.resume().catch(() => undefined);
  }

  push(pcm: ArrayBuffer): void {
    if (this.stopped || pcm.byteLength !== FRAME_SAMPLES * 2) return;
    if (this.node !== null) {
      this.node.port.postMessage({ type: "frame", epoch: this.epoch, pcm }, [pcm]);
    } else if (this.held.length < MAX_HELD_FRAMES) {
      this.held.push(pcm);
    }
  }

  clear(): void {
    this.epoch += 1;
    this.played = 0;
    this.held = [];
    this.eofRequested = false;
    this.node?.port.postMessage({ type: "clear", epoch: this.epoch });
  }

  markEof(): void {
    this.eofRequested = true;
    this.node?.port.postMessage({ type: "eof", epoch: this.epoch });
  }

  playedSamples(): number {
    return this.played;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.held = [];
    this.node?.port.postMessage({ type: "stop" });
    this.node?.disconnect();
    this.node?.port.close();
    this.node = null;
    const context = this.context;
    this.context = null;
    if (context !== null) void context.close().catch(() => undefined);
  }
}
