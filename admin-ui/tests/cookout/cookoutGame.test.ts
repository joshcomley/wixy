import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import { ServerLockedError } from "../../src/server/api/http";
import { createGameTabs, type GameTabs } from "../../src/server/gameTabs";
import type { ItemChat } from "../../src/server/itemChat";
import { parseCookoutView, type CookoutOutcome, type CookoutView } from "../../src/server/cookout/api";
import {
  categoryName,
  createCookoutGame,
  formatElapsed,
  skipLabel,
  turnPrompt,
  type CookoutGame,
  type CookoutGameApi,
} from "../../src/server/cookout/cookoutGame";
import { createCookoutModel, type CookoutModel } from "../../src/server/cookout/model";
import { createCookoutStartSheet, type StartChoices } from "../../src/server/cookout/startSheet";
import {
  FULL_RECIPE,
  LENTILS,
  RIBEYE,
  SALMON,
  bankedRecipes,
  finishedView,
  picture,
  pickingView,
  P2_PICKS,
  type Json,
} from "./fixtures";

// The Cookout pane (spec 09 §5.3, §6): the start sheet, Join, the two-skip button states, the Blind
// cloche with no leaked ingredient strings, the 10-pick reveal, three dish cards and the independent
// Bank this → Writing recipe… → Banked ✓ flow, plus the lock, End game and the Recipe-book jump.

function v(raw: Json): CookoutView {
  const view = parseCookoutView(raw);
  if (view === null) throw new Error("fixture did not parse");
  return view;
}

type ApiMock = { [K in keyof CookoutGameApi]: ReturnType<typeof vi.fn> };

interface Harness {
  game: CookoutGame;
  tabs: GameTabs;
  model: CookoutModel;
  api: ApiMock;
  pane: HTMLElement;
  lockNow: ReturnType<typeof vi.fn>;
  openStartSheet: ReturnType<typeof vi.fn>;
  openBook: ReturnType<typeof vi.fn>;
  openLightbox: ReturnType<typeof vi.fn>;
  clock: { now: number; intervals: Map<number, () => void>; timeouts: Map<number, () => void> };
  show(raw: Json): CookoutView;
}

function make(): Harness {
  const strip = document.createElement("div");
  strip.className = "fake-strip";
  const itemChat = {
    popup: document.createElement("div"),
    createStrip: () => ({ element: strip, draw: () => {} }),
    openPopup: vi.fn(),
    closePopup: vi.fn(),
    isPopupOpen: () => false,
    popupSeq: () => null,
    refresh: vi.fn(),
    reset: vi.fn(),
  } as unknown as ItemChat;
  const tabs = createGameTabs({ document, itemChat, onLayoutChange: () => {} });
  const model = createCookoutModel({
    session: () => null,
    viewer: () => "Josh",
    fetchRound: async () => ({ ok: false, kind: "unavailable" }),
    onChange: () => tabs.refresh(),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  const clock = { now: 1_000_000, intervals: new Map<number, () => void>(), timeouts: new Map<number, () => void>() };
  let nextId = 1;
  const api: ApiMock = {
    join: vi.fn(),
    skip: vi.fn(),
    pick: vi.fn(),
    abandon: vi.fn(),
    retryConcepts: vi.fn(),
    retryPictures: vi.fn(),
    bank: vi.fn(),
    retryRecipe: vi.fn(),
    lucky: vi.fn(),
    chaos: vi.fn(),
    veto: vi.fn(),
    star: vi.fn(),
    wildcard: vi.fn(),
    vote: vi.fn(),
    proposeSwap: vi.fn(),
    chooseSwap: vi.fn(),
    cancelSwap: vi.fn(),
    markCooked: vi.fn(),
    rate: vi.fn(),
    linkPhoto: vi.fn(),
    photos: vi.fn(),
  };
  const lockNow = vi.fn();
  const openStartSheet = vi.fn();
  const openBook = vi.fn();
  const openLightbox = vi.fn();
  let moveCounter = 0;
  const game = createCookoutGame({
    document,
    model,
    tabs,
    itemChat,
    hooks: { lockNow },
    api: api as unknown as CookoutGameApi,
    roundMessage: (seq) => ({ seq }) as Message,
    partner: () => "Cupcake",
    openStartSheet,
    openBook,
    openLightbox,
    afterChange: () => {},
    clock: {
      now: () => clock.now,
      setTimeout: (cb) => {
        const id = nextId++;
        clock.timeouts.set(id, cb);
        return id;
      },
      clearTimeout: (id) => clock.timeouts.delete(id),
      setInterval: (cb) => {
        const id = nextId++;
        clock.intervals.set(id, cb);
        return id;
      },
      clearInterval: (id) => clock.intervals.delete(id),
    },
    newId: () => `move-${++moveCounter}`,
  });
  document.body.append(game.pane, tabs.tabBar);
  return {
    game,
    tabs,
    model,
    api,
    pane: game.pane,
    lockNow,
    openStartSheet,
    openBook,
    openLightbox,
    clock,
    show(raw) {
      const view = v(raw);
      model.apply(view);
      if (tabs.seqOf("cookout") !== view.seq) game.open(view.seq);
      tabs.refresh();
      return view;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
}

function visible(root: ParentNode, selector: string): boolean {
  const node = root.querySelector<HTMLElement>(selector);
  if (node === null) return false;
  for (let el: HTMLElement | null = node; el !== null; el = el.parentElement) if (el.hidden) return false;
  return true;
}

function ok(raw: Json): CookoutOutcome {
  return { ok: true, view: v(raw) };
}

afterEach(() => document.body.replaceChildren());

/** start-1, start-2, … */
function ids(): () => string {
  let n = 0;
  return () => `start-${++n}`;
}

describe("words", () => {
  it("the skip button says how many skips are left, and the third pair is final", () => {
    expect(skipLabel(0)).toBe("Neither — deal 2 new options (2 skips left)");
    expect(skipLabel(1)).toBe("Neither — deal final 2 options (1 skip left)");
    expect(skipLabel(2)).toBe("Final pair — pick one of the two above");
  });

  it("the turn banner names the pick and the go, or who is being waited for", () => {
    expect(turnPrompt(v(pickingView({ turn: 3, offerIndex: 0 })), "Cupcake")).toBe("Your turn — Pick 2 of 5 (Go 1 of 3)");
    expect(turnPrompt(v(pickingView({ turn: 4, you: 1, showOptions: false, blind: true, p2Picks: null, p2Count: 1 })), null)).toBe(
      "Waiting for Cupcake — Pick 2 of 5",
    );
    expect(turnPrompt(v(pickingView({ turn: 2, player2: null, showOptions: false, waitingForJoin: true })), "Cupcake")).toBe(
      "Waiting for Cupcake to join — Pick 1 of 5",
    );
  });

  it("category ids read as the bank's names", () => {
    expect(categoryName("meat-poultry")).toBe("Meat & Poultry");
    expect(categoryName("new-thing")).toBe("New thing");
  });

  it("the chef's clock reads minutes and seconds", () => {
    expect(formatElapsed(42.7)).toBe("0:42");
    expect(formatElapsed(187)).toBe("3:07");
  });
});

/** The start sheet's twist deps: no chef until a test says so, and an empty pantry. */
const SHEET_DEPS = {
  loadOptions: async () => null,
  search: async () => ({ ok: true as const, ingredients: [] }),
};

describe("the start sheet", () => {
  it("defaults to Open, can choose Blind, and starts in the chosen mode, closing when it started", async () => {
    let resolve: () => void = () => {};
    const start = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const sheet = createCookoutStartSheet({ document, ...SHEET_DEPS, start, newId: ids() });
    document.body.append(sheet.element);
    sheet.open();
    expect(sheet.element.hidden).toBe(false);
    expect(q(sheet.element, '[data-mode="open"]').getAttribute("aria-checked")).toBe("true");
    q<HTMLButtonElement>(sheet.element, '[data-mode="blind"]').click();
    expect(q(sheet.element, '[data-mode="blind"]').getAttribute("aria-checked")).toBe("true");
    const go = q<HTMLButtonElement>(sheet.element, ".wx-srv-ck-start-go");
    go.click();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ blind: true, style: null, encore: null }), "start-1");
    expect(go.disabled).toBe(true);
    expect(go.textContent).toBe("Starting…");
    resolve();
    await flush();
    expect(sheet.isOpen()).toBe(false);
    expect(sheet.element.hidden).toBe(true);
  });

  it("is one radio group: arrows move the choice, only the chosen mode is a tab stop, and Tab stays inside", () => {
    const sheet = createCookoutStartSheet({ document, ...SHEET_DEPS, start: vi.fn(async () => {}), newId: ids() });
    document.body.append(sheet.element);
    sheet.open();
    const open = q<HTMLButtonElement>(sheet.element, '[data-mode="open"]');
    const blind = q<HTMLButtonElement>(sheet.element, '[data-mode="blind"]');
    expect([open.tabIndex, blind.tabIndex]).toEqual([0, -1]);
    open.focus();
    open.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(blind.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(blind);
    expect([open.tabIndex, blind.tabIndex]).toEqual([-1, 0]);
    const go = q<HTMLButtonElement>(sheet.element, ".wx-srv-ck-start-go");
    go.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    go.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(blind);
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    blind.dispatchEvent(back);
    expect(document.activeElement).toBe(go);
  });

  it("opens with the given mode preselected (New in the pane), and Cancel closes it", () => {
    const sheet = createCookoutStartSheet({ document, ...SHEET_DEPS, start: vi.fn(async () => {}), newId: ids() });
    sheet.open({ blind: true });
    expect(q(sheet.element, '[data-mode="blind"]').getAttribute("aria-checked")).toBe("true");
    q<HTMLButtonElement>(sheet.element, ".wx-srv-ck-start-cancel").click();
    expect(sheet.isOpen()).toBe(false);
  });

  it("stays open with the reason when the round could not start", async () => {
    const sheet = createCookoutStartSheet({
      document,
      ...SHEET_DEPS,
      start: vi.fn(async () => {
        throw new Error("Cookout isn't available on this server right now.");
      }),
      newId: ids(),
    });
    sheet.open();
    q<HTMLButtonElement>(sheet.element, ".wx-srv-ck-start-go").click();
    await flush();
    expect(sheet.isOpen()).toBe(true);
    expect(q(sheet.element, ".wx-srv-ck-start-error").textContent).toBe("Cookout isn't available on this server right now.");
    expect(q<HTMLButtonElement>(sheet.element, ".wx-srv-ck-start-go").disabled).toBe(false);
  });

  it("a retry after a failed start sends the SAME client id (no second round); a new mode or a new open does not", async () => {
    const start = vi.fn(async () => {
      throw new Error("Couldn't start a Cookout — try again.");
    });
    const sheet = createCookoutStartSheet({ document, ...SHEET_DEPS, start, newId: ids() });
    sheet.open();
    const go = q<HTMLButtonElement>(sheet.element, ".wx-srv-ck-start-go");
    go.click();
    await flush();
    go.click();
    await flush();
    q<HTMLButtonElement>(sheet.element, '[data-mode="blind"]').click();
    go.click();
    await flush();
    sheet.close();
    sheet.open();
    go.click();
    await flush();
    expect(start.mock.calls.map((call: unknown[]) => [(call[0] as StartChoices).blind, call[1]])).toEqual([
      [false, "start-1"],
      [false, "start-1"],
      [true, "start-2"],
      [false, "start-3"],
    ]);
  });

  it("opening again while a start is in flight changes nothing (no second Start beside it)", () => {
    const start = vi.fn(() => new Promise<void>(() => {}));
    const sheet = createCookoutStartSheet({ document, ...SHEET_DEPS, start, newId: ids() });
    sheet.open({ blind: true });
    q<HTMLButtonElement>(sheet.element, ".wx-srv-ck-start-go").click();
    sheet.open({ blind: false });
    expect(q<HTMLButtonElement>(sheet.element, ".wx-srv-ck-start-go").disabled).toBe(true);
    expect(q(sheet.element, '[data-mode="blind"]').getAttribute("aria-checked")).toBe("true");
  });

  it("the pane's New opens the sheet with the round's own mode", () => {
    const h = make();
    h.show(finishedView({ blind: true }));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-new").click();
    expect(h.openStartSheet).toHaveBeenCalledWith(expect.objectContaining({ blind: true, style: null, challenge: null, wildcard: false, stars: false, fridge: null }));
  });
});

describe("Join", () => {
  it("shows a Join Cookout button to a viewer who is not Player 1 while Slot 2 is free, and joins", async () => {
    const h = make();
    h.show(pickingView({ you: null, player2: null }));
    const join = q<HTMLButtonElement>(h.pane, ".wx-srv-ck-join");
    expect(join.textContent).toBe("Join Cookout");
    h.api.join.mockResolvedValue(ok(pickingView({ you: 2, rev: 4 })));
    join.click();
    expect(h.api.join).toHaveBeenCalledWith(41);
    await flush();
    expect(h.pane.querySelector(".wx-srv-ck-join")).toBeNull();
  });

  it("never shows Join to Player 1, nor once Slot 2 is bound", () => {
    const h = make();
    h.show(pickingView({ you: 1, player2: null }));
    expect(h.pane.querySelector(".wx-srv-ck-join")).toBeNull();
    h.show(pickingView({ you: null, rev: 5 }));
    expect(h.pane.querySelector(".wx-srv-ck-join")).toBeNull();
  });
});

describe("the draft: two cards, two skips", () => {
  it("shows the two ingredient cards with emoji, category and blurb, and the first skip", () => {
    const h = make();
    h.show(pickingView({ turn: 1, offerIndex: 0 }));
    const cards = h.pane.querySelectorAll<HTMLButtonElement>("button.wx-srv-ck-opt");
    expect([...cards].map((c) => c.dataset["ingredient"])).toEqual(["ribeye-steak", "salmon-fillet"]);
    expect(q(cards[0] as HTMLElement, ".wx-srv-ck-opt-cat").textContent).toBe("Meat & Poultry");
    expect(q(cards[0] as HTMLElement, ".wx-srv-ck-opt-name").textContent).toBe("Ribeye steak");
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Your turn — Pick 1 of 5 (Go 1 of 3)");
    expect(q(h.pane, ".wx-srv-ck-skip").textContent).toBe("Neither — deal 2 new options (2 skips left)");
  });

  it("the second pair offers the final skip, the third has no skip at all", () => {
    const h = make();
    h.show(pickingView({ offerIndex: 1, options: [LENTILS, SALMON] }));
    expect(q(h.pane, ".wx-srv-ck-skip").textContent).toBe("Neither — deal final 2 options (1 skip left)");
    h.show(pickingView({ offerIndex: 2, options: [LENTILS, SALMON], rev: 9 }));
    expect(h.pane.querySelector(".wx-srv-ck-skip")).toBeNull();
    expect(q(h.pane, ".wx-srv-ck-final").textContent).toBe("Final pair — pick one of the two above");
  });

  it("a skip sends the turn, the offer and the pair on screen with a fresh move id", async () => {
    const h = make();
    h.show(pickingView({ turn: 3, offerIndex: 1, options: [LENTILS, SALMON] }));
    h.api.skip.mockResolvedValue(ok(pickingView({ turn: 3, offerIndex: 2, options: [RIBEYE, SALMON], rev: 9 })));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").click();
    expect(h.api.skip).toHaveBeenCalledWith(41, { moveId: "move-1", turn: 3, offer: 1, optionIds: [LENTILS.id, SALMON.id] });
    expect(q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").disabled).toBe(true);
    await flush();
    expect(h.pane.querySelector(".wx-srv-ck-final")).not.toBeNull();
  });

  it("a skip after the pair changed in place (a veto, same offer) names the NEW pair, not the one it replaced", async () => {
    const h = make();
    h.show(pickingView({ turn: 3, offerIndex: 1, options: [LENTILS, SALMON] }));
    h.show(pickingView({ turn: 3, offerIndex: 1, options: [LENTILS, RIBEYE], rev: 9 }));
    h.api.skip.mockResolvedValue(ok(pickingView({ turn: 3, offerIndex: 2, options: [RIBEYE, SALMON], rev: 10 })));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").click();
    expect(h.api.skip).toHaveBeenCalledWith(41, { moveId: "move-1", turn: 3, offer: 1, optionIds: [LENTILS.id, RIBEYE.id] });
    await flush();
  });

  it("a pick resends the SAME move id after a lost answer, and says it is in the basket", async () => {
    const h = make();
    h.show(pickingView({ turn: 1 }));
    h.api.pick
      .mockResolvedValueOnce({ ok: false, kind: "unavailable" })
      .mockResolvedValueOnce(ok(pickingView({ turn: 2, rev: 9, p1Picks: [RIBEYE], showOptions: false, blind: true, p2Picks: null })));
    q<HTMLButtonElement>(h.pane, '[data-ingredient="ribeye-steak"]').click();
    await flush();
    const retry = [...h.clock.timeouts.values()][0];
    retry?.();
    await flush();
    expect(h.api.pick.mock.calls.map((c) => c[1])).toEqual([
      { moveId: "move-1", turn: 1, offer: 0, ingredientId: "ribeye-steak" },
      { moveId: "move-1", turn: 1, offer: 0, ingredientId: "ribeye-steak" },
    ]);
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("Ribeye steak is in the basket ✓");
  });

  it("a 409 says why in plain words and re-reads the round", async () => {
    const h = make();
    const refetch = vi.spyOn(h.model, "refetch");
    h.show(pickingView({ turn: 1, offerIndex: 2 }));
    h.api.pick.mockResolvedValue({ ok: false, kind: "not_your_turn" });
    q<HTMLButtonElement>(h.pane, '[data-ingredient="salmon-fillet"]').click();
    await flush();
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("It isn't your turn any more.");
    expect(refetch).toHaveBeenCalledWith(41);
  });

  it("a lock (401) locks the chat", async () => {
    const h = make();
    h.show(pickingView());
    h.api.skip.mockRejectedValue(new ServerLockedError());
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").click();
    await flush();
    expect(h.lockNow).toHaveBeenCalledWith("unauthorized");
  });

  it("in Open mode the partner's pair is shown read-only while they choose", () => {
    const h = make();
    h.show(pickingView({ you: 2, turn: 3 }));
    expect(h.pane.querySelectorAll("button.wx-srv-ck-opt")).toHaveLength(0);
    expect(h.pane.querySelectorAll("div.wx-srv-ck-opt")).toHaveLength(2);
    expect(q(h.pane, ".wx-srv-ck-watch").textContent).toBe("Josh is choosing between:");
    expect(h.pane.querySelector(".wx-srv-ck-skip")).toBeNull();
  });
});

describe("Blind mode", () => {
  it("shows the covered cloche on the partner's turn, with no ingredient string of theirs anywhere", () => {
    const h = make();
    // The view carries what the server sends Player 1 on Player 2's turn: no pair, no role, no picks.
    h.show(pickingView({ blind: true, you: 1, turn: 4, showOptions: false, p2Picks: null, p2Count: 1 }));
    expect(q(h.pane, ".wx-srv-ck-cloche-text").textContent).toBe("🕵️ Secret turn: Cupcake is choosing…");
    expect(q(h.pane, ".wx-srv-ck-badge").textContent).toBe("Blind");
    const text = h.pane.textContent ?? "";
    const html = h.pane.innerHTML;
    for (const partner of [...P2_PICKS, RIBEYE, SALMON]) {
      expect(text).not.toContain(partner["name"] as string);
      expect(html).not.toContain(partner["id"] as string);
    }
    expect(text).not.toContain("protein");
    // The partner's pick is a counted secret, never a name.
    expect(h.pane.querySelectorAll(".wx-srv-ck-chip-secret")).toHaveLength(1);
    expect(h.pane.querySelectorAll(".wx-srv-ck-pill-secret")).toHaveLength(1);
  });

  it("the ten picks are revealed together when the round finishes, flipping open once", () => {
    const h = make();
    h.show(pickingView({ blind: true, you: 1, turn: 10, showOptions: false, p2Picks: null, p2Count: 4 }));
    h.show(finishedView({ blind: true, concepts: "pending", images: "none", rev: 20 }));
    const chips = h.pane.querySelectorAll(".wx-srv-ck-reveal-chip");
    expect(chips).toHaveLength(10);
    expect([...chips].every((c) => c.classList.contains("wx-srv-ck-flip"))).toBe(true);
    expect(q(h.pane, ".wx-srv-ck-reveal-title").textContent).toContain("The big reveal");
    expect(h.pane.textContent).toContain("Ribeye steak");
    // The next refresh keeps the banner (no second flip, no cut-short flip).
    const banner = q(h.pane, ".wx-srv-ck-reveal");
    h.show(finishedView({ blind: true, concepts: "pending", images: "none", rev: 21 }));
    expect(q(h.pane, ".wx-srv-ck-reveal")).toBe(banner);
  });
});

describe("Blind mode, every viewer", () => {
  /** Every ingredient string of Player 2's (and the pair being offered to them) is absent from the pane. */
  function noPartnerStrings(pane: HTMLElement): void {
    const text = pane.textContent ?? "";
    const html = pane.innerHTML;
    for (const partner of [...P2_PICKS, RIBEYE, SALMON]) {
      expect(text).not.toContain(partner["name"] as string);
      expect(html).not.toContain(partner["id"] as string);
    }
  }

  it("a non-player sees a cloche and counted secrets, no ingredient of either player", () => {
    const h = make();
    h.show(pickingView({ blind: true, you: null, turn: 3, showOptions: false, p1Picks: null, p1Count: 1, p2Picks: null, p2Count: 1 }));
    expect(q(h.pane, ".wx-srv-ck-cloche-text").textContent).toBe("🕵️ Secret turn: Josh is choosing…");
    noPartnerStrings(h.pane);
    expect(h.pane.textContent).not.toContain("Thick-cut white toast");
    expect(h.pane.querySelectorAll(".wx-srv-ck-chip-secret")).toHaveLength(2);
  });

  it("an abandoned Blind round never reveals the partner's picks", () => {
    const h = make();
    h.show({ ...pickingView({ blind: true, you: 1, turn: 5, p2Picks: null, p2Count: 2 }), state: "abandoned", current: null });
    expect(q(h.pane, ".wx-srv-ck-ended-text").textContent).toContain("ended");
    noPartnerStrings(h.pane);
  });

  it("waiting for Player 2 to join shows the waiting cloche and nothing of theirs", () => {
    const h = make();
    h.show(pickingView({ blind: true, you: 1, turn: 2, player2: null, showOptions: false, waitingForJoin: true, p2Picks: null }));
    expect(q(h.pane, ".wx-srv-ck-cloche-text").textContent).toBe("Waiting for Cupcake to join…");
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Waiting for Cupcake to join — Pick 1 of 5");
    noPartnerStrings(h.pane);
  });

  it("the slots still to fill are one '… to go' pill, never a row of lone empty slots", () => {
    const h = make();
    h.show(pickingView({ blind: true, you: 1, turn: 4, showOptions: false, p2Picks: null, p2Count: 1 }));
    const rows = [...h.pane.querySelectorAll(".wx-srv-ck-tray-row")];
    expect(rows.map((r) => [...r.querySelectorAll(".wx-srv-ck-chip-empty")].map((e) => e.textContent))).toEqual([["3 to go"], ["4 to go"]]);
  });
});

describe("timers end with the round", () => {
  it("a lock or wipe (the frame's reset) clears a pending move retry and the chef's clock", async () => {
    const h = make();
    h.show(pickingView({ turn: 1 }));
    h.api.pick.mockResolvedValue({ ok: false, kind: "unavailable" });
    q<HTMLButtonElement>(h.pane, '[data-ingredient="ribeye-steak"]').click();
    await flush(); // the first attempt failed: the retry is waiting on its timer
    expect(h.clock.timeouts.size).toBe(1);
    h.tabs.reset();
    expect(h.clock.timeouts.size).toBe(0);
    h.show(finishedView({ concepts: "pending", images: "none", rev: 30 }));
    expect(h.clock.intervals.size).toBe(1);
    h.tabs.reset();
    expect(h.clock.intervals.size).toBe(0);
  });

  it("the toast's timer goes with a reset too", async () => {
    const h = make();
    h.show(pickingView({ turn: 1 }));
    h.api.skip.mockResolvedValue({ ok: false, kind: "bad_state" });
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").click();
    await flush();
    expect(h.clock.timeouts.size).toBe(1);
    h.tabs.reset();
    expect(h.clock.timeouts.size).toBe(0);
  });
});

describe("the chef", () => {
  it("counts the time while the chef invents, and stops the clock when hidden", () => {
    const h = make();
    h.show(finishedView({ concepts: "pending", images: "none" }));
    expect(q(h.pane, ".wx-srv-ck-chef-text").textContent).toBe("Chef is inventing 3 dishes from your 10 ingredients…");
    expect(h.clock.intervals.size).toBe(1);
    h.clock.now += 42_000;
    [...h.clock.intervals.values()][0]?.();
    expect(q(h.pane, ".wx-srv-ck-elapsed").textContent).toBe("0:42");
    h.tabs.showTab("chat");
    expect(h.clock.intervals.size).toBe(0);
  });

  it("a failed chef offers Try again, which retries the concepts", async () => {
    const h = make();
    h.show(finishedView({ concepts: "failed", images: "none" }));
    h.api.retryConcepts.mockResolvedValue(ok(finishedView({ concepts: "pending", images: "none", rev: 13 })));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-retry").click();
    expect(h.api.retryConcepts).toHaveBeenCalledWith(41, 1);
    await flush();
    expect(h.pane.querySelector(".wx-srv-ck-chef-working")).not.toBeNull();
  });

  it("shows three dish cards; pictures fill in, a missing one shimmers while pending and offers Retry after", () => {
    const h = make();
    h.show(finishedView({ concepts: "ready", images: "pending", pictures: { a: picture(1) } }));
    const dishes = h.pane.querySelectorAll<HTMLElement>(".wx-srv-ck-dish");
    expect([...dishes].map((d) => d.dataset["concept"])).toEqual(["a", "b", "c"]);
    expect(q<HTMLImageElement>(dishes[0] as HTMLElement, ".wx-srv-ck-dish-img").getAttribute("src")).toBe(
      "/api/admin/server/media/thumb-1.jpg",
    );
    expect((dishes[1] as HTMLElement).querySelector(".wx-srv-ck-dish-pic-pending")).not.toBeNull();
    expect(q(dishes[0] as HTMLElement, ".wx-srv-ck-uses-count").textContent).toBe("Uses 8/10");
    expect(q(dishes[0] as HTMLElement, ".wx-srv-ck-uses-staples").textContent).toBe("Staples: salt, black pepper, butter");
    expect((dishes[0] as HTMLElement).querySelectorAll(".wx-srv-ck-omitted-line")).toHaveLength(2);
    // A tap on the photo opens the full-size picture.
    q<HTMLButtonElement>(dishes[0] as HTMLElement, ".wx-srv-ck-dish-photo").click();
    expect(h.openLightbox).toHaveBeenCalledWith("/api/admin/server/media/full-1.jpg", "Espresso-Glazed Ribeye over Crispy Toast");
    // A photo that will not load falls back to the plate.
    const img = q<HTMLImageElement>(dishes[0] as HTMLElement, ".wx-srv-ck-dish-img");
    img.dispatchEvent(new Event("error"));
    expect((dishes[0] as HTMLElement).querySelector(".wx-srv-ck-dish-plate")).not.toBeNull();
    expect((dishes[0] as HTMLElement).querySelector(".wx-srv-ck-dish-photo")).toBeNull();
    // Card a keeps its node when only another slot changes.
    const cardA = dishes[0];
    h.show(finishedView({ concepts: "ready", images: "failed", pictures: { a: picture(1), b: picture(2) }, rev: 13 }));
    expect(h.pane.querySelector('.wx-srv-ck-dish[data-concept="a"]')).toBe(cardA);
    const cardC = q(h.pane, '.wx-srv-ck-dish[data-concept="c"]');
    h.api.retryPictures.mockResolvedValue(ok(finishedView({ concepts: "ready", images: "pending", rev: 14 })));
    q<HTMLButtonElement>(cardC, ".wx-srv-ck-dish-retry").click();
    expect(h.api.retryPictures).toHaveBeenCalledWith(41, 1);
  });

  it("Bank this → Writing recipe… → Banked ✓, each dish on its own, then the full recipe", async () => {
    const h = make();
    h.show(finishedView({ concepts: "ready", images: "done", pictures: { a: picture(1), b: picture(2), c: picture(3) } }));
    const card = (id: string) => q(h.pane, `.wx-srv-ck-dish[data-concept="${id}"]`);
    expect(q(card("a"), ".wx-srv-ck-bank").textContent).toBe("Bank this ✓");
    const pendingA = finishedView({ concepts: "ready", images: "done", rev: 14 });
    ((pendingA["recipes"] as Json)["a"] as Json)["state"] = "pending";
    h.api.bank.mockResolvedValue(ok(pendingA));
    q<HTMLButtonElement>(card("a"), ".wx-srv-ck-bank").click();
    expect(h.api.bank).toHaveBeenCalledWith(41, "a", "move-1", 1);
    expect(q(card("a"), ".wx-srv-ck-bank").textContent).toBe("Saving…");
    await flush();
    expect(q(card("a"), ".wx-srv-ck-writing").textContent).toBe("Writing recipe…");
    // The other dishes are still bankable on their own.
    expect(q(card("b"), ".wx-srv-ck-bank").textContent).toBe("Bank this ✓");
    // The recipe arrives.
    h.show(finishedView({ concepts: "ready", images: "done", recipes: bankedRecipes("a"), rev: 15 }));
    const banked = q<HTMLButtonElement>(card("a"), ".wx-srv-ck-banked");
    expect(banked.textContent).toBe("Banked ✓ — View full recipe");
    expect(card("a").querySelector(".wx-srv-ck-recipe")).toBeNull();
    banked.click();
    const recipe = q(card("a"), ".wx-srv-ck-recipe");
    expect([...recipe.querySelectorAll(".wx-srv-ck-fact-value")].map((n) => n.textContent)).toEqual(["2", "15 min", "20 min", "35 min"]);
    const ingredients = [...recipe.querySelectorAll(".wx-srv-ck-recipe-ing-name")].map((n) => n.textContent);
    expect(ingredients).toEqual(["Ribeye steak", "Thick-cut white toast", "Butter"]);
    expect(recipe.querySelectorAll(".wx-srv-ck-recipe-step")).toHaveLength((FULL_RECIPE["steps"] as unknown[]).length);
    expect(recipe.querySelectorAll(".wx-srv-ck-recipe-tip")).toHaveLength(1);
    // Ticking an ingredient off survives a refresh.
    const tick = q<HTMLInputElement>(recipe, ".wx-srv-ck-recipe-check");
    tick.checked = true;
    tick.dispatchEvent(new Event("change"));
    const banked2 = bankedRecipes("a");
    ((banked2["b"] as Json) ?? {})["state"] = "pending";
    h.show(finishedView({ concepts: "ready", images: "done", recipes: banked2, rev: 16 }));
    expect(q<HTMLInputElement>(card("a"), ".wx-srv-ck-recipe-check").checked).toBe(true);
  });

  it("a recipe that did not finish offers Try again for that dish", async () => {
    const h = make();
    const recipes = bankedRecipes("a");
    recipes["c"] = { state: "failed", requestedBy: "Josh", bankedAt: null, error: "timeout", data: null };
    h.show(finishedView({ concepts: "ready", images: "done", recipes }));
    const retry = q<HTMLButtonElement>(h.pane, '.wx-srv-ck-dish[data-concept="c"] .wx-srv-ck-recipe-retry');
    expect(retry.textContent).toBe("Recipe didn't finish — Try again");
    h.api.retryRecipe.mockResolvedValue(ok(finishedView({ concepts: "ready", images: "done", rev: 13 })));
    retry.click();
    expect(h.api.retryRecipe).toHaveBeenCalledWith(41, "c", 1);
  });

  it("a banked recipe the client cannot read says so instead of offering a retry the server would refuse", () => {
    const h = make();
    const recipes = bankedRecipes("a");
    (recipes["a"] as Json)["data"] = { serves: 2 };
    h.show(finishedView({ concepts: "ready", images: "done", recipes }));
    const card = q(h.pane, '.wx-srv-ck-dish[data-concept="a"]');
    expect(card.querySelector(".wx-srv-ck-recipe-retry")).toBeNull();
    q<HTMLButtonElement>(card, ".wx-srv-ck-banked").click();
    expect(q(h.pane, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-recipe-missing').textContent).toBe(
      "This recipe is saved but can't be shown right now.",
    );
  });

  it("a Recipe-book jump belongs to its round: another round drawn first is not expanded", () => {
    const h = make();
    h.game.openRecipe(77, "a"); // round 77's view has not arrived yet
    h.show(finishedView({ seq: 41, concepts: "ready", images: "done", recipes: bankedRecipes("a") }));
    expect(h.pane.querySelector(".wx-srv-ck-recipe")).toBeNull();
  });

  it("the Recipe book's tap opens the round straight at that dish's full recipe", () => {
    const h = make();
    h.model.apply(v(finishedView({ concepts: "ready", images: "done", recipes: bankedRecipes("b") })));
    h.game.openRecipe(41, "b");
    expect(h.tabs.activeTab()).toBe("cookout");
    expect(h.pane.querySelector('.wx-srv-ck-dish[data-concept="b"] .wx-srv-ck-recipe')).not.toBeNull();
    expect(h.pane.querySelector('.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-recipe')).toBeNull();
  });
});

describe("the header", () => {
  it("End game asks first, then ends the round", async () => {
    const h = make();
    h.show(pickingView());
    expect(visible(h.pane, ".wx-srv-ck-end")).toBe(true);
    expect(visible(h.pane, ".wx-srv-ck-new")).toBe(false);
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-end").click();
    expect(visible(h.pane, ".wx-srv-ck-confirm")).toBe(true);
    h.api.abandon.mockResolvedValue(ok({ ...pickingView({ rev: 9 }), state: "abandoned", current: null }));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-confirm-end").click();
    expect(h.api.abandon).toHaveBeenCalledWith(41);
    await flush();
    expect(q(h.pane, ".wx-srv-ck-ended-text").textContent).toContain("ended");
    expect(visible(h.pane, ".wx-srv-ck-new")).toBe(true);
    expect(visible(h.pane, ".wx-srv-ck-end")).toBe(false);
  });

  it("a non-player sees no End game; the Recipe book button opens the book", () => {
    const h = make();
    h.show(pickingView({ you: null }));
    expect(visible(h.pane, ".wx-srv-ck-end")).toBe(false);
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-book").click();
    expect(h.openBook).toHaveBeenCalled();
  });

  it("every control is a gesture boundary, and the pane holds no idle-lock suspension hook at all", () => {
    const h = make();
    h.show(finishedView({ concepts: "ready", images: "failed", recipes: bankedRecipes("a") }));
    for (const b of h.pane.querySelectorAll("button")) expect(b.hasAttribute("data-srv-gesture-boundary")).toBe(true);
  });

  it("closing the tab forgets the round", () => {
    const h = make();
    h.show(pickingView());
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-close").click();
    expect(h.tabs.seqOf("cookout")).toBeNull();
    expect(h.pane.hidden).toBe(true);
    expect(h.pane.querySelector(".wx-srv-ck-opt")).toBeNull();
  });
});
