// Guard for a trap jsdom cannot see (it never lays anything out, so `el.hidden`
// reading `true` there proves nothing about what is actually on screen): the
// UA stylesheet's `[hidden] { display: none }` and a class selector's own
// `display` have EQUAL specificity, so the class's rule silently wins and the
// "hidden" element stays visible. Found live in the e2e run: the thread view
// (header, thread, composer) stayed visible under the first-unlock name prompt
// because `.wx-srv-thread-view { display: flex }` had no `[hidden]` override.
//
// Every element the Server chat view shows/hides through the `hidden`
// attribute, and whose base rule sets `display`, needs an explicit
// `.<class>[hidden] { display: none }` rule.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server");
const chatCss = readFileSync(join(SRC_DIR, "chat.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every class the chat view toggles with `.hidden = …` (chatView.ts, thread.ts,
 * settingsSheet.ts). Keep in step with those files: add a class here when a new
 * element starts being shown/hidden that way. */
const HIDDEN_TOGGLED_CLASSES = [
  "wx-srv-thread-view",
  "wx-srv-name-prompt",
  "wx-srv-history-error",
  "wx-srv-jump-pill",
  "wx-srv-sheet-backdrop",
  "wx-srv-reactions",
  "wx-srv-reply-bar",
  "wx-srv-view-once-controls",
] as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The declaration block of the rule whose selector is exactly `.<cls>`. */
function baseRuleBody(css: string, cls: string): string | null {
  const match = new RegExp(`(?:^|})\\s*\\.${escapeRegExp(cls)}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? null;
}

describe("server/chat.css: hidden elements must actually hide", () => {
  for (const cls of HIDDEN_TOGGLED_CLASSES) {
    it(`.${cls} has a [hidden] override wherever its base rule sets display`, () => {
      const base = baseRuleBody(chatCss, cls);
      expect(base, `no base rule found for .${cls}`).not.toBeNull();
      if (base !== null && /\bdisplay\s*:/.test(base)) {
        expect(chatCss).toMatch(new RegExp(`\\.${escapeRegExp(cls)}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`));
      }
    });
  }
});

describe("server/chat.css: the 'Extend auto-lock to 1 minute' row", () => {
  it("is a flex row at least 44px tall (a comfortable phone tap target)", () => {
    const row = baseRuleBody(chatCss, "wx-srv-sheet-idle");
    expect(row, "no base rule for .wx-srv-sheet-idle").not.toBeNull();
    expect(row).toMatch(/display\s*:\s*flex/);
    const minHeight = /min-height\s*:\s*(\d+)px/.exec(row ?? "");
    expect(Number(minHeight?.[1] ?? 0)).toBeGreaterThanOrEqual(44);
  });

  it("keeps the checkbox fixed-size and lets the label text wrap instead of truncating", () => {
    const input = baseRuleBody(chatCss, "wx-srv-sheet-idle-input");
    expect(input).toMatch(/flex\s*:\s*none/);
    const text = baseRuleBody(chatCss, "wx-srv-sheet-idle-text");
    expect(text).toMatch(/min-width\s*:\s*0/);
    expect(text).not.toMatch(/text-overflow|white-space\s*:\s*nowrap/);
  });
});

// The settings sheet is anchored to the bottom of its host. On a short Android
// phone (where the push row makes it tallest) a content-height sheet used to grow
// UPWARD past the host's top edge, taking its close X underneath the admin's own
// navigation. These guard the rules that keep it inside the host (the real-browser
// proof is the "android settings sheet" hit-tests in e2e/tests/server-lock.spec.ts).
describe("server/chat.css: the settings sheet never outgrows its host", () => {
  it("is capped to the host minus what its box adds on top, and scrolls its own contents", () => {
    const sheet = baseRuleBody(chatCss, "wx-srv-sheet");
    expect(sheet, "no base rule for .wx-srv-sheet").not.toBeNull();
    expect(sheet).toMatch(/overflow-y\s*:\s*auto/);
    // The box is content-box, so max-height caps the CONTENT: a bare 100% still
    // overshoots the host by the bottom padding + safe-area inset + borders.
    const maxHeight = /max-height\s*:\s*(calc\([^;]*\))\s*;/.exec(sheet ?? "")?.[1] ?? "";
    expect(maxHeight, "max-height must be calc(100% - <what the box adds>)").toMatch(/^calc\(\s*100%\s*-/);
    expect(maxHeight).toContain("env(safe-area-inset-bottom");
    // The cap and the padding/border are built from the SAME variables, so they cannot drift apart.
    const padding = /(?:^|[\s;])padding\s*:\s*([^;]*);/.exec(sheet ?? "")?.[1] ?? "";
    const border = /(?:^|[\s;])border\s*:\s*([^;]*);/.exec(sheet ?? "")?.[1] ?? "";
    expect(maxHeight).toContain("--wx-srv-sheet-pad");
    expect(padding).toContain("--wx-srv-sheet-pad");
    expect(maxHeight).toContain("--wx-srv-sheet-border");
    expect(border).toContain("--wx-srv-sheet-border");
  });

  it("stays content-box: the calc() cap above is only right for that sizing model (and widths are unchanged)", () => {
    const sheet = baseRuleBody(chatCss, "wx-srv-sheet");
    expect(sheet).not.toMatch(/box-sizing/);
  });

  it("pins the header (with the close X) to the top of the sheet's own scroll", () => {
    const header = baseRuleBody(chatCss, "wx-srv-sheet-header");
    expect(header, "no base rule for .wx-srv-sheet-header").not.toBeNull();
    expect(header).toMatch(/position\s*:\s*sticky/);
    expect(header).toMatch(/top\s*:\s*0/);
    // Opaque, or scrolled contents would show through behind the title and X.
    expect(header).toMatch(/background\s*:/);
  });
});

describe("server/chat.css: message text keeps its line breaks", () => {
  // Real rendering is pinned by e2e/tests/server-message-text.spec.ts (innerText + geometry);
  // this is the fast guard on the one declaration that makes it work: the text is plain text
  // nodes, so without `pre-wrap` every typed line break collapses to a space.
  it(".wx-srv-bubble-text preserves typed newlines with white-space: pre-wrap", () => {
    const rule = baseRuleBody(chatCss, "wx-srv-bubble-text");
    expect(rule, "no base rule for .wx-srv-bubble-text").not.toBeNull();
    expect(rule).toMatch(/white-space\s*:\s*pre-wrap/);
  });
});

describe("server/chat.css: view-once controls", () => {
  it(".wx-srv-view-once-controls sits in normal flex flow below canvas, not position: absolute", () => {
    const controls = baseRuleBody(chatCss, "wx-srv-view-once-controls");
    expect(controls, "no base rule for .wx-srv-view-once-controls").not.toBeNull();
    expect(controls).not.toMatch(/position\s*:\s*absolute/);
  });
});
