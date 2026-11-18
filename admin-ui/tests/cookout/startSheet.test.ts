import { afterEach, describe, expect, it, vi } from "vitest";
import type { CookoutOptions, IngredientSnap, SearchResult } from "../../src/server/cookout/api";
import { CLASSIC_OPTION, parseSnap } from "../../src/server/cookout/api";
import { CookoutStartError, clocheHint, createCookoutStartSheet, encoreSeat, fridgeWords, type EncorePreset, type StartChoices, type StartPreset } from "../../src/server/cookout/startSheet";
import { PARSLEY } from "./fixtures";
import { HAM, PICKLES, SOURDOUGH, toastieOption, toastieOptions, type Json } from "./modeFixtures";
import { TOMATOES, flush, q, qa, visible } from "./twistFixtures";

// The start sheet's game modes (spec/server-chat/09c-cookout-modes.md §6.1): a "What are we making?" tile per
// listed mode (hidden while Classic is alone), Toasted sandwich wording for the fridge raid and the cloche, only
// the mode's own twists, "New" preselecting the round's mode, and an encore locking it.

function ingredient(raw: Json): IngredientSnap {
  const parsed = parseSnap(raw);
  if (parsed === null) throw new Error("fixture");
  return parsed;
}

const BOTH: CookoutOptions = toastieOptions();
const CLASSIC_ONLY: CookoutOptions = { ...BOTH, modes: [CLASSIC_OPTION] };

interface Timer {
  readonly cb: () => void;
  readonly ms: number;
}

interface Made {
  sheet: ReturnType<typeof createCookoutStartSheet>;
  start: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  loadOptions: ReturnType<typeof vi.fn>;
  timers: Map<number, Timer>;
  fire(): void;
  type(text: string): void;
  starts(): StartChoices[];
}

function make(
  options: CookoutOptions | null,
  startImpl: () => Promise<void> = async () => {},
  search: (q: string, mode: string) => Promise<SearchResult> = async () => ({ ok: true, ingredients: [] }),
  loadImpl: () => Promise<CookoutOptions | null> = async () => options,
): Made {
  const timers = new Map<number, Timer>();
  let nextTimer = 1;
  let nextId = 0;
  const start = vi.fn(startImpl);
  const searchFn = vi.fn(search);
  const loadOptions = vi.fn(loadImpl);
  const sheet = createCookoutStartSheet({
    document,
    start: start as unknown as (choices: StartChoices, clientId: string) => Promise<void>,
    loadOptions,
    search: searchFn as unknown as (q: string, mode: string) => Promise<SearchResult>,
    newId: () => `start-${++nextId}`,
    setTimeout: (cb, ms) => {
      const id = nextTimer++;
      timers.set(id, { cb, ms });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
  });
  document.body.append(sheet.element);
  return {
    sheet,
    start,
    search: searchFn,
    loadOptions,
    timers,
    fire() {
      const [id, timer] = [...timers.entries()][0] ?? [];
      if (id === undefined || timer === undefined) throw new Error("no pending timer");
      timers.delete(id);
      timer.cb();
    },
    type(text) {
      const input = q<HTMLInputElement>(sheet.element, ".wx-srv-ck-fridge-input");
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    starts: () => start.mock.calls.map((call: unknown[]) => call[0] as StartChoices),
  };
}

async function openWith(m: Made, preset?: StartPreset): Promise<void> {
  m.sheet.open(preset);
  await flush();
}

const go = (m: Made): HTMLButtonElement => q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-start-go");
const tile = (m: Made, id: string): HTMLButtonElement | null => m.sheet.element.querySelector<HTMLButtonElement>(`.wx-srv-ck-mtile[data-mode-id="${id}"]`);
const tileOf = (m: Made, id: string): HTMLButtonElement => {
  const found = tile(m, id);
  if (found === null) throw new Error(`no tile ${id}`);
  return found;
};

function expandTwists(m: Made): void {
  const toggle = q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-twists-toggle");
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
}

const hintOf = (m: Made, row: string): string => q(m.sheet.element, `.wx-srv-ck-twist-${row} .wx-srv-ck-twist-hint`).textContent ?? "";
const rowHidden = (m: Made, row: string): boolean => q(m.sheet.element, `.wx-srv-ck-twist-${row}`).hidden === true;

const ENCORE: EncorePreset = {
  fromSeq: 30,
  generation: 1,
  conceptId: "c",
  kind: "remix",
  title: "Skillet Ham & Cheddar Melt",
  // Each starter with its pick kind, as a mode round's Recipe book entry sends it (09c §2.5).
  candidates: [
    { ...ingredient(SOURDOUGH), kind: "bread" },
    { ...ingredient(HAM), kind: "main" },
    { ...ingredient(PICKLES), kind: "finish" },
  ],
  mode: "toastie",
};

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as { WIXY_COOKOUT_MODE_TILES?: unknown }).WIXY_COOKOUT_MODE_TILES;
});

describe("the mode tiles", () => {
  it("are hidden, and the sheet is as it was, while Classic is the only listed mode", async () => {
    const m = make(CLASSIC_ONLY);
    await openWith(m);
    expect(q(m.sheet.element, ".wx-srv-ck-start-what").hidden).toBe(true);
    expect(m.sheet.element.querySelectorAll(".wx-srv-ck-mtile")).toHaveLength(0);
    expect(q(m.sheet.element, "#wx-srv-ck-start-how").hidden).toBe(true);
    expect(q(m.sheet.element, ".wx-srv-ck-start-intro").textContent).toBe("Take turns picking 10 ingredients, then see what the chef invents.");
    // Failing to read the options at all is the same sheet.
    document.body.replaceChildren();
    const unread = make(null);
    await openWith(unread);
    expect(q(unread.sheet.element, ".wx-srv-ck-start-what").hidden).toBe(true);
    go(unread).click();
    await flush();
    expect(unread.starts()[0]).toMatchObject({ mode: "classic" });
  });

  it("show one radio tile per listed mode under \"What are we making?\", Classic checked by default", async () => {
    const m = make(BOTH);
    await openWith(m);
    expect(visible(m.sheet.element, ".wx-srv-ck-start-what")).toBe(true);
    expect(q(m.sheet.element, ".wx-srv-ck-start-what .wx-srv-ck-start-section").textContent).toBe("What are we making?");
    expect(q(m.sheet.element, "#wx-srv-ck-start-how").textContent).toBe("How do we play?");
    expect(q(m.sheet.element, ".wx-srv-ck-mtiles").getAttribute("role")).toBe("radiogroup");
    const tiles = qa<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-mtile");
    expect(tiles.map((t) => t.dataset["modeId"])).toEqual(["classic", "toastie"]);
    expect(tiles.map((t) => t.getAttribute("role"))).toEqual(["radio", "radio"]);
    expect(tiles.map((t) => t.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(tiles.map((t) => t.tabIndex)).toEqual([0, -1]);
    expect(tiles[1]?.querySelector(".wx-srv-ck-mtile-label")?.textContent).toBe("Toasted sandwich");
    expect(tiles[1]?.querySelector(".wx-srv-ck-mtile-blurb")?.textContent).toBe("Pick a bread and 7 fillings, get 3 toasties");
    expect(tiles[1]?.querySelector(".wx-srv-ck-mtile-emoji")?.textContent).toBe("🥪");
    expect(tiles.every((t) => !t.disabled)).toBe(true);
  });

  it("Start sends the chosen mode: classic by default, toastie once its tile is tapped", async () => {
    const classic = make(BOTH);
    await openWith(classic);
    go(classic).click();
    expect(classic.starts()[0]).toEqual({ mode: "classic", blind: false, style: null, challenge: null, wildcard: false, stars: false, fridgeSeedId: null, encore: null });
    await flush();
    document.body.replaceChildren();

    const m = make(BOTH);
    await openWith(m);
    tileOf(m, "toastie").click();
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
    expect(tileOf(m, "classic").getAttribute("aria-checked")).toBe("false");
    expect(q(m.sheet.element, ".wx-srv-ck-start-intro").textContent).toBe("Take turns picking 8 ingredients, then see what the chef invents.");
    go(m).click();
    expect(m.starts()[0]).toEqual({ mode: "toastie", blind: false, style: null, challenge: null, wildcard: false, stars: false, fridgeSeedId: null, encore: null });
  });

  it("the arrow keys move the choice and the focus between the tiles, wrapping round", async () => {
    const m = make(BOTH);
    await openWith(m);
    const key = (target: HTMLElement, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    key(tileOf(m, "classic"), "ArrowRight");
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(tileOf(m, "toastie"));
    expect(tileOf(m, "toastie").tabIndex).toBe(0);
    expect(tileOf(m, "classic").tabIndex).toBe(-1);
    key(tileOf(m, "toastie"), "ArrowRight");
    expect(tileOf(m, "classic").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(tileOf(m, "classic"));
    key(tileOf(m, "classic"), "ArrowLeft");
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
    key(tileOf(m, "toastie"), "ArrowUp");
    expect(tileOf(m, "classic").getAttribute("aria-checked")).toBe("true");
    key(tileOf(m, "classic"), "ArrowDown");
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
    // Other keys do nothing.
    key(tileOf(m, "toastie"), "a");
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "toastie" });
  });

  it("the Open / Blind choice is independent of the tile", async () => {
    const m = make(BOTH);
    await openWith(m);
    tileOf(m, "toastie").click();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-mode[data-mode="blind"]').click();
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "toastie", blind: true });
  });

  it("show the mode's picture, and fall back to its emoji when the picture fails", async () => {
    (globalThis as { WIXY_COOKOUT_MODE_TILES?: unknown }).WIXY_COOKOUT_MODE_TILES = { toastie: "/admin/cookout-mode-toastie.abc123.webp" };
    const m = make(BOTH);
    await openWith(m);
    // Classic has no picture in this build: its emoji.
    expect(tileOf(m, "classic").querySelector("img")).toBeNull();
    expect(tileOf(m, "classic").querySelector<HTMLElement>(".wx-srv-ck-mtile-emoji")?.hidden).toBe(false);
    const img = tileOf(m, "toastie").querySelector<HTMLImageElement>("img.wx-srv-ck-mtile-img");
    expect(img?.getAttribute("src")).toBe("/admin/cookout-mode-toastie.abc123.webp");
    expect(img?.alt).toBe("Toasted sandwich");
    expect(tileOf(m, "toastie").querySelector<HTMLElement>(".wx-srv-ck-mtile-emoji")?.hidden).toBe(true);
    img?.dispatchEvent(new Event("error"));
    expect(tileOf(m, "toastie").querySelector("img")).toBeNull();
    expect(tileOf(m, "toastie").querySelector<HTMLElement>(".wx-srv-ck-mtile-emoji")?.hidden).toBe(false);
  });

  it("have only the emoji when the build carries no pictures", async () => {
    const m = make(BOTH);
    await openWith(m);
    expect(m.sheet.element.querySelectorAll(".wx-srv-ck-mtile img")).toHaveLength(0);
    expect(tileOf(m, "toastie").querySelector<HTMLElement>(".wx-srv-ck-mtile-emoji")?.hidden).toBe(false);
  });
});

describe("the mode's words for the twists", () => {
  it("the fridge raid reads \"Start with a bread you have at home\" in Toasted sandwich mode, and Classic's own words otherwise", async () => {
    const m = make(BOTH);
    await openWith(m);
    expandTwists(m);
    expect(hintOf(m, "fridge")).toBe("Start with one thing you actually have at home tonight");
    expect(q<HTMLInputElement>(m.sheet.element, ".wx-srv-ck-fridge-input").placeholder).toBe("Search the pantry — e.g. tomatoes");
    tileOf(m, "toastie").click();
    expect(hintOf(m, "fridge")).toBe("Start with a bread you have at home");
    expect(q<HTMLInputElement>(m.sheet.element, ".wx-srv-ck-fridge-input").placeholder).toBe("Search for a bread — e.g. sourdough");
    tileOf(m, "classic").click();
    expect(hintOf(m, "fridge")).toBe("Start with one thing you actually have at home tonight");
  });

  it("the cloche row reads \"Lift a lid for a mystery 9th ingredient\" in Toasted sandwich mode", async () => {
    const m = make(BOTH);
    await openWith(m);
    expandTwists(m);
    expect(hintOf(m, "cloche")).toBe("Lift a lid for a surprise 11th ingredient");
    tileOf(m, "toastie").click();
    expect(hintOf(m, "cloche")).toBe("Lift a lid for a mystery 9th ingredient");
  });

  it("the word helpers", () => {
    const toastie = toastieOptions().modes[1];
    if (toastie === undefined) throw new Error("fixture");
    expect(clocheHint(toastie)).toBe("Lift a lid for a mystery 9th ingredient");
    expect(clocheHint(CLASSIC_OPTION)).toBe("Lift a lid for a surprise 11th ingredient");
    expect(fridgeWords(toastie).hint).toBe("Start with a bread you have at home");
    expect(fridgeWords({ ...toastie, fridgeKinds: ["bread", "wrap"] }).hint).toBe("Start with a bread or wrap you have at home");
    // A mode with no fridge kinds searches the whole pantry, in Classic's words.
    expect(fridgeWords({ ...toastie, fridgeKinds: null }).hint).toBe("Start with one thing you actually have at home tonight");
    expect(fridgeWords({ ...toastie, fridgeKinds: [] }).hint).toBe("Start with one thing you actually have at home tonight");
    expect(fridgeWords(CLASSIC_OPTION).placeholder).toBe("Search the pantry — e.g. tomatoes");
  });
});

describe("the fridge raid in a mode", () => {
  const breads: SearchResult = { ok: true, ingredients: [ingredient(SOURDOUGH)] };

  it("searches within the chosen mode (after the debounce)", async () => {
    const m = make(BOTH, async () => {}, async () => breads);
    await openWith(m);
    expandTwists(m);
    tileOf(m, "toastie").click();
    m.type("sour");
    expect(m.search).not.toHaveBeenCalled();
    m.fire();
    await flush();
    expect(m.search).toHaveBeenCalledTimes(1);
    expect(m.search).toHaveBeenCalledWith("sour", "toastie");
    expect(qa(m.sheet.element, ".wx-srv-ck-fridge-option").map((o) => o.dataset["ingredient"])).toEqual(["sourdough-loaf"]);
  });

  it("searches the whole bank in Classic", async () => {
    const m = make(BOTH, async () => {}, async () => breads);
    await openWith(m);
    expandTwists(m);
    m.type("sour");
    m.fire();
    await flush();
    expect(m.search).toHaveBeenCalledWith("sour", "classic");
  });

  it("changing the mode clears a chosen fridge item (a tomato cannot start a toastie)", async () => {
    const m = make(BOTH, async () => {}, async () => ({ ok: true, ingredients: [ingredient(TOMATOES)] }));
    await openWith(m);
    expandTwists(m);
    m.type("tom");
    m.fire();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-fridge-option[data-ingredient="cherry-tomatoes"]').click();
    expect(visible(m.sheet.element, ".wx-srv-ck-fridge-chosen")).toBe(true);
    expect(q(m.sheet.element, ".wx-srv-ck-twists-count").textContent).toBe("1 on");
    tileOf(m, "toastie").click();
    expect(visible(m.sheet.element, ".wx-srv-ck-fridge-chosen")).toBe(false);
    expect(visible(m.sheet.element, ".wx-srv-ck-fridge-input")).toBe(true);
    expect(visible(m.sheet.element, ".wx-srv-ck-twists-count")).toBe(false);
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "toastie", fridgeSeedId: null });
  });

  it("a bread chosen in Toasted sandwich mode is sent as the fridge seed", async () => {
    const m = make(BOTH, async () => {}, async () => breads);
    await openWith(m);
    expandTwists(m);
    tileOf(m, "toastie").click();
    m.type("sour");
    m.fire();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-fridge-option[data-ingredient="sourdough-loaf"]').click();
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "toastie", fridgeSeedId: "sourdough-loaf" });
  });
});

describe("only the mode's own twists", () => {
  const MINI = toastieOption({ id: "mini", label: "Mini", emoji: "🥨", turns: 6, picksPerPlayer: 3, twists: ["lucky"], fridgeKinds: null, blurb: "Quick one" });

  it("hides every row the mode does not allow, and keeps what it does", async () => {
    const m = make(BOTH);
    await openWith(m);
    expandTwists(m);
    for (const row of ["style", "challenge", "cloche", "stars", "fridge"]) expect(rowHidden(m, row), `Classic ${row}`).toBe(false);
    tileOf(m, "toastie").click();
    // Toasted sandwich allows all twelve.
    for (const row of ["style", "challenge", "cloche", "stars", "fridge"]) expect(rowHidden(m, row), `Toastie ${row}`).toBe(false);
  });

  it("a mode listing only some twists shows only those, and sends none of the others", async () => {
    const options = toastieOptions([
      { id: "classic", label: "Classic", emoji: "🍳", turns: 10, picksPerPlayer: 5, blurb: "", intro: [], twists: ["swap", "vote", "style", "cooked", "wildcard", "fridge", "challenge", "veto", "encore", "lucky", "stars", "chaos"], fridgeKinds: null },
      MINI,
    ]);
    const m = make(options);
    await openWith(m);
    expandTwists(m);
    tileOf(m, "mini").click();
    for (const row of ["style", "challenge", "cloche", "stars", "fridge"]) expect(rowHidden(m, row), row).toBe(true);
    go(m).click();
    expect(m.starts()[0]).toEqual({ mode: "mini", blind: false, style: null, challenge: null, wildcard: false, stars: false, fridgeSeedId: null, encore: null });
  });

  it("twists chosen before the mode changed are not sent for a mode that forbids them", async () => {
    const options = toastieOptions([
      { id: "classic", label: "Classic", emoji: "🍳", turns: 10, picksPerPlayer: 5, blurb: "", intro: [], twists: ["style", "challenge", "wildcard", "stars", "fridge"], fridgeKinds: null },
      MINI,
    ]);
    const m = make(options);
    await openWith(m, { style: "spin", challenge: "one-pan", wildcard: true, stars: true });
    expect(q(m.sheet.element, ".wx-srv-ck-twists-count").textContent).toBe("4 on");
    tileOf(m, "mini").click();
    expect(visible(m.sheet.element, ".wx-srv-ck-twists-count")).toBe(false);
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "mini", style: null, challenge: null, wildcard: false, stars: false });
    await flush();
    // Back in Classic they are all still there.
    tileOf(m, "classic").click();
    go(m).click();
  });
});

describe("\"New\" preselects the round's mode", () => {
  it("the preset's mode is the checked tile and is what Start sends, with the rest of the preset", async () => {
    const m = make(BOTH);
    await openWith(m, { mode: "toastie", blind: true, wildcard: true });
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
    expect(tileOf(m, "classic").getAttribute("aria-checked")).toBe("false");
    expect(tileOf(m, "classic").disabled).toBe(false); // New may still change it
    expect(hintOf(m, "cloche")).toBe("Lift a lid for a mystery 9th ingredient");
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "toastie", blind: true, wildcard: true });
  });

  it("a preselected mode the server no longer lists falls back to Classic", async () => {
    const m = make(CLASSIC_ONLY);
    await openWith(m, { mode: "toastie" });
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "classic" });
  });

  it("a preselected fridge item is kept for the preselected mode", async () => {
    const m = make(BOTH);
    await openWith(m, { mode: "toastie", fridge: ingredient(SOURDOUGH) });
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "toastie", fridgeSeedId: "sourdough-loaf" });
  });
});

describe("an encore locks the mode", () => {
  it("a Toasted sandwich encore shows only its own tile, checked, with \"Same game as before\"", async () => {
    const m = make(BOTH);
    await openWith(m, { encore: ENCORE });
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
    // The other tile is not offered (or at least cannot be chosen).
    const classic = tile(m, "classic");
    expect(classic === null || classic.disabled).toBe(true);
    expect(visible(m.sheet.element, ".wx-srv-ck-mtiles-note")).toBe(true);
    expect(q(m.sheet.element, ".wx-srv-ck-mtiles-note").textContent).toBe("Same game as before");
    classic?.click();
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "toastie", encore: { fromSeq: 30, kind: "remix", seedIds: ["sourdough-loaf"] } });
  });

  it("the arrow keys cannot leave a locked mode", async () => {
    const m = make(BOTH);
    await openWith(m, { encore: ENCORE });
    tileOf(m, "toastie").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
  });

  it("an encore's own mode beats the preset's mode", async () => {
    const m = make(BOTH);
    await openWith(m, { mode: "classic", encore: ENCORE });
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "toastie" });
  });

  it("a Classic encore (no mode on the preset) stays Classic and locks the tile too", async () => {
    const { mode: _mode, ...classicEncore } = ENCORE;
    const m = make(BOTH);
    await openWith(m, { encore: { ...classicEncore, candidates: [ingredient(PARSLEY)] } });
    expect(tileOf(m, "classic").getAttribute("aria-checked")).toBe("true");
    const other = tile(m, "toastie");
    expect(other === null || other.disabled).toBe(true);
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "classic" });
  });

  it("dropping the encore with its ✕ unlocks the tile", async () => {
    const m = make(BOTH);
    await openWith(m, { encore: ENCORE });
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-encore-drop").click();
    expect(visible(m.sheet.element, ".wx-srv-ck-mtiles-note")).toBe(false);
    expect(qa(m.sheet.element, ".wx-srv-ck-mtile").map((t) => t.dataset["modeId"])).toEqual(["classic", "toastie"]);
    expect(qa<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-mtile").every((t) => !t.disabled)).toBe(true);
    tileOf(m, "classic").click();
    expect(tileOf(m, "classic").getAttribute("aria-checked")).toBe("true");
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ mode: "classic", encore: null });
  });

  it("a locked mode the options do not describe waits: Start is off, it says so, and its starters are not seated by Classic's rules", async () => {
    const m = make(CLASSIC_ONLY);
    await openWith(m, { encore: { ...ENCORE, candidates: [withKind(SOURDOUGH, "bread"), withKind(HAM, "main"), withKind(PICKLES, "finish")] } });
    expect(visible(m.sheet.element, ".wx-srv-ck-mode-missing")).toBe(true);
    expect(q(m.sheet.element, ".wx-srv-ck-mode-missing-text").textContent).toBe("Couldn't load this game — try again.");
    expect(go(m).disabled).toBe(true);
    go(m).click();
    expect(m.starts()).toHaveLength(0);
    // Classic's rules would let a second starter be ticked beside the first: here nothing is re-seated.
    expect(seedsOf(m)).toEqual(["sourdough-loaf"]);
  });

  it("a failed options read on a mode encore can be tried again, and then the mode's seats apply", async () => {
    const reads: Array<CookoutOptions | null> = [null, BOTH];
    const m = make(BOTH, async () => {}, async () => ({ ok: true, ingredients: [] }), async () => reads.shift() ?? null);
    await openWith(m, { encore: remix([withKind(PARSLEY, null), withKind(SOURDOUGH, "bread"), withKind(HAM, "main")]) });
    expect(visible(m.sheet.element, ".wx-srv-ck-mode-missing")).toBe(true);
    expect(go(m).disabled).toBe(true);
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-mode-missing-retry").click();
    await flush();
    expect(visible(m.sheet.element, ".wx-srv-ck-mode-missing")).toBe(false);
    // Seated by the toasted sandwich's rules: the kind-less starter cannot be one, the bread can.
    expect(seedsOf(m)).toEqual(["sourdough-loaf"]);
    expect(go(m).disabled).toBe(false);
  });
});

describe("a start that fails because the mode went away", () => {
  it("re-reads the options, drops the tile and falls back to Classic, keeping the message", async () => {
    const reads: Array<CookoutOptions | null> = [BOTH, CLASSIC_ONLY];
    const m = make(
      BOTH,
      async () => {
        throw new Error("That game isn't available right now");
      },
      async () => ({ ok: true, ingredients: [] }),
      async () => reads.shift() ?? CLASSIC_ONLY,
    );
    await openWith(m);
    tileOf(m, "toastie").click();
    go(m).click();
    await flush();
    expect(m.loadOptions).toHaveBeenCalledTimes(2);
    expect(q(m.sheet.element, ".wx-srv-ck-start-error").textContent).toBe("That game isn't available right now");
    expect(visible(m.sheet.element, ".wx-srv-ck-start-error")).toBe(true);
    expect(m.sheet.element.querySelectorAll(".wx-srv-ck-mtile")).toHaveLength(0);
    expect(q(m.sheet.element, ".wx-srv-ck-start-what").hidden).toBe(true);
    // The sheet is still open and starts a Classic round next.
    expect(m.sheet.isOpen()).toBe(true);
    go(m).click();
    expect(m.starts()[1]).toMatchObject({ mode: "classic" });
  });

  it("a failed Classic start does not re-read the options", async () => {
    const m = make(BOTH, async () => {
      throw new Error("Couldn't start a Cookout — try again.");
    });
    await openWith(m);
    go(m).click();
    await flush();
    expect(m.loadOptions).toHaveBeenCalledTimes(1);
    expect(q(m.sheet.element, ".wx-srv-ck-start-error").textContent).toBe("Couldn't start a Cookout — try again.");
  });

  it("keeps the tiles when the re-read itself fails", async () => {
    const reads: Array<CookoutOptions | null> = [BOTH, null];
    const m = make(
      BOTH,
      async () => {
        throw new Error("nope");
      },
      async () => ({ ok: true, ingredients: [] }),
      async () => reads.shift() ?? null,
    );
    await openWith(m);
    tileOf(m, "toastie").click();
    go(m).click();
    await flush();
    expect(m.sheet.element.querySelectorAll(".wx-srv-ck-mtile")).toHaveLength(2);
    expect(tileOf(m, "toastie").getAttribute("aria-checked")).toBe("true");
  });
});


// -- Encore seats (09c §2.5): a toasted sandwich seats one bread and one filling ---------------------------------

const TOASTIE_OPTION = toastieOptions().modes[1]!;
const withKind = (raw: Json, kind: string | null): EncorePreset["candidates"][number] => (kind === null ? ingredient(raw) : { ...ingredient(raw), kind });

function remix(candidates: EncorePreset["candidates"], kind: "remix" | "leftovers" = "remix"): EncorePreset {
  return { fromSeq: 30, generation: 1, conceptId: "c", kind, title: "Dish", candidates, mode: "toastie" };
}

const seedsOf = (m: Made): string[] => qa(m.sheet.element, ".wx-srv-ck-encore-seed-on").map((n) => n.dataset["ingredient"] ?? "");
const seed = (m: Made, id: string): HTMLButtonElement => q<HTMLButtonElement>(m.sheet.element, `.wx-srv-ck-encore-seed[data-ingredient="${id}"]`);

describe("encoreSeat", () => {
  const bread = withKind(SOURDOUGH, "bread");
  const filling = withKind(HAM, "main");
  it("Classic seats any starter anywhere", () => {
    expect(encoreSeat(CLASSIC_OPTION, "remix", filling, false)).toEqual({ seat: "any", reason: null });
    expect(encoreSeat(CLASSIC_OPTION, "leftovers", withKind(HAM, null), true)).toEqual({ seat: "any", reason: null });
  });
  it("a leftovers encore's starters are fillings", () => {
    expect(encoreSeat(TOASTIE_OPTION, "leftovers", filling, false)).toEqual({ seat: "filling", reason: null });
    expect(encoreSeat(TOASTIE_OPTION, "leftovers", withKind(HAM, null), false).seat).toBe("filling");
  });
  it("a remix bread takes the first seat, unless the fridge raid already supplies one", () => {
    expect(encoreSeat(TOASTIE_OPTION, "remix", bread, false)).toEqual({ seat: "first", reason: null });
    expect(encoreSeat(TOASTIE_OPTION, "remix", bread, true)).toEqual({ seat: null, reason: "Your fridge bread is the bread" });
  });
  it("a remix filling takes the filling seat, with or without a fridge bread", () => {
    expect(encoreSeat(TOASTIE_OPTION, "remix", filling, false).seat).toBe("filling");
    expect(encoreSeat(TOASTIE_OPTION, "remix", filling, true).seat).toBe("filling");
  });
  it("a remix starter of unknown kind cannot be seated", () => {
    expect(encoreSeat(TOASTIE_OPTION, "remix", withKind(HAM, null), false)).toEqual({ seat: null, reason: "Can't be a starter here" });
    expect(encoreSeat(TOASTIE_OPTION, "remix", ingredient(HAM), false)).toEqual({ seat: null, reason: "Can't be a starter here" });
  });
});

describe("a toasted sandwich remix's starters", () => {
  const candidates = [withKind(SOURDOUGH, "bread"), withKind(HAM, "main"), withKind(PICKLES, "produce")];

  it("ticks the first seatable starter by default and starts with it", async () => {
    const m = make(BOTH);
    await openWith(m, { encore: remix(candidates) });
    expect(seedsOf(m)).toEqual(["sourdough-loaf"]);
    expect(q(m.sheet.element, ".wx-srv-ck-encore-hint").textContent).toContain("Choose a bread, a filling, or one of each");
  });

  it("a filling is added beside the bread (two seeds), and a second filling swaps out the first", async () => {
    const m = make(BOTH);
    await openWith(m, { encore: remix(candidates) });
    seed(m, "smoked-ham").click();
    expect(seedsOf(m).sort()).toEqual(["smoked-ham", "sourdough-loaf"]);
    seed(m, "dill-pickles").click();
    expect(seedsOf(m).sort()).toEqual(["dill-pickles", "sourdough-loaf"]);
    go(m).click();
    expect(m.starts()[0]?.encore?.seedIds.slice().sort()).toEqual(["dill-pickles", "sourdough-loaf"]);
  });

  it("a kind-less starter is disabled and says why", async () => {
    const m = make(BOTH);
    await openWith(m, { encore: remix([withKind(PARSLEY, null), ...candidates]) });
    const parsley = seed(m, "flat-leaf-parsley");
    expect(parsley.disabled).toBe(true);
    expect(parsley.querySelector(".wx-srv-ck-encore-why")?.textContent).toBe("Can't be a starter here");
    expect(seedsOf(m)).toEqual(["sourdough-loaf"]);
  });

  it("choosing a fridge bread drops the bread starter and disables bread starters with the reason", async () => {
    const m = make(BOTH, async () => {}, async () => ({ ok: true, ingredients: [ingredient(SOURDOUGH)] }));
    await openWith(m, { encore: remix(candidates) });
    expandTwists(m);
    m.type("sour");
    m.fire();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-fridge-option[data-ingredient="sourdough-loaf"]').click();
    expect(seed(m, "sourdough-loaf").disabled).toBe(true);
    expect(seed(m, "sourdough-loaf").querySelector(".wx-srv-ck-encore-why")?.textContent).toBe("Your fridge bread is the bread");
    expect(seedsOf(m)).toEqual(["smoked-ham"]);
    expect(q(m.sheet.element, ".wx-srv-ck-encore-hint").textContent).toBe("Choose 1 filling to begin the basket with (your fridge bread is the bread).");
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ fridgeSeedId: "sourdough-loaf", encore: { seedIds: ["smoked-ham"] } });
  });

  it("clearing the fridge bread gives back the bread starter it pushed out", async () => {
    const m = make(BOTH, async () => {}, async () => ({ ok: true, ingredients: [ingredient(SOURDOUGH)] }));
    await openWith(m, { encore: remix(candidates) });
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-encore-seed[data-ingredient="smoked-ham"]').click();
    expect(seedsOf(m)).toEqual(["sourdough-loaf", "smoked-ham"]);
    expandTwists(m);
    m.type("sour");
    m.fire();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-fridge-option[data-ingredient="sourdough-loaf"]').click();
    expect(seedsOf(m)).toEqual(["smoked-ham"]);
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-fridge-clear").click();
    expect(seedsOf(m)).toEqual(["sourdough-loaf", "smoked-ham"]);
    expect(seed(m, "sourdough-loaf").disabled).toBe(false);
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ fridgeSeedId: null, encore: { seedIds: ["sourdough-loaf", "smoked-ham"] } });
  });

  it("a start refused as invalid says to pick one bread and one filling", async () => {
    const m = make(BOTH, async () => {
      throw new CookoutStartError("invalid", "The kitchen can't start with those twists");
    });
    await openWith(m, { encore: remix(candidates) });
    go(m).click();
    await flush();
    expect(q(m.sheet.element, ".wx-srv-ck-start-error").textContent).toBe("Pick one bread and one filling to start with.");
  });

  it("options arriving after open re-seat the starters", async () => {
    let resolve: (o: CookoutOptions | null) => void = () => {};
    const m = make(BOTH, async () => {}, async () => ({ ok: true, ingredients: [] }), () => new Promise((r) => (resolve = r)));
    m.sheet.open({ encore: remix([withKind(PARSLEY, null), ...candidates]) });
    await flush();
    expect(seedsOf(m)).toEqual(["flat-leaf-parsley"]); // nothing is known about the mode yet
    resolve(BOTH);
    await flush();
    expect(seedsOf(m)).toEqual(["sourdough-loaf"]);
  });
});

describe("a toasted sandwich leftovers encore", () => {
  const candidates = [withKind(HAM, "main"), withKind(PICKLES, "produce")];

  it("keeps exactly one filling: ticking another replaces it", async () => {
    const m = make(BOTH);
    await openWith(m, { encore: remix(candidates, "leftovers") });
    expect(seedsOf(m)).toEqual(["smoked-ham"]);
    expect(q(m.sheet.element, ".wx-srv-ck-encore-hint").textContent).toBe("Choose 1 filling to begin the basket with.");
    seed(m, "dill-pickles").click();
    expect(seedsOf(m)).toEqual(["dill-pickles"]);
    go(m).click();
    expect(m.starts()[0]?.encore?.seedIds).toEqual(["dill-pickles"]);
  });

  it("a start refused as invalid says to pick one filling", async () => {
    const m = make(BOTH, async () => {
      throw new CookoutStartError("invalid", "nope");
    });
    await openWith(m, { encore: remix(candidates, "leftovers") });
    go(m).click();
    await flush();
    expect(q(m.sheet.element, ".wx-srv-ck-start-error").textContent).toBe("Pick one filling to start with.");
  });
});

describe("a Classic encore", () => {
  it("keeps the two-starter behaviour: two seeds, then the others are disabled until one is unticked", async () => {
    const m = make(BOTH);
    const classic: EncorePreset = { fromSeq: 30, generation: 1, conceptId: "c", kind: "remix", title: "T", candidates: [ingredient(SOURDOUGH), ingredient(HAM), ingredient(PICKLES)] };
    await openWith(m, { encore: classic });
    expect(seedsOf(m)).toEqual(["sourdough-loaf"]);
    seed(m, "smoked-ham").click();
    expect(seedsOf(m)).toEqual(["sourdough-loaf", "smoked-ham"]);
    expect(seed(m, "dill-pickles").disabled).toBe(true);
    seed(m, "sourdough-loaf").click();
    seed(m, "dill-pickles").click();
    expect(seedsOf(m).sort()).toEqual(["dill-pickles", "smoked-ham"]);
    expect(q(m.sheet.element, ".wx-srv-ck-encore-hint").textContent).toBe("Choose 1 or 2 starters to begin the basket with — you both see them.");
  });

  it("a Classic start refused as invalid keeps the caller's own words", async () => {
    const m = make(BOTH, async () => {
      throw new CookoutStartError("invalid", "The kitchen can't start with those twists — change a choice and try again.");
    });
    await openWith(m);
    go(m).click();
    await flush();
    expect(q(m.sheet.element, ".wx-srv-ck-start-error").textContent).toBe("The kitchen can't start with those twists — change a choice and try again.");
  });
});

describe("focus stays on the mode tiles", () => {
  it("a tap on a tile leaves the focus on the now-checked tile, not on the body", async () => {
    const m = make(BOTH);
    await openWith(m);
    tileOf(m, "toastie").focus();
    tileOf(m, "toastie").click();
    expect(document.activeElement).toBe(tileOf(m, "toastie"));
    expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
  });

  it("the arrow keys keep it on the chosen tile too", async () => {
    const m = make(BOTH);
    await openWith(m);
    tileOf(m, "classic").focus();
    tileOf(m, "classic").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tileOf(m, "toastie"));
    tileOf(m, "toastie").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tileOf(m, "classic"));
  });
});
