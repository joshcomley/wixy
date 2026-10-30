import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// spec 09 §6: the rebuilt, COMMITTED admin CSS bundle carries the Cookout selectors from chat.css (a
// source change that was never rebuilt would ship an unstyled game), and every Cookout element shown and
// hidden with the `hidden` attribute is really hidden (a class's own `display` beats the UA's
// `[hidden]` rule at equal specificity — serverChatCss.test.ts explains the trap).

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "..", "src", "server", "chat.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
const BUNDLE = readFileSync(join(HERE, "..", "..", "..", "wixy_server", "static", "admin", "admin.css"), "utf-8");

/** A representative selector of every Cookout surface. */
const SELECTORS = [
  ".wx-srv-ck",
  ".wx-srv-ck-bar",
  ".wx-srv-ck-prog-slot",
  ".wx-srv-ck-card",
  ".wx-srv-ck-table",
  ".wx-srv-ck-skip",
  ".wx-srv-ck-cloche",
  ".wx-srv-ck-sheet",
  ".wx-srv-ck-intro",
  ".wx-srv-ck-car",
  ".wx-srv-ck-pic",
  ".wx-srv-ck-reveal",
  ".wx-srv-ck-flip",
  ".wx-srv-ck-dish",
  ".wx-srv-ck-bank",
  ".wx-srv-ck-recipe",
  ".wx-srv-ck-start",
  ".wx-srv-ck-mcard",
  ".wx-srv-ck-book-view",
];

describe("the Cookout styles", () => {
  it("are in chat.css and in the rebuilt committed bundle", () => {
    for (const selector of SELECTORS) {
      const re = new RegExp(`${selector.replace(/[.]/g, "\\.")}[\\s{,:.\\[]`);
      expect(re.test(SOURCE), `${selector} in chat.css`).toBe(true);
      expect(re.test(BUNDLE), `${selector} in admin.css`).toBe(true);
    }
  });

  it("hide whatever the hidden attribute hides, inside the pane, the book and the start sheet", () => {
    for (const rule of [".wx-srv-ck [hidden]", ".wx-srv-ck-book-view [hidden]", ".wx-srv-ck-start [hidden]", ".wx-srv-ck-mcard [hidden]"]) {
      expect(SOURCE).toContain(rule);
    }
    expect(SOURCE).toMatch(/\.wx-srv-ck-start\[hidden\][\s\S]*?display: none !important/);
    expect(SOURCE).toMatch(/\.wx-srv-ck-book-view\[hidden\][\s\S]*?display: none !important/);
  });

  it("follow the dark theme both ways the shell sets it", () => {
    expect(SOURCE).toContain(':root[data-theme="dark"] .wx-srv-ck');
    expect(SOURCE).toContain(':root:not([data-theme="light"]):not([data-theme="dark"]) .wx-srv-ck');
  });
});


describe("the game-mode styles (layout guards)", () => {
  /** The declarations of the rule whose selector list is exactly `selector`. */
  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(SOURCE);
    if (found === null) throw new Error(`no rule ${selector}`);
    return found[1] ?? "";
  }

  it("a mode card's head wraps, and its title never does", () => {
    expect(rule(".wx-srv-ck-mcard-head-mode")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".wx-srv-ck-mcard-head-mode .wx-srv-ck-mcard-title")).toMatch(/white-space:\s*nowrap/);
  });

  it("the reveal grid's columns are at least 68px and never more than one player's picks", () => {
    const grid = rule(".wx-srv-ck-reveal-grid");
    expect(grid).toContain("minmax(max(68px, calc((100% - (var(--ck-reveal-cols) - 1) * 3px) / var(--ck-reveal-cols))), 1fr)");
    expect(grid).toContain("--ck-reveal-cols: 5;");
  });

  it("a reveal tile's name wraps at word breaks only, never mid-word", () => {
    const name = rule(".wx-srv-ck-rtile-name");
    expect(name).not.toContain("overflow-wrap: anywhere");
    expect(name).not.toContain("word-break: break-all");
  });
});
