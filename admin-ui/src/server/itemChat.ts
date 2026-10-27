// The per-item chat that EVERY game shares (spec/server-chat/08-adventure-time.md §5.1;
// extracted verbatim from wyrGame.ts, workspace 00045's mini chat and pop-up). Whatever the item
// is — a would-you-rather card, a globe destination — its conversation looks and behaves the
// same, so each improvement made here reaches every game at once.
//
//   the MINI STRIP   a fixed 60 px row inside the game's pane: this item's last two messages
//                    (plus optimistic echoes), one line each cut with an ellipsis, attachments as
//                    20 px thumbnails/icons, a "Chat N" button. It never changes height, so
//                    nothing above it shifts and nothing spills onto the composer below.
//   the POP-UP       the same chat larger: the item's whole history in the thread's own embedded
//                    bubble renderer, redrawn incrementally (a playing voice note is never cut
//                    off), with the ONE ordinary composer re-parented in (`mountComposer`) so
//                    voice notes, attachments and the draft all work and survive the move.
//
// There is one pop-up for the whole chat view and any number of strips (one per game pane). The
// pop-up closes by its ✕ or the backdrop — NOT by Escape: in this chat Escape is the panic key
// (it locks everything at once, R6).
//
// This module owns only its own DOM and state; the thread supplies the messages and the composer
// through `ItemChatDeps`, so nothing here knows how messages are stored or sent.

import type { Message } from "./api/messages";

/** A message of this item's chat that is still being sent (an optimistic echo). */
export interface ItemChatEcho {
  readonly clientId: string;
  readonly text: string | null;
}

export interface ItemChatDeps {
  readonly document: Document;
  isMine(sender: string): boolean;
  /** This item's chat: confirmed messages belonging to the anchor `seq`, oldest first. */
  gameMessages(seq: number): readonly Message[];
  /** This item's messages still being sent (optimistic echoes). */
  gameEchoes(seq: number): readonly ItemChatEcho[];
  /** A full message bubble (the thread's own renderer, embedded variant) for the pop-up. */
  renderBubble(message: Message): HTMLElement;
  /** Releases a bubble's media before it leaves the DOM. */
  disposeBubble(element: HTMLElement): void;
  /** Puts the ordinary composer into `host` (the pop-up) — `null` returns it to the thread. */
  mountComposer(host: HTMLElement | null): void;
  /** The pop-up opened or closed: the thread adjusts its own layout. */
  onLayoutChange(): void;
  /** Call after any change that may have altered the layout's height. */
  afterChange(): void;
}

export interface MiniStrip {
  /** The strip's DOM: put it in the game's pane. */
  readonly element: HTMLElement;
  /** Binds the strip to the item `seq` (null = none) and redraws it. */
  draw(seq: number | null): void;
}

export interface MiniStripOptions {
  /** The pop-up's heading when this strip opens it (default "Game chat"). */
  readonly popupTitle?: string;
}

export interface ItemChat {
  /** The pop-up chat overlay: put it in the thread view. */
  readonly popup: HTMLElement;
  /** A new mini strip. Every game embeds its own in its own pane; all share the one pop-up. */
  createStrip(options?: MiniStripOptions): MiniStrip;
  /** Opens the pop-up for the item `seq` (re-aims it if it was open for another one). */
  openPopup(seq: number, title: string): void;
  closePopup(): void;
  isPopupOpen(): boolean;
  /** The item the open pop-up is about, or null. */
  popupSeq(): number | null;
  /** Data changed: redraw every strip and the pop-up. */
  refresh(): void;
  /** Lock / wipe: close the pop-up, forget every strip's item. */
  reset(): void;
}

const MINI_COUNT = 2;
const STICK_PX = 40;
const DEFAULT_TITLE = "Game chat";

export function createItemChat(deps: ItemChatDeps): ItemChat {
  const doc = deps.document;

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.setAttribute("data-srv-gesture-boundary", "");
    b.addEventListener("click", onClick);
    return b;
  }

  // -- The pop-up ---------------------------------------------------------------------------

  let popupItem: number | null = null;

  const popup = el("div", "wx-srv-gamepop");
  popup.hidden = true;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", DEFAULT_TITLE);
  const backdrop = el("button", "wx-srv-gamepop-backdrop");
  backdrop.type = "button";
  backdrop.setAttribute("aria-label", "Close the game chat");
  backdrop.addEventListener("click", () => closePopup());
  const sheet = el("div", "wx-srv-gamepop-sheet");
  const popHead = el("div", "wx-srv-gamepop-head");
  const popTitle = el("span", "wx-srv-gamepop-title", DEFAULT_TITLE);
  const popClose = button("wx-srv-gamepop-close", "Close the game chat", "✕", () => closePopup());
  popHead.append(popTitle, popClose);
  const popList = el("div", "wx-srv-gamepop-list");
  const popEmpty = el("p", "wx-srv-gamepop-empty", "No messages about this one yet.");
  const composerSlot = el("div", "wx-srv-gamepop-composer");
  sheet.append(popHead, popList, composerSlot);
  popup.append(backdrop, sheet);
  popList.appendChild(popEmpty);
  const popBubbles = new Map<number, { readonly key: string; readonly element: HTMLElement }>();
  const popEchoes = new Map<string, HTMLElement>();

  // Escape is deliberately NOT a way to close the pop-up: in this chat Escape is the panic key
  // (it locks everything at once, R6), so the pop-up closes by its ✕ or by tapping the backdrop.

  function clearPopList(): void {
    for (const { element } of popBubbles.values()) {
      deps.disposeBubble(element);
      element.remove();
    }
    popBubbles.clear();
    for (const element of popEchoes.values()) element.remove();
    popEchoes.clear();
    popEmpty.hidden = false;
  }

  function bubbleKey(message: Message): string {
    return JSON.stringify([message.text, message.attachments, message.reactions]);
  }

  function drawPopup(): void {
    if (popupItem === null) return;
    const messages = deps.gameMessages(popupItem);
    const echoes = deps.gameEchoes(popupItem);
    const wasNearBottom = popList.scrollHeight - popList.scrollTop - popList.clientHeight <= STICK_PX;
    const wanted = new Set(messages.map((m) => m.seq));
    for (const [id, entry] of popBubbles) {
      if (!wanted.has(id)) {
        deps.disposeBubble(entry.element);
        entry.element.remove();
        popBubbles.delete(id);
      }
    }
    let previous: Element | null = null;
    for (const message of messages) {
      let entry = popBubbles.get(message.seq);
      const key = bubbleKey(message);
      if (entry === undefined || entry.key !== key) {
        // A message whose body changed (a picture finishing, a reaction) is rebuilt; an unchanged
        // one is left alone so a voice note that is playing is never cut off.
        if (entry !== undefined) {
          deps.disposeBubble(entry.element);
          entry.element.remove();
        }
        entry = { key, element: deps.renderBubble(message) };
        popBubbles.set(message.seq, entry);
      }
      const after: ChildNode | null = previous === null ? popList.firstChild : previous.nextSibling;
      if (entry.element !== after) popList.insertBefore(entry.element, after);
      previous = entry.element;
    }
    const echoIds = new Set(echoes.map((e) => e.clientId));
    for (const [id, node] of popEchoes) {
      if (!echoIds.has(id)) {
        node.remove();
        popEchoes.delete(id);
      }
    }
    for (const echo of echoes) {
      let node = popEchoes.get(echo.clientId);
      if (node === undefined) {
        node = el("div", "wx-srv-bubble wx-srv-bubble-mine wx-srv-echo");
        if (echo.text !== null && echo.text !== "") node.appendChild(el("div", "wx-srv-bubble-text", echo.text));
        popEchoes.set(echo.clientId, node);
      }
      popList.appendChild(node);
    }
    popEmpty.hidden = messages.length > 0 || echoes.length > 0;
    if (popEmpty.parentElement !== popList) popList.appendChild(popEmpty);
    if (wasNearBottom) popList.scrollTop = popList.scrollHeight;
  }

  function openPopup(seq: number, title: string): void {
    const wasOpen = popupItem !== null;
    popTitle.textContent = title;
    if (wasOpen && popupItem === seq) return;
    // Already open for another item: re-aim it (its bubbles belong to the old conversation).
    if (wasOpen) clearPopList();
    popupItem = seq;
    if (!wasOpen) {
      popup.hidden = false;
      deps.mountComposer(composerSlot);
    }
    drawPopup();
    popList.scrollTop = popList.scrollHeight;
    deps.onLayoutChange();
  }

  function closePopup(): void {
    if (popupItem === null) return;
    popupItem = null;
    popup.hidden = true;
    deps.mountComposer(null);
    clearPopList();
    deps.onLayoutChange();
  }

  // -- The mini strips ----------------------------------------------------------------------

  const strips: MiniStripImpl[] = [];

  interface MiniStripImpl extends MiniStrip {
    /** Redraws for the item it is bound to (nothing if none). */
    redraw(): void;
  }

  function createStrip(options: MiniStripOptions = {}): MiniStrip {
    const popupTitle = options.popupTitle ?? DEFAULT_TITLE;
    const element = el("div", "wx-srv-game-mini");
    let item: number | null = null;

    function openIt(): void {
      if (item !== null) openPopup(item, popupTitle);
    }

    function line(
      text: string | null,
      sender: string | null,
      attachments: readonly Message["attachments"][number][],
    ): HTMLElement {
      // One fixed-height line per message (cut with an ellipsis, never wrapped), so the strip is
      // the same size whatever was said; the pop-up is where whole messages are read.
      const row = el("button", sender === null ? "wx-srv-game-mini-msg wx-srv-game-mini-mine" : "wx-srv-game-mini-msg");
      (row as HTMLButtonElement).type = "button";
      row.setAttribute("data-srv-gesture-boundary", "");
      row.addEventListener("click", openIt);
      if (sender !== null) row.appendChild(el("span", "wx-srv-game-mini-sender", `${sender}: `));
      if (text !== null && text !== "") row.appendChild(el("span", "wx-srv-game-mini-text", text));
      for (const attachment of attachments) {
        if (attachment.kind === "photo" && attachment.status === "ready") {
          const src = attachment.urls.thumb ?? attachment.urls.full;
          if (src !== undefined) {
            const img = doc.createElement("img");
            img.className = "wx-srv-game-mini-thumb";
            img.src = src;
            img.alt = "";
            row.appendChild(img);
            continue;
          }
        }
        row.appendChild(
          el("span", "wx-srv-game-mini-icon", attachment.kind === "voice" ? "🎤" : attachment.kind === "video" ? "🎞" : "🖼"),
        );
      }
      return row;
    }

    function redraw(): void {
      element.replaceChildren();
      if (item === null) return;
      // The strip: [ up to two one-line messages | Open chat ] — always the same height, so the
      // picture and the controls above never shift and nothing can spill onto the composer.
      const lines = el("div", "wx-srv-game-mini-lines");
      const items: HTMLElement[] = [];
      const confirmed = deps.gameMessages(item);
      const echoes = deps.gameEchoes(item);
      for (const message of confirmed.slice(-MINI_COUNT)) {
        items.push(line(message.text, deps.isMine(message.sender) ? null : message.sender, message.attachments));
      }
      for (const echo of echoes) items.push(line(echo.text, null, []));
      const last = items.slice(-MINI_COUNT);
      if (last.length === 0) {
        const empty = el("button", "wx-srv-game-mini-msg wx-srv-game-mini-empty", "Chat about this one…");
        (empty as HTMLButtonElement).type = "button";
        empty.setAttribute("data-srv-gesture-boundary", "");
        empty.addEventListener("click", openIt);
        lines.appendChild(empty);
      } else {
        for (const entry of last) lines.appendChild(entry);
      }
      const total = confirmed.length + echoes.length;
      const expand = button("wx-srv-game-mini-expand", "Open the game chat", "", openIt);
      expand.append(el("span", "wx-srv-game-mini-expand-label", "Chat"));
      if (total > 0) expand.append(el("span", "wx-srv-game-mini-count", String(total)));
      element.append(lines, expand);
    }

    const strip: MiniStripImpl = {
      element,
      draw(seq) {
        item = seq;
        redraw();
      },
      redraw,
    };
    strips.push(strip);
    return strip;
  }

  function refresh(): void {
    for (const strip of strips) strip.redraw();
    drawPopup();
    deps.afterChange();
  }

  function reset(): void {
    closePopup();
    clearPopList();
    for (const strip of strips) strip.draw(null);
  }

  return {
    popup,
    createStrip,
    openPopup,
    closePopup,
    isPopupOpen: () => popupItem !== null,
    popupSeq: () => popupItem,
    refresh,
    reset,
  };
}
