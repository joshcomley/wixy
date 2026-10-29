import { afterEach, describe, expect, it } from "vitest";
import { starsGateText, viaBadge, voteBannerText } from "../../src/server/cookout/cookoutGame";
import { BEANS, MISO, LENTILS, PARSLEY, RIBEYE, SALMON, TOAST, FULL_RECIPE, CONCEPTS, P1_PICKS, P2_PICKS, recipesNone } from "./fixtures";
import type { FinishedOptions, PickingOptions } from "./fixtures";
import {
  CHALLENGE_PAN,
  DURIAN,
  NATTO,
  STYLE_COSY,
  TOMATOES,
  bankedSlot,
  earlierSet,
  gated,
  makeHarness,
  pick,
  q,
  qa,
  readyVote,
  settle,
  setup,
  stars,
  swap,
  twistFinished,
  twistPicking,
  v,
  type Harness,
  type Json,
} from "./twistFixtures";

// The Cookout pane's twists (spec/server-chat/09a-cookout-twists.md §9): lucky dip and chaos shelf, the
// waiting partner's sweep, starters, secret stars and the chef gate, the cloche, the dinner vote, the rescue
// swap, Earlier dishes, and the generation every vote / Bank / retry names.

afterEach(() => document.body.replaceChildren());

/** An Open round being picked, viewer Josh (Player 1) on his first turn, with extra keys on `current`. */
function table(current: Json = {}, o: PickingOptions = {}, root: Json = {}): Json {
  return twistPicking({ you: 1, turn: 1, ...o }, root, current);
}

/** A finished round whose dishes are ready. */
function ready(root: Json = {}, o: FinishedOptions = {}): Json {
  return twistFinished({ concepts: "ready", images: "done", ...o }, root);
}

const YOU_2: Json = { slot: 2, chaosUsed: false, vetoUsed: false };

function button(h: Harness, selector: string): HTMLButtonElement {
  return q<HTMLButtonElement>(h.pane, selector);
}

describe("lucky dip and chaos shelf", () => {
  it("render only when the server offers them (canLucky / canChaos non-null)", () => {
    const h = makeHarness();
    h.show(table());
    expect(h.pane.querySelector(".wx-srv-ck-lucky")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-chaos")).toBeNull();
    h.show(table({ canLucky: true, canChaos: true }));
    expect(button(h, ".wx-srv-ck-lucky").textContent).toBe("🪙 Lucky dip");
    expect(button(h, ".wx-srv-ck-lucky").disabled).toBe(false);
    expect(button(h, ".wx-srv-ck-chaos").textContent).toBe("🌋 Chaos shelf (once)");
    expect(button(h, ".wx-srv-ck-chaos").disabled).toBe(false);
    h.show(table({ canLucky: true }));
    expect(h.pane.querySelector(".wx-srv-ck-lucky")).not.toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-chaos")).toBeNull();
  });

  it("are disabled when the server says no, and the chaos shelf reads 'used' once spent", () => {
    const h = makeHarness();
    h.show(table({ canLucky: false, canChaos: false }));
    expect(button(h, ".wx-srv-ck-lucky").disabled).toBe(true);
    expect(button(h, ".wx-srv-ck-chaos").disabled).toBe(true);
    expect(button(h, ".wx-srv-ck-chaos").textContent).toBe("🌋 Chaos shelf (once)");
    h.show(table({ canLucky: true, canChaos: false }, {}, { you: { slot: 1, chaosUsed: true, vetoUsed: false } }));
    expect(button(h, ".wx-srv-ck-chaos").textContent).toBe("🌋 Chaos shelf used");
    expect(button(h, ".wx-srv-ck-chaos").disabled).toBe(true);
  });

  it("the waiting player and a non-player never get them", () => {
    const h = makeHarness();
    h.show(table({ canLucky: true, canChaos: true }, { you: 2 }));
    expect(h.pane.querySelector(".wx-srv-ck-lucky")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-chaos")).toBeNull();
    h.show(table({ canLucky: true, canChaos: true }, { you: null }));
    expect(h.pane.querySelector(".wx-srv-ck-lucky")).toBeNull();
  });

  it("a lucky dip sends the turn, the offer and BOTH ids on screen with a fresh move id", async () => {
    const h = makeHarness();
    h.show(table({ canLucky: true, canChaos: true }));
    h.api.lucky.mockResolvedValue(h.ok(twistPicking({ you: 1, turn: 2, showOptions: false, p1Picks: [pick(RIBEYE, 1, "lucky")] })));
    button(h, ".wx-srv-ck-lucky").click();
    expect(h.api.lucky).toHaveBeenCalledWith(41, { moveId: "move-1", turn: 1, offer: 0, optionIds: ["ribeye-steak", "salmon-fillet"] });
    expect(button(h, ".wx-srv-ck-lucky").textContent).toBe("Flipping…");
    expect(button(h, ".wx-srv-ck-lucky").disabled).toBe(true);
    await settle();
  });

  it("plays the coin flip after the answer, naming what the coin chose, and the coin goes away", async () => {
    const h = makeHarness();
    h.show(table({ canLucky: true }));
    const fx = q(h.pane, ".wx-srv-ck-fx");
    expect(fx.hidden).toBe(true);
    h.api.lucky.mockResolvedValue(h.ok(twistPicking({ you: 1, turn: 2, showOptions: false, p1Picks: [pick(RIBEYE, 1, "lucky")] })));
    button(h, ".wx-srv-ck-lucky").click();
    await settle();
    expect(fx.hidden).toBe(false);
    expect(fx.querySelector(".wx-srv-ck-fx-coin")).not.toBeNull();
    expect(q(fx, ".wx-srv-ck-fx-words").textContent).toBe("The coin chose Ribeye steak");
    expect(h.pane.querySelector(".wx-srv-ck-toast:not([hidden])")).toBeNull();
    for (const cb of [...h.clock.timeouts.values()]) cb();
    expect(fx.hidden).toBe(true);
    expect(fx.childElementCount).toBe(0);
  });

  it("skips the animation under reduced motion and toasts the answer instead", async () => {
    const h = makeHarness({ reducedMotion: true });
    h.show(table({ canLucky: true }));
    h.api.lucky.mockResolvedValue(h.ok(twistPicking({ you: 1, turn: 2, showOptions: false, p1Picks: [pick(RIBEYE, 1, "lucky")] })));
    button(h, ".wx-srv-ck-lucky").click();
    await settle();
    expect(q(h.pane, ".wx-srv-ck-fx").hidden).toBe(true);
    const toast = q(h.pane, ".wx-srv-ck-toast");
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toBe("🪙 The coin chose Ribeye steak ✓");
  });

  it("a chaos shelf sends both ids too, and the new pair is marked exotic", async () => {
    const h = makeHarness();
    h.show(table({ canChaos: true, canLucky: true }));
    h.api.chaos.mockResolvedValue(h.ok(table({ options: [DURIAN, NATTO], chaosPair: true, canChaos: false, canLucky: true }, {}, { you: { slot: 1, chaosUsed: true, vetoUsed: false } })));
    button(h, ".wx-srv-ck-chaos").click();
    expect(h.api.chaos).toHaveBeenCalledWith(41, { moveId: "move-1", turn: 1, offer: 0, optionIds: ["ribeye-steak", "salmon-fillet"] });
    await settle();
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("🌋 Two from the chaos shelf — dare you?");
    expect(qa(h.pane, ".wx-srv-ck-opt").map((c) => c.dataset["ingredient"])).toEqual(["fresh-durian", "fermented-natto"]);
    expect(qa(h.pane, ".wx-srv-ck-opt-exotic")).toHaveLength(2);
    expect(h.pane.querySelector(".wx-srv-ck-pair-chaos")).not.toBeNull();
    expect(q(h.pane, ".wx-srv-ck-chaos-note").textContent).toBe("🌋 Straight from the chaos shelf — dare you?");
    expect(button(h, ".wx-srv-ck-chaos").textContent).toBe("🌋 Chaos shelf used");
  });

  it("the watching partner sees the chaos pair worded for them, with no buttons of the active player's", () => {
    const h = makeHarness();
    h.show(table({ chaosPair: true, options: [DURIAN, NATTO], canVeto: true }, { you: 2 }, { you: YOU_2 }));
    expect(q(h.pane, ".wx-srv-ck-chaos-note").textContent).toBe("🌋 A pair from the chaos shelf!");
    expect(qa(h.pane, ".wx-srv-ck-opt-exotic")).toHaveLength(2);
    expect(h.pane.querySelector(".wx-srv-ck-chaos")).toBeNull();
  });

  it("a table that is not exotic has no chaos note", () => {
    const h = makeHarness();
    h.show(table({ chaosPair: false, canChaos: true }));
    expect(h.pane.querySelector(".wx-srv-ck-chaos-note")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-opt-exotic")).toBeNull();
  });

  it("a refused twist says why in plain words and re-reads the round", async () => {
    const h = makeHarness();
    h.show(table({ canChaos: true }));
    h.api.chaos.mockResolvedValue({ ok: false, kind: "token_used" });
    button(h, ".wx-srv-ck-chaos").click();
    await settle();
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("You've already used that once this game.");
  });
});

describe("the sweep (Open mode)", () => {
  it("the waiting partner sees '🧹 Sweep it (once)' on each card", () => {
    const h = makeHarness();
    h.show(table({ canVeto: true }, { you: 2 }, { you: YOU_2 }));
    const sweeps = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-sweep");
    expect(sweeps).toHaveLength(2);
    expect(sweeps.map((s) => s.textContent)).toEqual(["🧹 Sweep it (once)", "🧹 Sweep it (once)"]);
    expect(sweeps.every((s) => !s.disabled)).toBe(true);
    // They sit with the two cards, which are read-only for the watcher.
    expect(qa(h.pane, "div.wx-srv-ck-opt")).toHaveLength(2);
  });

  it("a sweep sends the card's ingredient id with the table it saw", async () => {
    const h = makeHarness();
    h.show(table({ canVeto: true }, { you: 2, turn: 3, offerIndex: 1, options: [SALMON, LENTILS] }, { you: YOU_2 }));
    h.api.veto.mockResolvedValue(h.ok(table({ canVeto: false, options: [SALMON, TOAST] }, { you: 2, turn: 3, offerIndex: 1 }, { you: { slot: 2, chaosUsed: false, vetoUsed: true } })));
    qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-sweep")[1]?.click();
    expect(h.api.veto).toHaveBeenCalledWith(41, { moveId: "move-1", turn: 3, offer: 1, ingredientId: "red-lentils" });
    await settle();
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("🧹 Red lentils swept off the table");
    // Spent now: the buttons are still there but disabled and say so.
    const after = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-sweep");
    expect(after.map((s) => s.textContent)).toEqual(["🧹 Sweep used", "🧹 Sweep used"]);
    expect(after.every((s) => s.disabled)).toBe(true);
  });

  it("is disabled when the server says canVeto is false, and absent when it is null", () => {
    const h = makeHarness();
    h.show(table({ canVeto: false }, { you: 2 }, { you: YOU_2 }));
    expect(qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-sweep").every((s) => s.disabled)).toBe(true);
    h.show(table({ canVeto: null }, { you: 2 }, { you: YOU_2 }));
    expect(h.pane.querySelector(".wx-srv-ck-sweep")).toBeNull();
  });

  it("the active player and a non-player have no sweep", () => {
    const h = makeHarness();
    h.show(table({ canVeto: true }, { you: 1 }));
    expect(h.pane.querySelector(".wx-srv-ck-sweep")).toBeNull();
    h.show(table({ canVeto: true }, { you: null }));
    expect(h.pane.querySelector(".wx-srv-ck-sweep")).toBeNull();
  });

  it("the active player sees who swept what off their table", () => {
    const h = makeHarness();
    h.show(table({ vetoed: { snap: SALMON }, options: [RIBEYE, LENTILS] }));
    const banner = q(h.pane, ".wx-srv-ck-swept");
    expect(banner.textContent).toContain("Cupcake swept Salmon fillet off your table");
    expect(q(banner, ".wx-srv-ck-swept-name").textContent).toBe("Salmon fillet");
    expect(qa(h.pane, ".wx-srv-ck-opt").map((c) => c.dataset["ingredient"])).toEqual(["ribeye-steak", "red-lentils"]);
  });
});

describe("starters", () => {
  const withStarters = (): Json =>
    twistPicking(
      { you: 1, turn: 5, p1Picks: [pick(TOMATOES, 1, "seed"), pick(PARSLEY, 3)], p2Picks: [pick(NATTO, 2, "seed"), pick(RIBEYE, 4)] },
      {
        setup: setup({ fridgeRaid: true, encore: { kind: "remix", fromSeq: 30, fromTitle: "Lentil Traybake" } }),
        starters: [pick(TOMATOES, 1, "seed"), pick(NATTO, 2, "seed")],
      },
    );

  it("pills carry a Starter title and a starter class; a normal pick has neither", () => {
    const h = makeHarness();
    h.show(withStarters());
    const starterPills = qa(h.pane, ".wx-srv-ck-pill-starter");
    expect(starterPills.map((p) => p.title)).toEqual(["Starter: Cherry tomatoes", "Starter: Fermented natto"]);
    expect(q(h.pane, '.wx-srv-ck-pills[data-slot="1"]').querySelectorAll(".wx-srv-ck-pill-full")).toHaveLength(2);
    expect(qa(h.pane, ".wx-srv-ck-pill-full").filter((p) => !p.classList.contains("wx-srv-ck-pill-starter"))).toHaveLength(2);
  });

  it("during the draft only the table's option cards carry data-ingredient: a basket chip never looks like an option", () => {
    const h = makeHarness();
    h.show(withStarters());
    expect(qa(h.pane, ".wx-srv-ck-chip-ing").length).toBeGreaterThan(0);
    const marked = qa(h.pane, "[data-ingredient]");
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((e) => e.classList.contains("wx-srv-ck-opt"))).toBe(true);
    // A pick already in the basket is not on the table any more (the browser test's "it left the table").
    expect(h.pane.querySelector('[data-ingredient="parsley"], [data-ingredient="flat-leaf-parsley"]')).toBeNull();
  });

  it("the fridge raid's turn-1 starter reads 🧊 and an encore's reads 🔁", () => {
    const h = makeHarness();
    const view = h.show(withStarters());
    expect(view.starters.map((s) => viaBadge(view, s))).toEqual(["🧊 Starter", "🔁 Starter"]);
    expect(qa(h.pane, ".wx-srv-ck-chip-badge").map((b) => b.textContent)).toEqual(["🧊 Starter", "🔁 Starter"]);
    expect(q(h.pane, '.wx-srv-ck-chip-ing[data-picked="cherry-tomatoes"]').classList.contains("wx-srv-ck-chip-seed")).toBe(true);
  });

  it("the header names the round's twists as chips", () => {
    const h = makeHarness();
    h.show(withStarters());
    expect(qa(h.pane, ".wx-srv-ck-rule-chip .wx-srv-ck-rule-text").map((c) => c.textContent)).toEqual(["Fridge raid", "Remix of Lentil Traybake"]);
  });

  it("in a Blind round the partner's starter is public but their drafted picks stay counted secrets", () => {
    const h = makeHarness();
    h.show(
      twistPicking(
        { blind: true, you: 1, turn: 5, p2Picks: null, p2Count: 2, p1Picks: [pick(TOMATOES, 1, "seed"), pick(PARSLEY, 3)] },
        { setup: setup({ fridgeRaid: true, encore: { kind: "leftovers", fromSeq: 30, fromTitle: null } }), starters: [pick(TOMATOES, 1, "seed"), pick(NATTO, 2, "seed")] },
      ),
    );
    const partnerRow = qa(h.pane, ".wx-srv-ck-tray-row")[1] as HTMLElement;
    expect(partnerRow.textContent).toContain("Fermented natto");
    expect(partnerRow.querySelectorAll(".wx-srv-ck-chip-secret")).toHaveLength(1);
    expect(h.pane.textContent).not.toContain("Fresh durian");
  });
});

describe("secret stars and the chef gate", () => {
  const gateStars = (patch: Json = {}): Json => gated(["stars"], { setup: setup({ stars: true }), stars: stars(patch) });

  it("asks you to star one of your five picks, and shows a toggle on your own picks only", () => {
    const h = makeHarness();
    h.show(gateStars());
    expect(q(h.pane, ".wx-srv-ck-gate-text").textContent).toBe("Star one of your five picks — the chef will make it a hero");
    const toggles = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-star");
    expect(toggles).toHaveLength(5);
    expect(toggles.map((t) => t.closest<HTMLElement>("[data-picked]")?.dataset["picked"])).toEqual([
      "thick-white-toast",
      "flat-leaf-parsley",
      "double-espresso",
      "smoked-paprika",
      "tinned-baked-beans",
    ]);
    expect(toggles.every((t) => t.textContent === "☆" && !t.disabled)).toBe(true);
    expect(q(h.pane, ".wx-srv-ck-gate-sub").textContent).toBe("Tap ☆ on one of your picks above.");
  });

  it("tapping a ☆ sends star(seq, ingredientId)", async () => {
    const h = makeHarness();
    h.show(gateStars());
    h.api.star.mockResolvedValue(h.ok(gated(["stars"], { setup: setup({ stars: true }), stars: stars({ mine: "double-espresso" }) })));
    qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-star")[2]?.click();
    expect(h.api.star).toHaveBeenCalledWith(41, "double-espresso");
    await settle();
    // Now yours is starred, and the gate waits for the partner.
    const on = q(h.pane, ".wx-srv-ck-star-on");
    expect(on.textContent).toBe("★");
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(q(h.pane, ".wx-srv-ck-gate-text").textContent).toBe("Waiting for Cupcake to star one");
  });

  it("a starred toggle does nothing when tapped again", () => {
    const h = makeHarness();
    h.show(gateStars({ mine: "double-espresso" }));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-star-on").click();
    expect(h.api.star).not.toHaveBeenCalled();
  });

  it("the gate banner reads differently for a non-player, and there is no toggle", () => {
    const h = makeHarness();
    h.show({ ...gateStars(), you: null });
    expect(q(h.pane, ".wx-srv-ck-gate-text").textContent).toBe("Waiting for the secret stars");
    expect(h.pane.querySelector(".wx-srv-ck-star")).toBeNull();
  });

  it("the words come from starsGateText for each viewer", () => {
    expect(starsGateText(v(gateStars()), "Cupcake")).toBe("⭐ Star one of your five picks — the chef will make it a hero");
    expect(starsGateText(v(gateStars({ mine: "double-espresso" })), "Cupcake")).toBe("Waiting for Cupcake to star one");
    expect(starsGateText(v(twistFinished()), "Cupcake")).toBe("");
  });

  it("nothing can be starred or re-starred once the stars are revealed, and both stars show as ★", () => {
    const h = makeHarness();
    h.show(ready({ setup: setup({ stars: true }), stars: stars({ mine: "double-espresso", partnerChosen: true, revealed: true, partner: "ribeye-steak" }) }));
    // Spec 09a §9: the toggles are disabled once revealed (a locked commitment). A toggle that is not drawn
    // at all cannot be tapped either, so the invariant is: whatever toggle exists is disabled.
    const toggles = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-star");
    expect(toggles.every((t) => t.disabled)).toBe(true);
    for (const t of toggles) t.click();
    expect(h.api.star).not.toHaveBeenCalled();
    const ownChip = q(h.pane, '.wx-srv-ck-reveal-chip[data-picked="double-espresso"]');
    expect(ownChip.classList.contains("wx-srv-ck-chip-starred")).toBe(true);
    expect(ownChip.querySelector(".wx-srv-ck-star-mark, .wx-srv-ck-star-on")?.textContent).toBe("★");
    const partnerChip = q(h.pane, '.wx-srv-ck-reveal-chip[data-picked="ribeye-steak"]');
    expect(partnerChip.classList.contains("wx-srv-ck-chip-starred")).toBe(true);
    expect(partnerChip.querySelector(".wx-srv-ck-star-mark")?.textContent).toBe("★");
    expect(partnerChip.querySelector("button")).toBeNull();
    // Nobody else's pick is starred.
    expect(qa(h.pane, ".wx-srv-ck-reveal-chip.wx-srv-ck-chip-starred")).toHaveLength(2);
    expect(h.pane.querySelector(".wx-srv-ck-stars-revealed")).not.toBeNull();
  });
});

describe("the wildcard cloche", () => {
  const offered = (): Json => gated(["wildcard"], { setup: setup({ wildcard: true }), wildcard: { state: "offered", ingredient: null } });

  it("is a card with Lift it! and No thanks, and Lift it! calls wildcard(seq, moveId, true)", async () => {
    const h = makeHarness();
    h.show(offered());
    expect(q(h.pane, ".wx-srv-ck-cloche-gate .wx-srv-ck-gate-text").textContent).toBe("Lift the cloche? One surprise 11th ingredient");
    expect(button(h, ".wx-srv-ck-lift").textContent).toBe("Lift it!");
    expect(button(h, ".wx-srv-ck-decline").textContent).toBe("No thanks — start cooking");
    h.api.wildcard.mockResolvedValue(
      h.ok(twistFinished({ concepts: "pending", images: "none" }, { setup: setup({ wildcard: true }), wildcard: { state: "lifted", ingredient: LENTILS }, basket: [pick(LENTILS, null, "wildcard")] })),
    );
    button(h, ".wx-srv-ck-lift").click();
    expect(h.api.wildcard).toHaveBeenCalledWith(41, "move-1", true);
    expect(button(h, ".wx-srv-ck-lift").textContent).toBe("Lifting…");
    await settle();
    // The lid lifts over the pane on the returned ingredient.
    const fx = q(h.pane, ".wx-srv-ck-fx");
    expect(fx.hidden).toBe(false);
    expect(fx.querySelector(".wx-srv-ck-fx-lid")).not.toBeNull();
    expect(q(fx, ".wx-srv-ck-fx-words").textContent).toBe("Under the lid: Red lentils!");
    // The gate is gone: the chef is working.
    expect(h.pane.querySelector(".wx-srv-ck-cloche-gate")).toBeNull();
  });

  it("a dish that uses all eleven (the cloche's best case) shows every chip, its stars, and Uses 11/11", () => {
    const h = makeHarness();
    const eleven = [...(CONCEPTS[0]!["pickedIngredients"] as Json[]), BEANS, MISO, LENTILS];
    const basket = [...P1_PICKS.map((s, i) => pick(s, i * 2 + 1)), ...P2_PICKS.map((s, i) => pick(s, i * 2 + 2)), pick(LENTILS, null, "wildcard")];
    h.show(
      twistFinished(
        {},
        {
          setup: setup({ wildcard: true, stars: true }),
          wildcard: { state: "lifted", ingredient: LENTILS },
          stars: stars({ enabled: true, mine: TOAST["id"], partnerChosen: true, revealed: true, partner: RIBEYE["id"] }),
          basket,
          concepts: { state: "ready", data: [{ ...CONCEPTS[0]!, pickedIngredients: eleven, omitted: [] }, CONCEPTS[1], CONCEPTS[2]], error: null },
        },
      ),
    );
    const dish = q(h.pane, ".wx-srv-ck-dish[data-concept='a']");
    expect(q(dish, ".wx-srv-ck-uses-count").textContent).toBe("Uses 11/11");
    expect(qa(dish, ".wx-srv-ck-uses-chips > *")).toHaveLength(11);
    expect(qa(dish, ".wx-srv-ck-uses-chips .wx-srv-ck-chip-starred")).toHaveLength(2);
  });

  it("a tap again after a lost answer resends the SAME move id (the lid may already be up); a refused one starts afresh", async () => {
    const h = makeHarness();
    h.show(offered());
    h.api.wildcard.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    button(h, ".wx-srv-ck-lift").click();
    await settle();
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("Couldn't reach the kitchen — try again.");
    h.api.wildcard.mockResolvedValueOnce({ ok: false, kind: "bad_state" });
    button(h, ".wx-srv-ck-lift").click();
    expect(h.api.wildcard).toHaveBeenLastCalledWith(41, "move-1", true);
    await settle();
    // A definite answer settles that move: the next tap is a new one.
    h.api.wildcard.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    button(h, ".wx-srv-ck-lift").click();
    expect(h.api.wildcard).toHaveBeenLastCalledWith(41, "move-2", true);
    await settle();
    // The other answer is a different move.
    h.api.wildcard.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    button(h, ".wx-srv-ck-decline").click();
    expect(h.api.wildcard).toHaveBeenLastCalledWith(41, "move-3", false);
    await settle();
  });

  it("a lock forgets a move still waiting for its answer: the next tap after unlocking is a new move", async () => {
    const h = makeHarness();
    h.show(offered());
    h.api.wildcard.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    button(h, ".wx-srv-ck-lift").click();
    await settle();
    h.tabs.reset();
    h.game.forgetAll();
    h.show(offered());
    h.api.wildcard.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    button(h, ".wx-srv-ck-lift").click();
    expect(h.api.wildcard.mock.calls.map((c: unknown[]) => c[1])).toEqual(["move-1", "move-2"]);
    await settle();
  });

  it("No thanks calls wildcard(seq, moveId, false)", async () => {
    const h = makeHarness();
    h.show(offered());
    h.api.wildcard.mockResolvedValue(h.ok(twistFinished({ concepts: "pending", images: "none" }, { setup: setup({ wildcard: true }), wildcard: { state: "declined", ingredient: null } })));
    button(h, ".wx-srv-ck-decline").click();
    expect(h.api.wildcard).toHaveBeenCalledWith(41, "move-1", false);
    await settle();
    expect(h.pane.querySelector(".wx-srv-ck-cloche-gate")).toBeNull();
    expect(q(h.pane, ".wx-srv-ck-fx").hidden).toBe(true);
  });

  it("under reduced motion the lid is a toast", async () => {
    const h = makeHarness({ reducedMotion: true });
    h.show(offered());
    h.api.wildcard.mockResolvedValue(
      h.ok(twistFinished({ concepts: "pending", images: "none" }, { setup: setup({ wildcard: true }), wildcard: { state: "lifted", ingredient: LENTILS }, basket: [pick(LENTILS, null, "wildcard")] })),
    );
    button(h, ".wx-srv-ck-lift").click();
    await settle();
    expect(q(h.pane, ".wx-srv-ck-fx").hidden).toBe(true);
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("🛎️ Under the lid: Red lentils!");
  });

  it("with nothing left to draw, 'No thanks' is still the way on", async () => {
    const h = makeHarness();
    h.show(offered());
    h.api.wildcard.mockResolvedValue({ ok: false, kind: "exhausted" });
    button(h, ".wx-srv-ck-lift").click();
    await settle();
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("The pantry has no surprise left under the lid — “No thanks” starts the cooking.");
    expect(button(h, ".wx-srv-ck-decline").disabled).toBe(false);
  });

  it("a non-player sees the cloche but cannot lift it", () => {
    const h = makeHarness();
    h.show({ ...offered(), you: null });
    expect(h.pane.querySelector(".wx-srv-ck-cloche-gate")).not.toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-lift")).toBeNull();
  });

  it("the wildcard shows in the basket with its badge, and is never starrable", () => {
    const h = makeHarness();
    const view = h.show(
      twistFinished({ concepts: "pending", images: "none" }, {
        setup: setup({ wildcard: true, stars: true }),
        wildcard: { state: "lifted", ingredient: LENTILS },
        stars: stars({ mine: "double-espresso" }),
        basket: [pick(TOAST, 1), pick(LENTILS, null, "wildcard")],
      }),
    );
    const wild = view.basket?.[1];
    if (wild === undefined) throw new Error("fixture");
    expect(viaBadge(view, wild)).toBe("🛎️ Wildcard");
    // The basket section is drawn from the server's effective basket: the wildcard is there, with no ☆ on it.
    const chip = q(h.pane, '.wx-srv-ck-reveal-chip[data-picked="red-lentils"]');
    expect(q(chip, ".wx-srv-ck-chip-badge").textContent).toBe("🛎️ Wildcard");
    expect(chip.querySelector(".wx-srv-ck-star")).toBeNull();
  });
});

describe("the dinner vote", () => {
  it("every dish has a vote button that sends vote(seq, generation, conceptId)", async () => {
    const h = makeHarness();
    h.show(ready({ vote: readyVote() }));
    const votes = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-vote");
    expect(votes).toHaveLength(3);
    expect(votes[0]?.textContent).toBe("🍽️ I'd eat this tonight");
    expect(q(h.pane, ".wx-srv-ck-vote-banner").textContent).toBe("🍽️ Which would you actually eat tonight? Tap one — it stays secret until you've both chosen.");
    h.api.vote.mockResolvedValue(h.ok(ready({ vote: readyVote({ you: "b" }) })));
    votes[1]?.click();
    expect(h.api.vote).toHaveBeenCalledWith(41, 1, "b");
    await settle();
    const mine = q<HTMLButtonElement>(h.pane, ".wx-srv-ck-vote-mine");
    expect(mine.textContent).toBe("✓ You'd eat this tonight");
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    expect(q(h.pane, ".wx-srv-ck-vote-banner").textContent).toBe("🍽️ Your vote is in (secret). Waiting for Cupcake…");
  });

  it("names the dish set of the view the button was drawn from, even if the view moved on before the tap", async () => {
    const h = makeHarness();
    h.show(ready({ generation: 2, vote: readyVote() }));
    expect(qa(h.pane, ".wx-srv-ck-dish").map((c) => c.dataset["generation"])).toEqual(["2", "2", "2"]);
    const stale = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-vote")[2];
    // The round moves on (another swap) and the cards are redrawn for generation 3 ...
    h.show(ready({ generation: 3, vote: readyVote() }));
    expect(qa(h.pane, ".wx-srv-ck-dish").map((c) => c.dataset["generation"])).toEqual(["3", "3", "3"]);
    expect(stale?.isConnected).toBe(false);
    // ... but a tap on the button drawn for generation 2 still says 2, never the latest.
    stale?.click();
    expect(h.api.vote).toHaveBeenCalledWith(41, 2, "c");
    await settle();
    // And a fresh tap on the new card names 3.
    qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-vote")[0]?.click();
    expect(h.api.vote).toHaveBeenLastCalledWith(41, 3, "a");
  });

  it("a generation-2 render sends generation 2", () => {
    const h = makeHarness();
    h.show(ready({ generation: 2, vote: readyVote() }));
    qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-vote")[0]?.click();
    expect(h.api.vote).toHaveBeenCalledWith(41, 2, "a");
  });

  it("a non-player has no vote buttons", () => {
    const h = makeHarness();
    h.show(ready({ you: null, vote: readyVote({ partnerVoted: true }) }));
    expect(h.pane.querySelector(".wx-srv-ck-vote")).toBeNull();
    expect(q(h.pane, ".wx-srv-ck-vote-banner").textContent).toBe("🍽️ The dinner vote is under way…");
  });

  it("on the reveal each dish shows its voters' badges", () => {
    const h = makeHarness();
    const view = h.show(ready({ vote: readyVote({ you: "a", partnerVoted: true, revealed: true, votes: { "1": "a", "2": "b" } }) }));
    expect(qa(q(h.pane, '.wx-srv-ck-dish[data-concept="a"]'), ".wx-srv-ck-voter").map((b) => b.textContent)).toEqual(["🍽️ You"]);
    expect(qa(q(h.pane, '.wx-srv-ck-dish[data-concept="b"]'), ".wx-srv-ck-voter").map((b) => b.textContent)).toEqual(["🍽️ Cupcake"]);
    expect(q(h.pane, '.wx-srv-ck-dish[data-concept="c"]').querySelector(".wx-srv-ck-voter")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-dinner")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-vote")).toBeNull();
    expect(q(h.pane, ".wx-srv-ck-vote-banner").textContent).toBe("🍽️ You'd each eat something different tonight — see the badges.");
    expect(voteBannerText(view, "Cupcake")).toBe("🍽️ You'd each eat something different tonight — see the badges.");
  });

  it("a match crowns the dish with '🎯 Tonight's dinner!'", () => {
    const h = makeHarness();
    h.show(ready({ vote: readyVote({ you: "b", partnerVoted: true, revealed: true, votes: { "1": "b", "2": "b" } }) }));
    const winner = q(h.pane, '.wx-srv-ck-dish[data-concept="b"]');
    expect(q(winner, ".wx-srv-ck-dinner").textContent).toBe("🎯 Tonight's dinner!");
    expect(winner.classList.contains("wx-srv-ck-dish-dinner")).toBe(true);
    expect(h.pane.querySelectorAll(".wx-srv-ck-dinner")).toHaveLength(1);
    expect(h.pane.querySelector(".wx-srv-ck-voter")).toBeNull();
    expect(q(h.pane, ".wx-srv-ck-vote-banner").textContent).toBe("🎯 Tonight's dinner: Smoky Gruyère & Broccoli Toastie Bake!");
  });
});

describe("the rescue swap", () => {
  const STARRED = stars({ mine: "thick-white-toast", partnerChosen: true, revealed: true, partner: "ribeye-steak" });

  it("opens from the 🔄 button; the chooser lists the basket and disables the two stars", async () => {
    const h = makeHarness();
    h.show(ready({ setup: setup({ stars: true }), stars: STARRED, swap: swap({ available: true }) }));
    expect(button(h, ".wx-srv-ck-rescue").textContent).toBe("🔄 Rescue swap (once)");
    button(h, ".wx-srv-ck-rescue").click();
    const items = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-swap-item");
    expect(items).toHaveLength(10);
    expect(items.filter((i) => i.disabled).map((i) => i.dataset["ingredient"])).toEqual(["thick-white-toast", "ribeye-steak"]);
    // Nothing chosen yet: the send button says so and is off.
    const send = button(h, ".wx-srv-ck-swap-send");
    expect(send.textContent).toBe("Choose one to send back");
    expect(send.disabled).toBe(true);
    // A starred item cannot be picked.
    qa<HTMLButtonElement>(h.pane, '.wx-srv-ck-swap-item[data-ingredient="ribeye-steak"]')[0]?.click();
    expect(button(h, ".wx-srv-ck-swap-send").disabled).toBe(true);
  });

  it("choose → 'Send back X' → proposeSwap, then a waiting state with Cancel (cancelSwap)", async () => {
    const h = makeHarness();
    h.show(ready({ swap: swap({ available: true }) }));
    button(h, ".wx-srv-ck-rescue").click();
    q<HTMLButtonElement>(h.pane, '.wx-srv-ck-swap-item[data-ingredient="flat-leaf-parsley"]').click();
    expect(button(h, ".wx-srv-ck-swap-send").textContent).toBe("Send back Flat-leaf parsley");
    expect(button(h, ".wx-srv-ck-swap-send").disabled).toBe(false);
    h.api.proposeSwap.mockResolvedValue(h.ok(ready({ swap: swap({ state: "proposed", by: 1, out: PARSLEY }) })));
    button(h, ".wx-srv-ck-swap-send").click();
    expect(h.api.proposeSwap).toHaveBeenCalledWith(41, "move-1", "flat-leaf-parsley");
    await settle();
    expect(q(h.pane, ".wx-srv-ck-swap-text").textContent).toBe("You're sending back Flat-leaf parsley. Waiting for Cupcake to choose a replacement…");
    expect(h.pane.querySelector(".wx-srv-ck-swap-item")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-rescue")).toBeNull();
    expect(button(h, ".wx-srv-ck-swap-cancel").textContent).toBe("Cancel");
    h.api.cancelSwap.mockResolvedValue(h.ok(ready({ swap: swap({ available: true }) })));
    button(h, ".wx-srv-ck-swap-cancel").click();
    expect(h.api.cancelSwap).toHaveBeenCalledWith(41);
    await settle();
    expect(h.pane.querySelector(".wx-srv-ck-swap-cancel")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-rescue")).not.toBeNull();
  });

  it("'Never mind' closes the chooser without a call", () => {
    const h = makeHarness();
    h.show(ready({ swap: swap({ available: true }) }));
    button(h, ".wx-srv-ck-rescue").click();
    button(h, ".wx-srv-ck-swap-cancel").click();
    expect(h.api.proposeSwap).not.toHaveBeenCalled();
    expect(h.pane.querySelector(".wx-srv-ck-swap-item")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-rescue")).not.toBeNull();
  });

  it("no swap button when the server does not offer one, or to a non-player", () => {
    const h = makeHarness();
    h.show(ready({ swap: swap({ available: false }) }));
    expect(h.pane.querySelector(".wx-srv-ck-rescue")).toBeNull();
    h.show(ready({ you: null, swap: swap({ available: true }) }));
    expect(h.pane.querySelector(".wx-srv-ck-rescue")).toBeNull();
  });

  it("the partner sees who wants to send back what, two replacements and Keep these dishes", async () => {
    const h = makeHarness();
    h.show(ready({ you: YOU_2, swap: swap({ state: "proposed", by: 1, out: PARSLEY, pair: [LENTILS, TOMATOES] }) }));
    expect(q(h.pane, ".wx-srv-ck-swap-text").textContent).toBe("Josh wants to send back Flat-leaf parsley. Choose a replacement:");
    const options = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-swap-pair button.wx-srv-ck-opt");
    expect(options.map((o) => o.dataset["ingredient"])).toEqual(["red-lentils", "cherry-tomatoes"]);
    expect(button(h, ".wx-srv-ck-swap-keep").textContent).toBe("Keep these dishes");
    h.api.chooseSwap.mockResolvedValue(h.ok(ready({ generation: 2, you: YOU_2, swap: swap({ state: "done", by: 1, out: PARSLEY, in: TOMATOES }) })));
    options[1]?.click();
    expect(h.api.chooseSwap).toHaveBeenCalledWith(41, "move-1", "cherry-tomatoes");
    await settle();
    expect(h.pane.querySelector(".wx-srv-ck-swap-pair")).toBeNull();
  });

  it("sending back and choosing keep ONE move id across a tap again after a lost answer", async () => {
    const h = makeHarness();
    h.show(ready({ swap: swap({ available: true }) }));
    button(h, ".wx-srv-ck-rescue").click();
    q<HTMLButtonElement>(h.pane, '.wx-srv-ck-swap-item[data-ingredient="flat-leaf-parsley"]').click();
    h.api.proposeSwap.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    button(h, ".wx-srv-ck-swap-send").click();
    await settle();
    h.api.proposeSwap.mockResolvedValueOnce(h.ok(ready({ swap: swap({ state: "proposed", by: 1, out: PARSLEY }) })));
    button(h, ".wx-srv-ck-swap-send").click();
    expect(h.api.proposeSwap.mock.calls.map((c: unknown[]) => c[1])).toEqual(["move-1", "move-1"]);
    await settle();

    const p = makeHarness();
    p.show(ready({ you: YOU_2, swap: swap({ state: "proposed", by: 1, out: PARSLEY, pair: [LENTILS, TOMATOES] }) }));
    p.api.chooseSwap.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    qa<HTMLButtonElement>(p.pane, ".wx-srv-ck-swap-pair button.wx-srv-ck-opt")[1]?.click();
    await settle();
    p.api.chooseSwap.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    qa<HTMLButtonElement>(p.pane, ".wx-srv-ck-swap-pair button.wx-srv-ck-opt")[1]?.click();
    await settle();
    // The other replacement is a different move.
    p.api.chooseSwap.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    qa<HTMLButtonElement>(p.pane, ".wx-srv-ck-swap-pair button.wx-srv-ck-opt")[0]?.click();
    await settle();
    expect(p.api.chooseSwap.mock.calls.map((c: unknown[]) => [c[1], c[2]])).toEqual([
      ["move-1", "cherry-tomatoes"],
      ["move-1", "cherry-tomatoes"],
      ["move-2", "red-lentils"],
    ]);
  });

  it("Keep these dishes cancels the proposal", () => {
    const h = makeHarness();
    h.show(ready({ you: YOU_2, swap: swap({ state: "proposed", by: 1, out: PARSLEY, pair: [LENTILS, TOMATOES] }) }));
    button(h, ".wx-srv-ck-swap-keep").click();
    expect(h.api.cancelSwap).toHaveBeenCalledWith(41);
  });

  it("a non-player is told a swap is under way, with no choices", () => {
    const h = makeHarness();
    h.show(ready({ you: null, swap: swap({ state: "proposed", by: 1, out: PARSLEY, pair: [LENTILS, TOMATOES] }) }));
    expect(q(h.pane, ".wx-srv-ck-swap-text").textContent).toBe("Josh is swapping out Flat-leaf parsley…");
    expect(h.pane.querySelector(".wx-srv-ck-swap-keep")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-swap-pair")).toBeNull();
  });

  it("afterwards a banner says 'Swapped X → Y'", () => {
    const h = makeHarness();
    h.show(ready({ generation: 2, swap: swap({ state: "done", by: 1, out: PARSLEY, in: LENTILS }) }));
    expect(q(h.pane, ".wx-srv-ck-swapped").textContent).toContain("Swapped Flat-leaf parsley → Red lentils");
    expect(h.pane.querySelector(".wx-srv-ck-rescue")).toBeNull();
  });

  it("while a swap is proposed, Bank and a recipe's Try again are disabled with a reason", () => {
    const h = makeHarness();
    const recipes = recipesNone();
    recipes["b"] = { state: "failed", requestedBy: "Josh", bankedAt: null, error: "timeout", data: null };
    h.show(ready({ recipes, swap: swap({ state: "proposed", by: 1, out: PARSLEY }) }));
    expect(button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-bank').disabled).toBe(true);
    expect(button(h, '.wx-srv-ck-dish[data-concept="c"] .wx-srv-ck-bank').disabled).toBe(true);
    expect(button(h, '.wx-srv-ck-dish[data-concept="b"] .wx-srv-ck-recipe-retry').disabled).toBe(true);
    expect(qa(h.pane, ".wx-srv-ck-bank-frozen").map((n) => n.textContent)).toEqual([
      "Finish or cancel the swap first",
      "Finish or cancel the swap first",
      "Finish or cancel the swap first",
    ]);
    button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-bank').click();
    button(h, '.wx-srv-ck-dish[data-concept="b"] .wx-srv-ck-recipe-retry').click();
    expect(h.api.bank).not.toHaveBeenCalled();
    expect(h.api.retryRecipe).not.toHaveBeenCalled();
  });

  it("they come back when the swap is cancelled", () => {
    const h = makeHarness();
    h.show(ready({ swap: swap({ state: "proposed", by: 1, out: PARSLEY }) }));
    expect(button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-bank').disabled).toBe(true);
    h.show(ready({ swap: swap({ available: true }) }));
    expect(button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-bank').disabled).toBe(false);
    expect(h.pane.querySelector(".wx-srv-ck-bank-frozen")).toBeNull();
  });
});

describe("the generation every Bank and retry names", () => {
  it("Bank, recipe Try again, the chef's Try again and Retry picture send the generation on screen", () => {
    const h = makeHarness();
    const recipes = recipesNone();
    recipes["b"] = { state: "failed", requestedBy: "Josh", bankedAt: null, error: "timeout", data: null };
    h.show(ready({ generation: 2, recipes, images: { state: "failed", pictures: { a: null, b: null, c: null } } }));
    button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-bank').click();
    expect(h.api.bank).toHaveBeenCalledWith(41, "a", "move-1", 2);
    button(h, '.wx-srv-ck-dish[data-concept="b"] .wx-srv-ck-recipe-retry').click();
    expect(h.api.retryRecipe).toHaveBeenCalledWith(41, "b", 2);
    button(h, '.wx-srv-ck-dish[data-concept="c"] .wx-srv-ck-dish-retry').click();
    expect(h.api.retryPictures).toHaveBeenCalledWith(41, 2);
    h.show(twistFinished({ concepts: "failed", images: "none" }, { generation: 2 }));
    button(h, ".wx-srv-ck-retry").click();
    expect(h.api.retryConcepts).toHaveBeenCalledWith(41, 2);
  });

  it("a Bank tap uses the generation of the card it was drawn on, not the latest view", () => {
    const h = makeHarness();
    h.show(ready({ generation: 2 }));
    const stale = button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-bank');
    h.show(ready({ generation: 3 }));
    expect(stale.isConnected).toBe(false);
    stale.click();
    expect(h.api.bank).toHaveBeenCalledWith(41, "a", "move-1", 2);
  });
});

describe("rules badge and the Encore with the leftovers", () => {
  it("a dish shows the challenge, its total time and its note as a small rule badge", () => {
    const h = makeHarness();
    h.show(
      ready({
        setup: setup({ challenge: CHALLENGE_PAN }),
        concepts: {
          state: "ready",
          data: [{ ...CONCEPTS[0], challengeNote: "Everything cooks in one pan", totalMinutes: 28 }, CONCEPTS[1], CONCEPTS[2]],
          error: null,
        },
      }),
    );
    const badge = q(q(h.pane, '.wx-srv-ck-dish[data-concept="a"]'), ".wx-srv-ck-rule");
    expect(q(badge, ".wx-srv-ck-rule-name").textContent).toBe("🍳 One pan only");
    expect(q(badge, ".wx-srv-ck-rule-time").textContent).toBe("⏱️ 28 min");
    expect(q(badge, ".wx-srv-ck-rule-note").textContent).toBe("Everything cooks in one pan");
    // The header chip too.
    expect(q(h.pane, ".wx-srv-ck-rule-challenge .wx-srv-ck-rule-text").textContent).toBe("One pan only");
  });

  describe("the spun style's wheel", () => {
    const spun = (): Json => ready({ setup: setup({ style: STYLE_COSY, styleSpun: true }) });

    function openOnce(h: Harness): void {
      h.model.apply(v({ ...spun(), rev: 200 }));
      h.game.open(41);
    }

    it("lands on the style the server chose, with the style named as spun", () => {
      const h = makeHarness();
      openOnce(h);
      expect(h.pane.querySelector(".wx-srv-ck-wheel")).not.toBeNull();
      expect(qa(h.pane, ".wx-srv-ck-wheel-face").at(-1)?.textContent).toBe("🍺");
      expect(q(h.pane, ".wx-srv-ck-rule-style .wx-srv-ck-rule-text").textContent).toBe("Cosy pub (spun)");
    });

    it("is not cut short by the very next refresh of the same round (a poll or a stream frame)", () => {
      const h = makeHarness();
      openOnce(h);
      expect(h.pane.querySelector(".wx-srv-ck-wheel")).not.toBeNull();
      h.tabs.refresh();
      expect(h.pane.querySelector(".wx-srv-ck-wheel")).not.toBeNull();
    });

    it("plays once per round: coming back to the round later shows the style without the wheel", () => {
      const h = makeHarness();
      openOnce(h);
      h.game.close();
      h.game.open(41);
      expect(h.pane.querySelector(".wx-srv-ck-wheel")).toBeNull();
      expect(q(h.pane, ".wx-srv-ck-rule-style .wx-srv-ck-rule-text").textContent).toBe("Cosy pub (spun)");
    });

    it("a lock forgets which wheels played: after unlocking, the round's wheel lands once more", () => {
      const h = makeHarness();
      openOnce(h);
      h.tabs.reset();
      h.game.forgetAll();
      openOnce(h);
      expect(h.pane.querySelector(".wx-srv-ck-wheel")).not.toBeNull();
    });

    it("never plays under reduced motion", () => {
      const calm = makeHarness({ reducedMotion: true });
      openOnce(calm);
      expect(calm.pane.querySelector(".wx-srv-ck-wheel")).toBeNull();
      expect(q(calm.pane, ".wx-srv-ck-rule-style .wx-srv-ck-rule-text").textContent).toBe("Cosy pub (spun)");
    });

    it("a style the players chose themselves never spins", () => {
      const h = makeHarness();
      h.model.apply(v({ ...ready({ setup: setup({ style: STYLE_COSY }) }), rev: 200 }));
      h.game.open(41);
      expect(h.pane.querySelector(".wx-srv-ck-wheel")).toBeNull();
      expect(q(h.pane, ".wx-srv-ck-rule-style .wx-srv-ck-rule-text").textContent).toBe("Cosy pub");
    });
  });

  it("a dish that left something out offers Encore with the leftovers, which opens the start sheet with them", () => {
    const h = makeHarness();
    h.show(ready());
    button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-dish-more-btn').click();
    button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-dish-menu-item').click();
    expect(h.openStartSheet).toHaveBeenCalledTimes(1);
    const preset = h.openStartSheet.mock.calls[0]?.[0] as { encore: { fromSeq: number; generation: number; conceptId: string; kind: string; title: string; candidates: Array<{ id: string }> } };
    expect(preset.encore).toMatchObject({ fromSeq: 41, generation: 1, conceptId: "a", kind: "leftovers", title: "Espresso-Glazed Ribeye over Crispy Toast" });
    expect(preset.encore.candidates.map((c) => c.id)).toEqual([BEANS["id"], MISO["id"]]);
  });
});

describe("Earlier dishes", () => {
  function swapped(extra: Json = {}): Json {
    return ready({
      generation: 2,
      swap: swap({ state: "done", by: 1, out: PARSLEY, in: LENTILS }),
      recipes: { ...recipesNone(), a: bankedSlot(2) },
      generations: [earlierSet(1, { recipes: { ...recipesNone(), a: bankedSlot(1) } })],
      ...extra,
    });
  }

  it("is a collapsed section that opens to read-only cards with no Bank button", () => {
    const h = makeHarness();
    h.show(swapped());
    const toggle = button(h, ".wx-srv-ck-earlier-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Earlier dishes");
    expect(h.pane.querySelector(".wx-srv-ck-dish-earlier")).toBeNull();
    toggle.click();
    expect(button(h, ".wx-srv-ck-earlier-toggle").getAttribute("aria-expanded")).toBe("true");
    const earlier = q(h.pane, ".wx-srv-ck-earlier");
    expect(qa(earlier, ".wx-srv-ck-dish-earlier").map((c) => c.dataset["concept"])).toEqual(["a", "b", "c"]);
    expect(qa(earlier, ".wx-srv-ck-bank")).toHaveLength(0);
    expect(qa(earlier, ".wx-srv-ck-vote")).toHaveLength(0);
    expect(qa(earlier, ".wx-srv-ck-earlier-state").map((s) => s.textContent)).toEqual(["Not banked", "Not banked"]);
    // The dishes on the table keep theirs.
    expect(qa(h.pane, ".wx-srv-ck-dishes:not(.wx-srv-ck-earlier-dishes) .wx-srv-ck-bank, .wx-srv-ck-dishes:not(.wx-srv-ck-earlier-dishes) .wx-srv-ck-banked").length).toBeGreaterThan(0);
    // And closes again.
    button(h, ".wx-srv-ck-earlier-toggle").click();
    expect(h.pane.querySelector(".wx-srv-ck-dish-earlier")).toBeNull();
  });

  it("a banked earlier recipe opens, and 'We cooked it!' marks THAT recipe (generation 1), not the current one", async () => {
    const h = makeHarness();
    h.show(swapped());
    button(h, ".wx-srv-ck-earlier-toggle").click();
    const open = button(h, '.wx-srv-ck-earlier .wx-srv-ck-dish-earlier[data-concept="a"] .wx-srv-ck-banked');
    expect(open.textContent).toBe("Banked ✓ — View full recipe");
    open.click();
    const recipe = q(h.pane, '.wx-srv-ck-earlier .wx-srv-ck-dish-earlier[data-concept="a"] .wx-srv-ck-recipe');
    expect(recipe.dataset["generation"]).toBe("1");
    h.api.markCooked.mockResolvedValue(h.ok(swapped()));
    q<HTMLButtonElement>(recipe, ".wx-srv-ck-cooked-mark").click();
    expect(h.api.markCooked).toHaveBeenCalledTimes(1);
    expect(h.api.markCooked).toHaveBeenCalledWith(41, 1, "a", true);
    await settle();
  });

  it("the Recipe book's tap on an earlier dish opens the section at its recipe", () => {
    const h = makeHarness();
    h.model.apply(v({ ...swapped(), rev: 500 }));
    h.game.openRecipe(41, "a", 1);
    expect(h.tabs.activeTab()).toBe("cookout");
    expect(button(h, ".wx-srv-ck-earlier-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(h.pane.querySelector('.wx-srv-ck-earlier .wx-srv-ck-dish-earlier[data-concept="a"] .wx-srv-ck-recipe')).not.toBeNull();
    // The current set's recipe stays closed.
    expect(h.pane.querySelector(".wx-srv-ck-dishes:not(.wx-srv-ck-earlier-dishes) .wx-srv-ck-recipe")).toBeNull();
  });

  it("a tap on a current-generation dish opens the current recipe, not the earlier one", () => {
    const h = makeHarness();
    h.model.apply(v({ ...swapped(), rev: 500 }));
    h.game.openRecipe(41, "a", 2);
    expect(h.pane.querySelector(".wx-srv-ck-earlier .wx-srv-ck-recipe")).toBeNull();
    expect(h.pane.querySelector('.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-recipe')?.getAttribute("data-generation")).toBe("2");
  });

  it("the recipe's cookware shows as 'You'll need: …'", () => {
    const h = makeHarness();
    const slot = bankedSlot(1);
    slot["data"] = { ...FULL_RECIPE, cookware: ["Large frying pan", "Tongs"] };
    h.show(ready({ recipes: { ...recipesNone(), a: slot } }));
    button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-banked').click();
    expect(q(h.pane, ".wx-srv-ck-recipe-cookware").textContent).toBe("You'll need: Large frying pan, Tongs");
  });
});

describe("every new control is a gesture boundary", () => {
  it("lucky, chaos, sweep, stars, cloche, votes, swap, earlier dishes and cooked controls all carry data-srv-gesture-boundary", () => {
    const h = makeHarness();
    const views: Json[] = [
      table({ canLucky: true, canChaos: true }),
      table({ canVeto: true }, { you: 2 }, { you: YOU_2 }),
      gated(["stars", "wildcard"], { setup: setup({ stars: true, wildcard: true }), stars: stars(), wildcard: { state: "offered", ingredient: null } }),
      ready({
        generation: 2,
        vote: readyVote(),
        swap: swap({ available: true }),
        recipes: { ...recipesNone(), a: bankedSlot(2, { cooked: { cookedAt: 1, cookedBy: "Josh", ratings: { "1": 3, "2": null }, photo: null, photoMessageSeq: null } }) },
        generations: [earlierSet(1)],
      }),
    ];
    for (const raw of views) {
      h.show(raw);
      if (h.pane.querySelector(".wx-srv-ck-rescue") !== null) button(h, ".wx-srv-ck-rescue").click();
      if (h.pane.querySelector(".wx-srv-ck-earlier-toggle") !== null) button(h, ".wx-srv-ck-earlier-toggle").click();
      if (h.pane.querySelector('.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-banked') !== null) button(h, '.wx-srv-ck-dish[data-concept="a"] .wx-srv-ck-banked').click();
      for (const b of h.pane.querySelectorAll("button")) expect(b.hasAttribute("data-srv-gesture-boundary"), b.className).toBe(true);
    }
  });
});
