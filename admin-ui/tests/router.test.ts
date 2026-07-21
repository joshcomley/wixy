import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  currentRoute,
  navigateTo,
  onRouteChange,
  parseHash,
  parsePath,
  routeToHash,
  routeToPath,
  sameRoute,
  type Route,
} from "../src/router";

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

  it("parses #/settings and every settings sub-page", () => {
    expect(parseHash("#/settings")).toEqual({ kind: "settings", page: "general" });
    expect(parseHash("#/settings/appearance")).toEqual({ kind: "settings", page: "appearance" });
    expect(parseHash("#/settings/shortcuts")).toEqual({ kind: "settings", page: "shortcuts" });
    expect(parseHash("#/settings/engine")).toEqual({ kind: "settings", page: "engine" });
    expect(parseHash("#/settings/ai")).toEqual({ kind: "settings", page: "ai" });
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
      { kind: "settings", page: "engine" },
      { kind: "settings", page: "ai" },
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

// -- Proper path routing (decisions/00087) -------------------------------------

describe("parsePath", () => {
  it("defaults to the pages panel for a bare /admin", () => {
    expect(parsePath("/admin")).toEqual({ kind: "pages" });
    expect(parsePath("/admin/")).toEqual({ kind: "pages" });
    expect(parsePath("/admin/pages")).toEqual({ kind: "pages" });
  });

  it("parses /admin/edit/<page>", () => {
    expect(parsePath("/admin/edit/about")).toEqual({ kind: "edit", page: "about" });
    expect(parsePath("/admin/edit")).toEqual({ kind: "pages" });
    expect(parsePath("/admin/edit/")).toEqual({ kind: "pages" });
  });

  it("parses the stub routes", () => {
    expect(parsePath("/admin/theme")).toEqual({ kind: "theme" });
    expect(parsePath("/admin/media")).toEqual({ kind: "media" });
    expect(parsePath("/admin/history")).toEqual({ kind: "history" });
  });

  it("parses /admin/chat with and without a conversation id", () => {
    expect(parsePath("/admin/chat")).toEqual({ kind: "chat", conversation: null });
    expect(parsePath("/admin/chat/abc123")).toEqual({ kind: "chat", conversation: "abc123" });
  });

  it("parses /admin/settings and every settings sub-page", () => {
    expect(parsePath("/admin/settings")).toEqual({ kind: "settings", page: "general" });
    expect(parsePath("/admin/settings/appearance")).toEqual({ kind: "settings", page: "appearance" });
    expect(parsePath("/admin/settings/shortcuts")).toEqual({ kind: "settings", page: "shortcuts" });
    expect(parsePath("/admin/settings/engine")).toEqual({ kind: "settings", page: "engine" });
    expect(parsePath("/admin/settings/ai")).toEqual({ kind: "settings", page: "ai" });
    expect(parsePath("/admin/settings/system")).toEqual({ kind: "settings", page: "system" });
    expect(parsePath("/admin/settings/nonsense")).toEqual({ kind: "settings", page: "general" });
  });

  it("falls back to pages for an unrecognized path", () => {
    expect(parsePath("/admin/nonsense")).toEqual({ kind: "pages" });
  });
});

describe("routeToPath", () => {
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
      { kind: "settings", page: "engine" },
      { kind: "settings", page: "ai" },
      { kind: "settings", page: "system" },
    ];
    for (const route of routes) {
      expect(parsePath(routeToPath(route))).toEqual(route);
    }
    // …and they really are PATHS, not hashes.
    expect(routeToPath({ kind: "edit", page: "about" })).toBe("/admin/edit/about");
    expect(routeToPath({ kind: "pages" })).toBe("/admin/pages");
  });
});

/** A minimal window fake for the history-API router: real Map-backed listener
 * sets, a mutable location, and a recording history. */
function fakeHistoryWin(initialPath = "/admin", initialHash = "") {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const state = { pathname: initialPath, hash: initialHash, pushes: [] as string[], replaces: [] as string[] };
  const win = {
    location: {
      get pathname() {
        return state.pathname;
      },
      get hash() {
        return state.hash;
      },
    },
    history: {
      pushState: (_s: unknown, _t: string, url: string) => {
        state.pushes.push(url);
        state.pathname = url;
      },
      replaceState: (_s: unknown, _t: string, url: string) => {
        state.replaces.push(url);
        state.pathname = url;
      },
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((l) => l(event));
      return true;
    },
  } as unknown as Window;
  return { win, state };
}

describe("currentRoute (path + legacy hash)", () => {
  it("routes on the path when there is no hash", () => {
    const { win } = fakeHistoryWin("/admin/edit/about");
    expect(currentRoute(win)).toEqual({ kind: "edit", page: "about" });
  });

  it("a legacy hash still wins over the path (old links must never break)", () => {
    const { win } = fakeHistoryWin("/admin/pages", "#/edit/about");
    expect(currentRoute(win)).toEqual({ kind: "edit", page: "about" });
  });
});

describe("navigateTo (history API)", () => {
  it("pushStates the path and notifies route listeners", () => {
    const { win, state } = fakeHistoryWin("/admin/pages");
    const seen: Route[] = [];
    const unsubscribe = onRouteChange((route) => seen.push(route), win);
    navigateTo({ kind: "edit", page: "about" }, win);
    expect(state.pushes).toEqual(["/admin/edit/about"]);
    expect(seen).toEqual([{ kind: "edit", page: "about" }]);
    unsubscribe();
  });

  it("a popstate (back/forward) notifies with the parsed path", () => {
    const { win, state } = fakeHistoryWin("/admin/edit/about");
    const seen: Route[] = [];
    const unsubscribe = onRouteChange((route) => seen.push(route), win);
    state.pathname = "/admin/pages";
    win.dispatchEvent(new Event("popstate"));
    expect(seen).toEqual([{ kind: "pages" }]);
    unsubscribe();
  });
});

describe("canonicalizeUrl", () => {
  it("rewrites a legacy hash deep-link to its path (no reload, no hash left)", () => {
    const { win, state } = fakeHistoryWin("/admin", "#/edit/about");
    canonicalizeUrl(win);
    expect(state.replaces).toEqual(["/admin/edit/about"]);
  });

  it("rewrites a bare /admin to the canonical panel path", () => {
    const { win, state } = fakeHistoryWin("/admin");
    canonicalizeUrl(win);
    expect(state.replaces).toEqual(["/admin/pages"]);
  });

  it("leaves an already-canonical deep link alone", () => {
    const { win, state } = fakeHistoryWin("/admin/theme");
    canonicalizeUrl(win);
    expect(state.replaces).toEqual([]);
  });
});
