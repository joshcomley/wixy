// View-once media viewer (spec/server-chat/06-view-once-media.md §3.3 & §4).
// Full-screen overlay component for viewing view-once photos (with optional
// tease reveal) and videos. Closes permanently after the view; the server
// deletes the content straight after bytes are handed over.

import {
  fetchViewOnceContent,
  openViewOnceClaim,
  type FetchViewOnceContentResult,
  type OpenViewOnceResult,
  type OpenViewOnceSuccess,
} from "./api/messages";
import { ServerLockedError } from "./api/http";
import type { ServerIdentity } from "./identity";
import type { LockHooks, ServerSession } from "./types";
import {
  TEASE_DRAG_RESUME_DELAY_MS,
  TEASE_EASE_DURATION_MS,
  TEASE_SIZE_DEFAULT,
  TEASE_SIZE_MAX,
  TEASE_SIZE_MIN,
  TEASE_SPEED_DEFAULT,
  TEASE_SPEED_MAX,
  TEASE_SPEED_MIN,
  TEASE_SPEED_STEP,
  advanceTeasePhase,
  computeTeaseCoords,
  computeTeaseRadius,
  paintPhoto,
  paintTeaseMask,
  teaseGeometry,
} from "./teasePaint";

export interface ViewOnceViewerDeps {
  readonly session: () => ServerSession | null;
  readonly seq: number;
  readonly hooks: LockHooks;
  readonly identity: ServerIdentity;
  readonly win: Window;
  readonly document?: Document;
  readonly onClose?: () => void;
  /** Test injection points (for fake time, simulated blobs, etc.) */
  readonly fetchContent?: (
    session: ServerSession,
    seq: number,
    claimId: string,
    signal?: AbortSignal,
  ) => Promise<FetchViewOnceContentResult>;
  readonly openClaim?: (
    session: ServerSession,
    seq: number,
    input: { claimId: string; sender: string },
  ) => Promise<OpenViewOnceResult>;
}

export interface ViewOnceViewerHandle {
  readonly element: HTMLElement;
  readonly close: () => void;
}

export function generateClaimId(win: Window): string {
  if (typeof win.crypto?.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues is not available");
  }
  const bytes = new Uint8Array(16);
  win.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const RING_RADIUS = 15;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// The Tease maths and painting live in teasePaint.ts (shared with the sender's compose-time
// preview); re-exported so existing importers keep working.
export {
  TEASE_CYCLE_MS,
  TEASE_DRAG_RESUME_DELAY_MS,
  TEASE_EASE_DURATION_MS,
  computeTeaseCoords,
  computeTeaseRadius,
  type TeaseCoordsParams,
} from "./teasePaint";

export function mountViewOnceViewer(deps: ViewOnceViewerDeps): ViewOnceViewerHandle {
  const win = deps.win;
  const doc = deps.document ?? win.document ?? document;
  const overlay = doc.createElement("div");
  overlay.className = "wx-srv-view-once-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "View once media");

  // Prevent right-click / context menu and long-press callout
  overlay.addEventListener("contextmenu", (e) => e.preventDefault());

  let closed = false;
  let releaseViewOnceSuspend: (() => void) | null = null;
  let releaseMediaPlayingSuspend: (() => void) | null = null;
  let activeBlob: Blob | null = null;
  let activeBitmap: ImageBitmap | null = null;
  let videoObjectUrl: string | null = null;
  let rafId: number | null = null;
  let timerIntervalId: number | null = null;
  let cleanupPhotoEvents: (() => void) | null = null;
  let cancelVideoFrame: (() => void) | null = null;

  const abortController = new AbortController();

  // Top header: close button & countdown ring
  const header = doc.createElement("div");
  header.className = "wx-srv-view-once-header";

  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wx-srv-view-once-close";
  closeButton.textContent = "✕";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.addEventListener("click", () => close());
  header.appendChild(closeButton);

  const ringWrap = doc.createElement("div");
  ringWrap.className = "wx-srv-view-once-ring-wrap";
  ringWrap.hidden = true;

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("class", "wx-srv-view-once-ring-svg");

  const circleBg = doc.createElementNS(svgNs, "circle");
  circleBg.setAttribute("class", "wx-srv-view-once-ring-bg");
  circleBg.setAttribute("cx", "18");
  circleBg.setAttribute("cy", "18");
  circleBg.setAttribute("r", String(RING_RADIUS));

  const circleFg = doc.createElementNS(svgNs, "circle");
  circleFg.setAttribute("class", "wx-srv-view-once-ring-fg");
  circleFg.setAttribute("cx", "18");
  circleFg.setAttribute("cy", "18");
  circleFg.setAttribute("r", String(RING_RADIUS));
  circleFg.setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
  circleFg.setAttribute("stroke-dashoffset", "0");

  svg.append(circleBg, circleFg);

  const countdownText = doc.createElement("span");
  countdownText.className = "wx-srv-view-once-countdown";

  ringWrap.append(svg, countdownText);
  header.appendChild(ringWrap);
  overlay.appendChild(header);

  // Content body
  const body = doc.createElement("div");
  body.className = "wx-srv-view-once-body";
  overlay.appendChild(body);

  const statusEl = doc.createElement("div");
  statusEl.className = "wx-srv-view-once-status";

  const statusText = doc.createElement("div");
  statusText.className = "wx-srv-view-once-status-text";
  statusText.textContent = "Loading…";

  const statusNotice = doc.createElement("div");
  statusNotice.className = "wx-srv-view-once-status-notice";
  statusNotice.textContent = "Opening it uses it up.";

  statusEl.append(statusText, statusNotice);
  body.appendChild(statusEl);

  // Controls container (slider for tease, or play button for video)
  const controlsEl = doc.createElement("div");
  controlsEl.className = "wx-srv-view-once-controls";
  controlsEl.hidden = true;
  overlay.appendChild(controlsEl);

  // Keyboard navigation & Escape
  function onKeyDown(evt: KeyboardEvent): void {
    if (evt.key === "Escape") {
      close();
      deps.hooks.lockNow("escape");
    }
  }
  win.addEventListener("keydown", onKeyDown);

  // Visibility change: leaving the app ends the view
  function onVisibilityChange(): void {
    if (doc.visibilityState === "hidden") {
      close();
    }
  }
  doc.addEventListener("visibilitychange", onVisibilityChange);

  function close(): void {
    if (closed) return;
    closed = true;

    abortController.abort();
    if (rafId !== null) {
      win.cancelAnimationFrame?.(rafId);
      rafId = null;
    }
    if (timerIntervalId !== null) {
      win.clearInterval?.(timerIntervalId);
      timerIntervalId = null;
    }
    if (cancelVideoFrame !== null) {
      cancelVideoFrame();
      cancelVideoFrame = null;
    }

    if (releaseViewOnceSuspend !== null) {
      releaseViewOnceSuspend();
      releaseViewOnceSuspend = null;
    }
    if (releaseMediaPlayingSuspend !== null) {
      releaseMediaPlayingSuspend();
      releaseMediaPlayingSuspend = null;
    }

    if (activeBitmap !== null) {
      try {
        activeBitmap.close?.();
      } catch {
        // Ignored
      }
      activeBitmap = null;
    }

    if (videoObjectUrl !== null) {
      try {
        const urlApi = (win as unknown as { URL?: typeof URL }).URL ?? URL;
        urlApi.revokeObjectURL(videoObjectUrl);
      } catch {
        // Ignored
      }
      videoObjectUrl = null;
    }

    const videoEl = body.querySelector("video");
    if (videoEl !== null) {
      try {
        videoEl.pause?.();
        videoEl.removeAttribute("src");
        videoEl.load?.();
      } catch {
        // Ignored
      }
    }

    const canvasEl = body.querySelector("canvas");
    if (canvasEl !== null) {
      try {
        const ctx = canvasEl.getContext("2d");
        ctx?.clearRect?.(0, 0, canvasEl.width, canvasEl.height);
      } catch {
        // Ignored
      }
    }

    if (cleanupPhotoEvents !== null) {
      cleanupPhotoEvents();
      cleanupPhotoEvents = null;
    }

    activeBlob = null;
    win.removeEventListener("keydown", onKeyDown);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    overlay.remove();

    deps.onClose?.();
  }

  // Timer handling
  let firstPainted = false;
  let paintedAt = 0;
  let durationSeconds: number | null = null;

  function startTimer(durationS: number | null): void {
    if (firstPainted || closed) return;
    firstPainted = true;
    if (paintedAt === 0) {
      paintedAt = (win.performance?.now?.() ?? Date.now());
    }
    durationSeconds = durationS;

    if (durationS !== null) {
      releaseViewOnceSuspend = deps.hooks.suspend("viewOnce");
      ringWrap.hidden = false;
      countdownText.textContent = String(durationS);

      const tick = (): void => {
        if (closed) return;
        const now = (win.performance?.now?.() ?? Date.now());
        const elapsed = (now - paintedAt) / 1000;
        const remaining = Math.max(0, durationS - elapsed);
        const frac = remaining / durationS;

        countdownText.textContent = String(Math.ceil(remaining));
        circleFg.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - frac)));

        if (remaining <= 0) {
          close();
        }
      };

      timerIntervalId = win.setInterval?.(tick, 50) as unknown as number;
    }
  }

  // Setup viewer content once claim and blob are loaded
  async function setupContent(
    claimData: { durationS: 2 | 5 | 30 | null; tease: boolean; kind: "photo" | "video"; mime: string },
    blob: Blob,
  ): Promise<void> {
    if (closed) return;
    statusEl.hidden = true;
    activeBlob = blob;

    if (claimData.kind === "video") {
      setupVideo(claimData.durationS, blob);
    } else {
      await setupPhoto(claimData.durationS, claimData.tease, blob);
    }
  }

  function setupVideo(durationS: number | null, blob: Blob): void {
    const video = doc.createElement("video");
    video.className = "wx-srv-view-once-video";
    video.style.pointerEvents = "none";
    video.playsInline = true;
    video.controls = false;
    video.setAttribute("playsinline", "true");
    video.setAttribute("disablepictureinpicture", "true");
    video.setAttribute("controlslist", "nodownload noremoteplayback");
    (video as unknown as { disablePictureInPicture?: boolean }).disablePictureInPicture = true;

    try {
      const urlApi = (win as unknown as { URL?: typeof URL }).URL ?? URL;
      if (typeof urlApi?.createObjectURL === "function") {
        videoObjectUrl = urlApi.createObjectURL(blob);
        if (videoObjectUrl) {
          video.src = videoObjectUrl;
        }
      }
    } catch {
      // Fallback for tests
    }

    video.addEventListener("play", () => {
      if (!releaseMediaPlayingSuspend) {
        releaseMediaPlayingSuspend = deps.hooks.suspend("mediaPlaying");
      }
    });

    let videoTimerStarted = false;
    function onFirstFrame(): void {
      if (closed || videoTimerStarted) return;
      videoTimerStarted = true;
      if (cancelVideoFrame !== null) {
        cancelVideoFrame();
        cancelVideoFrame = null;
      }
      startTimer(durationS);
    }

    const videoWithRfc = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: DOMHighResTimeStamp, metadata: unknown) => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };

    if (typeof videoWithRfc.requestVideoFrameCallback === "function") {
      let rfcId: number | null = null;
      const onFrame = (): void => {
        if (closed || videoTimerStarted) return;
        if (video.paused) {
          rfcId = videoWithRfc.requestVideoFrameCallback!(onFrame);
          return;
        }
        onFirstFrame();
      };
      rfcId = videoWithRfc.requestVideoFrameCallback(onFrame);
      cancelVideoFrame = () => {
        if (rfcId !== null) {
          try {
            videoWithRfc.cancelVideoFrameCallback?.(rfcId);
          } catch {
            // Ignored
          }
          rfcId = null;
        }
      };
      video.addEventListener("playing", onFirstFrame, { once: true });
    } else {
      video.addEventListener("playing", onFirstFrame, { once: true });
    }

    video.addEventListener("ended", () => {
      close();
    });

    body.appendChild(video);

    const playPromise = video.play?.();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        if (closed) return;
        // User gesture lapsed; show a single Play button
        controlsEl.hidden = false;
        const playBtn = doc.createElement("button");
        playBtn.type = "button";
        playBtn.className = "wx-srv-view-once-play-btn";
        playBtn.textContent = "▶ Play";
        playBtn.setAttribute("aria-label", "Play video");
        playBtn.addEventListener("click", () => {
          playBtn.remove();
          void video.play?.();
        });
        controlsEl.appendChild(playBtn);
      });
    }
  }

  async function setupPhoto(
    durationS: number | null,
    isTease: boolean,
    blob: Blob,
  ): Promise<void> {
    const canvas = doc.createElement("canvas");
    canvas.className = "wx-srv-view-once-canvas";
    body.appendChild(canvas);

    let bitmap: ImageBitmap;
    if (typeof win.createImageBitmap === "function") {
      try {
        bitmap = await win.createImageBitmap(blob);
      } catch {
        statusEl.textContent = "Couldn't show this photo.";
        statusEl.hidden = false;
        canvas.remove();
        return;
      }
    } else {
      statusEl.textContent = "Couldn't show this photo.";
      statusEl.hidden = false;
      canvas.remove();
      return;
    }
    if (closed) {
      bitmap.close?.();
      return;
    }
    activeBitmap = bitmap;

    const prefersReducedMotion =
      typeof win.matchMedia === "function" &&
      win.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let sliderValue = TEASE_SIZE_DEFAULT; // 6 to 35, default 12%
    // The animation clock and the recipient's speed multiplier (advanceTeasePhase, teasePaint.ts):
    // the cut-out's position follows this clock, so a speed change never makes it jump.
    let teaseSpeed = TEASE_SPEED_DEFAULT;
    let teasePhaseMs = 0;
    let lastFrameAt: number | null = null;
    if (isTease) {
      controlsEl.hidden = false;
      const panel = doc.createElement("div");
      panel.className = "wx-srv-view-once-tease-controls";
      const addRow = (label: string, input: HTMLInputElement, readout?: HTMLElement): void => {
        const row = doc.createElement("label");
        row.className = "wx-srv-view-once-control";
        const name = doc.createElement("span");
        name.className = "wx-srv-view-once-control-name";
        name.textContent = label;
        row.append(name, input);
        if (readout !== undefined) row.appendChild(readout);
        panel.appendChild(row);
      };

      const slider = doc.createElement("input");
      slider.type = "range";
      slider.className = "wx-srv-view-once-slider";
      slider.min = String(TEASE_SIZE_MIN);
      slider.max = String(TEASE_SIZE_MAX);
      slider.value = String(TEASE_SIZE_DEFAULT);
      slider.step = "1";
      slider.setAttribute("aria-label", "Tease size");
      // A readout on each row keeps the two sliders the same length.
      const sizeReadout = doc.createElement("span");
      sizeReadout.className = "wx-srv-view-once-control-value wx-srv-view-once-size-value";
      const showSize = (): void => {
        sizeReadout.textContent = `${sliderValue}%`;
      };
      slider.addEventListener("input", () => {
        sliderValue = Number(slider.value);
        showSize();
        renderFrame();
      });
      showSize();
      addRow("Size", slider, sizeReadout);

      // With reduced motion the cut-out is still (only the drag moves it), so there is no
      // speed to control and the slider is left out rather than shown doing nothing.
      if (!prefersReducedMotion) {
        const speedSlider = doc.createElement("input");
        speedSlider.type = "range";
        speedSlider.className = "wx-srv-view-once-speed-slider";
        speedSlider.min = String(TEASE_SPEED_MIN);
        speedSlider.max = String(TEASE_SPEED_MAX);
        speedSlider.step = String(TEASE_SPEED_STEP);
        speedSlider.value = String(TEASE_SPEED_DEFAULT);
        speedSlider.setAttribute("aria-label", "Tease speed");
        const speedReadout = doc.createElement("span");
        speedReadout.className = "wx-srv-view-once-control-value wx-srv-view-once-speed-value";
        const showSpeed = (): void => {
          speedReadout.textContent = `${teaseSpeed}×`;
        };
        speedSlider.addEventListener("input", () => {
          const v = Number(speedSlider.value);
          if (Number.isFinite(v)) {
            teaseSpeed = Math.min(TEASE_SPEED_MAX, Math.max(TEASE_SPEED_MIN, v));
          }
          showSpeed();
        });
        showSpeed();
        addRow("Speed", speedSlider, speedReadout);
      }
      controlsEl.appendChild(panel);
    }

    let isDragging = false;
    let dragX = 0;
    let dragY = 0;
    let dragReleaseTime = 0;
    let dragReleaseX: number | undefined = undefined;
    let dragReleaseY: number | undefined = undefined;

    function getPointerPos(evt: PointerEvent | MouseEvent | Touch): { x: number; y: number } {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(win.devicePixelRatio || 1, 2);
      return {
        x: (evt.clientX - rect.left) * dpr,
        y: (evt.clientY - rect.top) * dpr,
      };
    }

    function onPointerDown(evt: PointerEvent): void {
      if (!isTease) return;
      isDragging = true;
      const pos = getPointerPos(evt);
      dragX = pos.x;
      dragY = pos.y;
      renderFrame();
    }

    function onPointerMove(evt: PointerEvent): void {
      if (!isTease || !isDragging) return;
      const pos = getPointerPos(evt);
      dragX = pos.x;
      dragY = pos.y;
      renderFrame();
    }

    function onPointerUp(): void {
      if (!isTease || !isDragging) return;
      isDragging = false;
      dragReleaseTime = (win.performance?.now?.() ?? Date.now());
      renderFrame();
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    win.addEventListener("pointermove", onPointerMove);
    win.addEventListener("pointerup", onPointerUp);
    win.addEventListener("pointercancel", onPointerUp);

    cleanupPhotoEvents = () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      win.removeEventListener("pointermove", onPointerMove);
      win.removeEventListener("pointerup", onPointerUp);
      win.removeEventListener("pointercancel", onPointerUp);
    };

    function renderFrame(): void {
      if (closed || !activeBitmap) return;
      if (!firstPainted && paintedAt === 0) {
        paintedAt = (win.performance?.now?.() ?? Date.now());
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        if (!firstPainted) {
          startTimer(durationS);
        }
        return;
      }

      const dpr = Math.min(win.devicePixelRatio || 1, 2);
      const width = (body.clientWidth || win.innerWidth || 800) * dpr;
      const height = (body.clientHeight || win.innerHeight || 600) * dpr;

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      // Letterbox geometry, black background, then the photo (teasePaint.ts, shared with the
      // sender's compose-time preview).
      const geo = teaseGeometry(width, height, activeBitmap.width, activeBitmap.height);
      const { drawX, drawY, drawW, drawH, cx, cy, minSide } = geo;
      paintPhoto(ctx, activeBitmap, geo);

      if (isTease) {
        const radius = computeTeaseRadius(sliderValue, minSide);
        const Ax = Math.max(0, drawW / 2 - radius);
        const Ay = Math.max(0, drawH / 2 - radius);

        const now = (win.performance?.now?.() ?? Date.now());
        // The clock starts at first paint and only ever advances by (frame gap x speed), so at
        // speed 1 it equals the wall time since first paint and a speed change never jumps.
        teasePhaseMs = advanceTeasePhase(teasePhaseMs, now - (lastFrameAt ?? paintedAt), teaseSpeed);
        lastFrameAt = now;

        const coords = computeTeaseCoords({
          cx,
          cy,
          Ax,
          Ay,
          drawX,
          drawY,
          drawW,
          drawH,
          radius,
          elapsedMs: teasePhaseMs,
          prefersReducedMotion,
          isDragging,
          dragX,
          dragY,
          dragReleaseTime,
          dragReleaseX,
          dragReleaseY,
          now,
        });

        if (isDragging) {
          dragReleaseX = coords.x;
          dragReleaseY = coords.y;
        } else if (
          dragReleaseTime > 0 &&
          now - dragReleaseTime >= TEASE_DRAG_RESUME_DELAY_MS + TEASE_EASE_DURATION_MS
        ) {
          dragReleaseTime = 0;
        }

        const spotX = coords.x;
        const spotY = coords.y;

        // Opaque black layer with a circular hole, outer 15% feathered (teasePaint.ts).
        paintTeaseMask(ctx, geo, spotX, spotY, radius);
      }

      if (!firstPainted) {
        startTimer(durationS);
      }
    }

    function loop(): void {
      if (closed) return;
      renderFrame();
      // Redraw continuously if tease is moving
      if (isTease && !prefersReducedMotion) {
        rafId = win.requestAnimationFrame?.(loop) ?? null;
      }
    }

    renderFrame();
    if (isTease && !prefersReducedMotion) {
      rafId = win.requestAnimationFrame?.(loop) ?? null;
    }
  }

  // Start claim and fetch lifecycle
  async function init(): Promise<void> {
    try {
      const session = deps.session();
      if (session === null) {
        statusEl.textContent = "Unlock Server to view this item.";
        return;
      }

      const claimId = generateClaimId(win);
      const openClaimFn = deps.openClaim ?? openViewOnceClaim;
      const fetchContentFn = deps.fetchContent ?? fetchViewOnceContent;

      let claimData: OpenViewOnceSuccess | null = null;
      let claimAttempts = 0;
      while (!closed) {
        let claimResult: OpenViewOnceResult;
        try {
          claimResult = await openClaimFn(session, deps.seq, {
            claimId,
            sender: deps.identity.getName() ?? "Someone",
          });
        } catch (error) {
          if (error instanceof ServerLockedError) {
            close();
            deps.hooks.lockNow("unauthorized");
            return;
          }
          claimResult = { ok: false, kind: "unavailable" };
        }

        if (closed) return;

        if (claimResult.ok) {
          claimData = claimResult.data;
          break;
        }

        if (claimResult.kind === "already_opened") {
          statusEl.textContent = "Already opened";
          return;
        } else if (claimResult.kind === "not_found") {
          statusEl.textContent = "No longer available";
          return;
        } else if (claimResult.kind === "own_message") {
          statusEl.textContent = "Cannot open your own view-once message";
          return;
        }

        claimAttempts++;
        if (claimAttempts >= 30) {
          statusEl.textContent = "Couldn't open this message. Try again later.";
          return;
        }
        statusEl.textContent = "Connection issue, retrying…";
        await new Promise((r) => win.setTimeout?.(r, 1000) ?? setTimeout(r, 1000));
      }

      if (!claimData || closed) return;

      // Retry loop for content download on network failure
      let contentResult: FetchViewOnceContentResult | null = null;
      let attempts = 0;
      while (!closed) {
        try {
          contentResult = await fetchContentFn(
            session,
            deps.seq,
            claimId,
            abortController.signal,
          );
        } catch (error) {
          if (error instanceof ServerLockedError) {
            close();
            deps.hooks.lockNow("unauthorized");
            return;
          }
          contentResult = { ok: false, kind: "unavailable" };
        }
        if (closed) return;
        if (contentResult.ok) break;
        if (
          contentResult.kind === "not_found" ||
          contentResult.kind === "expired" ||
          contentResult.kind === "forbidden"
        ) {
          statusEl.textContent = "No longer available";
          return;
        }
        attempts++;
        if (attempts >= 30) {
          statusEl.textContent = "Couldn't open this message.";
          return;
        }
        // On unavailable / transient error, retry after 1s
        statusEl.textContent = "Connection issue, retrying…";
        await new Promise((r) => win.setTimeout?.(r, 1000) ?? setTimeout(r, 1000));
      }

      if (contentResult && contentResult.ok) {
        await setupContent(claimData, contentResult.blob);
      }
    } catch (error) {
      if (error instanceof ServerLockedError) {
        close();
        deps.hooks.lockNow("unauthorized");
        return;
      }
      if (closed) return;
      statusEl.textContent = "Couldn't open this message.";
    }
  }

  void init();

  return {
    element: overlay,
    close,
  };
}
