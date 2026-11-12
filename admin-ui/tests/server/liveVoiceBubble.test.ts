import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveAudioStatus, LiveHandover, LiveVoiceHub, LiveVoiceModel, LiveWatcher } from "../../src/server/liveVoice/hub";
import {
  differOnlyInLiveOrTranscript,
  disposeLiveVoice,
  LIVE_WAVEFORM_BARS,
  normalizePeaks,
  patchLiveVoiceBlocks,
} from "../../src/server/liveVoice/bubble";
import { renderAttachment, renderAttachments, type Attachment, type MediaRenderContext } from "../../src/server/mediaRender";
import { AUDIO_CONFIRM_KEY } from "../../src/server/audioConfirmPreference";

const ID = "c".repeat(32);

function liveAttachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: ID, kind: "voice", status: "live", liveState: "recording",
    width: null, height: null, durationS: 0, peaks: [], urls: {},
    ...over,
  };
}

function fakeHub() {
  const watchers = new Set<LiveWatcher>();
  const handovers = new Map<string, LiveHandover>();
  let online = true;
  const hub = {
    attach: vi.fn(),
    detach: vi.fn(),
    dispose: vi.fn(),
    watch: vi.fn((_id: string, watcher: LiveWatcher) => {
      watchers.add(watcher);
      return () => { watchers.delete(watcher); };
    }),
    play: vi.fn(),
    stop: vi.fn((): number | null => null),
    isOnline: () => online,
    rememberHandover: vi.fn((id: string, handover: LiveHandover) => { handovers.set(id, handover); }),
    takeHandover: vi.fn((id: string) => {
      const value = handovers.get(id) ?? null;
      handovers.delete(id);
      return value;
    }),
  } satisfies LiveVoiceHub;
  return {
    hub,
    watchers,
    handovers,
    model(model: LiveVoiceModel): void { for (const w of [...watchers]) w.onModel(model); },
    audio(status: LiveAudioStatus): void { for (const w of [...watchers]) w.onAudio(status); },
    connection(value: boolean): void {
      online = value;
      for (const w of [...watchers]) w.onConnection?.(value);
    },
    error(code: Parameters<NonNullable<LiveWatcher["onError"]>>[0]): void { for (const w of [...watchers]) w.onError?.(code); },
  };
}

function setup(over: { own?: boolean; listened?: (id: string) => void; win?: Window } = {}) {
  const fake = fakeHub();
  const release = vi.fn();
  const suspend = vi.fn(() => release);
  const context: MediaRenderContext = {
    hooks: { suspend },
    liveVoice: fake.hub,
    ownMessage: over.own === true,
    ...(over.listened ? { onVoiceListened: over.listened } : {}),
    ...(over.win ? { win: over.win } : {}),
  };
  const attachments = [liveAttachment()];
  const container = renderAttachments(attachments, context);
  document.body.appendChild(container);
  const root = container.querySelector<HTMLElement>(".wx-srv-voice-live")!;
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  return { fake, release, suspend, context, container, root, q };
}

const peaks = (n: number, value = 100) => Array.from({ length: n }, () => value);
const model = (state: LiveVoiceModel["state"], durationMs: number, p: number[]): LiveVoiceModel => ({ state, durationMs, peaks: p });

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});
afterEach(() => document.body.replaceChildren());

describe("a live voice note in the thread (spec 07 §1)", () => {
  it("looks like a voice note with a LIVE badge, play, jump to live and a time", () => {
    const { root, q, fake } = setup();
    expect(fake.hub.watch).toHaveBeenCalledWith(ID, expect.anything());
    expect(root.dataset["state"]).toBe("recording");
    expect(q(".wx-srv-live-badge").hidden).toBe(false);
    expect(q(".wx-srv-live-badge").textContent).toContain("LIVE");
    expect(q(".wx-srv-voice-play").getAttribute("aria-label")).toBe("Play live voice note from the start");
    expect(q(".wx-srv-voice-live-jump").getAttribute("aria-label")).toBe("Jump to live");
    expect(q(".wx-srv-voice-time").textContent).toBe("0:00");
  });

  it("grows its waveform from state messages: one bar per second, newest 64 once it is longer", () => {
    const { q, fake } = setup();
    expect(q(".wx-srv-voice-waveform").children).toHaveLength(0);
    fake.model(model("recording", 3000, [10, 255, 128]));
    const bars = () => Array.from(q(".wx-srv-voice-waveform").children) as HTMLElement[];
    expect(bars()).toHaveLength(3);
    expect(bars()[1]?.style.getPropertyValue("--wx-srv-wave-height")).toBe("1");
    expect(bars()[2]?.classList.contains("wx-srv-voice-waveform-bar--edge")).toBe(true);
    fake.model(model("recording", 4000, [10, 255, 128, 64]));
    expect(bars()).toHaveLength(4);
    expect(q(".wx-srv-voice-time").textContent).toBe("0:04");
    const long = Array.from({ length: 100 }, (_, i) => i);
    fake.model(model("recording", 100_000, long));
    expect(bars()).toHaveLength(LIVE_WAVEFORM_BARS);
    // the newest bucket (99) is the last bar; the oldest shown is bucket 36
    expect(bars().at(-1)?.style.getPropertyValue("--wx-srv-wave-height")).toBe(String(99 / 255));
    expect(bars()[0]?.style.getPropertyValue("--wx-srv-wave-height")).toBe(String(36 / 255));
  });

  it("says Paused while the sender is paused, and the red edge goes", () => {
    const { q, root, fake } = setup();
    fake.model(model("recording", 2000, peaks(2)));
    fake.model(model("paused", 2000, peaks(2)));
    expect(root.dataset["state"]).toBe("paused");
    expect(q(".wx-srv-live-status").textContent).toBe("Paused");
    expect(q(".wx-srv-live-status").hidden).toBe(false);
    expect(q(".wx-srv-voice-waveform-bar--edge", )).toBeNull();
    fake.model(model("recording", 3000, peaks(3)));
    expect(q(".wx-srv-live-status").hidden).toBe(true);
  });

  it("when the sender stops the badge goes and the bubble says Finishing…", () => {
    const { q, root, fake } = setup();
    fake.model(model("ended", 5000, peaks(5)));
    expect(root.dataset["state"]).toBe("ended");
    expect(q(".wx-srv-live-badge").hidden).toBe(true);
    expect(q(".wx-srv-voice-live-jump").hidden).toBe(true);
    expect(q(".wx-srv-live-status").textContent).toBe("Finishing…");
  });

  it("says Reconnecting… when the socket drops after having been online", () => {
    const { q, fake } = setup();
    fake.connection(true);
    fake.connection(false);
    expect(q(".wx-srv-live-status").textContent).toBe("Reconnecting…");
    fake.connection(true);
    expect(q(".wx-srv-live-status").hidden).toBe(true);
  });

  it("Play joins from the start; pausing and resuming are ordinary; Jump to live joins at the newest audio", () => {
    const { q, fake, suspend, release } = setup();
    fake.model(model("recording", 30_000, peaks(30)));
    q<HTMLButtonElement>(".wx-srv-voice-play").click();
    expect(fake.hub.play).toHaveBeenLastCalledWith(ID, "start");
    expect(suspend).toHaveBeenCalledWith("mediaPlaying");

    fake.audio({ phase: "playing", positionSamples: 24_000 * 12, error: null });
    expect(q(".wx-srv-voice-play").getAttribute("aria-label")).toBe("Pause live voice note");
    expect(q(".wx-srv-voice-time").textContent).toBe("0:12 / 0:30");
    expect(q<HTMLElement>(".wx-srv-voice-live-playhead").hidden).toBe(false);

    fake.hub.stop.mockReturnValueOnce(24_000 * 12);
    q<HTMLButtonElement>(".wx-srv-voice-play").click();
    expect(fake.hub.stop).toHaveBeenCalledWith(ID);
    fake.audio({ phase: "idle", positionSamples: 24_000 * 12, error: null });
    expect(release).toHaveBeenCalledOnce();
    expect(q(".wx-srv-voice-play").getAttribute("aria-label")).toBe("Resume live voice note");

    q<HTMLButtonElement>(".wx-srv-voice-play").click();
    expect(fake.hub.play).toHaveBeenLastCalledWith(ID, 24_000 * 12);

    q<HTMLButtonElement>(".wx-srv-voice-live-jump").click();
    expect(fake.hub.play).toHaveBeenLastCalledWith(ID, "live");
  });

  it("asks first when the per-device 'ask before playing audio' choice is on", () => {
    localStorage.setItem(AUDIO_CONFIRM_KEY, "1");
    const { q, fake } = setup({ win: window });
    q<HTMLButtonElement>(".wx-srv-voice-play").click();
    expect(fake.hub.play).not.toHaveBeenCalled();
    expect(q(".wx-srv-voice-confirm").hidden).toBe(false);
    q<HTMLButtonElement>(".wx-srv-voice-confirm-play").click();
    expect(fake.hub.play).toHaveBeenCalledWith(ID, "start");
    expect(q(".wx-srv-voice-confirm").hidden).toBe(true);
  });

  it("shows why live audio did not start and lets the person try again", () => {
    const { q, fake, release } = setup();
    q<HTMLButtonElement>(".wx-srv-voice-play").click();
    fake.audio({ phase: "idle", positionSamples: null, error: "too_many_listeners" });
    expect(q(".wx-srv-live-status").textContent).toBe("Too many people are listening live. Try again in a moment.");
    expect(release).toHaveBeenCalled();
    q<HTMLButtonElement>(".wx-srv-voice-play").click();
    expect(fake.hub.play).toHaveBeenCalledTimes(2);
    expect(q(".wx-srv-live-status").hidden).toBe(true);
  });

  it("marks the note listened to once its stream finishes", () => {
    const listened = vi.fn();
    const { fake } = setup({ listened });
    fake.audio({ phase: "playing", positionSamples: 0, error: null });
    expect(listened).not.toHaveBeenCalled();
    fake.audio({ phase: "finished", positionSamples: 24_000 * 5, error: null });
    expect(listened).toHaveBeenCalledWith(ID);
    fake.audio({ phase: "finished", positionSamples: 24_000 * 5, error: null });
    expect(listened).toHaveBeenCalledTimes(1);
  });

  it("the sender's own bubble has the growing waveform but no Play or Jump to live", () => {
    const { q, fake } = setup({ own: true });
    fake.model(model("recording", 2000, peaks(2)));
    expect(q<HTMLElement>(".wx-srv-voice-play").hidden).toBe(true);
    expect(q<HTMLElement>(".wx-srv-voice-live-jump").hidden).toBe(true);
    expect(q(".wx-srv-voice-waveform").children).toHaveLength(2);
    expect(q(".wx-srv-live-badge").hidden).toBe(false);
  });

  it("without a hub it is a plain 'Live voice note…' line rather than a broken player", () => {
    const el = renderAttachment(liveAttachment(), { hooks: { suspend: () => () => undefined } });
    expect(el.textContent).toBe("Live voice note…");
  });
});

describe("patching a live bubble in place", () => {
  it("applies a status or pause change without rebuilding (so a stream keeps playing)", () => {
    const { container, root, q, fake } = setup();
    patchLiveVoiceBlocks(container, [liveAttachment({ liveState: "paused" })]);
    expect(root.dataset["state"]).toBe("paused");
    patchLiveVoiceBlocks(container, [liveAttachment({ status: "processing", durationS: 7 })]);
    expect(root.dataset["state"]).toBe("ended");
    expect(q(".wx-srv-live-status").textContent).toBe("Finishing…");
    expect(container.querySelector(".wx-srv-voice-live")).toBe(root);
    expect(fake.hub.stop).not.toHaveBeenCalled();
  });

  it("the comparator treats live-phase changes and transcripts as patchable, and anything else as a rebuild", () => {
    const msg = (a: Attachment) => ({ attachments: [a] });
    const base = liveAttachment();
    expect(differOnlyInLiveOrTranscript(msg(base), msg(liveAttachment({ liveState: "paused", durationS: 9, peaks: [1, 2] })))).toBe(true);
    expect(differOnlyInLiveOrTranscript(msg(base), msg(liveAttachment({ status: "processing" })))).toBe(true);
    expect(differOnlyInLiveOrTranscript(msg(base), msg(liveAttachment({ transcript: { status: "live", text: "hi", tail: "th" } })))).toBe(true);
    expect(differOnlyInLiveOrTranscript(
      msg(liveAttachment({ status: "processing" })),
      msg(liveAttachment({ status: "ready", urls: { play: "/x.m4a" } })),
    )).toBe(false);
    expect(differOnlyInLiveOrTranscript(msg(base), msg({ ...base, id: "other" }))).toBe(false);
    expect(differOnlyInLiveOrTranscript(msg(base), { attachments: [] })).toBe(false);
    // an ordinary ready note: only a transcript may differ
    const ready = liveAttachment({ status: "ready", liveState: undefined as never, urls: { play: "/a.m4a" } });
    expect(differOnlyInLiveOrTranscript(msg(ready), msg({ ...ready, transcript: { status: "done", text: "x" } }))).toBe(true);
    expect(differOnlyInLiveOrTranscript(msg(ready), msg({ ...ready, urls: { play: "/b.m4a" } }))).toBe(false);
  });
});

describe("replacing the live bubble with the finished file (spec 07 §1)", () => {
  it("a listener mid-note is handed over at the same position, and keeps playing", () => {
    const { container, fake, q } = setup();
    q<HTMLButtonElement>(".wx-srv-voice-play").click();
    fake.audio({ phase: "playing", positionSamples: 24_000 * 20, error: null });
    fake.hub.stop.mockReturnValueOnce(24_000 * 21);
    disposeLiveVoice(container);
    expect(fake.hub.rememberHandover).toHaveBeenCalledWith(ID, { positionS: 21, playing: true });
    expect(fake.watchers.size).toBe(0);

    const finished = liveAttachment({ status: "ready", durationS: 60, urls: { play: "/finished.m4a" } });
    const bubble = renderAttachment(finished, { hooks: { suspend: () => () => undefined }, liveVoice: fake.hub });
    const audio = bubble.querySelector("audio")!;
    expect(audio.preload).toBe("metadata");
    const play = vi.spyOn(audio, "play").mockResolvedValue();
    let position = 0;
    Object.defineProperty(audio, "currentTime", { get: () => position, set: (value: number) => { position = value; }, configurable: true });
    Object.defineProperty(audio, "duration", { get: () => 60, configurable: true });
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(position).toBe(21);
    expect(play).toHaveBeenCalledOnce();
  });

  it("a listener who had paused at a position resumes there, paused", () => {
    const { container, fake } = setup();
    fake.audio({ phase: "idle", positionSamples: 24_000 * 8, error: null });
    disposeLiveVoice(container);
    expect(fake.hub.rememberHandover).toHaveBeenCalledWith(ID, { positionS: 8, playing: false });
    const bubble = renderAttachment(
      liveAttachment({ status: "ready", durationS: 30, urls: { play: "/f.m4a" } }),
      { hooks: { suspend: () => () => undefined }, liveVoice: fake.hub },
    );
    const audio = bubble.querySelector("audio")!;
    const play = vi.spyOn(audio, "play").mockResolvedValue();
    let position = 0;
    Object.defineProperty(audio, "currentTime", { get: () => position, set: (value: number) => { position = value; }, configurable: true });
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(position).toBe(8);
    expect(play).not.toHaveBeenCalled();
  });

  it("someone who never listened leaves no handover, and a finished note without one is an ordinary lazy player", () => {
    const { container, fake } = setup();
    disposeLiveVoice(container);
    expect(fake.hub.rememberHandover).not.toHaveBeenCalled();
    const bubble = renderAttachment(
      liveAttachment({ status: "ready", durationS: 30, urls: { play: "/f.m4a" } }),
      { hooks: { suspend: () => () => undefined }, liveVoice: fake.hub },
    );
    expect(bubble.querySelector("audio")!.preload).toBe("none");
  });

  it("disposing releases the idle-lock hold and the watch", () => {
    const { container, fake, release, q } = setup();
    q<HTMLButtonElement>(".wx-srv-voice-play").click();
    disposeLiveVoice(container);
    expect(release).toHaveBeenCalled();
    expect(fake.watchers.size).toBe(0);
  });
});

describe("normalizePeaks", () => {
  it("reads 0..255 integers and 0..1 floats alike", () => {
    expect(normalizePeaks([0, 255, 51])).toEqual([0, 1, 0.2]);
    expect(normalizePeaks([0, 0.5, 1])).toEqual([0, 0.5, 1]);
    expect(normalizePeaks(null)).toEqual([]);
    expect(normalizePeaks([])).toEqual([]);
  });
});
