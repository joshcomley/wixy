// The CANVAS TAB (decisions/00206). A canvas message stays in the chat as the record of when it was
// started (with its drawing on it and an Open button), but it is drawn on here: the one second tab of
// the game frame (`gameTabs.ts`), full screen, where it does not move as the chat scrolls. Opening a
// canvas replaces whatever game held that tab — still only Chat plus one — and opening an older canvas
// from its Open button simply carries on with it.
//
// The pane runs its OWN pen (`mountDrawingLayer`) whose only anchor is the canvas shown here, so the
// toolbar, live strokes, storing, undo and Select-and-delete are the chat pen's, unchanged. Drawings on
// a canvas are placed by the canvas's surface (`canvasPlacement`), so a stroke made here lands on the
// same spot of the inline canvas on both screens, at any width.
//
// The canvas has no chat of its own: while its tab shows, a message sent goes to the main chat, the
// FAB goes back to the Chat tab, and a newly arrived message floats in as it does over a game.

import type { Message } from "./api/messages";
import type { LiveFrame } from "./api/drawings";
import type { DrawingSyncApi } from "./drawingSync";
import { mountDrawingLayer, type DrawingLayer, type DrawingLiveApi } from "./drawingLayer";
import type { GameFloat } from "./gameFloat";
import type { GameTabs } from "./gameTabs";
import type { ServerIdentity } from "./identity";
import type { LockHooks, ServerSession } from "./types";

/** The canvas's fixed shape (chat.css `.wx-srv-canvas-surface`): width over height. */
const CANVAS_ASPECT = 4 / 5;
/** Room kept around the canvas inside the pane, in CSS px. */
const PANE_PAD_PX = 12;

export interface CanvasPaneDeps {
  readonly document: Document;
  readonly win: Window;
  readonly hooks: LockHooks;
  readonly identity: ServerIdentity;
  readonly tabs: Pick<GameTabs, "register" | "seqOf" | "showTab" | "close">;
  readonly float: Pick<GameFloat, "createOverlay">;
  /** The confirmed canvas message `seq`, or undefined (not loaded, deleted, wiped, not a canvas). */
  canvasMessage(seq: number): Message | undefined;
  /** Injectable for tests; the real HTTP client by default. */
  readonly api?: DrawingSyncApi & DrawingLiveApi;
  readonly now?: () => number;
}

export interface CanvasPane {
  readonly pane: HTMLElement;
  /** The pane's pen, for tests. */
  readonly drawingLayer: DrawingLayer;
  attach(session: ServerSession): void;
  detach(): void;
  teardown(): void;
  /** The chat's messages changed: fetch what the shown canvas's drawing summary says is new. */
  sync(): void;
  handleLive(frame: LiveFrame): void;
  messageDeleted(seq: number): void;
  wiped(): void;
}

export function createCanvasPane(deps: CanvasPaneDeps): CanvasPane {
  const doc = deps.document;
  const win = deps.win;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const pane = el("section", "wx-srv-game wx-srv-canvas-pane");
  pane.setAttribute("aria-label", "Canvas");
  const head = el("div", "wx-srv-canvas-head");
  const title = el("h2", "wx-srv-canvas-title", "Canvas");
  const tools = el("div", "wx-srv-canvas-tools");
  head.append(title, tools);

  // The scroll region (the pen's "thread") holds the content wrapper (its "content"), which holds the
  // canvas frame. The frame is both the pen's column and its Draw-surface host, so a stroke can only
  // start on the canvas itself.
  const scroller = el("div", "wx-srv-canvas-scroll");
  const content = el("div", "wx-srv-canvas-content");
  const frame = el("div", "wx-srv-canvas-frame");
  const surface = el("div", "wx-srv-canvas-surface");
  surface.setAttribute("role", "img");
  surface.setAttribute("aria-label", "Canvas to draw on");
  frame.appendChild(surface);
  content.appendChild(frame);
  scroller.appendChild(content);

  const chatRow = el("div", "wx-srv-game-chatrow");
  chatRow.appendChild(
    deps.float.createOverlay({
      fabLabel: "Back to the chat",
      popupTitle: "Chat",
      item: () => null,
      onFab: () => deps.tabs.showTab("chat"),
    }),
  );

  /** The canvas this pane shows, or null. */
  let current: number | null = null;
  let visible = false;
  let session: ServerSession | null = null;

  const drawingLayer = mountDrawingLayer({
    document: doc,
    win,
    hooks: deps.hooks,
    identity: deps.identity,
    thread: scroller,
    threadWrap: frame,
    content,
    column: frame,
    anchors: () => (current === null ? [] : [{ seq: current, element: frame }]),
    anchorElement: (seq) => (seq === current ? frame : null),
    canvasSurface: (seq) => (seq === current ? surface : null),
    holdScroll: () => () => {},
    onRemoteContent: () => {},
    ...(deps.api !== undefined ? { api: deps.api } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // ✕ closes the tab, as a game's does; the canvas stays in the chat, where Open brings it back.
  const closeButton = el("button", "wx-srv-game-close wx-srv-canvas-close", "✕");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close the canvas");
  closeButton.setAttribute("data-srv-gesture-boundary", "");
  closeButton.addEventListener("click", () => deps.tabs.close("canvas"));
  tools.append(drawingLayer.undoButton, drawingLayer.redoButton, drawingLayer.penButton, closeButton);
  pane.append(head, drawingLayer.toolbar, scroller, chatRow);

  /** Sizes the canvas to the largest 4:5 that fits the pane, so it never needs scrolling. */
  function fit(): void {
    const width = scroller.clientWidth - 2 * PANE_PAD_PX;
    const height = scroller.clientHeight - 2 * PANE_PAD_PX;
    if (!(width > 0) || !(height > 0)) return;
    const size = Math.max(0, Math.floor(Math.min(width, height * CANVAS_ASPECT)));
    frame.style.width = `${size}px`;
    drawingLayer.relayout();
  }
  const Observer = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const resizeObserver = Observer === undefined ? null : new Observer(() => fit());
  resizeObserver?.observe(scroller);

  function describe(seq: number): void {
    const message = deps.canvasMessage(seq);
    if (message === undefined) return;
    title.textContent = deps.identity.isMine(message.sender) ? "Your canvas" : `${message.sender}'s canvas`;
  }

  function show(seq: number): void {
    if (current !== seq) {
      // Another canvas: the pen session of the old one ends (its strokes are already stored).
      drawingLayer.setPen(false);
      current = seq;
    }
    describe(seq);
    const message = deps.canvasMessage(seq);
    drawingLayer.syncMessages(message === undefined ? [] : [message]);
    fit();
  }

  deps.tabs.register({
    key: "canvas",
    tabLabel: "Canvas",
    tabAriaLabel: "Canvas",
    itemChat: false,
    pane,
    exists: (seq) => deps.canvasMessage(seq) !== undefined,
    refresh(seq) {
      show(seq);
    },
    onShow(seq) {
      visible = true;
      show(seq);
      // A canvas is for drawing: its tab opens with the pen on.
      if (session !== null) drawingLayer.setPen(true);
    },
    onHide() {
      visible = false;
      drawingLayer.setPen(false);
    },
    reset() {
      visible = false;
      drawingLayer.setPen(false);
      current = null;
      drawingLayer.syncMessages([]);
    },
  });

  return {
    pane,
    drawingLayer,
    attach(next) {
      session = next;
      drawingLayer.attach(next);
    },
    detach() {
      session = null;
      drawingLayer.detach();
    },
    teardown() {
      session = null;
      resizeObserver?.disconnect();
      drawingLayer.teardown();
    },
    sync() {
      const seq = deps.tabs.seqOf("canvas");
      if (seq === null || seq !== current) return;
      show(seq);
    },
    handleLive(frame) {
      // Only the canvas shown here; the chat's own pen draws every other live stroke.
      if (current !== null && frame.anchorSeq === current) drawingLayer.handleLive(frame);
    },
    messageDeleted(seq) {
      drawingLayer.messageDeleted(seq);
    },
    wiped() {
      drawingLayer.wiped();
    },
  };
}
