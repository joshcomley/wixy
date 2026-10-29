// Wire fixtures for the Cookout GAME MODES (spec/server-chat/09c-cookout-modes.md §5.4, frozen wire A.3):
// the Toasted sandwich ("toastie") round as the server would send it, a `GET /cookout/options` body that
// lists it, and the Recipe-book entries that name a mode. Each builder returns raw JSON so the tests run it
// through the real parsers.

import { CLASSIC_OPTION, parseCookoutOptions, type CookoutOptions } from "../../src/server/cookout/api";
import {
  GRUYERE,
  STAPLES,
  finishedView,
  pickingView,
  picture,
  recipesNone,
  snap,
  bookBody,
  type Json,
  type PickingOptions,
} from "./fixtures";

export type { Json };

// -- The mode ---------------------------------------------------------------------------------------------

export const TOASTIE_KINDS: Json[] = [
  { id: "bread", label: "the bread", prompt: "pick the bread" },
  { id: "cheese", label: "a cheese", prompt: "add a cheese" },
  { id: "main", label: "a main filling", prompt: "add a main filling" },
  { id: "produce", label: "veg or fruit", prompt: "add veg or fruit" },
  { id: "finish", label: "a finishing touch", prompt: "add a finishing touch" },
];

/** The view's `mode` block of a Toasted sandwich round (09c §5.4). */
export const TOASTIE_MODE: Json = {
  id: "toastie",
  label: "Toasted sandwich",
  emoji: "🥪",
  turns: 8,
  picksPerPlayer: 4,
  kinds: TOASTIE_KINDS,
  anchorKind: "bread",
};

export const TOASTIE_INTRO: readonly string[] = [
  "You're making a toasted sandwich.",
  "{starter} picks the bread first, then you take turns adding fillings — 4 picks each.",
  "The chef makes three toasted sandwiches with your bread.",
];

export const ALL_TWIST_IDS: readonly string[] = [
  "swap",
  "vote",
  "style",
  "cooked",
  "wildcard",
  "fridge",
  "challenge",
  "veto",
  "encore",
  "lucky",
  "stars",
  "chaos",
];

/** The mode's entry in `GET /cookout/options` `modes`. */
export function toastieOption(patch: Json = {}): Json {
  return {
    id: "toastie",
    label: "Toasted sandwich",
    emoji: "🥪",
    turns: 8,
    picksPerPlayer: 4,
    blurb: "Pick a bread and 7 fillings, get 3 toasties",
    intro: [...TOASTIE_INTRO],
    twists: [...ALL_TWIST_IDS],
    fridgeKinds: ["bread"],
    ...patch,
  };
}

export function classicOptionWire(): Json {
  return {
    id: "classic",
    label: "Classic",
    emoji: "🍳",
    turns: 10,
    picksPerPlayer: 5,
    blurb: "Pick 10 ingredients, get 3 dishes",
    intro: [],
    twists: [...ALL_TWIST_IDS],
    fridgeKinds: null,
  };
}

/** A `GET /cookout/options` body listing Classic and Toasted sandwich. */
export function optionsBody(modes: unknown[] = [classicOptionWire(), toastieOption()]): Json {
  return {
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
    modes,
  };
}

/** The parsed options with both modes listed. */
export function toastieOptions(modes?: unknown[]): CookoutOptions {
  const parsed = parseCookoutOptions(optionsBody(modes));
  if (parsed === null) throw new Error("options fixture did not parse");
  return parsed;
}

export { CLASSIC_OPTION };

// -- Ingredients ------------------------------------------------------------------------------------------

export const SOURDOUGH = snap("sourdough-loaf", "Sourdough loaf", "grains-bakery", "🍞", "Chewy and tangy.");
export const BAGEL = snap("plain-bagel", "Plain bagel", "grains-bakery", "🥯", "Dense and glossy.");
export const CIABATTA = snap("ciabatta-roll", "Ciabatta roll", "grains-bakery", "🥖", "Airy and crisp.");
export const CHEDDAR = snap("mature-cheddar", "Mature cheddar", "dairy-eggs", "🧀", "Sharp and crumbly.");
export const BRIE = snap("ripe-brie", "Ripe brie", "dairy-eggs", "🧀", "Soft and creamy.");
export const HAM = snap("smoked-ham", "Smoked ham", "meat-poultry", "🍖", "Salty and sweet.");
export const PORK = snap("pulled-pork", "Pulled pork", "meat-poultry", "🥩", "Slow-cooked and sticky.");
export const TOMATO = snap("beef-tomato", "Beef tomato", "vegetables", "🍅", "Juicy and sweet.");
export const PICKLES = snap("dill-pickles", "Dill pickles", "vegetables", "🥒", "Sharp and crunchy.");
export const HOT_HONEY = snap("hot-honey", "Hot honey", "sauces-stocks-fermented", "🍯", "Sweet with a kick.");
export const SALAMI = snap("fennel-salami", "Fennel salami", "meat-poultry", "🥓", "Peppery slices.");
export const APPLE = snap("crisp-apple", "Crisp apple", "fruit", "🍎", "Tart and snappy.");
export { GRUYERE };

/** The pick kind of each turn of the fixture round: the bread, two mains, two cheeses, two produce, a finish. */
export const TOASTIE_TURN_KINDS: readonly string[] = ["bread", "main", "main", "cheese", "cheese", "produce", "produce", "finish"];

/** The eight picks of the fixture round, turn by turn (odd turns are Slot 1's). */
export const TOASTIE_PICKS: readonly Json[] = [SOURDOUGH, HAM, PORK, CHEDDAR, BRIE, TOMATO, PICKLES, HOT_HONEY];

/** A basket pick as the mode's wire carries it: with its turn, how it got in, and its pick kind. */
export function modePick(ingredient: Json, turn: number, kind: string | null, via = "pick"): Json {
  return { ...ingredient, turn, via, kind };
}

/** The fixture picks of one slot, up to (not including) `before`. */
export function toastiePicksOf(slot: 1 | 2, before = 9): Json[] {
  const out: Json[] = [];
  TOASTIE_PICKS.forEach((ingredient, i) => {
    const turn = i + 1;
    if (turn < before && (turn % 2 === 1 ? 1 : 2) === slot) out.push(modePick(ingredient, turn, TOASTIE_TURN_KINDS[i] ?? null));
  });
  return out;
}

/** The pair of options offered for a pick kind. */
export function optionsFor(kind: string): [Json, Json] {
  switch (kind) {
    case "bread":
      return [SOURDOUGH, BAGEL];
    case "cheese":
      return [CHEDDAR, BRIE];
    case "main":
      return [HAM, SALAMI];
    case "produce":
      return [TOMATO, APPLE];
    default:
      return [HOT_HONEY, PICKLES];
  }
}

// -- Picking ---------------------------------------------------------------------------------------------

export interface ToastieOptions extends Omit<PickingOptions, "options"> {
  /** The kind id on the current turn (default: the fixture round's kind of that turn). */
  readonly role?: string | null;
}

/** A Toasted sandwich round being picked, as the server would filter it for the viewer. */
export function toastiePicking(o: ToastieOptions = {}, root: Json = {}, current: Json = {}): Json {
  const turn = o.turn ?? 1;
  const kind = TOASTIE_TURN_KINDS[turn - 1] ?? "finish";
  const show = o.showOptions ?? true;
  const { role, ...rest } = o;
  const base = pickingView({
    ...rest,
    turn,
    options: optionsFor(role ?? kind),
    p1Picks: o.p1Picks === undefined ? toastiePicksOf(1, turn) : o.p1Picks,
    p2Picks: o.p2Picks === undefined ? toastiePicksOf(2, turn) : o.p2Picks,
  });
  const cur = base["current"] as Json;
  return {
    ...base,
    mode: TOASTIE_MODE,
    ...root,
    current: { ...cur, role: show ? (role === undefined ? kind : role) : null, ...current },
  };
}

// -- Finished ---------------------------------------------------------------------------------------------

/** A dish idea of a Toasted sandwich round: the bread plus six fillings, one filling left out. */
export function toastieConcept(id: "a" | "b" | "c", title: string, build: Json | null, extra: Json = {}): Json {
  const fillings = TOASTIE_PICKS.slice(1).filter((s) => s["id"] !== PICKLES["id"]);
  return {
    id,
    title,
    vibe: id === "a" ? "Diner Classic" : id === "b" ? "Cosy Sunday" : "Street Food",
    dishType: "sandwich",
    technique: "grill",
    description: `${title}: a golden, buttery toastie built on the sourdough, with the fillings layered hot to cold.`,
    pickedIngredients: [SOURDOUGH, ...fillings],
    staplesUsed: [
      { id: "butter", name: "Butter" },
      { id: "salt", name: "Salt" },
    ],
    omitted: [{ ingredient: PICKLES, reason: "Kept for a side so the toastie stays crisp." }],
    build,
    ...extra,
  };
}

export const TOASTIE_CONCEPTS: Json[] = [
  toastieConcept("a", "Skillet Ham & Cheddar Melt", { id: "skillet", label: "Skillet-fried" }),
  toastieConcept("b", "Pressed Pork & Brie Toastie", { id: "press", label: "Sandwich-press" }),
  toastieConcept("c", "Oven-Crisp Pork Toastie", { id: "oven", label: "Oven-baked" }),
];

export interface ToastieFinishedOptions {
  readonly seq?: number;
  readonly rev?: number;
  readonly blind?: boolean;
  readonly concepts?: "pending" | "ready" | "failed" | "unavailable";
  readonly images?: "none" | "pending" | "done" | "failed";
}

/** A finished Toasted sandwich round: the bread and seven fillings revealed. */
export function toastieFinished(o: ToastieFinishedOptions = {}, root: Json = {}): Json {
  const conceptsState = o.concepts ?? "ready";
  const base = finishedView({
    seq: o.seq ?? 41,
    rev: o.rev ?? 12,
    blind: o.blind ?? false,
    concepts: conceptsState,
    images: o.images ?? "pending",
    pictures: { a: null, b: null, c: null },
  });
  return {
    ...base,
    mode: TOASTIE_MODE,
    players: [
      { slot: 1, name: "Josh", pickCount: 4, picks: toastiePicksOf(1) },
      { slot: 2, name: "Cupcake", pickCount: 4, picks: toastiePicksOf(2) },
    ],
    concepts: {
      state: conceptsState,
      data: conceptsState === "ready" ? TOASTIE_CONCEPTS : null,
      error: conceptsState === "failed" ? "validation" : null,
    },
    staples: STAPLES,
    recipes: recipesNone(),
    ...root,
  };
}

// -- The Recipe book -------------------------------------------------------------------------------------

/** `bookBody()` whose second entry (seq 30) is a Toasted sandwich dish; the first stays a mode-less (Classic) one. */
export function modeBookBody(): Json {
  const [first, second] = bookBody()["recipes"] as Json[];
  return {
    recipes: [
      { ...first, generation: 1, ingredients: [SOURDOUGH, HAM], leftovers: [PICKLES] },
      {
        ...second,
        generation: 1,
        mode: { id: "toastie", label: "Toasted sandwich", emoji: "🥪" },
        build: { id: "skillet", label: "Skillet-fried" },
        ingredients: [SOURDOUGH, HAM],
        leftovers: [PICKLES],
      },
    ],
  };
}

export { picture };
