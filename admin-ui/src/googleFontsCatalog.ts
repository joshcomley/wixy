// A curated Google Fonts pick-list for the theme panel's family dropdowns (spec/05
// §3: "a curated ~24-Google-Fonts-family dropdown + custom-family text input"). Not
// fetched from Google's font-metadata API at runtime (no CDN/live-API calls from the
// admin UI, matching this repo's self-hosted-assets rule) — a small hand-picked list
// is enough for a v1 quick-pick; anything outside it is reachable via the custom
// input either dropdown offers. Each of the site's current three fonts (Cormorant
// Garamond, Jost, Pinyon Script) heads its own category so the existing choice is
// always visible as a preset, not just reachable by typing it back in.
//
// `WEIGHT_OPTIONS` is one fixed set offered for every family/role alike, rather than a
// per-family weight-availability table — Google Fonts' css2 API tolerates a requested
// weight a family doesn't actually publish (it serves the nearest match rather than
// erroring), so this is a deliberate simplification, not a correctness gap.

export type FontCategory = "serif" | "sans-serif" | "script";

export interface CatalogFont {
  family: string;
  category: FontCategory;
}

export const WEIGHT_OPTIONS: readonly string[] = ["300", "400", "500", "600", "700"];

export const GOOGLE_FONTS_CATALOG: readonly CatalogFont[] = [
  // Serif
  { family: "Cormorant Garamond", category: "serif" },
  { family: "Playfair Display", category: "serif" },
  { family: "Lora", category: "serif" },
  { family: "Libre Baskerville", category: "serif" },
  { family: "EB Garamond", category: "serif" },
  { family: "Crimson Text", category: "serif" },
  { family: "Marcellus", category: "serif" },
  { family: "Cardo", category: "serif" },
  // Sans-serif
  { family: "Jost", category: "sans-serif" },
  { family: "Inter", category: "sans-serif" },
  { family: "Poppins", category: "sans-serif" },
  { family: "Nunito Sans", category: "sans-serif" },
  { family: "Work Sans", category: "sans-serif" },
  { family: "Karla", category: "sans-serif" },
  { family: "Josefin Sans", category: "sans-serif" },
  { family: "Quicksand", category: "sans-serif" },
  // Script / handwritten
  { family: "Pinyon Script", category: "script" },
  { family: "Great Vibes", category: "script" },
  { family: "Parisienne", category: "script" },
  { family: "Sacramento", category: "script" },
  { family: "Alex Brush", category: "script" },
  { family: "Dancing Script", category: "script" },
  { family: "Allura", category: "script" },
  { family: "Cookie", category: "script" },
];
