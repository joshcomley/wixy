import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import { ServerLockedError } from "../../src/server/api/http";
import { parseRecipeBook, type BookResult } from "../../src/server/cookout/api";
import { createRecipeBook } from "../../src/server/cookout/recipeBook";
import type { ServerSession } from "../../src/server/types";
import { BEANS, TOAST, bookBody } from "./fixtures";
import { HAM, PICKLES, SOURDOUGH, modeBookBody } from "./modeFixtures";
import type { EncorePreset } from "../../src/server/cookout/startSheet";

// The Recipe book (spec 09 §5.4): a full-height screen like the Holiday bank, newest banked first, each
// entry a thumbnail, title, vibe, total time and "Serves 2"; a tap opens that dish's full recipe.

const SESSION = { token: "tok", expiresAt: 9e9 } as ServerSession;

function make(fetchBook: (s: ServerSession) => Promise<BookResult>, session: ServerSession | null = SESSION) {
  const timers: Array<() => void> = [];
  const openRecipe = vi.fn();
  const lockNow = vi.fn();
  const book = createRecipeBook({
    document,
    hooks: { lockNow },
    getSession: () => session,
    openRecipe,
    openEncore: vi.fn(),
    fetchBook,
    setTimeout: (cb) => timers.push(cb),
    clearTimeout: () => {},
  });
  document.body.append(book.element);
  return { book, openRecipe, lockNow, timers };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const full = async (): Promise<BookResult> => ({ ok: true, recipes: parseRecipeBook(bookBody()) ?? [] });

afterEach(() => document.body.replaceChildren());

describe("the Recipe book", () => {
  it("opens under the header and lists the banked dishes with photo, title, vibe, time and serves", async () => {
    const h = make(full);
    h.book.open(56);
    expect(h.book.element.hidden).toBe(false);
    expect(h.book.element.style.top).toBe("56px");
    await flush();
    const entries = h.book.element.querySelectorAll<HTMLButtonElement>(".wx-srv-ck-book-entry");
    expect(entries).toHaveLength(2);
    const first = entries[0] as HTMLElement;
    expect(first.querySelector(".wx-srv-ck-book-name")?.textContent).toBe("Espresso-Glazed Ribeye over Crispy Toast");
    expect(first.querySelector(".wx-srv-ck-book-vibe")?.textContent).toBe("Steakhouse Bistro");
    expect(first.querySelector(".wx-srv-ck-book-meta")?.textContent).toBe("35 min · Serves 2");
    expect(first.querySelector("img")?.getAttribute("src")).toBe("/api/admin/server/media/thumb-1.jpg");
    expect((entries[1] as HTMLElement).querySelector(".wx-srv-ck-book-meta")?.textContent).toBe("1 hr 20 min · Serves 2");
    expect((entries[1] as HTMLElement).querySelector("img")).toBeNull();
  });

  it("a tap closes the book and opens that dish", async () => {
    const h = make(full);
    h.book.open(0);
    await flush();
    h.book.element.querySelectorAll<HTMLButtonElement>(".wx-srv-ck-book-entry")[1]?.click();
    expect(h.book.isOpen()).toBe(false);
    expect(h.openRecipe).toHaveBeenCalledWith(30, "c", 1);
  });

  it("says when there is nothing yet, and offers Try again when the list will not load", async () => {
    const empty = make(async () => ({ ok: true, recipes: [] }));
    empty.book.open(0);
    await flush();
    expect(empty.book.element.querySelector<HTMLElement>(".wx-srv-ck-book-empty")?.hidden).toBe(false);
    document.body.replaceChildren();
    const failing = make(async () => ({ ok: false, kind: "unavailable" }));
    failing.book.open(0);
    await flush();
    expect(failing.book.element.querySelector(".wx-srv-ck-book-error")?.textContent).toBe("Couldn't load the Recipe book.");
    expect(failing.book.element.querySelector<HTMLElement>(".wx-srv-ck-book-retry")?.hidden).toBe(false);
  });

  it("a lock while loading locks the chat", async () => {
    const h = make(async () => {
      throw new ServerLockedError();
    });
    h.book.open(0);
    await flush();
    expect(h.lockNow).toHaveBeenCalledWith("unauthorized");
  });

  it("re-reads when a Cookout changes while open, and drops a deleted round's dishes at once", async () => {
    const fetchBook = vi.fn(full);
    const h = make(fetchBook);
    h.book.open(0);
    await flush();
    h.book.messageChanged({ seq: 99, cookout: null } as unknown as Message);
    expect(h.timers).toHaveLength(0);
    h.book.messageChanged({ seq: 41, cookout: { state: "finished", rev: 3 } } as unknown as Message);
    expect(h.timers).toHaveLength(1);
    h.timers[0]?.();
    await flush();
    expect(fetchBook).toHaveBeenCalledTimes(2);
    h.book.messageDeleted(41);
    expect(h.book.element.querySelectorAll(".wx-srv-ck-book-entry")).toHaveLength(1);
  });

  it("close() empties the screen and drops a late answer", async () => {
    let resolve: (r: BookResult) => void = () => {};
    const h = make(() => new Promise<BookResult>((r) => (resolve = r)));
    h.book.open(0);
    h.book.close();
    resolve({ ok: true, recipes: parseRecipeBook(bookBody()) ?? [] });
    await flush();
    expect(h.book.element.hidden).toBe(true);
    expect(h.book.element.querySelectorAll(".wx-srv-ck-book-entry")).toHaveLength(0);
  });
});

// -- Game modes (spec/server-chat/09c-cookout-modes.md §6.4) -------------------------------------------------

describe("game modes in the Recipe book", () => {
  function modeMake(raw: Record<string, unknown> = modeBookBody()) {
    const openEncore = vi.fn();
    const book = createRecipeBook({
      document,
      hooks: { lockNow: vi.fn() },
      getSession: () => SESSION,
      openRecipe: vi.fn(),
      openEncore,
      fetchBook: async (): Promise<BookResult> => ({ ok: true, recipes: parseRecipeBook(raw) ?? [] }),
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    document.body.append(book.element);
    return { book, openEncore };
  }

  async function modeOpened(raw?: Record<string, unknown>) {
    const h = modeMake(raw);
    h.book.open(0);
    await flush();
    return h;
  }

  /** The book item of recipe `seq`. */
  const item = (h: { book: { element: HTMLElement } }, seq: number): HTMLElement =>
    h.book.element.querySelector<HTMLElement>(`.wx-srv-ck-book-entry[data-recipe-seq="${seq}"]`)?.closest<HTMLElement>(".wx-srv-ck-book-item") as HTMLElement;

  it("a 🥪 badge sits on a Toasted sandwich entry and on no Classic one", async () => {
    const h = await modeOpened();
    const toastie = item(h, 30).querySelector<HTMLElement>(".wx-srv-ck-book-mode");
    expect(toastie?.textContent).toBe("🥪");
    expect(toastie?.title).toBe("Toasted sandwich");
    expect(toastie?.getAttribute("aria-label")).toBe("Toasted sandwich");
    expect(toastie?.dataset["gameMode"]).toBe("toastie");
    expect(item(h, 41).querySelector(".wx-srv-ck-book-mode")).toBeNull();
    expect(h.book.element.querySelectorAll(".wx-srv-ck-book-mode")).toHaveLength(1);
  });

  it("a mode without an emoji is badged with its label", async () => {
    const raw = modeBookBody();
    const [first, second] = raw["recipes"] as Array<Record<string, unknown>>;
    const h = await modeOpened({ recipes: [first, { ...second, mode: { id: "wrap", label: "Wrap" } }] });
    expect(item(h, 30).querySelector(".wx-srv-ck-book-mode")?.textContent).toBe("Wrap");
  });

  it("Remix and Leftovers carry the entry's mode into the encore preset", async () => {
    const h = await modeOpened();
    (item(h, 30).querySelector(".wx-srv-ck-book-remix") as HTMLButtonElement).click();
    expect(h.openEncore).toHaveBeenCalledTimes(1);
    const remix = h.openEncore.mock.calls[0]?.[0] as EncorePreset;
    expect(remix).toMatchObject({ fromSeq: 30, kind: "remix", mode: "toastie" });
    expect(remix.candidates.map((c) => c.id)).toEqual(["sourdough-loaf", "smoked-ham"]);
    h.book.open(0);
    await flush();
    (item(h, 30).querySelector(".wx-srv-ck-book-leftovers") as HTMLButtonElement).click();
    const leftovers = h.openEncore.mock.calls[1]?.[0] as EncorePreset;
    expect(leftovers).toMatchObject({ fromSeq: 30, kind: "leftovers", mode: "toastie" });
    expect(leftovers.candidates.map((c) => c.id)).toEqual(["dill-pickles"]);
  });

  it("a Classic entry passes mode \"classic\"", async () => {
    const h = await modeOpened();
    (item(h, 41).querySelector(".wx-srv-ck-book-remix") as HTMLButtonElement).click();
    expect(h.openEncore.mock.calls[0]?.[0]).toMatchObject({ fromSeq: 41, kind: "remix", mode: "classic" });
    h.book.open(0);
    await flush();
    (item(h, 41).querySelector(".wx-srv-ck-book-leftovers") as HTMLButtonElement).click();
    expect(h.openEncore.mock.calls[1]?.[0]).toMatchObject({ kind: "leftovers", mode: "classic" });
  });

  it("an entry from a server without modes is Classic: no badge, mode \"classic\" in its encore", async () => {
    const h = await modeOpened({ recipes: (bookBody()["recipes"] as Array<Record<string, unknown>>).map((r) => ({ ...r, generation: 1, ingredients: [TOAST], leftovers: [BEANS] })) });
    expect(h.book.element.querySelectorAll(".wx-srv-ck-book-mode")).toHaveLength(0);
    (item(h, 41).querySelector(".wx-srv-ck-book-remix") as HTMLButtonElement).click();
    expect(h.openEncore.mock.calls[0]?.[0]).toMatchObject({ mode: "classic" });
  });
});

describe("game modes: Remix passes candidates with their kinds", () => {
  it("a Toasted sandwich entry's Remix and Leftovers candidates carry kind", async () => {
    const [first, second] = modeBookBody()["recipes"] as Array<Record<string, unknown>>;
    const raw = {
      recipes: [
        first,
        {
          ...second,
          ingredients: [{ ...SOURDOUGH, kind: "bread" }, { ...HAM, kind: "main" }],
          leftovers: [{ ...PICKLES, kind: "produce" }, { ...HAM, id: "plain-ham", kind: null }],
        },
      ],
    };
    const openEncore = vi.fn();
    const book = createRecipeBook({
      document,
      hooks: { lockNow: vi.fn() },
      getSession: () => SESSION,
      openRecipe: vi.fn(),
      openEncore,
      fetchBook: async (): Promise<BookResult> => ({ ok: true, recipes: parseRecipeBook(raw) ?? [] }),
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    document.body.append(book.element);
    book.open(0);
    await flush();
    const item = book.element.querySelector<HTMLElement>('.wx-srv-ck-book-entry[data-recipe-seq="30"]')!.closest<HTMLElement>(".wx-srv-ck-book-item")!;
    (item.querySelector(".wx-srv-ck-book-remix") as HTMLButtonElement).click();
    const remix = openEncore.mock.calls[0]?.[0] as EncorePreset;
    expect(remix.candidates.map((c) => [c.id, c.kind])).toEqual([
      ["sourdough-loaf", "bread"],
      ["smoked-ham", "main"],
    ]);
    book.open(0);
    await flush();
    (item.ownerDocument.querySelector('.wx-srv-ck-book-entry[data-recipe-seq="30"]')!.closest(".wx-srv-ck-book-item")!.querySelector(".wx-srv-ck-book-leftovers") as HTMLButtonElement).click();
    const left = openEncore.mock.calls[1]?.[0] as EncorePreset;
    expect(left.candidates.map((c) => [c.id, c.kind])).toEqual([
      ["dill-pickles", "produce"],
      ["plain-ham", null],
    ]);
  });
});
