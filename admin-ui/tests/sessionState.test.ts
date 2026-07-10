import { describe, expect, it } from "vitest";
import { clearLastRoute, loadLastRoute, saveLastRoute } from "../src/sessionState";

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

describe("loadLastRoute", () => {
  it("returns null when nothing is stored", () => {
    expect(loadLastRoute(fakeWindow())).toBeNull();
  });

  it("returns null if localStorage throws", () => {
    const win = {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    } as unknown as Window;
    expect(loadLastRoute(win)).toBeNull();
  });
});

describe("saveLastRoute / loadLastRoute round-trip", () => {
  it("round-trips a simple route", () => {
    const win = fakeWindow();
    saveLastRoute({ kind: "media" }, win);
    expect(loadLastRoute(win)).toEqual({ kind: "media" });
  });

  it("round-trips a route with a parameter", () => {
    const win = fakeWindow();
    saveLastRoute({ kind: "edit", page: "about" }, win);
    expect(loadLastRoute(win)).toEqual({ kind: "edit", page: "about" });
  });

  it("round-trips a settings sub-page", () => {
    const win = fakeWindow();
    saveLastRoute({ kind: "settings", page: "shortcuts" }, win);
    expect(loadLastRoute(win)).toEqual({ kind: "settings", page: "shortcuts" });
  });

  it("a later save overwrites an earlier one", () => {
    const win = fakeWindow();
    saveLastRoute({ kind: "pages" }, win);
    saveLastRoute({ kind: "history" }, win);
    expect(loadLastRoute(win)).toEqual({ kind: "history" });
  });

  it("save is best-effort and does not throw if localStorage throws", () => {
    const win = {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    } as unknown as Window;
    expect(() => saveLastRoute({ kind: "pages" }, win)).not.toThrow();
  });
});

describe("clearLastRoute", () => {
  it("removes a previously saved route", () => {
    const win = fakeWindow();
    saveLastRoute({ kind: "media" }, win);
    clearLastRoute(win);
    expect(loadLastRoute(win)).toBeNull();
  });

  it("is a no-op (not a throw) when nothing was ever saved", () => {
    const win = fakeWindow();
    expect(() => clearLastRoute(win)).not.toThrow();
  });
});
