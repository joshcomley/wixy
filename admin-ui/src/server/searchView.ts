// The Server chat's Search (decisions/00208): the ⋯ menu's "Search" opens a full-height screen with
// a box to type in. Matching messages and voice-note transcripts are listed newest first, each with
// a short excerpt and the words marked. Tapping one closes the list and shows that message IN the
// chat, and a bar above the composer steps Older / Newer through the rest, or returns to the list.
//
// Nothing is kept: no query or result is written to storage, and every lock, wipe and teardown
// `reset()`s the lot. A deleted message leaves the results the moment its event arrives. The server
// does all the matching, so this file never has to agree with it about how text folds.

import { ServerLockedError } from "./api/http";
import type { Message } from "./api/messages";
import { SEARCH_MAX_CHARS, SEARCH_PAGE, searchMessages, type SearchPage, type SearchResult } from "./api/search";
import type { LockHooks, ServerSession } from "./types";

/** "cancelled": something newer took over, and the chat was left alone. */
export type RevealOutcome = "shown" | "gone" | "failed" | "cancelled";

export interface SearchDeps {
  readonly document: Document;
  readonly win: Pick<Window, "setTimeout" | "clearTimeout">;
  readonly hooks: Pick<LockHooks, "lockNow">;
  readonly getSession: () => ServerSession | null;
  /** How a sender reads in a result ("You", or their name). */
  readonly senderLabel: (sender: string) => string;
  /** Shows the message in the chat, loading its part of the history first if need be. */
  readonly reveal: (seq: number, matched: readonly string[]) => Promise<RevealOutcome>;
  /** The chat is no longer showing a result: drop the marks on its words. */
  readonly clearReveal: () => void;
  /** The bar above the composer appeared or went. */
  readonly onNavChange: () => void;
  /** Injectable for tests; defaults to the real `POST /messages/search`. */
  readonly fetchPage?: typeof searchMessages;
}

export interface SearchView {
  /** The full-height list, for the thread's root. */
  readonly element: HTMLElement;
  /** The Older / Newer bar, for the thread's wrapper. */
  readonly nav: HTMLElement;
  open(topOffsetPx: number): void;
  /** Close everything and forget the query and its results. */
  reset(): void;
  isOpen(): boolean;
  navActive(): boolean;
  /** A message arrived or changed in the chat: ask whether it now belongs in the results. */
  messageChanged(message: Message): void;
  messageDeleted(seq: number): void;
}

const DEBOUNCE_MS = 250;
/** How close (px) to the bottom of the list counts as "wants more". */
const NEAR_BOTTOM_PX = 400;

function errorText(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "Something went wrong.";
}

function formatWhen(epochS: number): string {
  const date = new Date(epochS * 1000);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

interface Row {
  result: SearchResult;
  element: HTMLElement;
}

export function createSearchView(deps: SearchDeps): SearchView {
  const { document: doc, hooks, win } = deps;
  const fetchPage = deps.fetchPage ?? searchMessages;

  const root = doc.createElement("div");
  root.className = "wx-srv-search-view";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Search messages");

  const bar = doc.createElement("div");
  bar.className = "wx-srv-search-bar";
  const input = doc.createElement("input");
  input.type = "search";
  input.className = "wx-srv-search-input";
  input.placeholder = "Search messages";
  input.maxLength = SEARCH_MAX_CHARS;
  input.setAttribute("aria-label", "Search messages");
  // What was typed here must not outlive the screen, in the browser's form history or anywhere else.
  input.autocomplete = "off";
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.spellcheck = false;
  input.enterKeyHint = "search";
  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wx-srv-search-close";
  closeButton.setAttribute("data-srv-gesture-boundary", "");
  closeButton.textContent = "Back to chat";
  bar.append(input, closeButton);

  const summary = doc.createElement("p");
  summary.className = "wx-srv-search-summary";
  summary.setAttribute("aria-live", "polite");

  const list = doc.createElement("div");
  list.className = "wx-srv-search-list";
  const hint = doc.createElement("p");
  hint.className = "wx-srv-search-hint";
  hint.textContent = "Type a word to find it in your messages and voice note transcripts.";
  const loading = doc.createElement("p");
  loading.className = "wx-srv-search-loading";
  loading.textContent = "Searching…";
  loading.hidden = true;
  const loadError = doc.createElement("p");
  loadError.className = "wx-srv-search-error";
  loadError.hidden = true;
  const more = doc.createElement("button");
  more.type = "button";
  more.className = "wx-srv-search-more";
  more.setAttribute("data-srv-gesture-boundary", "");
  more.hidden = true;
  // Rows are inserted before this footer, so it always stays last.
  const footer = doc.createElement("div");
  footer.className = "wx-srv-search-footer";
  footer.append(hint, loading, loadError, more);
  list.appendChild(footer);
  root.append(bar, summary, list);

  // The bar's buttons are tapped in quick succession on purpose, so they never count toward the
  // double-tap lock (R3), exactly as the unread voice notes bar. Escape and the panic ✕ still lock.
  const nav = doc.createElement("div");
  nav.className = "wx-srv-search-nav";
  nav.hidden = true;
  nav.setAttribute("role", "toolbar");
  nav.setAttribute("aria-label", "Search results");
  nav.setAttribute("data-srv-gesture-exempt", "");
  function navButton(className: string, text: string, label: string): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.setAttribute("aria-label", label);
    return button;
  }
  const older = navButton("wx-srv-search-older", "‹ Older", "Older result");
  const position = doc.createElement("button");
  position.type = "button";
  position.className = "wx-srv-search-pos";
  position.setAttribute("aria-live", "polite");
  const newer = navButton("wx-srv-search-newer", "Newer ›", "Newer result");
  // Never just "Close": to a screen reader that is the panic ✕, which locks the chat.
  const navClose = navButton("wx-srv-search-nav-close", "✕", "Close search");
  nav.append(older, position, newer, navClose);

  /** Newest first. */
  let rows: Row[] = [];
  let query = "";
  let hasMore = false;
  let total = 0;
  let searched = false;
  let busy = false;
  let opened = false;
  /** The result the bar is at, or null: no bar. It can have been deleted since. */
  let currentSeq: number | null = null;
  let finding = false;
  let navNote: string | null = null;
  let debounce: number | null = null;
  /** Bumped by each new query and by a reset, so a response to an earlier one is dropped. */
  let generation = 0;
  /** Bumped by each step, so only the newest reveal may update the bar. */
  let revealGeneration = 0;
  /** Deleted since this query began: a page read before the delete must not bring one back. */
  const deletedSeqs = new Set<number>();
  const changedSeqs = new Set<number>();
  let checkingChanged = false;
  let pageLoad: Promise<void> | null = null;

  function refreshChrome(): void {
    const typing = input.value.trim() !== "";
    hint.hidden = typing;
    loading.hidden = !busy;
    more.hidden = busy || !(hasMore || !loadError.hidden);
    more.textContent = loadError.hidden ? "Show earlier ones" : "Try again";
    if (!searched || !typing) {
      summary.hidden = true;
      summary.textContent = "";
    } else {
      summary.hidden = false;
      if (total === 0) summary.textContent = loadError.hidden ? "No messages found." : "";
      else summary.textContent = `${total} message${total === 1 ? "" : "s"}`;
    }
  }

  function buildRow(result: SearchResult): Row {
    const element = doc.createElement("button");
    element.type = "button";
    element.className = "wx-srv-search-item";
    element.dataset["messageSeq"] = String(result.seq);
    element.setAttribute("data-srv-gesture-boundary", "");
    const head = doc.createElement("span");
    head.className = "wx-srv-search-item-head";
    const sender = doc.createElement("span");
    sender.className = "wx-srv-search-item-sender";
    sender.textContent = deps.senderLabel(result.sender);
    const when = doc.createElement("span");
    when.className = "wx-srv-search-item-when";
    when.textContent = formatWhen(result.createdAt);
    head.append(sender, when);
    const body = doc.createElement("span");
    body.className = "wx-srv-search-item-text";
    if (result.source === "transcript") {
      const source = doc.createElement("span");
      source.className = "wx-srv-search-item-source";
      source.textContent = "Voice note: ";
      body.appendChild(source);
    }
    for (const part of result.parts) {
      if (part.match) {
        const mark = doc.createElement("mark");
        mark.textContent = part.text;
        body.appendChild(mark);
      } else {
        body.appendChild(doc.createTextNode(part.text));
      }
    }
    element.append(head, body);
    element.addEventListener("click", () => goTo(result.seq));
    return { result, element };
  }

  /** Puts `result` in its newest-first place, replacing the copy already shown. */
  function place(result: SearchResult): void {
    if (deletedSeqs.has(result.seq)) return;
    const added = buildRow(result);
    const existing = rows.findIndex((row) => row.result.seq === result.seq);
    if (existing !== -1) {
      rows[existing]?.element.replaceWith(added.element);
      rows[existing] = added;
      return;
    }
    let index = 0;
    while (index < rows.length && (rows[index]?.result.seq ?? 0) > result.seq) index += 1;
    list.insertBefore(added.element, rows[index]?.element ?? footer);
    rows.splice(index, 0, added);
  }

  function dropRows(): void {
    for (const row of rows) row.element.remove();
    rows = [];
  }

  function fail(error: unknown): void {
    if (error instanceof ServerLockedError) {
      hooks.lockNow("unauthorized");
      return;
    }
    loadError.textContent = errorText(error);
    loadError.hidden = false;
  }

  /** One page of the current query: the first when nothing is held, else the next older. One
   * already on its way is the one asked for. */
  function loadPage(startGeneration: number): Promise<void> {
    if (pageLoad !== null && busy) return pageLoad;
    pageLoad = fetchNextPage(startGeneration);
    return pageLoad;
  }

  async function fetchNextPage(startGeneration: number): Promise<void> {
    if (query === "") return;
    const session = deps.getSession();
    if (session === null) return;
    busy = true;
    loadError.hidden = true;
    refreshChrome();
    try {
      const oldest = rows[rows.length - 1]?.result.seq;
      const page: SearchPage = await fetchPage(session, query, {
        ...(oldest !== undefined ? { before: oldest } : {}),
        limit: SEARCH_PAGE,
      });
      if (generation !== startGeneration) return;
      for (const result of page.results) place(result);
      hasMore = page.hasMore && page.results.length > 0;
      total = page.total;
      searched = true;
    } catch (error) {
      if (generation !== startGeneration) return;
      fail(error);
      searched = true;
    } finally {
      if (generation === startGeneration) {
        busy = false;
        refreshChrome();
        syncNav();
      }
    }
  }

  function clearDebounce(): void {
    if (debounce !== null) win.clearTimeout(debounce);
    debounce = null;
  }

  function startSearch(text: string): void {
    clearDebounce();
    generation += 1;
    query = text;
    hasMore = false;
    total = 0;
    searched = false;
    busy = false;
    loadError.hidden = true;
    deletedSeqs.clear();
    changedSeqs.clear();
    dropRows();
    closeNav();
    list.scrollTop = 0;
    refreshChrome();
    if (text !== "") void loadPage(generation);
  }

  input.addEventListener("input", () => {
    clearDebounce();
    const text = input.value.trim();
    if (text === query) {
      refreshChrome();
      return;
    }
    if (text === "") {
      startSearch("");
      return;
    }
    debounce = win.setTimeout(() => startSearch(text), DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = input.value.trim();
    if (text !== query) startSearch(text);
    input.blur();
  });

  more.addEventListener("click", () => void loadPage(generation));
  list.addEventListener(
    "scroll",
    () => {
      if (!opened || !hasMore || busy || !loadError.hidden) return;
      if (list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX) {
        void loadPage(generation);
      }
    },
    { passive: true },
  );

  /** Asks about messages that arrived or changed, one at a time: a burst of them (a reconnect
   * catching up) must not become a burst of searches. */
  async function checkChanged(): Promise<void> {
    if (checkingChanged) return;
    checkingChanged = true;
    try {
      for (const seq of changedSeqs) {
        changedSeqs.delete(seq);
        const session = deps.getSession();
        if (session === null || query === "") break;
        // The first page is still on its way, and will include it if it belongs.
        if (!searched) continue;
        const startGeneration = generation;
        let page: SearchPage;
        try {
          page = await fetchPage(session, query, { only: seq });
        } catch (error) {
          // Only a refinement of a list already on screen; one lost answer doesn't lose the rest.
          if (error instanceof ServerLockedError) throw error;
          continue;
        }
        if (generation !== startGeneration) continue;
        const oldest = rows[rows.length - 1]?.result.seq;
        for (const result of page.results) {
          // Older than everything held, with more still to load: it arrives with its page.
          const held = rows.some((row) => row.result.seq === result.seq);
          if (!held && hasMore && oldest !== undefined && result.seq < oldest) continue;
          place(result);
        }
        total = page.total;
        refreshChrome();
        syncNav();
      }
    } catch (error) {
      if (error instanceof ServerLockedError) hooks.lockNow("unauthorized");
      changedSeqs.clear();
    } finally {
      checkingChanged = false;
    }
  }

  function indexOfCurrent(): number {
    return rows.findIndex((row) => row.result.seq === currentSeq);
  }

  /** The nearest held results either side of `currentSeq`, which may have been deleted. */
  function neighbours(): { older: Row | null; newer: Row | null } {
    let newerRow: Row | null = null;
    let olderRow: Row | null = null;
    for (const row of rows) {
      if (currentSeq !== null && row.result.seq > currentSeq) newerRow = row;
      else if (currentSeq !== null && row.result.seq < currentSeq) {
        olderRow = row;
        break;
      }
    }
    return { older: olderRow, newer: newerRow };
  }

  function syncNav(): void {
    const wasHidden = nav.hidden;
    if (currentSeq === null) {
      nav.hidden = true;
      if (!wasHidden) deps.onNavChange();
      return;
    }
    const around = neighbours();
    const index = indexOfCurrent();
    if (navNote !== null) position.textContent = navNote;
    else if (finding) position.textContent = "Finding it…";
    else if (index >= 0) position.textContent = `${index + 1} of ${total}`;
    else position.textContent = total === 0 ? "No more results" : `${total} result${total === 1 ? "" : "s"}`;
    position.setAttribute("aria-label", `${position.textContent}. Show the search results.`);
    older.hidden = around.older === null && !hasMore;
    newer.hidden = around.newer === null;
    nav.hidden = false;
    if (wasHidden) deps.onNavChange();
  }

  function hideList(): void {
    opened = false;
    root.hidden = true;
  }

  function closeNav(): void {
    currentSeq = null;
    finding = false;
    navNote = null;
    revealGeneration += 1;
    deps.clearReveal();
    syncNav();
  }

  /** Close the list and show the result `seq` in the chat. */
  function goTo(seq: number): void {
    const row = rows.find((candidate) => candidate.result.seq === seq);
    if (row === undefined) return;
    hideList();
    input.blur();
    currentSeq = seq;
    finding = true;
    navNote = null;
    revealGeneration += 1;
    const startReveal = revealGeneration;
    deps.clearReveal();
    syncNav();
    void deps.reveal(seq, row.result.matched).then((outcome) => {
      if (startReveal !== revealGeneration) return;
      finding = false;
      if (outcome === "cancelled") {
        syncNav();
        return;
      }
      if (outcome === "gone") view.messageDeleted(seq);
      else if (outcome === "failed") navNote = "Couldn't get to that one";
      syncNav();
    });
  }

  async function stepOlder(): Promise<void> {
    let target = neighbours().older;
    if (target === null && hasMore) {
      const startGeneration = generation;
      await loadPage(startGeneration);
      if (generation !== startGeneration || currentSeq === null) return;
      target = neighbours().older;
    }
    if (target !== null) goTo(target.result.seq);
  }

  older.addEventListener("click", () => void stepOlder());
  newer.addEventListener("click", () => {
    const target = neighbours().newer;
    if (target !== null) goTo(target.result.seq);
  });
  position.addEventListener("click", () => {
    view.open(Number.parseFloat(root.style.top) || 0);
    rows[Math.max(0, indexOfCurrent())]?.element.scrollIntoView?.({ block: "center" });
  });
  navClose.addEventListener("click", () => view.reset());
  closeButton.addEventListener("click", () => view.reset());

  const view: SearchView = {
    element: root,
    nav,
    open(topOffsetPx: number): void {
      if (opened) return;
      opened = true;
      root.style.top = `${topOffsetPx}px`;
      root.hidden = false;
      refreshChrome();
      if (query === "") input.focus();
    },
    reset(): void {
      opened = false;
      root.hidden = true;
      input.value = "";
      startSearch("");
    },
    isOpen: () => opened,
    navActive: () => currentSeq !== null,
    messageChanged(message: Message): void {
      if (query === "" || message.viewOnce) return;
      // The server says it exists: a delete that failed gives it back.
      deletedSeqs.delete(message.seq);
      changedSeqs.add(message.seq);
      void checkChanged();
    },
    messageDeleted(seq: number): void {
      deletedSeqs.add(seq);
      const index = rows.findIndex((row) => row.result.seq === seq);
      if (index === -1) return;
      const [removed] = rows.splice(index, 1);
      removed?.element.remove();
      total = Math.max(0, total - 1);
      if (rows.length === 0 && !hasMore && currentSeq !== null) {
        closeNav();
      }
      refreshChrome();
      syncNav();
    },
  };
  return view;
}
