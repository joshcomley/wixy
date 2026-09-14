import { describe, expect, it, vi } from "vitest";
import { renderAttachment, renderAttachments, type Attachment } from "../src/server/mediaRender";

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
    root.querySelector<HTMLButtonElement>("button")?.click();
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
});
