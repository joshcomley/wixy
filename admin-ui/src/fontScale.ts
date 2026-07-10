// Font-scale control for the admin shell's own chrome (Uxer's font-scaling
// mandate — a lever independent of zoom.ts's zoom, for users who want larger
// text without scaling layout/spacing too). Every font-size in style.css is
// expressed in `rem`, so scaling <html>'s own font-size (this module's
// `applyFontScale`) proportionally scales all of it in one place. Persisted
// in localStorage so the level survives reloads; admin_shell.html's own
// inline bootstrap script applies the persisted level synchronously before
// first paint (no flash of the wrong size).
//
// A pure state controller — no keyboard handling of its own; see zoom.ts's
// header for why (shortcuts.ts now owns matching, shell.ts registers
// `increase`/`decrease` as commands there).

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

export interface FontScaleController {
  getLevel(): FontScaleLevel;
  setLevel(level: FontScaleLevel): void;
  increase(): void;
  decrease(): void;
  reset(): void;
  /** See zoom.ts's ZoomController.subscribe for why this exists — same
   * multi-renderer staleness reasoning applies here. */
  subscribe(listener: (level: FontScaleLevel) => void): () => void;
}

export function initFontScale(win: Window = window, doc: Document = document): FontScaleController {
  let level = loadFontScale(win);
  applyFontScale(level, doc);

  const listeners = new Set<(level: FontScaleLevel) => void>();

  function setLevel(next: FontScaleLevel): void {
    level = clamp(next);
    try {
      win.localStorage.setItem(STORAGE_KEY, String(level));
    } catch {
      // best-effort persistence only
    }
    applyFontScale(level, doc);
    listeners.forEach((l) => l(level));
  }

  return {
    getLevel: () => level,
    setLevel,
    increase: () => setLevel(level + FONT_SCALE_STEP),
    decrease: () => setLevel(level - FONT_SCALE_STEP),
    reset: () => setLevel(FONT_SCALE_DEFAULT),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
