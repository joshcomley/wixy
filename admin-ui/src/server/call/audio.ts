/** Owns one attempt's audio resources, including resources returned after cancellation. */
declare const WIXY_CALL_WORKLET_URL: string;
const LEASE_S = 0.3;
interface GraphState { playUntil: number; captureLease: number; captureUntil: number; enabled: boolean; revision: number }
export class CallAudio {
  private context: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private stopped = false;
  private running = false;
  private muted = false;
  private activation: Promise<void>;
  // One coalesced main-to-worklet control in flight. The worklet acknowledges it from
  // process(), so an ack proves a render quantum ran, not merely that the port was read.
  private desired: GraphState = { playUntil: 0, captureLease: 0, captureUntil: 0, enabled: false, revision: 0 };
  private posted: GraphState | null = null;
  private flight: { seq: number; at: number; state: GraphState } | null = null;
  private seq = 0;
  private issuedUntil = 0;

  constructor(private onCapture: (pcm: ArrayBuffer, lease: number) => void, private onAdmitted: (sequence: number) => void,
    private onFailure: () => void, private onLeaseReady: (until: number, remainingMs: number) => void = () => {}) {
    this.context = new AudioContext();
    // Called synchronously from Call/Accept user gestures, before any server await.
    this.activation = this.context.resume();
    void this.activation.catch(() => { if (!this.stopped) this.onFailure(); });
  }

  async prepare(): Promise<void> {
    try {
      await this.activation;
      if (this.stopped) return;
      await this.context.audioWorklet.addModule(
        typeof WIXY_CALL_WORKLET_URL === "string" ? WIXY_CALL_WORKLET_URL : "/admin/static/admin/call-worklet.js",
      );
      if (this.stopped) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (this.stopped) { for (const track of stream.getTracks()) track.stop(); return; }
      this.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => {
        if (!this.stopped) this.onFailure();
      }, { once: true });
      if (this.context.state !== "running" || !stream.getAudioTracks().some((t) => t.readyState === "live")) {
        throw new Error("Audio unavailable");
      }
      this.node = new AudioWorkletNode(this.context, "wixy-call", { outputChannelCount: [1] });
      this.node.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
        const data = event.data;
        if (this.stopped) return;
        if (data["type"] === "capture" && data["pcm"] instanceof ArrayBuffer) {
          const pcm = data["pcm"];
          // Lease, mute revision and first-sample time were bound by the worklet; never relabel.
          const at = data["at"];
          const now = this.context.currentTime;
          try {
            if (pcm.byteLength === 960 && this.running && !this.muted
              && typeof data["lease"] === "number" && Number.isSafeInteger(data["lease"])
              && data["lease"] > 0 && data["lease"] <= 0xffffffff
              && data["revision"] === this.desired.revision && typeof at === "number"
              && Number.isFinite(at) && at <= now && now - at <= LEASE_S) this.onCapture(pcm, data["lease"]);
          } finally {
            // Forwarded, rejected and throwing callbacks return valid owned storage.
            if (!this.stopped && pcm.byteLength === 960) this.node?.port.postMessage({ type: "buffer", pcm }, [pcm]);
          }
        } else if (data["type"] === "state" && this.flight !== null && data["seq"] === this.flight.seq) {
          const flight = this.flight;
          this.flight = null;
          const remainingWallMs = LEASE_S * 1000 - (performance.now() - flight.at);
          if (remainingWallMs <= 0) { this.onFailure(); return; }
          const until = flight.state.playUntil;
          if (this.running && until > this.issuedUntil) {
            const remainingMs = Math.min(remainingWallMs, (until - this.context.currentTime) * 1000);
            if (remainingMs <= 0) { this.onFailure(); return; }
            this.issuedUntil = until;
            this.onLeaseReady(until, remainingMs); // Receiver lease only for a rendering graph.
          }
          this.sync();
        } else if (data["type"] === "admitted" && typeof data["sequence"] === "number") {
          this.onAdmitted(data["sequence"]);
        }
      };
      for (let i = 0; i < 5; i++) {
        const pcm = new ArrayBuffer(960);
        this.node.port.postMessage({ type: "buffer", pcm }, [pcm]);
      }
      this.node.onprocessorerror = this.onFailure;
      this.source = this.context.createMediaStreamSource(stream);
      this.source.connect(this.node);
      this.node.connect(this.context.destination);
      this.context.onstatechange = () => {
        if (!this.stopped && this.context.state !== "running") this.onFailure();
      };
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /** Never posts or fails synchronously: the controller acquires its call suspension, then pulses. */
  start(): void {
    this.running = true;
    this.muted = false;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = true;
    this.desired = { ...this.desired, enabled: true, revision: this.desired.revision + 1 };
  }
  setMuted(muted: boolean): void {
    if (muted !== this.muted) this.desired = { ...this.desired, revision: this.desired.revision + 1 };
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    // A new revision invalidates every capture buffer produced before this change.
    this.desired = { ...this.desired, enabled: this.running && !muted };
    this.sync();
  }
  /** 100 ms cadence while connected, including muted/silent calls. */
  pulse(): void {
    this.desired = { ...this.desired, playUntil: this.context.currentTime + LEASE_S };
    this.sync();
  }
  captureLease(lease: number): void {
    if (!Number.isSafeInteger(lease) || lease <= this.desired.captureLease) return;
    // Pushed as soon as the slot is free, not held for the next pulse: every 100 ms of
    // delay here is 100 ms less network budget before the relay's 300 ms expiry.
    this.desired = { ...this.desired, captureLease: lease, captureUntil: this.context.currentTime + LEASE_S };
    this.sync();
  }
  private sync(): void {
    if (this.stopped || !this.node || !this.running) return;
    if (this.flight !== null) {
      // Coalesce while unacknowledged; a graph that stops rendering fails the call.
      if (performance.now() - this.flight.at >= LEASE_S * 1000) this.onFailure();
      return;
    }
    if (this.posted === this.desired) return;
    this.posted = this.desired;
    this.flight = { seq: ++this.seq, at: performance.now(), state: this.desired };
    this.node.port.postMessage({ type: "state", seq: this.seq, ...this.desired });
  }
  play(pcm: ArrayBuffer, sequence: number, until: number): void {
    if (!this.stopped && this.running && until > this.context.currentTime) {
      this.node?.port.postMessage({ type: "play", pcm, sequence, until }, [pcm]);
    }
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.flight = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    this.node?.port.postMessage({ type: "stop" });
    this.node?.disconnect();
    this.node?.port.close();
    this.node = null;
    this.context.onstatechange = null;
    void this.context.close().catch(() => {});
  }
}
