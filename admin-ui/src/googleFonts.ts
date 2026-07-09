// A deliberate TS port of `builder/theme.py`'s `generate_fonts_url`/`_font_css2_param`
// (spec/02-content-model.md §4) — the theme panel (spec/05 §3) needs to compute the
// Google Fonts `<link>` URL LIVE, on every in-progress edit (family/weights/italics),
// with zero network round-trip (spec/05 §7: "never blocks on the network for
// keystrokes"), so it cannot simply call the server per keystroke. A hand-duplicated
// pure function is the same tradeoff decisions/00015 decision 2 already made for
// `protocol.ts` (no shared package can bridge Python <-> TS here either) — keep this in
// sync with `builder/theme.py` by hand if that logic ever changes; both cite the same
// spec section as ground truth. `builder/tests/test_theme.py`'s cases are mirrored
// exactly in `googleFonts.test.ts` so the two implementations stay provably identical.

export interface FontSpec {
  family: string;
  weights: string[];
  italics: boolean;
}

function weightSortKey(weight: string): number {
  return /^\d+$/.test(weight) ? Number.parseInt(weight, 10) : 0;
}

/** Dedupe preserving first-occurrence order (mirrors Python's `dict.fromkeys`), then
 * a STABLE sort by numeric weight (`Array.prototype.sort` is spec-guaranteed stable
 * since ES2019) — ties (non-numeric weights, all sorting to key 0) keep their
 * dedup order, matching `sorted()`'s stability in the Python original. */
function dedupedSortedWeights(weights: string[]): string[] {
  const seen = new Set<string>();
  const deduped = weights.filter((weight) => {
    if (seen.has(weight)) return false;
    seen.add(weight);
    return true;
  });
  return deduped.sort((a, b) => weightSortKey(a) - weightSortKey(b));
}

function fontCss2Param(spec: FontSpec): string {
  const name = spec.family.replace(/ /g, "+");
  const weights = dedupedSortedWeights(spec.weights);
  if (weights.length === 0) return `family=${name}`;
  const axis = spec.italics
    ? `ital,wght@${[...weights.map((w) => `0,${w}`), ...weights.map((w) => `1,${w}`)].join(";")}`
    : `wght@${weights.join(";")}`;
  return `family=${name}:${axis}`;
}

/** A single combined Google Fonts `css2?family=…` URL for the given font roles —
 * byte-identical to `builder.theme.generate_fonts_url`'s output for the same input,
 * so the theme panel's live preview never disagrees with what a real build emits. */
export function buildFontsUrl(fonts: Record<string, FontSpec>): string {
  const params = Object.values(fonts).map(fontCss2Param);
  return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`;
}
