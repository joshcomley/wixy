import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountTeasePreview } from "../../src/server/teasePreview";
import {
  TEASE_SIZE_DEFAULT,
  computeTeaseRadius,
  teaseGeometry,
} from "../../src/server/teasePaint";

interface Harness {
  win: Window;
  frames: Array<() => void>;
  cancelled: number[];
  setNow(ms: number): void;
  runFrame(): void;
  arcs: Array<{ x: number; y: number; radius: number }>;
  drawImage: ReturnType<typeof vi.fn>;
  images: HTMLImageElement[];
}

/** A window with a hand-cranked clock and animation-frame queue, and a canvas that records what
 * the renderer asked it to draw (jsdom has no 2D canvas). */
function harness(opts: { reducedMotion?: boolean } = {}): Harness {
  let now = 1000;
  const frames: Array<() => void> = [];
  const cancelled: number[] = [];
  const arcs: Harness["arcs"] = [];
  const drawImage = vi.fn();
  const ctx = {
    fillRect: vi.fn(),
    drawImage,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    arc: vi.fn((x: number, y: number, radius: number) => {
      arcs.push({ x, y, radius });
    }),
    closePath: vi.fn(),
    fill: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 320,
    height: 150,
    right: 320,
    bottom: 150,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  const images: HTMLImageElement[] = [];
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, o?: ElementCreationOptions) => {
    const el = realCreate(tag, o);
    if (tag === "img") {
      images.push(el as HTMLImageElement);
      Object.defineProperty(el, "naturalWidth", { value: 400, configurable: true });
      Object.defineProperty(el, "naturalHeight", { value: 300, configurable: true });
    }
    return el;
  }) as typeof document.createElement);

  const win = {
    devicePixelRatio: 1,
    performance: { now: () => now },
    matchMedia: () => ({ matches: opts.reducedMotion === true }),
    requestAnimationFrame: (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    },
    cancelAnimationFrame: (id: number) => {
      cancelled.push(id);
    },
  } as unknown as Window;

  return {
    win,
    frames,
    cancelled,
    arcs,
    drawImage,
    images,
    setNow: (ms) => {
      now = ms;
    },
    runFrame: () => {
      const cb = frames.shift();
      cb?.();
    },
  };
}

describe("mountTeasePreview", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it("builds a labelled canvas and a caption, and draws nothing until the photo has loaded", () => {
    const h = harness();
    const preview = mountTeasePreview({ doc: document, win: h.win, imageUrl: "blob:photo" });
    host.appendChild(preview.element);

    const canvas = preview.element.querySelector("canvas");
    expect(canvas?.getAttribute("role")).toBe("img");
    expect(canvas?.getAttribute("aria-label")).toBe("Preview of the Tease effect on your photo");
    expect(preview.element.querySelector(".wx-srv-tease-preview-caption")?.textContent).toBe(
      "This is how they will see it. They can change the size and speed.",
    );
    expect(h.images[0]?.src).toContain("blob:photo");
    expect(h.arcs).toHaveLength(0);
    expect(h.frames).toHaveLength(0);
    preview.destroy();
  });

  it("once the photo loads it paints the real Tease: photo, then a hole at the default size, and keeps animating", () => {
    const h = harness();
    const preview = mountTeasePreview({ doc: document, win: h.win, imageUrl: "blob:photo" });
    host.appendChild(preview.element);

    h.images[0]!.onload!(new Event("load"));
    expect(h.drawImage).toHaveBeenCalledTimes(1);
    expect(h.arcs).toHaveLength(2); // the mask's hole plus its feathered ring
    const geo = teaseGeometry(320, 150, 400, 300);
    expect(h.arcs[0]!.radius).toBeCloseTo(computeTeaseRadius(TEASE_SIZE_DEFAULT, geo.minSide), 9);
    expect(h.frames).toHaveLength(1); // the next frame is queued
    preview.destroy();
  });

  it("the cut-out moves between frames (it is the live effect, not a still)", () => {
    const h = harness();
    const preview = mountTeasePreview({ doc: document, win: h.win, imageUrl: "blob:photo" });
    host.appendChild(preview.element);
    h.images[0]!.onload!(new Event("load"));
    const first = h.arcs[0]!;

    h.setNow(3000);
    h.runFrame();
    const second = h.arcs[h.arcs.length - 1]!;
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThan(1);
    preview.destroy();
  });

  it("with reduced motion it paints once, centred, and schedules no animation", () => {
    const h = harness({ reducedMotion: true });
    const preview = mountTeasePreview({ doc: document, win: h.win, imageUrl: "blob:photo" });
    host.appendChild(preview.element);
    h.images[0]!.onload!(new Event("load"));

    expect(h.frames).toHaveLength(0);
    const geo = teaseGeometry(320, 150, 400, 300);
    expect(h.arcs[0]!.x).toBeCloseTo(geo.cx, 9);
    expect(h.arcs[0]!.y).toBeCloseTo(geo.cy, 9);
    preview.destroy();
  });

  it("destroy stops the animation, removes the element, ignores a late load, and is safe twice", () => {
    const h = harness();
    const preview = mountTeasePreview({ doc: document, win: h.win, imageUrl: "blob:photo" });
    host.appendChild(preview.element);
    h.images[0]!.onload!(new Event("load"));
    expect(h.frames).toHaveLength(1);

    preview.destroy();
    expect(h.cancelled).toHaveLength(1);
    expect(host.contains(preview.element)).toBe(false);
    preview.destroy();
    expect(h.cancelled).toHaveLength(1);

    const arcsBefore = h.arcs.length;
    h.runFrame(); // a frame that was already queued must not draw
    expect(h.arcs).toHaveLength(arcsBefore);
  });

  it("stops by itself if something else removed the sheet (a lock tears the chat down)", () => {
    const h = harness();
    const preview = mountTeasePreview({ doc: document, win: h.win, imageUrl: "blob:photo" });
    host.appendChild(preview.element);
    h.images[0]!.onload!(new Event("load"));
    const arcsBefore = h.arcs.length;

    host.remove(); // the whole chat view is gone; nobody called destroy()
    h.runFrame();
    expect(h.arcs).toHaveLength(arcsBefore);
    expect(h.frames).toHaveLength(0); // and it did not schedule another frame
  });

  it("a photo that will not decode gets no preview rather than a broken box", () => {
    const h = harness();
    const preview = mountTeasePreview({ doc: document, win: h.win, imageUrl: "blob:broken" });
    host.appendChild(preview.element);
    h.images[0]!.onerror!(new Event("error"));
    expect(preview.element.hidden).toBe(true);
    preview.destroy();
  });
});
