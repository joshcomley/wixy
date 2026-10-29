// Shared builders and the pane harness for the Cookout TWISTS suites (spec/server-chat/09a-cookout-twists.md
// §4.3 wire, §8 "vitest" bullet). Every builder returns the raw JSON a `GET /cookout/{seq}?as=` would send,
// by spreading extra twist keys onto the core builders of `fixtures.ts`, so the tests run it through the
// real parser. The harness mirrors `cookoutGame.test.ts`'s own, with the twists' seams (reduced motion,
// an inspectable mini-chat pop-up) added.

import { vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import { createGameTabs, type GameTabs } from "../../src/server/gameTabs";
import type { ItemChat } from "../../src/server/itemChat";
import { createGameFloat } from "../../src/server/gameFloat";
import { parseCookoutView, type CookoutOutcome, type CookoutView } from "../../src/server/cookout/api";
import { createCookoutGame, type CookoutGame, type CookoutGameApi } from "../../src/server/cookout/cookoutGame";
import { createCookoutModel, type CookoutModel } from "../../src/server/cookout/model";
import {
  CONCEPTS,
  FULL_RECIPE,
  LENTILS,
  PARSLEY,
  P1_PICKS,
  P2_PICKS,
  RIBEYE,
  SALMON,
  finishedView,
  picture,
  pickingView,
  recipesNone,
  snap,
  type FinishedOptions,
  type Json,
  type PickingOptions,
} from "./fixtures";

export type { Json };

// -- Extra ingredients -----------------------------------------------------------------------------------

export const TOMATOES = snap("cherry-tomatoes", "Cherry tomatoes", "vegetables", "🍅", "Sweet and bursting.");
export const DURIAN = snap("fresh-durian", "Fresh durian", "fruit", "🍈", "Wildly pungent.");
export const NATTO = snap("fermented-natto", "Fermented natto", "sauces-stocks-fermented", "🫘", "Sticky and funky.");
export const KIMCHI = snap("aged-kimchi", "Aged kimchi", "sauces-stocks-fermented", "🥬", "Sour and fiery.");

/** A pick as the twists' wire carries it: with the turn it was made on and how it got into the basket. */
export function pick(ingredient: Json, turn: number | null, via: "pick" | "lucky" | "chaos" | "seed" | "wildcard" | "swap" = "pick"): Json {
  return { ...ingredient, turn, via };
}

// -- Setup ---------------------------------------------------------------------------------------------

export const NO_SETUP: Json = {
  style: null,
  styleSpun: false,
  challenge: null,
  wildcard: false,
  stars: false,
  fridgeRaid: false,
  encore: null,
};

export const STYLE_COSY: Json = { id: "cosy-pub", label: "Cosy pub", emoji: "🍺" };
export const CHALLENGE_PAN: Json = { id: "one-pan", label: "One pan only", emoji: "🍳" };

export function setup(patch: Json = {}): Json {
  return { ...NO_SETUP, ...patch };
}

export const NO_STARS: Json = { enabled: false, mine: null, partnerChosen: false, revealed: false, partner: null };

export function stars(patch: Json = {}): Json {
  return { ...NO_STARS, enabled: true, ...patch };
}

// -- Picking -----------------------------------------------------------------------------------------------

/** `pickingView`, with extra keys put on the root and/or the `current` turn. */
export function twistPicking(o: PickingOptions = {}, root: Json = {}, current: Json = {}): Json {
  const base = pickingView(o);
  return { ...base, ...root, current: { ...(base["current"] as Json), ...current } };
}

// -- Finished ----------------------------------------------------------------------------------------------

/** `finishedView`, with extra keys put on the root. */
export function twistFinished(o: FinishedOptions = {}, root: Json = {}): Json {
  return { ...finishedView(o), ...root };
}

/** The chef has not started: the round waits behind the gate (09a §1.4). */
export function gated(waitingFor: readonly string[], root: Json = {}, o: FinishedOptions = {}): Json {
  return twistFinished(o, {
    concepts: { state: "none", data: null, error: null },
    images: { state: "none", pictures: { a: null, b: null, c: null } },
    gate: { waitingFor },
    ...root,
  });
}

export function bankedSlot(generation: number, extra: Json = {}): Json {
  return { state: "banked", requestedBy: "Cupcake", bankedAt: 1793210000, error: null, data: FULL_RECIPE, generation, cooked: null, ...extra };
}

export function cookedInfo(patch: Json = {}): Json {
  return { cookedAt: 1793300000, cookedBy: "Josh", ratings: { "1": null, "2": null }, photo: null, photoMessageSeq: null, ...patch };
}

/** An earlier dish set (after a rescue swap). */
export function earlierSet(generation: number, patch: Json = {}): Json {
  const recipes = recipesNone();
  for (const id of ["a", "b", "c"]) (recipes[id] as Json)["generation"] = generation;
  return {
    generation,
    basket: [...P1_PICKS, ...P2_PICKS].map((s) => ({ ...s })),
    concepts: CONCEPTS,
    pictures: { a: picture(11), b: null, c: null },
    vote: { votes: null, match: null },
    recipes,
    ...patch,
  };
}

export function readyVote(patch: Json = {}): Json {
  return { you: null, partnerVoted: false, revealed: false, votes: null, match: null, ...patch };
}

export const NO_SWAP: Json = { state: "none", available: false, by: null, out: null, pair: null, in: null };

export function swap(patch: Json = {}): Json {
  return { ...NO_SWAP, ...patch };
}

// -- Parsing ------------------------------------------------------------------------------------------------

export function v(raw: Json): CookoutView {
  const view = parseCookoutView(raw);
  if (view === null) throw new Error("fixture did not parse");
  return view;
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/** Several flushes: a call through the model takes more than one microtask turn to settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await flush();
}

export function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
}

export function qa<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

export function visible(root: ParentNode, selector: string): boolean {
  const node = root.querySelector<HTMLElement>(selector);
  if (node === null) return false;
  for (let el: HTMLElement | null = node; el !== null; el = el.parentElement) if (el.hidden) return false;
  return true;
}

// -- The pane harness -------------------------------------------------------------------------------------

export type ApiMock = { [K in keyof CookoutGameApi]: ReturnType<typeof vi.fn> };

export interface Harness {
  game: CookoutGame;
  tabs: GameTabs;
  model: CookoutModel;
  api: ApiMock;
  pane: HTMLElement;
  itemChat: { openPopup: ReturnType<typeof vi.fn> };
  lockNow: ReturnType<typeof vi.fn>;
  openStartSheet: ReturnType<typeof vi.fn>;
  clock: { now: number; intervals: Map<number, () => void>; timeouts: Map<number, () => void> };
  /** Shows a raw view in the pane; the revision is bumped for you so a later view is never "older". */
  show(raw: Json): CookoutView;
  /** An answer from the server: the raw view at the next revision. */
  ok(raw: Json): CookoutOutcome;
}

export interface HarnessOptions {
  readonly reducedMotion?: boolean;
  /** The model's reads of a round (none by default: there is no session). */
  readonly fetchRound?: (seq: number) => Promise<CookoutOutcome>;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const strip = document.createElement("div");
  strip.className = "fake-strip";
  const openPopup = vi.fn();
  const itemChat = {
    popup: document.createElement("div"),
    createStrip: () => ({ element: strip, draw: () => {} }),
    openPopup,
    closePopup: vi.fn(),
    isPopupOpen: () => false,
    popupSeq: () => null,
    refresh: vi.fn(),
    reset: vi.fn(),
  } as unknown as ItemChat;
  const tabs = createGameTabs({ document, itemChat, onLayoutChange: () => {} });
  const model = createCookoutModel({
    session: () => (options.fetchRound === undefined ? null : { token: "tok", expiresAt: 9_999_999_999 }),
    viewer: () => "Josh",
    fetchRound: async (_session, seq) => (options.fetchRound === undefined ? { ok: false, kind: "unavailable" } : options.fetchRound(seq)),
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
  let moveCounter = 0;
  let rev = 100;
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
    openBook: vi.fn(),
    openLightbox: vi.fn(),
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
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: () => options.reducedMotion === true }),
  });
  document.body.append(game.pane, tabs.tabBar);
  return {
    game,
    tabs,
    model,
    api,
    pane: game.pane,
    itemChat: { openPopup },
    lockNow,
    openStartSheet,
    clock,
    show(raw) {
      rev += 1;
      const view = v({ ...raw, rev });
      model.apply(view);
      if (tabs.seqOf("cookout") !== view.seq) game.open(view.seq);
      tabs.refresh();
      return view;
    },
    ok(raw) {
      rev += 1;
      return { ok: true, view: v({ ...raw, rev }) };
    },
  };
}

/** Every banked-recipe view in this suite is for dish `a` of round 41 unless a test says otherwise. */
export { FULL_RECIPE, LENTILS, PARSLEY, P1_PICKS, P2_PICKS, RIBEYE, SALMON, CONCEPTS, picture, pickingView, finishedView, recipesNone, snap };
