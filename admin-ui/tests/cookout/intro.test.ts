import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLASSIC_OPTION, type ModeOption } from "../../src/server/cookout/api";
import { createIntro, fallbackModeIntro, INTRO_KEY_PREFIX, introWords } from "../../src/server/cookout/intro";
import { TOASTIE_MODE, classicOptionWire, toastieOption, toastieOptions, toastiePicking } from "./modeFixtures";
import { CHALLENGE_PAN, makeHarness, q, setup, STYLE_COSY, twistPicking, v, visible } from "./twistFixtures";
import { pickingView } from "./fixtures";

// spec/server-chat/09b-cookout-visual.md §D.2: a light intro over the pane, shown the first time THIS device
// opens THIS round while it is being picked; reopenable from `?`; dismissed by "Let's cook" or the backdrop.
// Seen-flags live in storage (`wx-srv-ck-intro:<seq>`), every read and write guarded, with an in-memory set
// when storage is missing or throws.

function fakeStorage(): { store: Map<string, string>; storage: Pick<Storage, "getItem" | "setItem"> } {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("the intro's words", () => {
  it("Open mode: non-blind, turns, the deal, seeing each other's picks, the chef", () => {
    const words = introWords(v(pickingView()));
    expect(words.title).toBe("Cookout");
    expect(words.lines).toEqual([
      "You're playing non-blind mode.",
      "You take turns choosing ingredients — 5 each, 10 in the basket.",
      "Each turn, tap the one you want. Don't fancy either? Deal two new ones (up to twice).",
      "You'll see each other's picks as you go.",
      "Then the chef invents three dishes from your basket.",
    ]);
    expect(words.twists).toBeNull();
  });

  it("Blind mode swaps the mode line and the secrecy line", () => {
    const words = introWords(v(pickingView({ blind: true })));
    expect(words.lines[0]).toBe("You're playing blind mode.");
    expect(words.lines).toContain("Your picks are secret — the basket is revealed when all ten are in.");
    expect(words.lines).not.toContain("You'll see each other's picks as you go.");
  });

  it("lists the start-sheet twists, one short phrase each", () => {
    const raw = twistPicking({}, { setup: setup({ style: STYLE_COSY, styleSpun: true, challenge: CHALLENGE_PAN, stars: true, wildcard: true, fridgeRaid: true }) });
    expect(introWords(v(raw)).twists).toBe(
      "Twists on: 🎡 Cosy pub style · 🍳 One pan only · ⭐ secret stars · 🛎️ a mystery 11th ingredient · 🧊 starts with your fridge pick",
    );
    const chosen = twistPicking({}, { setup: setup({ style: STYLE_COSY }) });
    expect(introWords(v(chosen)).twists).toBe("Twists on: 🍺 Cosy pub style");
  });
});

describe("the intro card", () => {
  it("is new once per round per device, then remembered in storage", () => {
    const { store, storage } = fakeStorage();
    const intro = createIntro({ document, storage: () => storage, onChange: () => {} });
    const view = v(pickingView({ seq: 41 }));
    expect(intro.isNew(41)).toBe(true);
    intro.open(view);
    expect(intro.isOpen()).toBe(true);
    expect(store.get(`${INTRO_KEY_PREFIX}41`)).toBe("1");
    expect(intro.isNew(41)).toBe(false);
    expect(intro.isNew(42)).toBe(true);
    // A fresh page on the same device still knows.
    const again = createIntro({ document, storage: () => storage, onChange: () => {} });
    expect(again.isNew(41)).toBe(false);
  });

  it("storage that throws falls back to an in-memory set for the page's life", () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      },
    };
    const intro = createIntro({ document, storage: () => throwing, onChange: () => {} });
    expect(intro.isNew(41)).toBe(true);
    intro.open(v(pickingView({ seq: 41 })));
    expect(intro.isNew(41)).toBe(false);
    const missing = createIntro({
      document,
      storage: () => {
        throw new Error("no storage at all");
      },
      onChange: () => {},
    });
    expect(missing.isNew(7)).toBe(true);
    missing.open(v(pickingView({ seq: 7 })));
    expect(missing.isNew(7)).toBe(false);
  });

  it("Let's cook and the backdrop both dismiss it", () => {
    const { storage } = fakeStorage();
    const intro = createIntro({ document, storage: () => storage, onChange: () => {} });
    document.body.append(intro.element);
    intro.open(v(pickingView()));
    q<HTMLButtonElement>(intro.element, ".wx-srv-ck-intro-go").click();
    expect(intro.isOpen()).toBe(false);
    intro.open(v(pickingView()));
    q(intro.element, ".wx-srv-ck-intro-backdrop").click();
    expect(intro.isOpen()).toBe(false);
  });
});

describe("the intro in the pane", () => {
  it("shows on the first open of a picking round, not again, and `?` reopens it", () => {
    const h = makeHarness();
    h.show(pickingView({ seq: 41 }));
    expect(visible(h.pane, ".wx-srv-ck-intro")).toBe(true);
    expect(q(h.pane, ".wx-srv-ck-intro-lines").textContent).toContain("non-blind mode");
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-intro-go").click();
    expect(visible(h.pane, ".wx-srv-ck-intro")).toBe(false);
    // A later view of the same round does not bring it back.
    h.show(pickingView({ seq: 41, turn: 2 }));
    expect(visible(h.pane, ".wx-srv-ck-intro")).toBe(false);
    // `?` in the title row does.
    const help = q<HTMLButtonElement>(h.pane, ".wx-srv-ck-help");
    expect(help.hidden).toBe(false);
    help.click();
    expect(visible(h.pane, ".wx-srv-ck-intro")).toBe(true);
  });

  it("the joining player gets it too, and a finished round never shows it", () => {
    const h = makeHarness();
    h.show(pickingView({ seq: 50, you: null, turn: 2, player2: null, showOptions: false, waitingForJoin: true }));
    expect(visible(h.pane, ".wx-srv-ck-intro")).toBe(true);
    const h2 = makeHarness();
    window.localStorage.clear();
    h2.show({ ...pickingView({ seq: 60 }), state: "finished", current: null });
    expect(visible(h2.pane, ".wx-srv-ck-intro")).toBe(false);
    expect(q<HTMLButtonElement>(h2.pane, ".wx-srv-ck-help").hidden).toBe(true);
  });
});

// -- Game modes (spec/server-chat/09c-cookout-modes.md §6.2) -------------------------------------------------------

describe("the intro's words in a Toasted sandwich round", () => {
  const NO_HINT = "Each turn, tap the one you want. Don't fancy either? Deal two new ones (up to twice).";

  it("Open play, as the starter: the mode's lines first, then Open, the deal, seeing each other's picks, the chef", () => {
    const words = introWords(v(toastiePicking({ turn: 1, you: 1 })));
    expect(words.title).toBe("Cookout");
    expect(words.lines).toEqual([
      "You're making a toasted sandwich.",
      "You're playing non-blind mode.",
      "You pick the bread first, then you take turns adding fillings — 4 picks each.",
      NO_HINT,
      "You'll see each other's picks as you go.",
      "The chef makes three toasted sandwiches with your bread.",
    ]);
    expect(words.twists).toBeNull();
  });

  it("names the starter for the other player, and for a watcher", () => {
    expect(introWords(v(toastiePicking({ turn: 1, you: 2 }))).lines[2]).toBe("Josh picks the bread first, then you take turns adding fillings — 4 picks each.");
    expect(introWords(v(toastiePicking({ turn: 1, you: null }))).lines[2]).toBe("Josh picks the bread first, then you take turns adding fillings — 4 picks each.");
  });

  it("Blind play swaps the Open line and the secrecy line (\"…revealed when all eight are in\")", () => {
    const words = introWords(v(toastiePicking({ turn: 1, you: 1, blind: true })));
    expect(words.lines[1]).toBe("You're playing blind mode.");
    expect(words.lines).toContain("Your picks are secret — the toasted sandwich is revealed when all eight are in.");
    expect(words.lines).not.toContain("You'll see each other's picks as you go.");
    expect(words.lines).not.toContain("Your picks are secret — the basket is revealed when all ten are in.");
  });

  it("uses the options' own lines for the round's mode, with {starter} filled in", () => {
    const option = toastiePickingOption(["Bread, then fillings.", "{starter} chooses the bread, then you add four fillings each.", "Three toasties come out."]);
    const words = introWords(v(toastiePicking({ turn: 1, you: 2 })), option);
    expect(words.lines).toEqual([
      "Bread, then fillings.",
      "You're playing non-blind mode.",
      "Josh chooses the bread, then you add four fillings each.",
      NO_HINT,
      "You'll see each other's picks as you go.",
      "Three toasties come out.",
    ]);
    // The starter themselves is "you", with the verb agreeing.
    expect(introWords(v(toastiePicking({ turn: 1, you: 1 })), option).lines[2]).toBe("You choose the bread, then you add four fillings each.");
  });

  it("copes with a mode that gives only one or two lines", () => {
    const one = introWords(v(toastiePicking()), toastiePickingOption(["Just the one."]));
    expect(one.lines).toEqual(["Just the one.", "You're playing non-blind mode.", NO_HINT, "You'll see each other's picks as you go."]);
    const two = introWords(v(toastiePicking()), toastiePickingOption(["First.", "Last."]));
    expect(two.lines).toEqual(["First.", "You're playing non-blind mode.", NO_HINT, "You'll see each other's picks as you go.", "Last."]);
  });

  it("ignores options for another mode, or with no lines (the lines built from the view are used)", () => {
    const fallback = introWords(v(toastiePicking())).lines;
    expect(introWords(v(toastiePicking()), toastiePickingOption([])).lines).toEqual(fallback);
    expect(introWords(v(toastiePicking()), { ...(toastiePickingOption(["Other."]) as ModeOption), id: "wrap" }).lines).toEqual(fallback);
    expect(introWords(v(toastiePicking()), CLASSIC_OPTION).lines).toEqual(fallback);
  });

  it("a Classic round is unchanged by any option it is handed", () => {
    const classic = introWords(v(pickingView())).lines;
    expect(introWords(v(pickingView()), toastiePickingOption(["Nope."])).lines).toEqual(classic);
    expect(classic).toHaveLength(5);
  });

  it("the twists line uses the mode's own count for the mystery ingredient", () => {
    const raw = toastiePicking({}, { setup: setup({ wildcard: true, fridgeRaid: true }) });
    expect(introWords(v(raw)).twists).toBe("Twists on: 🛎️ a mystery 9th ingredient · 🧊 starts with your fridge pick");
  });

  it("fallbackModeIntro is the three lines built from the view alone", () => {
    expect(fallbackModeIntro(v(toastiePicking()))).toEqual([
      "You're making a toasted sandwich.",
      "{starter} picks the bread first, then you take turns adding fillings — 4 picks each.",
      "The chef makes three toasted sandwiches with your bread.",
    ]);
    // A mode with no anchor takes turns from the start.
    const noAnchor = { ...toastiePicking({}), mode: { ...TOASTIE_MODE, anchorKind: null, label: "Pizza" } };
    expect(fallbackModeIntro(v(noAnchor))).toEqual(["You're making a pizza.", "You take turns choosing ingredients — 4 each, 8 in the basket.", "The chef makes three pizzas."]);
  });
});

/** The toasted sandwich as `GET /cookout/options` lists it, with these intro lines. */
function toastiePickingOption(intro: string[]): ModeOption {
  const option = toastieOptions([classicOptionWire(), toastieOption({ intro })]).modes[1];
  if (option === undefined) throw new Error("fixture");
  return option;
}

describe("the intro card in a Toasted sandwich round", () => {
  const lineTexts = (intro: { element: HTMLElement }): string[] => [...intro.element.querySelectorAll(".wx-srv-ck-intro-line")].map((n) => n.textContent ?? "");

  it("opens with the mode's emoji and the lines built from the view when no options are to hand", () => {
    const { storage } = fakeStorage();
    const intro = createIntro({ document, storage: () => storage, onChange: () => {} });
    intro.open(v(toastiePicking({ seq: 41, you: 1 })));
    expect(intro.element.querySelector(".wx-srv-ck-intro-icon")?.textContent).toBe("🥪");
    expect(lineTexts(intro)).toEqual(introWords(v(toastiePicking({ seq: 41, you: 1 }))).lines);
    const classic = createIntro({ document, storage: () => storage, onChange: () => {} });
    classic.open(v(pickingView({ seq: 42 })));
    expect(classic.element.querySelector(".wx-srv-ck-intro-icon")?.textContent).toBe("🍳");
  });

  it("asks modeOption for the round's mode id and uses what it answers", () => {
    const { storage } = fakeStorage();
    const modeOption = vi.fn((_id: string): ModeOption | null => toastiePickingOption(["From the options.", "{starter} leads.", "Done."]));
    const intro = createIntro({ document, storage: () => storage, onChange: () => {}, modeOption });
    intro.open(v(toastiePicking({ seq: 41, you: 2 })));
    expect(modeOption).toHaveBeenCalledWith("toastie");
    expect(lineTexts(intro)[0]).toBe("From the options.");
    expect(lineTexts(intro)[2]).toBe("Josh leads.");
  });

  it("a Classic round never asks, and a modeOption that throws or answers null keeps the lines from the view", () => {
    const { storage } = fakeStorage();
    const modeOption = vi.fn((): ModeOption | null => null);
    const classic = createIntro({ document, storage: () => storage, onChange: () => {}, modeOption });
    classic.open(v(pickingView({ seq: 42 })));
    expect(modeOption).not.toHaveBeenCalled();
    const fallback = introWords(v(toastiePicking({ seq: 41 }))).lines;
    const nothing = createIntro({ document, storage: () => storage, onChange: () => {}, modeOption });
    nothing.open(v(toastiePicking({ seq: 41 })));
    expect(lineTexts(nothing)).toEqual(fallback);
    const throwing = createIntro({
      document,
      storage: () => storage,
      onChange: () => {},
      modeOption: () => {
        throw new Error("boom");
      },
    });
    throwing.open(v(toastiePicking({ seq: 43 })));
    expect(lineTexts(throwing)).toEqual(fallback);
  });

  it("update() swaps the lines in when the options arrive, text only: heading and button stay the same nodes", () => {
    const { storage } = fakeStorage();
    let option: ModeOption | null = null;
    const onChange = vi.fn();
    const intro = createIntro({ document, storage: () => storage, onChange, modeOption: () => option });
    const view = v(toastiePicking({ seq: 41, you: 1 }));
    intro.open(view);
    const heading = intro.element.querySelector(".wx-srv-ck-intro-title");
    const go = intro.element.querySelector(".wx-srv-ck-intro-go");
    const before = lineTexts(intro);
    onChange.mockClear();
    // Nothing new yet: nothing redrawn.
    intro.update(view);
    expect(onChange).not.toHaveBeenCalled();
    option = toastiePickingOption(["Swapped first.", "{starter} swaps.", "Swapped last."]);
    intro.update(view);
    expect(lineTexts(intro)).toEqual(["Swapped first.", "You're playing non-blind mode.", "You swap.", NO_HINT_LINE, "You'll see each other's picks as you go.", "Swapped last."]);
    expect(lineTexts(intro)).not.toEqual(before);
    expect(intro.element.querySelector(".wx-srv-ck-intro-title")).toBe(heading);
    expect(intro.element.querySelector(".wx-srv-ck-intro-go")).toBe(go);
    expect(intro.element.querySelectorAll(".wx-srv-ck-intro-lines")).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    // The same lines again change nothing.
    intro.update(view);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("update() does nothing for a closed card or another round", () => {
    const { storage } = fakeStorage();
    let option: ModeOption | null = null;
    const intro = createIntro({ document, storage: () => storage, onChange: () => {}, modeOption: () => option });
    option = toastiePickingOption(["Late first.", "{starter} is late.", "Late last."]);
    intro.update(v(toastiePicking({ seq: 41 })));
    expect(intro.isOpen()).toBe(false);
    expect(intro.element.querySelectorAll(".wx-srv-ck-intro-line")).toHaveLength(0);
    option = null;
    intro.open(v(toastiePicking({ seq: 41 })));
    const before = lineTexts(intro);
    option = toastiePickingOption(["Late first.", "{starter} is late.", "Late last."]);
    intro.update(v(toastiePicking({ seq: 99 })));
    expect(lineTexts(intro)).toEqual(before);
    intro.close();
    intro.update(v(toastiePicking({ seq: 41 })));
    expect(intro.isOpen()).toBe(false);
  });
});

const NO_HINT_LINE = "Each turn, tap the one you want. Don't fancy either? Deal two new ones (up to twice).";
