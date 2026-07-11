import { describe, expect, it } from "vitest";
import { navigateTo, onRouteChange, parseHash, routeToHash, sameRoute, type Route } from "../src/router";

describe("parseHash", () => {
  it("defaults to the pages panel for an empty hash", () => {
    expect(parseHash("")).toEqual({ kind: "pages" });
    expect(parseHash("#")).toEqual({ kind: "pages" });
  });

  it("parses #/pages", () => {
    expect(parseHash("#/pages")).toEqual({ kind: "pages" });
  });

  it("parses #/edit/<page>", () => {
    expect(parseHash("#/edit/about")).toEqual({ kind: "edit", page: "about" });
  });

  it("falls back to pages when #/edit has no page segment", () => {
    expect(parseHash("#/edit")).toEqual({ kind: "pages" });
    expect(parseHash("#/edit/")).toEqual({ kind: "pages" });
  });

  it("parses the stub routes", () => {
    expect(parseHash("#/theme")).toEqual({ kind: "theme" });
    expect(parseHash("#/media")).toEqual({ kind: "media" });
    expect(parseHash("#/history")).toEqual({ kind: "history" });
  });

  it("parses #/chat with and without a conversation id", () => {
    expect(parseHash("#/chat")).toEqual({ kind: "chat", conversation: null });
    expect(parseHash("#/chat/abc123")).toEqual({ kind: "chat", conversation: "abc123" });
  });

  it("parses #/settings, #/settings/appearance, and #/settings/shortcuts", () => {
    expect(parseHash("#/settings")).toEqual({ kind: "settings", page: "general" });
    expect(parseHash("#/settings/appearance")).toEqual({ kind: "settings", page: "appearance" });
    expect(parseHash("#/settings/shortcuts")).toEqual({ kind: "settings", page: "shortcuts" });
  });

  it("falls back to general for an unrecognized settings sub-page", () => {
    expect(parseHash("#/settings/nonsense")).toEqual({ kind: "settings", page: "general" });
  });

  it("falls back to pages for an unrecognized route", () => {
    expect(parseHash("#/nonsense")).toEqual({ kind: "pages" });
  });
});

describe("routeToHash", () => {
  it("round-trips every route kind", () => {
    const routes: Route[] = [
      { kind: "pages" },
      { kind: "edit", page: "about" },
      { kind: "theme" },
      { kind: "media" },
      { kind: "chat", conversation: null },
      { kind: "chat", conversation: "abc123" },
      { kind: "history" },
      { kind: "settings", page: "general" },
      { kind: "settings", page: "appearance" },
      { kind: "settings", page: "shortcuts" },
    ];
    for (const route of routes) {
      expect(parseHash(routeToHash(route))).toEqual(route);
    }
  });
});

describe("sameRoute", () => {
  it("is true for identical route kinds with no payload", () => {
    expect(sameRoute({ kind: "pages" }, { kind: "pages" })).toBe(true);
  });

  it("compares the page for edit routes", () => {
    expect(sameRoute({ kind: "edit", page: "about" }, { kind: "edit", page: "about" })).toBe(true);
    expect(sameRoute({ kind: "edit", page: "about" }, { kind: "edit", page: "index" })).toBe(false);
  });

  it("compares the page for settings routes", () => {
    expect(sameRoute({ kind: "settings", page: "general" }, { kind: "settings", page: "general" })).toBe(true);
    expect(sameRoute({ kind: "settings", page: "general" }, { kind: "settings", page: "shortcuts" })).toBe(false);
  });

  it("is false across different kinds", () => {
    expect(sameRoute({ kind: "pages" }, { kind: "theme" })).toBe(false);
  });
});

describe("navigateTo / onRouteChange", () => {
  it("setting a route fires the hashchange handler with the parsed route", () => {
    const listeners = new Map<string, Set<() => void>>();
    let hash = "";
    const fakeWin = {
      location: {
        get hash() {
          return hash;
        },
        set hash(value: string) {
          hash = value.startsWith("#") ? value : `#${value}`;
          listeners.get("hashchange")?.forEach((l) => l());
        },
      },
      addEventListener: (type: string, listener: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      },
    } as unknown as Window;

    const seen: Route[] = [];
    const unsubscribe = onRouteChange((route) => seen.push(route), fakeWin);
    navigateTo({ kind: "edit", page: "about" }, fakeWin);

    expect(seen).toEqual([{ kind: "edit", page: "about" }]);
    unsubscribe();
  });
});
