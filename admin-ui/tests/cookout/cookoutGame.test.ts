import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import { ServerLockedError } from "../../src/server/api/http";
import { createGameTabs, type GameTabs } from "../../src/server/gameTabs";
import type { ItemChat } from "../../src/server/itemChat";
import { createGameFloat } from "../../src/server/gameFloat";
import { parseCookoutView, type CookoutOutcome, type CookoutView } from "../../src/server/cookout/api";
import {
  categoryName,
  createCookoutGame,
  formatElapsed,
  roleShort,
  skipLabel,
  turnBanner,
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
  P1_PICKS,
  P2_PICKS,
  imageUrl,
  imaged,
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
    float: createGameFloat({
      document,
      win: window,
      itemChat,
      tabs,
      mountComposer: () => {},
      isRecording: () => false,
      tabBar: tabs.tabBar,
      host: document.body,
    }),
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
    expect(skipLabel(0)).toBe("Deal two new ones (2 left)");
    expect(skipLabel(1)).toBe("Deal two new ones (1 left)");
    expect(skipLabel(2)).toBe("Final pair");
    expect(roleShort("protein")).toBe("🍗 protein");
    expect(roleShort(null)).toBe("");
  });

  it("the turn banner names the pick and the go, or who is being waited for", () => {
    expect(turnBanner(v(pickingView({ turn: 3, offerIndex: 0 })), "Cupcake")).toEqual({
      line1: "Your turn — tap the one you want",
      line2: "Pick 2 of 5 · 🍗 protein · 2 new pairs left",
      join: false,
      mine: true,
    });
    expect(turnBanner(v(pickingView({ turn: 3, offerIndex: 2, options: [LENTILS, SALMON] })), "Cupcake").line2).toBe(
      "Pick 2 of 5 · 🍗 protein · final pair",
    );
    expect(turnBanner(v(pickingView({ turn: 4, you: 1, showOptions: false, blind: true, p2Picks: null, p2Count: 1 })), null)).toMatchObject({
      line1: "Cupcake is choosing…",
      line2: "Secret pick · Pick 2 of 5",
      mine: false,
    });
    expect(turnBanner(v(pickingView({ turn: 4, you: 1 })), null)).toMatchObject({
      line1: "Cupcake is choosing…",
      line2: "Pick 2 of 5 · 🍗 protein",
    });
    expect(turnBanner(v(pickingView({ turn: 2, player2: null, showOptions: false, waitingForJoin: true })), "Cupcake")).toMatchObject({
      line1: "Waiting for Cupcake to join",
      join: false,
    });
  });

  it("the banner offers Join to the joiner, and writes a long partner name as 'your partner'", () => {
    expect(turnBanner(v(pickingView({ turn: 2, you: null, player2: null, showOptions: false, waitingForJoin: true })), "Cupcake")).toMatchObject({
      line1: "Join to take your turn",
      join: true,
    });
    expect(turnBanner(v(pickingView({ turn: 2, player2: null, showOptions: false, waitingForJoin: true })), "Bartholomew-Maximilian")).toMatchObject({
      line1: "Waiting for your partner to join",
    });
    const long = pickingView({ turn: 4, you: 1 });
    ((long["players"] as Json[])[1] as Json)["name"] = "Bartholomew-Maximilian";
    expect(turnBanner(v(long), null).line1).toBe("Your partner is choosing…");
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
    await flush(); // the twist options are read before Start is live
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

  it("is one radio group: arrows move the choice, only the chosen mode is a tab stop, and Tab stays inside", async () => {
    const sheet = createCookoutStartSheet({ document, ...SHEET_DEPS, start: vi.fn(async () => {}), newId: ids() });
    document.body.append(sheet.element);
    sheet.open();
    await flush(); // the twist options are read before Start is live
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

  it("opens with the given mode preselected (New in the pane), and Cancel closes it", async () => {
    const sheet = createCookoutStartSheet({ document, ...SHEET_DEPS, start: vi.fn(async () => {}), newId: ids() });
    sheet.open({ blind: true });
    await flush(); // the twist options are read before Start is live
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
    await flush(); // the twist options are read before Start is live
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
    await flush(); // the twist options are read before Start is live
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
    await flush(); // the twist options are read before Start is live
    go.click();
    await flush();
    expect(start.mock.calls.map((call: unknown[]) => [(call[0] as StartChoices).blind, call[1]])).toEqual([
      [false, "start-1"],
      [false, "start-1"],
      [true, "start-2"],
      [false, "start-3"],
    ]);
  });

  it("opening again while a start is in flight changes nothing (no second Start beside it)", async () => {
    const start = vi.fn(() => new Promise<void>(() => {}));
    const sheet = createCookoutStartSheet({ document, ...SHEET_DEPS, start, newId: ids() });
    sheet.open({ blind: true });
    await flush(); // the twist options are read before Start is live
    q<HTMLButtonElement>(sheet.element, ".wx-srv-ck-start-go").click();
    sheet.open({ blind: false });
    await flush(); // the twist options are read before Start is live
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
  it("shows a Join button in the banner to a viewer who is not Player 1 while Slot 2 is free, and joins", async () => {
    const h = make();
    h.show(pickingView({ you: null, player2: null, turn: 2, showOptions: false, waitingForJoin: true }));
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Join to take your turn");
    const join = q<HTMLButtonElement>(q(h.pane, ".wx-srv-ck-banner"), ".wx-srv-ck-join");
    expect(join.textContent).toBe("Join");
    h.api.join.mockResolvedValue(ok(pickingView({ you: 2, rev: 4, turn: 2 })));
    join.click();
    expect(h.api.join).toHaveBeenCalledWith(41);
    await flush();
    expect(h.pane.querySelector(".wx-srv-ck-join")).toBeNull();
  });

  it("never shows Join to Player 1, nor once Slot 2 is bound", () => {
    const h = make();
    h.show(pickingView({ you: 1, player2: null }));
    expect(h.pane.querySelector(".wx-srv-ck-join")).toBeNull();
    h.show(pickingView({ you: 1, player2: null, turn: 2, showOptions: false, waitingForJoin: true, rev: 4 }));
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Waiting for Cupcake to join");
    expect(h.pane.querySelector(".wx-srv-ck-join")).toBeNull();
    h.show(pickingView({ you: null, rev: 5 }));
    expect(h.pane.querySelector(".wx-srv-ck-join")).toBeNull();
  });
});

describe("the draft: two cards, two skips", () => {
  it("shows the two ingredient picture cards (emoji fallback, name, what-line), the banner and the first skip", () => {
    const h = make();
    h.show(pickingView({ turn: 1, offerIndex: 0 }));
    const stage = q(h.pane, ".wx-srv-ck-table-stage");
    const cards = stage.querySelectorAll<HTMLButtonElement>("button.wx-srv-ck-card");
    expect([...cards].map((c) => c.dataset["ingredient"])).toEqual(["ribeye-steak", "salmon-fillet"]);
    expect(cards[0]?.getAttribute("aria-label")).toBe("Pick Ribeye steak");
    // No picture in the fixture: the tile falls back on the ingredient's emoji, in the same box.
    expect(q(cards[0] as HTMLElement, ".wx-srv-ck-pic .wx-srv-ck-pic-emoji").textContent).toBe("🥩");
    expect(q(cards[0] as HTMLElement, ".wx-srv-ck-card-name").textContent).toBe("Ribeye steak");
    // The blurb is short enough to show whole; there is no category label on a card any more.
    expect(q(cards[0] as HTMLElement, ".wx-srv-ck-card-what").textContent).toBe("Richly marbled and full of flavour.");
    expect(h.pane.querySelector(".wx-srv-ck-opt-cat")).toBeNull();
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Your turn — tap the one you want");
    expect(q(h.pane, ".wx-srv-ck-turn-sub").textContent).toBe("Pick 1 of 5 · 🍗 protein · 2 new pairs left");
    expect(q(h.pane, ".wx-srv-ck-skip").textContent).toBe("Deal two new ones (2 left)");
    // Nothing needs a twist, so there is no 🎲 button.
    expect(h.pane.querySelector(".wx-srv-ck-twists-btn")).toBeNull();
  });

  it("the second pair offers the last skip, the third pair's skip is the disabled 'Final pair'", () => {
    const h = make();
    h.show(pickingView({ offerIndex: 1, options: [LENTILS, SALMON] }));
    expect(q(h.pane, ".wx-srv-ck-skip").textContent).toBe("Deal two new ones (1 left)");
    expect(q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").disabled).toBe(false);
    h.show(pickingView({ offerIndex: 2, options: [LENTILS, SALMON], rev: 9 }));
    const skip = q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip");
    expect(skip.textContent).toBe("Final pair");
    expect(skip.disabled).toBe(true);
    expect(skip.classList.contains("wx-srv-ck-skip-final")).toBe(true);
  });

  it("a skip sends the turn, the offer and the pair on screen with a fresh move id", async () => {
    const h = make();
    h.show(pickingView({ turn: 3, offerIndex: 1, options: [LENTILS, SALMON] }));
    h.api.skip.mockResolvedValue(ok(pickingView({ turn: 3, offerIndex: 2, options: [RIBEYE, SALMON], rev: 9 })));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").click();
    expect(h.api.skip).toHaveBeenCalledWith(41, { moveId: "move-1", turn: 3, offer: 1, optionIds: [LENTILS.id, SALMON.id] });
    expect(q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").disabled).toBe(true);
    await flush();
    expect(q(h.pane, ".wx-srv-ck-skip").classList.contains("wx-srv-ck-skip-final")).toBe(true);
    expect(q(h.pane, ".wx-srv-ck-skip").textContent).toBe("Final pair");
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
    // ONE tap picks: the tapped card says "Picking…", the other is dimmed, both are disabled.
    expect(q(h.pane, '[data-ingredient="ribeye-steak"]').classList.contains("wx-srv-ck-card-chosen")).toBe(true);
    expect(q(h.pane, '[data-ingredient="ribeye-steak"] .wx-srv-ck-card-busy').textContent).toBe("Picking…");
    expect(q(h.pane, '[data-ingredient="salmon-fillet"]').classList.contains("wx-srv-ck-card-dim")).toBe(true);
    expect(h.pane.querySelectorAll("button.wx-srv-ck-card:disabled")).toHaveLength(2);
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
    expect(h.pane.querySelectorAll("button.wx-srv-ck-card")).toHaveLength(0);
    expect(h.pane.querySelectorAll("div.wx-srv-ck-card")).toHaveLength(2);
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Josh is choosing…");
    expect(q(h.pane, ".wx-srv-ck-turn-sub").textContent).toBe("Pick 2 of 5 · 🍗 protein");
    expect(h.pane.querySelector(".wx-srv-ck-skip")).toBeNull();
  });
});

describe("Blind mode", () => {
  it("shows the covered cloche on the partner's turn, with no ingredient string of theirs anywhere", () => {
    const h = make();
    // The view carries what the server sends Player 1 on Player 2's turn: no pair, no role, no picks.
    // The viewer's own two picks carry pictures (hash "a"); nothing of the partner's has a picture here.
    const mine = P1_PICKS.slice(0, 2).map((s) => imaged(s, "a"));
    h.show(pickingView({ blind: true, you: 1, turn: 4, showOptions: false, p1Picks: mine, p2Picks: null, p2Count: 1 }));
    expect(q(h.pane, ".wx-srv-ck-cloche-text").textContent).toBe("🕵️ Secret turn: Cupcake is choosing…");
    expect(q(h.pane, ".wx-srv-ck-badge").textContent).toBe("Blind");
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Cupcake is choosing…");
    expect(q(h.pane, ".wx-srv-ck-turn-sub").textContent).toBe("Secret pick · Pick 2 of 5");
    const text = h.pane.textContent ?? "";
    const html = h.pane.innerHTML;
    for (const partner of [...P2_PICKS, RIBEYE, SALMON]) {
      expect(text).not.toContain(partner["name"] as string);
      expect(html).not.toContain(partner["id"] as string);
    }
    expect(html).toContain(imageUrl("a")); // the viewer's own pictures do draw...
    expect(html).not.toContain(imageUrl("b")); // ...and no partner picture is anywhere
    expect(text).not.toContain("protein");
    // The partner's pick is one counted secret (a lock tile in the progress button), never a name.
    expect(h.pane.querySelectorAll(".wx-srv-ck-prog-secret")).toHaveLength(1);
    expect(h.pane.querySelectorAll('.wx-srv-ck-prog-group[data-slot="1"] .wx-srv-ck-prog-full')).toHaveLength(2);
    expect(h.pane.querySelector(".wx-srv-ck-card")).toBeNull();
    // The basket sheet says the same: "Secret pick", and still nothing of theirs.
    q<HTMLButtonElement>(h.pane, "button.wx-srv-ck-progress").click();
    const sheet = q(h.pane, '.wx-srv-ck-sheet[data-sheet="basket"]');
    expect(sheet.querySelectorAll('.wx-srv-ck-bgroup[data-slot="2"] .wx-srv-ck-bline-secret')).toHaveLength(1);
    expect(q(sheet, ".wx-srv-ck-bline-secret .wx-srv-ck-bline-name").textContent).toBe("Secret pick");
    for (const partner of [...P2_PICKS, RIBEYE, SALMON]) {
      expect(sheet.textContent).not.toContain(partner["name"] as string);
      expect(sheet.innerHTML).not.toContain(partner["id"] as string);
    }
  });

  it("the ten picks are revealed together when the round finishes, flipping open once", () => {
    const h = make();
    h.show(pickingView({ blind: true, you: 1, turn: 10, showOptions: false, p2Picks: null, p2Count: 4 }));
    h.show(finishedView({ blind: true, concepts: "pending", images: "none", rev: 20 }));
    const chips = h.pane.querySelectorAll(".wx-srv-ck-rtile");
    expect(chips).toHaveLength(10);
    expect([...chips].every((c) => c.classList.contains("wx-srv-ck-flip"))).toBe(true);
    // The fixture picks carry no turn, so they all land in the one "Extras" group.
    expect(h.pane.querySelectorAll(".wx-srv-ck-rgroup[data-group]")).toHaveLength(1);
    expect(q(h.pane, ".wx-srv-ck-reveal-title").textContent).toContain("The big reveal");
    expect(q(h.pane, '.wx-srv-ck-rtile[data-picked="ribeye-steak"] .wx-srv-ck-rtile-name').textContent).toBe("Ribeye steak");
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
    expect(h.pane.querySelectorAll(".wx-srv-ck-prog-secret")).toHaveLength(2);
    expect(h.pane.querySelector(".wx-srv-ck-card")).toBeNull();
    expect(h.pane.innerHTML).not.toContain("/admin/cookout-img/");
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
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Waiting for Cupcake to join");
    expect(q(h.pane, ".wx-srv-ck-turn-sub").textContent).toBe("Pick 1 of 5 is theirs");
    noPartnerStrings(h.pane);
  });

  it("the slots still to fill are one '… to go' line per player in the basket sheet, never a row of lone empty lines", () => {
    const h = make();
    h.show(pickingView({ blind: true, you: 1, turn: 4, showOptions: false, p2Picks: null, p2Count: 1 }));
    q<HTMLButtonElement>(h.pane, "button.wx-srv-ck-progress").click();
    const groups = [...h.pane.querySelectorAll('.wx-srv-ck-sheet[data-sheet="basket"] .wx-srv-ck-bgroup')];
    expect(groups.map((g) => [...g.querySelectorAll(".wx-srv-ck-bline-left")].map((e) => e.textContent))).toEqual([["3 to go"], ["4 to go"]]);
    // Player 2's one pick is a counted secret; the empty slots are not lines of their own.
    expect(groups.map((g) => g.querySelectorAll(".wx-srv-ck-bline").length)).toEqual([2, 1]);
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
    expect(h.pane.querySelector(".wx-srv-ck-card")).toBeNull();
  });
});
