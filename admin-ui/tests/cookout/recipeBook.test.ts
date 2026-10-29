import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import { ServerLockedError } from "../../src/server/api/http";
import { parseRecipeBook, type BookResult } from "../../src/server/cookout/api";
import { createRecipeBook } from "../../src/server/cookout/recipeBook";
import type { ServerSession } from "../../src/server/types";
import { bookBody } from "./fixtures";

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
