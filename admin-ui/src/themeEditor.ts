// The theme editor's data/state layer (Uxer's theme-editor mandate, item 9
// — distinct from theme.ts's light/dark/system TOGGLE, item 7: "the toggle
// lets a user *pick* a preset; the theme editor lets them *tailor* one").
// Owns the editable palette schema, per-variant draft state, live preview
// (inline CSS custom properties on <html>, which win over style.css's own
// `:root`/`:root[data-theme]` rules via specificity — no iframe/synthetic
// preview needed since the admin shell's own chrome IS the surface being
// edited), and persistence independent of an explicit Save.

import { resolveVariant, type ThemeController, type ThemeVariant } from "./theme";

export type PaletteKey =
  | "wx-brand-blue"
  | "wx-brand-blue-text"
  | "wx-brand-blue-tint"
  | "wx-ink"
  | "wx-muted"
  | "wx-surface"
  | "wx-canvas"
  | "wx-border"
  | "wx-danger"
  | "wx-danger-text"
  | "wx-danger-tint"
  | "wx-solid-dark"
  | "wx-solid-dark-text";

export interface PaletteEntry {
  key: PaletteKey;
  label: string;
  category: string;
}

// `--wx-inline-code-bg` (an rgba() overlay tint, not a solid color -
// <input type="color"> can't represent alpha) and `--wx-radius`/
// `--wx-shadow` (not colors at all) are deliberately excluded - every
// OTHER custom property style.css's :root blocks define is a genuine
// palette role and is here.
export const PALETTE: readonly PaletteEntry[] = [
  { key: "wx-brand-blue", label: "Brand fill", category: "Brand" },
  { key: "wx-brand-blue-text", label: "Brand text / links", category: "Brand" },
  { key: "wx-brand-blue-tint", label: "Brand tint background", category: "Brand" },
  { key: "wx-ink", label: "Primary text", category: "Text" },
  { key: "wx-muted", label: "Muted text", category: "Text" },
  { key: "wx-surface", label: "Surface (cards / panels)", category: "Surfaces" },
  { key: "wx-canvas", label: "Canvas (page background)", category: "Surfaces" },
  { key: "wx-border", label: "Border", category: "Surfaces" },
  { key: "wx-danger", label: "Danger fill", category: "Danger" },
  { key: "wx-danger-text", label: "Danger text", category: "Danger" },
  { key: "wx-danger-tint", label: "Danger tint background", category: "Danger" },
  { key: "wx-solid-dark", label: "Always-dark chrome fill", category: "Chrome" },
  { key: "wx-solid-dark-text", label: "Always-dark chrome text", category: "Chrome" },
];

export const PALETTE_KEYS: readonly PaletteKey[] = PALETTE.map((entry) => entry.key);

export interface ContrastPair {
  id: string;
  label: string;
  fg: PaletteKey | "white";
  bg: PaletteKey;
  isLargeOrUi: boolean;
  /** The 4 pairs Uxer's save-time WCAG gate checks — genuine running body
   * text on a background. The rest (button fills, badges, tints) are UI
   * components (3:1 bar), not what "never let a user save a theme that
   * fails WCAG AA for body text/background" is talking about. */
  isBodyText: boolean;
}

// Real foreground/background pairs this app's own style.css actually
// renders (traced from the rules themselves, not invented) — e.g.
// "white-brand" mirrors .wx-publish-button (background: var(--wx-brand-
// blue); color: #fff), "danger-tint" mirrors .wx-chat-error-row.
//
// isLargeOrUi is WCAG's actual "large text" criterion (>=18pt, or >=14pt
// bold) — NOT "is this sitting on a UI element." Every pair here is normal-
// weight-or-13px text (button/toast/badge labels), so all ten hold to the
// full 4.5:1 bar; none qualify for the relaxed 3:1 large-text threshold.
// (This was misclassified as `true` for white-brand/white-danger in an
// earlier draft of this file - didn't change either verdict at the time
// since both actual ratios already cleared 4.5:1 or failed 3:1 outright,
// but a future palette edit closer to the margin could have been
// incorrectly waved through under the wrong bar, so fixed regardless.)
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { id: "ink-surface", label: "Body text on surface", fg: "wx-ink", bg: "wx-surface", isLargeOrUi: false, isBodyText: true },
  { id: "ink-canvas", label: "Body text on page background", fg: "wx-ink", bg: "wx-canvas", isLargeOrUi: false, isBodyText: true },
  { id: "muted-surface", label: "Muted text on surface", fg: "wx-muted", bg: "wx-surface", isLargeOrUi: false, isBodyText: true },
  { id: "muted-canvas", label: "Muted text on page background", fg: "wx-muted", bg: "wx-canvas", isLargeOrUi: false, isBodyText: true },
  { id: "link-canvas", label: "Links / accent text on page background", fg: "wx-brand-blue-text", bg: "wx-canvas", isLargeOrUi: false, isBodyText: false },
  { id: "navactive-tint", label: "Active nav text on tint", fg: "wx-brand-blue-text", bg: "wx-brand-blue-tint", isLargeOrUi: false, isBodyText: false },
  { id: "white-brand", label: "White button text on brand fill", fg: "white", bg: "wx-brand-blue", isLargeOrUi: false, isBodyText: false },
  { id: "white-danger", label: "White text on danger fill", fg: "white", bg: "wx-danger", isLargeOrUi: false, isBodyText: false },
  { id: "danger-tint", label: "Danger text on danger tint", fg: "wx-danger-text", bg: "wx-danger-tint", isLargeOrUi: false, isBodyText: false },
  { id: "chrome-text", label: "Text on always-dark chrome", fg: "wx-solid-dark-text", bg: "wx-solid-dark", isLargeOrUi: false, isBodyText: false },
];

export type CustomColors = Partial<Record<PaletteKey, string>>;
export interface CustomTheme {
  light: CustomColors;
  dark: CustomColors;
}

const STORAGE_KEY = "wx-custom-theme";

function isValidHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function isPaletteKey(value: string): value is PaletteKey {
  return (PALETTE_KEYS as readonly string[]).includes(value);
}

function sanitizeColors(value: unknown): CustomColors {
  if (typeof value !== "object" || value === null) return {};
  const result: CustomColors = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (isPaletteKey(key) && isValidHex(v)) result[key] = v;
  }
  return result;
}

function sanitizeTheme(value: unknown): CustomTheme {
  if (typeof value !== "object" || value === null) return { light: {}, dark: {} };
  const v = value as Record<string, unknown>;
  return { light: sanitizeColors(v["light"]), dark: sanitizeColors(v["dark"]) };
}

function cloneTheme(theme: CustomTheme): CustomTheme {
  return { light: { ...theme.light }, dark: { ...theme.dark } };
}

function canonicalSerialize(theme: CustomTheme): string {
  const parts: string[] = [];
  for (const variant of ["light", "dark"] as const) {
    for (const key of PALETTE_KEYS) {
      const value = theme[variant][key];
      if (value !== undefined) parts.push(`${variant}.${key}=${value}`);
    }
  }
  return parts.join("|");
}

function loadPersisted(win: Window): CustomTheme {
  try {
    const raw = win.localStorage.getItem(STORAGE_KEY);
    return raw === null ? { light: {}, dark: {} } : sanitizeTheme(JSON.parse(raw));
  } catch {
    return { light: {}, dark: {} };
  }
}

function savePersisted(win: Window, theme: CustomTheme): void {
  try {
    win.localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // best-effort persistence only
  }
}

function findRootRule(doc: Document, selectorText: string): CSSStyleRule | null {
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin stylesheet's rules aren't readable - skip it
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText === selectorText) return rule;
    }
  }
  return null;
}

/** Reads each palette color's SHIPPED default straight from the loaded
 * stylesheet's own `:root` / `:root[data-theme="dark"]` rules — not a
 * second hardcoded copy (decisions/00047: this module and slice 7's
 * uxer-style.json must both read the same source rather than re-deriving
 * it) and immune to whatever custom override is already applied inline,
 * unlike `getComputedStyle`. */
export function readDefaultColors(doc: Document = document): CustomTheme {
  const lightRule = findRootRule(doc, ":root");
  const darkRule = findRootRule(doc, ':root[data-theme="dark"]');
  const light: CustomColors = {};
  const dark: CustomColors = {};
  for (const key of PALETTE_KEYS) {
    const varName = `--${key}`;
    const lv = lightRule?.style.getPropertyValue(varName).trim();
    if (lv !== undefined && lv !== "") light[key] = lv;
    const dv = darkRule?.style.getPropertyValue(varName).trim();
    if (dv !== undefined && dv !== "") dark[key] = dv;
  }
  return { light, dark };
}

function applyOverrides(colors: Record<PaletteKey, string>, doc: Document): void {
  for (const key of PALETTE_KEYS) {
    doc.documentElement.style.setProperty(`--${key}`, colors[key]);
  }
}

export interface ThemeEditorController {
  getDefaults(): CustomTheme;
  /** The in-progress, possibly-unsaved edit set for one variant. */
  getDraft(variant: ThemeVariant): CustomColors;
  /** draft-value-or-shipped-default for every key — always fully populated,
   * this is what live preview and the contrast readouts render from. */
  getEffective(variant: ThemeVariant): Record<PaletteKey, string>;
  isDirty(): boolean;
  setColor(variant: ThemeVariant, key: PaletteKey, hex: string): void;
  resetVariant(variant: ThemeVariant): void;
  save(): void;
  discardDraft(): void;
  exportJson(): string;
  importJson(json: string): { ok: true } | { ok: false; message: string };
  subscribe(listener: () => void): () => void;
  teardown(): void;
}

export function initThemeEditor(
  themeController: Pick<ThemeController, "getMode" | "subscribe">,
  win: Window = window,
  doc: Document = document,
): ThemeEditorController {
  const defaults = readDefaultColors(doc);
  const persisted = loadPersisted(win);
  const draft = cloneTheme(persisted);
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((l) => l());

  function effectiveFor(variant: ThemeVariant): Record<PaletteKey, string> {
    const result = {} as Record<PaletteKey, string>;
    for (const key of PALETTE_KEYS) {
      result[key] = draft[variant][key] ?? defaults[variant][key] ?? "#000000";
    }
    return result;
  }

  let currentVariant: ThemeVariant = resolveVariant(themeController.getMode(), win);

  function reapply(): void {
    applyOverrides(effectiveFor(currentVariant), doc);
  }
  reapply(); // apply any already-persisted custom theme immediately on construction

  const unsubscribeTheme = themeController.subscribe((_mode, variant) => {
    currentVariant = variant;
    reapply();
  });

  return {
    getDefaults: () => cloneTheme(defaults),
    getDraft: (variant) => ({ ...draft[variant] }),
    getEffective: (variant) => effectiveFor(variant),
    isDirty: () => canonicalSerialize(draft) !== canonicalSerialize(persisted),

    setColor: (variant, key, hex) => {
      draft[variant] = { ...draft[variant], [key]: hex };
      if (variant === currentVariant) reapply();
      notify();
    },

    resetVariant: (variant) => {
      draft[variant] = {};
      persisted[variant] = {};
      savePersisted(win, persisted);
      if (variant === currentVariant) reapply();
      notify();
    },

    save: () => {
      persisted.light = { ...draft.light };
      persisted.dark = { ...draft.dark };
      savePersisted(win, persisted);
      notify();
    },

    discardDraft: () => {
      draft.light = { ...persisted.light };
      draft.dark = { ...persisted.dark };
      reapply();
      notify();
    },

    exportJson: () => JSON.stringify(draft, null, 2),

    importJson: (json) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return { ok: false, message: "That's not valid JSON." };
      }
      const sanitized = sanitizeTheme(parsed);
      if (Object.keys(sanitized.light).length === 0 && Object.keys(sanitized.dark).length === 0) {
        return { ok: false, message: "No recognized colors found in that snippet." };
      }
      draft.light = { ...draft.light, ...sanitized.light };
      draft.dark = { ...draft.dark, ...sanitized.dark };
      reapply();
      notify();
      return { ok: true };
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // Deliberately leaves any applied overrides in place — teardown means
    // "the shell is going away", not "revert the user's saved theme."
    teardown: () => unsubscribeTheme(),
  };
}
