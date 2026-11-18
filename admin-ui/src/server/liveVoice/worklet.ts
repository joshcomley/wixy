// Live-voice playout processor, a sibling of the call's processor in the same self-hosted
// worklet module (`call/worklet.ts` imports this file, so one fingerprinted `call-worklet.js`
// carries both). The call's processor keeps a 200 ms ring under 300 ms leases, which cannot hold
// the up-to-2 s the live-voice credit window allows, so this one has its own FIXED 3 s ring: it
// never grows, and a frame that does not fit is dropped (and reported) rather than queued.
// Nothing here ever leaves the live graph: no samples are stored.
export {};
declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

const SOURCE_RATE = 24_000;
const RING_SAMPLES = SOURCE_RATE * 3;
/** Wait for 100 ms of audio before (re)starting, so jitter does not stutter the start. */
const START_SAMPLES = 2_400;
/** Progress reports go out about every 65 ms of output at 48 kHz. */
const REPORT_EVERY_QUANTA = 25;

class LiveVoiceProcessor extends AudioWorkletProcessor {
  private ring = new Float32Array(RING_SAMPLES);
  private read = 0;
  private count = 0;
  private phase = 0;
  private playing = false;
  private eof = false;
  private drainedSent = false;
  private played = 0;
  private epoch = 0;
  private quanta = 0;
  private closed = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      const data = event.data;
      if (data["type"] === "frame" && data["pcm"] instanceof ArrayBuffer && data["pcm"].byteLength === 960
        && data["epoch"] === this.epoch) {
        if (this.count + 480 > this.ring.length) {
          this.port.postMessage({ type: "overflow", epoch: this.epoch });
          return;
        }
        const pcm = new DataView(data["pcm"]);
        for (let i = 0; i < 480; i++) {
          this.ring[(this.read + this.count) % this.ring.length] = pcm.getInt16(i * 2, true) / 32768;
          this.count++;
        }
        this.drainedSent = false;
      } else if (data["type"] === "clear" && typeof data["epoch"] === "number") {
        this.epoch = data["epoch"];
        this.read = 0;
        this.count = 0;
        this.phase = 0;
        this.playing = false;
        this.eof = false;
        this.drainedSent = false;
        this.played = 0;
      } else if (data["type"] === "eof" && data["epoch"] === this.epoch) {
        this.eof = true;
      } else if (data["type"] === "stop") {
        this.closed = true;
        this.read = 0;
        this.count = 0;
        this.port.close();
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.closed) return false;
    const output = outputs[0]?.[0];
    if (output === undefined) return true;
    output.fill(0);
    const step = SOURCE_RATE / sampleRate;
    for (let i = 0; i < output.length; i++) {
      if (!this.playing) {
        if (this.count >= START_SAMPLES || (this.eof && this.count > 0)) this.playing = true;
        else continue;
      }
      if (this.count === 0 || (this.count === 1 && !this.eof)) {
        // Ran dry: wait for the next 100 ms (the end of the note just stops).
        this.playing = false;
        continue;
      }
      const a = this.ring[this.read] ?? 0;
      const b = this.count > 1 ? (this.ring[(this.read + 1) % this.ring.length] ?? a) : a;
      output[i] = a + (b - a) * this.phase;
      this.phase += step;
      while (this.phase >= 1 && this.count > 0) {
        this.phase -= 1;
        this.read = (this.read + 1) % this.ring.length;
        this.count--;
        this.played++;
      }
    }
    if (this.eof && this.count === 0 && !this.drainedSent) {
      this.drainedSent = true;
      this.port.postMessage({ type: "progress", epoch: this.epoch, played: this.played });
      this.port.postMessage({ type: "drained", epoch: this.epoch });
    } else if (++this.quanta >= REPORT_EVERY_QUANTA) {
      this.quanta = 0;
      this.port.postMessage({ type: "progress", epoch: this.epoch, played: this.played });
    }
    return true;
  }
}
registerProcessor("wixy-live-voice", LiveVoiceProcessor);
