/** Owns one attempt's audio resources, including resources returned after cancellation. */
declare const WIXY_CALL_WORKLET_URL: string;
export class CallAudio {
  private context: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private stopped = false;
  private running = false;
  private muted = false;
  private activation: Promise<void>;

  constructor(private onCapture: (pcm: ArrayBuffer) => void, private onAdmitted: (sequence: number) => void,
    private onFailure: () => void) {
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
          if (this.running && !this.muted) this.onCapture(pcm);
          if (!this.stopped) this.node?.port.postMessage({ type: "buffer", pcm }, [pcm]);
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

  start(): void { this.running = true; this.setMuted(false); }
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.node?.port.postMessage({ type: "enabled", enabled: this.running && !muted });
  }
  lease(): number {
    const until = this.context.currentTime + 0.3;
    this.node?.port.postMessage({ type: "lease", until });
    return until;
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
