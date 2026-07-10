// Light/Dark/System theme management for the admin shell's own chrome (NOT
// the published site's theme — that's themePanel.ts/themeVars.ts, a
// completely separate concern: the site's `theme.json` colors/fonts vs. this
// module's admin-UI-only appearance). Persisted in localStorage so the
// preference survives reloads; `admin_shell.html`'s own inline bootstrap
// script applies the persisted value synchronously before first paint (no
// flash of the wrong theme) — this module owns everything after that,
// including live OS-preference tracking while "system" is selected.

export type ThemeMode = "light" | "dark" | "system";
export type ThemeVariant = "light" | "dark";

const STORAGE_KEY = "wx-theme-mode";
const VALID_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && (VALID_MODES as readonly string[]).includes(value);
}

export function loadThemeMode(win: Window = window): ThemeMode {
  try {
    const stored = win.localStorage.getItem(STORAGE_KEY);
    return isThemeMode(stored) ? stored : "system";
  } catch {
    return "system"; // localStorage can throw in locked-down/private contexts
  }
}

function systemPrefersDark(win: Window = window): boolean {
  return win.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function resolveVariant(mode: ThemeMode, win: Window = window): ThemeVariant {
  if (mode === "system") return systemPrefersDark(win) ? "dark" : "light";
  return mode;
}

function applyVariant(variant: ThemeVariant, doc: Document = document): void {
  doc.documentElement.setAttribute("data-theme", variant);
}

export interface ThemeController {
  getMode(): ThemeMode;
  /** Sets and persists the mode, applying the resolved variant immediately. */
  setMode(mode: ThemeMode): void;
  /** Fires after every mode change AND after a live OS-preference change
   * while mode === "system" — the latter used to be silent (only
   * `applyVariant` ran, no external notification), which is harmless for
   * the topbar toggle today (its icon is keyed by mode, not resolved
   * variant, so it never visibly went stale) but would bite the first
   * renderer that also shows the *resolved* variant (Settings > General,
   * slice 4). Fixed here on the same reasoning as zoom.ts/fontScale.ts's
   * subscribe (see decisions/00046) rather than leaving an equivalent bug
   * for the next surface to rediscover. */
  subscribe(listener: (mode: ThemeMode, variant: ThemeVariant) => void): () => void;
  teardown(): void;
}

/** Wires up the theme system for the lifetime of the shell: applies the
 * current mode's resolved variant, and (only while mode === "system") keeps
 * it synced to live OS preference changes. */
export function initTheme(win: Window = window, doc: Document = document): ThemeController {
  let mode = loadThemeMode(win);
  applyVariant(resolveVariant(mode, win), doc);

  const listeners = new Set<(mode: ThemeMode, variant: ThemeVariant) => void>();
  function notify(): void {
    const variant = resolveVariant(mode, win);
    listeners.forEach((l) => l(mode, variant));
  }

  const media = win.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystemChange = (): void => {
    if (mode === "system") {
      applyVariant(resolveVariant(mode, win), doc);
      notify();
    }
  };
  media?.addEventListener?.("change", onSystemChange);

  return {
    getMode: () => mode,
    setMode: (next: ThemeMode) => {
      mode = next;
      try {
        win.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // best-effort persistence only
      }
      applyVariant(resolveVariant(next, win), doc);
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    teardown: () => media?.removeEventListener?.("change", onSystemChange),
  };
}
