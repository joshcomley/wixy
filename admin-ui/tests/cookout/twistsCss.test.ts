import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// spec/server-chat/09a-cookout-twists.md §8: the rebuilt, COMMITTED admin CSS bundle carries the twists'
// selectors from chat.css (a source change that was never rebuilt would ship an unstyled twist), and the
// new elements that are shown and hidden with the `hidden` attribute are really hidden.

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "..", "src", "server", "chat.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
const BUNDLE = readFileSync(join(HERE, "..", "..", "..", "wixy_server", "static", "admin", "admin.css"), "utf-8");

/** A representative selector of every twist surface. */
const SELECTORS = [
  ".wx-srv-ck-twists-toggle",
  ".wx-srv-ck-lucky",
  ".wx-srv-ck-chaos",
  ".wx-srv-ck-sweep",
  ".wx-srv-ck-star",
  ".wx-srv-ck-gate",
  ".wx-srv-ck-fx",
  ".wx-srv-ck-swap",
  ".wx-srv-ck-vote",
  ".wx-srv-ck-earlier",
  ".wx-srv-ck-cooked",
  ".wx-srv-ck-photos",
  ".wx-srv-ck-book-filter",
  ".wx-srv-ck-fridge-input",
  ".wx-srv-ck-encore",
];

function has(css: string, selector: string): boolean {
  return new RegExp(`${selector.replace(/[.]/g, "\\.")}[\\s{,:.\\[>+~)-]`).test(css);
}

describe("the twists' styles", () => {
  it("are in chat.css and in the rebuilt committed bundle", () => {
    for (const selector of SELECTORS) {
      expect(has(SOURCE, selector), `${selector} in chat.css`).toBe(true);
      expect(has(BUNDLE, selector), `${selector} in admin.css`).toBe(true);
    }
  });

  it("the bundle's twist rules are the ones chat.css declares (a stale bundle fails here)", () => {
    // Every wx-srv-ck-* class chat.css styles is also styled in the bundle.
    const classes = new Set([...SOURCE.matchAll(/\.(wx-srv-ck-[a-z0-9-]+)/g)].map((m) => m[1] as string));
    const missing = [...classes].filter((name) => !BUNDLE.includes(`.${name}`));
    expect(missing).toEqual([]);
  });

  it("hide whatever the hidden attribute hides in the new overlays", () => {
    // The photo chooser and the effects layer are shown and hidden with `hidden`; a class's own display
    // would otherwise beat the user-agent [hidden] rule at equal specificity.
    expect(SOURCE).toContain(".wx-srv-ck [hidden]");
    expect(SOURCE).toMatch(/\.wx-srv-ck-start \[hidden\]/);
    expect(BUNDLE).toMatch(/\.wx-srv-ck \[hidden\]/);
  });

  it("reduced motion switches the twists' animations off", () => {
    expect(SOURCE).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(BUNDLE).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it("follow the dark theme both ways the shell sets it", () => {
    expect(SOURCE).toContain(':root[data-theme="dark"] .wx-srv-ck');
    expect(SOURCE).toContain(':root:not([data-theme="light"]):not([data-theme="dark"]) .wx-srv-ck');
    // The bundle is minified (quotes inside attribute selectors may be dropped).
    expect(BUNDLE).toMatch(/:root\[data-theme="?dark"?\] \.wx-srv-ck/);
    expect(BUNDLE).toMatch(/:root:not\(\[data-theme="?light"?\]\):not\(\[data-theme="?dark"?\]\) \.wx-srv-ck/);
  });
});
