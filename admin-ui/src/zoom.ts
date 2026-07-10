// Zoom-level control for the admin shell's own chrome (Uxer's zoom-controls
// mandate). Applies CSS `zoom` to <html> — the web-platform mechanism named
// in UXER-INTEGRATION.md's zoom-controls table, distinct from the browser's
// own native zoom axis (we intercept and prevent that so the two don't
// compound). Persisted in localStorage so the level survives reloads;
// admin_shell.html's own inline bootstrap script applies the persisted
// level synchronously before first paint (no flash of the wrong zoom).
// See fontScale.ts for the independent font-only scaling lever.

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

type ZoomAction = "in" | "out" | "reset";

/** Matches on the physical key (`KeyboardEvent.code`) rather than the
 * produced character (`.key`), so Ctrl+Plus is recognized whether or not
 * typing '+' required Shift on the user's keyboard layout — and so it's
 * cleanly distinguishable from fontScale.ts's Ctrl+Shift+Plus (same
 * physical key; shiftKey is the discriminator, not the character). */
function matchShortcut(e: KeyboardEvent): ZoomAction | null {
  if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return null;
  if (e.code === "Equal" || e.code === "NumpadAdd") return "in";
  if (e.code === "Minus" || e.code === "NumpadSubtract") return "out";
  if (e.code === "Digit0" || e.code === "Numpad0") return "reset";
  return null;
}

export interface ZoomController {
  getLevel(): ZoomLevel;
  setLevel(level: ZoomLevel): void;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  teardown(): void;
}

/** Wires up zoom for the lifetime of the shell: applies the persisted level
 * immediately and listens globally for Ctrl+Plus/Minus/0, preventing the
 * browser's native zoom so the two don't stack. `onChange` fires after every
 * level change regardless of source (button click or keyboard shortcut) — the
 * keyboard path is handled entirely inside this module's own listener, so a
 * caller rendering a percentage label (shell.ts's topbar) needs this hook
 * rather than only re-rendering from its own click handlers, or a
 * keyboard-triggered change silently goes un-rendered. */
export function initZoom(
  win: Window = window,
  doc: Document = document,
  onChange?: (level: ZoomLevel) => void,
): ZoomController {
  let level = loadZoomLevel(win);
  applyZoom(level, doc);

  function setLevel(next: ZoomLevel): void {
    level = clamp(next);
    try {
      win.localStorage.setItem(STORAGE_KEY, String(level));
    } catch {
      // best-effort persistence only
    }
    applyZoom(level, doc);
    onChange?.(level);
  }

  const onKeydown = (e: KeyboardEvent): void => {
    const action = matchShortcut(e);
    if (action === null) return;
    e.preventDefault();
    if (action === "in") setLevel(level + ZOOM_STEP);
    else if (action === "out") setLevel(level - ZOOM_STEP);
    else setLevel(ZOOM_DEFAULT);
  };
  win.addEventListener("keydown", onKeydown);

  return {
    getLevel: () => level,
    setLevel,
    zoomIn: () => setLevel(level + ZOOM_STEP),
    zoomOut: () => setLevel(level - ZOOM_STEP),
    reset: () => setLevel(ZOOM_DEFAULT),
    teardown: () => win.removeEventListener("keydown", onKeydown),
  };
}
