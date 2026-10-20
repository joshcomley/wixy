import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startScene, GN_BACKGROUND, GN_FADING, GN_HIDDEN, type SceneHandle } from "../../src/server/goodnight/scene";
import { MESSAGES_BACK_FROM_MS, SCENE_END_MS } from "../../src/server/goodnight/timeline";
import { fakeWin, stubCanvas, trackDocumentListeners, type CanvasStub, type FakeWin } from "./goodnightHelpers";

let canvasStub: CanvasStub;
let clock = 0;
let view: HTMLElement;
let wrap: HTMLElement;
let release: ReturnType<typeof vi.fn>;
let suspend: ReturnType<typeof vi.fn>;
let handle: SceneHandle | null;

function start(fw: FakeWin): SceneHandle {
  handle = startScene({
    win: fw.win,
    document,
    hooks: { suspend },
    view,
    threadWrap: wrap,
    now: () => clock,
    seed: 11,
  });
  return handle;
}

function advance(fw: FakeWin, to: number): void {
  clock = to;
  fw.step();
}

const visibleCanvas = (): HTMLCanvasElement | null => document.body.querySelector(":scope > canvas.wx-srv-goodnight-canvas");

beforeEach(() => {
  canvasStub = stubCanvas();
  clock = 1_000_000;
  document.body.replaceChildren();
  view = document.createElement("div");
  wrap = document.createElement("div");
  wrap.appendChild(document.createElement("div"));
  view.appendChild(wrap);
  document.body.appendChild(view);
  release = vi.fn();
  suspend = vi.fn(() => release);
  handle = null;
});

afterEach(() => {
  handle?.close();
  canvasStub.restore();
  vi.restoreAllMocks();
});

describe("scene lifecycle", () => {
  it("mounts a viewport canvas on the body, fades the chat out and suspends the idle lock", () => {
    const fw = fakeWin({ width: 360, height: 640 });
    start(fw);
    const canvas = visibleCanvas();
    expect(canvas).not.toBeNull();
    // scale 3: the scene is 120 x 214 scene pixels
    expect([canvas!.width, canvas!.height]).toEqual([120, 214]);
    expect(canvas!.style.width).toBe("360px");
    expect(canvas!.style.height).toBe(`${214 * 3}px`);
    expect(view.classList.contains(GN_FADING)).toBe(true);
    expect(view.classList.contains(GN_HIDDEN)).toBe(true);
    expect(suspend).toHaveBeenCalledExactlyOnceWith("goodnight");
    expect(release).not.toHaveBeenCalled();
    expect(handle!.phase).toBe("playing");
    expect(fw.pendingFrames()).toBe(1);
  });

  it("draws every frame with whole-pixel coordinates only", () => {
    const fw = fakeWin();
    start(fw);
    for (let ms = 0; ms <= SCENE_END_MS + 1000; ms += 100) advance(fw, 1_000_000 + ms);
    const drawn = canvasStub.contexts.flatMap((c) => c.drawImage.mock.calls);
    expect(drawn.length).toBeGreaterThan(100);
    for (const call of drawn) {
      expect(call).toHaveLength(3);
      expect(Number.isInteger(call[1])).toBe(true);
      expect(Number.isInteger(call[2])).toBe(true);
    }
    for (const c of canvasStub.contexts) {
      for (const call of [...c.fillRect.mock.calls, ...c.clearRect.mock.calls]) {
        for (const n of call) expect(Number.isInteger(n)).toBe(true);
      }
      expect(c.imageSmoothingEnabled).toBe(false);
    }
  });

  it("brings the chat back at the hand-over and moves to background mode when it ends", () => {
    const fw = fakeWin();
    start(fw);
    advance(fw, 1_000_000 + MESSAGES_BACK_FROM_MS - 1);
    expect(view.classList.contains(GN_HIDDEN)).toBe(true);
    advance(fw, 1_000_000 + MESSAGES_BACK_FROM_MS);
    expect(view.classList.contains(GN_HIDDEN)).toBe(false);
    expect(handle!.phase).toBe("playing");
    advance(fw, 1_000_000 + SCENE_END_MS);
    expect(handle!.phase).toBe("background");
    expect(release).toHaveBeenCalledTimes(1);
    expect(visibleCanvas()).toBeNull();
    const layer = wrap.querySelector(":scope > .wx-srv-goodnight-bg");
    expect(layer).not.toBeNull();
    expect(layer!.querySelector("canvas")).not.toBeNull();
    expect(wrap.classList.contains(GN_BACKGROUND)).toBe(true);
    expect(wrap.firstElementChild).toBe(layer); // behind the thread
    expect(fw.pendingFrames()).toBe(1); // the starfield keeps twinkling
  });

  it("skips to background mode on a tap", () => {
    const fw = fakeWin();
    start(fw);
    advance(fw, 1_000_500);
    visibleCanvas()!.click();
    expect(handle!.phase).toBe("background");
    expect(release).toHaveBeenCalledTimes(1);
    expect(view.classList.contains(GN_HIDDEN)).toBe(false);
    expect(visibleCanvas()).toBeNull();
    expect(wrap.querySelector(".wx-srv-goodnight-bg canvas")).not.toBeNull();
    visibleCanvas()?.click();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips to background mode on Escape", () => {
    const fw = fakeWin();
    start(fw);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(handle!.phase).toBe("playing");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handle!.phase).toBe("background");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("tears everything down on close and leaves no listeners or frames", () => {
    const keys = trackDocumentListeners(document, "keydown");
    const fw = fakeWin();
    start(fw);
    expect(keys.live()).toBe(1);
    expect(fw.listenerCount()).toBe(1); // resize
    handle!.close();
    expect(handle!.phase).toBe("closed");
    expect(visibleCanvas()).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();
    expect(wrap.querySelector(".wx-srv-goodnight-bg")).toBeNull();
    expect(view.classList.contains(GN_FADING)).toBe(false);
    expect(view.classList.contains(GN_HIDDEN)).toBe(false);
    expect(wrap.classList.contains(GN_BACKGROUND)).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(fw.pendingFrames()).toBe(0);
    expect(fw.listenerCount()).toBe(0);
    expect(keys.live()).toBe(0);
    handle!.close(); // idempotent
    expect(release).toHaveBeenCalledTimes(1);
    keys.restore();
  });

  it("tears the background layer down too, with nothing left behind", () => {
    const keys = trackDocumentListeners(document, "keydown");
    const fw = fakeWin();
    start(fw);
    handle!.skip();
    expect(handle!.phase).toBe("background");
    handle!.close();
    expect(document.querySelector("canvas")).toBeNull();
    expect(wrap.querySelector(".wx-srv-goodnight-bg")).toBeNull();
    expect(wrap.classList.contains(GN_BACKGROUND)).toBe(false);
    expect(fw.pendingFrames()).toBe(0);
    expect(fw.listenerCount()).toBe(0);
    expect(keys.live()).toBe(0);
    keys.restore();
  });

  it("a closed scene never draws again", () => {
    const fw = fakeWin();
    start(fw);
    handle!.close();
    const before = canvasStub.contexts.flatMap((c) => c.drawImage.mock.calls).length;
    fw.step();
    advance(fw, 1_005_000);
    expect(canvasStub.contexts.flatMap((c) => c.drawImage.mock.calls).length).toBe(before);
  });

  it("re-lays out on resize", () => {
    const fw = fakeWin({ width: 360, height: 640 });
    start(fw);
    fw.innerWidth = 720;
    fw.innerHeight = 400;
    fw.fire("resize");
    const canvas = visibleCanvas()!;
    expect([canvas.width, canvas.height]).toEqual([120, 67]); // scale 6
    expect(canvas.style.width).toBe("720px");
    expect(canvas.style.height).toBe(`${67 * 6}px`);
  });

  it("does nothing when there is no 2D canvas", () => {
    canvasStub.restore();
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    const fw = fakeWin();
    start(fw);
    expect(handle!.phase).toBe("closed");
    expect(document.querySelector("canvas")).toBeNull();
    expect(suspend).not.toHaveBeenCalled();
  });
});

describe("idle suspension", () => {
  it("is held while playing and released on natural finish", () => {
    const fw = fakeWin();
    start(fw);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    advance(fw, 1_000_000 + SCENE_END_MS + 1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is released when closed mid-scene", () => {
    const fw = fakeWin();
    start(fw);
    handle!.close();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("reduced motion", () => {
  it("skips the scene: a static starfield behind the thread, no overlay, no suspension, no frames", () => {
    const fw = fakeWin({ reducedMotion: true });
    start(fw);
    expect(handle!.phase).toBe("background");
    expect(visibleCanvas()).toBeNull();
    expect(wrap.querySelector(".wx-srv-goodnight-bg canvas")).not.toBeNull();
    expect(suspend).not.toHaveBeenCalled();
    expect(fw.pendingFrames()).toBe(0);
    expect(view.classList.contains(GN_FADING)).toBe(false);
    const calls = canvasStub.contexts.flatMap((c) => c.drawImage.mock.calls);
    expect(calls.length).toBeGreaterThan(5); // the stars, drawn once
    fw.step();
    expect(canvasStub.contexts.flatMap((c) => c.drawImage.mock.calls).length).toBe(calls.length);
  });

  it("leaves nothing behind on close", () => {
    const fw = fakeWin({ reducedMotion: true });
    start(fw);
    handle!.close();
    expect(document.querySelector("canvas")).toBeNull();
    expect(wrap.classList.contains(GN_BACKGROUND)).toBe(false);
    expect(fw.listenerCount()).toBe(0);
  });
});
