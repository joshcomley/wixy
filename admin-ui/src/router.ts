// Client-side PATH routing (decisions/00087): "/admin/pages", "/admin/edit/<page>",
// "/admin/theme", "/admin/media", "/admin/chat", "/admin/chat/<conv>",
// "/admin/history", "/admin/settings", "/admin/settings/appearance",
// "/admin/settings/shortcuts", "/admin/settings/engine" (spec/independence/04 §2 —
// standalone-only content, but the route/tab always exists; the panel itself
// degrades gracefully on the fleet edition), "/admin/settings/ai"
// (spec/independence/05 §2 — anthropic-backend-only content, same
// always-exists-but-degrades-gracefully shape as "engine"),
// "/admin/settings/system" (spec/independence/06 §3 — backup age/disk usage/last
// publish/engine version, meaningful on BOTH editions, unlike "engine"/"ai"
// above). Every path serves the same shell document
// (`wixy_server.app.get_admin_shell_deep_link`) and this module parses it.
//
// History: until decisions/00087 these were HASH fragments ("#/pages", …) — "no
// History-API routing, the whole admin is a single served document". Proper
// paths won (operator 2026-07-21): they're shareable/linkable in the normal web
// way and the server already served one document for everything. LEGACY hashes
// keep working forever: `parseHash`/`routeToHash` stay, a hash in the URL wins
// over the path, and `canonicalizeUrl` rewrites it to the path on load.

export type SettingsPage = "general" | "appearance" | "shortcuts" | "engine" | "ai" | "system";

export type Route =
  | { kind: "pages" }
  | { kind: "edit"; page: string }
  | { kind: "theme" }
  | { kind: "media" }
  | { kind: "chat"; conversation: string | null }
  | { kind: "history" }
  | { kind: "settings"; page: SettingsPage };

export const DEFAULT_ROUTE: Route = { kind: "pages" };

/** The shared segment→Route mapping behind both parsers — one route table, two
 * URL spellings (path segments after "/admin", hash segments after "#"). */
function routeFromSegments(segments: string[]): Route {
  const first = segments[0];
  const second = segments[1];

  switch (first) {
    case undefined:
    case "pages":
      return { kind: "pages" };
    case "edit":
      return second !== undefined ? { kind: "edit", page: second } : DEFAULT_ROUTE;
    case "theme":
      return { kind: "theme" };
    case "media":
      return { kind: "media" };
    case "chat":
      return { kind: "chat", conversation: second ?? null };
    case "history":
      return { kind: "history" };
    case "settings":
      return {
        kind: "settings",
        page:
          second === "shortcuts"
            ? "shortcuts"
            : second === "appearance"
              ? "appearance"
              : second === "engine"
                ? "engine"
                : second === "ai"
                  ? "ai"
                  : second === "system"
                    ? "system"
                    : "general",
      };
    default:
      return DEFAULT_ROUTE;
  }
}

/** Parses an admin PATH ("/admin/edit/about", leading "/admin" included or not)
 * into a `Route` — a bare or unrecognized path falls back to the pages panel
 * (spec/05 §1 defines no dedicated 404 route; the pages panel is the natural
 * landing page). */
export function parsePath(pathname: string): Route {
  const withoutPrefix = pathname.replace(/^\/admin/, "");
  const segments = withoutPrefix.split("/").filter((s) => s.length > 0);
  return routeFromSegments(segments);
}

/** LEGACY (pre-00087) hash parsing — kept so old "#/…" links never break. */
export function parseHash(hash: string): Route {
  const trimmed = hash.replace(/^#/, "");
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  return routeFromSegments(segments);
}

function segmentsFor(route: Route): string[] {
  switch (route.kind) {
    case "pages":
      return ["pages"];
    case "edit":
      return ["edit", route.page];
    case "theme":
      return ["theme"];
    case "media":
      return ["media"];
    case "chat":
      return route.conversation !== null ? ["chat", route.conversation] : ["chat"];
    case "history":
      return ["history"];
    case "settings":
      return route.page === "general" ? ["settings"] : ["settings", route.page];
  }
}

export function routeToPath(route: Route): string {
  return `/admin/${segmentsFor(route).join("/")}`;
}

/** LEGACY (pre-00087) hash spelling — kept for reading old stored/deep-link
 * values; never emitted into the address bar anymore. */
export function routeToHash(route: Route): string {
  return `#/${segmentsFor(route).join("/")}`;
}

/** Whether two routes are the "same panel" for mount/no-op purposes — same kind,
 * and (for edit) the same page. Used to avoid tearing down and recreating a
 * panel when a route change doesn't actually change what should be showing. */
export function sameRoute(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "edit" && b.kind === "edit") return a.page === b.page;
  if (a.kind === "chat" && b.kind === "chat") return a.conversation === b.conversation;
  if (a.kind === "settings" && b.kind === "settings") return a.page === b.page;
  return true;
}

/** The route the current URL means: a non-empty (legacy) hash always wins
 * (normal web navigation expectations for old links); otherwise the path. */
export function currentRoute(win: Window = window): Route {
  const hash = win.location.hash.replace(/^#/, "");
  if (hash.length > 0) return parseHash(hash);
  return parsePath(win.location.pathname);
}

/** Rewrites the URL to its canonical path spelling WITHOUT a navigation:
 * a legacy "#/…" deep link becomes its path (the hash is gone from the address
 * bar and from what a copy/share would capture), and a bare "/admin" becomes
 * the canonical panel path. Already-canonical URLs are left alone. */
export function canonicalizeUrl(win: Window = window): void {
  const hash = win.location.hash.replace(/^#/, "");
  if (hash.length > 0) {
    win.history.replaceState({}, "", routeToPath(parseHash(hash)));
    return;
  }
  if (win.location.pathname === "/admin" || win.location.pathname === "/admin/") {
    win.history.replaceState({}, "", routeToPath(currentRoute(win)));
  }
}

export function onRouteChange(handler: (route: Route) => void, win: Window = window): () => void {
  const listener = (): void => handler(currentRoute(win));
  // popstate: back/forward (and navigateTo's own notification below).
  // hashchange: a hand-typed legacy "#/…" after load still routes.
  win.addEventListener("popstate", listener);
  win.addEventListener("hashchange", listener);
  return () => {
    win.removeEventListener("popstate", listener);
    win.removeEventListener("hashchange", listener);
  };
}

export function navigateTo(route: Route, win: Window = window): void {
  win.history.pushState({}, "", routeToPath(route));
  // pushState fires no popstate of its own — notify listeners the way the
  // browser would for a real traversal (they only read the location).
  win.dispatchEvent(new Event("popstate"));
}
