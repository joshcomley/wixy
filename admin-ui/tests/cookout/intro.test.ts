import { beforeEach, describe, expect, it } from "vitest";
import { createIntro, INTRO_KEY_PREFIX, introWords } from "../../src/server/cookout/intro";
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
