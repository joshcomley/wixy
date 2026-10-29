import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The chat header's buttons are proper 44 px targets on every screen, desktop included (spec/server-chat/09b
// F.3: Answer, Decline, Mute and End are tapped in a hurry, often over a game), and the header row has ONE
// height: the call controls, ⋯, the pen and its undo/redo, the cog and the panic ✕ all take
// `--wx-srv-header-control-h` (44 px, never redefined for a wider screen). The start-a-call dialog's and the
// failure notice's buttons are 44 tall. Read from chat.css and from the rebuilt committed bundle, so a source
// change that was never rebuilt fails here too.

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "..", "src", "server", "chat.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
const BUNDLE = readFileSync(join(HERE, "..", "..", "..", "wixy_server", "static", "admin", "admin.css"), "utf-8");

/** Every declaration block whose selector list is exactly `selector`, in source order. */
function blocks(css: string, selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    // Selector lists compare with their whitespace collapsed (a list may span lines in chat.css).
    if ((m[1] ?? "").replace(/\s+/g, " ").trim() === selector) out.push(m[2] ?? "");
  }
  return out;
}

/** The last value `property` gets across `selector`'s blocks (the one that wins at equal specificity). */
function value(css: string, selector: string, property: string): string | null {
  let found: string | null = null;
  for (const block of blocks(css, selector)) {
    for (const decl of block.split(";")) {
      const [name, ...rest] = decl.split(":");
      if ((name ?? "").trim() === property) found = rest.join(":").trim();
    }
  }
  return found;
}

/** The header height token as chat.css (or the bundle) defines it: one definition, on the thread view. */
function token(css: string): number {
  const defs = [...css.matchAll(/--wx-srv-header-control-h:\s*([0-9.]+)px/g)].map((m) => Number.parseFloat(m[1] ?? ""));
  expect(defs, "the header height is defined once (no wider-screen override)").toHaveLength(1);
  return defs[0] ?? Number.NaN;
}

/** A length in px: a plain one, or `var(--wx-srv-header-control-h, …)` resolved to the token. */
function px(css: string, text: string | null): number {
  if (text === null) return Number.NaN;
  if (/^var\(--wx-srv-header-control-h/.test(text)) return token(css);
  return Number.parseFloat(text);
}

const HEADER_BUTTONS: ReadonlyArray<readonly [string, "width" | "min-width"]> = [
  [".wx-srv-call button", "width"],
  [".wx-srv-more-button", "min-width"],
  [".wx-srv-pen-button", "width"],
  [".wx-srv-settings-button, .wx-srv-panic-button, .wx-srv-pen-undo, .wx-srv-pen-redo", "width"],
];

describe("the chat header's targets", () => {
  it("the header height token is 44 px", () => {
    expect(token(SOURCE)).toBe(44);
  });

  it("every header-row button is at least 44 x 44, all on the one header height", () => {
    for (const [selector, widthProp] of HEADER_BUTTONS) {
      const height = value(SOURCE, selector, "height");
      expect(height, `${selector} height`).toMatch(/^var\(--wx-srv-header-control-h/);
      expect(px(SOURCE, height), `${selector} height`).toBeGreaterThanOrEqual(44);
      expect(px(SOURCE, value(SOURCE, selector, widthProp)), `${selector} ${widthProp}`).toBeGreaterThanOrEqual(44);
    }
  });

  it("no header button keeps the old negative-margin trick (a target that overlaps its neighbour)", () => {
    expect(value(SOURCE, ".wx-srv-pen-button", "margin")).toBeNull();
  });

  it("keep 44 px height in the dialog and the notice (no rule there sets a smaller one)", () => {
    for (const selector of [
      ".wx-srv-call .wx-srv-call-dialog button",
      ".wx-srv-call .wx-srv-call-dialog .wx-srv-call-confirm",
      ".wx-srv-call .wx-srv-call-notice button",
    ]) {
      const height = value(SOURCE, selector, "height");
      const min = value(SOURCE, selector, "min-height");
      expect(height === null || px(SOURCE, height) >= 44, `${selector} height`).toBe(true);
      expect(min === null || px(SOURCE, min) >= 44, `${selector} min-height`).toBe(true);
    }
  });

  it("are in the rebuilt committed bundle", () => {
    expect(token(BUNDLE)).toBe(44);
    expect(px(BUNDLE, value(BUNDLE, ".wx-srv-call button", "height"))).toBeGreaterThanOrEqual(44);
    expect(px(BUNDLE, value(BUNDLE, ".wx-srv-call button", "width"))).toBeGreaterThanOrEqual(44);
    expect(px(BUNDLE, value(BUNDLE, ".wx-srv-more-button", "height"))).toBeGreaterThanOrEqual(44);
  });
});
