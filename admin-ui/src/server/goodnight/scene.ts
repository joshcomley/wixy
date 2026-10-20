// The good-night scene's canvas overlay (spec/server-chat/goodnight-scene.md).
//
// One <canvas> at a low scene resolution, scaled up by a whole number with nearest-neighbour.
// Sprites are pre-rendered once per frame into offscreen canvases at scale 1 and blitted with
// `drawImage(canvas, x, y)` at whole scene pixels only. Fades are Bayer dither (never alpha).
// The chat UI behind fades with ordinary CSS opacity (classes on the thread view).
//
// Lifecycle: `playing` (overlay on document.body, idle lock suspended, tap/click/Escape skip) ->
// `background` (canvas moves under the thread inside `.wx-srv-thread-wrap`, sky + twinkling stars
// only) -> `closed` (everything removed, no rAF, no listeners).

import { ditherLevel, ditherVisibleAt, mod4 } from "./dither";
import {
  backgroundAt,
  frameData,
  MESSAGES_BACK_FROM_MS,
  SCENE_END_MS,
  SKY_COLOUR,
  SPRITES,
  sceneAt,
  sceneGeometry,
  type SceneFrame,
  type SceneGeometry,
  type SpriteName,
} from "./timeline";

export type ScenePhase = "playing" | "background" | "closed";

export interface SceneDeps {
  readonly win: Window;
  readonly document: Document;
  readonly hooks: { suspend(reason: "goodnight"): () => void };
  /** `.wx-srv-thread-view`: gets the class names that fade the chat UI. */
  readonly view: HTMLElement;
  /** `.wx-srv-thread-wrap`: where the background starfield lives. */
  readonly threadWrap: HTMLElement;
  /** Milliseconds clock (default `Date.now`). */
  readonly now?: () => number;
  /** Seed for star placement and twinkle (default random). */
  readonly seed?: number;
}

export interface SceneHandle {
  readonly phase: ScenePhase;
  /** Jump straight to background mode (a no-op once there). */
  skip(): void;
  /** Remove the scene and the background layer. Idempotent. */
  close(): void;
}

/** Class names shared with chat.css. */
export const GN_FADING = "wx-srv-gn-fading";
export const GN_HIDDEN = "wx-srv-gn-hidden";
export const GN_BACKGROUND = "wx-srv-gn-bg";

const BACKGROUND_FRAME_MS = 66;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function parseHex(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

export function startScene(deps: SceneDeps): SceneHandle {
  const { win, document: doc, view, threadWrap } = deps;
  const now = deps.now ?? (() => Date.now());
  const seed = deps.seed ?? Math.floor(Math.random() * 4294967296);
  const reduced = win.matchMedia?.(REDUCED_MOTION)?.matches ?? false;

  let phase: ScenePhase = "playing";
  let geometry: SceneGeometry = sceneGeometry(win.innerWidth || 360, win.innerHeight || 640);
  let startedAt = now();
  let rafHandle: number | null = null;
  let rafIsTimeout = false;
  let releaseSuspend: (() => void) | null = null;
  let messagesBack = false;
  let lastBackgroundDraw = Number.NEGATIVE_INFINITY;
  let lastSignature = "";
  let bgContainer: HTMLElement | null = null;

  const canvas = doc.createElement("canvas");
  canvas.className = "wx-srv-goodnight-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    // No 2D canvas (very old or locked-down browser): the effect is decorative, so do nothing.
    phase = "closed";
    return { phase, skip() {}, close() {} };
  }
  ctx.imageSmoothingEnabled = false;

  // -- Pre-rendered sprites and dither caches -----------------------------------------------------

  const spriteCache = new Map<string, HTMLCanvasElement>();
  const skyCache = new Map<number, HTMLCanvasElement>();

  function offscreen(w: number, h: number, paint: (x: number, y: number) => [number, number, number] | null): HTMLCanvasElement {
    const c = doc.createElement("canvas");
    c.width = w;
    c.height = h;
    const c2 = c.getContext("2d");
    if (c2 === null) return c;
    const image = c2.createImageData(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const rgb = paint(x, y);
        if (rgb === null) continue;
        const i = (y * w + x) * 4;
        image.data[i] = rgb[0];
        image.data[i + 1] = rgb[1];
        image.data[i + 2] = rgb[2];
        image.data[i + 3] = 255;
      }
    }
    c2.putImageData(image, 0, 0);
    return c;
  }

  function spriteCanvas(sprite: SpriteName, frame: string, level: number, x: number, y: number): HTMLCanvasElement {
    const full = level >= 16;
    const key = full ? `${sprite}|${frame}` : `${sprite}|${frame}|${level}|${mod4(x)}|${mod4(y)}`;
    const hit = spriteCache.get(key);
    if (hit !== undefined) return hit;
    const data = SPRITES[sprite];
    const pixels = frameData(sprite, frame);
    const palette = data.palette.map((c) => (c === null ? null : parseHex(c)));
    const made = offscreen(data.w, data.h, (px, py) => {
      const index = Number.parseInt(pixels.charAt(py * data.w + px) || "0", 36);
      const rgb = palette[index] ?? null;
      if (rgb === null) return null;
      return full || ditherVisibleAt(x + px, y + py, level) ? rgb : null;
    });
    spriteCache.set(key, made);
    return made;
  }

  function skyCanvas(level: number): HTMLCanvasElement {
    const hit = skyCache.get(level);
    if (hit !== undefined) return hit;
    const rgb = parseHex(SKY_COLOUR);
    const made = offscreen(geometry.w, geometry.h, (x, y) => (ditherVisibleAt(x, y, level) ? rgb : null));
    skyCache.set(level, made);
    return made;
  }

  function draw(frame: SceneFrame): void {
    if (ctx === null) return;
    ctx.clearRect(0, 0, geometry.w, geometry.h);
    const skyLevel = ditherLevel(frame.skyOpacity);
    if (skyLevel >= 16) {
      ctx.fillStyle = SKY_COLOUR;
      ctx.fillRect(0, 0, geometry.w, geometry.h);
    } else if (skyLevel > 0) {
      ctx.drawImage(skyCanvas(skyLevel), 0, 0);
    }
    for (const op of frame.ops) {
      const level = ditherLevel(op.opacity);
      if (level <= 0) continue;
      ctx.drawImage(spriteCanvas(op.sprite, op.frame, level, op.x, op.y), op.x, op.y);
    }
  }

  function signature(frame: SceneFrame): string {
    return frame.ops.map((o) => `${o.sprite}${o.frame}${o.x},${o.y},${o.opacity}`).join("|");
  }

  // -- Layout ---------------------------------------------------------------------------------------

  function placeCanvas(): void {
    canvas.width = geometry.w;
    canvas.height = geometry.h;
    if (ctx !== null) ctx.imageSmoothingEnabled = false;
    canvas.style.width = `${geometry.w * geometry.scale}px`;
    canvas.style.height = `${geometry.h * geometry.scale}px`;
    positionBackground();
  }

  /** In background mode the canvas keeps its viewport-sized layout (so the stars never move at the
   * hand-over) and is offset inside the clipped layer to line up with the viewport. */
  function positionBackground(): void {
    if (phase !== "background" || bgContainer === null) return;
    const rect = bgContainer.getBoundingClientRect();
    canvas.style.left = `${-Math.round(rect.left)}px`;
    canvas.style.top = `${-Math.round(rect.top)}px`;
  }

  function onResize(): void {
    geometry = sceneGeometry(win.innerWidth || 360, win.innerHeight || 640);
    spriteCache.clear();
    skyCache.clear();
    placeCanvas();
    lastSignature = "";
    if (reduced && phase === "background") draw(backgroundAt(0, geometry, seed, true));
    else if (phase !== "closed") renderNow();
  }

  // -- Frame loop -----------------------------------------------------------------------------------

  function renderNow(): void {
    const elapsed = now() - startedAt;
    if (phase === "playing") {
      if (!messagesBack && elapsed >= MESSAGES_BACK_FROM_MS) {
        messagesBack = true;
        view.style.setProperty("--wx-gn-ms", "1000ms");
        view.classList.remove(GN_HIDDEN);
      }
      if (elapsed >= SCENE_END_MS) {
        enterBackground();
        return;
      }
      draw(sceneAt(elapsed, geometry, seed));
      return;
    }
    if (phase === "background") {
      if (elapsed - lastBackgroundDraw < BACKGROUND_FRAME_MS) return;
      lastBackgroundDraw = elapsed;
      positionBackground();
      const frame = backgroundAt(elapsed, geometry, seed);
      const sig = signature(frame);
      if (sig === lastSignature) return;
      lastSignature = sig;
      draw(frame);
    }
  }

  function schedule(): void {
    if (phase === "closed" || reduced) return;
    if (typeof win.requestAnimationFrame === "function") {
      rafIsTimeout = false;
      rafHandle = win.requestAnimationFrame(tick);
    } else {
      rafIsTimeout = true;
      rafHandle = win.setTimeout(tick, 16);
    }
  }

  function cancelFrame(): void {
    if (rafHandle === null) return;
    if (rafIsTimeout) win.clearTimeout(rafHandle);
    else win.cancelAnimationFrame?.(rafHandle);
    rafHandle = null;
  }

  function tick(): void {
    rafHandle = null;
    if (phase === "closed") return;
    renderNow();
    schedule();
  }

  // -- Skipping, the hand-over, teardown --------------------------------------------------------------

  function onClick(event: Event): void {
    event.preventDefault();
    skip();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Escape is also the chat's panic key: it is deliberately not swallowed here, so the lock it
    // causes still happens (and tears this scene down).
    if (event.key === "Escape") skip();
  }

  function releaseIdle(): void {
    releaseSuspend?.();
    releaseSuspend = null;
  }

  function enterBackground(): void {
    if (phase !== "playing") return;
    phase = "background";
    releaseIdle();
    canvas.removeEventListener("click", onClick);
    doc.removeEventListener("keydown", onKeyDown);
    view.classList.remove(GN_HIDDEN);
    view.style.setProperty("--wx-gn-ms", "1000ms");
    canvas.remove();
    const layer = doc.createElement("div");
    layer.className = "wx-srv-goodnight-bg";
    layer.setAttribute("aria-hidden", "true");
    layer.appendChild(canvas);
    threadWrap.insertBefore(layer, threadWrap.firstChild);
    bgContainer = layer;
    threadWrap.classList.add(GN_BACKGROUND);
    canvas.classList.add("wx-srv-goodnight-canvas-bg");
    lastSignature = "";
    lastBackgroundDraw = Number.NEGATIVE_INFINITY;
    placeCanvas();
    if (reduced) draw(backgroundAt(0, geometry, seed, true));
    else renderNow();
  }

  function skip(): void {
    enterBackground();
  }

  function close(): void {
    if (phase === "closed") return;
    const wasPlaying = phase === "playing" && !reduced;
    phase = "closed";
    cancelFrame();
    releaseIdle();
    if (wasPlaying) {
      canvas.removeEventListener("click", onClick);
      doc.removeEventListener("keydown", onKeyDown);
    }
    win.removeEventListener?.("resize", onResize);
    canvas.remove();
    bgContainer?.remove();
    bgContainer = null;
    view.classList.remove(GN_FADING, GN_HIDDEN);
    view.style.removeProperty("--wx-gn-ms");
    threadWrap.classList.remove(GN_BACKGROUND);
    spriteCache.clear();
    skyCache.clear();
  }

  // -- Start --------------------------------------------------------------------------------------------

  win.addEventListener?.("resize", onResize);
  placeCanvas();
  if (reduced) {
    // No scene: straight to a static starfield behind the thread.
    phase = "playing";
    enterBackground();
    return handle();
  }
  releaseSuspend = deps.hooks.suspend("goodnight");
  doc.body.appendChild(canvas);
  canvas.addEventListener("click", onClick);
  doc.addEventListener("keydown", onKeyDown);
  view.style.setProperty("--wx-gn-ms", "900ms");
  view.classList.add(GN_FADING, GN_HIDDEN);
  startedAt = now();
  renderNow();
  schedule();
  return handle();

  function handle(): SceneHandle {
    return {
      get phase(): ScenePhase {
        return phase;
      },
      skip,
      close,
    };
  }
}
