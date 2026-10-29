import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bannerName, skipLabel, turnBanner } from "../../src/server/cookout/cookoutGame";
import { makeHarness, pick, q, qa, settle, setup, stars, STYLE_COSY, twistPicking, v, visible, type Json } from "./twistFixtures";
import { P2_PICKS, pickingView, RIBEYE, SALMON, snap } from "./fixtures";

// spec/server-chat/09b-cookout-visual.md §D.3: the picture-first table. One tap on a whole card picks it
// (and disables both); the watcher's cards are not tappable; 🎲 Twists shows only when a drafting twist is
// usable now and opens a sheet; "Sweep one" makes the cards sweep; the Blind partner's turn is the cloche
// with no ingredient text or picture URL in the DOM; progress is one button of passive picture tiles with
// 🔒 for a Blind partner's picks; a new pair is decoded before it swaps in.

const sha = (c: string): string => c.repeat(64);
const image = (c: string): Json => ({ card: `/admin/cookout-img/${sha(c)}.webp`, thumb: `/admin/cookout-img/${sha(c === "a" ? "b" : "e")}.webp` });
const RIBEYE_P: Json = { ...RIBEYE, what: "A richly marbled beef steak cut from the rib.", image: image("a") };
const SALMON_P: Json = { ...SALMON, what: "A thick, pink fillet of salmon.", image: image("c") };

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});

afterEach(() => {
  delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
});

/** Shows a view with the intro already dismissed. */
function table(raw: Json, harness = makeHarness()): ReturnType<typeof makeHarness> {
  harness.show(raw);
  harness.pane.querySelector<HTMLButtonElement>(".wx-srv-ck-intro-go")?.click();
  return harness;
}

describe("the banner's words", () => {
  it("my turn: what to do, then the pick, the role and the pairs left", () => {
    expect(turnBanner(v(pickingView({ turn: 3 })), "Cupcake")).toEqual({
      line1: "Your turn — tap the one you want",
      line2: "Pick 2 of 5 · 🍗 protein · 2 new pairs left",
      join: false,
      mine: true,
    });
    expect(turnBanner(v(pickingView({ turn: 3, offerIndex: 1 })), "Cupcake").line2).toBe("Pick 2 of 5 · 🍗 protein · 1 new pair left");
    expect(turnBanner(v(pickingView({ turn: 3, offerIndex: 2 })), "Cupcake").line2).toBe("Pick 2 of 5 · 🍗 protein · final pair");
  });

  it("watching, Blind, and waiting for Join", () => {
    expect(turnBanner(v(pickingView({ turn: 2 })), "Cupcake").line1).toBe("Cupcake is choosing…");
    const blind = turnBanner(v(pickingView({ turn: 2, blind: true, showOptions: false, p2Picks: null, p2Count: 0 })), "Cupcake");
    expect(blind).toEqual({ line1: "Cupcake is choosing…", line2: "Secret pick · Pick 1 of 5", join: false, mine: false });
    expect(turnBanner(v(pickingView({ turn: 2, player2: null, showOptions: false, waitingForJoin: true })), "Cupcake").line1).toBe(
      "Waiting for Cupcake to join",
    );
    const joiner = turnBanner(v(pickingView({ turn: 2, you: null, player2: null, showOptions: false, waitingForJoin: true })), null);
    expect(joiner).toEqual({ line1: "Join to take your turn", line2: "", join: true, mine: false });
  });

  it("a long partner name is 'your partner', and every banner line fits 34 characters", () => {
    expect(bannerName("Bartholomew-Smythe")).toBe("your partner");
    expect(bannerName("Cupcake")).toBe("Cupcake");
    const long = "Bartholomew-Smythe";
    const views = [
      pickingView({ turn: 2, player2: long }),
      pickingView({ turn: 2, player2: null, showOptions: false, waitingForJoin: true }),
      pickingView({ turn: 3 }),
      pickingView({ turn: 2, you: null, player2: null, showOptions: false, waitingForJoin: true }),
    ];
    for (const raw of views) {
      const words = turnBanner(v(raw), long);
      expect(words.line1.length).toBeLessThanOrEqual(34);
      expect(words.line1).not.toContain(long);
    }
    expect(turnBanner(v(pickingView({ turn: 2, player2: long })), long).line1).toBe("Your partner is choosing…");
  });

  it("the skip's words", () => {
    expect(skipLabel(0, 2)).toBe("Deal two new ones (2 left)");
    expect(skipLabel(1, 1)).toBe("Deal two new ones (1 left)");
    expect(skipLabel(2, 0)).toBe("Final pair");
  });
});

describe("one tap picks", () => {
  it("the whole card is the button: one tap sends one pick and disables both cards", async () => {
    const h = table(pickingView({ turn: 3, options: [RIBEYE_P, SALMON_P] }));
    const cards = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-pair button.wx-srv-ck-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.getAttribute("aria-label")).toBe("Pick Ribeye steak");
    const describedBy = cards[0]!.getAttribute("aria-describedby") ?? "";
    expect(h.pane.querySelector(`#${describedBy}`)?.textContent).toBe("A richly marbled beef steak cut from the rib.");
    expect(q(cards[0]!, ".wx-srv-ck-card-name").textContent).toBe("Ribeye steak");
    expect(q<HTMLImageElement>(cards[0]!, "img").getAttribute("src")).toBe(`/admin/cookout-img/${sha("a")}.webp`);
    let resolve: (value: unknown) => void = () => {};
    h.api.pick.mockReturnValue(new Promise((r) => (resolve = r)));
    cards[0]!.click();
    cards[0]!.click();
    await settle();
    expect(h.api.pick).toHaveBeenCalledTimes(1);
    expect(h.api.pick.mock.calls[0]?.[1]).toMatchObject({ turn: 3, offer: 0, ingredientId: "ribeye-steak" });
    const now = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-pair button.wx-srv-ck-card");
    expect(now.every((c) => c.disabled)).toBe(true);
    expect(now[0]!.classList.contains("wx-srv-ck-card-chosen")).toBe(true);
    expect(q(now[0]!, ".wx-srv-ck-card-busy").textContent).toBe("Picking…");
    expect(now[1]!.classList.contains("wx-srv-ck-card-dim")).toBe(true);
    resolve(h.ok(pickingView({ turn: 4 })));
    await settle();
  });

  it("a blurb short enough shows as the what-line; a longer one stays in the description only", () => {
    const long = snap("long-one", "Long one", "vegetables", "🥕", "x".repeat(80));
    const h = table(pickingView({ turn: 3, options: [RIBEYE, long] }));
    const [ribeye, other] = qa<HTMLButtonElement>(h.pane, "button.wx-srv-ck-card");
    expect(q(ribeye!, ".wx-srv-ck-card-what").textContent).toBe("Richly marbled and full of flavour.");
    expect(other!.querySelector(".wx-srv-ck-card-what")).toBeNull();
    const id = other!.getAttribute("aria-describedby") ?? "";
    expect(h.pane.querySelector(`#${id}`)?.textContent).toBe("x".repeat(80));
    expect(h.pane.querySelector<HTMLElement>(`#${id}`)?.hidden).toBe(true);
  });

  it("the watcher's cards are pictures, not buttons, and say who is choosing", () => {
    const h = table(pickingView({ turn: 2, options: [RIBEYE_P, SALMON_P] }));
    expect(qa(h.pane, ".wx-srv-ck-pair .wx-srv-ck-card")).toHaveLength(2);
    expect(qa(h.pane, ".wx-srv-ck-pair button")).toHaveLength(0);
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Cupcake is choosing…");
    expect(visible(h.pane, ".wx-srv-ck-skip")).toBe(false);
  });

  it("the final pair has no skip to press", () => {
    const h = table(pickingView({ turn: 3, offerIndex: 2 }));
    const skip = q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip");
    expect(skip.textContent).toBe("Final pair");
    expect(skip.disabled).toBe(true);
  });
});

describe("leaving the table", () => {
  it("an ended round keeps no card, pair or ingredient of the table in the DOM, not even hidden", () => {
    const h = table(pickingView({ turn: 3, options: [RIBEYE_P, SALMON_P] }));
    expect(qa(h.pane, ".wx-srv-ck-table-stage .wx-srv-ck-card")).toHaveLength(2);
    h.show({ ...pickingView({ turn: 3 }), state: "abandoned", current: null });
    expect(h.pane.querySelectorAll("[data-ingredient]")).toHaveLength(0);
    expect(h.pane.querySelectorAll(".wx-srv-ck-card, .wx-srv-ck-skip")).toHaveLength(0);
    expect(h.pane.innerHTML).not.toContain(sha("c"));
    expect(visible(h.pane, ".wx-srv-ck-ended")).toBe(true);
  });
});

describe("joining", () => {
  it("somebody not playing may join on Player 1's turn too, while Slot 2 is free", async () => {
    const h = table(pickingView({ turn: 1, you: null, player2: null, p1Picks: [], p2Picks: [] }));
    const join = q<HTMLButtonElement>(h.pane, ".wx-srv-ck-banner .wx-srv-ck-join");
    expect(join.textContent).toBe("Join");
    h.api.join.mockResolvedValue(h.ok(pickingView({ turn: 1, you: 2, p1Picks: [], p2Picks: [] })));
    join.click();
    await settle();
    expect(h.api.join).toHaveBeenCalledWith(41);
    expect(h.pane.querySelector(".wx-srv-ck-join")).toBeNull();
  });
});

describe("the 🎲 Twists sheet", () => {
  it("shows only when a drafting twist is usable right now", () => {
    expect(table(twistPicking({ turn: 3 }, {}, { canLucky: null, canChaos: null, canVeto: null })).pane.querySelector(".wx-srv-ck-twists-btn")).toBeNull();
    expect(table(twistPicking({ turn: 3 }, {}, { canLucky: false, canChaos: false, canVeto: null })).pane.querySelector(".wx-srv-ck-twists-btn")).toBeNull();
    const h = table(twistPicking({ turn: 3 }, { you: { slot: 1, chaosUsed: true, vetoUsed: false } }, { canLucky: true, canChaos: false, canVeto: null }));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-twists-btn").click();
    expect(h.pane.querySelector(".wx-srv-ck-sheet")?.getAttribute("data-sheet")).toBe("twists");
    expect(q<HTMLButtonElement>(h.pane, ".wx-srv-ck-sheet .wx-srv-ck-lucky").disabled).toBe(false);
    const chaos = q<HTMLButtonElement>(h.pane, ".wx-srv-ck-sheet .wx-srv-ck-chaos");
    expect(chaos.disabled).toBe(true);
    expect(chaos.textContent).toContain("(used)");
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-sheet-close").click();
    expect(visible(h.pane, ".wx-srv-ck-sheet")).toBe(false);
  });

  it("a lucky dip from the sheet closes it and sends both ids on screen", async () => {
    const h = table(twistPicking({ turn: 3 }, {}, { canLucky: true, canChaos: null, canVeto: null }));
    h.api.lucky.mockResolvedValue(h.ok(pickingView({ turn: 4 })));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-twists-btn").click();
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-sheet .wx-srv-ck-lucky").click();
    expect(visible(h.pane, ".wx-srv-ck-sheet")).toBe(false);
    await settle();
    expect(h.api.lucky.mock.calls[0]?.[1]).toMatchObject({ turn: 3, offer: 0, optionIds: ["ribeye-steak", "salmon-fillet"] });
  });

  it("the watcher's Sweep one makes the cards sweep, with Cancel", async () => {
    const h = table(twistPicking({ turn: 2 }, {}, { canVeto: true }));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-twists-btn").click();
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-sheet .wx-srv-ck-sweep").click();
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Tap the one to sweep away");
    expect(q(h.pane, ".wx-srv-ck-turn-sub").textContent).toBe("It goes off Cupcake's table");
    const cards = qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-pair button.wx-srv-ck-card");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Sweep Ribeye steak off the table", "Sweep Salmon fillet off the table"]);
    // Cancel goes back to watching.
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-sweep-cancel").click();
    expect(qa(h.pane, ".wx-srv-ck-pair button")).toHaveLength(0);
    // Sweeping for real sends that card's id with the table it saw.
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-twists-btn").click();
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-sheet .wx-srv-ck-sweep").click();
    h.api.veto.mockResolvedValue(h.ok(twistPicking({ turn: 2 }, {}, { canVeto: false })));
    qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-pair button.wx-srv-ck-card")[1]!.click();
    await settle();
    expect(h.api.veto.mock.calls[0]?.[1]).toMatchObject({ turn: 2, offer: 0, ingredientId: "salmon-fillet" });
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Cupcake is choosing…");
  });

  it("sweep mode ends by itself when the turn moves on before a card is tapped", () => {
    const h = table(twistPicking({ turn: 2 }, {}, { canVeto: true }));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-twists-btn").click();
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-sheet .wx-srv-ck-sweep").click();
    expect(qa(h.pane, ".wx-srv-ck-pair button")).toHaveLength(2);
    // Cupcake picked: it is my turn now, with an ordinary pair to pick from.
    h.show(twistPicking({ turn: 3 }, {}, { canVeto: null }));
    expect(q(h.pane, ".wx-srv-ck-turn").textContent).toBe("Your turn — tap the one you want");
    expect(qa<HTMLButtonElement>(h.pane, ".wx-srv-ck-pair button")[0]!.getAttribute("aria-label")).toBe("Pick Ribeye steak");
    expect(h.pane.querySelector(".wx-srv-ck-sweep-cancel")).toBeNull();
  });
});

describe("Blind and the progress", () => {
  it("the partner's Blind turn is the cloche: no ingredient text and no picture URL of theirs in the DOM", () => {
    const secret: Json = { ...P2_PICKS[1], image: image("f") };
    // My own turn first (a pair with pictures on the table), then the partner's secret turn: nothing of the
    // earlier table may linger, and nothing of theirs is drawn.
    const h = table(pickingView({ turn: 3, blind: true, options: [RIBEYE_P, SALMON_P], p2Picks: null, p2Count: 1 }));
    expect(qa(h.pane, ".wx-srv-ck-card")).toHaveLength(2);
    h.show(pickingView({ turn: 4, blind: true, showOptions: false, p1Picks: [pick(snap("my-own-pick", "My own pick", "fruit", "🍎"), 3)], p2Picks: null, p2Count: 1 }));
    expect(visible(h.pane, ".wx-srv-ck-cloche")).toBe(true);
    expect(qa(h.pane, ".wx-srv-ck-table-stage .wx-srv-ck-card, .wx-srv-ck-table-stage img")).toHaveLength(0);
    expect(h.pane.innerHTML).not.toContain("Salmon fillet");
    expect(h.pane.innerHTML).not.toContain(sha("c"));
    const html = h.pane.innerHTML;
    for (const name of [String(secret["name"]), String(secret["id"])]) expect(html).not.toContain(name);
    expect(html).not.toContain(sha("f"));
    // The partner's pick is a 🔒 tile in the progress; mine are pictures (or their emoji tiles).
    const theirs = qa(h.pane, '.wx-srv-ck-prog-group[data-slot="2"] .wx-srv-ck-prog-secret');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.textContent).toBe("🔒");
  });

  it("progress is ONE button of passive tiles: yours left, theirs right, the next slot pulsing", () => {
    const mine = [pick({ ...RIBEYE_P }, 1)];
    const h = table(pickingView({ turn: 3, p1Picks: mine, p2Picks: [pick(SALMON_P, 2)] }));
    const progress = q<HTMLButtonElement>(h.pane, "button.wx-srv-ck-progress");
    expect(progress.getAttribute("aria-label")).toBe("Basket so far: you have 1 of 5, Cupcake has 1 of 5. Show the basket.");
    expect(qa(progress, "button")).toHaveLength(0);
    const groups = qa(progress, ".wx-srv-ck-prog-group");
    expect(groups.map((g) => g.dataset["slot"])).toEqual(["1", "2"]);
    expect(q<HTMLImageElement>(groups[0]!, ".wx-srv-ck-prog-full img").getAttribute("src")).toBe(`/admin/cookout-img/${sha("b")}.webp`);
    expect(qa(groups[0]!, ".wx-srv-ck-prog-now")).toHaveLength(1);
    expect(qa(groups[1]!, ".wx-srv-ck-prog-empty")).toHaveLength(4);
    // Slot 2 sees itself first.
    const h2 = table(pickingView({ turn: 3, you: 2 }));
    expect(qa(h2.pane, ".wx-srv-ck-prog-group").map((g) => g.dataset["slot"])).toEqual(["2", "1"]);
  });

  it("the basket sheet lists both players' picks large, with Star this on my own when stars are on", async () => {
    const mine = [pick(RIBEYE_P, 1)];
    const h = table(twistPicking({ turn: 3, p1Picks: mine }, { setup: setup({ stars: true }), stars: stars() }));
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-progress").click();
    expect(h.pane.querySelector(".wx-srv-ck-sheet")?.getAttribute("data-sheet")).toBe("basket");
    const line = q(h.pane, '.wx-srv-ck-bgroup[data-slot="1"] .wx-srv-ck-bline[data-picked="ribeye-steak"]');
    expect(q(line, ".wx-srv-ck-bline-what").textContent).toBe("A richly marbled beef steak cut from the rib.");
    h.api.star.mockResolvedValue(h.ok(twistPicking({ turn: 3, p1Picks: mine }, { setup: setup({ stars: true }), stars: stars({ mine: "ribeye-steak" }) })));
    q<HTMLButtonElement>(line, ".wx-srv-ck-star").click();
    await settle();
    expect(h.api.star).toHaveBeenCalledWith(41, "ribeye-steak");
    expect(q(h.pane, ".wx-srv-ck-bline .wx-srv-ck-star").textContent).toBe("★ Your star");
  });

  it("the twists strip shows the start-sheet twists as icons; a twist-free round has none", () => {
    const h = table(twistPicking({ turn: 3 }, { setup: setup({ style: STYLE_COSY, stars: true, wildcard: true }), stars: stars() }));
    expect(visible(h.pane, ".wx-srv-ck-strip")).toBe(true);
    expect(qa(h.pane, ".wx-srv-ck-strip .wx-srv-ck-strip-icon")).toHaveLength(3);
    expect(q(h.pane, ".wx-srv-ck-strip").getAttribute("aria-label")).toBe("Twists on: 🍺 Cosy pub style, ⭐ secret stars, 🛎️ a mystery 11th ingredient");
    expect(q(h.pane, ".wx-srv-ck-help").classList.contains("wx-srv-ck-help-twists")).toBe(true);
    const plain = table(pickingView({ turn: 3 }));
    expect(visible(plain.pane, ".wx-srv-ck-strip")).toBe(false);
  });
});

describe("a new pair is decoded before it swaps in", () => {
  it("keeps the old (disabled) cards until both pictures decode", async () => {
    const pending: Array<() => void> = [];
    const finish = (): void => pending.splice(0).forEach((r) => r());
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: () => new Promise<void>((r) => pending.push(r)),
    });
    const h = table(pickingView({ turn: 3, options: [RIBEYE_P, SALMON_P] }));
    const next = snap("smoked-paprika", "Smoked paprika", "spices-seasonings", "🌶️");
    const other = snap("red-lentils", "Red lentils", "legumes-nuts-seeds", "🫘");
    h.show(pickingView({ turn: 3, offerIndex: 1, options: [{ ...next, image: image("a") }, { ...other, image: image("c") }] }));
    // Still the old pair, now disabled — and nothing else may act on a pair not yet on screen.
    expect(qa(h.pane, ".wx-srv-ck-card").map((c) => c.dataset["ingredient"])).toEqual(["ribeye-steak", "salmon-fillet"]);
    expect(qa<HTMLButtonElement>(h.pane, "button.wx-srv-ck-card").every((c) => c.disabled)).toBe(true);
    expect(q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").disabled).toBe(true);
    finish();
    await settle();
    expect(qa(h.pane, ".wx-srv-ck-card").map((c) => c.dataset["ingredient"])).toEqual(["smoked-paprika", "red-lentils"]);
    expect(q<HTMLButtonElement>(h.pane, ".wx-srv-ck-skip").disabled).toBe(false);
  });

  it("swaps in after 400 ms even when the pictures are still decoding", async () => {
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => new Promise<void>(() => {}) });
    const h = table(pickingView({ turn: 3, options: [RIBEYE_P, SALMON_P] }));
    const next = { ...snap("smoked-paprika", "Smoked paprika", "spices-seasonings", "🌶️"), image: image("a") };
    const other = { ...snap("red-lentils", "Red lentils", "legumes-nuts-seeds", "🫘"), image: image("c") };
    h.show(pickingView({ turn: 3, offerIndex: 1, options: [next, other] }));
    expect(qa(h.pane, ".wx-srv-ck-card")[0]!.dataset["ingredient"]).toBe("ribeye-steak");
    for (const cb of [...h.clock.timeouts.values()]) cb();
    await settle();
    expect(qa(h.pane, ".wx-srv-ck-card")[0]!.dataset["ingredient"]).toBe("smoked-paprika");
  });

  it("a pair without pictures swaps at once", () => {
    const h = table(pickingView({ turn: 3 }));
    h.show(pickingView({ turn: 3, offerIndex: 1, options: [snap("a-1", "A one", "fruit", "🍎"), snap("b-2", "B two", "fruit", "🍐")] }));
    expect(qa(h.pane, ".wx-srv-ck-card").map((c) => c.dataset["ingredient"])).toEqual(["a-1", "b-2"]);
  });
});
