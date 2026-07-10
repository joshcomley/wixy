import { describe, expect, it } from "vitest";
import { initTheme, loadThemeMode, resolveVariant } from "../src/theme";

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

function fakeMediaQueryList(matches: boolean): MediaQueryList {
  const listeners = new Set<() => void>();
  return {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
    // exposed for tests to trigger a change
    _fire: () => listeners.forEach((l) => l()),
  } as unknown as MediaQueryList & { _fire: () => void };
}

function fakeWindow(opts: { storage?: Storage; systemDark?: boolean } = {}): Window {
  const storage = opts.storage ?? fakeStorage();
  const mql = fakeMediaQueryList(opts.systemDark ?? false);
  return {
    localStorage: storage,
    matchMedia: () => mql,
  } as unknown as Window & { __mql: typeof mql };
}

function fakeDocument(): Document {
  const html = document.createElement("html");
  return { documentElement: html } as unknown as Document;
}

describe("loadThemeMode", () => {
  it("defaults to system when nothing is stored", () => {
    expect(loadThemeMode(fakeWindow())).toBe("system");
  });

  it("returns a stored valid mode", () => {
    const storage = fakeStorage();
    storage.setItem("wx-theme-mode", "dark");
    expect(loadThemeMode(fakeWindow({ storage }))).toBe("dark");
  });

  it("falls back to system for a garbage stored value", () => {
    const storage = fakeStorage();
    storage.setItem("wx-theme-mode", "purple");
    expect(loadThemeMode(fakeWindow({ storage }))).toBe("system");
  });

  it("falls back to system if localStorage throws", () => {
    const win = {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    } as unknown as Window;
    expect(loadThemeMode(win)).toBe("system");
  });
});

describe("resolveVariant", () => {
  it("resolves system to dark when the OS prefers dark", () => {
    expect(resolveVariant("system", fakeWindow({ systemDark: true }))).toBe("dark");
  });

  it("resolves system to light when the OS prefers light", () => {
    expect(resolveVariant("system", fakeWindow({ systemDark: false }))).toBe("light");
  });

  it("passes explicit light/dark through unchanged regardless of OS", () => {
    expect(resolveVariant("light", fakeWindow({ systemDark: true }))).toBe("light");
    expect(resolveVariant("dark", fakeWindow({ systemDark: false }))).toBe("dark");
  });
});

describe("initTheme", () => {
  it("applies the persisted mode's resolved variant on init", () => {
    const storage = fakeStorage();
    storage.setItem("wx-theme-mode", "dark");
    const doc = fakeDocument();
    initTheme(fakeWindow({ storage }), doc);
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("setMode persists and re-applies immediately", () => {
    const storage = fakeStorage();
    const win = fakeWindow({ storage });
    const doc = fakeDocument();
    const controller = initTheme(win, doc);

    controller.setMode("dark");
    expect(controller.getMode()).toBe("dark");
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(storage.getItem("wx-theme-mode")).toBe("dark");

    controller.setMode("light");
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");
    expect(storage.getItem("wx-theme-mode")).toBe("light");
  });

  it("while mode is system, a live OS preference change re-applies the variant", () => {
    const doc = fakeDocument();
    const win = fakeWindow({ systemDark: false });
    const mql = win.matchMedia("(prefers-color-scheme: dark)");

    initTheme(win, doc);
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");

    (mql as unknown as { matches: boolean }).matches = true;
    (mql as unknown as { _fire: () => void })._fire();
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("an OS preference change is ignored once an explicit mode is set", () => {
    const doc = fakeDocument();
    const win = fakeWindow({ systemDark: false });
    const mql = win.matchMedia("(prefers-color-scheme: dark)");

    const controller = initTheme(win, doc);
    controller.setMode("light");
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");

    (mql as unknown as { matches: boolean }).matches = true;
    (mql as unknown as { _fire: () => void })._fire();
    // explicit "light" must not flip just because the OS now prefers dark
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("teardown stops listening for OS preference changes", () => {
    const doc = fakeDocument();
    const win = fakeWindow({ systemDark: false });
    const mql = win.matchMedia("(prefers-color-scheme: dark)");

    const controller = initTheme(win, doc);
    controller.teardown();

    (mql as unknown as { matches: boolean }).matches = true;
    (mql as unknown as { _fire: () => void })._fire();
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
