import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeTeaseCoords,
  computeTeaseRadius,
  generateClaimId,
  mountViewOnceViewer,
  RING_CIRCUMFERENCE,
  TEASE_CYCLE_MS,
  TEASE_DRAG_RESUME_DELAY_MS,
  TEASE_EASE_DURATION_MS,
} from "../../src/server/viewOnceViewer";
import type { LockHooks, ServerSession } from "../../src/server/types";
import type { ServerIdentity } from "../../src/server/identity";
import { mountServerThread } from "../../src/server/thread";
import type { Message } from "../../src/server/api/messages";
import { ServerLockedError } from "../../src/server/api/http";

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

describe("Server Chat View-Once & Tease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.createImageBitmap = vi.fn(async () => ({
      width: 400,
      height: 300,
      close: vi.fn(),
    } as unknown as ImageBitmap));
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

    it("generateClaimId throws when crypto.getRandomValues is missing", () => {
      expect(() => generateClaimId({ crypto: {} } as unknown as Window)).toThrow();
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
          data: { durationS: 5, tease: false, kind: "photo", mime: "image/jpeg" },
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
          data: { durationS: null, tease: false, kind: "photo", mime: "image/jpeg" },
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
          data: { durationS: 30, tease: false, kind: "photo", mime: "image/jpeg" },
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
          data: { durationS: 2, tease: false, kind: "photo", mime: "image/jpeg" },
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
          data: { durationS: 5, tease: false, kind: "photo", mime: "image/jpeg" },
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
          data: { durationS: 5, tease: false, kind: "video", mime: "video/mp4" },
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
          data: { durationS: 5, tease: false, kind: "photo", mime: "image/jpeg" },
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
          data: { durationS: null, tease: false, kind: "photo", mime: "image/jpeg" },
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
          data: { durationS: 5, tease: false, kind: "video", mime: "video/mp4" },
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
      video.dispatchEvent(new Event("playing"));

      expect(suspended.has("viewOnce")).toBe(true);
      expect(suspended.has("mediaPlaying")).toBe(true);

      viewer.close();
      expect(suspended.has("viewOnce")).toBe(false);
      expect(suspended.has("mediaPlaying")).toBe(false);
      expect(releases["viewOnce"]).toBe(1);
      expect(releases["mediaPlaying"]).toBe(1);
    });

    it("video timer does not start merely because play() was called, but on first frame callback or playing event", async () => {
      const { hooks, suspended } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 110,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: false, kind: "video", mime: "video/mp4" },
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
      const countdown = viewer.element.querySelector(".wx-srv-view-once-countdown")!;

      // Dispatch 'play' (playback requested)
      video.dispatchEvent(new Event("play"));

      // mediaPlaying is suspended, but timer has NOT started yet
      expect(suspended.has("mediaPlaying")).toBe(true);
      expect(suspended.has("viewOnce")).toBe(false);
      expect(countdown.textContent).toBe("");

      // Dispatch 'playing' (playback actually started / first frame rendered)
      video.dispatchEvent(new Event("playing"));

      expect(suspended.has("viewOnce")).toBe(true);
      expect(countdown.textContent).toBe("5");

      viewer.close();
    });

    it("F10: video timer does not start when requestVideoFrameCallback fires while video is paused (preroll)", async () => {
      const { hooks, suspended } = createMockHooks();
      let rfcCallback: ((now: number, metadata: unknown) => void) | null = null;
      const originalRfc = (HTMLVideoElement.prototype as any).requestVideoFrameCallback;
      const originalCancel = (HTMLVideoElement.prototype as any).cancelVideoFrameCallback;
      (HTMLVideoElement.prototype as any).requestVideoFrameCallback = vi.fn((cb) => {
        rfcCallback = cb;
        return 123;
      });
      (HTMLVideoElement.prototype as any).cancelVideoFrameCallback = vi.fn();

      try {
        const viewer = mountViewOnceViewer({
          session: () => SESSION,
          seq: 111,
          hooks,
          identity: fakeIdentity(),
          win: window,
          openClaim: async () => ({
            ok: true,
            data: { durationS: 5, tease: false, kind: "video", mime: "video/mp4" },
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
        const countdown = viewer.element.querySelector(".wx-srv-view-once-countdown")!;

        expect(rfcCallback).not.toBeNull();
        // Simulate preroll frame while video is paused
        Object.defineProperty(video, "paused", { value: true, configurable: true });
        rfcCallback!(100, {});

        // Timer and viewOnce suspension must NOT have started!
        expect(suspended.has("viewOnce")).toBe(false);
        expect(countdown.textContent).toBe("");

        // Now simulate video starting to play
        Object.defineProperty(video, "paused", { value: false, configurable: true });
        video.dispatchEvent(new Event("playing"));

        // Timer and viewOnce suspension should now start
        expect(suspended.has("viewOnce")).toBe(true);
        expect(countdown.textContent).toBe("5");

        viewer.close();
      } finally {
        (HTMLVideoElement.prototype as any).requestVideoFrameCallback = originalRfc;
        (HTMLVideoElement.prototype as any).cancelVideoFrameCallback = originalCancel;
      }
    });
  });

  describe("Tease calculations & interaction guarantees", () => {
    it("calculates radius from slider percentage bounded between 6% and 35%", () => {
      const minSide = 500;
      expect(computeTeaseRadius(6, minSide)).toBe(30);
      expect(computeTeaseRadius(12, minSide)).toBe(60);
      expect(computeTeaseRadius(35, minSide)).toBe(175);
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
      const p0 = computeTeaseCoords({ ...baseParams, elapsedMs: 0 });
      expect(p0.x).toBeCloseTo(cx + Ax);
      expect(p0.y).toBeCloseTo(cy);

      // At t=4000 ms (1/4 of 16000ms cycle: theta = pi/2)
      // autoX = cx + Ax * sin(3pi/2 + pi/2) = cx + Ax * sin(2pi) = cx
      // autoY = cy + Ay * sin(pi) = cy
      const p4k = computeTeaseCoords({ ...baseParams, elapsedMs: 4000 });
      expect(p4k.x).toBeCloseTo(cx);
      expect(p4k.y).toBeCloseTo(cy);

      // At t=8000 ms (theta = pi)
      // autoX = cx + Ax * sin(3pi + pi/2) = cx + Ax * sin(7pi/2) = cx - Ax
      // autoY = cy + Ay * sin(2pi) = cy
      const p8k = computeTeaseCoords({ ...baseParams, elapsedMs: 8000 });
      expect(p8k.x).toBeCloseTo(cx - Ax);
      expect(p8k.y).toBeCloseTo(cy);

      // At t=16000 ms (full cycle: theta = 2pi -> identical to t=0)
      const p16k = computeTeaseCoords({ ...baseParams, elapsedMs: 16000 });
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

      for (let t = 0; t <= TEASE_CYCLE_MS; t += 250) {
        const p = computeTeaseCoords({
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
        const p = computeTeaseCoords({ ...params, elapsedMs: t });
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
      const pInside = computeTeaseCoords({
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
      const pOutside = computeTeaseCoords({
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
      const pPaused = computeTeaseCoords({
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
      const pEaseStart = computeTeaseCoords({
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
      const pMid = computeTeaseCoords({
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
      const autoPath5k = computeTeaseCoords({
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
      const pEaseEnd = computeTeaseCoords({
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
          data: { durationS: 5, tease: false, kind: "photo", mime: "image/jpeg" },
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

    it("displays 'Couldn't show this photo.' when image decoding fails", async () => {
      const { hooks } = createMockHooks();
      window.createImageBitmap = vi.fn(async () => {
        throw new Error("corrupt image");
      });
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 116,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["corrupt-data"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const statusEl = viewer.element.querySelector(".wx-srv-view-once-status");
      expect(statusEl?.textContent).toBe("Couldn't show this photo.");
      viewer.close();
    });
  });

  describe("Tease UI component interactions", () => {
    it("renders slider and canvas, responding to range input and pointer events", async () => {
      const arcCalls: Array<{ x: number; y: number; radius: number }> = [];
      const stubCtx = {
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        arc: vi.fn((x: number, y: number, radius: number) => {
          arcCalls.push({ x, y, radius });
        }),
        closePath: vi.fn(),
        fill: vi.fn(),
        createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        clearRect: vi.fn(),
      };
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = vi.fn(() => stubCtx) as any;

      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 114,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: true, kind: "photo", mime: "image/jpeg" },
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
      canvas!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);

      const slider = viewer.element.querySelector<HTMLInputElement>(".wx-srv-view-once-slider");
      expect(slider).toBeTruthy();
      expect(slider?.min).toBe("6");
      expect(slider?.max).toBe("35");
      expect(slider?.value).toBe("12");
      expect(slider?.getAttribute("aria-label")).toBe("Tease size");

      expect(arcCalls.length).toBeGreaterThan(0);
      const initialRadius = arcCalls[0]!.radius;

      // User moves slider
      slider!.value = "25";
      slider!.dispatchEvent(new Event("input"));
      expect(slider?.value).toBe("25");

      const afterSliderRadius = arcCalls[arcCalls.length - 1]!.radius;
      expect(afterSliderRadius).toBeGreaterThan(initialRadius);

      // Pointer interactions on canvas
      canvas!.dispatchEvent(new PointerEvent("pointerdown", { clientX: 400, clientY: 300 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 420, clientY: 320 }));
      const afterMove = arcCalls[arcCalls.length - 1]!;
      expect(afterMove.x).toBe(420);
      expect(afterMove.y).toBe(320);
      window.dispatchEvent(new PointerEvent("pointerup"));

      HTMLCanvasElement.prototype.getContext = origGetContext;
      viewer.close();
    });

    it("renders Play button when video.play() promise rejects", async () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockRejectedValue(new Error("NotAllowedError"));
      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 115,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: false, kind: "video", mime: "video/mp4" },
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

      const playBtn = viewer.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-play-btn");
      expect(playBtn).toBeTruthy();
      expect(playBtn!.textContent).toContain("Play");
      playBtn!.click();

      playSpy.mockRestore();
      viewer.close();
    });
  });

  describe("Network failure during content download (Item 1)", () => {
    it("retries with the same claimId when blob() rejects once then succeeds", async () => {
      const { hooks } = createMockHooks();
      const openClaimSpy = vi.fn(async () => ({
        ok: true as const,
        data: { durationS: 5 as const, tease: false, kind: "photo" as const, mime: "image/jpeg" },
      }));

      let fetchCount = 0;
      const seenClaimIds: string[] = [];
      const origFetch = window.fetch;
      window.fetch = vi.fn(async (_url, init) => {
        const claimHeader = ((init?.headers as Record<string, string>)?.[
          "X-Wixy-View-Claim"
        ] ?? (init?.headers as Headers)?.get?.("X-Wixy-View-Claim")) as string;
        seenClaimIds.push(claimHeader);
        fetchCount++;
        if (fetchCount === 1) {
          return {
            status: 200,
            blob: async () => {
              throw new Error("mid-body stream disconnect");
            },
          } as unknown as Response;
        }
        return {
          status: 200,
          blob: async () => new Blob(["photo-data"], { type: "image/jpeg" }),
        } as unknown as Response;
      });

      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 201,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: openClaimSpy,
      });

      document.body.appendChild(viewer.element);
      await flush();
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      await vi.advanceTimersByTimeAsync(10);

      expect(fetchCount).toBe(2);
      expect(seenClaimIds[0]).toBeDefined();
      expect(seenClaimIds[1]).toBe(seenClaimIds[0]);

      window.fetch = origFetch;
      viewer.close();
    });

    it("shows error state when blob() always rejects without unhandled rejection", async () => {
      const { hooks } = createMockHooks();
      const origFetch = window.fetch;
      window.fetch = vi.fn(async () => {
        return {
          status: 200,
          blob: async () => {
            throw new Error("permanent disconnect");
          },
        } as unknown as Response;
      });

      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 202,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true as const,
          data: { durationS: 5, tease: false, kind: "photo" as const, mime: "image/jpeg" },
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();
      for (let i = 0; i < 35; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        await flush();
      }

      const statusEl = viewer.element.querySelector(".wx-srv-view-once-status");
      expect(statusEl?.textContent).toBe("Couldn't open this message.");
      const closeBtn = viewer.element.querySelector<HTMLButtonElement>(".wx-srv-view-once-close");
      expect(closeBtn).toBeTruthy();

      window.fetch = origFetch;
      viewer.close();
    });
  });

  describe("Claim retry on network failure (Item 7)", () => {
    it("retries claim with the same claimId when first call returns unavailable or rejects, then succeeds and fetches content", async () => {
      const { hooks } = createMockHooks();
      let claimAttempts = 0;
      const seenClaimIds: string[] = [];
      const fetchContentSpy = vi.fn(async () => ({
        ok: true as const,
        blob: new Blob(["photo-data"], { type: "image/jpeg" }),
      }));

      const openClaimSpy = vi.fn(async (_s: unknown, _seq: number, input: { claimId: string; sender: string }) => {
        seenClaimIds.push(input.claimId);
        claimAttempts++;
        if (claimAttempts === 1) {
          return { ok: false as const, kind: "unavailable" as const };
        }
        return {
          ok: true as const,
          data: { durationS: 5 as const, tease: false, kind: "photo" as const, mime: "image/jpeg" },
        };
      });

      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 301,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: openClaimSpy,
        fetchContent: fetchContentSpy,
      });

      document.body.appendChild(viewer.element);
      await flush();
      expect(claimAttempts).toBe(1);
      // Advance by retry delay
      await vi.advanceTimersByTimeAsync(1000);
      await flush();

      expect(claimAttempts).toBe(2);
      expect(seenClaimIds[0]).toBeDefined();
      expect(seenClaimIds[1]).toBe(seenClaimIds[0]);
      expect(fetchContentSpy).toHaveBeenCalledTimes(1);

      viewer.close();
    });
  });

  describe("Opening it uses it up notice (Item 8)", () => {
    it("keeps 'Opening it uses it up.' visible in the viewer's Loading state", async () => {
      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 401,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: () => new Promise(() => {}),
      });

      document.body.appendChild(viewer.element);
      const statusEl = viewer.element.querySelector(".wx-srv-view-once-status");
      expect(statusEl?.textContent).toContain("Opening it uses it up.");
      viewer.close();
    });
  });

  describe("Tease integrated viewer tests (Item 9)", () => {
    let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
    let stubCtx: any;
    let arcCalls: Array<{ x: number; y: number; radius: number }>;

    beforeEach(() => {
      arcCalls = [];
      stubCtx = {
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        arc: vi.fn((x: number, y: number, radius: number) => {
          arcCalls.push({ x, y, radius });
        }),
        closePath: vi.fn(),
        fill: vi.fn(),
        createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        clearRect: vi.fn(),
      };
      origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = vi.fn(() => stubCtx) as any;
    });

    afterEach(() => {
      HTMLCanvasElement.prototype.getContext = origGetContext;
    });

    it("(a) release far outside the image keeps the clamped position instead of jumping off-screen", async () => {
      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 501,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: null, tease: true, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const canvas = viewer.element.querySelector<HTMLCanvasElement>("canvas")!;
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);

      // Drag to far outside
      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: 5000, clientY: 5000 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 5000, clientY: 5000 }));

      const lastArc = arcCalls[arcCalls.length - 1];
      expect(lastArc).toBeDefined();
      expect(lastArc!.x).toBeLessThanOrEqual(canvas.width);
      expect(lastArc!.y).toBeLessThanOrEqual(canvas.height);
      expect(lastArc!.x).toBeLessThan(1000);
      expect(lastArc!.y).toBeLessThan(1000);

      viewer.close();
    });

    it("(b) first painted frame is at phase 0 deterministically", async () => {
      const { hooks } = createMockHooks();
      await vi.advanceTimersByTimeAsync(50_000);

      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 502,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: true, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const canvas = viewer.element.querySelector<HTMLCanvasElement>("canvas")!;
      expect(arcCalls.length).toBeGreaterThan(0);
      const firstArc = arcCalls[0]!;
      const expectedCy = canvas.height / 2;
      const minSide = Math.min(canvas.width, canvas.height);
      const expectedRadius = computeTeaseRadius(12, minSide);
      const expectedCx = canvas.width / 2;
      const expectedAx = expectedCx - expectedRadius;
      const expectedX = expectedCx + expectedAx;

      expect(firstArc.y).toBeCloseTo(expectedCy);
      expect(firstArc.x).toBeCloseTo(expectedX);

      viewer.close();
    });

    it("(c) in reduced motion, dragging then releasing stays put (does not snap to center)", async () => {
      const { hooks } = createMockHooks();
      const origMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as any;

      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 503,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: true, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const canvas = viewer.element.querySelector<HTMLCanvasElement>("canvas")!;
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);

      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: 250, clientY: 220 }));
      window.dispatchEvent(new PointerEvent("pointerup"));

      const lastArc = arcCalls[arcCalls.length - 1]!;
      expect(lastArc.x).toBe(250);
      expect(lastArc.y).toBe(220);

      window.matchMedia = origMatchMedia;
      viewer.close();
    });

    it("in reduced motion, first drawn arc is centred at (cx, cy) before any drag", async () => {
      const { hooks } = createMockHooks();
      const origMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as any;

      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 505,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: true, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const canvas = viewer.element.querySelector<HTMLCanvasElement>("canvas")!;
      expect(arcCalls.length).toBeGreaterThan(0);
      const firstArc = arcCalls[0]!;
      const expectedCx = canvas.width / 2;
      const expectedCy = canvas.height / 2;
      expect(firstArc.x).toBeCloseTo(expectedCx);
      expect(firstArc.y).toBeCloseTo(expectedCy);

      window.matchMedia = origMatchMedia;
      viewer.close();
    });

    it("(d) window pointer listeners are removed on viewer.close()", async () => {
      const { hooks } = createMockHooks();
      const addSpy = vi.spyOn(window, "addEventListener");
      const removeSpy = vi.spyOn(window, "removeEventListener");

      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 504,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: true, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["photo"], { type: "image/jpeg" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      expect(addSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith("pointercancel", expect.any(Function));

      viewer.close();

      expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("pointercancel", expect.any(Function));

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });
  });

  describe("Double-tap panic lock on playing video (Item 10)", () => {
    it("viewer video element has pointer-events: none so overlay receives taps and does not exclude gesture", async () => {
      const { hooks } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 601,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: false, kind: "video", mime: "video/mp4" },
        }),
        fetchContent: async () => ({
          ok: true,
          blob: new Blob(["video"], { type: "video/mp4" }),
        }),
      });

      document.body.appendChild(viewer.element);
      await flush();

      const video = viewer.element.querySelector("video")!;
      expect(video).toBeTruthy();
      expect(video.style.pointerEvents).toBe("none");

      viewer.close();
    });
  });

  describe("Viewer 401 handling (F8)", () => {
    it("401 / ServerLockedError on openClaim closes viewer and calls lockNow('unauthorized')", async () => {
      const { hooks, lockCauses } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 701,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => {
          throw new ServerLockedError();
        },
      });

      document.body.appendChild(viewer.element);
      await flush();

      expect(lockCauses).toContain("unauthorized");
      expect(document.body.contains(viewer.element)).toBe(false);
    });

    it("401 / ServerLockedError on fetchContent closes viewer and calls lockNow('unauthorized')", async () => {
      const { hooks, lockCauses } = createMockHooks();
      const viewer = mountViewOnceViewer({
        session: () => SESSION,
        seq: 702,
        hooks,
        identity: fakeIdentity(),
        win: window,
        openClaim: async () => ({
          ok: true,
          data: { durationS: 5, tease: false, kind: "photo", mime: "image/jpeg" },
        }),
        fetchContent: async () => {
          throw new ServerLockedError();
        },
      });

      document.body.appendChild(viewer.element);
      await flush();

      expect(lockCauses).toContain("unauthorized");
      expect(document.body.contains(viewer.element)).toBe(false);
    });
  });
});

