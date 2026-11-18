import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import type { CookoutSummary } from "../../src/server/cookout/api";
import { cookoutStatusLine, createCookoutCards } from "../../src/server/cookout/cookoutCard";
import { createCookoutModel } from "../../src/server/cookout/model";

// The main-chat card's twist status lines (spec/server-chat/09a-cookout-twists.md §9): "Lift the cloche?",
// "Waiting for secret stars", "Swapping an ingredient…", "🎯 Dinner decided", "✓ Cooked", and the second
// dish set's wording. The summary carries flags and counts only, so no line can name a star, a vote or a dish.

function summary(patch: Partial<CookoutSummary>): CookoutSummary {
  return {
    state: "finished",
    mode: "classic",
    blind: false,
    pickedCount: 10,
    concepts: "none",
    bankedCount: 0,
    rev: 1,
    generation: 1,
    waiting: [],
    swap: "none",
    dinnerDecided: false,
    cookedCount: 0,
    ...patch,
  };
}

describe("the status line, twists", () => {
  it("asks to lift the cloche, or says it is waiting for the secret stars", () => {
    expect(cookoutStatusLine(summary({ waiting: ["wildcard"] }))).toBe("All 10 picked — Lift the cloche?");
    expect(cookoutStatusLine(summary({ waiting: ["stars"] }))).toBe("All 10 picked — Waiting for secret stars");
    // Stars come first at the gate, but the cloche is the line when both are still open.
    expect(cookoutStatusLine(summary({ waiting: ["stars", "wildcard"] }))).toMatch(/^All 10 picked — (Lift the cloche\?|Waiting for secret stars)$/);
  });

  it("a gate no longer matters once the chef has started", () => {
    expect(cookoutStatusLine(summary({ concepts: "pending", waiting: ["stars"] }))).toBe("All 10 picked — chef is thinking…");
  });

  it("says a swap is under way", () => {
    expect(cookoutStatusLine(summary({ concepts: "ready", swap: "proposed" }))).toBe("Swapping an ingredient…");
    expect(cookoutStatusLine(summary({ concepts: "ready", swap: "done" }))).toBe("3 dish ideas ready");
  });

  it("marks a decided dinner and a cooked recipe, after the dish count", () => {
    expect(cookoutStatusLine(summary({ concepts: "ready", dinnerDecided: true }))).toBe("3 dish ideas ready · 🎯 Dinner decided");
    expect(cookoutStatusLine(summary({ concepts: "ready", bankedCount: 2, dinnerDecided: true, cookedCount: 1 }))).toBe("2 recipes banked ✓ · 🎯 Dinner decided · ✓ Cooked");
    expect(cookoutStatusLine(summary({ concepts: "ready", bankedCount: 1, cookedCount: 1 }))).toBe("1 recipe banked ✓ · ✓ Cooked");
    expect(cookoutStatusLine(summary({ concepts: "ready", cookedCount: 1 }))).toBe("3 dish ideas ready · ✓ Cooked");
  });

  it("the second dish set reads as new dishes", () => {
    expect(cookoutStatusLine(summary({ concepts: "ready", generation: 2 }))).toBe("3 new dish ideas ready");
    expect(cookoutStatusLine(summary({ concepts: "pending", generation: 2 }))).toBe("Ingredient swapped — chef is thinking…");
    expect(cookoutStatusLine(summary({ concepts: "ready", generation: 2, bankedCount: 1, dinnerDecided: true }))).toBe("1 recipe banked ✓ · 🎯 Dinner decided");
  });

  it("a round that is still being picked, or ended, ignores the flags", () => {
    expect(cookoutStatusLine(summary({ state: "picking", pickedCount: 4, dinnerDecided: true, cookedCount: 2 }))).toBe("Picking ingredients (4/10)…");
    expect(cookoutStatusLine(summary({ state: "abandoned", dinnerDecided: true }))).toBe("Ended");
  });
});

describe("the card with twists", () => {
  it("draws the new lines from the message's own summary, with no dish, star or vote text", () => {
    const model = createCookoutModel({
      session: () => null,
      viewer: () => "Josh",
      fetchRound: async () => ({ ok: false, kind: "unavailable" }),
      onChange: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const cards = createCookoutCards({ model, document, openGame: vi.fn() });
    const message = (cookout: unknown): Message => ({ seq: 41, sender: "Josh", text: null, attachments: [], reactions: [], createdAt: 1, replyTo: null, cookout }) as unknown as Message;
    const card = cards.create(message({ state: "finished", blind: false, pickedCount: 10, concepts: "none", bankedCount: 0, rev: 5, generation: 1, waiting: ["wildcard"], swap: "none", dinnerDecided: false, cookedCount: 0 }));
    expect(card.querySelector(".wx-srv-ck-mcard-status")?.textContent).toBe("All 10 picked — Lift the cloche?");
    cards.render(card, message({ state: "finished", blind: true, pickedCount: 10, concepts: "ready", bankedCount: 1, rev: 6, generation: 2, waiting: [], swap: "none", dinnerDecided: true, cookedCount: 1 }));
    expect(card.querySelector(".wx-srv-ck-mcard-status")?.textContent).toBe("1 recipe banked ✓ · 🎯 Dinner decided · ✓ Cooked");
    expect(card.querySelector(".wx-srv-ck-badge")?.textContent).toBe("Blind");
    expect(card.textContent).not.toMatch(/ribeye|toast|concept|\bvote\b/i);
  });
});
