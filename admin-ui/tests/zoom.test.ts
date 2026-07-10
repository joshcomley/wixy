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
  return { localStorage: storage } as unknown as Window;
}

function fakeDocument(): Document {
  const html = document.createElement("html");
  return { documentElement: html } as unknown as Document;
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

  it("subscribe fires with the new level on every change", () => {
    const doc = fakeDocument();
    const controller = initZoom(fakeWindow(), doc);
    const levels: number[] = [];
    controller.subscribe((level) => levels.push(level));
    controller.zoomIn();
    controller.zoomIn();
    controller.reset();
    expect(levels).toEqual([ZOOM_DEFAULT + ZOOM_STEP, ZOOM_DEFAULT + 2 * ZOOM_STEP, ZOOM_DEFAULT]);
  });

  it("supports multiple independent subscribers — the topbar label and Settings > General both watch the same controller", () => {
    const doc = fakeDocument();
    const controller = initZoom(fakeWindow(), doc);
    const a: number[] = [];
    const b: number[] = [];
    controller.subscribe((level) => a.push(level));
    controller.subscribe((level) => b.push(level));
    controller.zoomIn();
    expect(a).toEqual([ZOOM_DEFAULT + ZOOM_STEP]);
    expect(b).toEqual([ZOOM_DEFAULT + ZOOM_STEP]);
  });

  it("unsubscribe stops further notifications to that listener only", () => {
    const doc = fakeDocument();
    const controller = initZoom(fakeWindow(), doc);
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = controller.subscribe((level) => a.push(level));
    controller.subscribe((level) => b.push(level));
    controller.zoomIn();
    unsubA();
    controller.zoomIn();
    expect(a).toEqual([ZOOM_DEFAULT + ZOOM_STEP]);
    expect(b).toEqual([ZOOM_DEFAULT + ZOOM_STEP, ZOOM_DEFAULT + 2 * ZOOM_STEP]);
  });
});
