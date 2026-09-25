import { describe, expect, it, vi } from "vitest";
import {
  disposeAttachmentMedia,
  renderAttachment,
  renderAttachments,
  type Attachment,
} from "../src/server/mediaRender";

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
