// Live drawing — the pen tool in the Server chat (spec/server-chat/07-live-drawing.md). This
// module owns everything a person sees and touches: the header's Pen button and its toolbar,
// the Draw surface over the thread, the drawings themselves (one `<svg>` each, laid over the
// thread and scrolling with it), other people's strokes arriving live, and Select mode.
// `thread.ts` mounts it and feeds it the thread's own events; the pure pieces live beside it
// (`drawingGeometry.ts`, `drawGesture.ts`, `drawingLive.ts`, `drawingModel.ts`,
// `drawingSync.ts`).
//
// Layout (§1): every drawing is anchored to a message bubble by `seq` and positioned from the
// LIVE DOM on every layout change — never from a copied position — so it stays on its message
// through new messages, images loading, reactions, history paging, a resize and a rotation. The
// layer sits inside `.wx-srv-thread-content` (the wrapper around the message list), so the whole
// layer moves with the list and only the list's own layout can move a drawing relative to it.
// Drawings are `pointer-events: none` at all times: Select mode hit-tests them geometrically from
// a tap on the thread instead (Pointer Events, §5's 12 px rule), so a drawing can never block
// scrolling, a tap on a message, the ⋯ menu, or any of the lock gestures.
//
// Lifecycle: a lock (`detach`) turns the pen off — cancelling a stroke in progress with a live
// `cancel` sent at once, before the token is let go — removes the Draw surface, drops every live
// preview, and clears every timer and observer. Stored and pending drawings stay in memory, like
// the thread's messages and draft; strokes still waiting to be stored resume with the next
// unlock's token.

import {
  appendStroke,
  createDrawing,
  deleteDrawing,
  getDrawings,
  parseDrawingSummaries,
  postLiveBatch,
  type LiveFrame,
  type LivePostResult,
} from "./api/drawings";
import { ServerLockedError } from "./api/http";
import type { Message } from "./api/messages";
import { createDrawGesture, type DrawGestureEffect } from "./drawGesture";
import {
  chooseAnchor,
  declaredColumnWidth,
  drawScale,
  hitTestDrawings,
  pathData,
  prepareStoredPoints,
  segmentsPathData,
  strokesBounds,
  svgBox,
  toDrawSpace,
  wirePoint,
  type Bounds,
  type HitCandidate,
  type SvgBox,
} from "./drawingGeometry";
import { createLiveReceiver, createLiveSender, type LiveStroke, type OutgoingLiveFrame } from "./drawingLive";
import { createDrawingModel, type ModelDrawing, type ModelStroke } from "./drawingModel";
import {
  DEFAULT_DRAWING_COLOR,
  DEFAULT_DRAWING_WIDTH,
  DRAWING_COLORS,
  DRAWING_COLOR_LABELS,
  DRAWING_WIDTHS,
  DRAWING_WIDTH_LABELS,
  DRAWING_Y_SPLIT_PX,
  LIVE_STROKE_TIMEOUT_MS,
  MAX_DRAWINGS_PER_ANCHOR,
  MAX_STROKES_PER_DRAWING,
  type DrawingColor,
  type DrawingWidth,
} from "./drawings";
import { createDrawingSync, type DrawingLossReason, type DrawingSyncApi } from "./drawingSync";
import { TAP_MAX_MS, TAP_SLOP_PX } from "./constants";
import type { ServerIdentity } from "./identity";
import type { LockHooks, ServerSession } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
/** How long a toolbar notice ("Couldn't delete the drawing…") stays up. */
const STATUS_MS = 5_000;
/** How often stale live previews are swept while any are on screen. */
const LIVE_SWEEP_MS = 1_000;
/** The dashed selection outline sits this far outside the drawing's own box. */
const SELECTION_PAD_PX = 4;
/** How long after a tap that selected a drawing its own click is swallowed. */
const SWALLOW_CLICK_MS = 700;

export type PenMode = "draw" | "select";

export interface DrawingAnchor {
  readonly seq: number;
  readonly element: HTMLElement;
}

export interface DrawingLiveApi {
  postLiveBatch(
    session: ServerSession,
    frame: Omit<LiveFrame, "cancel"> & { readonly cancel?: boolean },
  ): Promise<LivePostResult>;
}

export interface DrawingLayerDeps {
  readonly document: Document;
  readonly win: Window;
  readonly hooks: LockHooks;
  readonly identity: ServerIdentity;
  /** `.wx-srv-thread`, the one scroll region. */
  readonly thread: HTMLElement;
  /** `.wx-srv-thread-wrap` (position: relative): hosts the Draw surface over the thread. */
  readonly threadWrap: HTMLElement;
  /** `.wx-srv-thread-content` (position: relative): hosts the drawing layer. */
  readonly content: HTMLElement;
  /** `.wx-srv-message-list`: the thread column (draw space's x origin and width, §1). */
  readonly column: HTMLElement;
  /** Confirmed, on-screen message bubbles, oldest first. */
  anchors(): readonly DrawingAnchor[];
  /** A confirmed, on-screen bubble by `seq`, or null. */
  anchorElement(seq: number): HTMLElement | null;
  /** Holds the thread where it is (no stick-to-bottom) until the returned release runs. */
  holdScroll(): () => void;
  /** Drawings changed the thread's height from outside this screen's own pen. */
  onRemoteContent(): void;
  /** Injectable for tests; the real HTTP client by default. */
  readonly api?: DrawingSyncApi & DrawingLiveApi;
  /** Injectable clock for tests; `performance.now()` by default. */
  readonly now?: () => number;
  /** Called whenever pen mode turns on or off (e.g. for header cog swap). */
  readonly onPenChange?: (penOn: boolean) => void;
}

export interface DrawingLayer {
  /** The header's Pen button (§5). */
  readonly penButton: HTMLButtonElement;
  /** The header's Undo button. */
  readonly undoButton: HTMLButtonElement;
  /** The header's Redo button. */
  readonly redoButton: HTMLButtonElement;
  /** The pen toolbar, placed between the header and the thread. */
  readonly toolbar: HTMLElement;
  /** The collapse affordance on the toolbar. */
  readonly collapseButton: HTMLButtonElement;
  attach(session: ServerSession): void;
  detach(): void;
  teardown(): void;
  /** After every thread render: the confirmed messages, oldest first. */
  syncMessages(messages: readonly Message[]): void;
  handleLive(frame: LiveFrame): void;
  messageDeleted(seq: number): void;
  wiped(): void;
  /** True while a finger (or mouse) is drawing a stroke. */
  isStrokeActive(): boolean;
  /** Re-reads every drawing's position from the live DOM (also runs on its own on resize). */
  relayout(): void;
  /** True while pen is on (in draw or select mode). */
  isPenOn(): boolean;
  /** Undoes the most recent stroke drawn in this session. */
  undo(): void;
  /** Redoes the most recent undone stroke. */
  redo(): void;
  /** Immediately exits draw mode and abandons this session's drawings. */
  abandon(): void;
}

interface Frame {
  /** The content wrapper's box, in client px. */
  readonly contentLeft: number;
  readonly contentTop: number;
  /** The column's left edge and width, in content px. */
  readonly columnLeft: number;
  readonly columnWidth: number;
  /** The thread's visible width, in content px: nothing is drawn outside it. */
  readonly clipLeft: number;
  readonly clipRight: number;
}

interface SvgView {
  readonly svg: SVGSVGElement;
  readonly paths: Map<string, SVGPathElement>;
  bounds: Bounds | null;
  box: SvgBox | null;
}

interface ActiveStroke {
  readonly key: string;
  readonly strokeId: string;
  readonly releaseHold: () => void;
}

const SVG_ATTRS = { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

function newId(win: Window): string {
  const cryptoObj = win.crypto;
  if (typeof cryptoObj?.randomUUID === "function") return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function mountDrawingLayer(deps: DrawingLayerDeps): DrawingLayer {
  const { document: documentRef, win, hooks, identity, thread, threadWrap, content, column } = deps;
  const api: DrawingSyncApi & DrawingLiveApi = deps.api ?? {
    createDrawing,
    appendStroke,
    deleteDrawing,
    getDrawings,
    postLiveBatch,
  };
  const now = deps.now ?? ((): number => (win.performance?.now() ?? Date.now()));

  let session: ServerSession | null = null;
  let penOn = false;
  let mode: PenMode = "draw";
  let color: DrawingColor = DEFAULT_DRAWING_COLOR;
  let width: DrawingWidth = DEFAULT_DRAWING_WIDTH;
  /** §2: the drawing this pen session is adding to (null until its first stroke). */
  let sessionDrawingKey: string | null = null;
  let activeStroke: ActiveStroke | null = null;
  let selectedKey: string | null = null;
  let confirmingDelete = false;
  let torndown = false;
  /** Every drawing this page ever started: live frames for them are this screen's own echo. */
  const ownClientIds = new Set<string>();

  const model = createDrawingModel();
  const gesture = createDrawGesture();
  const drawingViews = new Map<string, SvgView>();
  const liveViews = new Map<string, SvgView>();

  // -- DOM ---------------------------------------------------------------------------------

  const penButton = documentRef.createElement("button");
  penButton.type = "button";
  penButton.className = "wx-srv-pen-button";
  // A 44px tap target around a 36px face that matches ⚙ and ✕ beside it (chat.css).
  const penFace = documentRef.createElement("span");
  penFace.className = "wx-srv-pen-face";
  penFace.setAttribute("aria-hidden", "true");
  penFace.textContent = "✎";
  penButton.appendChild(penFace);
  penButton.title = "Draw on the chat";
  penButton.setAttribute("aria-label", "Pen");
  penButton.setAttribute("aria-pressed", "false");
  penButton.setAttribute("aria-expanded", "false");
  // §5: turning the pen on opens a new mode and toolbar under the finger.
  penButton.setAttribute("data-srv-gesture-boundary", "");

  const UNDO_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>' +
    '</svg>';

  const REDO_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>' +
    '</svg>';

  const undoButton = documentRef.createElement("button");
  undoButton.type = "button";
  undoButton.className = "wx-srv-pen-undo";
  undoButton.setAttribute("aria-label", "Undo");
  undoButton.title = "Undo";
  undoButton.setAttribute("data-srv-gesture-boundary", "");
  undoButton.innerHTML = UNDO_ICON;
  undoButton.disabled = true;
  undoButton.hidden = true;
  undoButton.addEventListener("click", () => undo());

  const redoButton = documentRef.createElement("button");
  redoButton.type = "button";
  redoButton.className = "wx-srv-pen-redo";
  redoButton.setAttribute("aria-label", "Redo");
  redoButton.title = "Redo";
  redoButton.setAttribute("data-srv-gesture-boundary", "");
  redoButton.innerHTML = REDO_ICON;
  redoButton.disabled = true;
  redoButton.hidden = true;
  redoButton.addEventListener("click", () => redo());

  interface UndoRecord {
    drawingKey: string;
    readonly anchorSeq: number;
    readonly columnWidth: number;
    readonly stroke: ModelStroke;
  }

  const undoStack: UndoRecord[] = [];
  const redoStack: UndoRecord[] = [];
  const sessionDrawingKeys = new Set<string>();

  function updateUndoRedo(): void {
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
  }

  const toolbar = documentRef.createElement("div");
  toolbar.className = "wx-srv-pen-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Pen");
  toolbar.hidden = true;

  const colorGroup = documentRef.createElement("div");
  colorGroup.className = "wx-srv-pen-colors";
  colorGroup.setAttribute("role", "group");
  colorGroup.setAttribute("aria-label", "Pen colour");
  const colorButtons = new Map<DrawingColor, HTMLButtonElement>();
  for (const value of DRAWING_COLORS) {
    const button = documentRef.createElement("button");
    button.type = "button";
    button.className = "wx-srv-pen-swatch";
    button.dataset["color"] = value;
    button.setAttribute("aria-label", DRAWING_COLOR_LABELS[value]);
    button.title = DRAWING_COLOR_LABELS[value];
    const dot = documentRef.createElement("span");
    dot.className = "wx-srv-pen-swatch-dot";
    dot.style.backgroundColor = value;
    button.appendChild(dot);
    button.addEventListener("click", () => setColor(value));
    colorButtons.set(value, button);
    colorGroup.appendChild(button);
  }

  const widthGroup = documentRef.createElement("div");
  widthGroup.className = "wx-srv-pen-widths";
  widthGroup.setAttribute("role", "group");
  widthGroup.setAttribute("aria-label", "Pen thickness");
  const widthButtons = new Map<DrawingWidth, HTMLButtonElement>();
  for (const value of DRAWING_WIDTHS) {
    const button = documentRef.createElement("button");
    button.type = "button";
    button.className = "wx-srv-pen-width";
    button.dataset["width"] = String(value);
    button.setAttribute("aria-label", DRAWING_WIDTH_LABELS[value]);
    button.title = DRAWING_WIDTH_LABELS[value];
    const dot = documentRef.createElement("span");
    dot.className = "wx-srv-pen-width-dot";
    const size = Math.max(3, value);
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    button.appendChild(dot);
    button.addEventListener("click", () => setWidth(value));
    widthButtons.set(value, button);
    widthGroup.appendChild(button);
  }

  // Select mode's hint is the toolbar's own child, not the select group's: on a phone it takes
  // the thicknesses' place on the second line (chat.css), so the first line holds only the two
  // buttons and neither line depends on how wide the device's font is.
  const selectHint = documentRef.createElement("span");
  selectHint.className = "wx-srv-pen-hint";
  selectHint.textContent = "Tap a drawing to select it.";
  selectHint.hidden = true;
  const selectGroup = documentRef.createElement("div");
  selectGroup.className = "wx-srv-pen-select";
  selectGroup.hidden = true;
  const nextButton = documentRef.createElement("button");
  nextButton.type = "button";
  nextButton.className = "wx-srv-pen-next";
  nextButton.textContent = "Next drawing";
  nextButton.addEventListener("click", () => selectNext());
  const deleteButton = documentRef.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "wx-srv-pen-delete";
  deleteButton.textContent = "Delete drawing";
  deleteButton.disabled = true;
  // §5: it opens a confirmation under the finger, as "Delete for everyone" does.
  deleteButton.setAttribute("data-srv-gesture-boundary", "");
  deleteButton.addEventListener("click", () => openDeleteConfirm());
  selectGroup.append(nextButton, deleteButton);

  const confirmGroup = documentRef.createElement("div");
  confirmGroup.className = "wx-srv-pen-confirm";
  confirmGroup.hidden = true;
  const confirmQuestion = documentRef.createElement("p");
  confirmQuestion.className = "wx-srv-pen-confirm-question";
  confirmQuestion.textContent = "Delete this drawing for everyone?";
  const confirmDeleteButton = documentRef.createElement("button");
  confirmDeleteButton.type = "button";
  confirmDeleteButton.className = "wx-srv-pen-confirm-delete";
  confirmDeleteButton.textContent = "Delete";
  confirmDeleteButton.addEventListener("click", () => void deleteSelected());
  const confirmCancelButton = documentRef.createElement("button");
  confirmCancelButton.type = "button";
  confirmCancelButton.className = "wx-srv-pen-confirm-cancel";
  confirmCancelButton.textContent = "Cancel";
  confirmCancelButton.addEventListener("click", () => closeDeleteConfirm(true));
  confirmGroup.append(confirmQuestion, confirmDeleteButton, confirmCancelButton);

  const modeGroup = documentRef.createElement("div");
  modeGroup.className = "wx-srv-pen-modes";
  modeGroup.setAttribute("role", "group");
  modeGroup.setAttribute("aria-label", "Pen mode");
  const drawModeButton = documentRef.createElement("button");
  drawModeButton.type = "button";
  drawModeButton.className = "wx-srv-pen-mode";
  drawModeButton.dataset["mode"] = "draw";
  drawModeButton.textContent = "Draw";
  drawModeButton.addEventListener("click", () => setMode("draw"));
  const selectModeButton = documentRef.createElement("button");
  selectModeButton.type = "button";
  selectModeButton.className = "wx-srv-pen-mode";
  selectModeButton.dataset["mode"] = "select";
  selectModeButton.textContent = "Select";
  selectModeButton.addEventListener("click", () => setMode("select"));
  modeGroup.append(drawModeButton, selectModeButton);

  const collapseButton = documentRef.createElement("button");
  collapseButton.type = "button";
  collapseButton.className = "wx-srv-pen-collapse";
  collapseButton.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="18 15 12 9 6 15"/>' +
    '</svg>' +
    '<span class="wx-srv-pen-collapse-label">Collapse</span>';
  collapseButton.title = "Collapse toolbar";
  collapseButton.setAttribute("aria-label", "Collapse toolbar");
  collapseButton.addEventListener("click", () => {
    setToolbarCollapsed(true);
    penButton.focus();
  });

  const doneButton = documentRef.createElement("button");
  doneButton.type = "button";
  doneButton.className = "wx-srv-pen-done";
  doneButton.textContent = "Done";
  doneButton.addEventListener("click", () => {
    setPen(false);
    penButton.focus();
  });

  const statusLine = documentRef.createElement("p");
  statusLine.className = "wx-srv-pen-status";
  statusLine.setAttribute("role", "status");
  statusLine.setAttribute("aria-live", "polite");
  statusLine.hidden = true;

  // DOM order is the desktop line's order (and so the keyboard's); on a phone chat.css arranges
  // the same controls into two fixed lines.
  toolbar.append(colorGroup, widthGroup, selectHint, selectGroup, confirmGroup, modeGroup, collapseButton, doneButton, statusLine);

  const layer = documentRef.createElement("div");
  layer.className = "wx-srv-drawing-layer";
  layer.setAttribute("aria-hidden", "true");
  const selectionOutline = documentRef.createElement("div");
  selectionOutline.className = "wx-srv-drawing-selection";
  selectionOutline.hidden = true;
  layer.appendChild(selectionOutline);
  content.appendChild(layer);

  let surface: HTMLElement | null = null;
  let toolbarCollapsed = false;

  penButton.addEventListener("click", () => {
    if (!penOn) {
      setPen(true);
    } else {
      setToolbarCollapsed(!toolbarCollapsed);
    }
  });

  // -- Timers and observers ------------------------------------------------------------------

  let statusTimer: number | null = null;
  let sweepTimer: number | null = null;
  let frameRequest: number | null = null;
  let frameIsTimeout = false;
  const dirtyDrawings = new Set<string>();
  let resizeObserver: ResizeObserver | null = null;
  let visibilityListening = false;

  function requestFrame(callback: () => void): void {
    if (frameRequest !== null) return;
    const raf = win.requestAnimationFrame?.bind(win);
    if (raf !== undefined) {
      frameIsTimeout = false;
      frameRequest = raf(() => {
        frameRequest = null;
        callback();
      });
    } else {
      frameIsTimeout = true;
      frameRequest = win.setTimeout(() => {
        frameRequest = null;
        callback();
      }, 16);
    }
  }

  function cancelFrame(): void {
    if (frameRequest === null) return;
    if (frameIsTimeout) win.clearTimeout(frameRequest);
    else win.cancelAnimationFrame?.(frameRequest);
    frameRequest = null;
  }

  function toolbarHeight(): number {
    return toolbar.hidden || !toolbar.isConnected ? 0 : toolbar.getBoundingClientRect().height;
  }

  /** Runs `change` and keeps the thread's content exactly where it was on screen. The toolbar sits
   * ABOVE the thread, so showing it — or its height changing (a mode switch, a notice, the delete
   * question) — moves the thread's top edge and shrinks it. Without this the newest messages slid
   * under the composer when the pen came on (nothing left there to draw on), and a reader stuck to
   * the bottom was left not at the bottom while still counted as stuck: measured, the next update
   * then jumped the thread ~90 px under the pen. */
  let keepingInPlace = false;

  function keepThreadInPlace(change: () => void): void {
    // Nested calls (turning the pen off also clears a notice) are covered by the outermost one,
    // which measures the whole change once; compensating in both would count it twice.
    if (keepingInPlace) {
      change();
      return;
    }
    keepingInPlace = true;
    try {
      const before = toolbarHeight();
      change();
      const delta = toolbarHeight() - before;
      if (delta !== 0) thread.scrollTop += delta;
    } finally {
      keepingInPlace = false;
    }
  }

  function setStatus(text: string | null): void {
    if (statusTimer !== null) win.clearTimeout(statusTimer);
    statusTimer = null;
    keepThreadInPlace(() => {
      statusLine.textContent = text ?? "";
      statusLine.hidden = text === null;
    });
    if (text !== null) {
      statusTimer = win.setTimeout(() => {
        statusTimer = null;
        keepThreadInPlace(() => {
          statusLine.textContent = "";
          statusLine.hidden = true;
        });
      }, STATUS_MS);
    }
  }

  function startObservers(): void {
    if (resizeObserver !== null) return;
    const Ctor = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Ctor === undefined) return; // an environment without it (a bare unit test)
    // Anything that moves or resizes the column or the thread (images loading, reactions, a
    // rotation, the toolbar appearing) re-reads every position before the next paint.
    resizeObserver = new Ctor(() => relayout());
    resizeObserver.observe(column);
    resizeObserver.observe(thread);
  }

  function stopObservers(): void {
    resizeObserver?.disconnect();
    resizeObserver = null;
  }

  function onVisibilityChange(): void {
    // §5: a drawing session ends when the page is hidden (even with the tab-lock box unticked).
    if (documentRef.visibilityState === "hidden" && penOn) endDrawingSession();
  }

  // -- Measuring and positioning ---------------------------------------------------------------

  function measureFrame(): Frame | null {
    const columnWidth = column.clientWidth;
    if (!(columnWidth > 0)) return null;
    const contentRect = content.getBoundingClientRect();
    const columnRect = column.getBoundingClientRect();
    const threadRect = thread.getBoundingClientRect();
    const threadInnerLeft = threadRect.left + thread.clientLeft;
    return {
      contentLeft: contentRect.left,
      contentTop: contentRect.top,
      columnLeft: columnRect.left - contentRect.left,
      columnWidth,
      clipLeft: threadInnerLeft - contentRect.left,
      clipRight: threadInnerLeft + thread.clientWidth - contentRect.left,
    };
  }

  /** The anchor's top edge in content px, or null when it is not on screen. */
  function anchorTop(seq: number, frame: Frame): number | null {
    const element = deps.anchorElement(seq);
    if (element === null) return null;
    return element.getBoundingClientRect().top - frame.contentTop;
  }

  function applyBox(view: SvgView, box: SvgBox | null): void {
    view.box = box;
    if (box === null) {
      view.svg.style.display = "none";
      return;
    }
    view.svg.style.display = "";
    view.svg.style.left = `${box.left}px`;
    view.svg.style.top = `${box.top}px`;
    view.svg.style.width = `${box.width}px`;
    view.svg.style.height = `${box.height}px`;
    const vb = box.viewBox;
    view.svg.setAttribute("viewBox", `${vb.minX} ${vb.minY} ${vb.maxX - vb.minX} ${vb.maxY - vb.minY}`);
  }

  function positionView(view: SvgView, anchorSeq: number, columnWidth: number, frame: Frame | null): void {
    if (frame === null || view.bounds === null) {
      applyBox(view, null);
      return;
    }
    const top = anchorTop(anchorSeq, frame);
    if (top === null) {
      applyBox(view, null);
      return;
    }
    const scale = drawScale(frame.columnWidth, columnWidth);
    applyBox(view, svgBox(view.bounds, frame.columnLeft, top, scale, frame.clipLeft, frame.clipRight));
  }

  function positionSelection(): void {
    const view = selectedKey === null ? undefined : drawingViews.get(selectedKey);
    const box = view?.box ?? null;
    if (box === null) {
      selectionOutline.hidden = true;
      return;
    }
    selectionOutline.hidden = false;
    selectionOutline.style.left = `${box.left - SELECTION_PAD_PX}px`;
    selectionOutline.style.top = `${box.top - SELECTION_PAD_PX}px`;
    selectionOutline.style.width = `${box.width + 2 * SELECTION_PAD_PX}px`;
    selectionOutline.style.height = `${box.height + 2 * SELECTION_PAD_PX}px`;
  }

  function relayout(): void {
    if (torndown) return;
    const frame = measureFrame();
    for (const [key, view] of drawingViews) {
      const drawing = model.get(key);
      if (drawing === undefined) continue;
      positionView(view, drawing.anchorSeq, drawing.columnWidth, frame);
    }
    for (const stroke of liveStrokesById()) {
      const view = liveViews.get(stroke.strokeId);
      if (view !== undefined) positionView(view, stroke.anchorSeq, stroke.columnWidth, frame);
    }
    positionSelection();
    updateSurfaceInset();
  }

  // -- Rendering -----------------------------------------------------------------------------

  function createView(): SvgView {
    const svg = documentRef.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "wx-srv-drawing");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.display = "none";
    layer.insertBefore(svg, selectionOutline);
    return { svg, paths: new Map(), bounds: null, box: null };
  }

  function createPath(strokeColor: DrawingColor, strokeWidth: DrawingWidth): SVGPathElement {
    const path = documentRef.createElementNS(SVG_NS, "path");
    for (const [name, value] of Object.entries(SVG_ATTRS)) path.setAttribute(name, value);
    // Colour and width come only from the validated palette/allowlist (drawings.ts).
    path.setAttribute("stroke", strokeColor);
    path.setAttribute("stroke-width", String(strokeWidth));
    return path;
  }

  function renderDrawing(key: string, frame: Frame | null = measureFrame()): void {
    const drawing = model.get(key);
    if (drawing === undefined) {
      removeDrawingView(key);
      return;
    }
    let view = drawingViews.get(key);
    if (view === undefined) {
      view = createView();
      view.svg.dataset["drawingKey"] = key;
      // Which message it sits on: a plain number, for tests and debugging (no content).
      view.svg.dataset["anchorSeq"] = String(drawing.anchorSeq);
      drawingViews.set(key, view);
    }
    const seen = new Set<string>();
    let previous: SVGPathElement | null = null;
    for (const stroke of drawing.strokes) {
      seen.add(stroke.strokeId);
      let path = view.paths.get(stroke.strokeId);
      if (path === undefined) {
        path = createPath(stroke.color, stroke.width);
        path.dataset["strokeId"] = stroke.strokeId;
        view.paths.set(stroke.strokeId, path);
      }
      const d = pathData(stroke.points);
      if (path.getAttribute("d") !== d) path.setAttribute("d", d);
      const expected: ChildNode | null = previous === null ? view.svg.firstChild : previous.nextSibling;
      if (expected !== path) view.svg.insertBefore(path, expected);
      previous = path;
    }
    for (const [strokeId, path] of view.paths) {
      if (!seen.has(strokeId)) {
        path.remove();
        view.paths.delete(strokeId);
      }
    }
    view.bounds = strokesBounds(drawing.strokes);
    positionView(view, drawing.anchorSeq, drawing.columnWidth, frame);
    if (key === selectedKey) positionSelection();
  }

  function removeDrawingView(key: string): void {
    drawingViews.get(key)?.svg.remove();
    drawingViews.delete(key);
    dirtyDrawings.delete(key);
    if (selectedKey === key) select(null);
  }

  function scheduleDrawingRender(key: string): void {
    dirtyDrawings.add(key);
    requestFrame(() => {
      const frame = measureFrame();
      for (const dirty of Array.from(dirtyDrawings)) renderDrawing(dirty, frame);
      dirtyDrawings.clear();
    });
  }

  function* liveStrokesById(): IterableIterator<LiveStroke> {
    yield* liveReceiver.strokes();
  }

  function renderLive(stroke: LiveStroke): void {
    let view = liveViews.get(stroke.strokeId);
    if (view === undefined) {
      view = createView();
      view.svg.classList.add("wx-srv-drawing-live");
      view.svg.dataset["anchorSeq"] = String(stroke.anchorSeq);
      const path = createPath(stroke.color, stroke.width);
      view.svg.insertBefore(path, null);
      view.paths.set(stroke.strokeId, path);
      liveViews.set(stroke.strokeId, view);
    }
    const path = view.paths.get(stroke.strokeId);
    path?.setAttribute("d", segmentsPathData(stroke.segments));
    view.bounds = strokesBounds(stroke.segments.map((points) => ({ points, width: stroke.width })));
    positionView(view, stroke.anchorSeq, stroke.columnWidth, measureFrame());
  }

  function removeLiveView(strokeId: string): void {
    liveViews.get(strokeId)?.svg.remove();
    liveViews.delete(strokeId);
  }

  function clearLive(): void {
    liveReceiver.clear();
    for (const strokeId of Array.from(liveViews.keys())) removeLiveView(strokeId);
    if (sweepTimer !== null) win.clearTimeout(sweepTimer);
    sweepTimer = null;
  }

  function ensureSweep(): void {
    if (sweepTimer !== null || liveReceiver.size === 0) return;
    sweepTimer = win.setTimeout(() => {
      sweepTimer = null;
      for (const strokeId of liveReceiver.sweep(now())) removeLiveView(strokeId);
      ensureSweep();
    }, LIVE_SWEEP_MS);
  }

  // -- The model's collaborators -----------------------------------------------------------

  function dropDrawingLocally(drawing: ModelDrawing): void {
    if (activeStroke !== null && activeStroke.key === drawing.key) abandonActiveStroke();
    if (sessionDrawingKey === drawing.key) sessionDrawingKey = null;
    removeDrawingView(drawing.key);
  }

  const sync = createDrawingSync({
    model,
    api,
    session: () => session,
    sender: () => identity.getName() ?? "",
    deviceId: () => identity.getDeviceId(),
    newId: () => {
      const id = newId(win);
      ownClientIds.add(id);
      return id;
    },
    anchorAlive: (seq) => deps.anchorElement(seq) !== null,
    onApplied(result): void {
      for (const drawing of result.removed) dropDrawingLocally(drawing);
      const frame = measureFrame();
      for (const key of result.changed) renderDrawing(key, frame);
      for (const strokeId of result.storedStrokeIds) {
        if (liveReceiver.finish(strokeId, now())) removeLiveView(strokeId);
      }
      // Only another screen's drawings can change the thread's height here; this screen's own
      // strokes being confirmed stored change nothing a reader is waiting for.
      const remote = result.removed.length > 0 || result.changed.some((key) => model.get(key)?.own !== true);
      if (remote && activeStroke === null) deps.onRemoteContent();
    },
    onLost(drawing: ModelDrawing, reason: DrawingLossReason): void {
      if (reason === "anchorFull") {
        setStatus(`That message already has ${MAX_DRAWINGS_PER_ANCHOR} drawings. Delete one to draw there.`);
      } else if (reason === "invalid") {
        setStatus("Couldn't save part of the drawing.");
      }
      if (sessionDrawingKey === drawing.key && model.get(drawing.key) === undefined) sessionDrawingKey = null;
    },
    onSplit(from: ModelDrawing, to: ModelDrawing): void {
      if (sessionDrawingKey === from.key) sessionDrawingKey = to.key;
      if (sessionDrawingKeys.has(from.key)) sessionDrawingKeys.add(to.key);
    },
    onLocked: () => hooks.lockNow("unauthorized"),
    setTimeout: (callback, ms) => win.setTimeout(callback, ms),
    clearTimeout: (id) => win.clearTimeout(id),
  });

  const liveSender = createLiveSender({
    async post(frame: OutgoingLiveFrame): Promise<LivePostResult | "locked"> {
      const current = session;
      if (current === null) return { kind: "failed" };
      try {
        return await api.postLiveBatch(current, frame);
      } catch (error) {
        if (error instanceof ServerLockedError) return "locked";
        return { kind: "failed" };
      }
    },
    onLocked: () => hooks.lockNow("unauthorized"),
    setTimeout: (callback, ms) => win.setTimeout(callback, ms),
    clearTimeout: (id) => win.clearTimeout(id),
    now,
  });

  const liveReceiver = createLiveReceiver({
    isOwnDrawing: (drawingClientId) => ownClientIds.has(drawingClientId),
    isKnownStroke: (strokeId) => model.hasStroke(strokeId),
  });

  // -- Drawing a stroke ----------------------------------------------------------------------

  /** The draw-space origin of `drawing` in CLIENT px right now, and its scale, or null. */
  function originOf(drawing: ModelDrawing): { x: number; y: number; scale: number } | null {
    const frame = measureFrame();
    const anchor = deps.anchorElement(drawing.anchorSeq);
    if (frame === null || anchor === null) return null;
    return {
      x: frame.contentLeft + frame.columnLeft,
      y: anchor.getBoundingClientRect().top,
      scale: drawScale(frame.columnWidth, drawing.columnWidth),
    };
  }

  /** The drawing a stroke starting at client (x, y) belongs to: this session's drawing when the
   * stroke fits it, otherwise a new one anchored per §1. Null (with a notice) when there is
   * nothing to draw on. */
  function drawingForStroke(clientY: number): ModelDrawing | null {
    const current = sessionDrawingKey === null ? undefined : model.get(sessionDrawingKey);
    if (current !== undefined) {
      const origin = originOf(current);
      if (
        origin !== null
        && Math.abs((clientY - origin.y) / origin.scale) <= DRAWING_Y_SPLIT_PX
        && current.strokes.length < MAX_STROKES_PER_DRAWING
      ) {
        return current;
      }
    }
    const frame = measureFrame();
    if (frame === null) return null;
    const anchor = chooseAnchor(
      deps.anchors().map((candidate) => ({ seq: candidate.seq, top: candidate.element.getBoundingClientRect().top })),
      clientY,
    );
    if (anchor === null) {
      setStatus("There's nothing to draw on yet. Send a message first.");
      return null;
    }
    if (model.forAnchor(anchor.seq).length >= MAX_DRAWINGS_PER_ANCHOR) {
      setStatus(`That message already has ${MAX_DRAWINGS_PER_ANCHOR} drawings. Delete one to draw there.`);
      return null;
    }
    const clientId = newId(win);
    ownClientIds.add(clientId);
    const drawing = model.addOwn({
      clientId,
      anchorSeq: anchor.seq,
      columnWidth: declaredColumnWidth(frame.columnWidth),
      sender: identity.getName() ?? "",
    });
    sessionDrawingKey = drawing.key;
    sessionDrawingKeys.add(drawing.key);
    return drawing;
  }

  function beginStroke(clientX: number, clientY: number): boolean {
    if (session === null) return false;
    const drawing = drawingForStroke(clientY);
    if (drawing === null) return false;
    const origin = originOf(drawing);
    if (origin === null) return false;
    const point = toDrawSpace(clientX, clientY, origin.x, origin.y, origin.scale);
    const stroke: ModelStroke = {
      strokeId: newId(win),
      color,
      width,
      points: [point],
      state: "drawing",
      sent: false,
    };
    drawing.strokes.push(stroke);
    activeStroke = { key: drawing.key, strokeId: stroke.strokeId, releaseHold: deps.holdScroll() };
    liveSender.begin(
      {
        drawingClientId: drawing.clientId ?? "",
        anchorSeq: drawing.anchorSeq,
        columnWidth: drawing.columnWidth,
        strokeId: stroke.strokeId,
        color,
        width,
      },
      wirePoint(point, drawing.columnWidth),
    );
    scheduleDrawingRender(drawing.key);
    return true;
  }

  function activeParts(): { drawing: ModelDrawing; stroke: ModelStroke } | null {
    if (activeStroke === null) return null;
    const drawing = model.get(activeStroke.key);
    const stroke = drawing?.strokes.find((candidate) => candidate.strokeId === activeStroke?.strokeId);
    return drawing === undefined || stroke === undefined ? null : { drawing, stroke };
  }

  function addStrokePoints(points: readonly (readonly [number, number])[]): void {
    const parts = activeParts();
    if (parts === null) return;
    const origin = originOf(parts.drawing);
    if (origin === null) {
      // The anchor left the screen mid-stroke (deleted): this stroke has nothing to sit on.
      cancelActiveStroke();
      return;
    }
    for (const [x, y] of points) {
      const point = toDrawSpace(x, y, origin.x, origin.y, origin.scale);
      parts.stroke.points.push(point);
      liveSender.push(wirePoint(point, parts.drawing.columnWidth));
    }
    scheduleDrawingRender(parts.drawing.key);
  }

  function finishStroke(): void {
    const parts = activeParts();
    const active = activeStroke;
    activeStroke = null;
    active?.releaseHold();
    if (parts === null) return;
    liveSender.end();
    const { drawing, stroke } = parts;
    stroke.points = prepareStoredPoints(stroke.points, drawing.columnWidth);
    if (stroke.points.length === 0) {
      removeStroke(drawing, stroke.strokeId);
      return;
    }
    stroke.state = "pending";
    renderDrawing(drawing.key);
    sync.storeStroke(drawing, stroke);

    undoStack.push({
      drawingKey: drawing.key,
      anchorSeq: drawing.anchorSeq,
      columnWidth: drawing.columnWidth,
      stroke: {
        strokeId: stroke.strokeId,
        color: stroke.color,
        width: stroke.width,
        points: stroke.points.slice(),
        state: "pending",
        sent: false,
      },
    });
    redoStack.length = 0;
    updateUndoRedo();
  }

  function undo(): void {
    if (undoStack.length === 0) return;
    const entry = undoStack.pop()!;
    redoStack.push(entry);
    updateUndoRedo();

    if (activeStroke !== null) cancelActiveStroke();

    const drawing = model.get(entry.drawingKey);
    if (drawing === undefined) return;

    liveSender.cancelStroke({
      drawingClientId: drawing.clientId ?? "",
      anchorSeq: entry.anchorSeq,
      columnWidth: entry.columnWidth,
      strokeId: entry.stroke.strokeId,
      color: entry.stroke.color,
      width: entry.stroke.width,
    });

    if (drawing.strokes.length <= 1) {
      model.remove(drawing.key);
      if (drawing.id !== null) model.tombstone(drawing.id);
      removeDrawingView(drawing.key);
      if (sessionDrawingKey === drawing.key) sessionDrawingKey = null;
      sessionDrawingKeys.delete(drawing.key);
      void sync.deleteDrawing(drawing);
    } else {
      const remainingStrokes = drawing.strokes.filter((s) => s.strokeId !== entry.stroke.strokeId);
      model.remove(drawing.key);
      if (drawing.id !== null) model.tombstone(drawing.id);
      removeDrawingView(drawing.key);
      sessionDrawingKeys.delete(drawing.key);
      void sync.deleteDrawing(drawing);

      const clientId = newId(win);
      ownClientIds.add(clientId);
      const newDrawing = model.addOwn({
        clientId,
        anchorSeq: entry.anchorSeq,
        columnWidth: entry.columnWidth,
        sender: identity.getName() ?? "",
      });
      sessionDrawingKeys.add(newDrawing.key);
      sessionDrawingKey = newDrawing.key;

      for (const item of undoStack) {
        if (item.drawingKey === entry.drawingKey) {
          item.drawingKey = newDrawing.key;
        }
      }
      for (const item of redoStack) {
        if (item.drawingKey === entry.drawingKey) {
          item.drawingKey = newDrawing.key;
        }
      }
      entry.drawingKey = newDrawing.key;

      for (const s of remainingStrokes) {
        const restored: ModelStroke = {
          strokeId: s.strokeId,
          color: s.color,
          width: s.width,
          points: s.points.slice(),
          state: "pending",
          sent: false,
        };
        newDrawing.strokes.push(restored);
        sync.storeStroke(newDrawing, restored);
      }
      renderDrawing(newDrawing.key);
    }
  }

  function redo(): void {
    if (redoStack.length === 0) return;
    const entry = redoStack.pop()!;
    undoStack.push(entry);
    updateUndoRedo();

    let drawing = sessionDrawingKey !== null ? model.get(sessionDrawingKey) : undefined;
    if (drawing === undefined || drawing.anchorSeq !== entry.anchorSeq) {
      drawing = model.get(entry.drawingKey);
    }
    if (drawing === undefined || drawing.anchorSeq !== entry.anchorSeq) {
      const clientId = newId(win);
      ownClientIds.add(clientId);
      drawing = model.addOwn({
        clientId,
        anchorSeq: entry.anchorSeq,
        columnWidth: entry.columnWidth,
        sender: identity.getName() ?? "",
      });
      sessionDrawingKeys.add(drawing.key);
      sessionDrawingKey = drawing.key;
    }
    entry.drawingKey = drawing.key;

    const strokeToRestore: ModelStroke = {
      strokeId: entry.stroke.strokeId,
      color: entry.stroke.color,
      width: entry.stroke.width,
      points: entry.stroke.points.slice(),
      state: "pending",
      sent: false,
    };
    drawing.strokes.push(strokeToRestore);
    renderDrawing(drawing.key);
    sync.storeStroke(drawing, strokeToRestore);
  }

  function abandon(): void {
    if (!penOn) return;
    if (activeStroke !== null) cancelActiveStroke();
    for (const key of Array.from(sessionDrawingKeys)) {
      const drawing = model.get(key);
      if (drawing !== undefined) {
        model.remove(key);
        if (drawing.id !== null) model.tombstone(drawing.id);
        removeDrawingView(key);
        void sync.deleteDrawing(drawing);
      }
    }
    sessionDrawingKeys.clear();
    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoRedo();
    setPen(false);
  }

  function removeStroke(drawing: ModelDrawing, strokeId: string): void {
    drawing.strokes = drawing.strokes.filter((candidate) => candidate.strokeId !== strokeId);
    if (drawing.strokes.length === 0 && drawing.id === null && sync.pendingCount(drawing.key) === 0) {
      model.remove(drawing.key);
      removeDrawingView(drawing.key);
      if (sessionDrawingKey === drawing.key) sessionDrawingKey = null;
    } else {
      renderDrawing(drawing.key);
    }
  }

  /** §4/§5: withdraw the stroke under the finger — a live `cancel`, nothing stored. */
  function cancelActiveStroke(): void {
    const parts = activeParts();
    const active = activeStroke;
    activeStroke = null;
    active?.releaseHold();
    if (active === null) return;
    liveSender.cancel();
    if (parts !== null) removeStroke(parts.drawing, parts.stroke.strokeId);
  }

  /** The stroke's drawing is gone (deleted elsewhere): stop drawing it, without touching the
   * model a second time. */
  function abandonActiveStroke(): void {
    const active = activeStroke;
    activeStroke = null;
    active?.releaseHold();
    if (active !== null) liveSender.cancel();
    gesture.reset();
  }

  /** §2/§5: the drawing session ends (pen off, a lock, the page hiding, a wipe). */
  function endDrawingSession(): void {
    gesture.reset();
    cancelActiveStroke();
    sessionDrawingKey = null;
  }

  function applyGestureEffects(effects: readonly DrawGestureEffect[], coalesced: readonly (readonly [number, number])[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case "strokeStart":
          if (!beginStroke(effect.x, effect.y)) gesture.reset();
          break;
        case "strokePoint":
          // Points of one DOM event are applied together below, with one layout read.
          break;
        case "strokeEnd":
          if (coalesced.length > 0) addStrokePoints(coalesced);
          finishStroke();
          return;
        case "strokeCancel":
          cancelActiveStroke();
          break;
        case "panStart":
        case "panEnd":
          break;
        case "panBy":
          thread.scrollTop += effect.dy;
          break;
      }
    }
    if (coalesced.length > 0) addStrokePoints(coalesced);
  }

  function collectPoints(effects: readonly DrawGestureEffect[]): Array<readonly [number, number]> {
    const points: Array<readonly [number, number]> = [];
    for (const effect of effects) if (effect.type === "strokePoint") points.push([effect.x, effect.y]);
    return points;
  }

  function onSurfacePointerDown(event: PointerEvent): void {
    const effects = gesture.handle({
      type: "down",
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      x: event.clientX,
      y: event.clientY,
      t: now(),
    });
    if (gesture.phase !== "idle") {
      try {
        surface?.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser already released: nothing to capture.
      }
    }
    // A mouse or pen drag must never select text or move focus; touch never does either here
    // (`touch-action: none`).
    if (event.pointerType !== "touch") event.preventDefault();
    applyGestureEffects(effects, collectPoints(effects));
  }

  function onSurfacePointerMove(event: PointerEvent): void {
    if (gesture.phase === "idle") return;
    const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const events = samples.length > 0 ? samples : [event];
    const effects: DrawGestureEffect[] = [];
    for (const sample of events) {
      effects.push(...gesture.handle({
        type: "move",
        pointerId: event.pointerId,
        x: sample.clientX,
        y: sample.clientY,
        t: now(),
      }));
    }
    applyGestureEffects(effects.filter((effect) => effect.type !== "strokePoint"), collectPoints(effects));
  }

  function onSurfacePointerUp(event: PointerEvent): void {
    const effects = gesture.handle({ type: "up", pointerId: event.pointerId, x: event.clientX, y: event.clientY, t: now() });
    applyGestureEffects(effects, collectPoints(effects));
  }

  function onSurfacePointerCancel(event: PointerEvent): void {
    applyGestureEffects(gesture.handle({ type: "cancel", pointerId: event.pointerId, t: now() }), []);
  }

  function onSurfaceWheel(event: WheelEvent): void {
    // §5: with a mouse the wheel scrolls as usual. The surface is not inside the scroller, so
    // the scroll is passed on by hand. A ctrl+wheel is a trackpad pinch: zoom stays off.
    event.preventDefault();
    if (event.ctrlKey) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? thread.clientHeight : 1;
    thread.scrollTop += event.deltaY * unit;
  }

  function updateSurfaceInset(): void {
    if (surface === null) return;
    // Leave a desktop scrollbar uncovered, so it can still be dragged while drawing.
    const scrollbar = Math.max(0, thread.offsetWidth - thread.clientWidth - thread.clientLeft * 2);
    surface.style.right = `${scrollbar}px`;
  }

  function mountSurface(): void {
    if (surface !== null) return;
    const element = documentRef.createElement("div");
    element.className = "wx-srv-draw-surface";
    element.setAttribute("aria-hidden", "true");
    // §5: in Draw mode the surface is EXCLUDED from the double-tap lock, as the typing box is —
    // rapid dots are content. Escape and the ✕ still lock at once.
    element.setAttribute("data-srv-gesture-exempt", "");
    element.addEventListener("pointerdown", onSurfacePointerDown);
    element.addEventListener("pointermove", onSurfacePointerMove);
    element.addEventListener("pointerup", onSurfacePointerUp);
    element.addEventListener("pointercancel", onSurfacePointerCancel);
    element.addEventListener("wheel", onSurfaceWheel, { passive: false });
    element.addEventListener("contextmenu", (event) => event.preventDefault());
    threadWrap.appendChild(element);
    surface = element;
    updateSurfaceInset();
  }

  function unmountSurface(): void {
    surface?.remove();
    surface = null;
  }

  // -- Select mode -------------------------------------------------------------------------

  function hitCandidates(frame: Frame): HitCandidate[] {
    const candidates: HitCandidate[] = [];
    for (const [key, view] of drawingViews) {
      const drawing = model.get(key);
      if (drawing === undefined || view.box === null) continue;
      const top = anchorTop(drawing.anchorSeq, frame);
      if (top === null) continue;
      candidates.push({
        key,
        originX: frame.columnLeft,
        originY: top,
        scale: drawScale(frame.columnWidth, drawing.columnWidth),
        strokes: drawing.strokes,
      });
    }
    return candidates;
  }

  // Select mode's taps are recognised from Pointer Events with the SAME rule the lock's own tap
  // recognizer uses (gestures.ts: moved <= TAP_SLOP_PX, held <= TAP_MAX_MS, never cancelled by
  // the browser taking the touch over for a scroll), so a scroll never selects and "a tap" means
  // one thing across the chat. Never `click`: a touch tap is not guaranteed to produce one
  // (measured in Chromium's phone emulation: pointerup, and no click at all), and a click that
  // comes from the keyboard has no position.
  let selectTap: { readonly pointerId: number; readonly x: number; readonly y: number; readonly at: number } | null = null;
  /** A tap that selected a drawing must not ALSO act on what is under it (a link, a photo). */
  let swallowClickUntil = 0;

  function onThreadPointerDown(event: PointerEvent): void {
    if (!penOn || mode !== "select" || !event.isPrimary || event.button !== 0) return;
    selectTap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: now() };
  }

  function onThreadPointerUp(event: PointerEvent): void {
    const tap = selectTap;
    selectTap = null;
    if (tap === null || !penOn || mode !== "select" || event.pointerId !== tap.pointerId) return;
    if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_SLOP_PX) return;
    if (now() - tap.at > TAP_MAX_MS) return;
    const frame = measureFrame();
    if (frame === null) return;
    const hit = hitTestDrawings(tap.x - frame.contentLeft, tap.y - frame.contentTop, hitCandidates(frame));
    if (hit !== null) {
      select(hit);
      swallowClickUntil = now() + SWALLOW_CLICK_MS;
    } else if (selectedKey !== null) {
      select(null);
    }
  }

  function onThreadPointerCancel(): void {
    selectTap = null;
  }

  function onThreadClickCapture(event: MouseEvent): void {
    if (swallowClickUntil === 0) return;
    const swallow = now() <= swallowClickUntil;
    swallowClickUntil = 0;
    if (swallow) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function listenForSelectTaps(on: boolean): void {
    const method = on ? "addEventListener" : "removeEventListener";
    thread[method]("pointerdown", onThreadPointerDown as EventListener, true);
    thread[method]("pointerup", onThreadPointerUp as EventListener, true);
    thread[method]("pointercancel", onThreadPointerCancel, true);
    thread[method]("click", onThreadClickCapture as EventListener, true);
    thread.classList.toggle("wx-srv-thread-selecting", on);
    if (!on) {
      selectTap = null;
      swallowClickUntil = 0;
    }
  }

  function select(key: string | null): void {
    if (selectedKey === key) return;
    if (selectedKey !== null) drawingViews.get(selectedKey)?.svg.classList.remove("wx-srv-drawing-selected");
    selectedKey = key;
    if (key !== null) drawingViews.get(key)?.svg.classList.add("wx-srv-drawing-selected");
    deleteButton.disabled = key === null;
    if (key === null) closeDeleteConfirm(false);
    positionSelection();
  }

  /** Keyboard (and small-target) route to a drawing: selects the next one down the thread,
   * wrapping, and brings it into view. */
  function selectNext(): void {
    const ordered = Array.from(drawingViews.entries())
      .filter(([, view]) => view.box !== null)
      .sort(([, a], [, b]) => (a.box!.top - b.box!.top) || (a.box!.left - b.box!.left))
      .map(([key]) => key);
    if (ordered.length === 0) {
      setStatus("There are no drawings to select here.");
      return;
    }
    const index = selectedKey === null ? -1 : ordered.indexOf(selectedKey);
    const next = ordered[(index + 1) % ordered.length] ?? null;
    select(next);
    const reduceMotion = win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    if (!selectionOutline.hidden && typeof selectionOutline.scrollIntoView === "function") {
      selectionOutline.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    }
  }

  function openDeleteConfirm(): void {
    if (selectedKey === null) return;
    keepThreadInPlace(() => {
      confirmingDelete = true;
      syncGroups();
    });
    confirmDeleteButton.focus();
  }

  function closeDeleteConfirm(refocus: boolean): void {
    if (!confirmingDelete) return;
    keepThreadInPlace(() => {
      confirmingDelete = false;
      syncGroups();
    });
    if (refocus && !deleteButton.disabled) deleteButton.focus();
  }

  async function deleteSelected(): Promise<void> {
    const key = selectedKey;
    const drawing = key === null ? undefined : model.get(key);
    closeDeleteConfirm(false);
    if (key === null || drawing === undefined) return;
    select(null);
    if (activeStroke !== null && activeStroke.key === key) cancelActiveStroke();
    if (sessionDrawingKey === key) sessionDrawingKey = null;
    // Taken off the screen at once; the other screen follows from the server's
    // `message_updated` (§6: removed in place, never a whole-bubble re-render).
    model.remove(key);
    if (drawing.id !== null) model.tombstone(drawing.id);
    removeDrawingView(key);
    const outcome = await sync.deleteDrawing(drawing);
    if (outcome === "ok" || torndown) return;
    // Not confirmed: it is still there for everyone, so it comes back here too, whole — the
    // strokes the delete held back are stored after all — and the server's own answer covers
    // anything stored meanwhile.
    model.restore(drawing);
    for (const stroke of drawing.strokes) if (stroke.state === "pending") sync.storeStroke(drawing, stroke);
    renderDrawing(key);
    sync.refetch(drawing.anchorSeq);
    if (outcome === "failed") setStatus("Couldn't delete the drawing. Try again.");
  }

  // -- Pen state -----------------------------------------------------------------------------

  function syncToolbar(): void {
    for (const [value, button] of colorButtons) button.setAttribute("aria-pressed", String(value === color));
    for (const [value, button] of widthButtons) {
      button.setAttribute("aria-pressed", String(value === width));
      button.style.setProperty("--wx-srv-pen-color", color);
    }
    drawModeButton.setAttribute("aria-pressed", String(mode === "draw"));
    selectModeButton.setAttribute("aria-pressed", String(mode === "select"));
    syncGroups();
    toolbar.classList.toggle("wx-srv-pen-toolbar-select", mode !== "draw");
  }

  /** The groups this mode shows. On a phone the first line holds what the mode acts on (the
   * colours, the selection's buttons, or the delete question) and the second line is always
   * Draw | Select, then this mode's slot (the thicknesses, or the hint; nothing while the
   * question is up), then Done — so the switch never moves when the mode changes. */
  function syncGroups(): void {
    const drawing = mode === "draw";
    colorGroup.hidden = !drawing;
    widthGroup.hidden = !drawing;
    collapseButton.hidden = !drawing;
    selectHint.hidden = drawing || confirmingDelete;
    selectGroup.hidden = drawing || confirmingDelete;
    confirmGroup.hidden = !confirmingDelete;
  }

  function setColor(value: DrawingColor): void {
    color = value;
    syncToolbar();
  }

  function setWidth(value: DrawingWidth): void {
    width = value;
    syncToolbar();
  }

  function setMode(next: PenMode): void {
    if (!penOn) return;
    if (mode === next) {
      syncToolbar();
      return;
    }
    mode = next;
    if (next === "draw") {
      select(null);
      listenForSelectTaps(false);
      mountSurface();
    } else {
      endDrawingSession();
      unmountSurface();
      listenForSelectTaps(true);
    }
    keepThreadInPlace(syncToolbar);
  }

  function setToolbarCollapsed(collapsed: boolean): void {
    if (!penOn) return;
    if (toolbarCollapsed === collapsed) return;
    toolbarCollapsed = collapsed;
    penButton.setAttribute("aria-expanded", String(!collapsed));
    keepThreadInPlace(() => {
      toolbar.hidden = collapsed;
    });
    relayout();
  }

  function setPen(on: boolean): void {
    if (on === penOn) return;
    if (on && session === null) return;
    penOn = on;
    toolbarCollapsed = false;
    penButton.setAttribute("aria-pressed", String(on));
    penButton.setAttribute("aria-expanded", String(on));
    penButton.classList.toggle("wx-srv-pen-button-on", on);
    undoButton.hidden = !on;
    redoButton.hidden = !on;
    deps.onPenChange?.(on);
    keepThreadInPlace(() => {
      if (on) {
        mode = "draw";
        sessionDrawingKey = null;
        sessionDrawingKeys.clear();
        undoStack.length = 0;
        redoStack.length = 0;
        updateUndoRedo();
        toolbar.hidden = false;
        mountSurface();
      } else {
        endDrawingSession();
        select(null);
        closeDeleteConfirm(false);
        unmountSurface();
        listenForSelectTaps(false);
        setStatus(null);
        toolbar.hidden = true;
        sessionDrawingKeys.clear();
        undoStack.length = 0;
        redoStack.length = 0;
        updateUndoRedo();
      }
      syncToolbar();
    });
    relayout();
  }

  syncToolbar();

  // -- The thread's events -------------------------------------------------------------------

  function dropAnchor(seq: number): void {
    for (const drawing of model.removeAnchor(seq)) dropDrawingLocally(drawing);
    sync.forgetAnchor(seq);
    for (const strokeId of liveReceiver.removeForAnchor(seq)) removeLiveView(strokeId);
  }

  let keyboardListening = false;

  function onKeyDown(event: KeyboardEvent): void {
    if (!penOn) return;
    const isMac = typeof win.navigator?.platform === "string" && /Mac|iPod|iPhone|iPad/.test(win.navigator.platform);
    const modKey = isMac ? event.metaKey : event.ctrlKey;
    if (!modKey) return;
    if (event.key === "z" || event.key === "Z") {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    } else if (event.key === "y" || event.key === "Y") {
      event.preventDefault();
      redo();
    }
  }

  function detach(): void {
    if (penOn) setPen(false);
    if (keyboardListening) {
      win.removeEventListener?.("keydown", onKeyDown as EventListener);
      keyboardListening = false;
    }
    // Owed live cancels go out now, while this unlock's token is still in hand.
    liveSender.shutdown();
    session = null;
    sync.pause();
    clearLive();
    stopObservers();
    cancelFrame();
    dirtyDrawings.clear();
    if (visibilityListening) {
      documentRef.removeEventListener("visibilitychange", onVisibilityChange);
      visibilityListening = false;
    }
    setStatus(null);
  }

  return {
    penButton,
    undoButton,
    redoButton,
    toolbar,
    collapseButton,
    attach(next: ServerSession): void {
      if (torndown) return;
      session = next;
      startObservers();
      if (!visibilityListening) {
        documentRef.addEventListener("visibilitychange", onVisibilityChange);
        visibilityListening = true;
      }
      if (!keyboardListening) {
        win.addEventListener?.("keydown", onKeyDown as EventListener);
        keyboardListening = true;
      }
      sync.resume();
    },
    detach,
    teardown(): void {
      if (torndown) return;
      detach();
      torndown = true;
      sync.teardown();
      model.clear();
      for (const key of Array.from(drawingViews.keys())) removeDrawingView(key);
      layer.remove();
      undoButton.remove();
      redoButton.remove();
      ownClientIds.clear();
      sessionDrawingKeys.clear();
      undoStack.length = 0;
      redoStack.length = 0;
    },
    syncMessages(messages: readonly Message[]): void {
      if (torndown) return;
      const alive = new Set(messages.map((message) => message.seq));
      for (const seq of model.anchorSeqs()) if (!alive.has(seq)) dropAnchor(seq);
      for (const message of messages) {
        const summaries = parseDrawingSummaries(message.drawings);
        if (summaries !== null) sync.observe(message.seq, summaries);
      }
      relayout();
    },
    handleLive(frame: LiveFrame): void {
      if (session === null || torndown) return;
      const result = liveReceiver.apply(frame, now());
      if (result.kind === "updated") {
        renderLive(result.stroke);
        ensureSweep();
        if (activeStroke === null) deps.onRemoteContent();
      } else if (result.kind === "removed") {
        removeLiveView(result.strokeId);
      }
    },
    messageDeleted(seq: number): void {
      dropAnchor(seq);
    },
    wiped(): void {
      if (penOn) setPen(false);
      sync.clear();
      for (const drawing of Array.from(model.all())) dropDrawingLocally(drawing);
      model.clear();
      clearLive();
      for (const key of Array.from(drawingViews.keys())) removeDrawingView(key);
      sessionDrawingKeys.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      updateUndoRedo();
    },
    isStrokeActive: () => activeStroke !== null,
    relayout,
    isPenOn: () => penOn,
    undo,
    redo,
    abandon,
  };
}

/** Exposed for tests: how long a live preview may go without an update. */
export const LIVE_PREVIEW_TIMEOUT_MS = LIVE_STROKE_TIMEOUT_MS;
