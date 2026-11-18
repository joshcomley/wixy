import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame } from "../../src/server/call/protocol";
import {
  createLiveVoiceHub,
  type LiveAudioStatus,
  type LiveVoiceHub,
  type LiveVoiceModel,
  type LiveWatcher,
} from "../../src/server/liveVoice/hub";
import type { LiveVoiceAudioCallbacks, LiveVoiceAudioHandle } from "../../src/server/liveVoice/player";
import { encodeLiveFrame } from "../../src/server/liveVoice/protocol";

const A = "a".repeat(32);
const B = "b".repeat(32);
const SESSION = { token: "tok-1", expiresAt: 9_999_999_999 };
const pcm = () => new Uint8Array(960).fill(3).buffer;

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  constructor(readonly url: string, readonly protocol: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1005;
    this.readyState = 3;
  }
  // test controls
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  text(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  binary(buffer: ArrayBuffer): void {
    this.onmessage?.({ data: buffer });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m["type"] === type);
  }
}

class FakeAudio implements LiveVoiceAudioHandle {
  pushed = 0;
  played = 0;
  cleared = 0;
  eof = false;
  stopped = false;
  activated = 0;
  constructor(readonly callbacks: LiveVoiceAudioCallbacks) {}
  activate(): void { this.activated += 1; }
  prepare(): Promise<void> { return Promise.resolve(); }
  push(): void { this.pushed += 1; }
  clear(): void { this.cleared += 1; this.played = 0; this.pushed = 0; this.eof = false; }
  markEof(): void { this.eof = true; }
  playedSamples(): number { return this.played; }
  stop(): void { this.stopped = true; }
  /** Play `samples` more samples and tell the hub, as the worklet's progress report would. */
  advance(samples: number): void {
    this.played += samples;
    this.callbacks.onProgress(this.played);
  }
}

function harness(overrides: { backoffMs?: number[] } = {}) {
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextTimer = 1;
  const win = {
    location: window.location,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimer++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
  } as unknown as Window;
  const audios: FakeAudio[] = [];
  const lockNow = vi.fn();
  const hub = createLiveVoiceHub({
    win,
    getLabel: () => "Josh",
    lockNow,
    socketFactory: (url, protocol) => new FakeSocket(url, protocol) as unknown as WebSocket,
    audioFactory: (callbacks) => {
      const audio = new FakeAudio(callbacks);
      audios.push(audio);
      return audio;
    },
    backoffMs: overrides.backoffMs ?? [100, 200, 400],
  });
  return {
    hub,
    lockNow,
    audios,
    timers,
    fire(): void {
      const next = timers.shift();
      next?.fn();
    },
    socket: (): FakeSocket => FakeSocket.all.at(-1)!,
  };
}

function watcher(): LiveWatcher & { models: LiveVoiceModel[]; audio: LiveAudioStatus[]; online: boolean[]; errors: string[] } {
  const models: LiveVoiceModel[] = [];
  const audio: LiveAudioStatus[] = [];
  const online: boolean[] = [];
  const errors: string[] = [];
  return {
    models, audio, online, errors,
    onModel: (m) => { models.push(m); },
    onAudio: (a) => { audio.push(a); },
    onConnection: (o) => { online.push(o); },
    onError: (c) => { errors.push(c); },
  };
}

/** Open the socket and complete the auth handshake. */
function connect(h: ReturnType<typeof harness>): FakeSocket {
  const socket = h.socket();
  socket.open();
  socket.text({ type: "ready" });
  return socket;
}

beforeEach(() => {
  FakeSocket.all = [];
});

describe("live-voice hub: socket and watching (spec 07 §6.2)", () => {
  it("opens one socket with the wixy-live-voice-v1 subprotocol, authenticates in the first frame, and watches after ready", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    expect(FakeSocket.all).toHaveLength(1);
    const socket = h.socket();
    expect(socket.protocol).toBe("wixy-live-voice-v1");
    expect(socket.url).toMatch(/^wss?:\/\/.*\/api\/admin\/server\/live-voice\/ws$/);
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    expect(socket.sent).toEqual([{ type: "auth", v: 1, token: "tok-1", label: "Josh" }]);
    socket.text({ type: "ready" });
    expect(socket.ofType("watch")).toEqual([{ type: "watch", attachmentId: A }]);
    expect(h.hub.isOnline()).toBe(true);
  });

  it("multiplexes every visible live note over that one socket", () => {
    const h = harness();
    h.hub.attach(SESSION);
    h.hub.watch(A, watcher());
    const socket = connect(h);
    h.hub.watch(B, watcher());
    expect(FakeSocket.all).toHaveLength(1);
    expect(socket.ofType("watch").map((m) => m["attachmentId"])).toEqual([A, B]);
  });

  it("does not open a socket until something watches, and closes it when nothing does", () => {
    const h = harness();
    h.hub.attach(SESSION);
    expect(FakeSocket.all).toHaveLength(0);
    const stop = h.hub.watch(A, watcher());
    const socket = connect(h);
    stop();
    expect(socket.ofType("unwatch")).toEqual([{ type: "unwatch", attachmentId: A }]);
    expect(socket.closedWith).toBe(1000);
  });

  it("answers ping with pong", () => {
    const h = harness();
    h.hub.attach(SESSION);
    h.hub.watch(A, watcher());
    const socket = connect(h);
    socket.text({ type: "ping" });
    expect(socket.ofType("pong")).toHaveLength(1);
  });

  it("accumulates the growing peaks from state messages and hands each watcher the whole model", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const socket = connect(h);
    socket.text({ type: "state", attachmentId: A, state: "recording", durationMs: 2000, peaksFrom: 0, peaks: [10, 20] });
    socket.text({ type: "state", attachmentId: A, state: "recording", durationMs: 4000, peaksFrom: 2, peaks: [30, 40] });
    expect(w.models.at(-1)).toEqual({ state: "recording", durationMs: 4000, peaks: [10, 20, 30, 40] });
    // A bucket that was still growing is replaced from `peaksFrom`.
    socket.text({ type: "state", attachmentId: A, state: "paused", durationMs: 4500, peaksFrom: 3, peaks: [99] });
    expect(w.models.at(-1)).toEqual({ state: "paused", durationMs: 4500, peaks: [10, 20, 30, 99] });
    socket.text({ type: "state", attachmentId: A, state: "ended", durationMs: 4500, peaksFrom: 4, peaks: [] });
    expect(w.models.at(-1)?.state).toBe("ended");
  });

  it("a late watcher gets the model held so far, and a gap in the peaks asks for the whole array again", () => {
    const h = harness();
    h.hub.attach(SESSION);
    h.hub.watch(A, watcher());
    const socket = connect(h);
    socket.text({ type: "state", attachmentId: A, state: "recording", durationMs: 1000, peaksFrom: 0, peaks: [5] });
    const late = watcher();
    h.hub.watch(A, late);
    expect(late.models.at(-1)?.peaks).toEqual([5]);
    socket.text({ type: "state", attachmentId: A, state: "recording", durationMs: 9000, peaksFrom: 7, peaks: [1] });
    expect(socket.ofType("unwatch")).toHaveLength(1);
    expect(socket.ofType("watch").filter((m) => m["attachmentId"] === A)).toHaveLength(2);
    expect(late.models.at(-1)?.peaks).toEqual([5]);
  });

  it("ignores malformed and unknown messages without closing", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const socket = connect(h);
    socket.onmessage?.({ data: "garbage" });
    socket.text({ type: "state", attachmentId: A, state: "weird", durationMs: 1, peaksFrom: 0, peaks: [] });
    socket.text({ type: "novel" });
    expect(w.models).toHaveLength(0);
    expect(socket.closedWith).toBeNull();
  });
});

describe("live-voice hub: reconnecting, locking and detaching", () => {
  it("reconnects with backoff after a drop, re-authenticates, and re-watches", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    connect(h).drop(1006);
    expect(w.online.at(-1)).toBe(false);
    expect(h.timers.map((t) => t.ms)).toEqual([100]);
    h.fire();
    expect(FakeSocket.all).toHaveLength(2);
    // a second failure backs off further
    h.socket().drop(1006);
    expect(h.timers.map((t) => t.ms)).toEqual([200]);
    h.fire();
    const third = connect(h);
    expect(third.sent[0]).toMatchObject({ type: "auth", token: "tok-1" });
    expect(third.ofType("watch")).toEqual([{ type: "watch", attachmentId: A }]);
    expect(w.online.at(-1)).toBe(true);
    // ... and the backoff starts again after a success
    third.drop(1006);
    expect(h.timers.map((t) => t.ms)).toEqual([100]);
  });

  it("locks the chat on close code 4401 and does not reconnect", () => {
    const h = harness();
    h.hub.attach(SESSION);
    h.hub.watch(A, watcher());
    connect(h).drop(4401);
    expect(h.lockNow).toHaveBeenCalledOnce();
    expect(h.timers).toHaveLength(0);
  });

  it("closes the socket and stops audio on detach, keeps watchers, and brings them back on the next attach", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const first = connect(h);
    h.hub.play(A, "start");
    h.hub.detach();
    expect(first.closedWith).toBe(1000);
    expect(h.audios[0]?.stopped).toBe(true);
    expect(w.audio.at(-1)?.phase).toBe("idle");
    h.hub.attach({ token: "tok-2", expiresAt: 9_999_999_999 });
    expect(FakeSocket.all).toHaveLength(2);
    const second = connect(h);
    expect(second.sent[0]).toMatchObject({ type: "auth", token: "tok-2" });
    expect(second.ofType("watch")).toEqual([{ type: "watch", attachmentId: A }]);
    expect(second.ofType("play")).toHaveLength(0); // audio never resumes by itself after a lock
  });

  it("reconnects on a renewed token", () => {
    const h = harness();
    h.hub.attach(SESSION);
    h.hub.watch(A, watcher());
    const first = connect(h);
    h.hub.attach({ token: "tok-2", expiresAt: 9_999_999_999 });
    expect(first.closedWith).toBe(1000);
    expect(connect(h).sent[0]).toMatchObject({ token: "tok-2" });
    // the same token again changes nothing
    h.hub.attach({ token: "tok-2", expiresAt: 9_999_999_999 });
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("surfaces a watch error to the watcher (not_live) without dropping the socket", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const socket = connect(h);
    socket.text({ type: "error", attachmentId: A, code: "not_live" });
    expect(w.errors).toEqual(["not_live"]);
    expect(socket.closedWith).toBeNull();
  });
});

describe("live-voice hub: audio and credit (spec 07 §6.2)", () => {
  /** A pretend server: it sends frames while it holds credit, as the real one must. */
  function server(socket: FakeSocket, id: string) {
    let credit = 0;
    let sequence = 0;
    let sample = 0;
    let playIndex = -1;
    return {
      frames: 0,
      consume(): void {
        const credits = socket.ofType("credit");
        credit = credits.reduce((sum, m) => sum + (m["frames"] as number), 0) - this.frames;
      },
      /** Send up to `count` frames without ever exceeding the credit granted so far. */
      send(count: number): number {
        this.consume();
        let sent = 0;
        while (sent < count && credit > 0) {
          socket.binary(encodeLiveFrame(id, sequence++, sample, pcm()));
          sample += 480;
          this.frames++;
          credit--;
          sent++;
        }
        return sent;
      },
      startAt(from: number): void {
        playIndex = socket.ofType("play").length - 1;
        sample = from;
        sequence = 0;
        this.frames = 0;
        credit = 0;
        void playIndex;
      },
    };
  }

  it("sends play, then 50 frames of credit, and starts the audio from a tap", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const socket = connect(h);
    h.hub.play(A, "start");
    expect(h.audios[0]?.activated).toBe(1);
    expect(socket.ofType("play")).toEqual([{ type: "play", attachmentId: A, from: "start" }]);
    expect(socket.ofType("credit")).toEqual([{ type: "credit", attachmentId: A, frames: 50 }]);
    expect(w.audio.at(-1)).toMatchObject({ phase: "connecting" });
  });

  it("queues the play until the socket is ready when it is not yet", () => {
    const h = harness();
    h.hub.attach(SESSION);
    h.hub.watch(A, watcher());
    const socket = h.socket();
    socket.open();
    h.hub.play(A, "live");
    expect(socket.ofType("play")).toHaveLength(0);
    socket.text({ type: "ready" });
    expect(socket.ofType("play")).toEqual([{ type: "play", attachmentId: A, from: "live" }]);
    expect(socket.ofType("watch")).toHaveLength(0); // play implies watch
    expect(socket.ofType("credit")).toHaveLength(1);
  });

  it("never lets what is buffered plus what is granted and unused pass two seconds (100 frames), however fast the server sends or the player drains", () => {
    const h = harness();
    h.hub.attach(SESSION);
    h.hub.watch(A, watcher());
    const socket = connect(h);
    h.hub.play(A, "start");
    const audio = h.audios[0]!;
    const srv = server(socket, A);
    let received = 0;
    let maxCommitted = 0;
    const committed = () => {
      const granted = socket.ofType("credit").reduce((sum, m) => sum + (m["frames"] as number), 0);
      return granted - received + (received - Math.floor(audio.played / 480));
    };
    for (let round = 0; round < 200; round++) {
      received += srv.send(1000); // as many as credit allows, instantly
      maxCommitted = Math.max(maxCommitted, committed());
      audio.advance(480 * 7); // the player consumes 7 frames between server bursts
      maxCommitted = Math.max(maxCommitted, committed());
    }
    expect(maxCommitted).toBeLessThanOrEqual(100);
    expect(received).toBeGreaterThan(1000); // it kept topping up: playback did not stall
    for (const credit of socket.ofType("credit")) {
      expect(credit["frames"] as number).toBeGreaterThanOrEqual(1);
      expect(credit["frames"] as number).toBeLessThanOrEqual(500);
    }
  });

  it("does not play a frame the server had no credit for, a repeat, or one out of position", () => {
    const h = harness();
    h.hub.attach(SESSION);
    h.hub.watch(A, watcher());
    const socket = connect(h);
    h.hub.play(A, "start");
    const audio = h.audios[0]!;
    for (let i = 0; i < 50; i++) socket.binary(encodeLiveFrame(A, i, i * 480, pcm()));
    expect(audio.pushed).toBe(50);
    // credit 50 is used up (a top-up may be granted but the client has not been told it arrived)
    const before = audio.pushed;
    const granted = socket.ofType("credit").reduce((sum, m) => sum + (m["frames"] as number), 0);
    for (let i = 0; i < granted - 50 + 1; i++) socket.binary(encodeLiveFrame(A, 50 + i, (50 + i) * 480, pcm()));
    expect(audio.pushed - before).toBe(granted - 50); // the one beyond the credit is dropped
    const settled = audio.pushed;
    socket.binary(encodeLiveFrame(A, 3, 3 * 480, pcm())); // a repeat
    socket.binary(encodeLiveFrame(A, 999, 999 * 480, pcm())); // out of position
    socket.binary(encodeFrame(A, 5, 1, pcm())); // a call frame
    socket.binary(encodeLiveFrame(B, 0, 0, pcm())); // another note
    socket.binary(new ArrayBuffer(10));
    expect(audio.pushed).toBe(settled);
  });

  it("reports the position from the first frame's sample index plus what has been played", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const socket = connect(h);
    h.hub.play(A, "live");
    socket.binary(encodeLiveFrame(A, 0, 480 * 1000, pcm()));
    expect(w.audio.at(-1)).toMatchObject({ phase: "playing", positionSamples: 480_000 });
    h.audios[0]!.advance(2400);
    expect(w.audio.at(-1)?.positionSamples).toBe(482_400);
  });

  it("stop tells the server, drops queued audio and returns the position to resume from", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const socket = connect(h);
    h.hub.play(A, "start");
    socket.binary(encodeLiveFrame(A, 0, 0, pcm()));
    h.audios[0]!.advance(1440);
    expect(h.hub.stop(A)).toBe(1440);
    expect(socket.ofType("stop")).toEqual([{ type: "stop", attachmentId: A }]);
    expect(w.audio.at(-1)).toMatchObject({ phase: "idle", positionSamples: 1440, error: null });
    expect(h.hub.stop(A)).toBeNull();
    // resuming plays from that sample (a multiple of 480)
    h.hub.play(A, 1440);
    expect(socket.ofType("play").at(-1)).toEqual({ type: "play", attachmentId: A, from: 1440 });
  });

  it("only one audio stream at a time: a new play replaces the old one", () => {
    const h = harness();
    const wa = watcher();
    const wb = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, wa);
    h.hub.watch(B, wb);
    const socket = connect(h);
    h.hub.play(A, "start");
    h.hub.play(B, "live");
    expect(wa.audio.at(-1)?.phase).toBe("idle");
    expect(wb.audio.at(-1)?.phase).toBe("connecting");
    expect(socket.ofType("stop")).toEqual([{ type: "stop", attachmentId: A }]);
    expect(socket.ofType("play").map((m) => m["attachmentId"])).toEqual([A, B]);
  });

  it("on eof lets the buffered audio play out, then reports the note finished", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const socket = connect(h);
    h.hub.play(A, "start");
    socket.binary(encodeLiveFrame(A, 0, 0, pcm()));
    socket.binary(encodeLiveFrame(A, 1, 480, pcm()));
    socket.text({ type: "eof", attachmentId: A, sampleIndex: 960 });
    expect(h.audios[0]?.eof).toBe(true);
    expect(w.audio.at(-1)?.phase).toBe("playing");
    h.audios[0]!.callbacks.onDrained();
    expect(w.audio.at(-1)).toMatchObject({ phase: "finished", positionSamples: 960 });
  });

  it("resumes a stream after a reconnect from the sample after the last one it received, without re-clearing what is queued", () => {
    const h = harness();
    h.hub.attach(SESSION);
    h.hub.watch(A, watcher());
    const first = connect(h);
    h.hub.play(A, "start");
    for (let i = 0; i < 10; i++) first.binary(encodeLiveFrame(A, i, i * 480, pcm()));
    const audio = h.audios[0]!;
    first.drop(1006);
    expect(audio.cleared).toBe(1); // only the one clear at play
    h.fire();
    const second = connect(h);
    expect(second.ofType("play")).toEqual([{ type: "play", attachmentId: A, from: 4800 }]);
    const credit = second.ofType("credit")[0]?.["frames"] as number;
    expect(credit).toBeLessThanOrEqual(50);
    // the new play's sequence restarts at 0 and continues exactly where the last frame ended
    second.binary(encodeLiveFrame(A, 0, 4800, pcm()));
    expect(audio.pushed).toBe(11);
    second.binary(encodeLiveFrame(A, 1, 4800, pcm())); // not contiguous
    expect(audio.pushed).toBe(11);
  });

  it("an audio failure stops the stream and tells the watcher", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const socket = connect(h);
    h.hub.play(A, "start");
    h.audios[0]!.callbacks.onFailure();
    expect(socket.ofType("stop")).toHaveLength(1);
    expect(w.audio.at(-1)).toMatchObject({ phase: "idle", error: "audio_failed" });
  });

  it("too_many_listeners ends the attempt with the error shown to the watcher", () => {
    const h = harness();
    const w = watcher();
    h.hub.attach(SESSION);
    h.hub.watch(A, w);
    const socket = connect(h);
    h.hub.play(A, "start");
    socket.text({ type: "error", attachmentId: A, code: "too_many_listeners" });
    expect(w.audio.at(-1)).toMatchObject({ phase: "idle", error: "too_many_listeners" });
    expect(w.errors).toEqual(["too_many_listeners"]);
  });

  it("unwatching the note that is playing stops its audio", () => {
    const h = harness();
    const stop = h.hub.watch(A, watcher());
    h.hub.attach(SESSION);
    const socket = connect(h);
    h.hub.play(A, "start");
    stop();
    expect(socket.ofType("stop")).toEqual([{ type: "stop", attachmentId: A }]);
  });

  it("will not play a note nobody watches, or without a session", () => {
    const h = harness();
    h.hub.play(A, "start");
    expect(h.audios).toHaveLength(0);
    h.hub.attach(SESSION);
    h.hub.play(A, "start");
    expect(h.audios).toHaveLength(0);
  });
});

describe("live-voice hub: handover to the finished file", () => {
  let hub: LiveVoiceHub;
  beforeEach(() => {
    hub = harness().hub;
  });

  it("holds one handover per note, once", () => {
    hub.rememberHandover(A, { positionS: 12.5, playing: true });
    expect(hub.takeHandover(A)).toEqual({ positionS: 12.5, playing: true });
    expect(hub.takeHandover(A)).toBeNull();
    expect(hub.takeHandover(B)).toBeNull();
  });

  it("forgets a handover that nobody took within 15 s", () => {
    let t = 1000;
    const timed = createLiveVoiceHub({
      win: window,
      getLabel: () => "x",
      lockNow: () => undefined,
      now: () => t,
    });
    timed.rememberHandover(A, { positionS: 1, playing: false });
    t += 16_000;
    expect(timed.takeHandover(A)).toBeNull();
  });
});
