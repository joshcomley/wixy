// A deliberate TS port of `builder/theme.py`'s `generate_theme_css` (spec/02 §4) —
// same rationale as `googleFonts.ts`: the theme panel needs the CSS custom-property
// values LIVE, client-side, with no network round trip, so the per-declaration logic
// is hand-mirrored here. Returns a `--name -> value` map (the `themeVars` postMessage
// shape, spec/05 §2) rather than a full stylesheet string, since a map is what
// `editor/src/overlay.ts`'s `applyThemeVars` consumes via `style.setProperty`.

import type { ThemeData } from "./api";

const GENERIC_FONT_FALLBACK: Record<string, string> = {
  serif: "serif",
  sans: "system-ui,sans-serif",
  script: "cursive",
};

export function themeVarsFromTheme(theme: ThemeData): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    vars[`--${key}`] = value;
  }
  vars["--shadow"] = theme.shadow;
  for (const [role, spec] of Object.entries(theme.fonts)) {
    const fallback = GENERIC_FONT_FALLBACK[role] ?? "";
    vars[`--font-${role}`] = fallback ? `'${spec.family}',${fallback}` : `'${spec.family}'`;
  }
  return vars;
}
