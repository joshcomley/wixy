import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRecipeBook, type BookResult } from "../../src/server/cookout/api";
import { createRecipeBook, filterBook } from "../../src/server/cookout/recipeBook";
import type { EncorePreset } from "../../src/server/cookout/startSheet";
import type { ServerSession } from "../../src/server/types";
import { BEANS, MISO, PARSLEY, RIBEYE, TOAST, bookBody, picture } from "./fixtures";
import { CHALLENGE_PAN, STYLE_COSY, flush, q, qa, type Json } from "./twistFixtures";

// The Recipe book's twists (spec/server-chat/09a-cookout-twists.md §4.5, §9): the ✓ Cooked badge, both
// ratings, the real photo beside the chef's, the All / Cooked / Not cooked yet filter, and the Remix and
// Leftovers encore buttons that open the start sheet with an Encore preset.

const SESSION = { token: "tok", expiresAt: 9e9 } as ServerSession;

function body(): Json {
  const [first, second] = bookBody()["recipes"] as Json[];
  return {
    recipes: [
      {
        ...first,
        generation: 1,
        cooked: {
          cookedAt: 1793300000,
          ratings: [
            { name: "Josh", rating: 4 },
            { name: "Cupcake", rating: null },
          ],
          photo: picture(5),
        },
        dinnerPick: true,
        style: STYLE_COSY,
        challenge: CHALLENGE_PAN,
        ingredients: [TOAST, PARSLEY],
        leftovers: [BEANS, MISO],
      },
      { ...second, generation: 2, cooked: null, ingredients: [RIBEYE], leftovers: [] },
    ],
  };
}

function make(raw: Json = body()) {
  const openRecipe = vi.fn();
  const openEncore = vi.fn();
  const book = createRecipeBook({
    document,
    hooks: { lockNow: vi.fn() },
    getSession: () => SESSION,
    openRecipe,
    openEncore,
    fetchBook: async (): Promise<BookResult> => ({ ok: true, recipes: parseRecipeBook(raw) ?? [] }),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  document.body.append(book.element);
  return { book, openRecipe, openEncore };
}

async function opened(raw: Json = body()) {
  const h = make(raw);
  h.book.open(0);
  await flush();
  return h;
}

const entry = (h: { book: { element: HTMLElement } }, seq: number): HTMLElement =>
  q(h.book.element, `.wx-srv-ck-book-entry[data-recipe-seq="${seq}"]`).closest<HTMLElement>(".wx-srv-ck-book-item") as HTMLElement;

afterEach(() => document.body.replaceChildren());

describe("a cooked entry", () => {
  it("carries a ✓ Cooked badge, the dinner pick, and the round's style and challenge", async () => {
    const h = await opened();
    const cooked = entry(h, 41);
    expect(cooked.classList.contains("wx-srv-ck-book-item-cooked")).toBe(true);
    expect(qa(cooked, ".wx-srv-ck-book-badge").map((b) => b.textContent)).toEqual(["✓ Cooked", "🎯 Dinner pick", "🍺 Cosy pub", "🍳 One pan only"]);
    // The other entry has none of it.
    const plain = entry(h, 30);
    expect(plain.classList.contains("wx-srv-ck-book-item-cooked")).toBe(false);
    expect(plain.querySelector(".wx-srv-ck-book-badges")).toBeNull();
  });

  it("shows both players' ratings as hearts", async () => {
    const h = await opened();
    const lines = qa(entry(h, 41), ".wx-srv-ck-book-rating");
    expect(lines.map((l) => [l.querySelector(".wx-srv-ck-book-rating-who")?.textContent, l.querySelector(".wx-srv-ck-book-rating-hearts")?.textContent])).toEqual([
      ["Josh", "♥♥♥♥♡"],
      ["Cupcake", "not rated"],
    ]);
    expect(lines[0]?.getAttribute("aria-label")).toBe("Josh: 4 of 5 hearts");
    expect(lines[1]?.getAttribute("aria-label")).toBe("Cupcake: not rated");
    expect(entry(h, 30).querySelector(".wx-srv-ck-book-ratings")).toBeNull();
  });

  it("shows the real photo as a thumbnail beside the AI one", async () => {
    const h = await opened();
    const thumbs = qa(entry(h, 41), ".wx-srv-ck-book-thumb");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]?.classList.contains("wx-srv-ck-book-thumb-real")).toBe(false);
    expect(thumbs[0]?.querySelector("img")?.getAttribute("src")).toBe("/api/admin/server/media/thumb-1.jpg");
    expect(thumbs[1]?.classList.contains("wx-srv-ck-book-thumb-real")).toBe(true);
    expect(thumbs[1]?.querySelector("img")?.getAttribute("src")).toBe("/api/admin/server/media/thumb-5.jpg");
    expect(thumbs[1]?.querySelector("img")?.getAttribute("alt")).toBe("Our plate");
    // An entry with no photo has just its one (here, no picture at all: the plate).
    expect(qa(entry(h, 30), ".wx-srv-ck-book-thumb")).toHaveLength(1);
  });

  it("a cooked entry with no real photo shows only the AI one", async () => {
    const raw = body();
    const [first] = raw["recipes"] as Json[];
    (first as Json)["cooked"] = { cookedAt: 1, ratings: [], photo: null };
    const h = await opened(raw);
    expect(qa(entry(h, 41), ".wx-srv-ck-book-thumb")).toHaveLength(1);
    expect(entry(h, 41).querySelector(".wx-srv-ck-book-ratings")).toBeNull();
  });
});

describe("the All / Cooked / Not cooked yet filter", () => {
  const filterButton = (h: { book: { element: HTMLElement } }, value: string): HTMLButtonElement =>
    q<HTMLButtonElement>(h.book.element, `.wx-srv-ck-book-filter[data-filter="${value}"]`);
  const seqs = (h: { book: { element: HTMLElement } }): string[] => qa(h.book.element, ".wx-srv-ck-book-entry").map((e) => e.dataset["recipeSeq"] ?? "");

  it("starts on All, with the three choices as one radio group", async () => {
    const h = await opened();
    expect(qa(h.book.element, ".wx-srv-ck-book-filter").map((b) => [b.textContent, b.getAttribute("aria-checked")])).toEqual([
      ["All", "true"],
      ["Cooked", "false"],
      ["Not cooked yet", "false"],
    ]);
    expect(seqs(h)).toEqual(["41", "30"]);
  });

  it("Cooked keeps the cooked ones, Not cooked yet the rest, All brings both back", async () => {
    const h = await opened();
    filterButton(h, "cooked").click();
    expect(seqs(h)).toEqual(["41"]);
    expect(filterButton(h, "cooked").getAttribute("aria-checked")).toBe("true");
    expect(filterButton(h, "all").getAttribute("aria-checked")).toBe("false");
    filterButton(h, "uncooked").click();
    expect(seqs(h)).toEqual(["30"]);
    filterButton(h, "all").click();
    expect(seqs(h)).toEqual(["41", "30"]);
  });

  it("says so when a filter leaves nothing", async () => {
    const raw = body();
    for (const r of raw["recipes"] as Json[]) r["cooked"] = null;
    const h = await opened(raw);
    filterButton(h, "cooked").click();
    expect(seqs(h)).toEqual([]);
    const none = q(h.book.element, ".wx-srv-ck-book-none");
    expect(none.hidden).toBe(false);
    expect(none.textContent).toBe("Nothing cooked yet — tap “We cooked it!” on a recipe you've made.");
    filterButton(h, "uncooked").click();
    expect(none.hidden).toBe(true);
  });

  it("is not offered when the book is empty, and resets to All when reopened", async () => {
    const empty = await opened({ recipes: [] });
    expect(q(empty.book.element, ".wx-srv-ck-book-filters").hidden).toBe(true);
    document.body.replaceChildren();
    const h = await opened();
    filterButton(h, "cooked").click();
    h.book.close();
    h.book.open(0);
    await flush();
    expect(filterButton(h, "all").getAttribute("aria-checked")).toBe("true");
    expect(seqs(h)).toEqual(["41", "30"]);
  });

  it("filterBook keeps the order and never mutates its input", () => {
    const recipes = parseRecipeBook(body()) ?? [];
    expect(filterBook(recipes, "all").map((r) => r.seq)).toEqual([41, 30]);
    expect(filterBook(recipes, "cooked").map((r) => r.seq)).toEqual([41]);
    expect(filterBook(recipes, "uncooked").map((r) => r.seq)).toEqual([30]);
    expect(recipes).toHaveLength(2);
  });
});

describe("Remix and Leftovers encore", () => {
  it("Remix opens the start sheet preset with the dish's own ingredients as the candidates", async () => {
    const h = await opened();
    q<HTMLButtonElement>(entry(h, 41), ".wx-srv-ck-book-remix").click();
    expect(h.openEncore).toHaveBeenCalledTimes(1);
    const preset = h.openEncore.mock.calls[0]?.[0] as EncorePreset;
    expect(preset).toMatchObject({ fromSeq: 41, generation: 1, conceptId: "a", kind: "remix", title: "Espresso-Glazed Ribeye over Crispy Toast" });
    expect(preset.candidates.map((c) => c.id)).toEqual(["thick-white-toast", "flat-leaf-parsley"]);
    // The book gets out of the way.
    expect(h.book.isOpen()).toBe(false);
    expect(h.openRecipe).not.toHaveBeenCalled();
  });

  it("Leftovers encore opens it with what the dish left out", async () => {
    const h = await opened();
    q<HTMLButtonElement>(entry(h, 41), ".wx-srv-ck-book-leftovers").click();
    const preset = h.openEncore.mock.calls[0]?.[0] as EncorePreset;
    expect(preset).toMatchObject({ fromSeq: 41, generation: 1, conceptId: "a", kind: "leftovers" });
    expect(preset.candidates.map((c) => c.id)).toEqual(["tinned-baked-beans", "white-miso"]);
    expect(h.book.isOpen()).toBe(false);
  });

  it("the encore names the dish's own generation (an earlier or later dish set)", async () => {
    const h = await opened();
    q<HTMLButtonElement>(entry(h, 30), ".wx-srv-ck-book-remix").click();
    expect(h.openEncore.mock.calls[0]?.[0]).toMatchObject({ fromSeq: 30, generation: 2, conceptId: "c", kind: "remix" });
  });

  it("the Leftovers button is absent when the dish left nothing out, and Remix when it used nothing", async () => {
    const raw = body();
    const [, second] = raw["recipes"] as Json[];
    (second as Json)["ingredients"] = [];
    const h = await opened(raw);
    expect(entry(h, 30).querySelector(".wx-srv-ck-book-leftovers")).toBeNull();
    expect(entry(h, 30).querySelector(".wx-srv-ck-book-remix")).toBeNull();
    expect(entry(h, 30).querySelector(".wx-srv-ck-book-actions")).toBeNull();
    expect(entry(h, 41).querySelector(".wx-srv-ck-book-leftovers")).not.toBeNull();
  });

  it("a core-era entry (no ingredient lists) has no encore buttons at all", async () => {
    const h = await opened(bookBody());
    expect(h.book.element.querySelector(".wx-srv-ck-book-encore")).toBeNull();
  });

  it("every encore button is a gesture boundary with a name", async () => {
    const h = await opened();
    for (const b of qa<HTMLButtonElement>(h.book.element, ".wx-srv-ck-book-encore")) {
      expect(b.hasAttribute("data-srv-gesture-boundary")).toBe(true);
      expect(b.getAttribute("aria-label")).not.toBe("");
    }
    for (const b of qa<HTMLButtonElement>(h.book.element, ".wx-srv-ck-book-filter, .wx-srv-ck-book-entry")) {
      expect(b.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    }
  });
});

describe("opening a dish", () => {
  it("a tap on an entry opens that dish with ITS generation, and closes the book", async () => {
    const h = await opened();
    q<HTMLButtonElement>(entry(h, 30), ".wx-srv-ck-book-entry").click();
    expect(h.openRecipe).toHaveBeenCalledWith(30, "c", 2);
    expect(h.book.isOpen()).toBe(false);
    document.body.replaceChildren();
    const again = await opened();
    q<HTMLButtonElement>(entry(again, 41), ".wx-srv-ck-book-entry").click();
    expect(again.openRecipe).toHaveBeenCalledWith(41, "a", 1);
  });
});
