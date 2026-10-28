// The Cookout GAME PANE (workspace 00058; spec/server-chat/09-cookout.md §5.3): when a round is opened
// its tab shows the kitchen full-height, phone-first (360 px is THE layout; wider screens put the two
// ingredient cards and the three dishes side by side):
//
//   [ 🍳 Cookout  (Blind)                 Recipe book  End game / New  ✕ ]
//   [ the basket progress: 5 pills each, and whose turn it is ("Your turn — Pick 2 of 5 (Go 1 of 3)") ]
//   [ the stage: two tactile ingredient cards + the skip button — or the Blind cloche — or the chef ]
//   [ the basket tray: what is in the basket so far, and the cupboard staples ]
//   [ mini chat: this round's last two messages ]      <- the shared itemChat strip
//   [ the chat composer — the ordinary one, now sending into this round ]
//
// When all ten are picked the progress and the tray give way to the chef stage: the revealed basket
// (in a Blind round the ten flip open together), "Chef is inventing…", then three dish cards whose
// picture placeholders fill in as the photos arrive, each with "Bank this ✓" → "Writing recipe…" →
// "Banked ✓ — View full recipe".
//
// BLIND MODE never reaches this file as data: the server leaves the partner's options, offers and picks
// out of the view (spec §1.3), so the cloche and the "🔒 Secret pick" cards are drawn from counts alone and
// no ingredient string of the partner's can be in the DOM.
//
// Like the other games it registers with the shared frame (`gameTabs.ts`) as "cookout" and embeds a strip
// of the shared per-item chat (`itemChat.ts`). It holds NO idle-lock suspension — not even through the
// minutes the chef and the pictures take (Inv 43/55: the lock is a privacy feature) — and Escape stays the
// chat's panic key: nothing here listens for it. Its only long-lived resources are a one-second timer for
// the chef's elapsed clock (only while that is on screen) and a toast timer, both released in `onHide` and
// `reset`. Everything user-visible is set via `textContent`.
//
// The pane redraws a section only when what that section shows changed (its key), so a scrolled list,
// an expanded recipe, ticked-off ingredients and loaded photos survive the frequent refreshes of a round
// whose pictures and recipes are still arriving.

import { ServerLockedError } from "../api/http";
import type { Message } from "../api/messages";
import type { GameTabs } from "../gameTabs";
import type { ItemChat } from "../itemChat";
import type { LockHooks } from "../types";
import {
  allPicks,
  CONCEPT_IDS,
  formatMinutes,
  PICKS_PER_PLAYER,
  type Concept,
  type ConceptId,
  type CookoutOutcome,
  type CookoutPlayer,
  type CookoutRole,
  type CookoutView,
  type FullRecipe,
  type IngredientSnap,
  type Picture,
  type RecipeSlot,
} from "./api";
import type { CookoutModel } from "./model";

export interface CookoutGameApi {
  join(seq: number): Promise<CookoutOutcome>;
  skip(seq: number, input: { readonly moveId: string; readonly turn: number; readonly offer: number }): Promise<CookoutOutcome>;
  pick(
    seq: number,
    input: { readonly moveId: string; readonly turn: number; readonly offer: number; readonly ingredientId: string },
  ): Promise<CookoutOutcome>;
  abandon(seq: number): Promise<CookoutOutcome>;
  retryConcepts(seq: number): Promise<CookoutOutcome>;
  retryPictures(seq: number): Promise<CookoutOutcome>;
  bank(seq: number, conceptId: ConceptId, moveId: string): Promise<CookoutOutcome>;
  retryRecipe(seq: number, conceptId: ConceptId): Promise<CookoutOutcome>;
}

export interface CookoutGameDeps {
  readonly document: Document;
  readonly model: CookoutModel;
  /** The shared tab bar: this pane registers itself as the game "cookout". */
  readonly tabs: GameTabs;
  /** The shared item chat: this pane embeds one mini chat strip. */
  readonly itemChat: ItemChat;
  readonly hooks: Pick<LockHooks, "lockNow">;
  readonly api: CookoutGameApi;
  /** The round's anchor message, or undefined once it is gone (deleted, wiped). */
  roundMessage(seq: number): Message | undefined;
  /** The other person's display name when it is known (for "Waiting for …" before they join). */
  partner(): string | null;
  /** Opens the start sheet with `blind` preselected (the header's New). */
  openStartSheet(blind: boolean): void;
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
}

export interface CookoutGame {
  /** The game tab's content — sits in the thread view where the message thread is. */
  readonly pane: HTMLElement;
  open(seq: number): void;
  /** Opens the round straight at one dish's full recipe (the Recipe book's tap). */
  openRecipe(seq: number, conceptId: ConceptId): void;
  offer(seq: number): void;
  close(): void;
  /** The open round, or null. */
  gameSeq(): number | null;
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

const ROLE_WORDS: Readonly<Record<CookoutRole, { readonly icon: string; readonly name: string }>> = {
  base: { icon: "🍞", name: "a base" },
  protein: { icon: "🍗", name: "a protein" },
  produce: { icon: "🥕", name: "fresh produce" },
  accent: { icon: "🌿", name: "a flavour accent" },
};

/** "🍗 This turn: a protein", or "" when the role is not known to this viewer. */
export function roleLine(role: CookoutRole | null): string {
  if (role === null) return "";
  const words = ROLE_WORDS[role];
  return `${words.icon} This turn: ${words.name}`;
}

/** The skip button's words for the offer on screen (spec §5.3). */
export function skipLabel(offerIndex: number): string {
  if (offerIndex <= 0) return "Neither — deal 2 new options (2 skips left)";
  if (offerIndex === 1) return "Neither — deal final 2 options (1 skip left)";
  return "Final pair — pick one of the two above";
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

/** The banner's prompt for a round being picked (spec §5.3). */
export function turnPrompt(view: CookoutView, partnerFallback: string | null): string {
  const current = view.current;
  if (view.state !== "picking" || current === null) return "";
  const pick = `Pick ${pickNumber(current.turn)} of ${PICKS_PER_PLAYER}`;
  const mine = view.you !== null && view.you.slot === current.player;
  if (current.waitingForJoin || (current.player === 2 && view.players[1].name === null)) {
    if (view.you?.slot === 1) return `Waiting for ${partnerFallback ?? "your partner"} to join — ${pick}`;
    return `Join to take your turn — ${pick}`;
  }
  if (mine) {
    const go = current.offerIndex === null ? "" : ` (Go ${current.offerIndex + 1} of 3)`;
    return `Your turn — ${pick}${go}`;
  }
  const who = nameOf(view, current.player, current.player === 2 ? (partnerFallback ?? "your partner") : "Player 1");
  return `Waiting for ${who} — ${pick}`;
}

/** Elapsed seconds as "0:42" / "3:07". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const MOVE_ATTEMPTS = 2;
const MOVE_RETRY_MS = 800;
const TOAST_MS = 4_000;
const REVEAL_STAGGER_MS = 90;

type Busy = "move" | "join" | "abandon" | "concepts" | "pictures";

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
  const bookButton = button("wx-srv-ck-chip wx-srv-ck-book", "", () => deps.openBook(), "Recipe book");
  bookButton.append(emojiSpan("wx-srv-ck-chip-icon", "📖"), el("span", "wx-srv-ck-chip-text", "Recipe book"));
  const endButton = button("wx-srv-ck-chip wx-srv-ck-end", "End game", () => askEnd(), "End this Cookout");
  const newButton = button("wx-srv-ck-chip wx-srv-ck-new", "New", () => startNew(), "Start a new Cookout");
  const closeButton = button("wx-srv-ck-chip wx-srv-ck-close", "✕", () => close(), "Close the game");
  actions.append(bookButton, endButton, newButton, closeButton);
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
  const progress = el("section", "wx-srv-ck-progress");
  progress.setAttribute("aria-label", "Basket progress");
  const stage = el("section", "wx-srv-ck-stage");
  const tray = el("section", "wx-srv-ck-tray");
  scroll.append(progress, stage, tray);

  const toast = el("div", "wx-srv-ck-toast");
  toast.setAttribute("role", "status");
  toast.hidden = true;

  const strip = deps.itemChat.createStrip({ popupTitle: "Cookout chat" });
  pane.append(bar, confirmEnd, scroll, toast, strip.element);

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
  let trayOpen = true;
  let ending = false;
  /** A dish to open at once (the Recipe book's tap), consumed when its recipe is on screen. */
  let focusConcept: { readonly seq: number; readonly id: ConceptId } | null = null;
  /** The round was seen being picked here: its Blind reveal plays when it finishes. */
  let sawPicking = false;
  let revealPlayed = false;
  /** When this screen first saw the chef working (local ms): the elapsed clock counts from it. */
  let chefSince: number | null = null;
  let elapsedTimer: number | null = null;
  let toastTimer: number | null = null;
  let moveRetryTimer: number | null = null;
  /** The keys the sections were last drawn for. */
  const drawn = { progress: "", stage: "", tray: "" };
  /** Each dish card's element and the key it was drawn for. */
  const conceptCards = new Map<ConceptId, { readonly element: HTMLElement; key: string }>();

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

  /** A skip or a pick: one move id for every attempt, so a resend after a lost answer is not a second move. */
  async function move(kind: "skip" | "pick", ingredientId: string | null): Promise<void> {
    const seq = drawnSeq;
    const view = seq === null ? undefined : deps.model.view(seq);
    const current = view?.current ?? null;
    if (seq === null || current === null || current.offerIndex === null || busy.has("move")) return;
    const started = generation;
    const moveId = newId();
    const base = { moveId, turn: current.turn, offer: current.offerIndex };
    busy.add("move");
    pickingId = ingredientId;
    redraw();
    let outcome: CookoutOutcome = { ok: false, kind: "unavailable" };
    for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
      outcome = await guarded(() =>
        kind === "pick" && ingredientId !== null ? deps.api.pick(seq, { ...base, ingredientId }) : deps.api.skip(seq, base),
      );
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
    pickingId = null;
    if (outcome.ok) {
      if (kind === "pick") {
        const chosen = current.options?.find((o) => o.id === ingredientId);
        if (chosen !== undefined) showToast(`${chosen.name} is in the basket ✓`);
      }
    } else {
      deps.model.refetch(seq);
      showToast(failureText(outcome.kind));
    }
    redraw();
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

  async function doBank(conceptId: ConceptId): Promise<void> {
    const seq = drawnSeq;
    if (seq === null || banking.has(conceptId)) return;
    const started = generation;
    banking.add(conceptId);
    redraw();
    const moveId = newId();
    let outcome: CookoutOutcome = { ok: false, kind: "unavailable" };
    for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
      outcome = await guarded(() => deps.api.bank(seq, conceptId, moveId));
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

  async function doRetryRecipe(conceptId: ConceptId): Promise<void> {
    const seq = drawnSeq;
    if (seq === null || recipeRetrying.has(conceptId)) return;
    const started = generation;
    recipeRetrying.add(conceptId);
    redraw();
    const outcome = await guarded(() => deps.api.retryRecipe(seq, conceptId));
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

  function startNew(): void {
    const seq = drawnSeq;
    const view = seq === null ? undefined : deps.model.view(seq);
    deps.openStartSheet(view?.blind ?? false);
  }

  // -- Drawing: the progress pills and the turn banner -----------------------------------------------------

  function slotLabel(view: CookoutView, slot: 1 | 2): string {
    if (view.you?.slot === slot) return "You";
    const name = playerOf(view, slot).name;
    if (name !== null) return name;
    return slot === 2 ? "Waiting to join" : "Player 1";
  }

  function pillsRow(view: CookoutView, slot: 1 | 2): HTMLElement {
    const player = playerOf(view, slot);
    const row = el("div", "wx-srv-ck-pills");
    row.dataset["slot"] = String(slot);
    const active = view.current?.player === slot;
    row.classList.toggle("wx-srv-ck-pills-active", active);
    row.append(el("span", "wx-srv-ck-pills-name", slotLabel(view, slot)));
    const dots = el("span", "wx-srv-ck-pills-dots");
    for (let i = 0; i < PICKS_PER_PLAYER; i += 1) {
      const pill = el("span", "wx-srv-ck-pill");
      const pick = player.picks?.[i];
      if (pick !== undefined) {
        pill.classList.add("wx-srv-ck-pill-full");
        pill.textContent = pick.emoji !== "" ? pick.emoji : "•";
        pill.title = pick.name;
      } else if (i < player.pickCount) {
        pill.classList.add("wx-srv-ck-pill-secret");
        pill.textContent = "🔒";
        pill.title = "Secret pick";
      } else if (active && i === player.pickCount) {
        pill.classList.add("wx-srv-ck-pill-now");
      }
      dots.append(pill);
    }
    row.append(dots);
    return row;
  }

  function drawProgress(view: CookoutView): void {
    const showJoin = view.state === "picking" && view.players[1].name === null && view.you?.slot !== 1;
    const key = JSON.stringify([
      view.state,
      view.players.map((p) => [p.name, p.pickCount, p.picks?.map((x) => x.id) ?? null]),
      view.you?.slot ?? null,
      view.current === null ? null : [view.current.turn, view.current.player, view.current.offerIndex, view.current.waitingForJoin, view.current.role],
      showJoin,
      busy.has("join"),
      deps.partner(),
    ]);
    if (view.state !== "picking") {
      progress.hidden = true;
      drawn.progress = "";
      return;
    }
    progress.hidden = false;
    if (drawn.progress === key) return;
    drawn.progress = key;
    const banner = el("p", "wx-srv-ck-turn", turnPrompt(view, partnerFallback()));
    const mine = view.you !== null && view.current !== null && view.you.slot === view.current.player;
    banner.classList.toggle("wx-srv-ck-turn-mine", mine);
    const children: HTMLElement[] = [pillsRow(view, 1), pillsRow(view, 2), banner];
    if (showJoin) {
      const join = button(
        "wx-srv-ck-join",
        busy.has("join") ? "Joining…" : "Join Cookout",
        () => void simple("join", (seq) => deps.api.join(seq), "Couldn't join — try again."),
      );
      join.disabled = busy.has("join");
      children.push(join);
    }
    progress.replaceChildren(...children);
  }

  // -- Drawing: the stage (drafting) ----------------------------------------------------------------------

  function ingredientCard(snap: IngredientSnap, pickable: boolean): HTMLElement {
    const card = el(pickable ? "button" : "div", "wx-srv-ck-opt");
    card.dataset["ingredient"] = snap.id;
    card.append(emojiSpan("wx-srv-ck-opt-emoji", snap.emoji !== "" ? snap.emoji : "🍽️"));
    card.append(el("span", "wx-srv-ck-opt-cat", categoryName(snap.category)));
    card.append(el("span", "wx-srv-ck-opt-name", snap.name));
    if (snap.blurb !== "") card.append(el("span", "wx-srv-ck-opt-blurb", snap.blurb));
    if (card instanceof HTMLButtonElement) {
      card.type = "button";
      card.setAttribute("data-srv-gesture-boundary", "");
      card.setAttribute("aria-label", `Pick ${snap.name}`);
      const cta = el("span", "wx-srv-ck-opt-cta", pickingId === snap.id ? "Adding…" : "Pick this");
      card.append(cta);
      card.disabled = busy.has("move");
      card.classList.toggle("wx-srv-ck-opt-chosen", pickingId === snap.id);
      card.addEventListener("click", () => void move("pick", snap.id));
    }
    return card;
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
      const who =
        current.player === 2 ? (view.players[1].name ?? partnerFallback() ?? "your partner") : nameOf(view, 1, "Player 1");
      const words = waitingJoin
        ? view.you?.slot === 1
          ? `Waiting for ${partnerFallback() ?? "your partner"} to join…`
          : "Press Join Cookout to take the next turn."
        : `🕵️ Secret turn: ${mine ? "you are" : `${who} is`} choosing…`;
      cloche.append(el("p", "wx-srv-ck-cloche-text", words));
      if (!waitingJoin && view.blind) {
        cloche.append(el("p", "wx-srv-ck-cloche-sub", "Blind mode: everything is revealed once all 10 are picked."));
      }
      return [cloche];
    }
    const out: HTMLElement[] = [];
    const role = roleLine(current.role);
    if (role !== "") out.push(el("p", "wx-srv-ck-role", role));
    if (!mine) {
      const who = nameOf(view, current.player, "your partner");
      out.push(el("p", "wx-srv-ck-watch", `${who} is choosing between:`));
    }
    const pair = el("div", "wx-srv-ck-pair");
    pair.classList.toggle("wx-srv-ck-pair-watch", !mine);
    pair.dataset["offer"] = String(current.offerIndex ?? 0);
    const [a, b] = current.options;
    pair.append(ingredientCard(a, mine), el("span", "wx-srv-ck-or", "or"), ingredientCard(b, mine));
    out.push(pair);
    if (mine) {
      const offer = current.offerIndex ?? 0;
      if (offer >= 2 || current.skipsRemaining === 0) {
        out.push(el("p", "wx-srv-ck-final", skipLabel(2)));
      } else {
        const skip = button("wx-srv-ck-skip", skipLabel(offer), () => void move("skip", null));
        skip.disabled = busy.has("move");
        if (busy.has("move") && pickingId === null) skip.textContent = "Dealing…";
        out.push(skip);
      }
    }
    return out;
  }

  // -- Drawing: the basket tray ----------------------------------------------------------------------------

  function basketChip(snap: IngredientSnap, className = "wx-srv-ck-chip-ing"): HTMLElement {
    const chip = el("span", className);
    chip.append(emojiSpan("wx-srv-ck-chip-emoji", snap.emoji !== "" ? snap.emoji : "🍽️"));
    chip.append(el("span", "wx-srv-ck-chip-name", snap.name));
    return chip;
  }

  function drawTray(view: CookoutView): void {
    if (view.state === "finished") {
      tray.hidden = true;
      drawn.tray = "";
      return;
    }
    tray.hidden = false;
    const key = JSON.stringify([
      view.players.map((p) => [p.name, p.pickCount, p.picks?.map((x) => x.id) ?? null]),
      view.you?.slot ?? null,
      view.staples.map((s) => s.id),
      trayOpen,
    ]);
    if (drawn.tray === key) return;
    drawn.tray = key;
    const toggle = button("wx-srv-ck-tray-toggle", "", () => {
      trayOpen = !trayOpen;
      redraw();
      deps.afterChange();
    });
    toggle.setAttribute("aria-expanded", trayOpen ? "true" : "false");
    const total = view.players[0].pickCount + view.players[1].pickCount;
    toggle.append(emojiSpan("wx-srv-ck-tray-icon", "🧺"), el("span", "wx-srv-ck-tray-title", `Basket ${total}/10`));
    toggle.append(el("span", "wx-srv-ck-tray-caret", trayOpen ? "▾" : "▸"));
    const body = el("div", "wx-srv-ck-tray-body");
    body.hidden = !trayOpen;
    const order: Array<1 | 2> = view.you?.slot === 2 ? [2, 1] : [1, 2];
    for (const slot of order) {
      const player = playerOf(view, slot);
      const row = el("div", "wx-srv-ck-tray-row");
      row.append(el("span", "wx-srv-ck-tray-who", slotLabel(view, slot)));
      const chips = el("div", "wx-srv-ck-tray-chips");
      if (player.picks !== null) {
        for (const pick of player.picks) chips.append(basketChip(pick));
      } else {
        for (let i = 0; i < player.pickCount; i += 1) {
          const secret = el("span", "wx-srv-ck-chip-secret");
          secret.append(emojiSpan("wx-srv-ck-chip-emoji", "🔒"), el("span", "wx-srv-ck-chip-name", "Secret pick"));
          chips.append(secret);
        }
      }
      const known = player.picks?.length ?? player.pickCount;
      for (let i = known; i < PICKS_PER_PLAYER; i += 1) chips.append(el("span", "wx-srv-ck-chip-empty"));
      row.append(chips);
      body.append(row);
    }
    if (view.staples.length > 0) {
      body.append(el("p", "wx-srv-ck-staples", `Always in the cupboard: ${view.staples.map((s) => s.name).join(", ")}`));
    }
    tray.replaceChildren(toggle, body);
  }

  // -- Drawing: the chef stage -----------------------------------------------------------------------------

  function revealBanner(view: CookoutView, animate: boolean): HTMLElement {
    const banner = el("div", "wx-srv-ck-reveal");
    const head = el("p", "wx-srv-ck-reveal-title");
    head.append(emojiSpan("wx-srv-ck-reveal-icon", "🧺"), doc.createTextNode(view.blind ? "The big reveal — your 10 ingredients" : "Your 10 ingredients"));
    const chips = el("div", "wx-srv-ck-reveal-chips");
    allPicks(view).forEach((snap, index) => {
      const chip = basketChip(snap, "wx-srv-ck-chip-ing wx-srv-ck-reveal-chip");
      if (animate) {
        chip.classList.add("wx-srv-ck-flip");
        chip.style.animationDelay = `${index * REVEAL_STAGGER_MS}ms`;
      }
      chips.append(chip);
    });
    banner.append(head, chips);
    if (view.staples.length > 0) {
      banner.append(el("p", "wx-srv-ck-staples", `Plus cupboard staples: ${view.staples.map((s) => s.name).join(", ")}`));
    }
    return banner;
  }

  function chefStatus(view: CookoutView): HTMLElement | null {
    const state = view.concepts.state;
    if (state === "ready") return null;
    const box = el("div", "wx-srv-ck-chef");
    if (state === "pending" || state === "none") {
      box.classList.add("wx-srv-ck-chef-working");
      box.append(emojiSpan("wx-srv-ck-chef-hat", "👩‍🍳"));
      box.append(el("p", "wx-srv-ck-chef-text", "Chef is inventing 3 dishes from your 10 ingredients…"));
      const elapsed = el("span", "wx-srv-ck-elapsed", formatElapsed(chefSince === null ? 0 : (clock.now() - chefSince) / 1000));
      elapsed.setAttribute("aria-hidden", "true");
      box.append(elapsed);
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
    const retry = button("wx-srv-ck-retry", busy.has("concepts") ? "Trying…" : "Try again", () =>
      void simple("concepts", (seq) => deps.api.retryConcepts(seq), "Couldn't restart the chef — try again."),
    );
    retry.disabled = busy.has("concepts");
    box.append(retry);
    return box;
  }

  function nameLookup(view: CookoutView, concept: Concept): Map<string, string> {
    const names = new Map<string, string>();
    for (const s of view.staples) names.set(s.id, s.name);
    for (const snap of allPicks(view)) names.set(snap.id, snap.name);
    for (const snap of concept.pickedIngredients) names.set(snap.id, snap.name);
    for (const s of concept.staplesUsed) names.set(s.id, s.name);
    return names;
  }

  function pictureHeader(view: CookoutView, concept: Concept, picture: Picture | null): HTMLElement {
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
      open.append(img);
      header.append(open);
      return header;
    }
    header.classList.add("wx-srv-ck-dish-pic-empty");
    header.append(emojiSpan("wx-srv-ck-dish-plate", dishEmoji(concept.dishType)));
    if (view.images.state === "pending") {
      header.classList.add("wx-srv-ck-dish-pic-pending");
      header.append(el("span", "wx-srv-ck-dish-pic-note", "Plating up…"));
    } else if (view.images.state === "failed") {
      const retry = button("wx-srv-ck-dish-retry", busy.has("pictures") ? "Trying…" : "Retry picture", () =>
        void simple("pictures", (seq) => deps.api.retryPictures(seq), "Couldn't restart the pictures — try again."),
      );
      retry.disabled = busy.has("pictures");
      header.append(retry);
    }
    return header;
  }

  function recipeView(concept: Concept, recipe: FullRecipe, names: Map<string, string>, slot: RecipeSlot): HTMLElement {
    const box = el("div", "wx-srv-ck-recipe");
    box.dataset["concept"] = concept.id;
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

    box.append(el("h4", "wx-srv-ck-recipe-head", "Ingredients"));
    const list = el("ul", "wx-srv-ck-recipe-ings");
    for (const item of recipe.ingredients) {
      const li = el("li", "wx-srv-ck-recipe-ing");
      const label = el("label", "wx-srv-ck-recipe-ing-label");
      label.setAttribute("data-srv-gesture-boundary", "");
      const box2 = doc.createElement("input");
      box2.type = "checkbox";
      box2.className = "wx-srv-ck-recipe-check";
      const tickKey = `${concept.id}:${item.id}`;
      box2.checked = checked.has(tickKey);
      box2.addEventListener("change", () => {
        if (box2.checked) checked.add(tickKey);
        else checked.delete(tickKey);
        li.classList.toggle("wx-srv-ck-recipe-ing-done", box2.checked);
      });
      li.classList.toggle("wx-srv-ck-recipe-ing-done", box2.checked);
      const words = el("span", "wx-srv-ck-recipe-ing-words");
      words.append(el("span", "wx-srv-ck-recipe-qty", item.quantity));
      words.append(el("span", "wx-srv-ck-recipe-ing-name", item.name ?? names.get(item.id) ?? tidy(item.id)));
      if (item.note !== "") words.append(el("span", "wx-srv-ck-recipe-note", item.note));
      label.append(box2, words);
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
    switch (slot.state) {
      case "none": {
        const bank = button("wx-srv-ck-bank", banking.has(concept.id) ? "Saving…" : "Bank this ✓", () => void doBank(concept.id), `Bank ${concept.title}`);
        bank.disabled = banking.has(concept.id);
        box.append(bank);
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
          () => void doRetryRecipe(concept.id),
        );
        retry.disabled = recipeRetrying.has(concept.id);
        box.append(retry);
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

  function conceptKey(view: CookoutView, concept: Concept): string {
    const slot = view.recipes[concept.id];
    const picture = view.images.pictures[concept.id];
    return JSON.stringify([
      concept,
      // A card with its photo does not care how the OTHER photos are getting on (redrawing it would
      // reload the photo); one without shows the shimmer or Retry, which do.
      picture ?? [view.images.state, busy.has("pictures")],
      slot,
      banking.has(concept.id),
      recipeRetrying.has(concept.id),
      expanded.has(concept.id),
    ]);
  }

  function conceptCard(view: CookoutView, concept: Concept): HTMLElement {
    const card = el("article", "wx-srv-ck-dish");
    card.dataset["concept"] = concept.id;
    card.append(pictureHeader(view, concept, view.images.pictures[concept.id]));
    const body = el("div", "wx-srv-ck-dish-body");
    body.append(el("h3", "wx-srv-ck-dish-title", concept.title));
    const tags = el("div", "wx-srv-ck-dish-tags");
    if (concept.vibe !== "") tags.append(el("span", "wx-srv-ck-tag wx-srv-ck-tag-vibe", concept.vibe));
    if (concept.dishType !== "") tags.append(el("span", "wx-srv-ck-tag", tidy(concept.dishType)));
    if (concept.technique !== "") tags.append(el("span", "wx-srv-ck-tag", tidy(concept.technique)));
    if (tags.childElementCount > 0) body.append(tags);
    body.append(el("p", "wx-srv-ck-dish-desc", concept.description));
    const total = Math.max(allPicks(view).length, concept.pickedIngredients.length + concept.omitted.length);
    const uses = el("div", "wx-srv-ck-dish-uses");
    uses.append(el("span", "wx-srv-ck-uses-count", `Uses ${concept.pickedIngredients.length}/${total}`));
    const chips = el("div", "wx-srv-ck-uses-chips");
    for (const snap of concept.pickedIngredients) chips.append(basketChip(snap, "wx-srv-ck-chip-ing wx-srv-ck-chip-small"));
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
    body.append(bankControls(view, concept));
    const slot = view.recipes[concept.id];
    if (slot.state === "banked" && expanded.has(concept.id)) {
      body.append(
        slot.data !== null
          ? recipeView(concept, slot.data, nameLookup(view, concept), slot)
          : el("p", "wx-srv-ck-recipe-missing", "This recipe is saved but can't be shown right now."),
      );
    }
    card.append(body);
    return card;
  }

  function drawChef(view: CookoutView, host: HTMLElement): void {
    const concepts = view.concepts.state === "ready" ? (view.concepts.data ?? []) : [];
    const grid = host.querySelector<HTMLElement>(".wx-srv-ck-dishes");
    if (grid === null) return;
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

  function drawStage(view: CookoutView): void {
    if (view.state === "abandoned") {
      const key = JSON.stringify(["abandoned"]);
      if (drawn.stage === key) return;
      drawn.stage = key;
      conceptCards.clear();
      const box = el("div", "wx-srv-ck-ended");
      box.append(emojiSpan("wx-srv-ck-ended-icon", "🧹"));
      box.append(el("p", "wx-srv-ck-ended-text", "This Cookout was ended before the basket was full."));
      box.append(button("wx-srv-ck-again", "Start a new Cookout", () => startNew()));
      stage.replaceChildren(box);
      return;
    }
    if (view.state === "picking") {
      conceptCards.clear();
      const current = view.current;
      const key = JSON.stringify([
        "picking",
        current,
        view.you?.slot ?? null,
        view.players.map((p) => p.name),
        busy.has("move"),
        pickingId,
        deps.partner(),
      ]);
      if (drawn.stage === key) return;
      drawn.stage = key;
      stage.replaceChildren(...drawDraft(view));
      return;
    }
    // Finished: the reveal banner, the chef's status and the three dishes.
    // A Blind round this screen watched being picked flips its basket open once. (Not part of the key:
    // the very next refresh must not redraw the banner and cut the flip short.)
    const animate = view.blind && sawPicking && !revealPlayed;
    const frameKey = JSON.stringify(["finished", allPicks(view).map((p) => p.id), view.concepts.state, busy.has("concepts")]);
    if (drawn.stage !== frameKey) {
      drawn.stage = frameKey;
      conceptCards.clear();
      const status = chefStatus(view);
      const grid = el("div", "wx-srv-ck-dishes");
      stage.replaceChildren(revealBanner(view, animate), ...(status === null ? [] : [status]), grid);
      if (animate) revealPlayed = true;
    }
    drawChef(view, stage);
  }

  // -- The elapsed clock -----------------------------------------------------------------------------------

  function syncElapsed(view: CookoutView | undefined): void {
    const working = view !== undefined && view.state === "finished" && (view.concepts.state === "pending" || view.concepts.state === "none");
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
      endButton.hidden = true;
      newButton.hidden = true;
      return;
    }
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
    trayOpen = true;
    ending = false;
    confirmEnd.hidden = true;
    sawPicking = false;
    revealPlayed = false;
    chefSince = null;
    if (moveRetryTimer !== null) clock.clearTimeout(moveRetryTimer);
    moveRetryTimer = null;
    stopTimers();
    drawn.progress = "";
    drawn.stage = "";
    drawn.tray = "";
    conceptCards.clear();
    progress.replaceChildren();
    stage.replaceChildren();
    tray.replaceChildren();
  }

  function applyFocus(view: CookoutView): void {
    if (focusConcept === null || focusConcept.seq !== view.seq || view.state !== "finished" || view.concepts.state !== "ready") {
      return;
    }
    const id = focusConcept.id;
    const slot = view.recipes[id];
    if (slot.state === "banked" && !expanded.has(id)) {
      expanded.add(id);
      drawChef(view, stage);
    }
    focusConcept = null;
    const card = conceptCards.get(id)?.element;
    if (card !== undefined && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "start" });
  }

  function refreshPane(seq: number): void {
    visible = true;
    if (drawnSeq !== seq) {
      forgetRound();
      drawnSeq = seq;
      strip.draw(seq);
      scroll.scrollTop = 0;
    }
    const view = deps.model.view(seq);
    drawBar(view);
    if (view === undefined) {
      progress.hidden = true;
      tray.hidden = true;
      if (drawn.stage !== "loading") {
        drawn.stage = "loading";
        stage.replaceChildren(el("p", "wx-srv-ck-loading", "Getting the kitchen ready…"));
      }
      return;
    }
    if (view.state === "picking") sawPicking = true;
    syncElapsed(view);
    drawProgress(view);
    drawStage(view);
    drawTray(view);
    applyFocus(view);
    deps.afterChange();
  }

  function forget(): void {
    visible = false;
    forgetRound();
    focusConcept = null;
    drawnSeq = null;
    strip.draw(null);
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
      if (ending) cancelEnd();
    },
    reset: forget,
  });

  return {
    pane,
    open: (seq) => deps.tabs.open("cookout", seq),
    openRecipe(seq, conceptId) {
      focusConcept = CONCEPT_IDS.includes(conceptId) ? { seq, id: conceptId } : null;
      deps.tabs.open("cookout", seq);
      // Already on screen with the same round: the open redraws only when something changed.
      const view = deps.model.view(seq);
      if (view !== undefined && drawnSeq === seq) applyFocus(view);
    },
    offer: (seq) => deps.tabs.offer("cookout", seq),
    close,
    gameSeq: () => deps.tabs.seqOf("cookout"),
  };
}
