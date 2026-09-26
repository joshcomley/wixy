import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeSpotlightCoords,
  computeSpotlightRadius,
  generateClaimId,
  mountViewOnceViewer,
  RING_CIRCUMFERENCE,
  SPOTLIGHT_CYCLE_MS,
  SPOTLIGHT_DRAG_RESUME_DELAY_MS,
  SPOTLIGHT_EASE_DURATION_MS,
} from "../../src/server/viewOnceViewer";
import type { LockHooks, ServerSession } from "../../src/server/types";
import type { ServerIdentity } from "../../src/server/identity";
import { mountServerThread } from "../../src/server/thread";
import type { Message } from "../../src/server/api/messages";

const SESSION: ServerSession = { token: "tok-test", expiresAt: 9_999_999_999 };

function createMockHooks(): {
  hooks: LockHooks;
  suspended: Set<string>;
  releases: Record<string, number>;
  lockCauses: string[];
} {
  const suspended = new Set<string>();
  const releases: Record<string, number> = {};
  const lockCauses: string[] = [];

  const hooks: LockHooks = {
    suspend: (reason) => {
      suspended.add(reason);
      return () => {
        suspended.delete(reason);
        releases[reason] = (releases[reason] || 0) + 1;
      };
    },
    lockNow: (cause) => {
      lockCauses.push(cause);
    },
    adoptBoundSession: vi.fn(),
    getBoundGrantId: vi.fn(() => null),
  };

  return { hooks, suspended, releases, lockCauses };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function fakeIdentity(name = "Josh"): ServerIdentity {
  return {
    getName: () => name,
    setName: vi.fn(),
    getDeviceId: () => "dev-1",
    isMine: (sender: string) => name !== null && sender.toLowerCase() === name.toLowerCase(),
  };
}

describe("Server Chat View-Once & Spotlight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("Claim ID generation", () => {
    it("generates a 32-character lowercase hex string", () => {
      const claimId = generateClaimId(window);
      expect(claimId).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe("Closing triggers & lifecycle", () => {
    it("closes on ✕ button click", async () => {
      const { hooks } = createMockHooks();
      const onClose = vi.fn();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 101,
        hooks,
        identity: fakeIdentity(),
        win: window,
        onClose,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, spotlight: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      const closeBtn = viewer.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-close")!;
      expect(closeBtn).toBeTruthy();

      closeBtn.click();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.body.contains(viewer.element)).toBe(false);
    });

    it("closes on Escape key and triggers lockNow('escape')", async () => {
      const { hooks, lockCauses } = createMockHooks();
      const onClose = vi.fn();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 102,
        hooks,
        identity: fakeIdentity(),
        win: window,
        onClose,
        openClaim: async () => ({
          ok: true,
          data: { durationS: null, spotlight: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(lockCauses).toContain("escape");
      expect(document.body.contains(viewer.element)).toBe(false);
    });

    it("closes on visibilitychange -> hidden", async () => {
      const { hooks } = createMockHooks();
      const onClose = vi.fn();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 103,
        hooks,
        identity: fakeIdentity(),
        win: window,
        onClose,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 30, spotlight: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.body.contains(viewer.element)).toBe(false);
    });

    it("closes when the timer expires", async () => {
      const { hooks, suspended } = createMockHooks();
      const onClose = vi.fn();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 104,
        hooks,
        identity: fakeIdentity(),
        win: window,
        onClose,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 2, spotlight: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();
      await vi.advanceTimersByTimeAsync(50);

      expect(suspended.has("viewOnce")).toBe(true);

      // Advance past 2s
      await vi.advanceTimersByTimeAsync(2100);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(suspended.has("viewOnce")).toBe(false);
      expect(document.body.contains(viewer.element)).toBe(false);
    });
  });

  describe("Resource release on close", () => {
    it("releases ImageBitmap, canvas, and DOM references", async () => {
      const { hooks } = createMockHooks();
      const bitmapClose = vi.fn();
      const mockBitmap = {
        width: 800,
        height: 600,
        close: bitmapClose,
      } as unknown as ImageBitmap;

      const origCreateImageBitmap = window.createImageBitmap;
      window.createImageBitmap = vi.fn(async () => mockBitmap);

      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 105,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, spotlight: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();
      await vi.advanceTimersByTimeAsync(10);

      viewer.close();

      expect(bitmapClose).toHaveBeenCalledTimes(1);
      expect(document.body.contains(viewer.element)).toBe(false);

      window.createImageBitmap = origCreateImageBitmap;
    });

    it("releases video Object URL and pauses video element", async () => {
      const { hooks } = createMockHooks();
      const revokeSpy = vi.fn();
      const urlApi = {
        createObjectURL: vi.fn(() => "blob:test-video-1"),
        revokeObjectURL: revokeSpy,
      };
      (window as unknown as { URL: typeof urlApi }).URL = urlApi;

      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 106,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, spotlight: false, kind: "video", mime: "video/mp4" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["video-bytes"], { type: "video/mp4" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();
      await vi.advanceTimersByTimeAsync(10);

      const video = viewer.element.querySelector<HTMLVideoElement>("video");
      expect(video).toBeTruthy();
      expect(video?.getAttribute("playsinline")).toBe("true");
      expect(video?.getAttribute("disablepictureinpicture")).toBe("true");

      viewer.close();

      expect(revokeSpy).toHaveBeenCalledWith("blob:test-video-1");
      expect(video?.getAttribute("src")).toBeNull();
    });
  });

  describe("Idle lock suspension (Inv 43 / R7)", () => {
    it("holds viewOnce suspension only for timed views (2s/5s/30s) and releases on close", async () => {
      const { hooks, suspended, releases } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 107,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, spotlight: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();
      await vi.advanceTimersByTimeAsync(10);

      expect(suspended.has("viewOnce")).toBe(true);

      viewer.close();
      expect(suspended.has("viewOnce")).toBe(false);
      expect(releases["viewOnce"]).toBe(1);
    });

    it("holds NO suspension for no-limit photo (durationS: null)", async () => {
      const { hooks, suspended } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 108,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: null, spotlight: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();
      await vi.advanceTimersByTimeAsync(10);

      expect(suspended.has("viewOnce")).toBe(false);
      viewer.close();
    });

    it("holds mediaPlaying suspension when video starts playing", async () => {
      const { hooks, suspended, releases } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 109,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, spotlight: false, kind: "video", mime: "video/mp4" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["video"], { type: "video/mp4" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();
      await vi.advanceTimersByTimeAsync(10);

      const video = viewer.element.querySelector("video")!;
      video.dispatchEvent(new Event("play"));

      expect(suspended.has("viewOnce")).toBe(true);
      expect(suspended.has("mediaPlaying")).toBe(true);

      viewer.close();
      expect(suspended.has("viewOnce")).toBe(false);
      expect(suspended.has("mediaPlaying")).toBe(false);
      expect(releases["viewOnce"]).toBe(1);
      expect(releases["mediaPlaying"]).toBe(1);
    });
  });

  describe("Spotlight calculations & interaction guarantees", () => {
    it("calculates radius from slider percentage bounded between 6% and 35%", () => {
      const minSide = 500;
      expect(computeSpotlightRadius(6, minSide)).toBe(30);
      expect(computeSpotlightRadius(12, minSide)).toBe(60);
      expect(computeSpotlightRadius(35, minSide)).toBe(175);
    });

    it("follows a deterministic Lissajous path under fake time", () => {
      const cx = 400;
      const cy = 300;
      const Ax = 200;
      const Ay = 150;
      const radius = 50;
      const baseParams = {
        cx,
        cy,
        Ax,
        Ay,
        drawX: 100,
        drawY: 50,
        drawW: 600,
        drawH: 500,
        radius,
        prefersReducedMotion: false,
        isDragging: false,
      };

      // At t=0 ms (theta = 0)
      // autoX = cx + Ax * sin(pi/2) = cx + Ax
      // autoY = cy + Ay * sin(0) = cy
      const p0 = computeSpotlightCoords({ ...baseParams, elapsedMs: 0 });
      expect(p0.x).toBeCloseTo(cx + Ax);
      expect(p0.y).toBeCloseTo(cy);

      // At t=4000 ms (1/4 of 16000ms cycle: theta = pi/2)
      // autoX = cx + Ax * sin(3pi/2 + pi/2) = cx + Ax * sin(2pi) = cx
      // autoY = cy + Ay * sin(pi) = cy
      const p4k = computeSpotlightCoords({ ...baseParams, elapsedMs: 4000 });
      expect(p4k.x).toBeCloseTo(cx);
      expect(p4k.y).toBeCloseTo(cy);

      // At t=8000 ms (theta = pi)
      // autoX = cx + Ax * sin(3pi + pi/2) = cx + Ax * sin(7pi/2) = cx - Ax
      // autoY = cy + Ay * sin(2pi) = cy
      const p8k = computeSpotlightCoords({ ...baseParams, elapsedMs: 8000 });
      expect(p8k.x).toBeCloseTo(cx - Ax);
      expect(p8k.y).toBeCloseTo(cy);

      // At t=16000 ms (full cycle: theta = 2pi -> identical to t=0)
      const p16k = computeSpotlightCoords({ ...baseParams, elapsedMs: 16000 });
      expect(p16k.x).toBeCloseTo(p0.x);
      expect(p16k.y).toBeCloseTo(p0.y);
    });

    it("keeps automatic movement strictly clamped within the drawn image", () => {
      const drawX = 50;
      const drawY = 20;
      const drawW = 500;
      const drawH = 360;
      const cx = drawX + drawW / 2;
      const cy = drawY + drawH / 2;
      const radius = 50;
      const Ax = drawW / 2 - radius;
      const Ay = drawH / 2 - radius;

      for (let t = 0; t <= SPOTLIGHT_CYCLE_MS; t += 250) {
        const p = computeSpotlightCoords({
          cx,
          cy,
          Ax,
          Ay,
          drawX,
          drawY,
          drawW,
          drawH,
          radius,
          elapsedMs: t,
          prefersReducedMotion: false,
          isDragging: false,
        });

        expect(p.x).toBeGreaterThanOrEqual(drawX + radius - 0.01);
        expect(p.x).toBeLessThanOrEqual(drawX + drawW - radius + 0.01);
        expect(p.y).toBeGreaterThanOrEqual(drawY + radius - 0.01);
        expect(p.y).toBeLessThanOrEqual(drawY + drawH - radius + 0.01);
      }
    });

    it("gives a static centered cut-out when prefersReducedMotion is true", () => {
      const cx = 400;
      const cy = 300;
      const params = {
        cx,
        cy,
        Ax: 150,
        Ay: 100,
        drawX: 200,
        drawY: 150,
        drawW: 400,
        drawH: 300,
        radius: 40,
        prefersReducedMotion: true,
        isDragging: false,
      };

      for (let t = 0; t <= 16000; t += 1000) {
        const p = computeSpotlightCoords({ ...params, elapsedMs: t });
        expect(p.x).toBe(cx);
        expect(p.y).toBe(cy);
      }
    });

    it("drags cut-out clamped under pointer and pauses automatic path", () => {
      const cx = 400;
      const cy = 300;
      const drawX = 100;
      const drawY = 100;
      const drawW = 600;
      const drawH = 400;
      const radius = 50;

      // Drag to a valid inside point
      const pInside = computeSpotlightCoords({
        cx,
        cy,
        Ax: 200,
        Ay: 150,
        drawX,
        drawY,
        drawW,
        drawH,
        radius,
        elapsedMs: 3000,
        prefersReducedMotion: false,
        isDragging: true,
        dragX: 250,
        dragY: 220,
      });
      expect(pInside.x).toBe(250);
      expect(pInside.y).toBe(220);

      // Drag outside the image bounds clamps to edge - radius
      const pOutside = computeSpotlightCoords({
        cx,
        cy,
        Ax: 200,
        Ay: 150,
        drawX,
        drawY,
        drawW,
        drawH,
        radius,
        elapsedMs: 3000,
        prefersReducedMotion: false,
        isDragging: true,
        dragX: 5,
        dragY: 999,
      });
      expect(pOutside.x).toBe(drawX + radius);
      expect(pOutside.y).toBe(drawY + drawH - radius);
    });

    it("pauses for 1.5s after drag release, then eases over 600ms back to path without a jump", () => {
      const cx = 400;
      const cy = 300;
      const Ax = 200;
      const Ay = 150;
      const drawX = 100;
      const drawY = 100;
      const drawW = 600;
      const drawH = 400;
      const radius = 50;

      const dragReleaseTime = 10_000;
      const dragReleaseX = 250;
      const dragReleaseY = 200;

      // During 1.5s pause (e.g. 500ms after release at now = 10500)
      const pPaused = computeSpotlightCoords({
        cx,
        cy,
        Ax,
        Ay,
        drawX,
        drawY,
        drawW,
        drawH,
        radius,
        elapsedMs: 5000,
        prefersReducedMotion: false,
        isDragging: false,
        dragReleaseTime,
        dragReleaseX,
        dragReleaseY,
        now: 10_500,
      });
      expect(pPaused.x).toBe(dragReleaseX);
      expect(pPaused.y).toBe(dragReleaseY);

      // Exactly at pause end (now = 11500, dt = 1500)
      const pEaseStart = computeSpotlightCoords({
        cx,
        cy,
        Ax,
        Ay,
        drawX,
        drawY,
        drawW,
        drawH,
        radius,
        elapsedMs: 5000,
        prefersReducedMotion: false,
        isDragging: false,
        dragReleaseTime,
        dragReleaseX,
        dragReleaseY,
        now: 11_500,
      });
      expect(pEaseStart.x).toBeCloseTo(dragReleaseX);
      expect(pEaseStart.y).toBeCloseTo(dragReleaseY);

      // Halfway through easing (dt = 1800 -> 300ms of 600ms easing)
      const pMid = computeSpotlightCoords({
        cx,
        cy,
        Ax,
        Ay,
        drawX,
        drawY,
        drawW,
        drawH,
        radius,
        elapsedMs: 5000,
        prefersReducedMotion: false,
        isDragging: false,
        dragReleaseTime,
        dragReleaseX,
        dragReleaseY,
        now: 11_800,
      });
      const autoPath5k = computeSpotlightCoords({
        cx,
        cy,
        Ax,
        Ay,
        drawX,
        drawY,
        drawW,
        drawH,
        radius,
        elapsedMs: 5000,
        prefersReducedMotion: false,
        isDragging: false,
      });
      // Cosine ease at halfway (0.5 - 0.5 * cos(pi/2) = 0.5) is exact midpoint
      expect(pMid.x).toBeCloseTo((dragReleaseX + autoPath5k.x) / 2);
      expect(pMid.y).toBeCloseTo((dragReleaseY + autoPath5k.y) / 2);

      // At end of easing (dt = 2100 -> 600ms easing complete)
      const pEaseEnd = computeSpotlightCoords({
        cx,
        cy,
        Ax,
        Ay,
        drawX,
        drawY,
        drawW,
        drawH,
        radius,
        elapsedMs: 5000,
        prefersReducedMotion: false,
        isDragging: false,
        dragReleaseTime,
        dragReleaseX,
        dragReleaseY,
        now: 12_100,
      });
      expect(pEaseEnd.x).toBeCloseTo(autoPath5k.x);
      expect(pEaseEnd.y).toBeCloseTo(autoPath5k.y);
    });
  });

  describe("API error handling in viewer", () => {
    it("displays 'Already opened' on 409", async () => {
      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 110,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: false,
          kind: "already_opened",
          status: 409,
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const statusEl = viewer.element.querySelector(".wx-srv-view-once-status");
      expect(statusEl?.textContent).toBe("Already opened");
      viewer.close();
    });

    it("displays 'No longer available' on 404/410", async () => {
      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 111,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: false,
          kind: "not_found",
          status: 404,
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const statusEl = viewer.element.querySelector(".wx-srv-view-once-status");
      expect(statusEl?.textContent).toBe("No longer available");
      viewer.close();
    });

    it("displays 'Cannot open your own view-once message' on 403 own_message", async () => {
      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 112,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: false,
          kind: "own_message",
          status: 403,
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const statusEl = viewer.element.querySelector(".wx-srv-view-once-status");
      expect(statusEl?.textContent).toBe("Cannot open your own view-once message");
      viewer.close();
    });

    it("retries fetching content on network error until successful", async () => {
      const { hooks } = createMockHooks();
      let attempts = 0;
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 113,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, spotlight: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => {
          attempts++;
          if (attempts === 1) {
            return { ok: false, kind: "unavailable" };
          }
          return { ok: true, blob: new Blob(["photo"], { type: "image/jpeg" }) };
        },
      });

      document.body.appendChild(viewer.element);
      await flush();

      const statusEl = viewer.element.querySelector<HTMLElement>(".wx-srv-view-once-status");
      expect(statusEl?.textContent).toBe("Connection issue, retrying…");

      // Advance retry timeout
      await vi.advanceTimersByTimeAsync(1100);
      await flush();

      expect(attempts).toBe(2);
      expect(statusEl?.hidden).toBe(true);
      viewer.close();
    });
  });

  describe("Spotlight UI component interactions", () => {
    it("renders slider and canvas, responding to range input and pointer events", async () => {
      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 114,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, spotlight: true, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const canvas = viewer.element.querySelector<HTMLCanvasElement>("canvas");
      expect(canvas).toBeTruthy();

      const slider = viewer.element.querySelector<HTMLInputElement>(".wx-srv-view-once-slider");
      expect(slider).toBeTruthy();
      expect(slider?.min).toBe("6");
      expect(slider?.max).toBe("35");
      expect(slider?.value).toBe("12");
      expect(slider?.getAttribute("aria-label")).toBe("Spotlight size");

      // User moves slider
      slider!.value = "25";
      slider!.dispatchEvent(new Event("input"));

      // Pointer interactions on canvas
      canvas!.dispatchEvent(new PointerEvent("pointerdown", { clientX: 100, clientY: 100 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, clientY: 130 }));
      window.dispatchEvent(new PointerEvent("pointerup"));

      viewer.close();
    });

    it("renders Play button when video.play() promise rejects", async () => {
      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 115,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, spotlight: false, kind: "video", mime: "video/mp4" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["video"], { type: "video/mp4" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const video = viewer.element.querySelector("video");
      expect(video).toBeTruthy();

      // In JSDOM HTMLMediaElement.play returns undefined or rejects, triggering the play button
      const playBtn = viewer.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-play-btn");
      if (playBtn) {
        expect(playBtn.textContent).toContain("Play");
        playBtn.click();
      }

      viewer.close();
    });
  });
});
