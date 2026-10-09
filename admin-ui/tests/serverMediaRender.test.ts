import { describe, expect, it, vi } from "vitest";
import {
  disposeAttachmentMedia,
  renderAttachment,
  renderAttachments,
  type Attachment,
} from "../src/server/mediaRender";
import { AUDIO_CONFIRM_KEY } from "../src/server/audioConfirmPreference";

const base: Attachment = {
  id: "a1",
  kind: "photo",
  status: "ready",
  width: 320,
  height: 200,
  durationS: null,
  peaks: null,
  urls: { thumb: "/thumb", full: "/full" },
};

function context() {
  return {
    hooks: { suspend: vi.fn(() => vi.fn()) },
    openLightbox: vi.fn(),
  };
}

describe("server attachment rendering", () => {
  it("renders processing and failed states", () => {
    const ctx = context();
    expect(renderAttachment({ ...base, status: "processing" }, ctx).textContent).toBe("Processing…");
    expect(renderAttachment({ ...base, status: "failed" }, ctx).textContent).toBe("Couldn't process this file");
  });

  it("renders photos as thumbnails that open the full rendition", () => {
    const ctx = context();
    const root = renderAttachments([base], ctx);
    expect(root.querySelector("img")?.getAttribute("src")).toBe("/thumb");
    const photoButton = root.querySelector<HTMLButtonElement>("button");
    expect(photoButton?.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    photoButton?.click();
    expect(ctx.openLightbox).toHaveBeenCalledWith("/full", "Attached photo");
  });

  it("renders video with the required lazy playback attributes", () => {
    const ctx = context();
    const root = renderAttachment({
      ...base,
      kind: "video",
      urls: { play: "/play", poster: "/poster" },
    }, ctx);
    const video = root as HTMLVideoElement;
    expect(video?.preload).toBe("none");
    expect(video?.playsInline).toBe(true);
    expect(video?.controls).toBe(true);
    expect(video?.poster).toContain("/poster");
    expect(video?.src).toContain("/play");
  });

  it("renders a voice waveform and suspends only during playback", () => {
    const ctx = context();
    const root = renderAttachment({
      ...base,
      kind: "voice",
      durationS: 12,
      peaks: [0.2, 0.8, 1],
      urls: { play: "/voice" },
    }, ctx);
    expect(root.querySelectorAll(".wx-srv-voice-waveform-bar")).toHaveLength(3);
    const audio = root.querySelector("audio");
    audio?.dispatchEvent(new Event("play"));
    expect(ctx.hooks.suspend).toHaveBeenCalledWith("mediaPlaying");
    audio?.dispatchEvent(new Event("pause"));
    expect(ctx.hooks.suspend).toHaveBeenCalledTimes(1);
  });

  it("plays voice audio immediately without confirmation by default (preference OFF)", () => {
    const ctx = context();
    const root = renderAttachment({
      ...base,
      kind: "voice",
      durationS: 5,
      peaks: [0.5],
      urls: { play: "/voice" },
    }, { ...ctx, win: window });
    const audio = root.querySelector("audio")!;
    const playSpy = vi.spyOn(audio, "play").mockImplementation(() => Promise.resolve());
    const playBtn = root.querySelector<HTMLButtonElement>("button.wx-srv-voice-play")!;
    const confirmBox = root.querySelector<HTMLElement>(".wx-srv-voice-confirm")!;

    expect(confirmBox.hidden).toBe(true);
    playBtn.click();
    expect(confirmBox.hidden).toBe(true);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("shows confirmation prompt when preference is ON, and cancels without playing", () => {
    window.localStorage.setItem(AUDIO_CONFIRM_KEY, "1");
    try {
      const ctx = context();
      const root = renderAttachment({
        ...base,
        kind: "voice",
        durationS: 5,
        peaks: [0.5],
        urls: { play: "/voice" },
      }, { ...ctx, win: window });
      const audio = root.querySelector("audio")!;
      const playSpy = vi.spyOn(audio, "play").mockImplementation(() => Promise.resolve());
      const playBtn = root.querySelector<HTMLButtonElement>("button.wx-srv-voice-play")!;
      const confirmBox = root.querySelector<HTMLElement>(".wx-srv-voice-confirm")!;
      const cancelBtn = root.querySelector<HTMLButtonElement>(".wx-srv-voice-confirm-cancel")!;
      const confirmPlayBtn = root.querySelector<HTMLButtonElement>(".wx-srv-voice-confirm-play")!;

      expect(confirmBox.hidden).toBe(true);
      playBtn.click();
      expect(confirmBox.hidden).toBe(false);
      expect(playSpy).not.toHaveBeenCalled();

      // Cancel hides prompt and does not play
      cancelBtn.click();
      expect(confirmBox.hidden).toBe(true);
      expect(playSpy).not.toHaveBeenCalled();

      // Click play again, then confirm plays
      playBtn.click();
      expect(confirmBox.hidden).toBe(false);
      confirmPlayBtn.click();
      expect(confirmBox.hidden).toBe(true);
      expect(playSpy).toHaveBeenCalledTimes(1);
    } finally {
      window.localStorage.removeItem(AUDIO_CONFIRM_KEY);
    }
  });

  it("pauses and synchronously releases active video and voice before redraw", () => {
    const audioRelease = vi.fn();
    const videoRelease = vi.fn();
    let releaseIndex = 0;
    const suspend = vi.fn(() => [audioRelease, videoRelease][releaseIndex++] ?? vi.fn());
    const root = renderAttachments([
      { ...base, kind: "voice", durationS: 3, peaks: [0.5], urls: { play: "/voice" } },
      { ...base, kind: "video", urls: { play: "/video", poster: "/poster" } },
    ], { hooks: { suspend } });
    const audio = root.querySelector<HTMLAudioElement>("audio")!;
    const video = root.querySelector<HTMLVideoElement>("video")!;
    const pauseAudio = vi.spyOn(audio, "pause").mockImplementation(() => {});
    const loadAudio = vi.spyOn(audio, "load").mockImplementation(() => {});
    const pauseVideo = vi.spyOn(video, "pause").mockImplementation(() => {});
    const loadVideo = vi.spyOn(video, "load").mockImplementation(() => {});
    audio.dispatchEvent(new Event("play"));
    video.dispatchEvent(new Event("play"));

    disposeAttachmentMedia(root);

    expect(pauseAudio).toHaveBeenCalledTimes(1);
    expect(pauseVideo).toHaveBeenCalledTimes(1);
    expect(loadAudio).toHaveBeenCalledTimes(1);
    expect(loadVideo).toHaveBeenCalledTimes(1);
    expect(audioRelease).toHaveBeenCalledTimes(1);
    expect(videoRelease).toHaveBeenCalledTimes(1);
    expect(audio.hasAttribute("src")).toBe(false);
    expect(video.hasAttribute("src")).toBe(false);
  });

  describe("voice-note position bar and skip buttons", () => {
    const voice: Attachment = {
      ...base,
      kind: "voice",
      durationS: 120,
      peaks: [0.5],
      urls: { play: "/voice" },
    };
    function setup() {
      vi.useFakeTimers();
      const root = renderAttachments([voice], context());
      document.body.appendChild(root);
      const audio = root.querySelector<HTMLAudioElement>("audio")!;
      Object.defineProperty(audio, "duration", { value: 120, configurable: true });
      audio.currentTime = 50;
      const back = root.querySelector<HTMLButtonElement>(".wx-srv-voice-skip-back")!;
      const fwd = root.querySelector<HTMLButtonElement>(".wx-srv-voice-skip-forward")!;
      const bar = root.querySelector<HTMLElement>(".wx-srv-voice-seek-tab")!;
      const scrub = root.querySelector<HTMLElement>(".wx-srv-voice-scrub")!;
      return { audio, back, fwd, bar, scrub };
    }
    const press = (el: HTMLElement) => el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    const lift = (el: HTMLElement) => el.dispatchEvent(new Event("pointerup", { bubbles: true }));

    it("a tap jumps 10 seconds back or forward", () => {
      const { audio, back, fwd } = setup();
      press(fwd);
      lift(fwd);
      expect(audio.currentTime).toBe(60);
      press(back);
      lift(back);
      press(back);
      lift(back);
      expect(audio.currentTime).toBe(40);
      vi.useRealTimers();
    });

    it("holding scrubs at 2.5x and does not also jump on release", () => {
      const { audio, fwd, back } = setup();
      press(fwd);
      vi.advanceTimersByTime(350 + 1000);
      lift(fwd);
      expect(audio.currentTime).toBeGreaterThan(50 + 2.0);
      expect(audio.currentTime).toBeLessThan(50 + 3.5);
      const after = audio.currentTime;
      press(back);
      vi.advanceTimersByTime(350 + 1000);
      lift(back);
      expect(audio.currentTime).toBeLessThan(after - 2.0);
      expect(audio.currentTime).toBeGreaterThan(after - 3.5);
      vi.useRealTimers();
    });

    it("the line follows playback and dragging the tab seeks", () => {
      const { audio, bar, scrub } = setup();
      audio.dispatchEvent(new Event("timeupdate"));
      expect(bar.getAttribute("aria-valuenow")).toBe("50");
      expect(Number(scrub.style.getPropertyValue("--wx-srv-seek"))).toBeCloseTo(50 / 120);
      scrub.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
      bar.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
      const move = new Event("pointermove", { bubbles: true });
      Object.defineProperty(move, "clientX", { value: 100 });
      bar.dispatchEvent(move);
      expect(audio.currentTime).toBe(60);
      bar.dispatchEvent(new Event("pointerup", { bubbles: true }));
      const later = new Event("pointermove", { bubbles: true });
      Object.defineProperty(later, "clientX", { value: 200 });
      bar.dispatchEvent(later);
      expect(audio.currentTime).toBe(60);
      vi.useRealTimers();
    });
  });

  describe("voice-note transcription control", () => {
    const transcription = {
      available: () => true,
      request: vi.fn(),
      markUnavailable: vi.fn(),
      isHidden: () => false,
      setHidden: vi.fn(),
    };
    const voiceNote: Attachment = {
      ...base,
      id: "v".repeat(32),
      kind: "voice",
      durationS: 3,
      peaks: [0.5],
      urls: { play: "/voice" },
    };

    it("adds a transcript block beneath each ready voice note when a context is supplied", () => {
      const root = renderAttachments([voiceNote], { ...context(), transcription });
      expect(Array.from(root.children).map((child) => child.className)).toEqual([
        "wx-srv-voice",
        "wx-srv-transcript",
      ]);
      expect(root.querySelector<HTMLElement>(".wx-srv-transcript")?.dataset["attachmentId"]).toBe(voiceNote.id);
    });

    it("renders no block without a context (older callers are unchanged)", () => {
      const root = renderAttachments([voiceNote], context());
      expect(root.querySelector(".wx-srv-transcript")).toBeNull();
    });

    it("never adds one for photos, video, or a voice note that is not ready", () => {
      const root = renderAttachments(
        [
          base,
          { ...base, id: "v2", kind: "video", urls: { play: "/video" } },
          { ...voiceNote, id: "v3", status: "processing" },
          { ...voiceNote, id: "v4", status: "failed" },
        ],
        { ...context(), transcription },
      );
      expect(root.querySelector(".wx-srv-transcript")).toBeNull();
    });

    it("seeds the block from the transcript the server sent", () => {
      const root = renderAttachments(
        [{ ...voiceNote, transcript: { status: "done", text: "seeded text" } }],
        { ...context(), transcription },
      );
      expect(root.querySelector(".wx-srv-transcript-text")?.textContent).toBe("seeded text");
    });
  });
});
