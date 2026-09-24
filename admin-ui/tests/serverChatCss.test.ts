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
