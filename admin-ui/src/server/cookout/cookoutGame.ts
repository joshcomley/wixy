// The Cookout GAME PANE (workspace 00058; spec/server-chat/09-cookout.md §5.3, and round 2's picture-first
// table, spec/server-chat/09b-cookout-visual.md §D): when a round is opened its tab shows the kitchen
// full-height, phone-first. While the round is being PICKED the pane is a fixed table that fits the phone
// without scrolling (09b §D.3 — every row height below is budgeted against the pane's own height):
//
//   [ 🍳 (Blind)                     ?  Recipe book  End game / New  ✕ ]   title row, 44 px
//   [ Twists ⭐ 🛎️ 🎡 ]                                                    only with start-sheet twists
//   [ Your turn — tap the one you want / Pick 2 of 5 · 🍗 protein · … ]   the turn banner
//   [ (J) ▣ ▣ ▢ ▢ ▢  |  (C) ▣ ▢ ▢ ▢ ▢ ]                                    "Basket so far": one button
//   [ picture card   or   picture card ]                                  the stage: one tap picks
//   [ Deal two new ones (2 left)                         🎲 Twists ]     the actions
//   [ the chat row: a floating message (left) and the chat FAB (right) ]  reserved, never over a control
//
// A container query on the pane's height switches to a compact table (no twists strip, a one-line banner,
// no what-line on the cards) and, below that, lets only the stage scroll. A light intro card explains the
// round the first time this device opens it (`intro.ts`); `?` brings it back.
//
// The games run FULL SCREEN (decisions/00194): the chat header and the composer are hidden while this tab
// shows, so everything that must stay reachable lives in the pane's own title row. The conversation is the
// shared chat FAB, floating message and quick reply (`gameFloat.ts`), whose overlay sits in a reserved chat
// row under the scrolling column (as WYR's), so it never covers a pick, a skip or a Bank at any scroll
// position; and the round's pop-up chat.
//
// When all ten are picked the table gives way to the chef stage (it scrolls): the revealed basket as a grid
// of pictures (in a Blind round the ten flip open together) and the cupboard staples, then while the chef
// works a carousel of the chosen ingredients with fun facts (`carousel.ts`), then three dish cards whose
// picture placeholders fill in as the photos arrive, each with "Bank this ✓" → "Writing recipe…" →
// "Banked ✓ — View full recipe".
//
// PICTURES. Every ingredient is drawn through `pictures.ts`: its catalogue photograph, or the same-size
// emoji tile when there is none (09b §D.6). A new pair on the table is decoded before it swaps in.
//
// BLIND MODE never reaches this file as data: the server leaves the partner's options, offers and picks
// out of the view (spec §1.3), so the cloche and the "🔒 Secret pick" cards are drawn from counts alone and
// no ingredient string of the partner's can be in the DOM.
//
// Like the other games it registers with the shared frame (`gameTabs.ts`) as "cookout" and opens the shared
// per-item pop-up chat (`itemChat.ts`). It holds NO idle-lock suspension — not even through the
// minutes the chef and the pictures take (Inv 43/55: the lock is a privacy feature) — and Escape stays the
// chat's panic key: nothing here listens for it. Its only long-lived resources are a one-second timer for
// the chef's elapsed clock (only while that is on screen) and a toast timer, both released in `onHide` and
// `reset`. Everything user-visible is set via `textContent`.
//
// The pane redraws a section only when what that section shows changed (its key), so a scrolled list,
// an expanded recipe, ticked-off ingredients and loaded photos survive the frequent refreshes of a round
// whose pictures and recipes are still arriving.
//
// THE TWISTS (spec/server-chat/09a-cookout-twists.md §9) add to every stage, and all of them are things
// the players may simply ignore: a rules strip under the header (style, challenge, cloche, stars); on the
// table 🪙 Lucky dip, 🌋 Chaos shelf and — for the waiting partner in Open mode — 🧹 Sweep it; ☆/★ secret
// stars on your own picks; the chef gate (stars, then "Lift the cloche?"); on the dishes 🍽️ "I'd eat this
// tonight", 🔄 Rescue swap and "Earlier dishes"; and 👩‍🍳 "We cooked it!" on a banked recipe
// (`cookedSheet.ts`). The secrets (the partner's star, their vote, their chaos pair in Blind) never reach
// this file before their reveal: the server leaves them out, and `api.ts` drops them again if sent.
//
// GENERATION. A vote, a Bank or a retry is sent with the `generation` of the view its button was drawn
// from (captured when drawn, never re-read when tapped), so a tap that lands after a rescue swap is
// refused by the server instead of acting on a different dish with the same letter.

import { ServerLockedError } from "../api/http";
import type { Message } from "../api/messages";
import type { GameTabs } from "../gameTabs";
import type { GameFloat } from "../gameFloat";
import type { ItemChat } from "../itemChat";
import type { LockHooks } from "../types";
import {
  allPicks,
  CONCEPT_IDS,
  formatMinutes,
  isChallengeId,
  isStyleId,
  PICKS_PER_PLAYER,
  type Concept,
  type ConceptId,
  type CookoutOutcome,
  type CookoutPlayer,
  type CookoutRole,
  type CookoutView,
  type FullRecipe,
  type GenerationView,
  type IngredientSnap,
  type PhotosResult,
  type PickSnap,
  type Picture,
  type RecipeSlot,
  type Staple,
} from "./api";
import { createCarousel, type Carousel } from "./carousel";
import { createCookedControls } from "./cookedSheet";
import { createIntro, twistPhrases } from "./intro";
import type { CookoutModel } from "./model";
import { DECODE_WAIT_MS, decodeAll, ingredientPicture, type Picturable } from "./pictures";
import type { StartPreset } from "./startSheet";

export interface TableMove {
  readonly moveId: string;
  readonly turn: number;
  readonly offer: number;
}

export interface CookoutGameApi {
  join(seq: number): Promise<CookoutOutcome>;
  skip(seq: number, input: TableMove & { readonly optionIds: readonly [string, string] }): Promise<CookoutOutcome>;
  pick(seq: number, input: TableMove & { readonly ingredientId: string }): Promise<CookoutOutcome>;
  abandon(seq: number): Promise<CookoutOutcome>;
  retryConcepts(seq: number, generation: number): Promise<CookoutOutcome>;
  retryPictures(seq: number, generation: number): Promise<CookoutOutcome>;
  bank(seq: number, conceptId: ConceptId, moveId: string, generation: number): Promise<CookoutOutcome>;
  retryRecipe(seq: number, conceptId: ConceptId, generation: number): Promise<CookoutOutcome>;
  // -- Twists --
  lucky(seq: number, input: TableMove & { readonly optionIds: readonly [string, string] }): Promise<CookoutOutcome>;
  chaos(seq: number, input: TableMove & { readonly optionIds: readonly [string, string] }): Promise<CookoutOutcome>;
  veto(seq: number, input: TableMove & { readonly ingredientId: string }): Promise<CookoutOutcome>;
  star(seq: number, ingredientId: string): Promise<CookoutOutcome>;
  wildcard(seq: number, moveId: string, lift: boolean): Promise<CookoutOutcome>;
  vote(seq: number, generation: number, conceptId: ConceptId): Promise<CookoutOutcome>;
  proposeSwap(seq: number, moveId: string, ingredientId: string): Promise<CookoutOutcome>;
  chooseSwap(seq: number, moveId: string, ingredientId: string): Promise<CookoutOutcome>;
  cancelSwap(seq: number): Promise<CookoutOutcome>;
  markCooked(seq: number, generation: number, conceptId: ConceptId, cooked: boolean): Promise<CookoutOutcome>;
  rate(seq: number, generation: number, conceptId: ConceptId, rating: number | null): Promise<CookoutOutcome>;
  linkPhoto(
    seq: number,
    generation: number,
    conceptId: ConceptId,
    messageSeq: number | null,
    attachmentId: string | null,
  ): Promise<CookoutOutcome>;
  photos(seq: number): Promise<PhotosResult>;
}

export interface CookoutGameDeps {
  readonly document: Document;
  readonly model: CookoutModel;
  /** The shared tab bar: this pane registers itself as the game "cookout". */
  readonly tabs: GameTabs;
  /** The shared item chat: the round's pop-up chat ("Send a new photo to this game's chat"). */
  readonly itemChat: Pick<ItemChat, "openPopup">;
  /** The shared chat FAB / floating message / quick reply: this pane embeds one overlay. */
  readonly float: Pick<GameFloat, "createOverlay">;
  readonly hooks: Pick<LockHooks, "lockNow">;
  readonly api: CookoutGameApi;
  /** The round's anchor message, or undefined once it is gone (deleted, wiped). */
  roundMessage(seq: number): Message | undefined;
  /** The other person's display name when it is known (for "Waiting for …" before they join). */
  partner(): string | null;
  /** Opens the start sheet preselected (the header's New: this round's setup; a dish's encore). */
  openStartSheet(preset: StartPreset): void;
  /** Opens the Recipe book screen. */
  openBook(): void;
  openLightbox(src: string, alt: string): void;
  /** Call after any change that may have altered the layout's height. */
  afterChange(): void;
  /** Test seams. */
  readonly clock?: {
    now(): number;
    setTimeout(callback: () => void, ms: number): number;
    clearTimeout(id: number): void;
    setInterval(callback: () => void, ms: number): number;
    clearInterval(id: number): void;
  };
  newId?(): string;
  /** Whether the viewer asked for less motion (the coin flip, the wheel and the lid then do not play). */
  reducedMotion?(): boolean;
  /** The device's storage for the intro's "seen" flags (default: `localStorage`; a throw counts as none). */
  storage?(): Pick<Storage, "getItem" | "setItem"> | null;
}

export interface CookoutGame {
  /** The game tab's content — sits in the thread view where the message thread is. */
  readonly pane: HTMLElement;
  open(seq: number): void;
  /** Opens the round straight at one dish's full recipe (the Recipe book's tap). */
  openRecipe(seq: number, conceptId: ConceptId, generation?: number): void;
  offer(seq: number): void;
  close(): void;
  /** The open round, or null. */
  gameSeq(): number | null;
  /** Lock / wipe / teardown: forget what outlives closing the tab (the wheels already played, moves still
   * waiting for an answer). Closing the tab alone keeps them. */
  forgetAll(): void;
}

// -- Words ---------------------------------------------------------------------------------------------

const CATEGORY_NAMES: Readonly<Record<string, string>> = {
  "meat-poultry": "Meat & Poultry",
  "fish-seafood": "Fish & Seafood",
  vegetables: "Vegetables & Greens",
  fungi: "Mushrooms & Fungi",
  fruit: "Fruit & Citrus",
  "dairy-eggs": "Dairy, Cream & Eggs",
  "grains-bakery": "Bread, Pasta & Grains",
  "legumes-nuts-seeds": "Beans, Nuts & Seeds",
  "herbs-aromatics": "Fresh Herbs & Aromatics",
  "spices-seasonings": "Spices & Chilis",
  "oils-fats-condiments": "Oils, Fats & Condiments",
  "sauces-stocks-fermented": "Sauces, Pastes & Pickles",
  "sweet-baking": "Sweet, Sugar & Baking",
  "prepared-pantry": "Prepared & Comfort Pantry",
  "drinks-alcohol": "Splash, Brews & Infusions",
};

/** A category id as words: the bank's own name for the fifteen, a tidied id for anything newer. */
export function categoryName(id: string): string {
  const known = CATEGORY_NAMES[id];
  if (known !== undefined) return known;
  const words = id.replace(/[-_]+/g, " ").trim();
  return words === "" ? "Ingredient" : words.charAt(0).toUpperCase() + words.slice(1);
}

const ROLE_WORDS: Readonly<Record<CookoutRole, string>> = {
  base: "🍞 base",
  protein: "🍗 protein",
  produce: "🥕 produce",
  accent: "🌿 accent",
};

/** "🍗 protein" for the banner's second line, or "" when the role is not known to this viewer. */
export function roleShort(role: CookoutRole | null): string {
  return role === null ? "" : ROLE_WORDS[role];
}

/** The skip button's words for the offer on screen (09b §D.3): two new pairs at most, then the final one. */
export function skipLabel(offerIndex: number, skipsRemaining: number | null = null): string {
  const left = skipsRemaining ?? Math.max(0, 2 - offerIndex);
  if (offerIndex >= 2 || left <= 0) return "Final pair";
  return `Deal two new ones (${left} left)`;
}

/** A partner name longer than this is "your partner" in the banner (09b §D.3: a copy rule, never a clip). */
export const BANNER_NAME_MAX = 12;

/** The banner's name for somebody: their name when short enough, else "your partner". */
export function bannerName(name: string | null): string {
  return name !== null && name.trim() !== "" && name.length <= BANNER_NAME_MAX ? name : "your partner";
}

function sentence(text: string): string {
  return text === "" ? "" : text.charAt(0).toUpperCase() + text.slice(1);
}

/** The turn banner (09b §D.3): one big line saying whose turn it is and what to do, and a small one. */
export interface TurnBanner {
  readonly line1: string;
  readonly line2: string;
  /** The viewer is the joiner: a Join button stands in for line 2. */
  readonly join: boolean;
  /** It is the viewer's own turn. */
  readonly mine: boolean;
}

/** The banner for a round being picked. `sweeping`: the watcher chose "Sweep one" and is choosing which. */
export function turnBanner(view: CookoutView, partnerFallback: string | null, sweeping = false): TurnBanner {
  const current = view.current;
  if (view.state !== "picking" || current === null) return { line1: "", line2: "", join: false, mine: false };
  const pick = `Pick ${pickNumber(current.turn)} of ${PICKS_PER_PLAYER}`;
  const mine = view.you !== null && view.you.slot === current.player;
  const activeName = bannerName(
    playerOf(view, current.player).name ?? (current.player === 2 ? partnerFallback : null) ?? (current.player === 1 ? "Player 1" : null),
  );
  // Somebody who is not playing may join whenever Slot 2 is free — on Player 1's turn as well as their own.
  if (view.you === null && view.players[1].name === null) {
    return { line1: "Join to take your turn", line2: "", join: true, mine: false };
  }
  if (current.waitingForJoin || (current.player === 2 && view.players[1].name === null)) {
    if (view.you?.slot === 1) {
      return { line1: `Waiting for ${bannerName(partnerFallback)} to join`, line2: `${pick} is theirs`, join: false, mine: false };
    }
    return { line1: "Join to take your turn", line2: "", join: false, mine: false };
  }
  if (mine) {
    const offer = current.offerIndex ?? 0;
    let note = "";
    if (current.chaosPair === true) note = "Straight from the chaos shelf";
    else if (current.vetoed !== null) {
      note = `${sentence(bannerName(playerOf(view, current.player === 1 ? 2 : 1).name ?? partnerFallback))} swept one off your table`;
    }
    const skips = offer >= 2 || current.skipsRemaining === 0 ? "final pair" : `${current.skipsRemaining ?? 2 - offer} new ${(current.skipsRemaining ?? 2 - offer) === 1 ? "pair" : "pairs"} left`;
    const line2 = note !== "" ? note : [pick, roleShort(current.role), skips].filter((part) => part !== "").join(" · ");
    return { line1: "Your turn — tap the one you want", line2, join: false, mine: true };
  }
  if (sweeping && current.options !== null) {
    return { line1: "Tap the one to sweep away", line2: `It goes off ${activeName}'s table`, join: false, mine: false };
  }
  const line1 = `${sentence(activeName)} is choosing…`;
  if (current.options === null) return { line1, line2: `Secret pick · ${pick}`, join: false, mine: false };
  if (current.chaosPair === true) return { line1, line2: "A pair from the chaos shelf!", join: false, mine: false };
  return { line1, line2: [pick, roleShort(current.role)].filter((part) => part !== "").join(" · "), join: false, mine: false };
}

const DISH_EMOJI: Readonly<Record<string, string>> = {
  bowl: "🥣",
  traybake: "🍽️",
  stew: "🍲",
  soup: "🍜",
  salad: "🥗",
  pie: "🥧",
  pasta: "🍝",
  rice: "🍚",
  flatbread: "🫓",
  sandwich: "🥪",
  pancake: "🥞",
  fritter: "🧆",
  omelette: "🍳",
  bake: "🥘",
  dessert: "🍰",
  platter: "🍽️",
};

export function dishEmoji(dishType: string): string {
  return DISH_EMOJI[dishType] ?? "🍽️";
}

function tidy(word: string): string {
  const w = word.replace(/[-_]+/g, " ").trim();
  return w === "" ? "" : w.charAt(0).toUpperCase() + w.slice(1);
}

function pickNumber(turn: number): number {
  return Math.ceil(turn / 2);
}

function playerOf(view: CookoutView, slot: 1 | 2): CookoutPlayer {
  return slot === 1 ? view.players[0] : view.players[1];
}

function nameOf(view: CookoutView, slot: 1 | 2, fallback: string): string {
  return playerOf(view, slot).name ?? fallback;
}

/** Elapsed seconds as "0:42" / "3:07". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// -- Twist words ----------------------------------------------------------------------------------------------

/** The style wheel's faces: decoration only (the server already chose the style). */
const WHEEL_FACES: readonly string[] = ["🍺", "🌯", "🥂", "🥞", "🕯️", "🥡", "🧺", "🔥"];

/** A starter's icon: 🧊 for the fridge raid's (always Turn 1), 🔁 for an encore's. */
export function starterIcon(view: CookoutView, snap: PickSnap): string {
  return view.setup.fridgeRaid && snap.turn === 1 ? "🧊" : "🔁";
}

/** The small badge a basket item carries for how it got in ("" for an ordinary pick). */
export function viaBadge(view: CookoutView, snap: PickSnap): string {
  switch (snap.via) {
    case "seed":
      return `${starterIcon(view, snap)} Starter`;
    case "wildcard":
      return "🛎️ Wildcard";
    case "swap":
      return "🔄 Swapped in";
    case "lucky":
      return "🪙";
    case "chaos":
      return "🌋";
    default:
      return "";
  }
}

/** The chef gate's words for this viewer (09a §1.4: the pane shows who it is waiting for). */
export function starsGateText(view: CookoutView, partner: string): string {
  if (!view.gate.waitingFor.includes("stars")) return "";
  if (view.you !== null && view.stars.mine === null) return "⭐ Star one of your five picks — the chef will make it a hero";
  if (view.you !== null) return `Waiting for ${partner} to star one`;
  return "Waiting for the secret stars";
}

/** The dinner vote's banner for this viewer (09a §1.7). */
export function voteBannerText(view: CookoutView, partner: string): string {
  const vote = view.vote;
  if (vote === null) return "";
  if (vote.revealed) {
    if (vote.match !== null) {
      const title = view.concepts.data?.find((c) => c.id === vote.match)?.title;
      return title !== undefined ? `🎯 Tonight's dinner: ${title}!` : "🎯 Tonight's dinner is decided!";
    }
    return "🍽️ You'd each eat something different tonight — see the badges.";
  }
  if (view.you === null) return vote.partnerVoted ? "🍽️ The dinner vote is under way…" : "";
  if (vote.you === null) {
    return vote.partnerVoted
      ? `🍽️ ${partner} has secretly chosen — which would you eat tonight?`
      : "🍽️ Which would you actually eat tonight? Tap one — it stays secret until you've both chosen.";
  }
  return `🍽️ Your vote is in (secret). Waiting for ${partner}…`;
}

const MOVE_ATTEMPTS = 2;
const MOVE_RETRY_MS = 800;
const TOAST_MS = 4_000;
const REVEAL_STAGGER_MS = 90;
/** A blurb longer than this is left off the pick card (never clipped): the catalogue's `what` maximum. */
export const CARD_WHAT_MAX = 60;
/** The coin flip and the lid lift (09a §9: ≈1.2 s). */
const FX_MS = 1_200;

type Busy = "move" | "join" | "abandon" | "concepts" | "pictures" | "star" | "wildcard" | "vote" | "swap";
type TableKind = "skip" | "pick" | "lucky" | "chaos" | "veto";

export function createCookoutGame(deps: CookoutGameDeps): CookoutGame {
  const doc = deps.document;
  const clock = deps.clock ?? {
    now: () => Date.now(),
    setTimeout: (cb: () => void, ms: number) => window.setTimeout(cb, ms),
    clearTimeout: (id: number) => window.clearTimeout(id),
    setInterval: (cb: () => void, ms: number) => window.setInterval(cb, ms),
    clearInterval: (id: number) => window.clearInterval(id),
  };
  const newId =
    deps.newId ??
    (() =>
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className: string, text: string, onClick: () => void, label?: string): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    if (label !== undefined) b.setAttribute("aria-label", label);
    b.setAttribute("data-srv-gesture-boundary", "");
    b.addEventListener("click", onClick);
    return b;
  }

  function emojiSpan(className: string, emoji: string): HTMLElement {
    const span = el("span", className, emoji);
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  // -- Pane DOM -------------------------------------------------------------------------------------------

  const pane = el("div", "wx-srv-game wx-srv-ck");
  pane.setAttribute("data-game", "cookout");
  pane.hidden = true;

  const bar = el("header", "wx-srv-ck-bar");
  const title = el("div", "wx-srv-ck-title");
  title.append(emojiSpan("wx-srv-ck-title-icon", "🍳"), el("span", "wx-srv-ck-title-text", "Cookout"));
  const modeBadge = el("span", "wx-srv-ck-badge");
  modeBadge.hidden = true;
  title.append(modeBadge);
  const actions = el("div", "wx-srv-ck-bar-actions");
  /** `?`: the intro again (09b §D.2). In compact mode it carries a dot when the round has twists. */
  const helpButton = button("wx-srv-ck-chip wx-srv-ck-help", "?", () => openIntro(), "How to play this round");
  helpButton.hidden = true;
  const bookButton = button("wx-srv-ck-chip wx-srv-ck-book", "", () => deps.openBook(), "Recipe book");
  bookButton.append(emojiSpan("wx-srv-ck-chip-icon", "📖"), el("span", "wx-srv-ck-chip-text", "Recipe book"));
  const endButton = button("wx-srv-ck-chip wx-srv-ck-end", "", () => askEnd(), "End this Cookout");
  endButton.append(el("span", "wx-srv-ck-end-long", "End game"), el("span", "wx-srv-ck-end-short", "End"));
  const newButton = button("wx-srv-ck-chip wx-srv-ck-new", "New", () => startNew(), "Start a new Cookout");
  const closeButton = button("wx-srv-ck-chip wx-srv-ck-close", "✕", () => close(), "Close the game");
  actions.append(helpButton, bookButton, endButton, newButton, closeButton);
  bar.append(title, actions);

  const confirmEnd = el("div", "wx-srv-ck-confirm");
  confirmEnd.setAttribute("role", "alertdialog");
  confirmEnd.setAttribute("aria-label", "End this Cookout?");
  confirmEnd.hidden = true;
  const confirmText = el("span", "wx-srv-ck-confirm-text", "End this Cookout? It can't be picked up again.");
  const keepPlaying = button("wx-srv-ck-confirm-keep", "Keep playing", () => cancelEnd());
  const endNow = button("wx-srv-ck-confirm-end", "End game", () => void doAbandon());
  confirmEnd.append(confirmText, keepPlaying, endNow);

  const scroll = el("div", "wx-srv-ck-scroll");
  /** The round's start-sheet twists as chips, once the basket is full (hidden for a twist-free round). */
  const rules = el("div", "wx-srv-ck-rules");
  rules.setAttribute("aria-label", "This round's twists");
  rules.hidden = true;
  /** The picking table (09b §D.3): a fixed grid that fits the pane — strip, banner, progress, stage, actions. */
  const table = el("div", "wx-srv-ck-table");
  table.hidden = true;
  /** While picking, the start-sheet twists as a strip of icons: not a target (`?` explains them). */
  const strip = el("div", "wx-srv-ck-strip");
  strip.hidden = true;
  const turnLine = el("div", "wx-srv-ck-banner");
  turnLine.setAttribute("role", "status");
  const progress = button("wx-srv-ck-progress", "", () => openSheet("basket"));
  const pickStage = el("section", "wx-srv-ck-table-stage");
  pickStage.setAttribute("aria-label", "The table");
  const tableActions = el("div", "wx-srv-ck-actions");
  table.append(strip, turnLine, progress, pickStage, tableActions);
  /** Everything but picking: loading, the chef stage, an ended round. */
  const stage = el("section", "wx-srv-ck-stage");
  scroll.append(table, rules, stage);

  /** The basket sheet and the 🎲 Twists sheet: a bottom sheet over the pane, one at a time. */
  const sheetHost = el("div", "wx-srv-ck-sheet");
  sheetHost.hidden = true;

  const toast = el("div", "wx-srv-ck-toast");
  toast.setAttribute("role", "status");
  toast.hidden = true;

  /** The coin flip and the cloche's lid: a moment over the pane, never in the way of a tap. */
  const fx = el("div", "wx-srv-ck-fx");
  fx.setAttribute("aria-hidden", "true");
  fx.hidden = true;

  const cooked = createCookedControls({
    document: doc,
    api: {
      markCooked: (seq, g, id, value) => deps.api.markCooked(seq, g, id, value),
      rate: (seq, g, id, rating) => deps.api.rate(seq, g, id, rating),
      linkPhoto: (seq, g, id, messageSeq, attachmentId) => deps.api.linkPhoto(seq, g, id, messageSeq, attachmentId),
      photos: (seq) => deps.api.photos(seq),
    },
    run: (callFn) => guarded(callFn),
    async readPhotos(callFn) {
      try {
        return await callFn();
      } catch (error) {
        if (error instanceof ServerLockedError) deps.hooks.lockNow("unauthorized");
        return { ok: false, kind: "unavailable" };
      }
    },
    refetch: (seq) => deps.model.refetch(seq),
    read: (seq) => deps.model.read(seq),
    toast: (text) => showToast(text),
    redraw: () => redraw(),
    openChat: (seq) => deps.itemChat.openPopup(seq, "Cookout chat"),
    openLightbox: (src, alt) => deps.openLightbox(src, alt),
    afterChange: () => deps.afterChange(),
  });
  // The chat row: reserved space under the scrolling column for the FAB (right) and a floating message
  // (left), as WYR's — the play controls scroll above it, so neither can ever cover one (decisions/00194).
  const chatRow = el("div", "wx-srv-game-chatrow");
  chatRow.append(
    deps.float.createOverlay({
      fabLabel: "Open this round's chat",
      popupTitle: "Cookout chat",
      item: () => deps.tabs.seqOf("cookout"),
    }),
  );
  const intro = createIntro({
    document: doc,
    storage: () => (deps.storage !== undefined ? deps.storage() : typeof window === "undefined" ? null : window.localStorage),
    onChange: () => deps.afterChange(),
  });
  pane.append(bar, confirmEnd, scroll, chatRow, toast, fx, cooked.chooser, sheetHost, intro.element);

  // -- Per-round view state ------------------------------------------------------------------------------

  /** The round the pane was last drawn for: a different one starts from nothing. */
  let drawnSeq: number | null = null;
  let visible = false;
  /** Bumped whenever the round on screen changes: an answer for an earlier one is dropped. */
  let generation = 0;
  const busy = new Set<Busy>();
  const banking = new Set<ConceptId>();
  const recipeRetrying = new Set<ConceptId>();
  /** The ingredient whose card was just tapped (it stays pressed until the answer). */
  let pickingId: string | null = null;
  const expanded = new Set<ConceptId>();
  /** Ticked-off recipe ingredients, `"<concept>:<ingredient>"`. Local to this screen. */
  const checked = new Set<string>();
  /** The bottom sheet on show: the basket so far, or the 🎲 Twists menu. */
  let sheet: "basket" | "twists" | null = null;
  /** The watcher chose "Sweep one": the two cards on the table sweep instead of nothing. */
  let sweeping = false;
  /** The pair the table shows (`"<turn>:<offer>:<a>:<b>"`); a new one is decoded before it swaps in. */
  let shownPair: string | null = null;
  /** The pair being decoded right now (a newer view replaces it). */
  let decodingPair: string | null = null;
  /** The chef carousel while it is on screen. */
  let carousel: Carousel | null = null;
  let ending = false;
  /** A dish to open at once (the Recipe book's tap), consumed when its recipe is on screen. */
  let focusConcept: { readonly seq: number; readonly id: ConceptId; readonly generation: number | null } | null = null;
  /** The round was seen being picked here: its Blind reveal plays when it finishes. */
  let sawPicking = false;
  let revealPlayed = false;
  /** When this screen first saw the chef working (local ms): the elapsed clock counts from it. */
  let chefSince: number | null = null;
  let elapsedTimer: number | null = null;
  let toastTimer: number | null = null;
  let moveRetryTimer: number | null = null;
  /** The keys the sections were last drawn for. */
  const drawn = { progress: "", stage: "", banner: "", actions: "", strip: "", sheet: "", rules: "" };
  /** Each dish card's element and the key it was drawn for. */
  const conceptCards = new Map<ConceptId, { readonly element: HTMLElement; key: string }>();
  /** The finished stage's sections (in order) and the keys they were drawn for. */
  const sections = new Map<string, { readonly element: HTMLElement; key: string }>();
  /** The twist move on its way (which button shows "…"). */
  let tableBusy: { readonly kind: TableKind; readonly target: string | null } | null = null;
  /** The rescue-swap chooser: open, and the basket item chosen to send back (awaiting confirm). */
  let swapChoosing = false;
  let swapTarget: string | null = null;
  /** The swap replacement being chosen (the partner's tap). */
  let swapChoice: string | null = null;
  let earlierOpen = false;
  /** Expanded recipes of earlier dish sets, `"<generation>:<concept>"`. */
  const expandedEarlier = new Set<string>();
  /** A dish card's ⋯ menu that is open, `"<generation>:<concept>"`. */
  let dishMenu: string | null = null;
  /** Rounds whose spun-style wheel already landed on this screen (kept until a lock). */
  const wheelPlayed = new Set<number>();
  let fxTimer: number | null = null;

  // -- Small helpers -------------------------------------------------------------------------------------

  function showToast(text: string): void {
    toast.textContent = text;
    toast.hidden = false;
    if (toastTimer !== null) clock.clearTimeout(toastTimer);
    toastTimer = clock.setTimeout(() => {
      toastTimer = null;
      toast.hidden = true;
    }, TOAST_MS);
    deps.afterChange();
  }

  function hideToast(): void {
    if (toastTimer !== null) clock.clearTimeout(toastTimer);
    toastTimer = null;
    toast.hidden = true;
  }

  function partnerFallback(): string | null {
    return deps.partner();
  }

  function failureText(kind: string): string {
    switch (kind) {
      case "not_your_turn":
        return "It isn't your turn any more.";
      case "not_player":
        return "You're not playing in this Cookout.";
      case "skip_exhausted":
        return "No skips left — pick one of these two.";
      case "exhausted":
        return "The pantry has no fresh pair for this turn — pick one of these two.";
      case "token_used":
        return "You've already used that once this game.";
      case "recipe_pending":
        return "A recipe is still being written — wait for it to finish first.";
      case "bad_state":
        return "Somebody else got there first.";
      case "not_found":
        return "This Cookout has gone.";
      default:
        return "Couldn't reach the kitchen — try again.";
    }
  }

  /** Runs a call, turning a lock (401) into the chat locking and any other throw into "unavailable". */
  async function guarded(callFn: () => Promise<CookoutOutcome>): Promise<CookoutOutcome> {
    try {
      return await deps.model.run(callFn);
    } catch (error) {
      if (error instanceof ServerLockedError) deps.hooks.lockNow("unauthorized");
      return { ok: false, kind: "unavailable" };
    }
  }

  function redraw(): void {
    if (drawnSeq !== null && visible) refreshPane(drawnSeq);
  }

  // -- Calls ---------------------------------------------------------------------------------------------

  function reduced(): boolean {
    if (deps.reducedMotion !== undefined) return deps.reducedMotion();
    try {
      return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  /** Plays a short moment over the pane (the coin, the lid); replaced by the next one. */
  function playFx(kind: "coin" | "lid", emoji: string, words: string): void {
    if (fxTimer !== null) clock.clearTimeout(fxTimer);
    const card = el("div", `wx-srv-ck-fx-card wx-srv-ck-fx-${kind}`);
    const art = el("div", "wx-srv-ck-fx-art");
    if (kind === "coin") {
      art.append(el("span", "wx-srv-ck-fx-coin", "🪙"));
    } else {
      art.append(el("span", "wx-srv-ck-fx-lid", "🛎️"));
    }
    art.append(el("span", "wx-srv-ck-fx-food", emoji !== "" ? emoji : "🍽️"));
    card.append(art, el("p", "wx-srv-ck-fx-words", words));
    fx.replaceChildren(card);
    fx.hidden = false;
    fxTimer = clock.setTimeout(() => {
      fxTimer = null;
      fx.hidden = true;
      fx.replaceChildren();
    }, FX_MS);
  }

  function stopFx(): void {
    if (fxTimer !== null) clock.clearTimeout(fxTimer);
    fxTimer = null;
    fx.hidden = true;
    fx.replaceChildren();
  }

  /** What landed in the basket on `turn` (the coin's answer), from a fresh view. */
  function choiceOf(view: CookoutView, turn: number): IngredientSnap | null {
    const fromHistory = view.history.find((t) => t.turn === turn)?.choice;
    if (fromHistory !== undefined && fromHistory !== null) return fromHistory;
    const mine = view.you === null ? null : playerOf(view, view.you.slot).picks;
    return mine?.find((p) => p.turn === turn) ?? null;
  }

  /** A move on the table (skip, pick, lucky dip, chaos shelf, sweep): one move id for every attempt, so a
   * resend after a lost answer is not a second move. Each names the table it saw (turn, offer, and the pair
   * or the target), so a table that changed first makes it stale rather than acting on unseen options. */
  async function move(kind: TableKind, ingredientId: string | null): Promise<void> {
    const seq = drawnSeq;
    const view = seq === null ? undefined : deps.model.view(seq);
    const current = view?.current ?? null;
    if (seq === null || current === null || current.offerIndex === null || current.options === null || busy.has("move")) return;
    const started = generation;
    const moveId = newId();
    const base = { moveId, turn: current.turn, offer: current.offerIndex };
    const optionIds: readonly [string, string] = [current.options[0].id, current.options[1].id];
    busy.add("move");
    tableBusy = { kind, target: ingredientId };
    pickingId = kind === "pick" ? ingredientId : null;
    // A twist chosen from the 🎲 sheet closes it: the table shows what happens.
    if (sheet === "twists") sheet = null;
    redraw();
    const send = (): Promise<CookoutOutcome> => {
      switch (kind) {
        case "pick":
          return deps.api.pick(seq, { ...base, ingredientId: ingredientId ?? "" });
        case "lucky":
          return deps.api.lucky(seq, { ...base, optionIds });
        case "chaos":
          return deps.api.chaos(seq, { ...base, optionIds });
        case "veto":
          return deps.api.veto(seq, { ...base, ingredientId: ingredientId ?? "" });
        default:
          return deps.api.skip(seq, { ...base, optionIds });
      }
    };
    let outcome: CookoutOutcome = { ok: false, kind: "unavailable" };
    for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
      outcome = await guarded(send);
      if (started !== generation) return;
      if (outcome.ok || outcome.kind !== "unavailable" || attempt === MOVE_ATTEMPTS - 1) break;
      await new Promise<void>((resolve) => {
        moveRetryTimer = clock.setTimeout(() => {
          moveRetryTimer = null;
          resolve();
        }, MOVE_RETRY_MS);
      });
      if (started !== generation) return;
    }
    busy.delete("move");
    tableBusy = null;
    pickingId = null;
    // A sweep answered either way ends sweep mode (a refusal shows why; the table is redrawn fresh).
    if (kind === "veto") sweeping = false;
    if (outcome.ok) {
      if (kind === "pick") {
        const chosen = current.options.find((o) => o.id === ingredientId);
        if (chosen !== undefined) showToast(`${chosen.name} is in the basket ✓`);
      } else if (kind === "lucky") {
        // The server already chose; the coin only shows its answer.
        const chosen = choiceOf(outcome.view, current.turn);
        const words = chosen === null ? "The coin has chosen!" : `The coin chose ${chosen.name}`;
        if (reduced()) showToast(`🪙 ${words} ✓`);
        else playFx("coin", chosen?.emoji ?? "", words);
      } else if (kind === "veto") {
        const swept = current.options.find((o) => o.id === ingredientId);
        if (swept !== undefined) showToast(`🧹 ${swept.name} swept off the table`);
      } else if (kind === "chaos") {
        showToast("🌋 Two from the chaos shelf — dare you?");
      }
    } else {
      deps.model.refetch(seq);
      showToast(failureText(outcome.kind));
    }
    redraw();
  }

  /** One twist call that answers with a view (star, cloche, vote, swap): `kind` shows as busy meanwhile. */
  async function twist(kind: Busy, callFn: (seq: number) => Promise<CookoutOutcome>, failed: string): Promise<CookoutOutcome | null> {
    const seq = drawnSeq;
    if (seq === null || busy.has(kind)) return null;
    const started = generation;
    busy.add(kind);
    redraw();
    const outcome = await guarded(() => callFn(seq));
    if (started !== generation) return null;
    busy.delete(kind);
    if (!outcome.ok) {
      deps.model.refetch(seq);
      showToast(outcome.kind === "unavailable" ? failed : failureText(outcome.kind));
    }
    redraw();
    return outcome;
  }

  /** One move id per intended move (round, action, target) until the server gives a definite answer: a tap
   * again after a lost answer resends the move it may already hold, which is answered with the current view
   * rather than refused as somebody else's. */
  const intendedMoves = new Map<string, string>();

  async function intendedMove(
    kind: Busy,
    intent: string,
    callFn: (seq: number, moveId: string) => Promise<CookoutOutcome>,
    failed: string,
  ): Promise<CookoutOutcome | null> {
    const seq = drawnSeq;
    if (seq === null) return null;
    const key = `${seq}:${intent}`;
    const moveId = intendedMoves.get(key) ?? newId();
    intendedMoves.set(key, moveId);
    const outcome = await twist(kind, (s) => callFn(s, moveId), failed);
    if (outcome !== null && (outcome.ok || outcome.kind !== "unavailable") && intendedMoves.get(key) === moveId) intendedMoves.delete(key);
    return outcome;
  }

  function doStar(ingredientId: string): void {
    void twist("star", (seq) => deps.api.star(seq, ingredientId), "Couldn't save your star — try again.");
  }

  async function doWildcard(lift: boolean): Promise<void> {
    const outcome = await intendedMove("wildcard", `wildcard:${lift}`, (seq, moveId) => deps.api.wildcard(seq, moveId, lift), "Couldn't reach the kitchen — try again.");
    if (outcome === null) return;
    if (!outcome.ok && outcome.kind === "exhausted") {
      showToast("The pantry has no surprise left under the lid — “No thanks” starts the cooking.");
      return;
    }
    if (outcome.ok && lift && outcome.view.wildcard.ingredient !== null) {
      const snap = outcome.view.wildcard.ingredient;
      if (reduced()) showToast(`🛎️ Under the lid: ${snap.name}!`);
      else playFx("lid", snap.emoji, `Under the lid: ${snap.name}!`);
    }
  }

  function doVote(viewGeneration: number, conceptId: ConceptId): void {
    void twist("vote", (seq) => deps.api.vote(seq, viewGeneration, conceptId), "Couldn't save your vote — try again.");
  }

  async function doProposeSwap(ingredientId: string): Promise<void> {
    const outcome = await intendedMove("swap", `propose:${ingredientId}`, (seq, moveId) => deps.api.proposeSwap(seq, moveId, ingredientId), "Couldn't send that back — try again.");
    if (outcome?.ok === true) {
      swapChoosing = false;
      swapTarget = null;
      redraw();
    }
  }

  async function doChooseSwap(ingredientId: string): Promise<void> {
    swapChoice = ingredientId;
    await intendedMove("swap", `choose:${ingredientId}`, (seq, moveId) => deps.api.chooseSwap(seq, moveId, ingredientId), "Couldn't swap that in — try again.");
    swapChoice = null;
    redraw();
  }

  function doCancelSwap(): void {
    void twist("swap", (seq) => deps.api.cancelSwap(seq), "Couldn't cancel the swap — try again.");
  }

  async function simple(kind: Busy, callFn: (seq: number) => Promise<CookoutOutcome>, failed: string): Promise<void> {
    const seq = drawnSeq;
    if (seq === null || busy.has(kind)) return;
    const started = generation;
    busy.add(kind);
    redraw();
    const outcome = await guarded(() => callFn(seq));
    if (started !== generation) return;
    busy.delete(kind);
    if (!outcome.ok) {
      deps.model.refetch(seq);
      showToast(outcome.kind === "unavailable" ? failed : failureText(outcome.kind));
    }
    redraw();
  }

  async function doBank(conceptId: ConceptId, viewGeneration: number): Promise<void> {
    const seq = drawnSeq;
    if (seq === null || banking.has(conceptId)) return;
    const started = generation;
    banking.add(conceptId);
    redraw();
    const moveId = newId();
    let outcome: CookoutOutcome = { ok: false, kind: "unavailable" };
    for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
      outcome = await guarded(() => deps.api.bank(seq, conceptId, moveId, viewGeneration));
      if (started !== generation) return;
      if (outcome.ok || outcome.kind !== "unavailable") break;
    }
    banking.delete(conceptId);
    if (!outcome.ok) {
      deps.model.refetch(seq);
      showToast(outcome.kind === "unavailable" ? "Couldn't save that dish — try again." : failureText(outcome.kind));
    }
    redraw();
  }

  async function doRetryRecipe(conceptId: ConceptId, viewGeneration: number): Promise<void> {
    const seq = drawnSeq;
    if (seq === null || recipeRetrying.has(conceptId)) return;
    const started = generation;
    recipeRetrying.add(conceptId);
    redraw();
    const outcome = await guarded(() => deps.api.retryRecipe(seq, conceptId, viewGeneration));
    if (started !== generation) return;
    recipeRetrying.delete(conceptId);
    if (!outcome.ok) {
      deps.model.refetch(seq);
      showToast(outcome.kind === "unavailable" ? "Couldn't restart that recipe — try again." : failureText(outcome.kind));
    }
    redraw();
  }

  function askEnd(): void {
    ending = true;
    confirmEnd.hidden = false;
    keepPlaying.focus();
    deps.afterChange();
  }

  function cancelEnd(): void {
    ending = false;
    confirmEnd.hidden = true;
    deps.afterChange();
  }

  async function doAbandon(): Promise<void> {
    cancelEnd();
    await simple("abandon", (seq) => deps.api.abandon(seq), "Couldn't end the game — try again.");
  }

  /** "New": the start sheet comes back preselected with this round's setup (09a §1.1). */
  function startNew(): void {
    const seq = drawnSeq;
    const view = seq === null ? undefined : deps.model.view(seq);
    if (view === undefined) {
      deps.openStartSheet({});
      return;
    }
    const setup = view.setup;
    const fridge = setup.fridgeRaid ? (view.starters.find((s) => s.turn === 1) ?? null) : null;
    const styleId = setup.style?.id;
    const challengeId = setup.challenge?.id;
    deps.openStartSheet({
      blind: view.blind,
      style: setup.styleSpun ? "spin" : isStyleId(styleId) ? styleId : null,
      challenge: isChallengeId(challengeId) ? challengeId : null,
      wildcard: setup.wildcard,
      stars: setup.stars,
      fridge:
        fridge === null
          ? null
          : { id: fridge.id, name: fridge.name, category: fridge.category, emoji: fridge.emoji, blurb: fridge.blurb, what: fridge.what, image: fridge.image },
    });
  }

  /** A dish's "Encore with the leftovers": a new round seeded with what this dish left out (09a §1.3). */
  function startEncore(view: CookoutView, dishGeneration: number, concept: Concept): void {
    dishMenu = null;
    deps.openStartSheet({
      blind: view.blind,
      encore: {
        fromSeq: view.seq,
        generation: dishGeneration,
        conceptId: concept.id,
        kind: "leftovers",
        title: concept.title,
        candidates: concept.omitted.map((o) => o.ingredient),
      },
    });
  }

  // -- Drawing: the turn banner, the progress button and the sheets (09b §D.3) ------------------------------

  function slotLabel(view: CookoutView, slot: 1 | 2): string {
    if (view.you?.slot === slot) return "You";
    const name = playerOf(view, slot).name;
    if (name !== null) return name;
    return slot === 2 ? "Waiting to join" : "Player 1";
  }

  /** The public starters on `slot`'s turns (odd turns are Slot 1's). */
  function startersOf(view: CookoutView, slot: 1 | 2): PickSnap[] {
    return view.starters.filter((s) => s.turn !== null && (s.turn % 2 === 1 ? 1 : 2) === slot);
  }

  /** A star this viewer may see: their own always, the partner's only once revealed. */
  function isStarred(view: CookoutView, id: string): boolean {
    return view.stars.enabled && (view.stars.mine === id || (view.stars.revealed && view.stars.partner === id));
  }

  /** The two players left to right: the viewer first (a non-player sees Slot 1 first). */
  function slotOrder(view: CookoutView): readonly [1 | 2, 1 | 2] {
    return view.you?.slot === 2 ? [2, 1] : [1, 2];
  }

  /** A one-letter chip for a player ("Y" for the viewer). */
  function initialOf(view: CookoutView, slot: 1 | 2): string {
    const label = view.you?.slot === slot ? "You" : (playerOf(view, slot).name ?? (slot === 2 ? (partnerFallback() ?? "Partner") : "Player"));
    const first = Array.from(label.trim())[0] ?? "?";
    return first.toUpperCase();
  }

  /** What a basket item says it is: the catalogue's line, else the bank's blurb. */
  function whatOf(snap: IngredientSnap): string {
    return snap.what ?? snap.blurb;
  }

  /** One player's five progress slots: passive tiles (the whole row is the one button). */
  function progressGroup(view: CookoutView, slot: 1 | 2): HTMLElement {
    const player = playerOf(view, slot);
    const group = el("span", "wx-srv-ck-prog-group");
    group.dataset["slot"] = String(slot);
    const active = view.current?.player === slot;
    group.classList.toggle("wx-srv-ck-prog-active", active);
    const who = el("span", "wx-srv-ck-prog-who", initialOf(view, slot));
    who.setAttribute("aria-hidden", "true");
    group.append(who);
    // A hidden partner's public starters still show (they are first in pick order).
    const known: readonly PickSnap[] = player.picks ?? startersOf(view, slot);
    for (let i = 0; i < PICKS_PER_PLAYER; i += 1) {
      const pick = known[i];
      let tile: HTMLElement;
      if (pick !== undefined) {
        tile = ingredientPicture(doc, pick, { rendition: "thumb", className: "wx-srv-ck-prog-slot wx-srv-ck-prog-full", alt: "" });
        tile.removeAttribute("role");
        tile.removeAttribute("aria-label");
        tile.dataset["picked"] = pick.id;
        tile.classList.toggle("wx-srv-ck-prog-starter", pick.via === "seed");
        if (isStarred(view, pick.id)) tile.classList.add("wx-srv-ck-prog-star");
      } else if (i < player.pickCount) {
        tile = el("span", "wx-srv-ck-prog-slot wx-srv-ck-prog-secret", "🔒");
      } else {
        tile = el("span", "wx-srv-ck-prog-slot wx-srv-ck-prog-empty");
        tile.classList.toggle("wx-srv-ck-prog-now", active && i === player.pickCount);
      }
      tile.setAttribute("aria-hidden", "true");
      group.append(tile);
    }
    return group;
  }

  function progressLabel(view: CookoutView): string {
    const parts = slotOrder(view).map((slot) => {
      const player = playerOf(view, slot);
      const who = view.you?.slot === slot ? "you have" : `${playerOf(view, slot).name ?? "your partner"} has`;
      return `${who} ${player.pickCount} of ${PICKS_PER_PLAYER}`;
    });
    return `Basket so far: ${parts.join(", ")}. Show the basket.`;
  }

  function drawProgress(view: CookoutView): void {
    const key = JSON.stringify([
      view.players.map((p) => [p.name, p.pickCount, p.picks?.map((x) => [x.id, x.via, x.image?.thumb ?? null]) ?? null]),
      view.starters.map((s) => [s.id, s.turn, s.image?.thumb ?? null]),
      view.stars,
      view.you?.slot ?? null,
      view.current === null ? null : [view.current.player, view.current.turn],
      deps.partner(),
    ]);
    if (drawn.progress === key) return;
    drawn.progress = key;
    const [left, right] = slotOrder(view);
    progress.setAttribute("aria-label", progressLabel(view));
    progress.setAttribute("aria-haspopup", "dialog");
    progress.replaceChildren(progressGroup(view, left), el("span", "wx-srv-ck-prog-divider"), progressGroup(view, right));
  }

  function drawBanner(view: CookoutView): void {
    const words = turnBanner(view, partnerFallback(), sweeping);
    const key = JSON.stringify([words, busy.has("join")]);
    if (drawn.banner === key) return;
    drawn.banner = key;
    turnLine.classList.toggle("wx-srv-ck-banner-mine", words.mine);
    turnLine.classList.toggle("wx-srv-ck-banner-join", words.join);
    const children: HTMLElement[] = [el("p", "wx-srv-ck-turn", words.line1)];
    if (words.join) {
      const join = button(
        "wx-srv-ck-join",
        busy.has("join") ? "Joining…" : "Join",
        () => void simple("join", (seq) => deps.api.join(seq), "Couldn't join — try again."),
        "Join this Cookout",
      );
      join.disabled = busy.has("join");
      children.push(join);
    } else if (words.line2 !== "") {
      children.push(el("p", "wx-srv-ck-turn-sub", words.line2));
    }
    turnLine.replaceChildren(...children);
  }

  /** The drafting twists this viewer could use right now (09a §9): the 🎲 button shows only when one is. */
  function usableTwists(view: CookoutView): boolean {
    const current = view.current;
    if (current === null || current.options === null || view.you === null) return false;
    if (view.you.slot === current.player) return current.canLucky === true || current.canChaos === true;
    return current.canVeto === true;
  }

  function drawActions(view: CookoutView): void {
    const current = view.current;
    const mine = current !== null && view.you !== null && view.you.slot === current.player;
    const key = JSON.stringify([
      current === null ? null : [current.turn, current.offerIndex, current.skipsRemaining, current.options !== null, current.canLucky, current.canChaos, current.canVeto],
      mine,
      sweeping,
      busy.has("move"),
      tableBusy,
      sheet,
      view.you,
      decodingPair,
    ]);
    if (drawn.actions === key) return;
    // While a new pair is still decoding the old one is on screen: nothing may act on a pair not yet seen.
    const settling = decodingPair !== null;
    drawn.actions = key;
    const out: HTMLElement[] = [];
    if (current !== null && current.options !== null) {
      if (mine) {
        const offer = current.offerIndex ?? 0;
        const final = offer >= 2 || current.skipsRemaining === 0;
        const skip = button("wx-srv-ck-skip", skipLabel(offer, current.skipsRemaining), () => void move("skip", null));
        if (final) {
          skip.disabled = true;
          skip.classList.add("wx-srv-ck-skip-final");
        } else {
          skip.disabled = busy.has("move") || settling;
          if (tableBusy?.kind === "skip") skip.textContent = "Dealing…";
        }
        out.push(skip);
      } else if (sweeping) {
        const cancel = button("wx-srv-ck-sweep-cancel", "Cancel", () => {
          sweeping = false;
          redraw();
        }, "Cancel the sweep");
        cancel.disabled = busy.has("move");
        out.push(cancel);
      }
      if (!sweeping && usableTwists(view)) {
        const twists = button("wx-srv-ck-twists-btn", "🎲 Twists", () => openSheet("twists"), "Twists you can use now");
        twists.setAttribute("aria-haspopup", "dialog");
        twists.setAttribute("aria-expanded", sheet === "twists" ? "true" : "false");
        twists.disabled = busy.has("move") || settling;
        out.push(twists);
      }
    }
    tableActions.replaceChildren(...out);
  }

  /** The twist strip while picking (09b §D.3): "Twists" then one icon per start-sheet twist. */
  function drawStrip(view: CookoutView): void {
    const setup = view.setup;
    const spin = setup.styleSpun && setup.style !== null && !wheelPlayed.has(view.seq);
    // `spin` is not part of the key: the very next refresh must not redraw the strip and cut the wheel short.
    const key = JSON.stringify(setup);
    if (drawn.strip === key) return;
    drawn.strip = key;
    const icons: HTMLElement[] = [];
    if (setup.style !== null) icons.push(styleIcon(setup.style.emoji, spin, "wx-srv-ck-strip-icon"));
    if (spin) wheelPlayed.add(view.seq);
    if (setup.challenge !== null) icons.push(emojiSpan("wx-srv-ck-strip-icon", setup.challenge.emoji));
    if (setup.wildcard) icons.push(emojiSpan("wx-srv-ck-strip-icon", "🛎️"));
    if (setup.stars) icons.push(emojiSpan("wx-srv-ck-strip-icon", "⭐"));
    if (setup.fridgeRaid) icons.push(emojiSpan("wx-srv-ck-strip-icon", "🧊"));
    if (setup.encore !== null) icons.push(emojiSpan("wx-srv-ck-strip-icon", "🔁"));
    const phrases = twistPhrases(view);
    strip.hidden = icons.length === 0;
    helpButton.classList.toggle("wx-srv-ck-help-twists", icons.length > 0);
    strip.setAttribute("aria-label", phrases.length === 0 ? "" : `Twists on: ${phrases.join(", ")}`);
    strip.setAttribute("role", "img");
    const word = el("span", "wx-srv-ck-strip-word", "Twists");
    word.setAttribute("aria-hidden", "true");
    strip.replaceChildren(word, ...icons.slice(0, 6));
  }

  /** A style's icon: its emoji, or — the first time a spun style is seen here — the wheel landing on it. */
  function styleIcon(emoji: string, spin: boolean, className: string): HTMLElement {
    if (!spin || reduced()) return emojiSpan(className, emoji);
    const wheel = el("span", `wx-srv-ck-wheel ${className}`);
    wheel.setAttribute("aria-hidden", "true");
    const reel = el("span", "wx-srv-ck-wheel-reel");
    for (const face of [...WHEEL_FACES, ...WHEEL_FACES, emoji]) reel.append(el("span", "wx-srv-ck-wheel-face", face));
    wheel.append(reel);
    return wheel;
  }

  // -- The sheets: the basket so far, and the 🎲 Twists menu --------------------------------------------------

  function openSheet(which: "basket" | "twists"): void {
    sheet = which;
    redraw();
    sheetHost.querySelector<HTMLElement>(".wx-srv-ck-sheet-close")?.focus();
  }

  function closeSheet(): void {
    if (sheet === null) return;
    const was = sheet;
    sheet = null;
    redraw();
    (was === "basket" ? progress : tableActions.querySelector<HTMLElement>(".wx-srv-ck-twists-btn"))?.focus();
  }

  function sheetFrame(title: string, body: HTMLElement[]): HTMLElement[] {
    const backdrop = el("div", "wx-srv-ck-sheet-backdrop");
    backdrop.setAttribute("data-srv-gesture-boundary", "");
    backdrop.addEventListener("click", () => closeSheet());
    const panel = el("div", "wx-srv-ck-sheet-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", title);
    const head = el("div", "wx-srv-ck-sheet-head");
    head.append(el("h3", "wx-srv-ck-sheet-title", title), button("wx-srv-ck-sheet-close", "✕", () => closeSheet(), "Close"));
    const content = el("div", "wx-srv-ck-sheet-body");
    content.append(...body);
    panel.append(head, content);
    return [backdrop, panel];
  }

  /** One basket line in the sheet: the picture, the name, what it is, how it got in, and its star. */
  function basketLine(view: CookoutView, snap: PickSnap, mine: boolean): HTMLElement {
    const line = el("li", "wx-srv-ck-bline");
    line.dataset["picked"] = snap.id;
    line.append(ingredientPicture(doc, snap, { rendition: "thumb", className: "wx-srv-ck-bline-pic" }));
    const words = el("span", "wx-srv-ck-bline-words");
    words.append(el("span", "wx-srv-ck-bline-name", snap.name));
    const what = whatOf(snap);
    if (what !== "") words.append(el("span", "wx-srv-ck-bline-what", what));
    const badge = snap.via === "seed" || snap.via === "wildcard" || snap.via === "swap" ? viaBadge(view, snap) : "";
    if (badge !== "") words.append(el("span", "wx-srv-ck-chip-badge", badge));
    line.append(words);
    const star = starControl(view, snap, mine, "Star this");
    if (star !== null) line.append(star);
    return line;
  }

  function basketSheet(view: CookoutView): HTMLElement[] {
    const body: HTMLElement[] = [];
    for (const slot of slotOrder(view)) {
      const player = playerOf(view, slot);
      const group = el("section", "wx-srv-ck-bgroup");
      group.dataset["slot"] = String(slot);
      group.append(el("h4", "wx-srv-ck-bgroup-who", `${slotLabel(view, slot)} · ${player.pickCount} of ${PICKS_PER_PLAYER}`));
      const list = el("ul", "wx-srv-ck-blist");
      const mine = view.you?.slot === slot;
      if (player.picks !== null) {
        for (const pick of player.picks) list.append(basketLine(view, pick, mine));
      } else {
        // Starters are public in both modes: a Blind partner's starter shows, their drafted picks do not.
        const starters = startersOf(view, slot);
        for (const pick of starters) list.append(basketLine(view, pick, false));
        for (let i = starters.length; i < player.pickCount; i += 1) {
          const secret = el("li", "wx-srv-ck-bline wx-srv-ck-bline-secret");
          const tile = el("span", "wx-srv-ck-pic wx-srv-ck-pic-thumb wx-srv-ck-bline-pic wx-srv-ck-pic-secret", "🔒");
          tile.setAttribute("aria-hidden", "true");
          secret.append(tile, el("span", "wx-srv-ck-bline-name", "Secret pick"));
          list.append(secret);
        }
      }
      const known = player.picks?.length ?? Math.max(player.pickCount, startersOf(view, slot).length);
      const left = PICKS_PER_PLAYER - known;
      if (left > 0) list.append(el("li", "wx-srv-ck-bline-left", `${left} to go`));
      group.append(list);
      body.push(group);
    }
    const hint = starHint(view);
    if (hint !== null) body.push(hint);
    return sheetFrame("Basket so far", body);
  }

  function twistItem(className: string, title: string, hint: string, enabled: boolean, onTap: () => void): HTMLElement {
    const item = button(`wx-srv-ck-twist-item ${className}`, "", onTap, title);
    item.append(el("span", "wx-srv-ck-twist-item-name", title), el("span", "wx-srv-ck-twist-item-hint", hint));
    item.disabled = !enabled || busy.has("move");
    return item;
  }

  function twistsSheet(view: CookoutView): HTMLElement[] {
    const current = view.current;
    const body: HTMLElement[] = [];
    if (current !== null && view.you !== null) {
      if (view.you.slot === current.player) {
        if (current.canLucky !== null) {
          body.push(twistItem("wx-srv-ck-lucky", "🪙 Lucky dip", "A coin picks one of these two for you.", current.canLucky, () => void move("lucky", null)));
        }
        if (current.canChaos !== null) {
          body.push(
            twistItem(
              "wx-srv-ck-chaos",
              view.you.chaosUsed ? "🌋 Chaos shelf (used)" : "🌋 Chaos shelf",
              "Swap these two for two weird and exotic ones — once a game.",
              current.canChaos,
              () => void move("chaos", null),
            ),
          );
        }
      } else if (current.canVeto !== null) {
        body.push(
          twistItem(
            "wx-srv-ck-sweep",
            view.you.vetoUsed ? "🧹 Sweep one (used)" : "🧹 Sweep one",
            `Sweep one of these off ${bannerName(playerOf(view, current.player).name)}'s table — once a game.`,
            current.canVeto,
            () => {
              sheet = null;
              sweeping = true;
              redraw();
            },
          ),
        );
      }
    }
    return sheetFrame("Twists", body);
  }

  function drawSheet(view: CookoutView | undefined): void {
    // The 🎲 sheet closes itself once nothing in it can be used (the turn moved on, the twist was spent).
    if (sheet === "twists" && (view === undefined || !usableTwists(view))) sheet = null;
    const open = view !== undefined && view.state === "picking" ? sheet : null;
    if (open === null) {
      sheet = null;
      if (drawn.sheet !== "") {
        drawn.sheet = "";
        sheetHost.hidden = true;
        sheetHost.replaceChildren();
      }
      return;
    }
    const key = JSON.stringify([
      open,
      view?.players.map((p) => [p.name, p.pickCount, p.picks?.map((x) => [x.id, x.via, x.what, x.image]) ?? null]),
      view?.starters.map((s) => s.id),
      view?.stars,
      view?.you,
      view?.current === null || view?.current === undefined
        ? null
        : [view.current.turn, view.current.player, view.current.canLucky, view.current.canChaos, view.current.canVeto],
      busy.has("star"),
      busy.has("move"),
    ]);
    if (drawn.sheet === key || view === undefined) return;
    drawn.sheet = key;
    sheetHost.dataset["sheet"] = open;
    sheetHost.replaceChildren(...(open === "basket" ? basketSheet(view) : twistsSheet(view)));
    sheetHost.hidden = false;
  }

  // -- Drawing: the table's two picture cards (09b §D.3) -------------------------------------------------------

  interface CardAction {
    readonly onPick: () => void;
    /** The card's accessible name ("Pick Ribeye steak"). */
    readonly label: string;
    /** Shown over the card while its move is on its way ("Picking…"). */
    readonly busyText: string;
    readonly chosen: boolean;
    readonly disabled: boolean;
  }

  let describedCount = 0;

  /** One picture card: a button when it can be chosen (`action`), else a plain card. The whole card is the
   * target; the picture flexes, the name and the what-line never clip (09b §D.3). */
  function ingredientCard(snap: IngredientSnap, action: CardAction | null, exotic = false, dim = false): HTMLElement {
    const card = el(action !== null ? "button" : "div", "wx-srv-ck-card");
    card.dataset["ingredient"] = snap.id;
    card.classList.toggle("wx-srv-ck-card-exotic", exotic);
    card.classList.toggle("wx-srv-ck-card-dim", dim);
    const inner = el("span", "wx-srv-ck-card-in");
    inner.append(ingredientPicture(doc, snap, { rendition: "card", className: "wx-srv-ck-card-pic", eager: true }));
    inner.append(el("span", "wx-srv-ck-card-name", snap.name));
    // The what-line: the catalogue's, else a blurb short enough to show whole; a longer blurb stays in the
    // card's accessible description only (never clipped).
    const id = `wx-srv-ck-desc-${(describedCount += 1)}`;
    const shown = snap.what ?? (snap.blurb !== "" && snap.blurb.length <= CARD_WHAT_MAX ? snap.blurb : null);
    if (shown !== null) {
      const what = el("span", "wx-srv-ck-card-what", shown);
      what.id = id;
      inner.append(what);
    } else if (snap.blurb !== "") {
      const hidden = el("span", "wx-srv-ck-sr", snap.blurb);
      hidden.id = id;
      inner.append(hidden);
    }
    card.append(inner);
    if (card instanceof HTMLButtonElement && action !== null) {
      card.type = "button";
      card.setAttribute("data-srv-gesture-boundary", "");
      card.setAttribute("aria-label", action.label);
      if (shown !== null || snap.blurb !== "") card.setAttribute("aria-describedby", id);
      card.disabled = action.disabled;
      card.classList.toggle("wx-srv-ck-card-chosen", action.chosen);
      if (action.chosen) card.append(el("span", "wx-srv-ck-card-busy", action.busyText));
      card.addEventListener("click", action.onPick);
    }
    return card;
  }

  function pickAction(snap: IngredientSnap): CardAction {
    return {
      onPick: () => void move("pick", snap.id),
      label: `Pick ${snap.name}`,
      busyText: "Picking…",
      chosen: pickingId === snap.id,
      disabled: busy.has("move"),
    };
  }

  function sweepAction(snap: IngredientSnap): CardAction {
    const going = tableBusy?.kind === "veto" && tableBusy.target === snap.id;
    return {
      onPick: () => void move("veto", snap.id),
      label: `Sweep ${snap.name} off the table`,
      busyText: "Sweeping…",
      chosen: going,
      disabled: busy.has("move"),
    };
  }

  function drawDraft(view: CookoutView): HTMLElement[] {
    const current = view.current;
    if (current === null) return [];
    const mine = view.you !== null && view.you.slot === current.player;
    if (current.options === null) {
      // Blind (or waiting for Join): the partner's pair is not in the view, and so not in the DOM.
      const cloche = el("div", "wx-srv-ck-cloche");
      cloche.append(emojiSpan("wx-srv-ck-cloche-dome", "🛎️"));
      const waitingJoin = current.waitingForJoin || (current.player === 2 && view.players[1].name === null);
      const who = current.player === 2 ? (view.players[1].name ?? partnerFallback() ?? "your partner") : nameOf(view, 1, "Player 1");
      const words = waitingJoin
        ? view.you?.slot === 1
          ? `Waiting for ${partnerFallback() ?? "your partner"} to join…`
          : "Press Join to take the next turn."
        : `🕵️ Secret turn: ${mine ? "you are" : `${who} is`} choosing…`;
      cloche.append(el("p", "wx-srv-ck-cloche-text", words));
      if (!waitingJoin && view.blind) {
        cloche.append(el("p", "wx-srv-ck-cloche-sub", "Blind mode: everything is revealed once all 10 are picked."));
      }
      return [cloche];
    }
    const exotic = current.chaosPair === true;
    const pair = el("div", "wx-srv-ck-pair");
    pair.classList.toggle("wx-srv-ck-pair-watch", !mine && !sweeping);
    pair.classList.toggle("wx-srv-ck-pair-sweep", !mine && sweeping);
    pair.classList.toggle("wx-srv-ck-pair-chaos", exotic);
    pair.dataset["offer"] = String(current.offerIndex ?? 0);
    const [a, b] = current.options;
    const going = mine ? pickingId : tableBusy?.kind === "veto" ? tableBusy.target : null;
    const side = (snap: IngredientSnap): HTMLElement => {
      const dim = (going !== null && going !== snap.id) || (!mine && !sweeping);
      if (mine) return ingredientCard(snap, pickAction(snap), exotic, dim);
      if (sweeping && view.you !== null && current.canVeto === true) return ingredientCard(snap, sweepAction(snap), exotic, dim);
      return ingredientCard(snap, null, exotic, dim);
    };
    const or = el("span", "wx-srv-ck-or", "or");
    or.setAttribute("aria-hidden", "true");
    pair.append(side(a), or, side(b));
    return [pair];
  }

  /** The pair on the table as a key: a new one is decoded before it swaps in (09b §D.6). */
  function pairKey(view: CookoutView): string | null {
    const current = view.current;
    if (current === null || current.options === null) return null;
    return `${current.turn}:${current.offerIndex ?? 0}:${current.options[0].id}:${current.options[1].id}`;
  }

  function drawTable(view: CookoutView): void {
    const current = view.current;
    const key = JSON.stringify([
      "picking",
      current,
      view.you,
      view.players.map((p) => p.name),
      busy.has("move"),
      pickingId,
      tableBusy,
      sweeping,
      deps.partner(),
    ]);
    if (drawn.stage === key) return;
    const pk = pairKey(view);
    if (pk !== null && shownPair !== null && pk !== shownPair) {
      // A new pair: keep the old cards (disabled) until both new pictures decode, at most 400 ms.
      if (decodingPair === pk) return;
      const options = current?.options ?? null;
      const urls = options === null ? [] : options.flatMap((o) => (o.image === null ? [] : [o.image.card]));
      if (urls.length > 0) {
        decodingPair = pk;
        for (const card of pickStage.querySelectorAll<HTMLButtonElement>("button.wx-srv-ck-card")) card.disabled = true;
        const started = generation;
        void decodeAll(doc, urls, DECODE_WAIT_MS, clock).then(() => {
          if (started !== generation || decodingPair !== pk) return;
          decodingPair = null;
          shownPair = pk;
          drawn.stage = "";
          redraw();
        });
        return;
      }
    }
    decodingPair = null;
    shownPair = pk;
    drawn.stage = key;
    pickStage.replaceChildren(...drawDraft(view));
  }

  // -- Stars: the ☆/★ toggle on the viewer's own picks (09a §1.5) ---------------------------------------------

  /** The viewer's ☆/★ toggle on one of their own picks while stars can still change; a plain ★ on a star they
   * may see; else null. `label` is the toggle's words when it shows them. */
  function starControl(view: CookoutView, snap: PickSnap, mine: boolean, label: string | null): HTMLElement | null {
    const stars = view.stars;
    const starred = isStarred(view, snap.id);
    // The wildcard is nobody's pick and cannot be starred; a swapped-in item is not one of the five.
    const starrable = mine && stars.enabled && view.you !== null && snap.via !== "wildcard" && snap.via !== "swap";
    if (starrable) {
      const on = stars.mine === snap.id;
      const toggle = button(
        "wx-srv-ck-star",
        label === null ? (on ? "★" : "☆") : on ? "★ Your star" : `☆ ${label}`,
        () => {
          if (!on) doStar(snap.id);
        },
        on ? `${snap.name} is your secret star` : `Star ${snap.name}`,
      );
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
      toggle.classList.toggle("wx-srv-ck-star-on", on);
      // Revealed is locked (09a §1.5): a secret commitment cannot change once shown.
      toggle.disabled = stars.revealed || busy.has("star") || view.state === "abandoned";
      return toggle;
    }
    if (starred) return el("span", "wx-srv-ck-star-mark", "★");
    return null;
  }

  function starHint(view: CookoutView): HTMLElement | null {
    if (!view.stars.enabled || view.you === null || view.stars.revealed || view.state === "abandoned") return null;
    const own = playerOf(view, view.you.slot).picks ?? [];
    if (own.length === 0) return null;
    return el(
      "p",
      "wx-srv-ck-star-hint",
      view.stars.mine === null
        ? "⭐ Star one of your picks — it stays secret, and the chef will make it a hero."
        : "⭐ Your star is secret until you've both chosen. Star another to change it.",
    );
  }

  /** A small inline thumb (dish "uses", recipe lines) with the name for screen readers and on hover. */
  function smallThumb(item: Picturable, className: string, title: string): HTMLElement {
    const wrap = el("span", `wx-srv-ck-mini ${className}`);
    wrap.title = title;
    wrap.dataset["ingredient"] = item.id;
    const pic = ingredientPicture(doc, item, { rendition: "thumb", className: "wx-srv-ck-mini-pic", alt: "" });
    pic.removeAttribute("role");
    pic.removeAttribute("aria-label");
    pic.setAttribute("aria-hidden", "true");
    wrap.append(pic, el("span", "wx-srv-ck-sr", title));
    return wrap;
  }

  // -- Drawing: the chef stage -----------------------------------------------------------------------------

  /** One revealed basket item: its picture, its name under it (wrapping, never clamped) and its badges in the
   * corners. On the viewer's own picks while stars can change, the whole tile is the ☆/★ toggle. */
  function revealTile(view: CookoutView, snap: PickSnap, mine: boolean): HTMLElement {
    const star = starControl(view, snap, mine, null);
    const tile = star instanceof HTMLButtonElement ? star : el("div", "wx-srv-ck-rtile");
    tile.classList.add("wx-srv-ck-rtile");
    tile.textContent = "";
    tile.dataset["picked"] = snap.id;
    tile.append(ingredientPicture(doc, snap, { rendition: "thumb", className: "wx-srv-ck-rtile-pic" }));
    tile.append(el("span", "wx-srv-ck-rtile-name", snap.name));
    const badge = snap.via === "seed" || snap.via === "wildcard" || snap.via === "swap" ? viaBadge(view, snap) : "";
    if (badge !== "") {
      tile.classList.add(`wx-srv-ck-rtile-${snap.via}`);
      const corner = el("span", "wx-srv-ck-rtile-via", Array.from(badge)[0] ?? "");
      corner.title = badge;
      tile.append(corner);
    }
    const starred = isStarred(view, snap.id);
    tile.classList.toggle("wx-srv-ck-rtile-starred", starred);
    if (star instanceof HTMLButtonElement) {
      tile.append(el("span", "wx-srv-ck-rtile-star", view.stars.mine === snap.id ? "★" : "☆"));
    } else if (starred) {
      tile.append(el("span", "wx-srv-ck-rtile-star", "★"));
    }
    return tile;
  }

  /** The basket once full (09b §D.5): picture tiles grouped by player (the cloche's wildcard and a rescue
   * swap's replacement after them), then the cupboard staples. */
  function revealBanner(view: CookoutView, animate: boolean): HTMLElement {
    const banner = el("div", "wx-srv-ck-reveal");
    const head = el("p", "wx-srv-ck-reveal-title");
    head.append(emojiSpan("wx-srv-ck-reveal-icon", "🧺"), doc.createTextNode(view.blind ? "The big reveal — your 10 ingredients" : "Your 10 ingredients"));
    banner.append(head);
    const picks = allPicks(view);
    const mineIds = new Set((view.you === null ? null : playerOf(view, view.you.slot).picks)?.map((p) => p.id) ?? []);
    const groups: Array<{ readonly label: string; readonly key: string; readonly items: PickSnap[] }> = slotOrder(view).map((slot) => ({
      label: slotLabel(view, slot),
      key: String(slot),
      items: picks.filter((p) => p.turn !== null && (p.turn % 2 === 1 ? 1 : 2) === slot),
    }));
    groups.push({ label: "Extras", key: "extra", items: picks.filter((p) => p.turn === null) });
    let index = 0;
    for (const group of groups) {
      if (group.items.length === 0) continue;
      const box = el("div", "wx-srv-ck-rgroup");
      box.dataset["group"] = group.key;
      box.append(el("p", "wx-srv-ck-rgroup-who", group.label));
      const grid = el("div", "wx-srv-ck-reveal-grid");
      for (const snap of group.items) {
        const tile = revealTile(view, snap, mineIds.has(snap.id));
        if (animate) {
          tile.classList.add("wx-srv-ck-flip");
          tile.style.animationDelay = `${index * REVEAL_STAGGER_MS}ms`;
        }
        index += 1;
        grid.append(tile);
      }
      box.append(grid);
      banner.append(box);
    }
    if (view.stars.enabled && view.stars.revealed && (view.stars.mine !== null || view.stars.partner !== null)) {
      banner.append(el("p", "wx-srv-ck-stars-revealed", "★ The stars are out — the chef makes them the heroes of every dish."));
    }
    if (view.staples.length > 0) banner.append(staplesRow(view.staples));
    return banner;
  }

  /** "Plus cupboard staples:" and their thumbs (09b §D.5). */
  function staplesRow(staples: readonly Staple[]): HTMLElement {
    const row = el("div", "wx-srv-ck-staples");
    row.append(el("span", "wx-srv-ck-staples-label", "Plus cupboard staples:"));
    const list = el("span", "wx-srv-ck-staples-list");
    for (const staple of staples) {
      const item = el("span", "wx-srv-ck-staple");
      item.dataset["ingredient"] = staple.id;
      const pic = ingredientPicture(doc, staple, { rendition: "thumb", className: "wx-srv-ck-mini-pic", alt: "" });
      pic.removeAttribute("role");
      pic.removeAttribute("aria-label");
      pic.setAttribute("aria-hidden", "true");
      item.append(pic, el("span", "wx-srv-ck-staple-name", staple.name));
      list.append(item);
    }
    row.append(list);
    return row;
  }

  function partnerName(view: CookoutView): string {
    const other: 1 | 2 = view.you?.slot === 2 ? 1 : 2;
    return playerOf(view, other).name ?? partnerFallback() ?? "your partner";
  }

  /** The chef gate (09a §1.4): the stars still to choose and the cloche to answer, before cooking. */
  function gateSection(view: CookoutView): HTMLElement[] {
    const out: HTMLElement[] = [];
    const waiting = view.gate.waitingFor;
    if (view.state !== "finished" || waiting.length === 0) return out;
    if (waiting.includes("stars")) {
      const box = el("div", "wx-srv-ck-gate wx-srv-ck-gate-stars");
      box.setAttribute("role", "status");
      box.append(emojiSpan("wx-srv-ck-gate-icon", "⭐"), el("p", "wx-srv-ck-gate-text", starsGateText(view, partnerName(view)).replace(/^⭐ /, "")));
      if (view.you !== null && view.stars.mine === null) {
        box.append(el("p", "wx-srv-ck-gate-sub", "Tap ☆ on one of your picks above."));
      }
      out.push(box);
    }
    if (waiting.includes("wildcard") && view.wildcard.state === "offered") {
      const card = el("div", "wx-srv-ck-gate wx-srv-ck-cloche-gate");
      card.append(emojiSpan("wx-srv-ck-gate-icon wx-srv-ck-cloche-bell", "🛎️"));
      const words = el("div", "wx-srv-ck-gate-words");
      words.append(el("p", "wx-srv-ck-gate-text", "Lift the cloche? One surprise 11th ingredient"));
      words.append(el("p", "wx-srv-ck-gate-sub", "Neither of you chose it — the chef has to use it."));
      card.append(words);
      if (view.you !== null) {
        const row = el("div", "wx-srv-ck-gate-actions");
        const lifting = busy.has("wildcard");
        const lift = button("wx-srv-ck-lift", lifting ? "Lifting…" : "Lift it!", () => void doWildcard(true));
        const decline = button("wx-srv-ck-decline", "No thanks — start cooking", () => void doWildcard(false));
        lift.disabled = lifting;
        decline.disabled = lifting;
        row.append(lift, decline);
        card.append(row);
      }
      out.push(card);
    }
    return out;
  }

  /** The rescue swap (09a §1.6): the button, the basket chooser, the proposal and its answer, the result. */
  function swapSection(view: CookoutView): HTMLElement[] {
    const swap = view.swap;
    const out: HTMLElement[] = [];
    const working = busy.has("swap");
    if (swap.state === "done") {
      if (swap.out !== null && swap.in !== null) {
        const done = el("p", "wx-srv-ck-swapped");
        done.append(emojiSpan("wx-srv-ck-swapped-icon", "🔄"), doc.createTextNode("Swapped "));
        done.append(el("strong", "", swap.out.name), doc.createTextNode(" → "), el("strong", "", swap.in.name));
        out.push(done);
      }
      return out;
    }
    if (swap.state === "proposed") {
      const box = el("div", "wx-srv-ck-swap");
      box.dataset["swap"] = "proposed";
      const proposer = swap.by === null ? "Somebody" : swap.by === view.you?.slot ? "You" : (playerOf(view, swap.by).name ?? "Your partner");
      const outName = swap.out?.name ?? "an ingredient";
      if (view.you !== null && swap.by === view.you.slot) {
        box.append(el("p", "wx-srv-ck-swap-text", `You're sending back ${outName}. Waiting for ${partnerName(view)} to choose a replacement…`));
        const cancel = button("wx-srv-ck-swap-cancel", working ? "Cancelling…" : "Cancel", () => doCancelSwap(), "Cancel the swap");
        cancel.disabled = working;
        box.append(cancel);
      } else if (view.you !== null) {
        const words = el("p", "wx-srv-ck-swap-text");
        words.append(doc.createTextNode(`${proposer} wants to send back `), el("em", "", outName), doc.createTextNode(". Choose a replacement:"));
        box.append(words);
        if (swap.pair !== null) {
          const pair = el("div", "wx-srv-ck-pair wx-srv-ck-swap-pair");
          const [a, b] = swap.pair;
          const option = (snap: IngredientSnap): HTMLElement =>
            ingredientCard(
              snap,
              {
                onPick: () => void doChooseSwap(snap.id),
                label: `Swap in ${snap.name}`,
                busyText: "Swapping…",
                chosen: swapChoice === snap.id,
                disabled: working,
              },
              false,
              swapChoice !== null && swapChoice !== snap.id,
            );
          pair.append(option(a), el("span", "wx-srv-ck-or", "or"), option(b));
          box.append(pair);
        }
        const keep = button("wx-srv-ck-swap-keep", "Keep these dishes", () => doCancelSwap());
        keep.disabled = working;
        box.append(keep);
      } else {
        box.append(el("p", "wx-srv-ck-swap-text", `${proposer} is swapping out ${outName}…`));
      }
      out.push(box);
      return out;
    }
    if (!swap.available || view.you === null) return out;
    if (!swapChoosing) {
      out.push(
        button("wx-srv-ck-rescue", "🔄 Rescue swap (once)", () => {
          swapChoosing = true;
          swapTarget = null;
          redraw();
          deps.afterChange();
        }, "Rescue swap: send one ingredient back and get three new dishes"),
      );
      return out;
    }
    const box = el("div", "wx-srv-ck-swap");
    box.dataset["swap"] = "choosing";
    box.append(el("p", "wx-srv-ck-swap-text", "Which ingredient do you regret? Send one back — your partner picks its replacement and the chef makes three new dishes."));
    const list = el("div", "wx-srv-ck-swap-basket");
    for (const snap of allPicks(view)) {
      const starred = view.stars.mine === snap.id || view.stars.partner === snap.id;
      const item = button("wx-srv-ck-swap-item", "", () => {
        swapTarget = snap.id;
        redraw();
      }, starred ? `${snap.name} is a star and can't be swapped` : `Send back ${snap.name}`);
      item.append(
        ingredientPicture(doc, snap, { rendition: "thumb", className: "wx-srv-ck-swap-pic", alt: "" }),
        el("span", "wx-srv-ck-swap-name", snap.name),
      );
      if (starred) item.append(el("span", "wx-srv-ck-star-mark", "★"));
      item.disabled = starred || working;
      item.dataset["ingredient"] = snap.id;
      item.setAttribute("aria-pressed", swapTarget === snap.id ? "true" : "false");
      item.classList.toggle("wx-srv-ck-swap-item-on", swapTarget === snap.id);
      list.append(item);
    }
    box.append(list);
    const target = allPicks(view).find((s) => s.id === swapTarget);
    const row = el("div", "wx-srv-ck-swap-actions");
    const never = button("wx-srv-ck-swap-cancel", "Never mind", () => {
      swapChoosing = false;
      swapTarget = null;
      redraw();
    });
    const send = button(
      "wx-srv-ck-swap-send",
      working ? "Sending…" : target === undefined ? "Choose one to send back" : `Send back ${target.name}`,
      () => {
        if (target !== undefined) void doProposeSwap(target.id);
      },
    );
    send.disabled = target === undefined || working;
    never.disabled = working;
    row.append(never, send);
    box.append(row);
    out.push(box);
    return out;
  }

  function voteSection(view: CookoutView): HTMLElement[] {
    const words = voteBannerText(view, partnerName(view));
    if (words === "") return [];
    const banner = el("p", "wx-srv-ck-vote-banner", words);
    banner.setAttribute("role", "status");
    banner.classList.toggle("wx-srv-ck-vote-match", view.vote?.match !== null && view.vote?.match !== undefined);
    return [banner];
  }

  function chefStatus(view: CookoutView): HTMLElement | null {
    const state = view.concepts.state;
    if (state === "ready") return null;
    // Behind the gate the chef has not started: the gate says what it waits for.
    if (state === "none" && view.gate.waitingFor.length > 0) return null;
    const box = el("div", "wx-srv-ck-chef");
    if (state === "pending" || state === "none") {
      box.classList.add("wx-srv-ck-chef-working");
      box.append(emojiSpan("wx-srv-ck-chef-hat", "👩‍🍳"));
      const count = allPicks(view).length;
      const fresh = view.generation > 1 ? "3 new dishes" : "3 dishes";
      box.append(el("p", "wx-srv-ck-chef-text", `Chef is inventing ${fresh} from your ${count > 0 ? count : 10} ingredients…`));
      const elapsed = el("span", "wx-srv-ck-elapsed", formatElapsed(chefSince === null ? 0 : (clock.now() - chefSince) / 1000));
      elapsed.setAttribute("aria-hidden", "true");
      box.append(elapsed);
      // While the chef works: the chosen ingredients go round with their fun facts (09b §D.4).
      const slides = allPicks(view);
      if (slides.length > 0) {
        carousel = createCarousel({ document: doc, clock, reducedMotion: () => reduced() }, slides);
        box.append(carousel.element);
        if (visible) carousel.start();
      }
      return box;
    }
    box.classList.add("wx-srv-ck-chef-failed");
    box.append(emojiSpan("wx-srv-ck-chef-hat", "🧑‍🍳"));
    box.append(
      el(
        "p",
        "wx-srv-ck-chef-text",
        state === "unavailable" ? "The chef isn't available right now." : "The chef couldn't finish those dishes.",
      ),
    );
    const viewGeneration = view.generation;
    const retry = button("wx-srv-ck-retry", busy.has("concepts") ? "Trying…" : "Try again", () =>
      void simple("concepts", (seq) => deps.api.retryConcepts(seq, viewGeneration), "Couldn't restart the chef — try again."),
    );
    retry.disabled = busy.has("concepts");
    box.append(retry);
    return box;
  }

  /** A snap with the basket's picture when it came without one (a dish's copy of a basket item). */
  function withPicture(view: CookoutView, snap: IngredientSnap): IngredientSnap {
    if (snap.image !== null) return snap;
    const known = allPicks(view).find((p) => p.id === snap.id);
    return known === undefined || known.image === null ? snap : { ...snap, image: known.image };
  }

  function nameLookup(view: CookoutView, concept: Concept): Map<string, string> {
    const names = new Map<string, string>();
    for (const s of view.staples) names.set(s.id, s.name);
    for (const snap of allPicks(view)) names.set(snap.id, snap.name);
    for (const snap of concept.pickedIngredients) names.set(snap.id, snap.name);
    for (const s of concept.staplesUsed) names.set(s.id, s.name);
    return names;
  }

  /** `archived`: a dish of an earlier set — its missing picture cannot be retried (09a §1.6). */
  function pictureHeader(view: CookoutView, concept: Concept, picture: Picture | null, archived = false): HTMLElement {
    const header = el("div", "wx-srv-ck-dish-pic");
    if (picture !== null) {
      const open = button("wx-srv-ck-dish-photo", "", () => deps.openLightbox(picture.fullUrl, concept.title), `See a bigger picture of ${concept.title}`);
      const img = doc.createElement("img");
      img.className = "wx-srv-ck-dish-img";
      img.src = picture.thumbUrl;
      img.alt = concept.title;
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.addEventListener("error", () => {
        open.remove();
        header.classList.add("wx-srv-ck-dish-pic-empty");
        header.append(emojiSpan("wx-srv-ck-dish-plate", dishEmoji(concept.dishType)));
      });
      open.append(img);
      header.append(open);
      return header;
    }
    header.classList.add("wx-srv-ck-dish-pic-empty");
    header.append(emojiSpan("wx-srv-ck-dish-plate", dishEmoji(concept.dishType)));
    if (archived) return header;
    if (view.images.state === "pending") {
      header.classList.add("wx-srv-ck-dish-pic-pending");
      header.append(el("span", "wx-srv-ck-dish-pic-note", "Plating up…"));
    } else if (view.images.state === "failed") {
      const viewGeneration = view.generation;
      const retry = button("wx-srv-ck-dish-retry", busy.has("pictures") ? "Trying…" : "Retry picture", () =>
        void simple("pictures", (seq) => deps.api.retryPictures(seq, viewGeneration), "Couldn't restart the pictures — try again."),
      );
      retry.disabled = busy.has("pictures");
      header.append(retry);
    }
    return header;
  }

  function recipeView(
    view: CookoutView,
    concept: Concept,
    recipe: FullRecipe,
    names: Map<string, string>,
    slot: RecipeSlot,
    picture: Picture | null,
  ): HTMLElement {
    const box = el("div", "wx-srv-ck-recipe");
    box.dataset["concept"] = concept.id;
    box.dataset["generation"] = String(slot.generation);
    box.append(cooked.section(view, concept, slot, picture));
    const facts = el("div", "wx-srv-ck-recipe-facts");
    for (const [label, value] of [
      ["Serves", String(recipe.serves)],
      ["Prep", formatMinutes(recipe.prepMinutes)],
      ["Cook", formatMinutes(recipe.cookMinutes)],
      ["Total", formatMinutes(recipe.totalMinutes)],
    ] as const) {
      const fact = el("span", "wx-srv-ck-fact");
      fact.append(el("span", "wx-srv-ck-fact-label", label), el("span", "wx-srv-ck-fact-value", value));
      facts.append(fact);
    }
    box.append(facts);
    if (recipe.cookware.length > 0) {
      box.append(el("p", "wx-srv-ck-recipe-cookware", `You'll need: ${recipe.cookware.join(", ")}`));
    }

    box.append(el("h4", "wx-srv-ck-recipe-head", "Ingredients"));
    const list = el("ul", "wx-srv-ck-recipe-ings");
    const basket = new Map(allPicks(view).map((p) => [p.id, p] as const));
    for (const item of recipe.ingredients) {
      const li = el("li", "wx-srv-ck-recipe-ing");
      const label = el("label", "wx-srv-ck-recipe-ing-label");
      label.setAttribute("data-srv-gesture-boundary", "");
      const box2 = doc.createElement("input");
      box2.type = "checkbox";
      box2.className = "wx-srv-ck-recipe-check";
      const tickKey = `${slot.generation}:${concept.id}:${item.id}`;
      box2.checked = checked.has(tickKey);
      box2.addEventListener("change", () => {
        if (box2.checked) checked.add(tickKey);
        else checked.delete(tickKey);
        li.classList.toggle("wx-srv-ck-recipe-ing-done", box2.checked);
      });
      li.classList.toggle("wx-srv-ck-recipe-ing-done", box2.checked);
      // A basket ingredient gets its 24 px picture (09b §D.5); a staple or a pantry extra does not.
      const fromBasket = basket.get(item.id);
      const thumb = fromBasket === undefined ? null : ingredientPicture(doc, fromBasket, { rendition: "thumb", className: "wx-srv-ck-recipe-pic", alt: "" });
      if (thumb !== null) {
        thumb.removeAttribute("role");
        thumb.removeAttribute("aria-label");
        thumb.setAttribute("aria-hidden", "true");
      }
      const words = el("span", "wx-srv-ck-recipe-ing-words");
      words.append(el("span", "wx-srv-ck-recipe-qty", item.quantity));
      words.append(el("span", "wx-srv-ck-recipe-ing-name", item.name ?? names.get(item.id) ?? tidy(item.id)));
      if (item.note !== "") words.append(el("span", "wx-srv-ck-recipe-note", item.note));
      if (thumb !== null) label.append(box2, thumb, words);
      else label.append(box2, words);
      li.append(label);
      list.append(li);
    }
    box.append(list);

    box.append(el("h4", "wx-srv-ck-recipe-head", "Method"));
    const steps = el("ol", "wx-srv-ck-recipe-steps");
    for (const step of recipe.steps) {
      const li = el("li", "wx-srv-ck-recipe-step");
      li.append(el("span", "wx-srv-ck-recipe-step-text", step.text));
      if (step.minutes !== null && step.minutes > 0) li.append(el("span", "wx-srv-ck-recipe-step-time", formatMinutes(step.minutes)));
      steps.append(li);
    }
    box.append(steps);

    if (recipe.tips.length > 0) {
      box.append(el("h4", "wx-srv-ck-recipe-head", "Chef's tips"));
      const tips = el("ul", "wx-srv-ck-recipe-tips");
      for (const tip of recipe.tips) tips.append(el("li", "wx-srv-ck-recipe-tip", tip));
      box.append(tips);
    }
    if (slot.requestedBy !== null) box.append(el("p", "wx-srv-ck-recipe-by", `Banked by ${slot.requestedBy}`));
    return box;
  }

  function bankControls(view: CookoutView, concept: Concept): HTMLElement {
    const slot = view.recipes[concept.id];
    const box = el("div", "wx-srv-ck-bankrow");
    box.dataset["recipe"] = slot.state;
    // Captured now: a tap after a rescue swap names the dish set it was drawn for (09a §1.10).
    const viewGeneration = view.generation;
    // No recipe job may start against dishes about to be archived (09a §1.6).
    const frozen = view.swap.state === "proposed";
    const frozenNote = (): void => {
      box.append(el("span", "wx-srv-ck-bank-frozen", "Finish or cancel the swap first"));
    };
    switch (slot.state) {
      case "none": {
        const bank = button(
          "wx-srv-ck-bank",
          banking.has(concept.id) ? "Saving…" : "Bank this ✓",
          () => void doBank(concept.id, viewGeneration),
          `Bank ${concept.title}`,
        );
        bank.disabled = banking.has(concept.id) || frozen;
        box.append(bank);
        if (frozen) frozenNote();
        break;
      }
      case "pending": {
        const writing = el("span", "wx-srv-ck-writing");
        writing.setAttribute("role", "status");
        writing.append(el("span", "wx-srv-ck-spinner"), doc.createTextNode("Writing recipe…"));
        box.append(writing);
        break;
      }
      case "failed":
      case "unavailable": {
        const retry = button(
          "wx-srv-ck-recipe-retry",
          recipeRetrying.has(concept.id) ? "Trying…" : "Recipe didn't finish — Try again",
          () => void doRetryRecipe(concept.id, viewGeneration),
        );
        retry.disabled = recipeRetrying.has(concept.id) || frozen;
        box.append(retry);
        if (frozen) frozenNote();
        break;
      }
      case "banked": {
        const open = expanded.has(concept.id);
        const toggle = button("wx-srv-ck-banked", open ? "Banked ✓ — Hide recipe" : "Banked ✓ — View full recipe", () => {
          if (expanded.has(concept.id)) expanded.delete(concept.id);
          else expanded.add(concept.id);
          redraw();
          deps.afterChange();
        });
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        box.append(toggle);
        break;
      }
    }
    return box;
  }

  /** One dish card's context: the dishes on the table now, or an earlier (read-only) set. */
  interface DishContext {
    readonly generation: number;
    readonly archived: boolean;
    readonly picture: Picture | null;
    readonly slot: RecipeSlot;
    /** Both votes once revealed (null before, and for a one-sided archived vote). */
    readonly votes: { readonly 1: ConceptId; readonly 2: ConceptId } | null;
    readonly match: ConceptId | null;
    /** The basket the dish was made from (for "Uses n/total"). */
    readonly basketSize: number;
  }

  function currentDish(view: CookoutView, concept: Concept): DishContext {
    return {
      generation: view.generation,
      archived: false,
      picture: view.images.pictures[concept.id],
      slot: view.recipes[concept.id],
      votes: view.vote?.votes ?? null,
      match: view.vote?.match ?? null,
      basketSize: allPicks(view).length,
    };
  }

  function earlierDish(set: GenerationView, concept: Concept): DishContext {
    return {
      generation: set.generation,
      archived: true,
      picture: set.pictures[concept.id],
      slot: set.recipes[concept.id],
      votes: set.vote.votes,
      match: set.vote.match,
      basketSize: set.basket.length,
    };
  }

  function dishId(ctx: DishContext, conceptId: ConceptId): string {
    return `${ctx.generation}:${conceptId}`;
  }

  function isExpanded(ctx: DishContext, conceptId: ConceptId): boolean {
    return ctx.archived ? expandedEarlier.has(dishId(ctx, conceptId)) : expanded.has(conceptId);
  }

  function conceptKey(view: CookoutView, concept: Concept, ctx: DishContext = currentDish(view, concept)): string {
    return JSON.stringify([
      concept,
      ctx,
      // A card with its photo does not care how the OTHER photos are getting on (redrawing it would
      // reload the photo); one without shows the shimmer or Retry, which do.
      ctx.picture ?? (ctx.archived ? null : [view.images.state, busy.has("pictures")]),
      ctx.archived ? null : [banking.has(concept.id), recipeRetrying.has(concept.id), view.swap.state, view.vote, busy.has("vote")],
      isExpanded(ctx, concept.id),
      dishMenu === dishId(ctx, concept.id),
      cooked.stateKey(ctx.slot.generation, concept.id),
      view.you,
      view.players.map((p) => p.name),
      view.stars,
      view.setup.challenge,
    ]);
  }

  function voterName(view: CookoutView, slot: 1 | 2): string {
    return view.you?.slot === slot ? "You" : (playerOf(view, slot).name ?? (slot === 1 ? "Player 1" : "Player 2"));
  }

  /** The vote on one dish: the viewer's own button before the reveal, everybody's badges after. */
  function voteRow(view: CookoutView, concept: Concept, ctx: DishContext): HTMLElement | null {
    const box = el("div", "wx-srv-ck-dish-vote");
    if (ctx.votes !== null) {
      if (ctx.match === concept.id) {
        box.append(el("span", "wx-srv-ck-dinner", "🎯 Tonight's dinner!"));
      } else {
        for (const s of [1, 2] as const) {
          if (ctx.votes[s] === concept.id) box.append(el("span", "wx-srv-ck-voter", `🍽️ ${voterName(view, s)}`));
        }
      }
      return box.childElementCount > 0 ? box : null;
    }
    if (ctx.archived) return null;
    const vote = view.vote;
    if (vote === null || view.you === null) return null;
    const mine = vote.you === concept.id;
    // Captured now: the vote names the dish set this card was drawn for.
    const viewGeneration = view.generation;
    const tap = button(
      "wx-srv-ck-vote",
      mine ? "✓ You'd eat this tonight" : "🍽️ I'd eat this tonight",
      () => {
        if (!mine) doVote(viewGeneration, concept.id);
      },
      mine ? `Your secret vote: ${concept.title}` : `Vote for ${concept.title} as tonight's dinner`,
    );
    tap.setAttribute("aria-pressed", mine ? "true" : "false");
    tap.classList.toggle("wx-srv-ck-vote-mine", mine);
    tap.disabled = busy.has("vote");
    box.append(tap);
    return box;
  }

  /** The dish's ⋯: "Encore with the leftovers" when the dish left something out (09a §9). */
  function dishMore(view: CookoutView, concept: Concept, ctx: DishContext): HTMLElement | null {
    if (concept.omitted.length === 0) return null;
    const id = dishId(ctx, concept.id);
    const wrap = el("div", "wx-srv-ck-dish-more");
    const more = button(
      "wx-srv-ck-dish-more-btn",
      "⋯",
      () => {
        dishMenu = dishMenu === id ? null : id;
        redraw();
        deps.afterChange();
      },
      `More for ${concept.title}`,
    );
    more.setAttribute("aria-expanded", dishMenu === id ? "true" : "false");
    more.setAttribute("aria-haspopup", "menu");
    wrap.append(more);
    if (dishMenu === id) {
      const menu = el("div", "wx-srv-ck-dish-menu");
      menu.setAttribute("role", "menu");
      const encore = button("wx-srv-ck-dish-menu-item", "🔁 Encore with the leftovers", () => startEncore(view, ctx.generation, concept));
      encore.setAttribute("role", "menuitem");
      menu.append(encore);
      wrap.append(menu);
    }
    return wrap;
  }

  /** The kitchen challenge and the dish's time, as a small rule badge. */
  function ruleBadge(view: CookoutView, concept: Concept): HTMLElement | null {
    const challenge = view.setup.challenge;
    const note = concept.challengeNote !== null && concept.challengeNote.trim() !== "" ? concept.challengeNote : null;
    if (challenge === null && note === null && concept.totalMinutes === null) return null;
    const badge = el("p", "wx-srv-ck-rule");
    if (challenge !== null) badge.append(el("span", "wx-srv-ck-rule-name", `${challenge.emoji} ${challenge.label}`.trim()));
    if (concept.totalMinutes !== null) badge.append(el("span", "wx-srv-ck-rule-time", `⏱️ ${formatMinutes(concept.totalMinutes)}`));
    if (note !== null) badge.append(el("span", "wx-srv-ck-rule-note", note));
    return badge;
  }

  /** An earlier dish's recipe state: banked ones open their recipe; the rest are view-only. */
  function earlierControls(concept: Concept, ctx: DishContext): HTMLElement {
    const box = el("div", "wx-srv-ck-bankrow");
    box.dataset["recipe"] = ctx.slot.state;
    if (ctx.slot.state !== "banked") {
      box.append(el("span", "wx-srv-ck-earlier-state", "Not banked"));
      return box;
    }
    const id = dishId(ctx, concept.id);
    const open = expandedEarlier.has(id);
    const toggle = button("wx-srv-ck-banked", open ? "Banked ✓ — Hide recipe" : "Banked ✓ — View full recipe", () => {
      if (expandedEarlier.has(id)) expandedEarlier.delete(id);
      else expandedEarlier.add(id);
      redraw();
      deps.afterChange();
    });
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    box.append(toggle);
    return box;
  }

  function conceptCard(view: CookoutView, concept: Concept, ctx: DishContext = currentDish(view, concept)): HTMLElement {
    const card = el("article", "wx-srv-ck-dish");
    card.dataset["concept"] = concept.id;
    card.dataset["generation"] = String(ctx.generation);
    card.classList.toggle("wx-srv-ck-dish-earlier", ctx.archived);
    card.classList.toggle("wx-srv-ck-dish-dinner", ctx.match === concept.id);
    card.append(pictureHeader(view, concept, ctx.picture, ctx.archived));
    const body = el("div", "wx-srv-ck-dish-body");
    const titleRow = el("div", "wx-srv-ck-dish-titlerow");
    titleRow.append(el("h3", "wx-srv-ck-dish-title", concept.title));
    const more = view.state === "finished" ? dishMore(view, concept, ctx) : null;
    if (more !== null) titleRow.append(more);
    body.append(titleRow);
    const tags = el("div", "wx-srv-ck-dish-tags");
    if (concept.vibe !== "") tags.append(el("span", "wx-srv-ck-tag wx-srv-ck-tag-vibe", concept.vibe));
    if (concept.dishType !== "") tags.append(el("span", "wx-srv-ck-tag", tidy(concept.dishType)));
    if (concept.technique !== "") tags.append(el("span", "wx-srv-ck-tag", tidy(concept.technique)));
    if (tags.childElementCount > 0) body.append(tags);
    const rule = ruleBadge(view, concept);
    if (rule !== null) body.append(rule);
    body.append(el("p", "wx-srv-ck-dish-desc", concept.description));
    const total = Math.max(ctx.basketSize, concept.pickedIngredients.length + concept.omitted.length);
    const uses = el("div", "wx-srv-ck-dish-uses");
    uses.append(el("span", "wx-srv-ck-uses-count", `Uses ${concept.pickedIngredients.length}/${total}`));
    // 28 px thumbs (09b §D.5): the name in the tooltip and for screen readers; left-out ones faded.
    const chips = el("div", "wx-srv-ck-uses-chips");
    for (const snap of concept.pickedIngredients) {
      const thumb = smallThumb(withPicture(view, snap), "wx-srv-ck-use", snap.name);
      if (isStarred(view, snap.id)) {
        thumb.classList.add("wx-srv-ck-use-starred");
        thumb.append(el("span", "wx-srv-ck-use-star", "★"));
      }
      chips.append(thumb);
    }
    for (const item of concept.omitted) {
      chips.append(smallThumb(withPicture(view, item.ingredient), "wx-srv-ck-use wx-srv-ck-use-omitted", `Left out: ${item.ingredient.name}`));
    }
    uses.append(chips);
    if (concept.staplesUsed.length > 0) {
      uses.append(el("span", "wx-srv-ck-uses-staples", `Staples: ${concept.staplesUsed.map((s) => s.name.toLowerCase()).join(", ")}`));
    }
    body.append(uses);
    if (concept.omitted.length > 0) {
      const note = el("div", "wx-srv-ck-omitted");
      for (const item of concept.omitted) {
        const line = el("p", "wx-srv-ck-omitted-line");
        line.append(el("span", "wx-srv-ck-omitted-name", `Left out ${item.ingredient.name}: `), doc.createTextNode(item.reason));
        note.append(line);
      }
      body.append(note);
    }
    const vote = voteRow(view, concept, ctx);
    if (vote !== null) body.append(vote);
    body.append(ctx.archived ? earlierControls(concept, ctx) : bankControls(view, concept));
    const slot = ctx.slot;
    if (slot.state === "banked" && isExpanded(ctx, concept.id)) {
      body.append(
        slot.data !== null
          ? recipeView(view, concept, slot.data, nameLookup(view, concept), slot, ctx.picture)
          : el("p", "wx-srv-ck-recipe-missing", "This recipe is saved but can't be shown right now."),
      );
    }
    card.append(body);
    return card;
  }

  /** The dish sets a rescue swap replaced: collapsed under "Earlier dishes", read-only. */
  function earlierSection(view: CookoutView): HTMLElement[] {
    if (view.generations.length === 0) return [];
    const box = el("section", "wx-srv-ck-earlier");
    const toggle = button("wx-srv-ck-earlier-toggle", "", () => {
      earlierOpen = !earlierOpen;
      redraw();
      deps.afterChange();
    });
    toggle.setAttribute("aria-expanded", earlierOpen ? "true" : "false");
    toggle.append(emojiSpan("wx-srv-ck-earlier-icon", "🕰️"), el("span", "wx-srv-ck-earlier-title", "Earlier dishes"));
    toggle.append(el("span", "wx-srv-ck-earlier-sub", "before the swap"), el("span", "wx-srv-ck-tray-caret", earlierOpen ? "▾" : "▸"));
    box.append(toggle);
    if (!earlierOpen) return [box];
    for (const set of view.generations) {
      const grid = el("div", "wx-srv-ck-dishes wx-srv-ck-earlier-dishes");
      grid.dataset["generation"] = String(set.generation);
      for (const concept of set.concepts) grid.append(conceptCard(view, concept, earlierDish(set, concept)));
      box.append(grid);
    }
    return [box];
  }

  function drawChef(view: CookoutView): void {
    const concepts = view.concepts.state === "ready" ? (view.concepts.data ?? []) : [];
    const grid = sections.get("dishes")?.element;
    if (grid === undefined) return;
    const wanted = new Set<ConceptId>();
    const ordered: HTMLElement[] = [];
    for (const concept of concepts) {
      wanted.add(concept.id);
      const key = conceptKey(view, concept);
      let entry = conceptCards.get(concept.id);
      if (entry === undefined || entry.key !== key) {
        const element = conceptCard(view, concept);
        entry?.element.replaceWith(element);
        entry = { element, key };
        conceptCards.set(concept.id, entry);
      }
      ordered.push(entry.element);
    }
    for (const [id, entry] of conceptCards) {
      if (!wanted.has(id)) {
        entry.element.remove();
        conceptCards.delete(id);
      }
    }
    // Keep the cards in a/b/c order without touching ones already in place.
    ordered.forEach((element, index) => {
      if (grid.children[index] !== element) grid.insertBefore(element, grid.children[index] ?? null);
    });
  }

  // -- Drawing: the stage as a whole ----------------------------------------------------------------------

  /** The finished stage's sections, top to bottom. The swap shows above the dishes once proposed or done
   * (both players need it first), and below them as the "Rescue swap" button before that. */
  const FINISHED_SECTIONS = ["basket", "gate", "chef", "swapTop", "vote", "dishes", "swapBottom", "earlier"] as const;
  type FinishedSection = (typeof FINISHED_SECTIONS)[number];

  /** Redraws one section of the finished stage when its key changed. */
  function section(name: FinishedSection, key: string, build: () => HTMLElement[]): void {
    const entry = sections.get(name);
    if (entry === undefined || entry.key === key) return;
    entry.key = key;
    entry.element.replaceChildren(...build());
  }

  function stopCarousel(): void {
    carousel?.destroy();
    carousel = null;
  }

  /** While picking, the table shows and the stage below it does not; otherwise the other way round. */
  function showTable(picking: boolean): void {
    table.hidden = !picking;
    stage.hidden = picking;
    scroll.classList.toggle("wx-srv-ck-scroll-table", picking);
    if (!picking) {
      // Nothing of the table outlives picking, not even hidden (an ended round keeps no pair in the DOM).
      pickStage.replaceChildren();
      tableActions.replaceChildren();
      sweeping = false;
      shownPair = null;
      decodingPair = null;
      drawn.banner = "";
      drawn.actions = "";
      drawn.progress = "";
      drawn.strip = "";
    }
  }

  function drawStage(view: CookoutView): void {
    showTable(view.state === "picking");
    if (view.state === "abandoned") {
      const key = JSON.stringify(["abandoned"]);
      if (drawn.stage === key) return;
      drawn.stage = key;
      stopCarousel();
      conceptCards.clear();
      sections.clear();
      const box = el("div", "wx-srv-ck-ended");
      box.append(emojiSpan("wx-srv-ck-ended-icon", "🧹"));
      box.append(el("p", "wx-srv-ck-ended-text", "This Cookout was ended before the basket was full."));
      box.append(button("wx-srv-ck-again", "Start a new Cookout", () => startNew()));
      stage.replaceChildren(box);
      return;
    }
    if (view.state === "picking") {
      stopCarousel();
      conceptCards.clear();
      sections.clear();
      if (stage.childElementCount > 0) stage.replaceChildren();
      if (!drawn.stage.startsWith('["picking"')) pickStage.replaceChildren();
      // Sweep mode lasts only while this viewer can still sweep the pair on the table.
      const current = view.current;
      if (sweeping && (current === null || current.options === null || current.canVeto !== true || view.you === null || view.you.slot === current.player)) {
        sweeping = false;
      }
      drawStrip(view);
      drawBanner(view);
      drawProgress(view);
      drawTable(view);
      drawActions(view);
      return;
    }
    pickStage.replaceChildren();
    tableActions.replaceChildren();
    // Finished: the basket, the chef gate, the chef's status, the dinner vote, the three dishes, the rescue
    // swap and any earlier dishes — each redrawn only when what it shows changed.
    const frameKey = JSON.stringify(["finished", view.seq]);
    if (drawn.stage !== frameKey) {
      drawn.stage = frameKey;
      stopCarousel();
      conceptCards.clear();
      sections.clear();
      const hosts: HTMLElement[] = [];
      for (const name of FINISHED_SECTIONS) {
        const host = el("div", name === "dishes" ? "wx-srv-ck-dishes" : `wx-srv-ck-sec wx-srv-ck-sec-${name}`);
        sections.set(name, { element: host, key: "" });
        hosts.push(host);
      }
      stage.replaceChildren(...hosts);
    }
    const you = view.you;
    const names = view.players.map((p) => p.name);
    // A swap proposed (by either player) or done ends this screen's own basket chooser.
    if (view.swap.state !== "none" || !view.swap.available) {
      swapChoosing = false;
      swapTarget = null;
    }
    // A Blind round this screen watched being picked flips its basket open once. (The flag is not part of
    // the key: the very next refresh must not redraw the basket and cut the flip short.)
    section(
      "basket",
      JSON.stringify([allPicks(view).map((p) => [p.id, p.via]), view.stars, busy.has("star"), you, view.setup.fridgeRaid, view.staples]),
      () => {
        const animate = view.blind && sawPicking && !revealPlayed;
        if (animate) revealPlayed = true;
        return [revealBanner(view, animate)];
      },
    );
    section(
      "gate",
      JSON.stringify([view.gate.waitingFor, view.wildcard.state, view.stars.mine, view.stars.partnerChosen, busy.has("wildcard"), you, names, deps.partner()]),
      () => gateSection(view),
    );
    section(
      "chef",
      JSON.stringify([
        view.concepts.state,
        busy.has("concepts"),
        view.gate.waitingFor.length,
        view.generation,
        allPicks(view).map((p) => [p.id, p.what, p.image, p.facts]),
      ]),
      () => {
        stopCarousel();
        const status = chefStatus(view);
        return status === null ? [] : [status];
      },
    );
    const swapKey = JSON.stringify([view.swap, swapChoosing, swapTarget, swapChoice, busy.has("swap"), view.stars, allPicks(view).map((p) => p.id), you, names]);
    const swapUp = view.swap.state !== "none";
    section("swapTop", JSON.stringify([swapUp, swapUp ? swapKey : null]), () => (swapUp ? swapSection(view) : []));
    section(
      "swapBottom",
      JSON.stringify([!swapUp, !swapUp && view.concepts.state === "ready" ? swapKey : null]),
      () => (!swapUp && view.concepts.state === "ready" ? swapSection(view) : []),
    );
    section("vote", JSON.stringify([view.vote, view.concepts.data?.map((c) => c.title) ?? null, you, names]), () => voteSection(view));
    drawChef(view);
    section(
      "earlier",
      JSON.stringify([
        view.generations,
        earlierOpen,
        [...expandedEarlier],
        dishMenu,
        you,
        names,
        view.stars,
        view.generations.map((g) => CONCEPT_IDS.map((id) => cooked.stateKey(g.generation, id))),
      ]),
      () => earlierSection(view),
    );
  }

  // -- The elapsed clock -----------------------------------------------------------------------------------

  function syncElapsed(view: CookoutView | undefined): void {
    // Behind the chef gate nothing is cooking yet: the clock starts when the chef does.
    const working =
      view !== undefined &&
      view.state === "finished" &&
      (view.concepts.state === "pending" || (view.concepts.state === "none" && view.gate.waitingFor.length === 0));
    if (working && chefSince === null) chefSince = clock.now();
    if (!working) chefSince = null;
    const run = working && visible;
    if (run && elapsedTimer === null) {
      elapsedTimer = clock.setInterval(() => {
        const node = stage.querySelector<HTMLElement>(".wx-srv-ck-elapsed");
        if (node !== null && chefSince !== null) node.textContent = formatElapsed((clock.now() - chefSince) / 1000);
      }, 1_000);
    } else if (!run && elapsedTimer !== null) {
      clock.clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function stopTimers(): void {
    if (elapsedTimer !== null) clock.clearInterval(elapsedTimer);
    elapsedTimer = null;
    hideToast();
  }

  // -- The header ------------------------------------------------------------------------------------------

  function drawBar(view: CookoutView | undefined): void {
    if (view === undefined) {
      modeBadge.hidden = true;
      helpButton.hidden = true;
      endButton.hidden = true;
      newButton.hidden = true;
      return;
    }
    helpButton.hidden = view.state !== "picking";
    modeBadge.hidden = false;
    modeBadge.textContent = view.blind ? "Blind" : "Open";
    modeBadge.dataset["mode"] = view.blind ? "blind" : "open";
    const picking = view.state === "picking";
    endButton.hidden = !(picking && view.you !== null);
    endButton.disabled = busy.has("abandon");
    newButton.hidden = picking;
    if (!picking && ending) cancelEnd();
  }

  // -- Pane lifecycle --------------------------------------------------------------------------------------

  function forgetRound(): void {
    generation += 1;
    busy.clear();
    banking.clear();
    recipeRetrying.clear();
    pickingId = null;
    expanded.clear();
    checked.clear();
    sheet = null;
    sweeping = false;
    shownPair = null;
    decodingPair = null;
    stopCarousel();
    intro.close();
    ending = false;
    confirmEnd.hidden = true;
    sawPicking = false;
    revealPlayed = false;
    chefSince = null;
    if (moveRetryTimer !== null) clock.clearTimeout(moveRetryTimer);
    moveRetryTimer = null;
    stopTimers();
    stopFx();
    tableBusy = null;
    swapChoosing = false;
    swapTarget = null;
    swapChoice = null;
    earlierOpen = false;
    expandedEarlier.clear();
    dishMenu = null;
    cooked.reset();
    for (const name of Object.keys(drawn) as Array<keyof typeof drawn>) drawn[name] = "";
    conceptCards.clear();
    sections.clear();
    rules.replaceChildren();
    rules.hidden = true;
    strip.replaceChildren();
    strip.hidden = true;
    turnLine.replaceChildren();
    progress.replaceChildren();
    pickStage.replaceChildren();
    tableActions.replaceChildren();
    sheetHost.replaceChildren();
    sheetHost.hidden = true;
    table.hidden = true;
    stage.hidden = false;
    stage.replaceChildren();
  }

  /** The round's start-sheet twists as chips once the basket is full (while picking they are the table's
   * icon strip). A spun style lands its wheel once — wherever it is first seen. */
  function drawRules(view: CookoutView): void {
    if (view.state === "picking") {
      rules.hidden = true;
      drawn.rules = "";
      return;
    }
    const setup = view.setup;
    const spin = setup.styleSpun && setup.style !== null && !wheelPlayed.has(view.seq);
    // `spin` is not part of the key: the very next refresh must not redraw the chip and cut the wheel short.
    const key = JSON.stringify(setup);
    if (drawn.rules === key) return;
    drawn.rules = key;
    const chips: HTMLElement[] = [];
    if (setup.style !== null) {
      const chip = el("span", "wx-srv-ck-rule-chip wx-srv-ck-rule-style");
      // The wheel spins through the faces and lands on the server's answer (it chose at creation).
      chip.append(styleIcon(setup.style.emoji, spin, "wx-srv-ck-rule-icon"));
      chip.append(el("span", "wx-srv-ck-rule-text", setup.styleSpun ? `${setup.style.label} (spun)` : setup.style.label));
      chips.push(chip);
    }
    if (spin) wheelPlayed.add(view.seq);
    if (setup.challenge !== null) {
      const chip = el("span", "wx-srv-ck-rule-chip wx-srv-ck-rule-challenge");
      chip.append(emojiSpan("wx-srv-ck-rule-icon", setup.challenge.emoji), el("span", "wx-srv-ck-rule-text", setup.challenge.label));
      chips.push(chip);
    }
    if (setup.wildcard) {
      const chip = el("span", "wx-srv-ck-rule-chip");
      chip.append(emojiSpan("wx-srv-ck-rule-icon", "🛎️"), el("span", "wx-srv-ck-rule-text", "Cloche"));
      chips.push(chip);
    }
    if (setup.stars) {
      const chip = el("span", "wx-srv-ck-rule-chip");
      chip.append(emojiSpan("wx-srv-ck-rule-icon", "⭐"), el("span", "wx-srv-ck-rule-text", "Secret stars"));
      chips.push(chip);
    }
    if (setup.fridgeRaid) {
      const chip = el("span", "wx-srv-ck-rule-chip");
      chip.append(emojiSpan("wx-srv-ck-rule-icon", "🧊"), el("span", "wx-srv-ck-rule-text", "Fridge raid"));
      chips.push(chip);
    }
    if (setup.encore !== null) {
      const chip = el("span", "wx-srv-ck-rule-chip");
      const what = setup.encore.kind === "remix" ? "Remix" : "Leftovers encore";
      chip.append(
        emojiSpan("wx-srv-ck-rule-icon", "🔁"),
        el("span", "wx-srv-ck-rule-text", setup.encore.fromTitle !== null ? `${what} of ${setup.encore.fromTitle}` : what),
      );
      chips.push(chip);
    }
    rules.replaceChildren(...chips);
    rules.hidden = chips.length === 0;
  }

  function applyFocus(view: CookoutView): void {
    if (focusConcept === null || focusConcept.seq !== view.seq || view.state !== "finished" || view.concepts.state !== "ready") {
      return;
    }
    const id = focusConcept.id;
    const wanted = focusConcept.generation;
    focusConcept = null;
    if (wanted !== null && wanted !== view.generation) {
      // A dish from before a rescue swap: open "Earlier dishes" at its recipe.
      const set = view.generations.find((g) => g.generation === wanted);
      if (set === undefined) return;
      earlierOpen = true;
      if (set.recipes[id].state === "banked") expandedEarlier.add(`${wanted}:${id}`);
      drawStage(view);
      const card = stage.querySelector<HTMLElement>(`.wx-srv-ck-dish-earlier[data-generation="${wanted}"][data-concept="${id}"]`);
      if (card !== null && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "start" });
      return;
    }
    const slot = view.recipes[id];
    if (slot.state === "banked" && !expanded.has(id)) {
      expanded.add(id);
      drawChef(view);
    }
    const card = conceptCards.get(id)?.element;
    if (card !== undefined && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "start" });
  }

  function refreshPane(seq: number): void {
    visible = true;
    if (drawnSeq !== seq) {
      forgetRound();
      drawnSeq = seq;
      scroll.scrollTop = 0;
    }
    const view = deps.model.view(seq);
    drawBar(view);
    if (view === undefined) {
      showTable(false);
      drawSheet(undefined);
      if (drawn.stage !== "loading") {
        drawn.stage = "loading";
        stage.replaceChildren(el("p", "wx-srv-ck-loading", "Getting the kitchen ready…"));
      }
      return;
    }
    if (view.state === "picking") sawPicking = true;
    syncElapsed(view);
    drawRules(view);
    drawStage(view);
    drawSheet(view);
    applyFocus(view);
    if (carousel !== null) carousel.start();
    // The first time this device opens this round while it is being picked: the intro (09b §D.2).
    if (view.state === "picking" && !intro.isOpen() && intro.isNew(view.seq)) intro.open(view);
    if (view.state !== "picking") intro.close();
    deps.afterChange();
  }

  function openIntro(): void {
    const view = drawnSeq === null ? undefined : deps.model.view(drawnSeq);
    if (view !== undefined) intro.open(view);
  }

  function forget(): void {
    visible = false;
    forgetRound();
    focusConcept = null;
    drawnSeq = null;
  }

  function close(): void {
    deps.tabs.close("cookout");
  }

  deps.tabs.register({
    key: "cookout",
    tabLabel: "Cookout",
    tabAriaLabel: "Cookout game",
    pane,
    exists: (seq) => deps.roundMessage(seq) !== undefined,
    refresh: refreshPane,
    onShow: () => {
      visible = true;
    },
    onHide: () => {
      // Another tab came to the front: no timer keeps running for a pane nobody can see.
      visible = false;
      stopTimers();
      stopFx();
      carousel?.stop();
      if (ending) cancelEnd();
    },
    reset: forget,
  });

  return {
    pane,
    open: (seq) => deps.tabs.open("cookout", seq),
    openRecipe(seq, conceptId, dishGeneration) {
      focusConcept = CONCEPT_IDS.includes(conceptId) ? { seq, id: conceptId, generation: dishGeneration ?? null } : null;
      deps.tabs.open("cookout", seq);
      // Already on screen with the same round: the open redraws only when something changed.
      const view = deps.model.view(seq);
      if (view !== undefined && drawnSeq === seq) applyFocus(view);
    },
    offer: (seq) => deps.tabs.offer("cookout", seq),
    close,
    gameSeq: () => deps.tabs.seqOf("cookout"),
    forgetAll() {
      wheelPlayed.clear();
      intendedMoves.clear();
    },
  };
}
