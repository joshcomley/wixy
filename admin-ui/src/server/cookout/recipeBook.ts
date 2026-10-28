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

import { ServerLockedError } from "../api/http";
import type { Message } from "../api/messages";
import type { LockHooks, ServerSession } from "../types";
import { formatMinutes, getRecipeBook, type BookRecipe, type BookResult, type ConceptId } from "./api";

export interface RecipeBookDeps {
  readonly document: Document;
  readonly hooks: Pick<LockHooks, "lockNow">;
  readonly getSession: () => ServerSession | null;
  /** A dish was tapped: open it in the Cookout tab (the book closes itself first). */
  openRecipe(seq: number, conceptId: ConceptId): void;
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
  list.append(entries, empty, loading, error, retry);
  root.append(bar, list);

  let opened = false;
  let loaded = false;
  let busy = false;
  let again = false;
  let current: readonly BookRecipe[] = [];
  /** Bumped on every open/close so an answer to an earlier session of the screen is dropped. */
  let generation = 0;
  let timer: number | null = null;

  function refreshChrome(): void {
    empty.hidden = !(loaded && current.length === 0 && error.hidden);
    loading.hidden = !(busy && !loaded);
    retry.hidden = error.hidden;
  }

  function entryButton(recipe: BookRecipe): HTMLElement {
    const row = el("button", "wx-srv-ck-book-entry");
    row.type = "button";
    row.setAttribute("data-srv-gesture-boundary", "");
    row.dataset["recipeSeq"] = String(recipe.seq);
    row.dataset["conceptId"] = recipe.conceptId;
    const thumb = el("span", "wx-srv-ck-book-thumb");
    if (recipe.picture !== null) {
      const img = doc.createElement("img");
      img.className = "wx-srv-ck-book-img";
      img.src = recipe.picture.thumbUrl;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.addEventListener("error", () => {
        img.remove();
        thumb.textContent = "🍽️";
      });
      thumb.append(img);
    } else {
      thumb.textContent = "🍽️";
      thumb.setAttribute("aria-hidden", "true");
    }
    const words = el("span", "wx-srv-ck-book-words");
    words.append(el("span", "wx-srv-ck-book-name", recipe.title));
    if (recipe.vibe !== "") words.append(el("span", "wx-srv-ck-book-vibe", recipe.vibe));
    const meta = [formatMinutes(recipe.totalMinutes), `Serves ${recipe.serves}`];
    words.append(el("span", "wx-srv-ck-book-meta", meta.join(" · ")));
    row.append(thumb, words);
    row.addEventListener("click", () => {
      view.close();
      deps.openRecipe(recipe.seq, recipe.conceptId);
    });
    return row;
  }

  function draw(): void {
    entries.replaceChildren(...current.map(entryButton));
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
