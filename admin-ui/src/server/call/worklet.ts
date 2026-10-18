// Self-hosted AudioWorklet. Fixed capture pool and playout ring also bound MessagePort
// traffic when the browser main thread stalls. No samples leave this live graph to storage.
export {};
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class CallAudioProcessor extends AudioWorkletProcessor {
  private pool: ArrayBuffer[] = [];
  private capture: DataView | null = null;
  private captured = 0;
  private capturePhase = 0;
  private previous = 0;
  private low = 0;
  private alpha = 1 - Math.exp(-2 * Math.PI * 10_000 / sampleRate);
  private enabled = false;
  private leaseUntil = 0;
  private ring = new Float32Array(4800);
  private deadlines = new Float64Array(4800);
  private read = 0;
  private count = 0;
  private playPhase = 0;
  private playing = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      const data = event.data;
      if (data["type"] === "buffer" && data["pcm"] instanceof ArrayBuffer) {
        if (this.pool.length < 5 && data["pcm"].byteLength === 960) this.pool.push(data["pcm"]);
      } else if (data["type"] === "enabled") {
        this.enabled = data["enabled"] === true;
        this.captured = 0;
      } else if (data["type"] === "lease" && typeof data["until"] === "number") {
        this.leaseUntil = data["until"];
      } else if (data["type"] === "play" && data["pcm"] instanceof ArrayBuffer
        && typeof data["until"] === "number" && typeof data["sequence"] === "number") {
        const pcm = new DataView(data["pcm"]);
        if (pcm.byteLength !== 960 || data["until"] <= currentTime) return;
        // Drop old unsounded samples first. Never grow or catch up a stalled ring.
        if (this.count + 480 > this.ring.length) this.flush();
        for (let i = 0; i < 480; i++) {
          const at = (this.read + this.count) % this.ring.length;
          this.ring[at] = pcm.getInt16(i * 2, true) / 32768;
          this.deadlines[at] = data["until"];
          this.count++;
        }
        this.port.postMessage({ type: "admitted", sequence: data["sequence"] });
      } else if (data["type"] === "stop") {
        this.enabled = false;
        this.leaseUntil = 0;
        this.flush();
        this.port.close();
      }
    };
  }

  private flush(): void { this.read = 0; this.count = 0; this.playPhase = 0; this.playing = false; }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input !== undefined && this.enabled && currentTime < this.leaseUntil) {
      for (const value of input) {
        // Bounded low-pass plus fractional-rate interpolation; native contexts may
        // run at 44.1 or 48 kHz regardless of getUserMedia's sample-rate preference.
        this.low += this.alpha * (value - this.low);
        this.capturePhase += 24_000 / sampleRate;
        while (this.capturePhase >= 1) {
          this.capturePhase -= 1;
          if (this.capture === null) {
            const buffer = this.pool.pop();
            if (buffer !== undefined) this.capture = new DataView(buffer);
          }
          if (this.capture !== null) {
            const fraction = 1 - this.capturePhase * sampleRate / 24_000;
            const sample = this.previous + Math.max(0, Math.min(1, fraction)) * (this.low - this.previous);
            this.capture.setInt16(this.captured * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), true);
            if (++this.captured === 480) {
              const pcm = this.capture.buffer as ArrayBuffer;
              this.port.postMessage({ type: "capture", pcm }, [pcm]);
              this.capture = null;
              this.captured = 0;
            }
          }
        }
        this.previous = this.low;
      }
    } else {
      this.captured = 0;
      this.capturePhase = 0;
    }
    const output = outputs[0]?.[0];
    if (output === undefined) return true;
    output.fill(0);
    if (currentTime >= this.leaseUntil) { this.flush(); return true; }
    for (let i = 0; i < output.length; i++) {
      const at = currentTime + i / sampleRate;
      while (this.count > 0 && (this.deadlines[this.read] ?? 0) <= at) {
        this.read = (this.read + 1) % this.ring.length;
        this.count--;
        this.playing = false;
      }
      if (!this.playing && this.count >= 1440) this.playing = true;
      if (!this.playing || this.count < 2) { this.playing = false; continue; }
      const a = this.ring[this.read] ?? 0;
      const b = this.ring[(this.read + 1) % this.ring.length] ?? 0;
      output[i] = a + (b - a) * this.playPhase;
      // Small bounded drift correction; occupancy cannot grow over 200 ms.
      const correction = this.count > 2400 ? 1.005 : this.count < 960 ? 0.995 : 1;
      this.playPhase += 24_000 / sampleRate * correction;
      while (this.playPhase >= 1 && this.count > 0) {
        this.playPhase--;
        this.read = (this.read + 1) % this.ring.length;
        this.count--;
      }
    }
    return true;
  }
}
registerProcessor("wixy-call", CallAudioProcessor);
