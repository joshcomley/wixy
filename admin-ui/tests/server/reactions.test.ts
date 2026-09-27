// The browser's copy of the reaction allowlist (spec/server-chat/04-reactions.md). That it
// matches the server's list code point for code point is asserted from the other side, by
// `wixy_server/tests/test_livechat_reactions.py`, which parses this module's source.

import { beforeEach, describe, expect, it } from "vitest";
import {
  REACTION_EMOJIS,
  isReactionEmoji,
  reactionLabel,
  reactionOrder,
  hasVariants,
  getVariants,
  getDefaultHeartEmoji,
  setDefaultHeartEmoji,
  getRecentReactions,
  addRecentReaction,
  isMainListReaction,
  DEFAULT_HEART_STORAGE_KEY,
  RECENT_REACTIONS_STORAGE_KEY,
} from "../../src/server/reactions";

describe("reaction allowlist", () => {
  it("is the eight static reactions including Care and Celebrate, each an exact code-point sequence", () => {
    expect(REACTION_EMOJIS.map((emoji) => [...emoji].map((c) => c.codePointAt(0)!.toString(16)))).toEqual([
      ["1f44d"],
      ["2764", "fe0f"],
      ["1f602"],
      ["1f62e"],
      ["1f622"],
      ["1f64f"],
      ["1f970"],
      ["1f389"],
    ]);
  });

  it("accepts each static entry and rejects non-allowlist entries for isReactionEmoji", () => {
    for (const emoji of REACTION_EMOJIS) expect(isReactionEmoji(emoji)).toBe(true);
    for (const other of ["", "❤", "\u{1F44D}️", "\u{1F44E}", "thumbs_up", " \u{1F44D}"]) {
      expect(isReactionEmoji(other)).toBe(false);
    }
  });

  it("gives every static emoji a spoken label, including Care and Celebrate", () => {
    for (const emoji of REACTION_EMOJIS) expect(reactionLabel(emoji)).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    expect(reactionLabel("🥰")).toBe("Care");
    expect(reactionLabel("🎉")).toBe("Celebrate");
    expect(reactionLabel("💙")).toBe("Blue heart");
    expect(reactionLabel("👍🏽")).toBe("Thumbs up (medium skin tone)");
    expect(reactionLabel("\u{1F44E}")).toBe("\u{1F44E}");
  });

  it("orders by list position, unknown last", () => {
    expect(REACTION_EMOJIS.map(reactionOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(reactionOrder("\u{1F44E}")).toBe(REACTION_EMOJIS.length);
  });
});

describe("reaction variants", () => {
  it("detects variantable emojis correctly", () => {
    expect(hasVariants("👍")).toBe(true);
    expect(hasVariants("👍🏽")).toBe(true);
    expect(hasVariants("❤️")).toBe(true);
    expect(hasVariants("💙")).toBe(true);
    expect(hasVariants("🙏")).toBe(true);
    expect(hasVariants("🙏🏻")).toBe(true);
    expect(hasVariants("😂")).toBe(false);
    expect(hasVariants("😮")).toBe(false);
    expect(hasVariants("😢")).toBe(false);
    expect(hasVariants("🥰")).toBe(false);
    expect(hasVariants("🎉")).toBe(false);
  });

  it("returns appropriate variants for thumbs up, hearts, and folded hands", () => {
    expect(getVariants("👍")).toHaveLength(6);
    expect(getVariants("❤️")).toHaveLength(13);
    expect(getVariants("💙")).toHaveLength(13);
    expect(getVariants("🙏")).toHaveLength(6);
    expect(getVariants("😂")).toHaveLength(0);
  });
});

describe("default heart color persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to red heart when no preference is saved", () => {
    expect(getDefaultHeartEmoji()).toBe("❤️");
  });

  it("persists chosen heart color and retrieves it", () => {
    setDefaultHeartEmoji("💙");
    expect(localStorage.getItem(DEFAULT_HEART_STORAGE_KEY)).toBe("💙");
    expect(getDefaultHeartEmoji()).toBe("💙");
  });

  it("ignores invalid saved values and falls back to red heart", () => {
    localStorage.setItem(DEFAULT_HEART_STORAGE_KEY, "invalid");
    expect(getDefaultHeartEmoji()).toBe("❤️");
  });
});

describe("recent reactions", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("retrieves empty array by default", () => {
    expect(getRecentReactions()).toEqual([]);
  });

  it("adds recent emojis, keeping up to 5 ordered by recency", () => {
    addRecentReaction("🚀");
    addRecentReaction("🍕");
    addRecentReaction("🔥");
    addRecentReaction("✨");
    addRecentReaction("💯");
    addRecentReaction("⭐");

    const recents = getRecentReactions();
    expect(recents).toHaveLength(5);
    expect(recents).toEqual(["⭐", "💯", "✨", "🔥", "🍕"]);
  });

  it("deduplicates recent emojis and moves most recent to front", () => {
    addRecentReaction("🚀");
    addRecentReaction("🍕");
    addRecentReaction("🚀");

    expect(getRecentReactions()).toEqual(["🚀", "🍕"]);
  });

  it("correctly identifies whether an emoji is on the main list", () => {
    expect(isMainListReaction("👍")).toBe(true);
    expect(isMainListReaction("❤️")).toBe(true);
    expect(isMainListReaction("🥰")).toBe(true);
    expect(isMainListReaction("🎉")).toBe(true);
    expect(isMainListReaction("🚀")).toBe(false);
    expect(isMainListReaction("💙", "💙")).toBe(true);
    expect(isMainListReaction("💙", "❤️")).toBe(false);
  });
});
