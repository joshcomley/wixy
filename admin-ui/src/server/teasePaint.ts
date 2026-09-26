// The Tease effect's maths and painting (spec/server-chat/06-view-once-media.md section 4),
// shared by the recipient's viewer (`viewOnceViewer.ts`) and the sender's compose-time preview
// (`teasePreview.ts`) so the two can never drift apart: the preview is the real renderer, not a
// look-alike. Nothing here touches the DOM beyond a caller-supplied 2D context.

export const TEASE_CYCLE_MS = 16_000;
export const TEASE_DRAG_RESUME_DELAY_MS = 1_500;
export const TEASE_EASE_DURATION_MS = 600;

/** The recipient's speed multiplier: 1 is the original 16 s loop, 2 is twice as fast. Viewer-side
 * only, like the size (the sender chooses nothing about it and nothing is stored or sent). */
export const TEASE_SPEED_MIN = 0.5;
export const TEASE_SPEED_MAX = 3;
export const TEASE_SPEED_STEP = 0.25;
export const TEASE_SPEED_DEFAULT = 1;

/** The size slider's range and default, as a percentage of the photo's shorter side. */
export const TEASE_SIZE_MIN = 6;
export const TEASE_SIZE_MAX = 35;
export const TEASE_SIZE_DEFAULT = 12;

export function computeTeaseRadius(sliderValue: number, minSide: number): number {
  return (sliderValue / 100) * minSide;
}

/**
 * Advances the animation clock by one frame. The cut-out's position is a function of this clock
 * (`elapsedMs` below), NOT of wall time, and the clock only ever moves forward by
 * `frameGapMs * speed`. That is what keeps a speed change seamless: changing `speed` alters how
 * fast the clock advances from now on and never rewrites the time already accumulated, so the
 * cut-out carries on from exactly where it is. The naive alternative, `(wallTime * speed) % cycle`,
 * jumps to a different point on the path the instant the slider moves (the same trap the
 * drag-then-resume ease exists to avoid). At speed 1 the clock equals wall time since the first
 * paint, i.e. the pre-speed-control behaviour exactly.
 */
export function advanceTeasePhase(phaseMs: number, frameGapMs: number, speed: number): number {
  return phaseMs + Math.max(0, frameGapMs) * speed;
}

export interface TeaseCoordsParams {
  cx: number;
  cy: number;
  Ax: number;
  Ay: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
  radius: number;
  /** The animation clock (see `advanceTeasePhase`), not raw elapsed wall time. */
  elapsedMs: number;
  prefersReducedMotion: boolean;
  isDragging: boolean;
  dragX?: number;
  dragY?: number;
  dragReleaseTime?: number;
  dragReleaseX?: number | undefined;
  dragReleaseY?: number | undefined;
  now?: number;
}

export function computeTeaseCoords(params: TeaseCoordsParams): { x: number; y: number } {
  const {
    cx,
    cy,
    Ax,
    Ay,
    drawX,
    drawY,
    drawW,
    drawH,
    radius,
    elapsedMs,
    prefersReducedMotion,
    isDragging,
    dragX = cx,
    dragY = cy,
    dragReleaseTime = 0,
    dragReleaseX = cx,
    dragReleaseY = cy,
    now = 0,
  } = params;

  if (prefersReducedMotion) {
    if (isDragging) {
      const spotX = Math.max(drawX + radius, Math.min(drawX + drawW - radius, dragX));
      const spotY = Math.max(drawY + radius, Math.min(drawY + drawH - radius, dragY));
      return { x: spotX, y: spotY };
    }
    const spotX = Math.max(drawX + radius, Math.min(drawX + drawW - radius, dragReleaseX));
    const spotY = Math.max(drawY + radius, Math.min(drawY + drawH - radius, dragReleaseY));
    return { x: spotX, y: spotY };
  }

  const theta = (2 * Math.PI * (elapsedMs % TEASE_CYCLE_MS)) / TEASE_CYCLE_MS;
  const autoX = cx + Ax * Math.sin(3 * theta + Math.PI / 2);
  const autoY = cy + Ay * Math.sin(2 * theta);

  if (isDragging) {
    const spotX = Math.max(drawX + radius, Math.min(drawX + drawW - radius, dragX));
    const spotY = Math.max(drawY + radius, Math.min(drawY + drawH - radius, dragY));
    return { x: spotX, y: spotY };
  }

  if (dragReleaseTime > 0) {
    const timeSinceRelease = now - dragReleaseTime;
    if (timeSinceRelease < TEASE_DRAG_RESUME_DELAY_MS) {
      return { x: dragReleaseX, y: dragReleaseY };
    }
    const easeElapsed = timeSinceRelease - TEASE_DRAG_RESUME_DELAY_MS;
    const progress = Math.min(1, easeElapsed / TEASE_EASE_DURATION_MS);
    const ease = 0.5 - 0.5 * Math.cos(Math.PI * progress);
    const spotX = (1 - ease) * dragReleaseX + ease * autoX;
    const spotY = (1 - ease) * dragReleaseY + ease * autoY;
    return { x: spotX, y: spotY };
  }

  return { x: autoX, y: autoY };
}

/** Where the photo sits inside a canvas of `width` x `height` (letterboxed, centred). */
export interface TeaseGeometry {
  width: number;
  height: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
  cx: number;
  cy: number;
  minSide: number;
}

export function teaseGeometry(
  width: number,
  height: number,
  imgW: number,
  imgH: number,
): TeaseGeometry {
  const scale = Math.min(width / imgW, height / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const drawX = (width - drawW) / 2;
  const drawY = (height - drawH) / 2;
  return {
    width,
    height,
    drawX,
    drawY,
    drawW,
    drawH,
    cx: drawX + drawW / 2,
    cy: drawY + drawH / 2,
    minSide: Math.min(drawW, drawH),
  };
}

/** Black background, then the photo letterboxed into it. */
export function paintPhoto(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  geo: TeaseGeometry,
): void {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, geo.width, geo.height);
  try {
    ctx.drawImage(image, geo.drawX, geo.drawY, geo.drawW, geo.drawH);
  } catch {
    // Fallback for jsdom without canvas implementation
  }
}

/** The Tease mask over an already-painted photo: opaque black everywhere except a circular hole
 * at (spotX, spotY), its outer 15% feathered with a radial gradient. */
export function paintTeaseMask(
  ctx: CanvasRenderingContext2D,
  geo: TeaseGeometry,
  spotX: number,
  spotY: number,
  radius: number,
): void {
  try {
    ctx.save();
    // Draw mask: everything outside the hole is solid black
    ctx.beginPath();
    ctx.rect(0, 0, geo.width, geo.height);
    ctx.arc(spotX, spotY, radius, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fillStyle = "#000000";
    ctx.fill();

    // Feathered outer 15%
    if (typeof ctx.createRadialGradient === "function") {
      const grad = ctx.createRadialGradient(spotX, spotY, radius * 0.85, spotX, spotY, radius);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, "rgba(0,0,0,1)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(spotX, spotY, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } catch {
    // Ignored if canvas 2D context is stubbed
  }
}
