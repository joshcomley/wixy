// Zoom-level control for the admin shell's own chrome (Uxer's zoom-controls
// mandate). Applies CSS `zoom` to <html> — the web-platform mechanism named
// in UXER-INTEGRATION.md's zoom-controls table, distinct from the browser's
// own native zoom axis. Persisted in localStorage so the level survives
// reloads; admin_shell.html's own inline bootstrap script applies the
// persisted level synchronously before first paint (no flash of the wrong
// zoom). See fontScale.ts for the independent font-only scaling lever.
//
// A pure state controller — no keyboard handling of its own. Slice 3 gave
// this module its own hardcoded Ctrl+Plus/Minus/0 listener; slice 4 moved
// shortcut matching into shortcuts.ts (a single registry so bindings are
// rebindable/disableable in one place) and shell.ts now registers
// `zoomIn`/`zoomOut`/`reset` as commands there instead.

export type ZoomLevel = number; // a percentage, e.g. 100 = 100%

const STORAGE_KEY = "wx-zoom-level";
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;
export const ZOOM_STEP = 10;
export const ZOOM_DEFAULT = 100;

function clamp(level: number): ZoomLevel {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
}

export function loadZoomLevel(win: Window = window): ZoomLevel {
  try {
    const stored = win.localStorage.getItem(STORAGE_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    return Number.isFinite(parsed) ? clamp(parsed) : ZOOM_DEFAULT;
  } catch {
    return ZOOM_DEFAULT; // localStorage can throw in locked-down/private contexts
  }
}

function applyZoom(level: ZoomLevel, doc: Document = document): void {
  doc.documentElement.style.zoom = String(level / 100);
}

export interface ZoomController {
  getLevel(): ZoomLevel;
  setLevel(level: ZoomLevel): void;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  /** Fires after every level change regardless of caller (topbar click,
   * Settings page, or a shortcuts.ts-triggered keyboard shortcut) — any
   * renderer showing the current percentage subscribes rather than only
   * reacting to its own click handlers, or a change from elsewhere in the
   * app silently goes un-rendered (see decisions/00046 for why this
   * matters — it's exactly the bug slice 3 found and fixed for the single-
   * listener predecessor of this). */
  subscribe(listener: (level: ZoomLevel) => void): () => void;
}

export function initZoom(win: Window = window, doc: Document = document): ZoomController {
  let level = loadZoomLevel(win);
  applyZoom(level, doc);

  const listeners = new Set<(level: ZoomLevel) => void>();

  function setLevel(next: ZoomLevel): void {
    level = clamp(next);
    try {
      win.localStorage.setItem(STORAGE_KEY, String(level));
    } catch {
      // best-effort persistence only
    }
    applyZoom(level, doc);
    listeners.forEach((l) => l(level));
  }

  return {
    getLevel: () => level,
    setLevel,
    zoomIn: () => setLevel(level + ZOOM_STEP),
    zoomOut: () => setLevel(level - ZOOM_STEP),
    reset: () => setLevel(ZOOM_DEFAULT),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
