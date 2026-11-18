import { afterEach, describe, expect, it, vi } from "vitest";
import type { CookoutOptions, IngredientSnap, SearchResult } from "../../src/server/cookout/api";
import { CLASSIC_OPTION, parseSnap } from "../../src/server/cookout/api";
import { createCookoutStartSheet, type EncorePreset, type StartChoices, type StartPreset } from "../../src/server/cookout/startSheet";
import { BEANS, MISO, PARSLEY, RIBEYE, SALMON, TOAST } from "./fixtures";
import { TOMATOES, flush, q, qa, visible, type Json } from "./twistFixtures";

// The start sheet's twists (spec/server-chat/09a-cookout-twists.md §9): a collapsed "Add twists" disclosure,
// chef-only rows hidden without a chef, Spin, the fridge raid's debounced search, the encore banner and its
// seed limits, the New-style preset, and one client id per distinct set of choices.

function ingredient(raw: Json): IngredientSnap {
  const parsed = parseSnap(raw);
  if (parsed === null) throw new Error("fixture");
  return parsed;
}

const OPTIONS: CookoutOptions = {
  styles: [
    { id: "cosy-pub", label: "Cosy pub", emoji: "🍺", blurb: "Warm and hearty" },
    { id: "street-food", label: "Street food", emoji: "🌯", blurb: "Fast and bold" },
  ],
  challenges: [
    { id: "one-pan", label: "One pan only", emoji: "🍳", blurb: "A single vessel" },
    { id: "no-oven", label: "No oven", emoji: "🔥", blurb: "Hob only" },
  ],
  chef: true,
  pictures: true,
  modes: [CLASSIC_OPTION],
};
const NO_CHEF: CookoutOptions = { ...OPTIONS, chef: false };

interface Timer {
  readonly cb: () => void;
  readonly ms: number;
}

interface Made {
  sheet: ReturnType<typeof createCookoutStartSheet>;
  start: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  timers: Map<number, Timer>;
  cleared: number[];
  /** Runs the one pending debounce timer. */
  fire(): void;
  type(text: string): void;
  starts(): StartChoices[];
}

function make(
  options: CookoutOptions | null,
  search: (q: string) => Promise<SearchResult> = async () => ({ ok: true, ingredients: [] }),
  startImpl: () => Promise<void> = async () => {},
  loadOptions: () => Promise<CookoutOptions | null> = async () => options,
): Made {
  const timers = new Map<number, Timer>();
  const cleared: number[] = [];
  let nextTimer = 1;
  let nextId = 0;
  const start = vi.fn(startImpl);
  const searchFn = vi.fn(search);
  const sheet = createCookoutStartSheet({
    document,
    start: start as unknown as (choices: StartChoices, clientId: string) => Promise<void>,
    loadOptions,
    search: searchFn as unknown as (q: string) => Promise<SearchResult>,
    newId: () => `start-${++nextId}`,
    setTimeout: (cb, ms) => {
      const id = nextTimer++;
      timers.set(id, { cb, ms });
      return id;
    },
    clearTimeout: (id) => {
      cleared.push(id);
      timers.delete(id);
    },
  });
  document.body.append(sheet.element);
  return {
    sheet,
    start,
    search: searchFn,
    timers,
    cleared,
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

function go(m: Made): HTMLButtonElement {
  return q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-start-go");
}

function expandTwists(m: Made): void {
  const toggle = q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-twists-toggle");
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
}

const ENCORE: EncorePreset = {
  fromSeq: 30,
  generation: 1,
  conceptId: "c",
  kind: "leftovers",
  title: "Lentil & Salmon Traybake",
  candidates: [ingredient(BEANS), ingredient(MISO), ingredient(PARSLEY)],
};

afterEach(() => document.body.replaceChildren());

describe("the twists disclosure", () => {
  it("is collapsed by default, with no twist-count chip, and opens on a tap", async () => {
    const m = make(OPTIONS);
    await openWith(m);
    const toggle = q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-twists-toggle");
    expect(toggle.textContent).toContain("Add twists (optional)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(q(m.sheet.element, ".wx-srv-ck-twists-body").hidden).toBe(true);
    expect(visible(m.sheet.element, ".wx-srv-ck-twists-count")).toBe(false);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(visible(m.sheet.element, ".wx-srv-ck-twists-body")).toBe(true);
    toggle.click();
    expect(q(m.sheet.element, ".wx-srv-ck-twists-body").hidden).toBe(true);
  });

  it("counts the twists switched on in a chip next to the label", async () => {
    const m = make(OPTIONS);
    await openWith(m);
    expandTwists(m);
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-twist-cloche").click();
    expect(q(m.sheet.element, ".wx-srv-ck-twists-count").textContent).toBe("1 on");
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-twist-stars").click();
    q<HTMLButtonElement>(m.sheet.element, '[data-challenge="one-pan"]').click();
    const chip = q(m.sheet.element, ".wx-srv-ck-twists-count");
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe("3 on");
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-twist-cloche").click();
    expect(q(m.sheet.element, ".wx-srv-ck-twists-count").textContent).toBe("2 on");
  });
});

describe("the chef-only rows", () => {
  it("are hidden when the server has no chef (chef: false), with a note saying why", async () => {
    const m = make(NO_CHEF);
    await openWith(m);
    expandTwists(m);
    expect(visible(m.sheet.element, ".wx-srv-ck-twist-style")).toBe(false);
    expect(visible(m.sheet.element, ".wx-srv-ck-twist-challenge")).toBe(false);
    expect(visible(m.sheet.element, ".wx-srv-ck-twist-cloche")).toBe(false);
    expect(visible(m.sheet.element, ".wx-srv-ck-twist-stars")).toBe(false);
    expect(visible(m.sheet.element, ".wx-srv-ck-twists-note")).toBe(true);
    // The fridge raid needs no chef.
    expect(visible(m.sheet.element, ".wx-srv-ck-twist-fridge")).toBe(true);
  });

  it("are hidden when the options could not be read at all (null)", async () => {
    const m = make(null);
    await openWith(m);
    expandTwists(m);
    for (const row of [".wx-srv-ck-twist-style", ".wx-srv-ck-twist-challenge", ".wx-srv-ck-twist-cloche", ".wx-srv-ck-twist-stars"]) {
      expect(visible(m.sheet.element, row), row).toBe(false);
    }
    expect(visible(m.sheet.element, ".wx-srv-ck-twist-fridge")).toBe(true);
  });

  it("are shown with the catalogue when the chef is there", async () => {
    const m = make(OPTIONS);
    await openWith(m);
    expandTwists(m);
    for (const row of [".wx-srv-ck-twist-style", ".wx-srv-ck-twist-challenge", ".wx-srv-ck-twist-cloche", ".wx-srv-ck-twist-stars", ".wx-srv-ck-twist-fridge"]) {
      expect(visible(m.sheet.element, row), row).toBe(true);
    }
    expect(visible(m.sheet.element, ".wx-srv-ck-twists-note")).toBe(false);
    expect(qa(m.sheet.element, "[data-style]").map((c) => c.dataset["style"])).toEqual(["none", "spin", "cosy-pub", "street-food"]);
    expect(qa(m.sheet.element, "[data-challenge]").map((c) => c.dataset["challenge"])).toEqual(["none", "one-pan", "no-oven"]);
    expect(q(m.sheet.element, '[data-style="cosy-pub"]').textContent).toContain("Cosy pub");
    expect(q(m.sheet.element, '[data-style="none"]').getAttribute("aria-checked")).toBe("true");
  });

  it("choosing Spin sends style 'spin'", async () => {
    const m = make(OPTIONS);
    await openWith(m);
    expandTwists(m);
    q<HTMLButtonElement>(m.sheet.element, '[data-style="spin"]').click();
    expect(q(m.sheet.element, '[data-style="spin"]').getAttribute("aria-checked")).toBe("true");
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ style: "spin" });
  });

  it("sends the chosen style, challenge, cloche and stars", async () => {
    const m = make(OPTIONS);
    await openWith(m);
    expandTwists(m);
    q<HTMLButtonElement>(m.sheet.element, '[data-style="cosy-pub"]').click();
    q<HTMLButtonElement>(m.sheet.element, '[data-challenge="no-oven"]').click();
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-twist-cloche").click();
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-twist-stars").click();
    go(m).click();
    expect(m.starts()[0]).toEqual({ mode: "classic", blind: false, style: "cosy-pub", challenge: "no-oven", wildcard: true, stars: true, fridgeSeedId: null, encore: null });
  });

  it("are NOT sent when there is no chef, even if a preset had them on; the fridge raid still is", async () => {
    for (const options of [NO_CHEF, null]) {
      const m = make(options);
      await openWith(m, { style: "cosy-pub", challenge: "one-pan", wildcard: true, stars: true, fridge: ingredient(TOMATOES) });
      go(m).click();
      expect(m.starts()[0], String(options?.chef)).toEqual({
        mode: "classic",
        blind: false,
        style: null,
        challenge: null,
        wildcard: false,
        stars: false,
        fridgeSeedId: "cherry-tomatoes",
        encore: null,
      });
      document.body.replaceChildren();
    }
  });

  it("a Blind start with no twists sends just the mode", async () => {
    const m = make(OPTIONS);
    await openWith(m, { blind: true });
    go(m).click();
    expect(m.starts()[0]).toEqual({ mode: "classic", blind: true, style: null, challenge: null, wildcard: false, stars: false, fridgeSeedId: null, encore: null });
  });
});

describe("the fridge raid's search", () => {
  const found: SearchResult = { ok: true, ingredients: [ingredient(TOMATOES), ingredient(SALMON)] };

  it("waits 250 ms after the last keystroke and fires ONE search", async () => {
    const m = make(OPTIONS, async () => found);
    await openWith(m);
    expandTwists(m);
    m.type("t");
    expect(m.timers.size).toBe(0);
    m.type("to");
    expect([...m.timers.values()].map((t) => t.ms)).toEqual([250]);
    m.type("tom");
    // The earlier keystroke's timer was cancelled: still only one pending.
    expect(m.cleared).toHaveLength(1);
    expect(m.timers.size).toBe(1);
    expect(m.search).not.toHaveBeenCalled();
    m.fire();
    await flush();
    expect(m.search).toHaveBeenCalledTimes(1);
    expect(m.search).toHaveBeenCalledWith("tom", "classic");
    expect(qa(m.sheet.element, ".wx-srv-ck-fridge-option").map((o) => o.dataset["ingredient"])).toEqual(["cherry-tomatoes", "salmon-fillet"]);
  });

  it("drops an answer for an older query", async () => {
    const pending: Array<{ q: string; resolve: (r: SearchResult) => void }> = [];
    const m = make(OPTIONS, (query) => new Promise<SearchResult>((resolve) => pending.push({ q: query, resolve })));
    await openWith(m);
    expandTwists(m);
    m.type("to");
    m.fire();
    m.type("tom");
    m.fire();
    expect(pending.map((p) => p.q)).toEqual(["to", "tom"]);
    pending[1]?.resolve({ ok: true, ingredients: [ingredient(TOMATOES)] });
    await flush();
    pending[0]?.resolve({ ok: true, ingredients: [ingredient(SALMON), ingredient(RIBEYE)] });
    await flush();
    expect(qa(m.sheet.element, ".wx-srv-ck-fridge-option").map((o) => o.dataset["ingredient"])).toEqual(["cherry-tomatoes"]);
  });

  it("says when nothing matches, and when the pantry cannot be searched", async () => {
    const answers: SearchResult[] = [{ ok: true, ingredients: [] }, { ok: false, kind: "game_unavailable" }, { ok: false, kind: "unavailable" }];
    const m = make(OPTIONS, async () => answers.shift() ?? { ok: true, ingredients: [] });
    await openWith(m);
    expandTwists(m);
    const status = (): string => q(m.sheet.element, ".wx-srv-ck-fridge-status").textContent ?? "";
    m.type("zz");
    m.fire();
    await flush();
    expect(status()).toBe("Nothing in the pantry matches that.");
    m.type("zzz");
    m.fire();
    await flush();
    expect(status()).toBe("The pantry isn't available right now.");
    m.type("zzzz");
    m.fire();
    await flush();
    expect(status()).toBe("Couldn't search the pantry — try again.");
  });

  it("choosing a result shows the chip and sends fridgeSeedId; the ✕ clears it", async () => {
    const m = make(OPTIONS, async () => found);
    await openWith(m);
    expandTwists(m);
    m.type("tom");
    m.fire();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-fridge-option[data-ingredient="cherry-tomatoes"]').click();
    expect(q(m.sheet.element, ".wx-srv-ck-fridge-chip-name").textContent).toBe("Cherry tomatoes");
    expect(visible(m.sheet.element, ".wx-srv-ck-fridge-chosen")).toBe(true);
    expect(q(m.sheet.element, ".wx-srv-ck-twists-count").textContent).toBe("1 on");
    go(m).click();
    expect(m.starts()[0]).toMatchObject({ fridgeSeedId: "cherry-tomatoes" });
    await flush();
    document.body.replaceChildren();

    const again = make(OPTIONS, async () => found);
    await openWith(again);
    expandTwists(again);
    again.type("tom");
    again.fire();
    await flush();
    q<HTMLButtonElement>(again.sheet.element, '.wx-srv-ck-fridge-option[data-ingredient="cherry-tomatoes"]').click();
    q<HTMLButtonElement>(again.sheet.element, ".wx-srv-ck-fridge-clear").click();
    expect(visible(again.sheet.element, ".wx-srv-ck-fridge-chosen")).toBe(false);
    expect(visible(again.sheet.element, ".wx-srv-ck-fridge-input")).toBe(true);
    go(again).click();
    expect(again.starts()[0]).toMatchObject({ fridgeSeedId: null });
  });
});

describe("the encore preset", () => {
  it("shows the banner with the first starter ticked, and starts an encore with just that one", async () => {
    const m = make(OPTIONS);
    await openWith(m, { encore: ENCORE });
    expect(visible(m.sheet.element, ".wx-srv-ck-encore")).toBe(true);
    expect(q(m.sheet.element, ".wx-srv-ck-encore-title").textContent).toContain("Leftovers encore of “Lentil & Salmon Traybake”");
    const seeds = qa<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-encore-seed");
    expect(seeds.map((s) => [s.dataset["ingredient"], s.getAttribute("aria-checked")])).toEqual([
      ["tinned-baked-beans", "true"],
      ["white-miso", "false"],
      ["flat-leaf-parsley", "false"],
    ]);
    expect(go(m).textContent).toBe("Start encore");
    go(m).click();
    expect(m.starts()[0]?.encore).toEqual({ fromSeq: 30, generation: 1, conceptId: "c", kind: "leftovers", seedIds: ["tinned-baked-beans"] });
  });

  it("allows at most two starters: a third is disabled until one is unticked", async () => {
    const m = make(OPTIONS);
    await openWith(m, { encore: ENCORE });
    const seed = (id: string): HTMLButtonElement => q<HTMLButtonElement>(m.sheet.element, `.wx-srv-ck-encore-seed[data-ingredient="${id}"]`);
    seed("white-miso").click();
    expect(seed("white-miso").getAttribute("aria-checked")).toBe("true");
    expect(seed("flat-leaf-parsley").disabled).toBe(true);
    seed("flat-leaf-parsley").click();
    expect(seed("flat-leaf-parsley").getAttribute("aria-checked")).toBe("false");
    seed("tinned-baked-beans").click();
    expect(seed("flat-leaf-parsley").disabled).toBe(false);
    seed("flat-leaf-parsley").click();
    go(m).click();
    expect(m.starts()[0]?.encore?.seedIds).toEqual(["white-miso", "flat-leaf-parsley"]);
  });

  it("allows only one starter once a fridge seed is chosen, and choosing the fridge seed trims two to one", async () => {
    const m = make(OPTIONS, async () => ({ ok: true, ingredients: [ingredient(TOMATOES)] }));
    await openWith(m, { encore: ENCORE });
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-encore-seed[data-ingredient="white-miso"]').click();
    expect(qa(m.sheet.element, '.wx-srv-ck-encore-seed[aria-checked="true"]')).toHaveLength(2);
    expandTwists(m);
    m.type("tom");
    m.fire();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-fridge-option[data-ingredient="cherry-tomatoes"]').click();
    // Trimmed to the first starter; the hint says the fridge takes the other place.
    expect(qa(m.sheet.element, '.wx-srv-ck-encore-seed[aria-checked="true"]').map((s) => s.dataset["ingredient"])).toEqual(["tinned-baked-beans"]);
    expect(q(m.sheet.element, ".wx-srv-ck-encore-hint").textContent).toContain("Choose 1 starter");
    // Another tap swaps rather than adds.
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-encore-seed[data-ingredient="flat-leaf-parsley"]').click();
    expect(qa(m.sheet.element, '.wx-srv-ck-encore-seed[aria-checked="true"]')).toHaveLength(1);
    go(m).click();
    const sent = m.starts()[0];
    expect(sent?.fridgeSeedId).toBe("cherry-tomatoes");
    expect(sent?.encore?.seedIds).toEqual(["flat-leaf-parsley"]);
  });

  it("opens with a fridge seed already chosen limited to one starter", async () => {
    const m = make(OPTIONS);
    await openWith(m, { encore: ENCORE, fridge: ingredient(TOMATOES) });
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-encore-seed[data-ingredient="white-miso"]').click();
    expect(qa(m.sheet.element, '.wx-srv-ck-encore-seed[aria-checked="true"]')).toHaveLength(1);
  });

  it("unticking every starter disables Start", async () => {
    const m = make(OPTIONS);
    await openWith(m, { encore: ENCORE });
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-encore-seed[data-ingredient="tinned-baked-beans"]').click();
    expect(go(m).disabled).toBe(true);
    go(m).click();
    expect(m.start).not.toHaveBeenCalled();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-encore-seed[data-ingredient="white-miso"]').click();
    expect(go(m).disabled).toBe(false);
  });

  it("the ✕ drops the encore: no banner, a plain start", async () => {
    const m = make(OPTIONS);
    await openWith(m, { encore: ENCORE });
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-encore-drop").click();
    expect(visible(m.sheet.element, ".wx-srv-ck-encore")).toBe(false);
    expect(go(m).textContent).toBe("Start Cookout");
    expect(go(m).disabled).toBe(false);
    go(m).click();
    expect(m.starts()[0]?.encore).toBeNull();
  });

  it("a preset with no candidates is no encore at all", async () => {
    const m = make(OPTIONS);
    await openWith(m, { encore: { ...ENCORE, candidates: [] } });
    expect(visible(m.sheet.element, ".wx-srv-ck-encore")).toBe(false);
    expect(go(m).disabled).toBe(false);
  });

  it("a Remix is worded as one", async () => {
    const m = make(OPTIONS);
    await openWith(m, { encore: { ...ENCORE, kind: "remix", candidates: [ingredient(TOAST)] } });
    expect(q(m.sheet.element, ".wx-srv-ck-encore-title").textContent).toContain("Remix of “Lentil & Salmon Traybake”");
    go(m).click();
    expect(m.starts()[0]?.encore).toMatchObject({ kind: "remix", seedIds: ["thick-white-toast"] });
  });
});

describe("the 'New' preset", () => {
  it("preselects style, challenge, cloche, stars and fridge, and opens the disclosure", async () => {
    const m = make(OPTIONS);
    await openWith(m, { blind: true, style: "spin", challenge: "one-pan", wildcard: true, stars: true, fridge: ingredient(TOMATOES) });
    expect(visible(m.sheet.element, ".wx-srv-ck-twists-body")).toBe(true);
    expect(q(m.sheet.element, '[data-mode="blind"]').getAttribute("aria-checked")).toBe("true");
    expect(q(m.sheet.element, '[data-style="spin"]').getAttribute("aria-checked")).toBe("true");
    expect(q(m.sheet.element, '[data-challenge="one-pan"]').getAttribute("aria-checked")).toBe("true");
    expect(q(m.sheet.element, ".wx-srv-ck-twist-cloche").getAttribute("aria-checked")).toBe("true");
    expect(q(m.sheet.element, ".wx-srv-ck-twist-stars").getAttribute("aria-checked")).toBe("true");
    expect(q(m.sheet.element, ".wx-srv-ck-fridge-chip-name").textContent).toBe("Cherry tomatoes");
    expect(q(m.sheet.element, ".wx-srv-ck-twists-count").textContent).toBe("5 on");
    go(m).click();
    expect(m.starts()[0]).toEqual({ mode: "classic", blind: true, style: "spin", challenge: "one-pan", wildcard: true, stars: true, fridgeSeedId: "cherry-tomatoes", encore: null });
  });

  it("Start waits for the twist options, so a preselected chef twist is never silently dropped", async () => {
    let answer: (options: CookoutOptions | null) => void = () => {};
    const m = make(OPTIONS, undefined, undefined, () => new Promise((resolve) => (answer = resolve)));
    await openWith(m, { style: "cosy-pub", stars: true });
    expect(go(m).disabled).toBe(true);
    go(m).click();
    expect(m.start).not.toHaveBeenCalled();
    answer(OPTIONS);
    await flush();
    expect(go(m).disabled).toBe(false);
    go(m).click();
    expect(m.starts()[0]).toEqual({ mode: "classic", blind: false, style: "cosy-pub", challenge: null, wildcard: false, stars: true, fridgeSeedId: null, encore: null });
  });

  it("an options read that fails still lets the round start, without the chef twists and saying why", async () => {
    let answer: (options: CookoutOptions | null) => void = () => {};
    const m = make(OPTIONS, undefined, undefined, () => new Promise((resolve) => (answer = resolve)));
    await openWith(m, { style: "cosy-pub", fridge: ingredient(TOMATOES) });
    expect(go(m).disabled).toBe(true);
    answer(null);
    await flush();
    expect(go(m).disabled).toBe(false);
    expect(visible(m.sheet.element, ".wx-srv-ck-twists-note")).toBe(true);
    go(m).click();
    expect(m.starts()[0]).toEqual({ mode: "classic", blind: false, style: null, challenge: null, wildcard: false, stars: false, fridgeSeedId: "cherry-tomatoes", encore: null });
  });

  it("a twist-free New leaves the disclosure folded", async () => {
    const m = make(OPTIONS);
    await openWith(m, { blind: false });
    expect(q(m.sheet.element, ".wx-srv-ck-twists-body").hidden).toBe(true);
  });

  it("the preset does not leak into the next opening", async () => {
    const m = make(OPTIONS);
    await openWith(m, { style: "cosy-pub", wildcard: true, fridge: ingredient(TOMATOES) });
    m.sheet.close();
    await openWith(m);
    expect(q(m.sheet.element, ".wx-srv-ck-twists-body").hidden).toBe(true);
    go(m).click();
    expect(m.starts()[0]).toEqual({ mode: "classic", blind: false, style: null, challenge: null, wildcard: false, stars: false, fridgeSeedId: null, encore: null });
  });
});

describe("the start's client id", () => {
  it("is new when any choice changes, and the same on a retry of the same choices", async () => {
    const m = make(
      OPTIONS,
      async () => ({ ok: true, ingredients: [] }),
      async () => {
        throw new Error("Couldn't start a Cookout — try again.");
      },
    );
    await openWith(m);
    expandTwists(m);
    const ids = (): string[] => m.start.mock.calls.map((c: unknown[]) => c[1] as string);
    go(m).click();
    await flush();
    go(m).click();
    await flush();
    expect(ids()).toEqual(["start-1", "start-1"]);
    // Each kind of change is a different start.
    q<HTMLButtonElement>(m.sheet.element, ".wx-srv-ck-twist-stars").click();
    go(m).click();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '[data-style="cosy-pub"]').click();
    go(m).click();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '[data-challenge="no-oven"]').click();
    go(m).click();
    await flush();
    go(m).click();
    await flush();
    expect(ids()).toEqual(["start-1", "start-1", "start-2", "start-3", "start-4", "start-4"]);
    // Changing it back is still a change from the last one sent.
    q<HTMLButtonElement>(m.sheet.element, '[data-challenge="none"]').click();
    go(m).click();
    await flush();
    expect(ids()[6]).toBe("start-5");
  });

  it("a fridge seed or an encore starter changes it too", async () => {
    const m = make(OPTIONS, async () => ({ ok: true, ingredients: [ingredient(TOMATOES)] }), async () => {
      throw new Error("no");
    });
    await openWith(m, { encore: ENCORE });
    const ids = (): string[] => m.start.mock.calls.map((c: unknown[]) => c[1] as string);
    go(m).click();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-encore-seed[data-ingredient="white-miso"]').click();
    go(m).click();
    await flush();
    expandTwists(m);
    m.type("tom");
    m.fire();
    await flush();
    q<HTMLButtonElement>(m.sheet.element, '.wx-srv-ck-fridge-option[data-ingredient="cherry-tomatoes"]').click();
    go(m).click();
    await flush();
    expect(ids()).toEqual(["start-1", "start-2", "start-3"]);
  });
});
