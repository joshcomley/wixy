import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import { CLASSIC_MODE, parseCookoutView, parseModeInfo, type CookoutSummary } from "../../src/server/cookout/api";
import { cookoutStatusLine, createCookoutCards } from "../../src/server/cookout/cookoutCard";
import { createCookoutModel } from "../../src/server/cookout/model";
import { finishedView, picture } from "./fixtures";
import { TOASTIE_MODE, toastieFinished, toastiePicking } from "./modeFixtures";

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

// -- Game modes (spec/server-chat/09c-cookout-modes.md §6.4) -------------------------------------------------

describe("the status line in a Toasted sandwich round", () => {
  const TOASTIE = parseModeInfo(TOASTIE_MODE);
  const toastie = (patch: Partial<CookoutSummary>): CookoutSummary => summary({ mode: "toastie", ...patch });

  it("uses the mode's numbers given the mode", () => {
    expect(cookoutStatusLine(toastie({ pickedCount: 3 }), TOASTIE)).toBe("Picking ingredients (3/8)…");
    expect(cookoutStatusLine(toastie({ pickedCount: 0 }), TOASTIE)).toBe("Picking ingredients (0/8)…");
    expect(cookoutStatusLine(toastie({ state: "finished", pickedCount: 8, concepts: "pending" }), TOASTIE)).toBe("All 8 picked — chef is thinking…");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "ready" }), TOASTIE)).toBe("3 toasted sandwich ideas ready");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "ready", generation: 2 }), TOASTIE)).toBe("3 new toasted sandwich ideas ready");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "failed" }), TOASTIE)).toBe("All 8 picked — the chef didn't finish");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "unavailable" }), TOASTIE)).toBe("All 8 picked");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "none", waiting: ["wildcard"] }), TOASTIE)).toBe("All 8 picked — Lift the cloche?");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "none", waiting: ["stars"] }), TOASTIE)).toBe("All 8 picked — Waiting for secret stars");
  });

  it("keeps the lines that carry no count exactly as in Classic", () => {
    expect(cookoutStatusLine(toastie({ state: "abandoned" }), TOASTIE)).toBe("Ended");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "ready", bankedCount: 2 }), TOASTIE)).toBe("2 recipes banked ✓");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "ready", dinnerDecided: true, cookedCount: 1 }), TOASTIE)).toBe(
      "3 toasted sandwich ideas ready · 🎯 Dinner decided · ✓ Cooked",
    );
    expect(cookoutStatusLine(toastie({ state: "finished", swap: "proposed" }), TOASTIE)).toBe("Swapping an ingredient…");
  });

  it("without the view's mode it says what it can without a count, and never guesses Classic's ten", () => {
    expect(cookoutStatusLine(toastie({ pickedCount: 3 }))).toBe("Picking ingredients…");
    expect(cookoutStatusLine(toastie({ pickedCount: 3 }), null)).toBe("Picking ingredients…");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "pending" }))).toBe("All picked — chef is thinking…");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "ready" }))).toBe("3 ideas ready");
    expect(cookoutStatusLine(toastie({ state: "finished", concepts: "failed" }))).toBe("All picked — the chef didn't finish");
    // A view of some other mode is not this round's.
    expect(cookoutStatusLine(toastie({ pickedCount: 3 }), CLASSIC_MODE)).toBe("Picking ingredients…");
  });

  it("Classic lines are unchanged; a mode that disagrees with the summary leaves the count out", () => {
    expect(cookoutStatusLine(summary({ pickedCount: 4 }))).toBe("Picking ingredients (4/10)…");
    expect(cookoutStatusLine(summary({ pickedCount: 4 }), CLASSIC_MODE)).toBe("Picking ingredients (4/10)…");
    // The view says toasted sandwich while the summary says Classic (review shot 16): never "/10", never "/8".
    expect(cookoutStatusLine(summary({ pickedCount: 4 }), TOASTIE)).toBe("Picking ingredients…");
    expect(cookoutStatusLine(summary({ state: "finished", concepts: "ready" }), TOASTIE)).toBe("3 ideas ready");
    expect(cookoutStatusLine(summary({ state: "finished", concepts: "ready", generation: 2 }))).toBe("3 new dish ideas ready");
  });
});

describe("the card in a Toasted sandwich round", () => {
  it("carries the mode badge, the mode's emoji and the mode's numbers once the round's view is read", () => {
    const { cards, model } = make();
    const msg = message(41, summary({ mode: "toastie", pickedCount: 3 }));
    const card = cards.create(msg);
    // Before the view: no badge (nothing to name it from), no count.
    expect(card.querySelector(".wx-srv-ck-mcard-mode")).toBeNull();
    expect(card.querySelector(".wx-srv-ck-mcard-status")?.textContent).toBe("Picking ingredients…");
    const view = parseCookoutView(toastiePicking({ seq: 41, turn: 4 }));
    if (view === null) throw new Error("fixture");
    model.apply(view);
    cards.render(card, msg);
    const badge = card.querySelector<HTMLElement>(".wx-srv-ck-mcard-mode");
    expect(badge?.textContent).toBe("Toasted sandwich");
    expect(badge?.dataset["gameMode"]).toBe("toastie");
    expect(card.querySelector(".wx-srv-ck-mcard-icon")?.textContent).toBe("🥪");
    // Open / Blind is still there beside it.
    expect([...card.querySelectorAll(".wx-srv-ck-badge")].map((b) => b.textContent)).toEqual(["Toasted sandwich", "Open"]);
    expect(card.querySelector(".wx-srv-ck-mcard-status")?.textContent).toBe("Picking ingredients (3/8)…");
  });

  it("a Classic round has no mode badge and keeps 🍳", () => {
    const { cards, model } = make();
    const msg = message(41, summary({ pickedCount: 4 }));
    const card = cards.create(msg);
    const view = parseCookoutView(finishedView({ seq: 41 }));
    if (view === null) throw new Error("fixture");
    model.apply(view);
    cards.render(card, msg);
    expect(card.querySelector(".wx-srv-ck-mcard-mode")).toBeNull();
    expect(card.querySelector(".wx-srv-ck-mcard-icon")?.textContent).toBe("🍳");
    expect([...card.querySelectorAll(".wx-srv-ck-badge")].map((b) => b.textContent)).toEqual(["Open"]);
  });

  it("a finished toasted sandwich reads \"3 toasted sandwich ideas ready\" and a Blind one says Blind", () => {
    const { cards, model } = make();
    const msg = message(41, summary({ mode: "toastie", state: "finished", concepts: "ready", blind: true, pickedCount: 8, rev: 12 }));
    const card = cards.create(msg);
    const view = parseCookoutView(toastieFinished({ seq: 41, blind: true }));
    if (view === null) throw new Error("fixture");
    model.apply(view);
    cards.render(card, msg);
    expect(card.querySelector(".wx-srv-ck-mcard-status")?.textContent).toBe("3 toasted sandwich ideas ready");
    expect([...card.querySelectorAll(".wx-srv-ck-badge")].map((b) => b.textContent)).toEqual(["Toasted sandwich", "Blind"]);
  });
});

describe("a mode card before its round is read (the cached options' numbers)", () => {
  const TOASTIE_ENTRY = { id: "toastie", label: "Toasted sandwich", emoji: "🥪", turns: 8 };

  function makeWith(modeOption: (id: string) => typeof TOASTIE_ENTRY | null) {
    const model = createCookoutModel({
      session: () => null,
      viewer: () => "Josh",
      fetchRound: async () => ({ ok: false, kind: "unavailable" }),
      onChange: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const cards = createCookoutCards({ model, document, openGame: vi.fn(), modeOption });
    return { model, cards };
  }

  it("uses the options' entry: the count, the dish words and the badge", () => {
    const { cards } = makeWith(() => TOASTIE_ENTRY);
    const status = (patch: Partial<CookoutSummary>): string => {
      const card = cards.create(message(41, summary({ mode: "toastie", ...patch })));
      return card.querySelector(".wx-srv-ck-mcard-status")?.textContent ?? "";
    };
    expect(status({ pickedCount: 3 })).toBe("Picking ingredients (3/8)…");
    expect(status({ state: "finished", pickedCount: 8, concepts: "pending" })).toBe("All 8 picked — chef is thinking…");
    expect(status({ state: "finished", concepts: "ready" })).toBe("3 toasted sandwich ideas ready");
    const card = cards.create(message(41, summary({ mode: "toastie", pickedCount: 3 })));
    expect(card.querySelector(".wx-srv-ck-mcard-mode")?.textContent).toBe("Toasted sandwich");
    expect(card.querySelector(".wx-srv-ck-mcard-icon")?.textContent).toBe("🥪");
  });

  it("with no entry (options not read) there is no count and never a /10", () => {
    const { cards } = makeWith(() => null);
    const card = cards.create(message(41, summary({ mode: "toastie", pickedCount: 3 })));
    expect(card.querySelector(".wx-srv-ck-mcard-status")?.textContent).toBe("Picking ingredients…");
    expect(card.querySelector(".wx-srv-ck-mcard-mode")).toBeNull();
    expect(card.textContent).not.toContain("/10");
  });

  it("a toastie summary never draws /10, whatever mode or view is handed in, for every count and state", () => {
    const modes: Array<CardModeArg> = [null, CLASSIC_MODE, parseModeInfo(TOASTIE_MODE), { id: "toastie", label: "T", emoji: "", turns: 8 }, { id: "other", label: "O", emoji: "", turns: 10 }];
    for (const mode of modes) {
      for (let picked = 0; picked <= 8; picked += 1) {
        for (const state of ["picking", "finished", "abandoned"] as const) {
          for (const concepts of ["none", "pending", "ready", "failed", "unavailable"] as const) {
            for (const generation of [1, 2]) {
              const text = cookoutStatusLine(summary({ mode: "toastie", state, pickedCount: picked, concepts, generation }), mode);
              expect(text, `${mode?.id} ${state} ${picked} ${concepts}`).not.toContain("/10");
              expect(text).not.toContain("10 picked");
            }
          }
        }
      }
    }
  });

  it("a rendered card with a Classic view for a toastie summary does not draw a count either", () => {
    const { cards, model } = makeWith(() => TOASTIE_ENTRY);
    const view = parseCookoutView(finishedView({ seq: 41 }));
    if (view === null) throw new Error("fixture");
    model.apply(view);
    const card = cards.create(message(41, summary({ mode: "toastie", state: "finished", concepts: "pending" })));
    expect(card.textContent).not.toContain("10");
  });
});

describe("the mode card's head", () => {
  it("carries wx-srv-ck-mcard-head-mode only for a mode round", () => {
    const { cards, model } = make();
    const classic = cards.create(message(41, summary({})));
    expect(classic.querySelector(".wx-srv-ck-mcard-head")?.classList.contains("wx-srv-ck-mcard-head-mode")).toBe(false);
    const msg = message(42, summary({ mode: "toastie", pickedCount: 1 }));
    const card = cards.create(msg);
    const view = parseCookoutView(toastiePicking({ seq: 42, turn: 2 }));
    if (view === null) throw new Error("fixture");
    model.apply(view);
    cards.render(card, msg);
    expect(card.querySelector(".wx-srv-ck-mcard-head")?.classList.contains("wx-srv-ck-mcard-head-mode")).toBe(true);
  });
});

type CardModeArg = { id: string; label: string; emoji: string; turns: number } | null;
