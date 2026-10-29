import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import { parseCookoutView, type CookoutSummary } from "../../src/server/cookout/api";
import { cookoutStatusLine, createCookoutCards } from "../../src/server/cookout/cookoutCard";
import { createCookoutModel } from "../../src/server/cookout/model";
import { finishedView, picture } from "./fixtures";

// The main-chat card (spec 09 §5.4): the mode badge, one status line from the message's own summary,
// and an Open button; dish photos beside the words once the round has them.

function summary(patch: Partial<CookoutSummary>): CookoutSummary {
  return {
    state: "picking",
    mode: "classic",
    blind: false,
    pickedCount: 0,
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

function message(seq: number, cookout: unknown): Message {
  return { seq, sender: "Josh", text: null, attachments: [], reactions: [], createdAt: 1, replyTo: null, cookout } as unknown as Message;
}

function make() {
  const model = createCookoutModel({
    session: () => null,
    viewer: () => "Josh",
    fetchRound: async () => ({ ok: false, kind: "unavailable" }),
    onChange: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  const openGame = vi.fn();
  const cards = createCookoutCards({ model, document, openGame });
  return { model, cards, openGame };
}

describe("the status line", () => {
  it("says each stage the spec names", () => {
    expect(cookoutStatusLine(summary({ pickedCount: 4 }))).toBe("Picking ingredients (4/10)…");
    expect(cookoutStatusLine(summary({ state: "finished", pickedCount: 10, concepts: "pending" }))).toBe("All 10 picked — chef is thinking…");
    expect(cookoutStatusLine(summary({ state: "finished", concepts: "ready" }))).toBe("3 dish ideas ready");
    expect(cookoutStatusLine(summary({ state: "finished", concepts: "ready", bankedCount: 1 }))).toBe("1 recipe banked ✓");
    expect(cookoutStatusLine(summary({ state: "finished", concepts: "ready", bankedCount: 2 }))).toBe("2 recipes banked ✓");
    expect(cookoutStatusLine(summary({ state: "abandoned" }))).toBe("Ended");
    expect(cookoutStatusLine(summary({ state: "finished", concepts: "failed" }))).toBe("All 10 picked — the chef didn't finish");
    expect(cookoutStatusLine(null)).toBe("Cookout");
  });
});

describe("the card", () => {
  it("shows the mode badge, the status and an Open button that opens the game tab", () => {
    const { cards, openGame } = make();
    const card = cards.create(message(41, summary({ blind: true, pickedCount: 4 })));
    document.body.append(card);
    expect(card.querySelector(".wx-srv-ck-badge")?.textContent).toBe("Blind");
    expect(card.querySelector(".wx-srv-ck-mcard-status")?.textContent).toBe("Picking ingredients (4/10)…");
    const open = card.querySelector<HTMLButtonElement>(".wx-srv-ck-mcard-open");
    expect(open?.textContent).toBe("Open");
    expect(open?.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    open?.click();
    expect(openGame).toHaveBeenCalledWith(41);
  });

  it("an Open-mode round's badge says Open", () => {
    const { cards } = make();
    const card = cards.create(message(41, summary({ state: "finished", concepts: "ready" })));
    expect(card.querySelector(".wx-srv-ck-badge")?.textContent).toBe("Open");
    expect(card.querySelector(".wx-srv-ck-mcard-open")?.textContent).toBe("Open");
  });

  it("carries no ingredient or recipe text (the summary has none), and adds the dish photos from the view", () => {
    const { cards, model } = make();
    const msg = message(41, summary({ state: "finished", concepts: "ready", bankedCount: 1, rev: 12 }));
    const card = cards.create(msg);
    expect(card.querySelectorAll("img")).toHaveLength(0);
    const view = parseCookoutView(finishedView({ images: "done", pictures: { a: picture(1), b: picture(2), c: picture(3) } }));
    if (view === null) throw new Error("fixture");
    model.apply(view);
    cards.render(card, msg);
    expect([...card.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
      "/api/admin/server/media/thumb-1.jpg",
      "/api/admin/server/media/thumb-2.jpg",
      "/api/admin/server/media/thumb-3.jpg",
    ]);
    expect(card.textContent).not.toContain("Ribeye");
    // A redraw with the same photos keeps the very same image elements (no flicker, no re-request).
    const before = [...card.querySelectorAll("img")];
    cards.render(card, msg);
    const after = [...card.querySelectorAll("img")];
    expect(after.every((img, i) => img === before[i])).toBe(true);
    expect(after).toHaveLength(3);
    // A different photo set is redrawn.
    const fewer = parseCookoutView(finishedView({ rev: 13, images: "done", pictures: { a: picture(1) } }));
    if (fewer === null) throw new Error("fixture");
    model.apply(fewer);
    cards.render(card, msg);
    expect(card.querySelectorAll("img")).toHaveLength(1);
  });

  it("a malformed summary still draws a plain card rather than nothing", () => {
    const { cards } = make();
    const card = cards.create(message(41, { state: "odd" }));
    expect(card.querySelector(".wx-srv-ck-mcard-status")?.textContent).toBe("Cookout");
  });
});
