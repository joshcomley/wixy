import { describe, expect, it } from "vitest";
import { initZoom, loadZoomLevel, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "../src/zoom";

function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function fakeWindow(opts: { storage?: Storage } = {}): Window {
  const storage = opts.storage ?? fakeStorage();
  const target = new EventTarget();
  return {
    localStorage: storage,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as Window;
}

function fakeDocument(): Document {
  const html = document.createElement("html");
  return { documentElement: html } as unknown as Document;
}

function keydown(win: Window, init: KeyboardEventInit): void {
  win.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...init }));
}

describe("loadZoomLevel", () => {
  it("defaults to 100 when nothing is stored", () => {
    expect(loadZoomLevel(fakeWindow())).toBe(ZOOM_DEFAULT);
  });

  it("returns a stored valid level", () => {
    const storage = fakeStorage();
    storage.setItem("wx-zoom-level", "150");
    expect(loadZoomLevel(fakeWindow({ storage }))).toBe(150);
  });

  it("clamps a stored out-of-range level", () => {
    const storage = fakeStorage();
    storage.setItem("wx-zoom-level", "9999");
    expect(loadZoomLevel(fakeWindow({ storage }))).toBe(ZOOM_MAX);
  });

  it("falls back to default for a garbage stored value", () => {
    const storage = fakeStorage();
    storage.setItem("wx-zoom-level", "not-a-number");
    expect(loadZoomLevel(fakeWindow({ storage }))).toBe(ZOOM_DEFAULT);
  });

  it("falls back to default if localStorage throws", () => {
    const win = {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    } as unknown as Window;
    expect(loadZoomLevel(win)).toBe(ZOOM_DEFAULT);
  });
});

describe("initZoom", () => {
  it("applies the persisted level's CSS zoom on init", () => {
    const storage = fakeStorage();
    storage.setItem("wx-zoom-level", "120");
    const doc = fakeDocument();
    initZoom(fakeWindow({ storage }), doc);
    expect(doc.documentElement.style.zoom).toBe("1.2");
  });

  it("zoomIn/zoomOut step by ZOOM_STEP and persist", () => {
    const storage = fakeStorage();
    const win = fakeWindow({ storage });
    const doc = fakeDocument();
    const controller = initZoom(win, doc);

    controller.zoomIn();
    expect(controller.getLevel()).toBe(ZOOM_DEFAULT + ZOOM_STEP);
    expect(doc.documentElement.style.zoom).toBe(String((ZOOM_DEFAULT + ZOOM_STEP) / 100));
    expect(storage.getItem("wx-zoom-level")).toBe(String(ZOOM_DEFAULT + ZOOM_STEP));

    controller.zoomOut();
    controller.zoomOut();
    expect(controller.getLevel()).toBe(ZOOM_DEFAULT - ZOOM_STEP);
  });

  it("clamps at ZOOM_MAX and ZOOM_MIN", () => {
    const doc = fakeDocument();
    const controller = initZoom(fakeWindow(), doc);
    for (let i = 0; i < 20; i++) controller.zoomIn();
    expect(controller.getLevel()).toBe(ZOOM_MAX);
    for (let i = 0; i < 20; i++) controller.zoomOut();
    expect(controller.getLevel()).toBe(ZOOM_MIN);
  });

  it("reset returns to ZOOM_DEFAULT", () => {
    const doc = fakeDocument();
    const controller = initZoom(fakeWindow(), doc);
    controller.setLevel(180);
    controller.reset();
    expect(controller.getLevel()).toBe(ZOOM_DEFAULT);
  });

  it("Ctrl+Equal zooms in and prevents the default (native) zoom", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initZoom(win, doc);
    const event = new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, code: "Equal" });
    win.dispatchEvent(event);
    expect(controller.getLevel()).toBe(ZOOM_DEFAULT + ZOOM_STEP);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Ctrl+Minus zooms out", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initZoom(win, doc);
    keydown(win, { ctrlKey: true, code: "Minus" });
    expect(controller.getLevel()).toBe(ZOOM_DEFAULT - ZOOM_STEP);
  });

  it("Ctrl+Digit0 resets to ZOOM_DEFAULT", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initZoom(win, doc);
    controller.setLevel(170);
    keydown(win, { ctrlKey: true, code: "Digit0" });
    expect(controller.getLevel()).toBe(ZOOM_DEFAULT);
  });

  it("ignores Ctrl+Shift+Equal (that's fontScale's shortcut, not zoom's)", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initZoom(win, doc);
    keydown(win, { ctrlKey: true, shiftKey: true, code: "Equal" });
    expect(controller.getLevel()).toBe(ZOOM_DEFAULT);
  });

  it("ignores a plain Equal keydown with no modifier", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initZoom(win, doc);
    keydown(win, { code: "Equal" });
    expect(controller.getLevel()).toBe(ZOOM_DEFAULT);
  });

  it("teardown stops listening for shortcuts", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initZoom(win, doc);
    controller.teardown();
    keydown(win, { ctrlKey: true, code: "Equal" });
    expect(controller.getLevel()).toBe(ZOOM_DEFAULT);
  });

  it("onChange fires with the new level on a button-driven call", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const levels: number[] = [];
    const controller = initZoom(win, doc, (level) => levels.push(level));
    controller.zoomIn();
    expect(levels).toEqual([ZOOM_DEFAULT + ZOOM_STEP]);
  });

  it("onChange also fires for a keyboard-shortcut-driven change — this is the exact gap that left shell.ts's topbar percentage label stale after Ctrl+Plus/Minus/0, caught only by real-browser verification, not by asserting on controller state alone", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const levels: number[] = [];
    initZoom(win, doc, (level) => levels.push(level));
    keydown(win, { ctrlKey: true, code: "Equal" });
    keydown(win, { ctrlKey: true, code: "Digit0" });
    expect(levels).toEqual([ZOOM_DEFAULT + ZOOM_STEP, ZOOM_DEFAULT]);
  });

  it("onChange does not fire for an unmatched keydown", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const levels: number[] = [];
    initZoom(win, doc, (level) => levels.push(level));
    keydown(win, { code: "Equal" }); // no Ctrl
    expect(levels).toEqual([]);
  });
});
