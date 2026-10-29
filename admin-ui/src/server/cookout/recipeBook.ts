// The Recipe book (workspace 00058; spec/server-chat/09-cookout.md §5.4, the `holidayBank.ts`
// precedent): the ⋯ menu's "Recipe book" (and the Cookout pane's header) opens this full-height screen
// over the thread listing every banked dish, newest first — its photo, title, vibe, total time and
// "Serves 2". Tapping one opens that round in the Cookout tab straight at the dish's full recipe (and
// its chat). Like the Holiday bank it sits under the chat header so the panic ✕ and the lock gestures
// stay reachable, and every lock and wipe closes it (`thread.detach()` / `teardown()`).
//
// The list is the server's `GET /cookout/bank` (derived from banked recipes, so deleting a round's
// message removes its dishes). While the screen is open a Cookout that changes or is deleted re-reads
// the list (a short debounce collects a burst of changes into one request).
//
// THE TWISTS (spec/server-chat/09a-cookout-twists.md §9): each entry shows its ✓ Cooked badge, both
// players' hearts and the real-plate photo beside the chef's picture; an "All / Cooked / Not cooked yet"
// filter sits above the list; and every entry carries Remix (start a new game seeded with this dish's own
// ingredients) and — when the dish left something out — Leftovers encore. Both open the start sheet
// with an Encore banner preset; nothing starts until the players press Start.

import { ServerLockedError } from "../api/http";
import type { Message } from "../api/messages";
import type { LockHooks, ServerSession } from "../types";
import { formatMinutes, getRecipeBook, MAX_RATING, type BookRecipe, type BookResult, type ConceptId, type Picture } from "./api";
import type { EncorePreset } from "./startSheet";

export interface RecipeBookDeps {
  readonly document: Document;
  readonly hooks: Pick<LockHooks, "lockNow">;
  readonly getSession: () => ServerSession | null;
  /** A dish was tapped: open it in the Cookout tab (the book closes itself first). `generation` names the
   * dish set (an earlier one after a rescue swap). */
  openRecipe(seq: number, conceptId: ConceptId, generation: number): void;
  /** Remix / Leftovers encore: open the start sheet with this encore preset (the book closes first). */
  openEncore(preset: EncorePreset): void;
  /** Injectable for tests; defaults to the real `GET /cookout/bank`. */
  readonly fetchBook?: (session: ServerSession) => Promise<BookResult>;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

export interface RecipeBook {
  readonly element: HTMLElement;
  /** Show the screen below `topOffsetPx` (the chat header's height). */
  open(topOffsetPx: number): void;
  close(): void;
  isOpen(): boolean;
  /** A message arrived or changed in the thread: re-read the list if it is a Cookout. */
  messageChanged(message: Message): void;
  messageDeleted(seq: number): void;
}

const REFRESH_DEBOUNCE_MS = 400;

export type BookFilter = "all" | "cooked" | "uncooked";

/** The entries a filter keeps (order unchanged). */
export function filterBook(recipes: readonly BookRecipe[], filter: BookFilter): BookRecipe[] {
  if (filter === "cooked") return recipes.filter((r) => r.cooked !== null);
  if (filter === "uncooked") return recipes.filter((r) => r.cooked === null);
  return [...recipes];
}

export function createRecipeBook(deps: RecipeBookDeps): RecipeBook {
  const doc = deps.document;
  const fetchBook = deps.fetchBook ?? getRecipeBook;
  const setTimer = deps.setTimeout ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const clearTimer = deps.clearTimeout ?? ((id: number) => window.clearTimeout(id));

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const root = el("div", "wx-srv-ck-book-view");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Recipe book");

  const bar = el("div", "wx-srv-ck-book-bar");
  const title = el("span", "wx-srv-ck-book-title");
  const titleIcon = el("span", "wx-srv-ck-book-icon", "📖");
  titleIcon.setAttribute("aria-hidden", "true");
  title.append(titleIcon, doc.createTextNode("Recipe book"));
  const closeButton = el("button", "wx-srv-ck-book-close", "Back to chat");
  closeButton.type = "button";
  closeButton.setAttribute("data-srv-gesture-boundary", "");
  bar.append(title, closeButton);

  const list = el("div", "wx-srv-ck-book-list");
  const filters = el("div", "wx-srv-ck-book-filters");
  filters.setAttribute("role", "radiogroup");
  filters.setAttribute("aria-label", "Show");
  const filterButtons = new Map<BookFilter, HTMLButtonElement>();
  for (const [value, label] of [
    ["all", "All"],
    ["cooked", "Cooked"],
    ["uncooked", "Not cooked yet"],
  ] as const) {
    const b = el("button", "wx-srv-ck-book-filter", label);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("data-srv-gesture-boundary", "");
    b.dataset["filter"] = value;
    b.addEventListener("click", () => {
      filter = value;
      draw();
    });
    filterButtons.set(value, b);
    filters.append(b);
  }
  const noneHere = el("p", "wx-srv-ck-book-none", "");
  noneHere.hidden = true;
  const empty = el("div", "wx-srv-ck-book-empty");
  const emptyIcon = el("span", "wx-srv-ck-book-empty-icon", "🍳");
  emptyIcon.setAttribute("aria-hidden", "true");
  empty.append(
    emptyIcon,
    el("p", "wx-srv-ck-book-empty-text", "No recipes yet. Play Cookout and tap “Bank this” on a dish you'd like to cook."),
  );
  empty.hidden = true;
  const loading = el("p", "wx-srv-ck-book-loading", "Loading…");
  loading.hidden = true;
  const error = el("p", "wx-srv-ck-book-error");
  error.hidden = true;
  const retry = el("button", "wx-srv-ck-book-retry", "Try again");
  retry.type = "button";
  retry.setAttribute("data-srv-gesture-boundary", "");
  retry.hidden = true;
  const entries = el("div", "wx-srv-ck-book-entries");
  list.append(filters, entries, noneHere, empty, loading, error, retry);
  root.append(bar, list);

  let opened = false;
  let loaded = false;
  let busy = false;
  let again = false;
  let current: readonly BookRecipe[] = [];
  let filter: BookFilter = "all";
  /** Bumped on every open/close so an answer to an earlier session of the screen is dropped. */
  let generation = 0;
  let timer: number | null = null;

  function refreshChrome(): void {
    empty.hidden = !(loaded && current.length === 0 && error.hidden);
    loading.hidden = !(busy && !loaded);
    retry.hidden = error.hidden;
    filters.hidden = current.length === 0;
    for (const [value, b] of filterButtons) {
      b.setAttribute("aria-checked", value === filter ? "true" : "false");
      b.classList.toggle("wx-srv-ck-book-filter-on", value === filter);
    }
    const shown = filterBook(current, filter).length;
    noneHere.hidden = !(current.length > 0 && shown === 0);
    noneHere.textContent = filter === "cooked" ? "Nothing cooked yet — tap “We cooked it!” on a recipe you've made." : "You've cooked everything here!";
  }

  function thumbOf(picture: Picture | null, className: string, fallback: string, alt: string): HTMLElement {
    const thumb = el("span", className);
    if (picture !== null) {
      const img = doc.createElement("img");
      img.className = "wx-srv-ck-book-img";
      img.src = picture.thumbUrl;
      img.alt = alt;
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.addEventListener("error", () => {
        img.remove();
        thumb.textContent = fallback;
      });
      thumb.append(img);
    } else {
      thumb.textContent = fallback;
      thumb.setAttribute("aria-hidden", "true");
    }
    return thumb;
  }

  function heartsText(rating: number | null): string {
    if (rating === null) return "not rated";
    return "♥".repeat(rating) + "♡".repeat(MAX_RATING - rating);
  }

  function encoreButton(recipe: BookRecipe, kind: "remix" | "leftovers"): HTMLButtonElement {
    const candidates = kind === "remix" ? recipe.ingredients : recipe.leftovers;
    const b = el("button", `wx-srv-ck-book-encore wx-srv-ck-book-${kind}`, kind === "remix" ? "🔁 Remix" : "🥡 Leftovers encore");
    b.type = "button";
    b.setAttribute("data-srv-gesture-boundary", "");
    b.setAttribute("aria-label", kind === "remix" ? `Remix ${recipe.title}` : `Start a game with what ${recipe.title} left out`);
    b.addEventListener("click", () => {
      view.close();
      deps.openEncore({
        fromSeq: recipe.seq,
        generation: recipe.generation,
        conceptId: recipe.conceptId,
        kind,
        title: recipe.title,
        candidates,
      });
    });
    return b;
  }

  function entryButton(recipe: BookRecipe): HTMLElement {
    const entry = el("div", "wx-srv-ck-book-item");
    entry.classList.toggle("wx-srv-ck-book-item-cooked", recipe.cooked !== null);
    const row = el("button", "wx-srv-ck-book-entry");
    row.type = "button";
    row.setAttribute("data-srv-gesture-boundary", "");
    row.dataset["recipeSeq"] = String(recipe.seq);
    row.dataset["conceptId"] = recipe.conceptId;
    row.dataset["generation"] = String(recipe.generation);
    const thumbs = el("span", "wx-srv-ck-book-thumbs");
    thumbs.append(thumbOf(recipe.picture, "wx-srv-ck-book-thumb", "🍽️", ""));
    // The real plate beside the chef's daydream, once one is linked.
    if (recipe.cooked?.photo != null) {
      thumbs.append(thumbOf(recipe.cooked.photo, "wx-srv-ck-book-thumb wx-srv-ck-book-thumb-real", "📷", "Our plate"));
    }
    const words = el("span", "wx-srv-ck-book-words");
    const name = el("span", "wx-srv-ck-book-name", recipe.title);
    words.append(name);
    const badges = el("span", "wx-srv-ck-book-badges");
    if (recipe.cooked !== null) badges.append(el("span", "wx-srv-ck-book-badge wx-srv-ck-book-cooked", "✓ Cooked"));
    if (recipe.dinnerPick) badges.append(el("span", "wx-srv-ck-book-badge wx-srv-ck-book-dinner", "🎯 Dinner pick"));
    if (recipe.style !== null) badges.append(el("span", "wx-srv-ck-book-badge", `${recipe.style.emoji} ${recipe.style.label}`.trim()));
    if (recipe.challenge !== null) badges.append(el("span", "wx-srv-ck-book-badge", `${recipe.challenge.emoji} ${recipe.challenge.label}`.trim()));
    if (badges.childElementCount > 0) words.append(badges);
    if (recipe.vibe !== "") words.append(el("span", "wx-srv-ck-book-vibe", recipe.vibe));
    const meta = [formatMinutes(recipe.totalMinutes), `Serves ${recipe.serves}`];
    words.append(el("span", "wx-srv-ck-book-meta", meta.join(" · ")));
    if (recipe.cooked !== null && recipe.cooked.ratings.length > 0) {
      const ratings = el("span", "wx-srv-ck-book-ratings");
      for (const r of recipe.cooked.ratings) {
        const line = el("span", "wx-srv-ck-book-rating");
        line.append(el("span", "wx-srv-ck-book-rating-who", r.name), el("span", "wx-srv-ck-book-rating-hearts", heartsText(r.rating)));
        line.setAttribute("aria-label", r.rating === null ? `${r.name}: not rated` : `${r.name}: ${r.rating} of ${MAX_RATING} hearts`);
        ratings.append(line);
      }
      words.append(ratings);
    }
    row.append(thumbs, words);
    row.addEventListener("click", () => {
      view.close();
      deps.openRecipe(recipe.seq, recipe.conceptId, recipe.generation);
    });
    entry.append(row);
    const actions = el("div", "wx-srv-ck-book-actions");
    if (recipe.ingredients.length > 0) actions.append(encoreButton(recipe, "remix"));
    if (recipe.leftovers.length > 0) actions.append(encoreButton(recipe, "leftovers"));
    if (actions.childElementCount > 0) entry.append(actions);
    return entry;
  }

  function draw(): void {
    entries.replaceChildren(...filterBook(current, filter).map(entryButton));
    refreshChrome();
  }

  async function load(): Promise<void> {
    if (busy) {
      again = true;
      return;
    }
    const session = deps.getSession();
    if (session === null) return;
    const started = generation;
    busy = true;
    error.hidden = true;
    refreshChrome();
    let result: BookResult;
    try {
      result = await fetchBook(session);
    } catch (thrown) {
      if (started === generation && thrown instanceof ServerLockedError) deps.hooks.lockNow("unauthorized");
      result = { ok: false, kind: "unavailable" };
    }
    if (started !== generation) return;
    busy = false;
    if (result.ok) {
      current = result.recipes;
      loaded = true;
      error.hidden = true;
    } else {
      error.textContent = "Couldn't load the Recipe book.";
      error.hidden = false;
      loaded = true;
    }
    draw();
    if (again) {
      again = false;
      void load();
    }
  }

  function scheduleRefresh(): void {
    if (!opened || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void load();
    }, REFRESH_DEBOUNCE_MS);
  }

  closeButton.addEventListener("click", () => view.close());
  retry.addEventListener("click", () => void load());

  const view: RecipeBook = {
    element: root,
    open(topOffsetPx) {
      if (opened) return;
      opened = true;
      generation += 1;
      loaded = false;
      busy = false;
      again = false;
      current = [];
      filter = "all";
      error.hidden = true;
      entries.replaceChildren();
      root.style.top = `${topOffsetPx}px`;
      root.hidden = false;
      list.scrollTop = 0;
      refreshChrome();
      void load();
    },
    close() {
      if (!opened) return;
      opened = false;
      generation += 1;
      busy = false;
      again = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      root.hidden = true;
      entries.replaceChildren();
      current = [];
    },
    isOpen: () => opened,
    messageChanged(message) {
      if (message.cookout === undefined || message.cookout === null) return;
      scheduleRefresh();
    },
    messageDeleted(seq) {
      if (!opened) return;
      if (current.some((recipe) => recipe.seq === seq)) {
        current = current.filter((recipe) => recipe.seq !== seq);
        draw();
      }
    },
  };
  return view;
}
