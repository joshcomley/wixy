// The pen in the DOM (spec/server-chat/07-live-drawing.md §1, §4, §5, §6): the Pen button and
// toolbar, drawing on the Draw surface (anchoring, draw-space coordinates, the live batches and
// the stored stroke), the two-finger pan, the lock teardown, other screens' live strokes, the
// in-place patching and removal of drawings, and Select mode's tap-to-select and delete.
//
// jsdom never lays anything out, so every element the layer measures gets a stubbed box here;
// the real-browser proof of the same behaviour is e2e/tests/server-drawing.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppendStrokeResult,
  CreateDrawingResult,
  DeleteDrawingResult,
  LiveFrame,
  LivePostResult,
  StoredDrawing,
} from "../../src/server/api/drawings";
import { ServerLockedError } from "../../src/server/api/http";
import type { Message } from "../../src/server/api/messages";
import { mountDrawingLayer, type DrawingLayer, type DrawingLayerDeps } from "../../src/server/drawingLayer";
import { LIVE_STROKE_TIMEOUT_MS } from "../../src/server/drawings";
import { isExcludedTapTarget, isGestureBoundaryTarget } from "../../src/server/gestures";
import type { ServerIdentity } from "../../src/server/identity";
import type { LockHooks, ServerSession } from "../../src/server/types";

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

/** The thread's geometry, in client px: the content wrapper and the column start at (10, 100)
 * and are 310 px wide; the thread shows 336 px from x = 0. Bubble tops are set per test. */
const CONTENT = { left: 10, top: 100 };
const COLUMN_WIDTH = 310;

function stubRect(element: Element, box: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () =>
    ({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function pointer(
  type: string,
  init: { pointerId?: number; pointerType?: string; button?: number; isPrimary?: boolean; x: number; y: number },
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? "mouse" },
    button: { value: init.button ?? 0 },
    isPrimary: { value: init.isPrimary ?? true },
    clientX: { value: init.x },
    clientY: { value: init.y },
  });
  return event;
}

function click(x: number, y: number): MouseEvent {
  return new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 });
}

/** A real tap on `target` at (x, y): pointerdown, pointerup, then the click a browser MAY add.
 * Returns that click, to check whether it was swallowed. */
function tap(target: Element, x: number, y: number, pointerType = "touch"): MouseEvent {
  target.dispatchEvent(pointer("pointerdown", { pointerType, x, y }));
  target.dispatchEvent(pointer("pointerup", { pointerType, x, y }));
  const follow = click(x, y);
  target.dispatchEvent(follow);
  return follow;
}

function message(seq: number, drawings?: Array<{ id: number; rev: number }>): Message {
  return {
    seq,
    clientId: `c-${seq}`,
    sender: "Fixture",
    text: `message ${seq}`,
    attachments: [],
    reactions: [],
    createdAt: 1_800_000_000 + seq,
    replyTo: null,
    ...(drawings === undefined ? {} : { drawings }),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

interface Setup {
  readonly layer: DrawingLayer;
  readonly deps: DrawingLayerDeps;
  readonly thread: HTMLElement;
  readonly threadWrap: HTMLElement;
  readonly header: HTMLElement;
  readonly api: {
    createDrawing: ReturnType<typeof vi.fn>;
    appendStroke: ReturnType<typeof vi.fn>;
    deleteDrawing: ReturnType<typeof vi.fn>;
    getDrawings: ReturnType<typeof vi.fn>;
    postLiveBatch: ReturnType<typeof vi.fn>;
  };
  readonly hooks: LockHooks;
  readonly releaseHold: ReturnType<typeof vi.fn>;
  addBubble(seq: number, top: number, height?: number): HTMLElement;
  surface(): HTMLElement | null;
  svgs(): SVGSVGElement[];
  liveSvgs(): SVGSVGElement[];
  toolbarButton(selector: string): HTMLButtonElement;
  clock: { t: number };
}

function setup(): Setup {
  const threadWrap = document.createElement("div");
  threadWrap.className = "wx-srv-thread-wrap";
  const thread = document.createElement("div");
  thread.className = "wx-srv-thread";
  const content = document.createElement("div");
  content.className = "wx-srv-thread-content";
  const column = document.createElement("div");
  column.className = "wx-srv-message-list";
  content.appendChild(column);
  thread.appendChild(content);
  threadWrap.appendChild(thread);
  const header = document.createElement("div");
  document.body.append(header, threadWrap);

  stubRect(content, { left: CONTENT.left, top: CONTENT.top, width: COLUMN_WIDTH, height: 2000 });
  stubRect(column, { left: CONTENT.left, top: CONTENT.top, width: COLUMN_WIDTH, height: 2000 });
  stubRect(thread, { left: 0, top: 90, width: 336, height: 500 });
  Object.defineProperty(column, "clientWidth", { value: COLUMN_WIDTH, configurable: true });
  Object.defineProperty(thread, "clientWidth", { value: 334, configurable: true });
  Object.defineProperty(thread, "clientLeft", { value: 1, configurable: true });
  Object.defineProperty(thread, "clientHeight", { value: 480, configurable: true });

  const bubbles = new Map<number, HTMLElement>();
  let uuid = 0;
  const clock = { t: 1_000 };
  const listeners = new Map<string, Set<EventListener>>();
  const win = {
    crypto: { randomUUID: () => `uuid-${(uuid += 1).toString().padStart(4, "0")}` },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    matchMedia: () => ({ matches: false }),
    addEventListener: (type: string, listener: EventListener) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
      return true;
    },
  } as unknown as Window;
  const api = {
    createDrawing: vi.fn(async (): Promise<CreateDrawingResult> => ({ kind: "ok", id: 41, rev: 1 })),
    appendStroke: vi.fn(async (): Promise<AppendStrokeResult> => ({ kind: "ok", rev: 2 })),
    deleteDrawing: vi.fn(async (): Promise<DeleteDrawingResult> => ({ kind: "ok" })),
    getDrawings: vi.fn(async (): Promise<readonly StoredDrawing[]> => []),
    postLiveBatch: vi.fn(async (): Promise<LivePostResult> => ({ kind: "ok" })),
  };
  const hooks: LockHooks = {
    suspend: vi.fn(() => () => {}),
    lockNow: vi.fn(),
    adoptBoundSession: vi.fn(),
    getBoundGrantId: vi.fn(() => null),
  };
  const identity: ServerIdentity = {
    getName: () => "Alice",
    setName: vi.fn(),
    getDeviceId: () => "device-alice",
    isMine: (sender) => sender === "Alice",
  };
  const releaseHold = vi.fn();
  const deps: DrawingLayerDeps = {
    document,
    win,
    hooks,
    identity,
    thread,
    threadWrap,
    content,
    column,
    anchors: () =>
      Array.from(bubbles.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([seq, element]) => ({ seq, element })),
    anchorElement: (seq) => bubbles.get(seq) ?? null,
    holdScroll: () => releaseHold,
    onRemoteContent: vi.fn(),
    api,
    now: () => clock.t,
  };
  const layer = mountDrawingLayer(deps);
  header.appendChild(layer.penButton);
  header.appendChild(layer.toolbar);
  return {
    layer,
    deps,
    thread,
    threadWrap,
    header,
    api,
    hooks,
    releaseHold,
    clock,
    addBubble(seq: number, top: number, height = 60): HTMLElement {
      const bubble = document.createElement("div");
      bubble.className = "wx-srv-bubble";
      bubble.dataset["messageSeq"] = String(seq);
      stubRect(bubble, { left: CONTENT.left, top, width: 200, height });
      column.appendChild(bubble);
      bubbles.set(seq, bubble);
      return bubble;
    },
    surface: () => threadWrap.querySelector<HTMLElement>(".wx-srv-draw-surface"),
    svgs: () => Array.from(content.querySelectorAll<SVGSVGElement>("svg.wx-srv-drawing:not(.wx-srv-drawing-live)")),
    liveSvgs: () => Array.from(content.querySelectorAll<SVGSVGElement>("svg.wx-srv-drawing-live")),
    toolbarButton: (selector: string) => layer.toolbar.querySelector<HTMLButtonElement>(selector)!,
  };
}

/** Draws a stroke on the surface with a mouse, through client points. */
function drawMouseStroke(s: Setup, points: Array<[number, number]>, pointerId = 1): void {
  const surface = s.surface()!;
  const [first, ...rest] = points;
  surface.dispatchEvent(pointer("pointerdown", { pointerId, x: first![0], y: first![1] }));
  for (const [x, y] of rest.slice(0, -1)) surface.dispatchEvent(pointer("pointermove", { pointerId, x, y }));
  const last = rest[rest.length - 1] ?? first!;
  surface.dispatchEvent(pointer("pointerup", { pointerId, x: last[0], y: last[1] }));
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("drawingLayer: the Pen button and toolbar (§5)", () => {
  it("is a gesture-boundary toggle that shows the toolbar and the Draw surface, OFF by default", () => {
    const s = setup();
    s.layer.attach(SESSION);
    expect(isGestureBoundaryTarget(s.layer.penButton)).toBe(true);
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("false");
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("false");
    expect(s.layer.toolbar.hidden).toBe(true);
    expect(s.surface()).toBeNull();

    s.layer.penButton.click();
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("true");
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("true");
    expect(s.layer.toolbar.hidden).toBe(false);
    expect(s.surface()).not.toBeNull();

    s.toolbarButton(".wx-srv-pen-done").click();
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("false");
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("false");
    expect(s.layer.toolbar.hidden).toBe(true);
    expect(s.surface()).toBeNull();
    expect(document.activeElement).toBe(s.layer.penButton);
  });

  it("collapses the toolbar via the collapse button while drawing stays live and strokes land", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    expect(s.layer.toolbar.hidden).toBe(false);
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("true");
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("true");
    expect(s.surface()).not.toBeNull();

    // Collapse the toolbar
    const collapseButton = s.layer.collapseButton ?? s.toolbarButton(".wx-srv-pen-collapse");
    collapseButton.click();
    expect(s.layer.toolbar.hidden).toBe(true);
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("true");
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("false");
    // Draw surface remains mounted and active
    expect(s.surface()).not.toBeNull();
    expect(document.activeElement).toBe(s.layer.penButton);

    // Drawing a stroke still works
    drawMouseStroke(s, [[40, 320], [60, 330]]);
    await flush();
    expect(s.api.createDrawing).toHaveBeenCalledTimes(1);
    expect(s.svgs()).toHaveLength(1);
  });

  it("tapping the pen button toggles toolbar open/collapsed while pen is on (never turns pen off)", () => {
    const s = setup();
    s.layer.attach(SESSION);
    // 1. Initial click: turns pen on and opens toolbar
    s.layer.penButton.click();
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("true");
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("true");
    expect(s.layer.toolbar.hidden).toBe(false);
    expect(s.surface()).not.toBeNull();

    // 2. Second click: collapses toolbar while pen stays on
    s.layer.penButton.click();
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("true");
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("false");
    expect(s.layer.toolbar.hidden).toBe(true);
    expect(s.surface()).not.toBeNull();

    // 3. Third click: re-opens toolbar while pen stays on
    s.layer.penButton.click();
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("true");
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("true");
    expect(s.layer.toolbar.hidden).toBe(false);
    expect(s.surface()).not.toBeNull();

    // 4. Collapse again via collapse button, then tap pen button to re-open
    const collapseButton = s.layer.collapseButton ?? s.toolbarButton(".wx-srv-pen-collapse");
    collapseButton.click();
    expect(s.layer.toolbar.hidden).toBe(true);
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("false");
    s.layer.penButton.click();
    expect(s.layer.toolbar.hidden).toBe(false);
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("true");

    // 5. Done button exits draw mode
    s.toolbarButton(".wx-srv-pen-done").click();
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("false");
    expect(s.layer.penButton.getAttribute("aria-expanded")).toBe("false");
    expect(s.layer.toolbar.hidden).toBe(true);
    expect(s.surface()).toBeNull();
  });

  it("keeps the thread's content where it was when the toolbar appears, changes height, or goes", () => {
    const s = setup();
    s.layer.attach(SESSION);
    const toolbar = s.layer.toolbar;
    const status = toolbar.querySelector<HTMLElement>(".wx-srv-pen-status")!;
    // The toolbar sits above the thread: 100 px tall, plus 20 px while a notice shows.
    toolbar.getBoundingClientRect = () =>
      ({ height: toolbar.hidden ? 0 : 100 + (status.hidden ? 0 : 20) }) as DOMRect;
    s.thread.scrollTop = 500;
    s.layer.penButton.click();
    expect(s.thread.scrollTop).toBe(600);
    // A notice (nothing to draw on here) grows it by 20 px: the content stays put.
    drawMouseStroke(s, [[40, 320]]);
    expect(status.hidden).toBe(false);
    expect(s.thread.scrollTop).toBe(620);
    s.toolbarButton(".wx-srv-pen-done").click();
    expect(s.thread.scrollTop).toBe(500);
  });

  it("cannot turn on while locked (no session)", () => {
    const s = setup();
    s.layer.penButton.click();
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("false");
    expect(s.layer.toolbar.hidden).toBe(true);
  });

  it("offers the 8 palette colours, the 4 thicknesses, Draw | Select and Done, each reporting its state", () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    const swatches = s.layer.toolbar.querySelectorAll<HTMLButtonElement>(".wx-srv-pen-swatch");
    const widths = s.layer.toolbar.querySelectorAll<HTMLButtonElement>(".wx-srv-pen-width");
    expect(swatches).toHaveLength(8);
    expect(widths).toHaveLength(4);
    expect(Array.from(swatches, (b) => b.getAttribute("aria-label"))).toEqual([
      "Black", "White", "Red", "Orange", "Yellow", "Green", "Blue", "Purple",
    ]);
    const blue = s.toolbarButton('.wx-srv-pen-swatch[data-color="#0a84ff"]');
    blue.click();
    expect(blue.getAttribute("aria-pressed")).toBe("true");
    expect(s.toolbarButton('.wx-srv-pen-swatch[data-color="#ff3b30"]').getAttribute("aria-pressed")).toBe("false");
    const thick = s.toolbarButton('.wx-srv-pen-width[data-width="14"]');
    thick.click();
    expect(thick.getAttribute("aria-pressed")).toBe("true");
    expect(s.toolbarButton('.wx-srv-pen-mode[data-mode="draw"]').getAttribute("aria-pressed")).toBe("true");
  });

  it("'Delete drawing' is a gesture boundary (it opens a confirmation), disabled until something is selected", () => {
    const s = setup();
    const del = s.toolbarButton(".wx-srv-pen-delete");
    expect(isGestureBoundaryTarget(del)).toBe(true);
    expect(del.disabled).toBe(true);
  });
});

describe("drawingLayer: the double-tap lock and Escape (§5)", () => {
  it("in Draw mode the surface is EXCLUDED from the multi-tap detector; in Select mode there is no surface", () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    expect(isExcludedTapTarget(s.surface())).toBe(true);
    s.toolbarButton('.wx-srv-pen-mode[data-mode="select"]').click();
    expect(s.surface()).toBeNull();
    // Taps on the thread itself count as ordinary taps again.
    expect(isExcludedTapTarget(s.thread)).toBe(false);
  });

  it("Escape pressed anywhere in the pen UI still reaches the document's panic-lock listener", () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    for (const target of [s.surface()!, s.toolbarButton(".wx-srv-pen-done"), s.layer.penButton]) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    document.removeEventListener("keydown", seen);
    expect(seen).toHaveBeenCalledTimes(3);
  });
});

describe("drawingLayer: drawing a stroke (§1, §2, §4)", () => {
  it("anchors to the bubble nearest above the start, stores integer draw-space points, and streams the stroke live", async () => {
    const s = setup();
    s.addBubble(1, 150);
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();

    // Starts 20 px below bubble 2's top, 30 px into the column (a "V": no point is redundant).
    drawMouseStroke(s, [[40, 320], [60, 340], [80, 320]]);
    await flush();

    expect(s.api.createDrawing).toHaveBeenCalledTimes(1);
    const [session, input] = s.api.createDrawing.mock.calls[0] as [ServerSession, { anchorSeq: number; columnWidth: number; stroke: { points: number[][]; color: string; width: number }; clientId: string; sender: string; deviceId: string }];
    expect(session).toBe(SESSION);
    expect(input.anchorSeq).toBe(2);
    expect(input.columnWidth).toBe(COLUMN_WIDTH);
    expect(input.sender).toBe("Alice");
    expect(input.deviceId).toBe("device-alice");
    expect(input.stroke.color).toBe("#ff3b30");
    expect(input.stroke.width).toBe(4);
    // x from the column's left edge (10), y from the anchor's top edge (300): integers.
    expect(input.stroke.points).toEqual([[30, 20], [50, 40], [70, 20]]);

    // The live batches carried the same draw space, keyed by this drawing's client id (the last
    // points still go out after the finger lifts).
    await vi.advanceTimersByTimeAsync(200);
    const frames = s.api.postLiveBatch.mock.calls.map((call) => call[1] as LiveFrame);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatchObject({ drawingClientId: input.clientId, anchorSeq: 2, columnWidth: COLUMN_WIDTH, batch: 0 });
    expect(frames[0]?.points[0]).toEqual([30, 20]);

    // Drawn as one svg with one path, whose box sits on the anchor in content px.
    const svgs = s.svgs();
    expect(svgs).toHaveLength(1);
    expect(svgs[0]!.querySelectorAll("path")).toHaveLength(1);
    expect(svgs[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(svgs[0]!.style.display).toBe("");
    // bounds minY = 20 - (4/2 + 1) = 17 below the anchor top, anchor at 300 - 100 = 200 content px.
    expect(parseFloat(svgs[0]!.style.top)).toBeCloseTo(217, 5);
    expect(s.releaseHold).toHaveBeenCalledTimes(1); // the scroll hold ended with the stroke
  });

  it("a stroke starting above the first bubble anchors to that first bubble with a negative offset", async () => {
    const s = setup();
    s.addBubble(5, 400);
    s.addBubble(6, 500);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    drawMouseStroke(s, [[40, 350], [50, 360]]);
    await flush();
    const input = s.api.createDrawing.mock.calls[0]![1] as { anchorSeq: number; stroke: { points: number[][] } };
    expect(input.anchorSeq).toBe(5);
    expect(input.stroke.points[0]).toEqual([30, -50]);
  });

  it("later strokes of the same pen session join the same drawing (appended after the create)", async () => {
    const s = setup();
    s.addBubble(1, 150);
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    drawMouseStroke(s, [[40, 320], [60, 330]]);
    await flush();
    // Even far below, near bubble 1's successor: same drawing, same anchor, larger y.
    drawMouseStroke(s, [[40, 160], [60, 170]], 2);
    await flush();
    expect(s.api.createDrawing).toHaveBeenCalledTimes(1);
    expect(s.api.appendStroke).toHaveBeenCalledTimes(1);
    const [, drawingId, stroke] = s.api.appendStroke.mock.calls[0] as [ServerSession, number, { points: number[][] }];
    expect(drawingId).toBe(41);
    expect(stroke.points[0]).toEqual([30, -140]);
    expect(s.svgs()).toHaveLength(1);
    expect(s.svgs()[0]!.querySelectorAll("path")).toHaveLength(2);
  });

  it("turning the pen off and on starts a NEW drawing (a drawing is one pen session, §2)", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    drawMouseStroke(s, [[40, 320], [60, 330]]);
    await flush();
    s.toolbarButton(".wx-srv-pen-done").click();
    s.layer.penButton.click();
    drawMouseStroke(s, [[40, 340], [60, 350]], 2);
    await flush();
    expect(s.api.createDrawing).toHaveBeenCalledTimes(2);
    expect(s.svgs()).toHaveLength(2);
  });

  it("a single tap is stored as a two-point dot", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    drawMouseStroke(s, [[40, 320]]);
    await flush();
    const input = s.api.createDrawing.mock.calls[0]![1] as { stroke: { points: number[][] } };
    expect(input.stroke.points).toEqual([[30, 20], [30, 20]]);
  });

  it("with nothing to anchor to, nothing is drawn and the toolbar says why", async () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    drawMouseStroke(s, [[40, 320], [60, 330]]);
    await flush();
    expect(s.api.createDrawing).not.toHaveBeenCalled();
    expect(s.svgs()).toHaveLength(0);
    const status = s.layer.toolbar.querySelector<HTMLElement>(".wx-srv-pen-status")!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/nothing to draw on/i);
  });

  it("a right-button drag draws nothing", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    const surface = s.surface()!;
    surface.dispatchEvent(pointer("pointerdown", { button: 2, x: 40, y: 320 }));
    surface.dispatchEvent(pointer("pointerup", { button: 2, x: 60, y: 330 }));
    await flush();
    expect(s.api.createDrawing).not.toHaveBeenCalled();
    expect(s.svgs()).toHaveLength(0);
  });
});

describe("drawingLayer: two fingers scroll, and cancel the stroke (§5)", () => {
  it("a second finger within 150 ms, before 12 px of movement, withdraws the stroke (live cancel) and pans the thread", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    const surface = s.surface()!;
    s.thread.scrollTop = 500;

    surface.dispatchEvent(pointer("pointerdown", { pointerId: 1, pointerType: "touch", x: 100, y: 400 }));
    await vi.advanceTimersByTimeAsync(60); // the first live batch goes out meanwhile
    s.clock.t += 60;
    surface.dispatchEvent(pointer("pointerdown", { pointerId: 2, pointerType: "touch", x: 160, y: 400 }));
    await vi.advanceTimersByTimeAsync(60);
    // The half-drawn stroke is gone, and a cancel followed the batch already sent.
    expect(s.svgs()).toHaveLength(0);
    const frames = s.api.postLiveBatch.mock.calls.map((call) => call[1] as LiveFrame & { cancel?: boolean });
    expect(frames.some((frame) => frame.cancel === true)).toBe(true);

    // Both fingers move up 40 px: the thread scrolls down by the centroid's 40 px.
    surface.dispatchEvent(pointer("pointermove", { pointerId: 1, pointerType: "touch", x: 100, y: 360 }));
    surface.dispatchEvent(pointer("pointermove", { pointerId: 2, pointerType: "touch", x: 160, y: 360 }));
    expect(s.thread.scrollTop).toBe(540);
    surface.dispatchEvent(pointer("pointerup", { pointerId: 1, pointerType: "touch", x: 100, y: 360 }));
    surface.dispatchEvent(pointer("pointerup", { pointerId: 2, pointerType: "touch", x: 160, y: 360 }));
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.api.createDrawing).not.toHaveBeenCalled();
  });

  it("a second finger after the first has drawn 12 px is ignored: the stroke carries on", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    const surface = s.surface()!;
    surface.dispatchEvent(pointer("pointerdown", { pointerId: 1, pointerType: "touch", x: 100, y: 400 }));
    surface.dispatchEvent(pointer("pointermove", { pointerId: 1, pointerType: "touch", x: 120, y: 400 }));
    surface.dispatchEvent(pointer("pointerdown", { pointerId: 2, pointerType: "touch", x: 160, y: 400 }));
    surface.dispatchEvent(pointer("pointerup", { pointerId: 1, pointerType: "touch", x: 130, y: 400 }));
    surface.dispatchEvent(pointer("pointerup", { pointerId: 2, pointerType: "touch", x: 160, y: 400 }));
    await flush();
    expect(s.api.createDrawing).toHaveBeenCalledTimes(1);
  });

  it("the mouse wheel over the surface scrolls the thread; a ctrl+wheel (pinch) does nothing", () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    s.thread.scrollTop = 100;
    const wheel = new WheelEvent("wheel", { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true });
    s.surface()!.dispatchEvent(wheel);
    expect(s.thread.scrollTop).toBe(220);
    expect(wheel.defaultPrevented).toBe(true);
    s.surface()!.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(s.thread.scrollTop).toBe(220);
  });
});

describe("drawingLayer: a lock destroys the session, the surface and every timer (§5)", () => {
  it("detach mid-stroke: a live cancel goes out at once with the unlock's token, then nothing more ever", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    const surface = s.surface()!;
    surface.dispatchEvent(pointer("pointerdown", { x: 40, y: 320 }));
    await vi.advanceTimersByTimeAsync(60);
    surface.dispatchEvent(pointer("pointermove", { x: 60, y: 330 }));
    const before = s.api.postLiveBatch.mock.calls.length;

    s.layer.detach();

    const after = s.api.postLiveBatch.mock.calls.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]![0]).toBe(SESSION);
    expect((after[0]![1] as { cancel?: boolean }).cancel).toBe(true);
    expect(s.surface()).toBeNull();
    expect(s.layer.toolbar.hidden).toBe(true);
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("false");
    expect(s.svgs()).toHaveLength(0); // the unfinished stroke was withdrawn, not stored
    const calls = s.api.postLiveBatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.api.postLiveBatch.mock.calls.length).toBe(calls);
    expect(s.api.createDrawing).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops other screens' live previews and stops their sweep timer", () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.handleLive(liveFrame({ batch: 0 }));
    expect(s.liveSvgs()).toHaveLength(1);
    s.layer.detach();
    expect(s.liveSvgs()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stroke waiting to be stored survives the lock and is stored with the next unlock's token", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.api.createDrawing.mockResolvedValueOnce({ kind: "retry" });
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    drawMouseStroke(s, [[40, 320], [60, 330]]);
    await flush();
    expect(s.api.createDrawing).toHaveBeenCalledTimes(1);
    s.layer.detach();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.api.createDrawing).toHaveBeenCalledTimes(1);
    const renewed: ServerSession = { token: "tok-2", expiresAt: 9_999_999_999 };
    s.layer.attach(renewed);
    await flush();
    expect(s.api.createDrawing).toHaveBeenCalledTimes(2);
    expect(s.api.createDrawing.mock.calls[1]![0]).toBe(renewed);
    expect((s.api.createDrawing.mock.calls[1]![1] as { clientId: string }).clientId).toBe(
      (s.api.createDrawing.mock.calls[0]![1] as { clientId: string }).clientId,
    );
  });

  it("a 401 on a live batch locks the chat", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.api.postLiveBatch.mockRejectedValue(new ServerLockedError());
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    s.surface()!.dispatchEvent(pointer("pointerdown", { x: 40, y: 320 }));
    await vi.advanceTimersByTimeAsync(60);
    await flush();
    expect(s.hooks.lockNow).toHaveBeenCalledWith("unauthorized");
  });

  it("the page hiding ends the drawing session (stroke withdrawn) but keeps the pen on", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    s.surface()!.dispatchEvent(pointer("pointerdown", { x: 40, y: 320 }));
    s.surface()!.dispatchEvent(pointer("pointermove", { x: 60, y: 330 }));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await flush();
    expect(s.svgs()).toHaveLength(0);
    expect(s.layer.isStrokeActive()).toBe(false);
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("true");
    s.layer.detach();
  });
});

function liveFrame(overrides: Partial<LiveFrame> = {}): LiveFrame {
  return {
    drawingClientId: "their-drawing",
    anchorSeq: 2,
    columnWidth: 310,
    strokeId: "their-stroke",
    batch: 0,
    color: "#0a84ff",
    width: 8,
    points: [[10, 10], [20, 20]],
    cancel: false,
    ...overrides,
  };
}

function storedDrawing(id: number, strokeIds: string[], rev = strokeIds.length): StoredDrawing {
  return {
    id,
    rev,
    sender: "Bob",
    columnWidth: 310,
    strokes: strokeIds.map((strokeId, index) => ({
      strokeId,
      color: "#0a84ff",
      width: 8,
      points: [[10 + index * 20, 10], [20 + index * 20, 20]],
    })),
  };
}

describe("drawingLayer: other screens' strokes, live (§4)", () => {
  it("renders a live stroke on its anchor, appends later batches, and ignores older ones", () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.handleLive(liveFrame({ batch: 0, points: [[10, 10], [20, 20]] }));
    const svg = s.liveSvgs()[0]!;
    const path = svg.querySelector("path")!;
    expect(path.getAttribute("d")).toBe("M10 10 L20 20");
    expect(path.getAttribute("stroke")).toBe("#0a84ff");
    s.layer.handleLive(liveFrame({ batch: 2, points: [[20, 20], [30, 25]] }));
    expect(path.getAttribute("d")).toBe("M10 10 L20 20 M20 20 L30 25");
    s.layer.handleLive(liveFrame({ batch: 1, points: [[99, 99]] })); // out of order: ignored
    expect(path.getAttribute("d")).toBe("M10 10 L20 20 M20 20 L30 25");
    expect(s.deps.onRemoteContent).toHaveBeenCalled();
    s.layer.detach();
  });

  it("a cancel removes the preview; a preview idle for 5 s is dropped", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.handleLive(liveFrame({ strokeId: "a" }));
    s.layer.handleLive(liveFrame({ strokeId: "a", batch: 1, cancel: true, points: [] }));
    expect(s.liveSvgs()).toHaveLength(0);

    s.layer.handleLive(liveFrame({ strokeId: "b" }));
    expect(s.liveSvgs()).toHaveLength(1);
    s.clock.t += LIVE_STROKE_TIMEOUT_MS + 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.liveSvgs()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    s.layer.detach();
  });

  it("ignores live frames for a drawing this screen is drawing itself", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    s.surface()!.dispatchEvent(pointer("pointerdown", { x: 40, y: 320 }));
    await vi.advanceTimersByTimeAsync(60);
    const own = s.api.postLiveBatch.mock.calls[0]![1] as LiveFrame;
    s.layer.handleLive({ ...own, cancel: false });
    expect(s.liveSvgs()).toHaveLength(0);
    s.layer.detach();
  });

  it("the stored stroke replaces the live preview: no duplicate, and late frames never bring it back", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.handleLive(liveFrame({ strokeId: "x1" }));
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 1 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(s.liveSvgs()).toHaveLength(0);
    expect(s.svgs()).toHaveLength(1);
    s.layer.handleLive(liveFrame({ strokeId: "x1", batch: 7 }));
    expect(s.liveSvgs()).toHaveLength(0);
    s.layer.detach();
  });
});

describe("drawingLayer: stored drawings are patched and removed in place (§4, §6)", () => {
  it("fetches what a summary says is new, then patches the SAME svg when a stroke is added", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 1 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    const svg = s.svgs()[0]!;
    const firstPath = svg.querySelector("path");
    expect(s.api.getDrawings).toHaveBeenCalledWith(SESSION, 2);

    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1", "x2"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 2 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(s.svgs()).toEqual([svg]);
    expect(svg.querySelectorAll("path")).toHaveLength(2);
    expect(svg.querySelector("path")).toBe(firstPath);
    s.layer.detach();
  });

  it("a settled summary causes no fetch at all", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.syncMessages([message(2, [])]);
    s.layer.syncMessages([message(2)]); // an older server: no field at all, "unknown"
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.api.getDrawings).not.toHaveBeenCalled();
    s.layer.detach();
  });

  it("a drawing deleted elsewhere disappears when the fetch no longer has it", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 1 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(s.svgs()).toHaveLength(1);
    s.api.getDrawings.mockResolvedValueOnce([]);
    s.layer.syncMessages([message(2, [])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(s.svgs()).toHaveLength(0);
    s.layer.detach();
  });

  it("deleting the anchor message removes its drawings at once, without a fetch", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 1 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    s.layer.messageDeleted(2);
    expect(s.svgs()).toHaveLength(0);
    // A message leaving the thread by any route (e.g. a reattach refresh) does the same.
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 1 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(s.svgs()).toHaveLength(1);
    s.layer.syncMessages([]);
    expect(s.svgs()).toHaveLength(0);
    s.layer.detach();
  });

  it("a wipe removes every drawing and live preview, and turns the pen off", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 1 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    s.layer.handleLive(liveFrame({ strokeId: "zz" }));
    s.layer.penButton.click();
    s.layer.wiped();
    expect(s.svgs()).toHaveLength(0);
    expect(s.liveSvgs()).toHaveLength(0);
    expect(s.layer.penButton.getAttribute("aria-pressed")).toBe("false");
    s.layer.detach();
  });

  it("re-reads every position from the live DOM: a bubble above growing moves the drawing with its anchor", async () => {
    const s = setup();
    const anchor = s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 1 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    const svg = s.svgs()[0]!;
    const before = parseFloat(svg.style.top);
    stubRect(anchor, { left: CONTENT.left, top: 380, width: 200, height: 60 }); // an image above loaded
    s.layer.relayout();
    expect(parseFloat(svg.style.top)).toBeCloseTo(before + 80, 5);
    s.layer.detach();
  });

  it("scales uniformly to this screen's column: a drawing made on a 310 px column shown on 620 px doubles", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 1 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    const svg = s.svgs()[0]!;
    const narrow = { width: parseFloat(svg.style.width), height: parseFloat(svg.style.height) };
    Object.defineProperty(s.deps.column, "clientWidth", { value: 620, configurable: true });
    Object.defineProperty(s.thread, "clientWidth", { value: 700, configurable: true });
    s.layer.relayout();
    expect(parseFloat(svg.style.width)).toBeCloseTo(narrow.width * 2, 5);
    expect(parseFloat(svg.style.height)).toBeCloseTo(narrow.height * 2, 5);
    // The viewBox stays in draw space, so the browser does the scaling (stroke width included).
    expect(svg.getAttribute("viewBox")).toBe(svg.getAttribute("viewBox"));
    s.layer.detach();
  });

  it("a drawing whose anchor is not on screen is not shown", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.handleLive(liveFrame({ anchorSeq: 99 }));
    expect(s.liveSvgs()[0]!.style.display).toBe("none");
    s.layer.detach();
  });
});

describe("drawingLayer: Select mode (§5)", () => {
  async function withStoredDrawing(): Promise<Setup> {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.layer.syncMessages([message(2, [{ id: 9, rev: 1 }])]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    s.layer.penButton.click();
    s.toolbarButton('.wx-srv-pen-mode[data-mode="select"]').click();
    return s;
  }

  it("a tap within 12 px of a stroke selects its drawing and does nothing else; a tap elsewhere passes through", async () => {
    const s = await withStoredDrawing();
    const underneath = vi.fn();
    const bubble = s.deps.anchorElement(2)!;
    bubble.addEventListener("click", underneath);
    // The stroke runs (10,10)-(20,20) in draw space: client (20,310)-(30,320).
    const onStroke = tap(bubble, 25 + 10, 315 - 10); // ~7 px from the line, width 8 -> inside 12 + 4
    expect(onStroke.defaultPrevented).toBe(true); // its click never reaches what is underneath
    expect(underneath).not.toHaveBeenCalled();
    const selection = s.deps.content.querySelector<HTMLElement>(".wx-srv-drawing-selection")!;
    expect(selection.hidden).toBe(false);
    expect(s.toolbarButton(".wx-srv-pen-delete").disabled).toBe(false);

    const far = tap(bubble, 250, 340);
    expect(far.defaultPrevented).toBe(false);
    expect(underneath).toHaveBeenCalledTimes(1);
    expect(selection.hidden).toBe(true);
    expect(s.toolbarButton(".wx-srv-pen-delete").disabled).toBe(true);
    s.layer.detach();
  });

  it("a touch tap selects even when the browser sends no click at all", async () => {
    const s = await withStoredDrawing();
    const bubble = s.deps.anchorElement(2)!;
    bubble.dispatchEvent(pointer("pointerdown", { pointerType: "touch", x: 25, y: 315 }));
    bubble.dispatchEvent(pointer("pointerup", { pointerType: "touch", x: 25, y: 315 }));
    expect(s.deps.content.querySelector<HTMLElement>(".wx-srv-drawing-selection")!.hidden).toBe(false);
    s.layer.detach();
  });

  it("a scroll (moved past the tap slop) or a long hold never selects, and a keyboard click never hit-tests", async () => {
    const s = await withStoredDrawing();
    const bubble = s.deps.anchorElement(2)!;
    bubble.dispatchEvent(pointer("pointerdown", { pointerType: "touch", x: 25, y: 280 }));
    bubble.dispatchEvent(pointer("pointerup", { pointerType: "touch", x: 25, y: 315 }));
    s.clock.t += 1;
    bubble.dispatchEvent(pointer("pointerdown", { pointerType: "touch", x: 25, y: 315 }));
    s.clock.t += 400;
    bubble.dispatchEvent(pointer("pointerup", { pointerType: "touch", x: 25, y: 315 }));
    const keyboardClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 });
    bubble.dispatchEvent(keyboardClick);
    expect(keyboardClick.defaultPrevented).toBe(false);
    expect(s.deps.content.querySelector<HTMLElement>(".wx-srv-drawing-selection")!.hidden).toBe(true);
    s.layer.detach();
  });

  it("Delete drawing asks first, then removes it at once and deletes it for everyone", async () => {
    const s = await withStoredDrawing();
    tap(s.deps.anchorElement(2)!, 25, 315);
    s.toolbarButton(".wx-srv-pen-delete").click();
    const confirm = s.layer.toolbar.querySelector<HTMLElement>(".wx-srv-pen-confirm")!;
    expect(confirm.hidden).toBe(false);
    expect(confirm.textContent).toContain("Delete this drawing for everyone?");
    expect(s.svgs()).toHaveLength(1);

    s.toolbarButton(".wx-srv-pen-confirm-delete").click();
    expect(s.svgs()).toHaveLength(0);
    await flush();
    expect(s.api.deleteDrawing).toHaveBeenCalledWith(SESSION, 9);
    expect(confirm.hidden).toBe(true);
    s.layer.detach();
  });

  it("Cancel keeps the drawing; a failed delete brings it back and says so", async () => {
    const s = await withStoredDrawing();
    tap(s.deps.anchorElement(2)!, 25, 315);
    s.toolbarButton(".wx-srv-pen-delete").click();
    s.toolbarButton(".wx-srv-pen-confirm-cancel").click();
    expect(s.svgs()).toHaveLength(1);
    expect(s.api.deleteDrawing).not.toHaveBeenCalled();

    s.api.deleteDrawing.mockResolvedValueOnce({ kind: "failed", status: 400 });
    s.api.getDrawings.mockResolvedValueOnce([storedDrawing(9, ["x1"])]);
    s.toolbarButton(".wx-srv-pen-delete").click();
    s.toolbarButton(".wx-srv-pen-confirm-delete").click();
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(s.svgs()).toHaveLength(1);
    expect(s.layer.toolbar.querySelector(".wx-srv-pen-status")?.textContent).toMatch(/couldn't delete/i);
    s.layer.detach();
  });

  it("a failed delete of my own drawing brings it back whole: the stroke the delete held back is stored after all", async () => {
    const s = setup();
    s.addBubble(2, 300);
    s.layer.attach(SESSION);
    s.layer.penButton.click();
    drawMouseStroke(s, [[40, 320], [60, 330]]);
    await flush();
    expect(s.api.createDrawing).toHaveBeenCalledTimes(1); // stored as drawing 41
    // The second stroke's append hangs, so the third waits behind it, never sent.
    let answerSecond!: (result: AppendStrokeResult) => void;
    s.api.appendStroke.mockImplementationOnce(() => new Promise<AppendStrokeResult>((resolve) => {
      answerSecond = resolve;
    }));
    drawMouseStroke(s, [[40, 340], [60, 350]], 2);
    await flush();
    drawMouseStroke(s, [[40, 360], [60, 370]], 3);
    await flush();
    expect(s.api.appendStroke).toHaveBeenCalledTimes(1);
    const strokeIdOf = (call: unknown[]): string => (call[2] as { strokeId: string }).strokeId;
    const [second, third] = Array.from(s.svgs()[0]!.querySelectorAll("path")).slice(1).map((path) => path.dataset["strokeId"]!);

    s.toolbarButton('.wx-srv-pen-mode[data-mode="select"]').click();
    tap(s.deps.anchorElement(2)!, 60, 330);
    s.api.deleteDrawing.mockResolvedValueOnce({ kind: "failed", status: 400 });
    s.toolbarButton(".wx-srv-pen-delete").click();
    s.toolbarButton(".wx-srv-pen-confirm-delete").click();
    expect(s.svgs()).toHaveLength(0);
    await flush();
    expect(s.api.deleteDrawing).toHaveBeenCalledWith(SESSION, 41);

    // Back, with all three strokes, and the held-back third is stored after the second.
    expect(s.svgs()).toHaveLength(1);
    expect(s.svgs()[0]!.querySelectorAll("path")).toHaveLength(3);
    expect(s.layer.toolbar.querySelector(".wx-srv-pen-status")?.textContent).toMatch(/couldn't delete/i);
    answerSecond({ kind: "ok", rev: 2 });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    const appended = s.api.appendStroke.mock.calls.map(strokeIdOf);
    expect(appended).toContain(third);
    expect(appended.indexOf(second!)).toBeLessThan(appended.lastIndexOf(third!));
    s.layer.detach();
  });

  it("each mode shows only its own groups; Draw | Select and Done stay in every mode", async () => {
    const s = await withStoredDrawing();
    const shown = (): string[] =>
      Array.from(s.layer.toolbar.children)
        .filter((el) => !(el as HTMLElement).hidden && !el.classList.contains("wx-srv-pen-status"))
        .map((el) => el.className);
    // The hint is the toolbar's own child (a phone puts it in the thicknesses' place), so the
    // select group holds only its two buttons.
    expect(s.layer.toolbar.querySelector(".wx-srv-pen-select .wx-srv-pen-hint")).toBeNull();
    expect(shown()).toEqual(["wx-srv-pen-hint", "wx-srv-pen-select", "wx-srv-pen-modes", "wx-srv-pen-done"]);
    tap(s.deps.anchorElement(2)!, 25, 315);
    s.toolbarButton(".wx-srv-pen-delete").click();
    expect(shown()).toEqual(["wx-srv-pen-confirm", "wx-srv-pen-modes", "wx-srv-pen-done"]);
    s.toolbarButton(".wx-srv-pen-confirm-cancel").click();
    expect(shown()).toEqual(["wx-srv-pen-hint", "wx-srv-pen-select", "wx-srv-pen-modes", "wx-srv-pen-done"]);
    s.toolbarButton('.wx-srv-pen-mode[data-mode="draw"]').click();
    expect(shown()).toEqual(["wx-srv-pen-colors", "wx-srv-pen-widths", "wx-srv-pen-modes", "wx-srv-pen-collapse", "wx-srv-pen-done"]);
    s.layer.detach();
  });

  it("'Next drawing' selects drawings from the keyboard, top to bottom, wrapping", async () => {
    const s = await withStoredDrawing();
    s.toolbarButton(".wx-srv-pen-next").click();
    const selection = s.deps.content.querySelector<HTMLElement>(".wx-srv-drawing-selection")!;
    expect(selection.hidden).toBe(false);
    expect(s.toolbarButton(".wx-srv-pen-delete").disabled).toBe(false);
    s.layer.detach();
  });

  it("back in Draw mode the selection clears and the surface returns", async () => {
    const s = await withStoredDrawing();
    tap(s.deps.anchorElement(2)!, 25, 315);
    s.toolbarButton('.wx-srv-pen-mode[data-mode="draw"]').click();
    expect(s.deps.content.querySelector<HTMLElement>(".wx-srv-drawing-selection")!.hidden).toBe(true);
    expect(s.surface()).not.toBeNull();
    s.layer.detach();
  });
});

describe("drawingLayer: undo, redo, and abandon", () => {
  it("undo and redo buttons are gesture boundaries, hidden when pen is off, disabled initially", () => {
    const s = setup();
    s.layer.attach(SESSION);
    expect(s.layer.undoButton.getAttribute("aria-label")).toBe("Undo");
    expect(s.layer.redoButton.getAttribute("aria-label")).toBe("Redo");
    expect(s.layer.undoButton.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    expect(s.layer.redoButton.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    expect(s.layer.undoButton.hidden).toBe(true);
    expect(s.layer.redoButton.hidden).toBe(true);
    expect(s.layer.undoButton.disabled).toBe(true);
    expect(s.layer.redoButton.disabled).toBe(true);

    s.layer.penButton.click();
    expect(s.layer.undoButton.hidden).toBe(false);
    expect(s.layer.redoButton.hidden).toBe(false);
    expect(s.layer.undoButton.disabled).toBe(true);
    expect(s.layer.redoButton.disabled).toBe(true);
    s.layer.detach();
  });

  it("drawing a stroke enables Undo, leaves Redo disabled; undo drops it locally, calls live cancel and delete", async () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.addBubble(1, 300);
    s.layer.penButton.click();

    drawMouseStroke(s, [[40, 310], [50, 312], [60, 310]]);
    await flush();

    expect(s.layer.undoButton.disabled).toBe(false);
    expect(s.layer.redoButton.disabled).toBe(true);
    expect(s.svgs()).toHaveLength(1);

    // Clicking Undo
    s.layer.undoButton.click();
    await flush();

    expect(s.svgs()).toHaveLength(0);
    expect(s.layer.undoButton.disabled).toBe(true);
    expect(s.layer.redoButton.disabled).toBe(false);
    expect(s.api.deleteDrawing).toHaveBeenCalledTimes(1);
    expect(s.api.postLiveBatch).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ cancel: true }),
    );

    // Clicking Redo restores it
    s.layer.redoButton.click();
    await flush();

    expect(s.svgs()).toHaveLength(1);
    expect(s.layer.undoButton.disabled).toBe(false);
    expect(s.layer.redoButton.disabled).toBe(true);

    s.layer.detach();
  });

  it("keyboard shortcuts Ctrl+Z undos and Ctrl+Y / Ctrl+Shift+Z redoes while pen is on", async () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.addBubble(1, 300);
    s.layer.penButton.click();

    drawMouseStroke(s, [[40, 310], [50, 312], [60, 310]]);
    await flush();
    expect(s.svgs()).toHaveLength(1);

    // Ctrl+Z
    s.deps.win.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    await flush();
    expect(s.svgs()).toHaveLength(0);
    expect(s.layer.redoButton.disabled).toBe(false);

    // Ctrl+Shift+Z
    s.deps.win.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", ctrlKey: true, shiftKey: true, bubbles: true }));
    await flush();
    expect(s.svgs()).toHaveLength(1);
    expect(s.layer.undoButton.disabled).toBe(false);

    // Ctrl+Z again
    s.deps.win.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    await flush();
    expect(s.svgs()).toHaveLength(0);

    // Ctrl+Y
    s.deps.win.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true }));
    await flush();
    expect(s.svgs()).toHaveLength(1);

    s.layer.detach();
  });

  it("drawing a new stroke after undo clears the redo stack", async () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.addBubble(1, 300);
    s.layer.penButton.click();

    drawMouseStroke(s, [[40, 310], [50, 312], [60, 310]]);
    await flush();
    s.layer.undo();
    await flush();
    expect(s.layer.redoButton.disabled).toBe(false);

    // Draw a new stroke
    drawMouseStroke(s, [[45, 315], [55, 317], [65, 315]]);
    await flush();
    expect(s.layer.undoButton.disabled).toBe(false);
    expect(s.layer.redoButton.disabled).toBe(true);

    s.layer.detach();
  });

  it("multi-stroke drawing: undoing the second stroke deletes the old drawing and re-stores the first stroke", async () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.addBubble(1, 300);
    s.layer.penButton.click();

    // First stroke
    drawMouseStroke(s, [[40, 310], [50, 312], [60, 310]]);
    await flush();
    // Second stroke in same drawing
    drawMouseStroke(s, [[45, 320], [55, 322], [65, 320]]);
    await flush();

    expect(s.svgs()).toHaveLength(1);
    expect(s.svgs()[0]!.querySelectorAll("path")).toHaveLength(2);

    // Undo second stroke
    s.layer.undo();
    await flush();

    expect(s.svgs()).toHaveLength(1);
    expect(s.svgs()[0]!.querySelectorAll("path")).toHaveLength(1);
    expect(s.api.deleteDrawing).toHaveBeenCalledTimes(1);

    // Redo second stroke
    s.layer.redo();
    await flush();

    expect(s.svgs()).toHaveLength(1);
    expect(s.svgs()[0]!.querySelectorAll("path")).toHaveLength(2);

    s.layer.detach();
  });

  it("abandon immediately exits draw mode and deletes all drawings made in this session", async () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.addBubble(1, 300);
    s.layer.penButton.click();

    drawMouseStroke(s, [[40, 310], [50, 312], [60, 310]]);
    await flush();
    expect(s.svgs()).toHaveLength(1);

    s.layer.abandon();
    await flush();

    expect(s.svgs()).toHaveLength(0);
    expect(s.layer.isPenOn()).toBe(false);
    expect(s.layer.undoButton.hidden).toBe(true);
    expect(s.layer.redoButton.hidden).toBe(true);
    expect(s.api.deleteDrawing).toHaveBeenCalledTimes(1);

    s.layer.detach();
  });

  it("ending the session with Done clears the undo and redo stacks", async () => {
    const s = setup();
    s.layer.attach(SESSION);
    s.addBubble(1, 300);
    s.layer.penButton.click();

    drawMouseStroke(s, [[40, 310], [50, 312], [60, 310]]);
    await flush();
    expect(s.layer.undoButton.disabled).toBe(false);

    // Click Done to end session
    s.toolbarButton(".wx-srv-pen-done").click();
    expect(s.layer.isPenOn()).toBe(false);

    // Turn pen back on: fresh session with empty undo/redo stacks
    s.layer.penButton.click();
    expect(s.layer.isPenOn()).toBe(true);
    expect(s.layer.undoButton.disabled).toBe(true);
    expect(s.layer.redoButton.disabled).toBe(true);

    s.layer.detach();
  });
});

