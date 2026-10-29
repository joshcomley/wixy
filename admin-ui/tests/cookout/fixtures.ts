// Cookout wire fixtures, written from spec/server-chat/09-cookout.md §4.2 (the server is built in
// parallel: these ARE the contract the client was built against). Each builder returns the raw JSON a
// `GET /cookout/{seq}?as=` would send, so the tests run it through the real parser.

export type Json = Record<string, unknown>;

export function snap(id: string, name: string, category: string, emoji: string, blurb = ""): Json {
  return { id, name, category, emoji, blurb };
}

export const TOAST = snap("thick-white-toast", "Thick-cut white toast", "prepared-pantry", "🍞", "Crisp golden slices ready for topping.");
export const RIBEYE = snap("ribeye-steak", "Ribeye steak", "meat-poultry", "🥩", "Richly marbled and full of flavour.");
export const PARSLEY = snap("flat-leaf-parsley", "Flat-leaf parsley", "herbs-aromatics", "🌿", "Bright, grassy and fresh.");
export const SUGAR = snap("dark-brown-sugar", "Dark brown sugar", "sweet-baking", "🍯", "Deep molasses sweetness.");
export const ESPRESSO = snap("double-espresso", "Double espresso", "drinks-alcohol", "☕", "Bitter, roasted and bold.");
export const BROCCOLI = snap("tenderstem-broccoli", "Tenderstem broccoli", "vegetables", "🥦", "Sweet, tender stems.");
export const PAPRIKA = snap("smoked-paprika", "Smoked paprika", "spices-seasonings", "🌶️", "Warm, smoky depth.");
export const GRUYERE = snap("aged-gruyere", "Aged Gruyère", "dairy-eggs", "🧀", "Nutty and crystalline.");
export const BEANS = snap("tinned-baked-beans", "Tinned baked beans", "prepared-pantry", "🥫", "Sweet tomato sauce comfort.");
export const MISO = snap("white-miso", "White miso", "sauces-stocks-fermented", "🫙", "Mellow, savoury depth.");
export const SALMON = snap("salmon-fillet", "Salmon fillet", "fish-seafood", "🐟", "Rich and flaky.");
export const LENTILS = snap("red-lentils", "Red lentils", "legumes-nuts-seeds", "🫘", "Cook down to a silky purée.");

export const P1_PICKS = [TOAST, PARSLEY, ESPRESSO, PAPRIKA, BEANS];
export const P2_PICKS = [RIBEYE, SUGAR, BROCCOLI, GRUYERE, MISO];

export const STAPLES = [
  { id: "water", name: "Water" },
  { id: "salt", name: "Salt" },
  { id: "black-pepper", name: "Black pepper" },
  { id: "butter", name: "Butter" },
  { id: "plain-flour", name: "Plain flour" },
  { id: "cooking-oil", name: "Cooking oil" },
  { id: "granulated-sugar", name: "Granulated sugar" },
  { id: "milk", name: "Milk" },
];

const NO_RECIPE = { state: "none", requestedBy: null, bankedAt: null, error: null, data: null };

export function recipesNone(): Json {
  return { a: { ...NO_RECIPE }, b: { ...NO_RECIPE }, c: { ...NO_RECIPE } };
}

export interface PickingOptions {
  readonly seq?: number;
  readonly rev?: number;
  readonly blind?: boolean;
  /** The viewer's slot, or null for a non-player. */
  readonly you?: 1 | 2 | null;
  readonly turn?: number;
  readonly offerIndex?: number;
  readonly player2?: string | null;
  /** Whether the active pair is in the view (false = Blind and not the viewer's turn, or waiting). */
  readonly showOptions?: boolean;
  readonly waitingForJoin?: boolean;
  readonly options?: readonly [Json, Json];
  readonly p1Picks?: readonly Json[] | null;
  readonly p2Picks?: readonly Json[] | null;
  readonly p1Count?: number;
  readonly p2Count?: number;
}

/** A round being picked, as the server would filter it for the viewer. */
export function pickingView(o: PickingOptions = {}): Json {
  const turn = o.turn ?? 1;
  const player = turn % 2 === 1 ? 1 : 2;
  const offerIndex = o.offerIndex ?? 0;
  const show = o.showOptions ?? true;
  const p1Picks = o.p1Picks === undefined ? P1_PICKS.slice(0, Math.floor(turn / 2)) : o.p1Picks;
  const p2Picks = o.p2Picks === undefined ? P2_PICKS.slice(0, Math.floor((turn - 1) / 2)) : o.p2Picks;
  return {
    seq: o.seq ?? 41,
    state: "picking",
    rev: o.rev ?? 3,
    blind: o.blind ?? false,
    revealed: false,
    players: [
      { slot: 1, name: "Josh", pickCount: o.p1Count ?? p1Picks?.length ?? 0, picks: p1Picks },
      {
        slot: 2,
        name: o.player2 === undefined ? "Cupcake" : o.player2,
        pickCount: o.p2Count ?? p2Picks?.length ?? 0,
        picks: p2Picks,
      },
    ],
    you: o.you === null ? null : { slot: o.you ?? 1 },
    current: {
      turn,
      player,
      role: show ? "protein" : null,
      waitingForJoin: o.waitingForJoin ?? false,
      options: show ? (o.options ?? [RIBEYE, SALMON]) : null,
      offerIndex: show ? offerIndex : null,
      skipsRemaining: show ? 2 - offerIndex : null,
    },
    history: [],
    staples: STAPLES,
    concepts: { state: "none", data: null, error: null },
    images: { state: "none", pictures: { a: null, b: null, c: null } },
    recipes: recipesNone(),
  };
}

export function concept(id: "a" | "b" | "c", title: string, dishType: string, technique: string): Json {
  const picked = [...P1_PICKS, ...P2_PICKS].filter((s) => s["id"] !== "tinned-baked-beans" && s["id"] !== "white-miso");
  return {
    id,
    title,
    vibe: id === "a" ? "Steakhouse Bistro" : id === "b" ? "Cosy Sunday" : "Street Food",
    dishType,
    technique,
    description: `${title}: a generous dish for two built around the basket's best bits, finished with something bright.`,
    pickedIngredients: picked,
    staplesUsed: [
      { id: "salt", name: "Salt" },
      { id: "black-pepper", name: "Black pepper" },
      { id: "butter", name: "Butter" },
    ],
    omitted: [
      { ingredient: BEANS, reason: "Left out so the espresso pan-sauce stays sharp and glossy." },
      { ingredient: MISO, reason: "Gruyère already provides the savoury finish." },
    ],
  };
}

export const CONCEPTS = [
  concept("a", "Espresso-Glazed Ribeye over Crispy Toast", "platter", "pan-fry"),
  concept("b", "Smoky Gruyère & Broccoli Toastie Bake", "bake", "bake"),
  concept("c", "Paprika Steak Sandwiches with Herb Butter", "sandwich", "grill"),
];

export function picture(n: number): Json {
  return { attachmentId: `att-${n}`, thumbUrl: `/api/admin/server/media/thumb-${n}.jpg`, fullUrl: `/api/admin/server/media/full-${n}.jpg` };
}

export const FULL_RECIPE: Json = {
  serves: 2,
  prepMinutes: 15,
  cookMinutes: 20,
  totalMinutes: 35,
  ingredients: [
    { id: "ribeye-steak", quantity: "2 steaks (approx. 220g each)", note: "room temperature" },
    { id: "thick-white-toast", quantity: "2 thick slices", note: "toasted golden" },
    { id: "butter", quantity: "2 tbsp", note: "unsalted" },
  ],
  steps: [
    { text: "Pat the steaks dry and season with smoked paprika, salt and black pepper.", minutes: 3, uses: ["ribeye-steak"] },
    { text: "Sear in a hot pan for 3 minutes a side, basting with the butter.", minutes: 6, uses: ["ribeye-steak", "butter"] },
    { text: "Rest the steak on the toast and spoon over the pan juices.", minutes: null, uses: ["thick-white-toast"] },
  ],
  tips: ["Resting the steak on the toast lets it soak up every drop."],
};

export interface FinishedOptions {
  readonly seq?: number;
  readonly rev?: number;
  readonly blind?: boolean;
  readonly concepts?: "pending" | "ready" | "failed" | "unavailable";
  readonly images?: "none" | "pending" | "done" | "failed";
  readonly pictures?: { readonly a?: Json | null; readonly b?: Json | null; readonly c?: Json | null };
  readonly recipes?: Json;
}

/** A finished round: all ten revealed. */
export function finishedView(o: FinishedOptions = {}): Json {
  const conceptsState = o.concepts ?? "ready";
  return {
    seq: o.seq ?? 41,
    state: "finished",
    rev: o.rev ?? 12,
    blind: o.blind ?? false,
    revealed: true,
    players: [
      { slot: 1, name: "Josh", pickCount: 5, picks: P1_PICKS },
      { slot: 2, name: "Cupcake", pickCount: 5, picks: P2_PICKS },
    ],
    you: { slot: 1 },
    current: null,
    history: [],
    staples: STAPLES,
    concepts: {
      state: conceptsState,
      data: conceptsState === "ready" ? CONCEPTS : null,
      error: conceptsState === "failed" ? "validation" : null,
    },
    images: {
      state: o.images ?? "pending",
      pictures: { a: o.pictures?.a ?? null, b: o.pictures?.b ?? null, c: o.pictures?.c ?? null },
    },
    recipes: o.recipes ?? recipesNone(),
  };
}

export function bankedRecipes(which: "a" | "b" | "c" = "a"): Json {
  const recipes = recipesNone();
  recipes[which] = { state: "banked", requestedBy: "Cupcake", bankedAt: 1793210000, error: null, data: FULL_RECIPE };
  return recipes;
}

export function bookBody(): Json {
  return {
    recipes: [
      {
        seq: 41,
        conceptId: "a",
        title: "Espresso-Glazed Ribeye over Crispy Toast",
        vibe: "Steakhouse Bistro",
        description: "Seared ribeye…",
        serves: 2,
        prepMinutes: 15,
        cookMinutes: 20,
        totalMinutes: 35,
        bankedAt: 1793210000,
        requestedBy: "Cupcake",
        picture: picture(1),
      },
      {
        seq: 30,
        conceptId: "c",
        title: "Lentil & Salmon Traybake",
        vibe: "Weeknight",
        description: "…",
        serves: 2,
        prepMinutes: 10,
        cookMinutes: 70,
        totalMinutes: 80,
        bankedAt: 1793100000,
        requestedBy: "Josh",
        picture: null,
      },
    ],
  };
}

/** The URL of the catalogue picture whose content hash is `hex` (one hex digit, repeated 64 times). Both
 * renditions share it in these fixtures: a test that asks "did this picture leak?" greps for this URL. */
export function imageUrl(hex: string): string {
  return `/admin/cookout-img/${hex.repeat(64)}.webp`;
}

/** The wire form of a catalogue picture whose content hash is `hex`. */
export function imageOf(hex: string): Json {
  return { card: imageUrl(hex), thumb: imageUrl(hex) };
}

/** An ingredient snap with a picture and a catalogue what-line (the new wire fields). */
export function imaged(base: Json, hex: string, what: string | null = null): Json {
  return { ...base, image: imageOf(hex), what };
}
