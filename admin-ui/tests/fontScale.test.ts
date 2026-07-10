import { describe, expect, it } from "vitest";
import {
  FONT_SCALE_DEFAULT,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  initFontScale,
  loadFontScale,
} from "../src/fontScale";

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

describe("loadFontScale", () => {
  it("defaults to 100 when nothing is stored", () => {
    expect(loadFontScale(fakeWindow())).toBe(FONT_SCALE_DEFAULT);
  });

  it("returns a stored valid level", () => {
    const storage = fakeStorage();
    storage.setItem("wx-font-scale", "130");
    expect(loadFontScale(fakeWindow({ storage }))).toBe(130);
  });

  it("clamps a stored out-of-range level", () => {
    const storage = fakeStorage();
    storage.setItem("wx-font-scale", "5");
    expect(loadFontScale(fakeWindow({ storage }))).toBe(FONT_SCALE_MIN);
  });

  it("falls back to default for a garbage stored value", () => {
    const storage = fakeStorage();
    storage.setItem("wx-font-scale", "huge");
    expect(loadFontScale(fakeWindow({ storage }))).toBe(FONT_SCALE_DEFAULT);
  });

  it("falls back to default if localStorage throws", () => {
    const win = {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    } as unknown as Window;
    expect(loadFontScale(win)).toBe(FONT_SCALE_DEFAULT);
  });
});

describe("initFontScale", () => {
  it("applies the persisted level as <html> font-size on init", () => {
    const storage = fakeStorage();
    storage.setItem("wx-font-scale", "120");
    const doc = fakeDocument();
    initFontScale(fakeWindow({ storage }), doc);
    expect(doc.documentElement.style.fontSize).toBe("120%");
  });

  it("increase/decrease step by FONT_SCALE_STEP and persist", () => {
    const storage = fakeStorage();
    const win = fakeWindow({ storage });
    const doc = fakeDocument();
    const controller = initFontScale(win, doc);

    controller.increase();
    expect(controller.getLevel()).toBe(FONT_SCALE_DEFAULT + FONT_SCALE_STEP);
    expect(doc.documentElement.style.fontSize).toBe(`${FONT_SCALE_DEFAULT + FONT_SCALE_STEP}%`);
    expect(storage.getItem("wx-font-scale")).toBe(String(FONT_SCALE_DEFAULT + FONT_SCALE_STEP));

    controller.decrease();
    controller.decrease();
    expect(controller.getLevel()).toBe(FONT_SCALE_DEFAULT - FONT_SCALE_STEP);
  });

  it("clamps at FONT_SCALE_MAX and FONT_SCALE_MIN", () => {
    const doc = fakeDocument();
    const controller = initFontScale(fakeWindow(), doc);
    for (let i = 0; i < 20; i++) controller.increase();
    expect(controller.getLevel()).toBe(FONT_SCALE_MAX);
    for (let i = 0; i < 20; i++) controller.decrease();
    expect(controller.getLevel()).toBe(FONT_SCALE_MIN);
  });

  it("reset returns to FONT_SCALE_DEFAULT", () => {
    const doc = fakeDocument();
    const controller = initFontScale(fakeWindow(), doc);
    controller.setLevel(140);
    controller.reset();
    expect(controller.getLevel()).toBe(FONT_SCALE_DEFAULT);
  });

  it("subscribe fires with the new level on every change", () => {
    const doc = fakeDocument();
    const controller = initFontScale(fakeWindow(), doc);
    const levels: number[] = [];
    controller.subscribe((level) => levels.push(level));
    controller.increase();
    controller.increase();
    controller.reset();
    expect(levels).toEqual([
      FONT_SCALE_DEFAULT + FONT_SCALE_STEP,
      FONT_SCALE_DEFAULT + 2 * FONT_SCALE_STEP,
      FONT_SCALE_DEFAULT,
    ]);
  });

  it("supports multiple independent subscribers", () => {
    const doc = fakeDocument();
    const controller = initFontScale(fakeWindow(), doc);
    const a: number[] = [];
    const b: number[] = [];
    controller.subscribe((level) => a.push(level));
    controller.subscribe((level) => b.push(level));
    controller.increase();
    expect(a).toEqual([FONT_SCALE_DEFAULT + FONT_SCALE_STEP]);
    expect(b).toEqual([FONT_SCALE_DEFAULT + FONT_SCALE_STEP]);
  });

  it("unsubscribe stops further notifications to that listener only", () => {
    const doc = fakeDocument();
    const controller = initFontScale(fakeWindow(), doc);
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = controller.subscribe((level) => a.push(level));
    controller.subscribe((level) => b.push(level));
    controller.increase();
    unsubA();
    controller.increase();
    expect(a).toEqual([FONT_SCALE_DEFAULT + FONT_SCALE_STEP]);
    expect(b).toEqual([FONT_SCALE_DEFAULT + FONT_SCALE_STEP, FONT_SCALE_DEFAULT + 2 * FONT_SCALE_STEP]);
  });
});
