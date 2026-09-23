// Guard for the class of bug behind the 2026-07-21 "6 changes" drawer layout
// incident: a rule whose selector line was deleted during an edit left
// orphaned declarations (`border: none; display: block; }`) at stylesheet top
// level. CSS error recovery then swallowed the NEXT rule (`.wx-drawer {...}`)
// entirely — the drawer lost position:fixed/background/z-index and rendered as
// a transparent in-flow block over the whole shell. Browsers accept the file
// silently, so nothing but a structural check like this can catch it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const styleCss = readFileSync(join(SRC_DIR, "style.css"), "utf-8");

/** Strips comments and string literals (position-preserving: every removed
 * character becomes a space except newlines, which stay) so brace/semicolon
 * counting below only ever sees structural characters at true line numbers. */
function stripCommentsAndStrings(css: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  return css
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, blank);
}

/** Every top-level statement must be a rule (selector prelude ending in `{`)
 * or an at-rule statement (`@import …;`). Anything else at top level — an
 * orphaned declaration (`color: red;` outside any block) or an unmatched `}`
 * (the tail of a mangled rule, the exact incident shape) — is returned as a
 * 1-based line number. */
function orphanedTopLevelStatements(css: string): number[] {
  const stripped = stripCommentsAndStrings(css);
  const offenders: number[] = [];
  let depth = 0;
  let buffer = "";
  let bufferLine = 1;
  let line = 1;
  for (const ch of stripped) {
    if (ch === "\n") line += 1;
    if (depth > 0) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      continue;
    }
    if (ch === "{") {
      depth += 1; // the buffer was a selector prelude — a well-formed rule
      buffer = "";
    } else if (ch === "}") {
      offenders.push(buffer.trim() !== "" ? bufferLine : line); // unmatched close
      buffer = "";
    } else if (ch === ";") {
      if (buffer.trim() !== "" && !buffer.trimStart().startsWith("@")) {
        offenders.push(bufferLine);
      }
      buffer = "";
    } else {
      if (buffer.trim() === "" && !/\s/.test(ch)) bufferLine = line;
      buffer += ch;
    }
  }
  if (depth !== 0) offenders.push(line); // unbalanced braces overall
  return offenders;
}

describe("style.css structural sanity", () => {
  it("has no orphaned top-level declarations or unmatched braces", () => {
    expect(orphanedTopLevelStatements(styleCss)).toEqual([]);
  });

  it("still defines the publish drawer's overlay positioning", () => {
    // The concrete rule the incident swallowed — cheap canary that a future
    // mangling can't silently drop it again.
    expect(styleCss).toMatch(/\.wx-drawer\s*\{[^}]*position:\s*fixed/s);
  });
});

describe("server/lock.css: a hidden overlay must actually stop intercepting clicks", () => {
  // Found live via e2e (not vitest — jsdom never lays anything out, so
  // `el.hidden` reading `true` there proves nothing about real click
  // interception): `[hidden]`'s UA-stylesheet `display:none` and a class
  // selector's own `display` have EQUAL specificity, so the class's rule —
  // being later in the cascade — silently wins regardless of the attribute.
  // `.wx-srv-chat-host`/`.wx-srv-pinpad-host` cover the decoy via
  // `position:absolute`, so this exact trap made a real Playwright click on
  // the decoy land on the "hidden" chat overlay instead. Guard: any rule
  // targeting these classes without a `:not([hidden])` qualifier must never
  // set `display`.
  it("never sets display on .wx-srv-chat-host/.wx-srv-pinpad-host outside a :not([hidden]) guard", () => {
    const lockCss = readFileSync(join(SRC_DIR, "server", "lock.css"), "utf-8");
    for (const block of lockCss.split("}")) {
      const braceIndex = block.indexOf("{");
      if (braceIndex === -1) continue;
      const selector = block.slice(0, braceIndex);
      const body = block.slice(braceIndex + 1);
      const targetsHost = /\.wx-srv-(chat|pinpad)-host\b/.test(selector);
      const isGuarded = selector.includes(":not([hidden])");
      if (targetsHost && !isGuarded) {
        expect(body).not.toMatch(/display\s*:/);
      }
    }
  });
});
