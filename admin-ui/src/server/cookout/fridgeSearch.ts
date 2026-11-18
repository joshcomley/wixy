// The FRIDGE RAID search (workspace 00058; spec/server-chat/09a-cookout-twists.md §1.1 T6, §9): one row
// of the start sheet's twists. Type what is in the fridge tonight, the bank answers (`GET
// /cookout/ingredients?q=`, at most 20 of its own entries), tap one and it becomes the round's first pick
// — a public "starter" both players see from the beginning.
//
//   [ 🧊 Fridge raid  — start with something you have at home ]
//   [ 🔎 [ Search the pantry…                            ] ]
//   [  🍅 Cherry tomatoes   🧀 Aged Gruyère   …              ]   <- results, or the one chosen chip ✕
//
// Only bank entries can be chosen (the server refuses anything else), so the field is a search, never a
// free-text ingredient: no typed string ever reaches the chef. Requests are debounced (250 ms) and an
// answer to an older query is dropped, so a fast typist never sees a stale list. Everything user-visible
// is set via `textContent`.

import { SEARCH_MAX, SEARCH_MIN, type IngredientSnap, type SearchResult } from "./api";
import { ingredientPicture } from "./pictures";

export interface FridgeSearchDeps {
  readonly document: Document;
  /** The bank search; rejects only on a lock (the caller handles it). */
  search(q: string): Promise<SearchResult>;
  /** The chosen ingredient changed (null = cleared). */
  onChange(chosen: IngredientSnap | null): void;
  /** Test seams. */
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

export interface FridgeSearch {
  readonly element: HTMLElement;
  chosen(): IngredientSnap | null;
  /** Show `snap` as the chosen one (a preset), or clear it. Does not call `onChange`. */
  set(snap: IngredientSnap | null): void;
  /** Lock the controls while a start is in flight. */
  setDisabled(disabled: boolean): void;
  /** The field's example words (a toasted sandwich searches breads, 09c §6.1). */
  setPlaceholder(text: string): void;
  /** Forget the query, the results and any request in flight. */
  reset(): void;
}

export const FRIDGE_DEBOUNCE_MS = 250;

export function createFridgeSearch(deps: FridgeSearchDeps): FridgeSearch {
  const doc = deps.document;
  const setTimer = deps.setTimeout ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const clearTimer = deps.clearTimeout ?? ((id: number) => window.clearTimeout(id));

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function emoji(className: string, glyph: string): HTMLElement {
    const span = el("span", className, glyph);
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  const root = el("div", "wx-srv-ck-fridge");
  const field = el("label", "wx-srv-ck-fridge-field");
  field.append(emoji("wx-srv-ck-fridge-glass", "🔎"));
  const input = doc.createElement("input");
  input.type = "search";
  input.className = "wx-srv-ck-fridge-input";
  input.placeholder = "Search the pantry — e.g. tomatoes";
  input.maxLength = SEARCH_MAX;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Search for an ingredient you have at home");
  input.setAttribute("data-srv-gesture-boundary", "");
  field.append(input);
  const status = el("p", "wx-srv-ck-fridge-status");
  status.setAttribute("role", "status");
  status.hidden = true;
  const results = el("div", "wx-srv-ck-fridge-results");
  results.setAttribute("role", "listbox");
  results.setAttribute("aria-label", "Pantry matches");
  results.hidden = true;
  const chosenRow = el("div", "wx-srv-ck-fridge-chosen");
  chosenRow.hidden = true;
  root.append(field, status, results, chosenRow);

  let chosen: IngredientSnap | null = null;
  let disabled = false;
  let timer: number | null = null;
  /** Bumped per query (and on reset): an answer for an older one is dropped. */
  let ticket = 0;

  function showStatus(text: string): void {
    status.textContent = text;
    status.hidden = text === "";
  }

  function drawChosen(): void {
    field.hidden = chosen !== null;
    results.hidden = true;
    results.replaceChildren();
    if (chosen === null) {
      chosenRow.hidden = true;
      chosenRow.replaceChildren();
      return;
    }
    const chip = el("span", "wx-srv-ck-fridge-chip");
    // Its picture (09b §D.5), or the same-size emoji tile without one.
    chip.append(ingredientPicture(doc, chosen, { rendition: "thumb", className: "wx-srv-ck-fridge-pic", alt: "" }));
    chip.append(el("span", "wx-srv-ck-fridge-chip-name", chosen.name));
    const clear = el("button", "wx-srv-ck-fridge-clear", "✕");
    clear.type = "button";
    clear.disabled = disabled;
    clear.setAttribute("aria-label", `Remove ${chosen.name}`);
    clear.setAttribute("data-srv-gesture-boundary", "");
    clear.addEventListener("click", () => {
      if (disabled) return;
      chosen = null;
      drawChosen();
      showStatus("");
      deps.onChange(null);
      input.focus();
    });
    chip.append(clear);
    chosenRow.replaceChildren(chip);
    chosenRow.hidden = false;
  }

  function choose(snap: IngredientSnap): void {
    if (disabled) return;
    chosen = snap;
    input.value = "";
    ticket += 1;
    showStatus("");
    drawChosen();
    deps.onChange(snap);
  }

  function drawResults(list: readonly IngredientSnap[]): void {
    results.replaceChildren(
      ...list.map((snap) => {
        const option = el("button", "wx-srv-ck-fridge-option");
        option.type = "button";
        option.setAttribute("role", "option");
        option.setAttribute("data-srv-gesture-boundary", "");
        option.dataset["ingredient"] = snap.id;
        option.disabled = disabled;
        option.append(ingredientPicture(doc, snap, { rendition: "thumb", className: "wx-srv-ck-fridge-pic", alt: "" }));
        option.append(el("span", "wx-srv-ck-fridge-option-name", snap.name));
        option.addEventListener("click", () => choose(snap));
        return option;
      }),
    );
    results.hidden = list.length === 0;
  }

  async function run(query: string, mine: number): Promise<void> {
    let result: SearchResult;
    try {
      result = await deps.search(query);
    } catch {
      // A lock: the caller's own hooks deal with it; this field just stops.
      return;
    }
    if (mine !== ticket) return;
    if (!result.ok) {
      drawResults([]);
      showStatus(result.kind === "game_unavailable" ? "The pantry isn't available right now." : "Couldn't search the pantry — try again.");
      return;
    }
    drawResults(result.ingredients);
    showStatus(result.ingredients.length === 0 ? "Nothing in the pantry matches that." : "");
  }

  function schedule(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
    ticket += 1;
    const query = input.value.trim();
    if (query.length < SEARCH_MIN) {
      drawResults([]);
      showStatus("");
      return;
    }
    const mine = ticket;
    timer = setTimer(() => {
      timer = null;
      void run(query, mine);
    }, FRIDGE_DEBOUNCE_MS);
  }

  input.addEventListener("input", () => schedule());

  return {
    element: root,
    chosen: () => chosen,
    set(snap) {
      chosen = snap;
      input.value = "";
      ticket += 1;
      showStatus("");
      drawChosen();
    },
    setDisabled(next) {
      disabled = next;
      input.disabled = next;
      for (const b of root.querySelectorAll<HTMLButtonElement>("button")) b.disabled = next;
    },
    setPlaceholder(text) {
      input.placeholder = text;
    },
    reset() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      ticket += 1;
      chosen = null;
      input.value = "";
      showStatus("");
      drawChosen();
    },
  };
}
