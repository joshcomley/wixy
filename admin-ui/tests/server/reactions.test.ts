// The browser's copy of the reaction allowlist (spec/server-chat/04-reactions.md). That it
// matches the server's list code point for code point is asserted from the other side, by
// `wixy_server/tests/test_livechat_reactions.py`, which parses this module's source.

import { describe, expect, it } from "vitest";
import { REACTION_EMOJIS, isReactionEmoji, reactionLabel, reactionOrder } from "../../src/server/reactions";

describe("reaction allowlist", () => {
  it("is the six quick reactions, each an exact code-point sequence", () => {
    expect(REACTION_EMOJIS.map((emoji) => [...emoji].map((c) => c.codePointAt(0)!.toString(16)))).toEqual([
      ["1f44d"],
      ["2764", "fe0f"],
      ["1f602"],
      ["1f62e"],
      ["1f622"],
      ["1f64f"],
    ]);
  });

  it("accepts each entry and nothing else, with no normalisation", () => {
    for (const emoji of REACTION_EMOJIS) expect(isReactionEmoji(emoji)).toBe(true);
    for (const other of ["", "❤", "\u{1F44D}️", "\u{1F44E}", "thumbs_up", " \u{1F44D}"]) {
      expect(isReactionEmoji(other)).toBe(false);
    }
  });

  it("gives every emoji a spoken label, and falls back to the glyph for an unknown one", () => {
    for (const emoji of REACTION_EMOJIS) expect(reactionLabel(emoji)).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    expect(reactionLabel("\u{1F44E}")).toBe("\u{1F44E}");
  });

  it("orders by list position, unknown last", () => {
    expect(REACTION_EMOJIS.map(reactionOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(reactionOrder("\u{1F44E}")).toBe(REACTION_EMOJIS.length);
  });
});
