// The before/after ALIGNER (decisions/00108) — a full-screen canvas dialog
// that lets the owner line up a photo pair herself: drag with a finger to
// move, pinch (or the zoom slider) to resize, tilt buttons to straighten, and
// a micro pad of arrows for the final sub-pixel nudges. Born from Purdi's
// 2026-08-02 question: "the lips are in different positions and I can't see
// how I can move the image so they match up like the others".
//
// HOW IT SHIPS: saving BAKES the adjusted photo(s) to a brand-new JPEG on an
// offscreen canvas at the exact frame aspect (what she sees in the dialog is
// what publishes — the live frame is `object-fit: cover` at the same aspect,
// which is the aligner's identity transform), uploads it through the ordinary
// media pipeline (`api.uploadMedia` — staged as a draft like any upload), and
// hands the caller the new `{src, alt}` to store in the item. The original
// photo stays in the library untouched; the site template, content schema,
// and publish pipeline needed no changes at all.
//
// The frame aspect comes from the registry (`AdminCollection.alignAspect`,
// Inv 1 — the engine never hardcodes a site's shape). All geometry lives in
// `alignerModel.ts` (pure, unit-tested); this file is the DOM/canvas shell.

import type { AdminApi } from "./api";
import {
  clampedToCoverage,
  exportSize,
  IDENTITY_TRANSFORM,
  isIdentityTransform,
  MAX_ZOOM,
  MICRO_PAN_STEP,
  MICRO_ROT_STEP_DEG,
  MICRO_ZOOM_FACTOR,
  minCoveringZoom,
  placementFor,
  withPanCompensated,
  withRotationCompensated,
  type AlignTransform,
  type NaturalSize,
} from "./alignerModel";
import { contentSrcToDisplayUrl } from "./mediaDialog";

/** One image field's side of the pair, as the dialog needs it. */
export interface AlignSide {
  /** The item's field key (e.g. "before") — echoed back so the caller can
   * write the result onto the right field without positional guessing. */
  key: string;
  /** The field's registry label ("Before photo") for the toggle + chips. */
  label: string;
  src: string;
  alt: string;
}

export interface AlignerRequest {
  /** The pair's FIRST image field (the reference layer; the "before"). */
  first: AlignSide;
  /** The pair's SECOND image field (adjusted by default; the "after"). */
  second: AlignSide;
  /** The live frame's aspect from `AdminCollection.alignAspect`. */
  aspectW: number;
  aspectH: number;
}

/** What a Save hands back: the re-baked `{src, alt}` for each side she
 * actually adjusted (a side she never touched keeps its original photo). */
export interface AlignerResult {
  first?: { src: string; alt: string };
  second?: { src: string; alt: string };
}

/** A decoded photo ready to draw — abstracted so tests can stub image
 * loading (jsdom never fires `img.onload`). */
export interface LoadedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
}

export interface AlignerDeps {
  api: AdminApi;
  win?: Window;
  loadImage?: (src: string) => Promise<LoadedImage>;
}

type SideId = "first" | "second";
type ViewMode = "blend" | "split";

const HASH8_PREFIX = /^[0-9a-f]{8}-/;
const EXTENSION = /\.[a-zA-Z0-9]+$/;

/** The upload filename for a baked photo — the original's stem (minus the
 * pipeline's `<hash8>-` content prefix, `wixy_server/media.py`) plus
 * "-aligned". The server re-slugifies and re-prefixes by content hash, so a
 * byte-identical re-bake dedupes instead of accumulating copies. */
export function alignedUploadName(src: string): string {
  const base = src.split("/").pop() ?? "photo";
  const stem = base.replace(EXTENSION, "").replace(HASH8_PREFIX, "");
  return `${stem === "" ? "photo" : stem}-aligned.jpg`;
}

function defaultLoadImage(src: string): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        reject(new Error("the photo didn't decode"));
        return;
      }
      resolve({ width: img.naturalWidth, height: img.naturalHeight, source: img });
    };
    img.onerror = () => reject(new Error("the photo couldn't be loaded"));
    // The admin document has no `<base href="/">` (only preview pages get
    // one), so the content-form src must become a root-absolute URL first —
    // the same rule as every other admin-side thumbnail (decisions/00102).
    img.src = contentSrcToDisplayUrl(src);
  });
}

export interface AlignerDialog {
  element: HTMLElement;
  teardown(): void;
}

export interface AlignerDialogCallbacks {
  /** EXACTLY once: the baked result on Save, or `null` on cancel/close. */
  onDone: (result: AlignerResult | null) => void;
}

export function mountAlignerDialog(
  deps: AlignerDeps,
  request: AlignerRequest,
  callbacks: AlignerDialogCallbacks,
): AlignerDialog {
  const win = deps.win ?? window;
  const loadImage = deps.loadImage ?? defaultLoadImage;
  const LW = request.aspectW; // logical canvas units — resolution-independent
  const LH = request.aspectH;
  let destroyed = false;

  // -- State ---------------------------------------------------------------
  let activeSide: SideId = "second"; // the "after" is the one she usually moves
  const transforms: Record<SideId, AlignTransform> = {
    first: { ...IDENTITY_TRANSFORM },
    second: { ...IDENTITY_TRANSFORM },
  };
  let mode: ViewMode = "blend";
  let blendOpacityPct = 55;
  let splitPct = 50;
  let images: Record<SideId, LoadedImage> | null = null;
  let loadFailed = false;
  let busy = false;

  const sideOf = (id: SideId): AlignSide => (id === "first" ? request.first : request.second);
  const otherSide = (id: SideId): SideId => (id === "first" ? "second" : "first");

  // -- DOM skeleton ----------------------------------------------------------
  // Its OWN `.wx-align-*` classes throughout — never the media dialog's or
  // add-flow's (the section panel can stack dialogs; shared classes made two
  // dialogs indistinguishable to selectors once before, decisions/00098's
  // add-flow comment).
  const backdrop = document.createElement("div");
  backdrop.className = "wx-align-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "wx-align-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Line up the photos");
  backdrop.appendChild(dialog);

  const header = document.createElement("div");
  header.className = "wx-drawer-header";
  const heading = document.createElement("h3");
  heading.textContent = "Line up the photos";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wx-drawer-close";
  closeButton.textContent = "✕";
  closeButton.setAttribute("aria-label", "Cancel");
  closeButton.addEventListener("click", () => finish(null));
  header.append(heading, closeButton);

  const hint = document.createElement("p");
  hint.className = "wx-align-hint";
  hint.textContent =
    "Drag a photo with one finger to move it. Pinch — or use the zoom slider — to resize. " +
    "The little arrows make tiny nudges. Saving makes a NEW photo; your original stays in the media library.";

  const canvasWrap = document.createElement("div");
  canvasWrap.className = "wx-align-canvas-wrap";
  canvasWrap.style.aspectRatio = `${request.aspectW} / ${request.aspectH}`;
  const canvas = document.createElement("canvas");
  canvas.className = "wx-align-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    "Alignment preview — drag to move the photo, or use the controls below",
  );
  const canvasNote = document.createElement("div");
  canvasNote.className = "wx-align-canvas-note";
  canvasNote.textContent = "Loading photos…";
  const firstChip = document.createElement("span");
  firstChip.className = "wx-align-chip wx-align-chip-first";
  firstChip.textContent = request.first.label;
  const secondChip = document.createElement("span");
  secondChip.className = "wx-align-chip wx-align-chip-second";
  secondChip.textContent = request.second.label;
  canvasWrap.append(canvas, canvasNote, firstChip, secondChip);

  // -- Controls --------------------------------------------------------------
  function buildSegmented(
    label: string,
    options: ReadonlyArray<{ id: string; text: string }>,
    initialId: string,
    onPick: (id: string) => void,
  ): { row: HTMLElement; buttons: Map<string, HTMLButtonElement> } {
    const row = document.createElement("div");
    row.className = "wx-align-row";
    const labelEl = document.createElement("span");
    labelEl.className = "wx-align-row-label";
    labelEl.textContent = label;
    const seg = document.createElement("div");
    seg.className = "wx-align-seg";
    const buttons = new Map<string, HTMLButtonElement>();
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wx-align-seg-button";
      button.textContent = option.text;
      button.dataset["id"] = option.id;
      button.addEventListener("click", () => onPick(option.id));
      buttons.set(option.id, button);
      seg.appendChild(button);
    }
    row.append(labelEl, seg);
    const active = buttons.get(initialId);
    if (active !== undefined) active.classList.add("wx-align-seg-button-active");
    return { row, buttons };
  }

  function refreshSeg(buttons: Map<string, HTMLButtonElement>, pickedId: string): void {
    for (const [id, button] of buttons) {
      button.classList.toggle("wx-align-seg-button-active", id === pickedId);
    }
  }

  const moveSeg = buildSegmented(
    "Move",
    [
      { id: "first", text: request.first.label },
      { id: "second", text: request.second.label },
    ],
    activeSide,
    (id) => {
      activeSide = id as SideId;
      refreshSeg(moveSeg.buttons, activeSide);
      syncControls();
      redrawCanvas();
    },
  );

  const viewSeg = buildSegmented(
    "View",
    [
      { id: "blend", text: "Blend" },
      { id: "split", text: "Split" },
    ],
    mode,
    (id) => {
      mode = id as ViewMode;
      refreshSeg(viewSeg.buttons, mode);
      syncControls();
      redrawCanvas();
    },
  );

  // Blend see-through slider (Blend mode) / compare position (Split mode).
  const blendRow = document.createElement("div");
  blendRow.className = "wx-align-row";
  const blendLabel = document.createElement("span");
  blendLabel.className = "wx-align-row-label";
  blendLabel.textContent = "See-through";
  const blendSlider = document.createElement("input");
  blendSlider.type = "range";
  blendSlider.className = "wx-align-slider";
  blendSlider.min = "5";
  blendSlider.max = "95";
  blendSlider.step = "1";
  blendSlider.value = String(blendOpacityPct);
  blendSlider.setAttribute("aria-label", "How see-through the moving photo is");
  blendSlider.addEventListener("input", () => {
    blendOpacityPct = Number(blendSlider.value);
    redrawCanvas();
  });
  blendRow.append(blendLabel, blendSlider);

  const splitRow = document.createElement("div");
  splitRow.className = "wx-align-row";
  const splitLabel = document.createElement("span");
  splitLabel.className = "wx-align-row-label";
  splitLabel.textContent = "Compare";
  const splitSlider = document.createElement("input");
  splitSlider.type = "range";
  splitSlider.className = "wx-align-slider";
  splitSlider.min = "0";
  splitSlider.max = "100";
  splitSlider.step = "1";
  splitSlider.value = String(splitPct);
  splitSlider.setAttribute("aria-label", "Where the before/after split sits");
  splitSlider.addEventListener("input", () => {
    splitPct = Number(splitSlider.value);
    redrawCanvas();
  });
  splitRow.append(splitLabel, splitSlider);

  // -- Micro pad (the operator's explicit ask: buttons for the final nudges) --
  const pad = document.createElement("div");
  pad.className = "wx-align-pad";

  /** A micro button that fires once on press, then repeats while held. */
  function microButton(
    text: string,
    ariaLabel: string,
    act: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wx-align-pad-button";
    button.textContent = text;
    button.setAttribute("aria-label", ariaLabel);
    let repeatDelay: ReturnType<typeof setTimeout> | null = null;
    let repeatInterval: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
      if (repeatDelay !== null) clearTimeout(repeatDelay);
      if (repeatInterval !== null) clearInterval(repeatInterval);
      repeatDelay = null;
      repeatInterval = null;
    };
    button.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
      if (busy || images === null) return;
      act();
      stop();
      repeatDelay = setTimeout(() => {
        repeatInterval = setInterval(act, 90);
      }, 350);
    });
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("pointerleave", stop);
    return button;
  }

  function panActive(ddx: number, ddy: number): void {
    if (images === null) return;
    const nat = naturalOf(activeSide);
    const base = transforms[activeSide];
    // Compensated, so a nudge always visibly moves the photo (a plain clamp
    // makes ←/→ dead at zoom 1 on a width-limited image — the first thing
    // she'd report). The tiny auto-zoom this can cost is the price of the
    // photo never showing a gap.
    transforms[activeSide] = withPanCompensated(
      nat,
      LW,
      LH,
      base,
      base.dx + ddx,
      base.dy + ddy,
      MAX_ZOOM,
    );
    syncControls();
    redrawCanvas();
  }

  function zoomActive(factor: number): void {
    if (images === null) return;
    const nat = naturalOf(activeSide);
    const base = transforms[activeSide];
    transforms[activeSide] = clampedToCoverage(nat, LW, LH, base, {
      ...base,
      zoom: Math.min(MAX_ZOOM, base.zoom * factor),
    });
    syncControls();
    redrawCanvas();
  }

  function rotActive(deltaDeg: number): void {
    if (images === null) return;
    const nat = naturalOf(activeSide);
    const base = transforms[activeSide];
    // A tilt must visibly HAPPEN — `withRotationCompensated` pays for it with
    // the smallest auto-zoom that keeps the corners covered, instead of a
    // plain clamp bisecting the tilt itself back to ≈0° at zoom 1.
    const next = withRotationCompensated(nat, LW, LH, base, base.rotDeg + deltaDeg, MAX_ZOOM);
    if (next === null || next.rotDeg === base.rotDeg) return; // refused (edge pan) or at the clamp
    transforms[activeSide] = next;
    syncControls();
    redrawCanvas();
  }

  function resetActive(): void {
    transforms[activeSide] = { ...IDENTITY_TRANSFORM };
    syncControls();
    redrawCanvas();
  }

  const padUp = microButton("↑", "Nudge up", () => panActive(0, -MICRO_PAN_STEP));
  const padLeft = microButton("←", "Nudge left", () => panActive(-MICRO_PAN_STEP, 0));
  const padRight = microButton("→", "Nudge right", () => panActive(MICRO_PAN_STEP, 0));
  const padDown = microButton("↓", "Nudge down", () => panActive(0, MICRO_PAN_STEP));
  const padSpacerA = document.createElement("span");
  const padSpacerB = document.createElement("span");
  const padSpacerC = document.createElement("span");
  const padSpacerD = document.createElement("span");
  const padSpacerE = document.createElement("span");
  pad.append(padSpacerA, padUp, padSpacerB, padLeft, padSpacerE, padRight, padSpacerC, padDown, padSpacerD);

  // Zoom row: − slider +
  const zoomRow = document.createElement("div");
  zoomRow.className = "wx-align-row";
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "wx-align-row-label";
  zoomLabel.textContent = "Zoom";
  const zoomOut = microButton("−", "Zoom out a little", () => zoomActive(1 / MICRO_ZOOM_FACTOR));
  const zoomSlider = document.createElement("input");
  zoomSlider.type = "range";
  zoomSlider.className = "wx-align-slider";
  zoomSlider.min = "1";
  zoomSlider.max = String(MAX_ZOOM);
  zoomSlider.step = "0.005";
  zoomSlider.value = "1";
  zoomSlider.setAttribute("aria-label", "Zoom");
  zoomSlider.addEventListener("input", () => {
    if (images === null) return;
    const nat = naturalOf(activeSide);
    const base = transforms[activeSide];
    transforms[activeSide] = clampedToCoverage(nat, LW, LH, base, {
      ...base,
      zoom: Number(zoomSlider.value),
    });
    syncControls();
    redrawCanvas();
  });
  const zoomIn = microButton("+", "Zoom in a little", () => zoomActive(MICRO_ZOOM_FACTOR));
  zoomRow.append(zoomLabel, zoomOut, zoomSlider, zoomIn);

  // Tilt row: straighten a handheld shot by fractions of a degree.
  const tiltRow = document.createElement("div");
  tiltRow.className = "wx-align-row";
  const tiltLabel = document.createElement("span");
  tiltLabel.className = "wx-align-row-label";
  tiltLabel.textContent = "Straighten";
  const tiltLeft = microButton("⟲", "Tilt anticlockwise", () => rotActive(-MICRO_ROT_STEP_DEG));
  const tiltReadout = document.createElement("span");
  tiltReadout.className = "wx-align-tilt-readout";
  tiltReadout.textContent = "0°";
  const tiltRight = microButton("⟳", "Tilt clockwise", () => rotActive(MICRO_ROT_STEP_DEG));
  tiltRow.append(tiltLabel, tiltLeft, tiltReadout, tiltRight);

  const controlsWrap = document.createElement("div");
  controlsWrap.className = "wx-align-controls";
  controlsWrap.append(moveSeg.row, viewSeg.row, blendRow, splitRow, pad, zoomRow, tiltRow);

  const errorLine = document.createElement("p");
  errorLine.className = "wx-align-error";
  errorLine.hidden = true;

  const saveRow = document.createElement("div");
  saveRow.className = "wx-align-save-row";
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "wx-media-delete";
  resetButton.textContent = "Start over";
  resetButton.title = "Put this photo back how it was";
  resetButton.addEventListener("click", resetActive);
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "wx-media-delete";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => finish(null));
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "wx-publish-button";
  saveButton.textContent = "Save aligned photo";
  saveButton.disabled = true;
  saveButton.addEventListener("click", () => void save());
  saveRow.append(resetButton, cancelButton, saveButton);

  dialog.append(header, hint, canvasWrap, controlsWrap, errorLine, saveRow);

  // -- Drawing ---------------------------------------------------------------
  function naturalOf(id: SideId): NaturalSize {
    const loaded = images?.[id];
    // Callers guard on `images !== null` before touching geometry.
    return { width: loaded?.width ?? 1, height: loaded?.height ?? 1 };
  }

  function drawSideOn(
    ctx: CanvasRenderingContext2D,
    id: SideId,
    alpha: number,
    logicalW: number,
    logicalH: number,
  ): void {
    if (images === null) return;
    const loaded = images[id];
    const p = placementFor(naturalOf(id), logicalW, logicalH, transforms[id]);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.centerX, p.centerY);
    ctx.rotate((p.rotDeg * Math.PI) / 180);
    ctx.drawImage(loaded.source, -p.width / 2, -p.height / 2, p.width, p.height);
    ctx.restore();
  }

  function drawScene(ctx: CanvasRenderingContext2D, logicalW: number, logicalH: number): void {
    ctx.clearRect(0, 0, logicalW, logicalH);
    if (images === null) return;
    if (mode === "blend") {
      // The reference side solid underneath, the side she's moving
      // see-through on top — feature alignment by eye (the onion-skin).
      drawSideOn(ctx, otherSide(activeSide), 1, logicalW, logicalH);
      drawSideOn(ctx, activeSide, blendOpacityPct / 100, logicalW, logicalH);
    } else {
      // The live widget's own look: the "after" full-width beneath, the
      // "before" clipped on top at the split position, divider + handle.
      drawSideOn(ctx, "second", 1, logicalW, logicalH);
      const splitX = (splitPct / 100) * logicalW;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, logicalH);
      ctx.clip();
      drawSideOn(ctx, "first", 1, logicalW, logicalH);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = Math.max(2, logicalW / 320);
      ctx.beginPath();
      ctx.moveTo(splitX, 0);
      ctx.lineTo(splitX, logicalH);
      ctx.stroke();
      const handleR = logicalW / 26;
      ctx.beginPath();
      ctx.arc(splitX, logicalH / 2, handleR, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "rgba(94,70,53,0.6)";
      ctx.lineWidth = Math.max(1.5, logicalW / 480);
      const chevron = handleR * 0.45;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(splitX + dir * chevron * 0.4, logicalH / 2 - chevron * 0.7);
        ctx.lineTo(splitX + dir * chevron, logicalH / 2);
        ctx.lineTo(splitX + dir * chevron * 0.4, logicalH / 2 + chevron * 0.7);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  const displayCtx = canvas.getContext("2d");

  function sizeBackingStore(): void {
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const dpr = win.devicePixelRatio ?? 1;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
  }

  function redrawCanvas(): void {
    if (displayCtx === null) return; // jsdom — painting is a browser-only concern
    sizeBackingStore();
    if (canvas.width === 0 || canvas.height === 0) return;
    displayCtx.save();
    displayCtx.scale(canvas.width / LW, canvas.height / LH);
    drawScene(displayCtx, LW, LH);
    displayCtx.restore();
  }

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => redrawCanvas());
    resizeObserver.observe(canvasWrap);
  }

  // -- Control-state sync ------------------------------------------------------
  function syncControls(): void {
    const t = transforms[activeSide];
    const dirty =
      !isIdentityTransform(transforms.first) || !isIdentityTransform(transforms.second);
    saveButton.disabled = busy || loadFailed || images === null || !dirty;
    blendRow.hidden = mode !== "blend";
    splitRow.hidden = mode !== "split";
    blendSlider.value = String(blendOpacityPct);
    splitSlider.value = String(splitPct);
    if (images !== null) {
      const minZoom = minCoveringZoom(naturalOf(activeSide), LW, LH, t);
      zoomSlider.min = String(Math.min(MAX_ZOOM, Math.ceil(minZoom * 200) / 200));
      zoomSlider.value = String(t.zoom);
    }
    tiltReadout.textContent = `${t.rotDeg === 0 ? "0" : t.rotDeg.toFixed(2).replace(/\.?0+$/, "")}°`;
    firstChip.classList.toggle("wx-align-chip-active", activeSide === "first");
    secondChip.classList.toggle("wx-align-chip-active", activeSide === "second");
  }

  // -- Canvas gestures: one finger pans, two fingers pinch-zoom + move ---------
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchStart: { distance: number; zoom: number } | null = null;

  function canvasPoint(evt: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  canvas.addEventListener("pointerdown", (evt) => {
    if (busy || images === null) return;
    evt.preventDefault();
    canvas.setPointerCapture(evt.pointerId);
    pointers.set(evt.pointerId, canvasPoint(evt));
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      if (a !== undefined && b !== undefined) {
        pinchStart = {
          distance: Math.hypot(a.x - b.x, a.y - b.y),
          zoom: transforms[activeSide].zoom,
        };
      }
    }
  });

  canvas.addEventListener("pointermove", (evt) => {
    if (busy || images === null || !pointers.has(evt.pointerId)) return;
    evt.preventDefault();
    const previous = pointers.get(evt.pointerId);
    const current = canvasPoint(evt);
    pointers.set(evt.pointerId, current);
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || previous === undefined) return;

    if (pointers.size === 1) {
      // One finger: pan — a CSS-pixel drag maps to the same FRACTION of the
      // canvas width (the model's pan unit) on both axes.
      panActive((current.x - previous.x) / rect.width, (current.y - previous.y) / rect.width);
    } else if (pointers.size === 2) {
      // Two fingers: pinch zooms (about the canvas centre — the coverage
      // clamp keeps the edges closed), the pair's movement pans.
      const [a, b] = Array.from(pointers.values());
      if (a === undefined || b === undefined) return;
      if (pinchStart !== null && pinchStart.distance > 0) {
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const nat = naturalOf(activeSide);
        const base = transforms[activeSide];
        transforms[activeSide] = clampedToCoverage(nat, LW, LH, base, {
          ...base,
          zoom: Math.min(MAX_ZOOM, pinchStart.zoom * (distance / pinchStart.distance)),
        });
      }
      panActive((current.x - previous.x) / rect.width, (current.y - previous.y) / rect.width);
    }
  });

  function endPointer(evt: PointerEvent): void {
    pointers.delete(evt.pointerId);
    if (pointers.size < 2) pinchStart = null;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  // Keyboard parity for the micro pad (desktop + a11y).
  canvas.addEventListener("keydown", (evt) => {
    if (busy || images === null) return;
    const step = evt.shiftKey ? MICRO_PAN_STEP * 10 : MICRO_PAN_STEP;
    if (evt.key === "ArrowLeft") panActive(-step, 0);
    else if (evt.key === "ArrowRight") panActive(step, 0);
    else if (evt.key === "ArrowUp") panActive(0, -step);
    else if (evt.key === "ArrowDown") panActive(0, step);
    else if (evt.key === "+" || evt.key === "=") zoomActive(MICRO_ZOOM_FACTOR);
    else if (evt.key === "-") zoomActive(1 / MICRO_ZOOM_FACTOR);
    else return;
    evt.preventDefault();
  });

  // -- Save: bake each adjusted side, upload, hand back -------------------------
  async function bakeSide(id: SideId): Promise<{ src: string; alt: string }> {
    if (images === null) throw new Error("photos aren't loaded yet");
    const size = exportSize(request.aspectW, request.aspectH);
    const bakeCanvas = document.createElement("canvas");
    bakeCanvas.width = size.width;
    bakeCanvas.height = size.height;
    const ctx = bakeCanvas.getContext("2d");
    if (ctx === null) throw new Error("this browser couldn't prepare the photo");
    ctx.fillStyle = "#ffffff"; // JPEG has no transparency — never let a gap go black
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.scale(size.width / LW, size.height / LH);
    drawSideOn(ctx, id, 1, LW, LH);
    const blob = await new Promise<Blob | null>((resolve) => {
      bakeCanvas.toBlob((b) => resolve(b), "image/jpeg", 0.92);
    });
    if (blob === null) throw new Error("this browser couldn't prepare the photo");
    const side = sideOf(id);
    const file = new File([blob], alignedUploadName(side.src), { type: "image/jpeg" });
    const uploaded = await deps.api.uploadMedia(file);
    return { src: uploaded.contentSrc, alt: side.alt };
  }

  function setBusy(nextBusy: boolean): void {
    busy = nextBusy;
    cancelButton.disabled = nextBusy;
    resetButton.disabled = nextBusy;
    closeButton.disabled = nextBusy;
    saveButton.textContent = nextBusy ? "Saving…" : "Save aligned photo";
    if (nextBusy) {
      saveButton.disabled = true;
    } else {
      syncControls();
    }
  }

  async function save(): Promise<void> {
    if (busy || images === null) return;
    errorLine.hidden = true;
    setBusy(true);
    try {
      const result: AlignerResult = {};
      if (!isIdentityTransform(transforms.first)) result.first = await bakeSide("first");
      if (destroyed) return;
      if (!isIdentityTransform(transforms.second)) result.second = await bakeSide("second");
      if (destroyed) return;
      // Not `finish()` — that one is busy-guarded against cancel-during-save;
      // this IS the save completing, the one legitimate busy-path outcome.
      callbacks.onDone(result);
    } catch (error) {
      if (destroyed) return;
      setBusy(false);
      errorLine.textContent = `Couldn't save the aligned photo — ${
        error instanceof Error ? error.message : "please try again"
      }. Your original photos are untouched.`;
      errorLine.hidden = false;
    }
  }

  // -- Lifecycle ---------------------------------------------------------------
  function finish(result: AlignerResult | null): void {
    if (busy) return; // a Save in flight owns the outcome now
    callbacks.onDone(result);
  }

  backdrop.addEventListener("click", (evt) => {
    if (evt.target === backdrop) finish(null);
  });
  const keydownListener = (evt: KeyboardEvent): void => {
    if (evt.key === "Escape") finish(null);
  };
  win.addEventListener("keydown", keydownListener);

  // Load both photos, then paint. A failed load keeps the dialog open (she can
  // still cancel) but Save stays disabled with a plain-English reason showing.
  Promise.all([loadImage(request.first.src), loadImage(request.second.src)])
    .then(([firstLoaded, secondLoaded]) => {
      if (destroyed) return;
      images = { first: firstLoaded, second: secondLoaded };
      canvasNote.hidden = true;
      syncControls();
      redrawCanvas();
    })
    .catch(() => {
      if (destroyed) return;
      loadFailed = true;
      canvasNote.textContent = "One of the photos couldn't be loaded — please close this and try again.";
      syncControls();
    });

  syncControls();

  return {
    element: backdrop,
    teardown(): void {
      destroyed = true;
      resizeObserver?.disconnect(); // else it pins the removed dialog's DOM forever
      win.removeEventListener("keydown", keydownListener);
    },
  };
}

/** The single entry point callers use — mounts onto `document.body`, tears
 * itself down, and calls `respond` EXACTLY once (mirrors `openMediaDialog`). */
export function openAlignerDialog(
  deps: AlignerDeps,
  request: AlignerRequest,
  respond: (result: AlignerResult | null) => void,
): void {
  let dialog: AlignerDialog | null = null;
  function finish(result: AlignerResult | null): void {
    dialog?.teardown();
    dialog?.element.remove();
    dialog = null;
    respond(result);
  }
  dialog = mountAlignerDialog(deps, request, { onDone: finish });
  document.body.appendChild(dialog.element);
}
