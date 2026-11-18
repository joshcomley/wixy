import { afterEach, describe, expect, it } from "vitest";
import { CLASSIC_MODE, parseCookoutView, parseModeInfo, parsePickSnap, type PickSnap } from "../../src/server/cookout/api";
import {
  anchorFirst,
  anchorKind,
  anchorMark,
  anchorPick,
  capitalise,
  dishNoun,
  fillStarter,
  fillingTurns,
  isAnchorPick,
  isModeRound,
  kindNoun,
  kindOf,
  modeTileUrl,
  numberWord,
  ordinal,
  plural,
} from "../../src/server/cookout/modes";
import { pickingView } from "./fixtures";
import { BAGEL, HAM, SOURDOUGH, TOASTIE_MODE, modePick, toastiePicking } from "./modeFixtures";

// The small pure word rules every mode screen shares (spec/server-chat/09c-cookout-modes.md §6).

const TOASTIE = parseModeInfo(TOASTIE_MODE);

function pick(raw: Record<string, unknown>): PickSnap {
  const parsed = parsePickSnap(raw);
  if (parsed === null) throw new Error("fixture");
  return parsed;
}

afterEach(() => {
  delete (globalThis as { WIXY_COOKOUT_MODE_TILES?: unknown }).WIXY_COOKOUT_MODE_TILES;
});

describe("number words", () => {
  it("ordinal handles the teens and the endings", () => {
    expect(ordinal(9)).toBe("9th");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
    expect(ordinal(21)).toBe("21st");
    expect(ordinal(22)).toBe("22nd");
    expect(ordinal(23)).toBe("23rd");
    expect(ordinal(101)).toBe("101st");
    expect(ordinal(111)).toBe("111th");
    expect(ordinal(112)).toBe("112th");
  });

  it("numberWord spells up to twelve and falls back to digits", () => {
    expect(numberWord(8)).toBe("eight");
    expect(numberWord(10)).toBe("ten");
    expect(numberWord(12)).toBe("twelve");
    expect(numberWord(13)).toBe("13");
  });

  it("plural makes the dish's plural", () => {
    expect(plural("toasted sandwich")).toBe("toasted sandwiches");
    expect(plural("pizza")).toBe("pizzas");
    expect(plural("curry")).toBe("curries");
    expect(plural("tray")).toBe("trays");
    expect(plural("box")).toBe("boxes");
    expect(plural("dish")).toBe("dishes");
    expect(plural("bass")).toBe("basses");
  });

  it("capitalise and dishNoun", () => {
    expect(capitalise("bread")).toBe("Bread");
    expect(capitalise("")).toBe("");
    expect(dishNoun({ label: " Toasted sandwich " })).toBe("toasted sandwich");
  });
});

describe("{starter} in an intro line", () => {
  const LINE = "{starter} picks the bread first, then you take turns adding fillings — 4 picks each.";

  it("is the starter's name for anyone else", () => {
    expect(fillStarter(LINE, "Cupcake", false)).toBe("Cupcake picks the bread first, then you take turns adding fillings — 4 picks each.");
    expect(fillStarter(LINE, null, false)).toBe("Player 1 picks the bread first, then you take turns adding fillings — 4 picks each.");
  });

  it("is \"You\" with the verb agreeing for the starter", () => {
    expect(fillStarter(LINE, "Josh", true)).toBe("You pick the bread first, then you take turns adding fillings — 4 picks each.");
    expect(fillStarter("{starter} goes first.", "Josh", true)).toBe("You go first.");
    expect(fillStarter("{starter} chooses the bread.", "Josh", true)).toBe("You choose the bread.");
    expect(fillStarter("{starter} makes the first move.", "Josh", true)).toBe("You make the first move.");
    expect(fillStarter("{starter} finishes it.", "Josh", true)).toBe("You finish it.");
    expect(fillStarter("{starter} mixes it.", "Josh", true)).toBe("You mix it.");
  });

  it("is lower-case \"you\" in the middle of a line, and a line without it is untouched", () => {
    expect(fillStarter("Then {starter} picks.", "Josh", true)).toBe("Then you pick.");
    expect(fillStarter("The chef makes three toasted sandwiches with your bread.", "Josh", true)).toBe("The chef makes three toasted sandwiches with your bread.");
    expect(fillStarter("The chef makes three.", "Josh", false)).toBe("The chef makes three.");
  });
});

describe("kinds and the anchor", () => {
  it("kindNoun drops the article; kindOf finds a kind by id", () => {
    expect(TOASTIE.kinds.map(kindNoun)).toEqual(["bread", "cheese", "main filling", "veg or fruit", "finishing touch"]);
    expect(kindOf(TOASTIE, "cheese")?.prompt).toBe("add a cheese");
    expect(kindOf(TOASTIE, "nope")).toBeNull();
    expect(kindOf(TOASTIE, null)).toBeNull();
  });

  it("anchorKind is the bread for Toasted sandwich and nothing for Classic", () => {
    expect(anchorKind(TOASTIE)?.id).toBe("bread");
    expect(anchorKind(CLASSIC_MODE)).toBeNull();
    expect(anchorKind({ ...TOASTIE, anchorKind: null })).toBeNull();
    expect(anchorMark(TOASTIE)).toBe("🍞");
    expect(anchorMark({ ...TOASTIE, anchorKind: "base", emoji: "🍕" })).toBe("🍕");
  });

  it("fillingTurns leaves the anchor's turn out", () => {
    expect(fillingTurns(TOASTIE)).toBe(7);
    expect(fillingTurns(CLASSIC_MODE)).toBe(10);
  });

  it("isModeRound is true only for a non-Classic view", () => {
    expect(isModeRound(parseCookoutView(toastiePicking()) as NonNullable<ReturnType<typeof parseCookoutView>>)).toBe(true);
    expect(isModeRound(parseCookoutView(pickingView()) as NonNullable<ReturnType<typeof parseCookoutView>>)).toBe(false);
  });

  it("a pick is the anchor by its kind, or (an older snapshot with no kind) by being turn 1", () => {
    const bread = pick(modePick(SOURDOUGH, 1, "bread"));
    const filling = pick(modePick(HAM, 2, "main"));
    const unkindedFirst = pick({ ...SOURDOUGH, turn: 1 });
    const unkindedLater = pick({ ...HAM, turn: 2 });
    expect(isAnchorPick(TOASTIE, bread)).toBe(true);
    expect(isAnchorPick(TOASTIE, filling)).toBe(false);
    expect(isAnchorPick(TOASTIE, unkindedFirst)).toBe(true);
    expect(isAnchorPick(TOASTIE, unkindedLater)).toBe(false);
    // Classic has none, whatever turn it was.
    expect(isAnchorPick(CLASSIC_MODE, unkindedFirst)).toBe(false);
    // A kind that disagrees with turn 1 wins over turn 1.
    expect(isAnchorPick(TOASTIE, pick(modePick(BAGEL, 1, "cheese")))).toBe(false);
  });

  it("anchorPick finds the bread and anchorFirst puts it first", () => {
    const picks = [pick(modePick(HAM, 2, "main")), pick(modePick(SOURDOUGH, 1, "bread")), pick(modePick(BAGEL, 3, "main"))];
    expect(anchorPick(TOASTIE, picks)?.id).toBe("sourdough-loaf");
    expect(anchorFirst(TOASTIE, picks).map((p) => p.id)).toEqual(["sourdough-loaf", "smoked-ham", "plain-bagel"]);
    // No bread visible (a hidden partner's): the order is kept. Classic: always kept.
    const without = picks.filter((p) => p.id !== "sourdough-loaf");
    expect(anchorPick(TOASTIE, without)).toBeNull();
    expect(anchorFirst(TOASTIE, without).map((p) => p.id)).toEqual(["smoked-ham", "plain-bagel"]);
    expect(anchorFirst(CLASSIC_MODE, picks).map((p) => p.id)).toEqual(["smoked-ham", "sourdough-loaf", "plain-bagel"]);
  });
});

describe("the tile pictures", () => {
  it("are none when the build carries no WIXY_COOKOUT_MODE_TILES", () => {
    expect(modeTileUrl("toastie")).toBeNull();
  });

  it("come from the build's map, one per mode, and blank or missing entries are none", () => {
    (globalThis as { WIXY_COOKOUT_MODE_TILES?: unknown }).WIXY_COOKOUT_MODE_TILES = { toastie: "/admin/cookout-mode-toastie.1a2b3c.webp", classic: "" };
    expect(modeTileUrl("toastie")).toBe("/admin/cookout-mode-toastie.1a2b3c.webp");
    expect(modeTileUrl("classic")).toBeNull();
    expect(modeTileUrl("wrap")).toBeNull();
  });
});
