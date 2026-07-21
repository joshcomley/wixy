// Last-active-view persistence (Uxer's session-persistence mandate, item 6:
// "Last active view/module — reopen to the same page the user was on").
// The other session-persisted pieces (theme mode, zoom, font-scale, shortcut
// bindings) each already own this same shape — one focused localStorage key,
// loaded on init, saved on every change — in theme.ts/zoom.ts/fontScale.ts/
// shortcuts.ts respectively. That's the "one coherent persistence layer"
// Uxer asks for: a single consistent pattern across every concern, surfaced
// together in Settings > General (settingsPanel.ts), rather than a forced
// single-blob merge that would need admin_shell.html's pre-paint bootstrap
// script to parse combined JSON for no real benefit.

import { parseHash, parsePath, routeToPath, type Route } from "./router";

const STORAGE_KEY = "wx-last-route";

export function saveLastRoute(route: Route, win: Window = window): void {
  try {
    win.localStorage.setItem(STORAGE_KEY, routeToPath(route));
  } catch {
    // best-effort persistence only
  }
}

export function loadLastRoute(win: Window = window): Route | null {
  try {
    const stored = win.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return null;
    // Values written before decisions/00087 are hash spellings ("#/edit/x") —
    // parse those too rather than orphaning the operator's stored view.
    return stored.startsWith("#") ? parseHash(stored) : parsePath(stored);
  } catch {
    return null;
  }
}

export function clearLastRoute(win: Window = window): void {
  try {
    win.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort persistence only
  }
}
