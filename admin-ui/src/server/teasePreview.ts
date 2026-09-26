// The sender's compose-time Tease preview (spec/server-chat/06-view-once-media.md section 4):
// when Tease is ticked in the View-once sheet, show the sender's own staged photo with the real
// moving cut-out, at the recipient's default size and speed, so the effect is not a surprise.
// It draws with the exact renderer the recipient's viewer uses (teasePaint.ts), never a copy.
// Nothing about it is stored or sent: it is a picture on the sender's own screen.

import {
  TEASE_SIZE_DEFAULT,
  TEASE_SPEED_DEFAULT,
  advanceTeasePhase,
  computeTeaseCoords,
  computeTeaseRadius,
  paintPhoto,
  paintTeaseMask,
  teaseGeometry,
} from "./teasePaint";

export interface TeasePreviewDeps {
  readonly doc: Document;
  readonly win: Window;
  /** The staged photo's object URL: the same one the composer chip and the sheet thumbnail render
   * from, so no second copy of the file is minted. */
  readonly imageUrl: string;
}

export interface TeasePreviewHandle {
  readonly element: HTMLElement;
  /** Stops the animation, releases the image and removes the element. Safe to call twice. */
  readonly destroy: () => void;
}

export function mountTeasePreview(deps: TeasePreviewDeps): TeasePreviewHandle {
  const { doc, win, imageUrl } = deps;

  const root = doc.createElement("div");
  root.className = "wx-srv-tease-preview";

  const canvas = doc.createElement("canvas");
  canvas.className = "wx-srv-tease-preview-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Preview of the Tease effect on your photo");

  const caption = doc.createElement("div");
  caption.className = "wx-srv-tease-preview-caption";
  caption.textContent = "This is how they will see it. They can change the size and speed.";

  root.append(canvas, caption);

  const prefersReducedMotion =
    typeof win.matchMedia === "function" &&
    win.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const img = doc.createElement("img");
  let ready = false;
  let destroyed = false;
  let rafId: number | null = null;
  let phaseMs = 0;
  let lastFrameAt: number | null = null;

  const nowMs = (): number => win.performance?.now?.() ?? Date.now();

  function draw(): void {
    if (destroyed || !ready) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(win.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round((rect.width || canvas.clientWidth || 240) * dpr));
    const height = Math.max(1, Math.round((rect.height || canvas.clientHeight || 150) * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const geo = teaseGeometry(width, height, img.naturalWidth, img.naturalHeight);
    paintPhoto(ctx, img, geo);

    const radius = computeTeaseRadius(TEASE_SIZE_DEFAULT, geo.minSide);
    const now = nowMs();
    phaseMs = advanceTeasePhase(phaseMs, now - (lastFrameAt ?? now), TEASE_SPEED_DEFAULT);
    lastFrameAt = now;

    const spot = computeTeaseCoords({
      cx: geo.cx,
      cy: geo.cy,
      Ax: Math.max(0, geo.drawW / 2 - radius),
      Ay: Math.max(0, geo.drawH / 2 - radius),
      drawX: geo.drawX,
      drawY: geo.drawY,
      drawW: geo.drawW,
      drawH: geo.drawH,
      radius,
      elapsedMs: phaseMs,
      prefersReducedMotion,
      isDragging: false,
    });
    paintTeaseMask(ctx, geo, spot.x, spot.y, radius);
  }

  const handle: TeasePreviewHandle = {
    element: root,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (rafId !== null) win.cancelAnimationFrame?.(rafId);
      rafId = null;
      img.onload = null;
      img.onerror = null;
      root.remove();
    },
  };

  function loop(): void {
    if (destroyed) return;
    // Something else removed the sheet (a lock tears the whole chat down): stop for good rather
    // than animating a detached canvas forever.
    if (!root.isConnected) {
      handle.destroy();
      return;
    }
    draw();
    // With reduced motion the cut-out is still, so one paint is all it needs.
    if (!prefersReducedMotion) {
      rafId = win.requestAnimationFrame?.(loop) ?? null;
    }
  }

  img.onload = () => {
    if (destroyed) return;
    ready = true;
    loop();
  };
  img.onerror = () => {
    // A photo that will not decode gets no preview rather than a broken box.
    if (!destroyed) root.hidden = true;
  };
  img.src = imageUrl;

  return handle;
}
