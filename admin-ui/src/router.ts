// Client-side hash routing (spec/05-editor.md §1): "#/pages", "#/edit/<page>",
// "#/theme", "#/media", "#/chat", "#/chat/<conv>", "#/history",
// "#/settings", "#/settings/appearance", "#/settings/shortcuts",
// "#/settings/engine" (spec/independence/04 §2 — standalone-only content,
// but the route/tab always exists; the panel itself degrades gracefully on
// the fleet edition), "#/settings/ai" (spec/independence/05 §2 —
// anthropic-backend-only content, same always-exists-but-degrades-gracefully
// shape as "engine"). No History-API routing — the whole admin is a single
// served document (wixy_server.app.get_admin_shell: "every /admin sub-route
// the browser might deep-link to is this same document").

export type SettingsPage = "general" | "appearance" | "shortcuts" | "engine" | "ai";

export type Route =
  | { kind: "pages" }
  | { kind: "edit"; page: string }
  | { kind: "theme" }
  | { kind: "media" }
  | { kind: "chat"; conversation: string | null }
  | { kind: "history" }
  | { kind: "settings"; page: SettingsPage };

export const DEFAULT_ROUTE: Route = { kind: "pages" };

/** Parses `location.hash` (leading "#" included or not) into a `Route` — an
 * empty or unrecognized hash falls back to the pages panel (spec/05 §1 defines
 * no dedicated 404 route; "#/pages" is the natural landing page). */
export function parseHash(hash: string): Route {
  const trimmed = hash.replace(/^#/, "");
  const segments = trimmed.split("/").filter((s) => s.length > 0);
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
                  : "general",
      };
    default:
      return DEFAULT_ROUTE;
  }
}

export function routeToHash(route: Route): string {
  switch (route.kind) {
    case "pages":
      return "#/pages";
    case "edit":
      return `#/edit/${route.page}`;
    case "theme":
      return "#/theme";
    case "media":
      return "#/media";
    case "chat":
      return route.conversation !== null ? `#/chat/${route.conversation}` : "#/chat";
    case "history":
      return "#/history";
    case "settings":
      if (route.page === "shortcuts") return "#/settings/shortcuts";
      if (route.page === "appearance") return "#/settings/appearance";
      if (route.page === "engine") return "#/settings/engine";
      if (route.page === "ai") return "#/settings/ai";
      return "#/settings";
  }
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

export function currentRoute(win: Window = window): Route {
  return parseHash(win.location.hash);
}

export function onRouteChange(handler: (route: Route) => void, win: Window = window): () => void {
  const listener = (): void => handler(parseHash(win.location.hash));
  win.addEventListener("hashchange", listener);
  return () => win.removeEventListener("hashchange", listener);
}

export function navigateTo(route: Route, win: Window = window): void {
  win.location.hash = routeToHash(route);
}
