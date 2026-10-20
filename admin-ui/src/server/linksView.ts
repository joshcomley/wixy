// The Server chat "Links" view (workspace 00052): the ⋯ menu's "Links" opens this full-height
// screen over the thread showing ONLY the messages that contain a web link — the same bubbles,
// newest first, older ones loaded as you scroll. The list is the server's stored link index
// (`GET /messages/links`), so it stays fast however long the chat grows.
//
// Live: a link message that arrives (or changes — a reaction, say) while the screen is open is
// slotted in; a deleted one drops out. Lock behaviour is the thread's: `close()` is called by
// `thread.detach()`/`teardown()`.

import { LINKS_PAGE, getLinkMessages, type LinksPage } from "./api/links";
import { ServerLockedError } from "./api/http";
import type { Message } from "./api/messages";
import { textHasLink } from "./linkify";
import type { LockHooks, ServerSession } from "./types";

export interface LinksDeps {
  readonly document: Document;
  readonly hooks: Pick<LockHooks, "lockNow">;
  readonly getSession: () => ServerSession | null;
  /** The thread's own bubble renderer (embedded form: no menu, same players/links). */
  readonly renderBubble: (message: Message) => HTMLElement;
  /** Releases any media inside a node about to be dropped. */
  readonly disposeMedia: (root: ParentNode) => void;
  /** Injectable for tests; defaults to the real `GET /messages/links`. */
  readonly fetchPage?: (
    session: ServerSession,
    opts: { before?: number; limit?: number },
  ) => Promise<LinksPage>;
}

export interface LinksView {
  readonly element: HTMLElement;
  /** Show the screen below `topOffsetPx` (the chat header's height). */
  open(topOffsetPx: number): void;
  close(): void;
  isOpen(): boolean;
  /** A message arrived or changed in the thread: slot it in if it has a link. */
  messageChanged(message: Message): void;
  messageDeleted(seq: number): void;
}

/** How close (px) to the bottom of the list counts as "wants more". */
const NEAR_BOTTOM_PX = 400;

function errorText(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "Something went wrong.";
}

interface LinkItem {
  message: Message;
  element: HTMLElement;
}

export function createLinksView(deps: LinksDeps): LinksView {
  const { document: doc, hooks } = deps;
  const fetchPage = deps.fetchPage ?? getLinkMessages;

  const root = doc.createElement("div");
  root.className = "wx-srv-links-view";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Messages with links");

  const bar = doc.createElement("div");
  bar.className = "wx-srv-links-bar";
  const title = doc.createElement("span");
  title.className = "wx-srv-links-title";
  title.textContent = "Messages with links";
  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wx-srv-links-close";
  closeButton.setAttribute("data-srv-gesture-boundary", "");
  closeButton.textContent = "Back to chat";
  bar.append(title, closeButton);

  const list = doc.createElement("div");
  list.className = "wx-srv-links-list";
  const empty = doc.createElement("p");
  empty.className = "wx-srv-links-empty";
  empty.textContent = "No messages with links yet.";
  empty.hidden = true;
  const loading = doc.createElement("p");
  loading.className = "wx-srv-links-loading";
  loading.textContent = "Loading…";
  loading.hidden = true;
  const loadError = doc.createElement("p");
  loadError.className = "wx-srv-links-error";
  loadError.hidden = true;
  const more = doc.createElement("button");
  more.type = "button";
  more.className = "wx-srv-links-more";
  more.setAttribute("data-srv-gesture-boundary", "");
  more.textContent = "Show earlier ones";
  more.hidden = true;
  // The messages are inserted before this footer, so it always stays last.
  const footer = doc.createElement("div");
  footer.className = "wx-srv-links-footer";
  footer.append(empty, loading, loadError, more);
  list.appendChild(footer);
  root.append(bar, list);

  /** Newest first. */
  let items: LinkItem[] = [];
  let hasMore = false;
  let loaded = false;
  let busy = false;
  let opened = false;
  /** Bumped on every open/close so a response from an earlier session of the screen is dropped. */
  let generation = 0;

  function refreshChrome(): void {
    empty.hidden = !(loaded && items.length === 0 && loadError.hidden);
    loading.hidden = !busy;
    more.hidden = busy || !(hasMore || !loadError.hidden);
    more.textContent = loadError.hidden ? "Show earlier ones" : "Try again";
  }

  function buildItem(message: Message): LinkItem {
    const element = doc.createElement("div");
    element.className = "wx-srv-links-item";
    element.dataset["messageSeq"] = String(message.seq);
    element.appendChild(deps.renderBubble(message));
    return { message, element };
  }

  /** Puts `message` in its newest-first place, replacing the copy already shown. */
  function place(message: Message): void {
    const existing = items.findIndex((item) => item.message.seq === message.seq);
    const added = buildItem(message);
    if (existing !== -1) {
      const old = items[existing];
      if (old === undefined) return;
      deps.disposeMedia(old.element);
      old.element.replaceWith(added.element);
      items[existing] = added;
      return;
    }
    let index = 0;
    while (index < items.length && (items[index]?.message.seq ?? 0) > message.seq) index += 1;
    list.insertBefore(added.element, items[index]?.element ?? footer);
    items.splice(index, 0, added);
  }

  function dropAll(): void {
    for (const item of items) {
      deps.disposeMedia(item.element);
      item.element.remove();
    }
    items = [];
  }

  async function loadMore(startGeneration: number): Promise<void> {
    if (busy) return;
    const session = deps.getSession();
    if (session === null) return;
    busy = true;
    loadError.hidden = true;
    refreshChrome();
    try {
      const oldest = items[items.length - 1]?.message.seq;
      const page = await fetchPage(session, {
        ...(oldest !== undefined ? { before: oldest } : {}),
        limit: LINKS_PAGE,
      });
      if (generation !== startGeneration) return;
      // The page is ascending; items are newest first.
      for (const message of [...page.messages].reverse()) {
        if (!items.some((item) => item.message.seq === message.seq)) place(message);
      }
      hasMore = page.hasMore && page.messages.length > 0;
      loaded = true;
    } catch (error) {
      if (generation !== startGeneration) return;
      if (error instanceof ServerLockedError) {
        hooks.lockNow("unauthorized");
        return;
      }
      loadError.textContent = errorText(error);
      loadError.hidden = false;
      loaded = true;
    } finally {
      if (generation === startGeneration) {
        busy = false;
        refreshChrome();
      }
    }
  }

  more.addEventListener("click", () => void loadMore(generation));
  list.addEventListener(
    "scroll",
    () => {
      if (!opened || !hasMore || busy || !loadError.hidden) return;
      if (list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX) {
        void loadMore(generation);
      }
    },
    { passive: true },
  );
  closeButton.addEventListener("click", () => view.close());

  const view: LinksView = {
    element: root,
    open(topOffsetPx: number): void {
      if (opened) return;
      opened = true;
      generation += 1;
      hasMore = false;
      loaded = false;
      busy = false;
      loadError.hidden = true;
      dropAll();
      root.style.top = `${topOffsetPx}px`;
      root.hidden = false;
      list.scrollTop = 0;
      refreshChrome();
      void loadMore(generation);
    },
    close(): void {
      if (!opened) return;
      opened = false;
      generation += 1;
      busy = false;
      root.hidden = true;
      dropAll();
    },
    isOpen: () => opened,
    messageChanged(message: Message): void {
      if (!opened || message.viewOnce || !textHasLink(message.text)) return;
      const held = items.some((item) => item.message.seq === message.seq);
      const oldest = items[items.length - 1]?.message.seq;
      // Older than everything shown while more is still to load: it arrives with its page.
      if (!held && hasMore && oldest !== undefined && message.seq < oldest) return;
      place(message);
      refreshChrome();
    },
    messageDeleted(seq: number): void {
      const index = items.findIndex((item) => item.message.seq === seq);
      if (index === -1) return;
      const [removed] = items.splice(index, 1);
      if (removed !== undefined) {
        deps.disposeMedia(removed.element);
        removed.element.remove();
      }
      refreshChrome();
    },
  };
  return view;
}
