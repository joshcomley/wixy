// Font-scale control for the admin shell's own chrome (Uxer's font-scaling
// mandate — a lever independent of zoom.ts's zoom, for users who want larger
// text without scaling layout/spacing too). Every font-size in style.css is
// expressed in `rem`, so scaling <html>'s own font-size (this module's
// `applyFontScale`) proportionally scales all of it in one place. Persisted
// in localStorage so the level survives reloads; admin_shell.html's own
// inline bootstrap script applies the persisted level synchronously before
// first paint (no flash of the wrong size).

export type FontScaleLevel = number; // a percentage, e.g. 100 = 100%

const STORAGE_KEY = "wx-font-scale";
export const FONT_SCALE_MIN = 80;
export const FONT_SCALE_MAX = 150;
export const FONT_SCALE_STEP = 10;
export const FONT_SCALE_DEFAULT = 100;

function clamp(level: number): FontScaleLevel {
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, level));
}

export function loadFontScale(win: Window = window): FontScaleLevel {
  try {
    const stored = win.localStorage.getItem(STORAGE_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    return Number.isFinite(parsed) ? clamp(parsed) : FONT_SCALE_DEFAULT;
  } catch {
    return FONT_SCALE_DEFAULT; // localStorage can throw in locked-down/private contexts
  }
}

function applyFontScale(level: FontScaleLevel, doc: Document = document): void {
  doc.documentElement.style.fontSize = `${level}%`;
}

type FontScaleAction = "up" | "down";

/** Matches on the physical key (`KeyboardEvent.code`), mirroring
 * zoom.ts's matchShortcut — see that file for why `.code` + shiftKey (not
 * `.key`) is what cleanly separates Ctrl+Shift+Plus from Ctrl+Plus. */
function matchShortcut(e: KeyboardEvent): FontScaleAction | null {
  if (!e.ctrlKey || e.metaKey || !e.shiftKey || e.altKey) return null;
  if (e.code === "Equal" || e.code === "NumpadAdd") return "up";
  if (e.code === "Minus" || e.code === "NumpadSubtract") return "down";
  return null;
}

export interface FontScaleController {
  getLevel(): FontScaleLevel;
  setLevel(level: FontScaleLevel): void;
  increase(): void;
  decrease(): void;
  reset(): void;
  teardown(): void;
}

/** Wires up font-scale for the lifetime of the shell: applies the persisted
 * level immediately and listens globally for Ctrl+Shift+Plus/Minus.
 * `onChange` fires after every level change regardless of source (button
 * click or keyboard shortcut) — see zoom.ts's `initZoom` for why a caller
 * rendering a percentage label needs this rather than only re-rendering
 * from its own click handlers. */
export function initFontScale(
  win: Window = window,
  doc: Document = document,
  onChange?: (level: FontScaleLevel) => void,
): FontScaleController {
  let level = loadFontScale(win);
  applyFontScale(level, doc);

  function setLevel(next: FontScaleLevel): void {
    level = clamp(next);
    try {
      win.localStorage.setItem(STORAGE_KEY, String(level));
    } catch {
      // best-effort persistence only
    }
    applyFontScale(level, doc);
    onChange?.(level);
  }

  const onKeydown = (e: KeyboardEvent): void => {
    const action = matchShortcut(e);
    if (action === null) return;
    e.preventDefault();
    if (action === "up") setLevel(level + FONT_SCALE_STEP);
    else setLevel(level - FONT_SCALE_STEP);
  };
  win.addEventListener("keydown", onKeydown);

  return {
    getLevel: () => level,
    setLevel,
    increase: () => setLevel(level + FONT_SCALE_STEP),
    decrease: () => setLevel(level - FONT_SCALE_STEP),
    reset: () => setLevel(FONT_SCALE_DEFAULT),
    teardown: () => win.removeEventListener("keydown", onKeydown),
  };
}
