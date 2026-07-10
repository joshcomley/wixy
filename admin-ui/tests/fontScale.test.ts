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

  it("Ctrl+Shift+Equal increases and prevents the default", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initFontScale(win, doc);
    const event = new KeyboardEvent("keydown", {
      cancelable: true,
      ctrlKey: true,
      shiftKey: true,
      code: "Equal",
    });
    win.dispatchEvent(event);
    expect(controller.getLevel()).toBe(FONT_SCALE_DEFAULT + FONT_SCALE_STEP);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+Minus decreases", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initFontScale(win, doc);
    keydown(win, { ctrlKey: true, shiftKey: true, code: "Minus" });
    expect(controller.getLevel()).toBe(FONT_SCALE_DEFAULT - FONT_SCALE_STEP);
  });

  it("ignores Ctrl+Equal without Shift (that's zoom's shortcut, not fontScale's)", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initFontScale(win, doc);
    keydown(win, { ctrlKey: true, code: "Equal" });
    expect(controller.getLevel()).toBe(FONT_SCALE_DEFAULT);
  });

  it("teardown stops listening for shortcuts", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const controller = initFontScale(win, doc);
    controller.teardown();
    keydown(win, { ctrlKey: true, shiftKey: true, code: "Equal" });
    expect(controller.getLevel()).toBe(FONT_SCALE_DEFAULT);
  });

  it("onChange fires with the new level on a button-driven call", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const levels: number[] = [];
    const controller = initFontScale(win, doc, (level) => levels.push(level));
    controller.increase();
    expect(levels).toEqual([FONT_SCALE_DEFAULT + FONT_SCALE_STEP]);
  });

  it("onChange also fires for a keyboard-shortcut-driven change — mirrors zoom.test.ts's same-named case for the same reason (see there for why this matters)", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const levels: number[] = [];
    initFontScale(win, doc, (level) => levels.push(level));
    keydown(win, { ctrlKey: true, shiftKey: true, code: "Equal" });
    keydown(win, { ctrlKey: true, shiftKey: true, code: "Minus" });
    expect(levels).toEqual([FONT_SCALE_DEFAULT + FONT_SCALE_STEP, FONT_SCALE_DEFAULT]);
  });

  it("onChange does not fire for an unmatched keydown", () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const levels: number[] = [];
    initFontScale(win, doc, (level) => levels.push(level));
    keydown(win, { ctrlKey: true, code: "Equal" }); // no Shift
    expect(levels).toEqual([]);
  });
});
