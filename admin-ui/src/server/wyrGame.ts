// The would-you-rather GAME TAB (workspace 00045): when a round is opened the chat gets a tab bar
// at the bottom — "Chat" and "WYR" — and the WYR tab shows the round full-height:
//
//   [ title                              Next ▸  × ]
//   [ the picture — tap it to flip between option A and option B ]
//   [ the controls: Play/Skip, pick + guess, Reveal, results ]
//   [ mini chat: this card's last two messages ]      <- tap a message (or a thumbnail) to open
//   [ the chat composer — the ordinary one, now sending into this card ]
//
// The card's chat is kept WITH the card (messages carry `wyrRef`, `wyrSeq` on send) and also lives
// in the main chat. Tapping a mini-chat message opens a pop-up: the same card chat, larger, with
// that card's whole history and the ordinary composer moved into it (voice notes, attachments and
// all). Closing the game closes the tab; with one tab left the bar disappears.
//
// This module owns only the game's own DOM and state; the thread supplies the data and the
// composer through `WyrGameDeps` (so nothing here knows how messages are stored or sent).

import type { Message } from "./api/messages";
import type { WyrView } from "./api/wyr";
import type { WyrControls } from "./wyrControls";
import { wyrPictureUrls } from "./wyrCard";
import type { WyrModel } from "./wyrModel";

export type WyrTab = "chat" | "wyr";

export interface WyrEcho {
  readonly clientId: string;
  readonly text: string | null;
}

export interface WyrGameDeps {
  readonly document: Document;
  readonly model: WyrModel;
  readonly controls: WyrControls;
  isMine(sender: string): boolean;
  /** The round's anchor message, or undefined once it is gone (deleted, wiped). */
  roundMessage(seq: number): Message | undefined;
  /** This card's chat: confirmed messages with `wyrRef === seq`, oldest first. */
  gameMessages(seq: number): readonly Message[];
  /** This card's messages still being sent (optimistic echoes). */
  gameEchoes(seq: number): readonly WyrEcho[];
  /** A full message bubble (the thread's own renderer, embedded variant) for the pop-up. */
  renderBubble(message: Message): HTMLElement;
  /** Releases a bubble's media before it leaves the DOM. */
  disposeBubble(element: HTMLElement): void;
  /** Puts the ordinary composer into `host` (the pop-up) — `null` returns it to the thread. */
  mountComposer(host: HTMLElement | null): void;
  /** Starts the next round (the ⋯ menu's action). */
  startNextRound(): void;
  /** The visible tab, or whether a game exists, changed: the thread adjusts its own layout. */
  onLayoutChange(): void;
  /** Call after any change that may have altered the layout's height. */
  afterChange(): void;
  openLightbox?(source: string, alt: string): void;
}

export interface WyrGame {
  /** The game tab's content — sits in the thread view where the message thread is. */
  readonly pane: HTMLElement;
  /** The bottom tab bar (hidden unless a game is open). */
  readonly tabBar: HTMLElement;
  /** The pop-up game chat overlay. */
  readonly popup: HTMLElement;
  /** Opens the game tab for `seq` and shows it. */
  open(seq: number): void;
  /** A round started elsewhere: the tab appears (with a dot) without taking over the screen. */
  offer(seq: number): void;
  /** Closes the game: the tab goes, the chat is shown. */
  close(): void;
  showTab(tab: WyrTab): void;
  activeTab(): WyrTab;
  /** The open game's round, or null. */
  gameSeq(): number | null;
  /** The round a message sent right now belongs to (the game chat), or null (the main chat). */
  chatTarget(): number | null;
  /** The main chat got a message while the game tab is showing: dot the Chat tab. */
  noteChatActivity(): void;
  /** Data changed: redraw whatever is visible (and close if the round is gone). */
  refresh(): void;
  isPopupOpen(): boolean;
  closePopup(): void;
  /** Lock / wipe: forget everything. */
  reset(): void;
}

const MINI_COUNT = 2;
const STICK_PX = 40;

export function createWyrGame(deps: WyrGameDeps): WyrGame {
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

  let seq: number | null = null;
  let tab: WyrTab = "chat";
  let dismissedSeq: number | null = null;
  let shown: "a" | "b" = "a";
  let wyrDot = false;
  let chatDot = false;
  let popupOpen = false;

  // -- Tab bar ------------------------------------------------------------------------------

  const tabBar = el("div", "wx-srv-tabs");
  tabBar.setAttribute("role", "tablist");
  tabBar.hidden = true;
  const chatTabButton = button("wx-srv-tab wx-srv-tab-chat", "Chat", "Chat", () => showTab("chat"));
  const wyrTabButton = button("wx-srv-tab wx-srv-tab-wyr", "Would you rather game", "WYR", () => showTab("wyr"));
  for (const b of [chatTabButton, wyrTabButton]) b.setAttribute("role", "tab");
  const chatDotEl = el("span", "wx-srv-tab-dot");
  const wyrDotEl = el("span", "wx-srv-tab-dot");
  chatDotEl.hidden = true;
  wyrDotEl.hidden = true;
  chatTabButton.appendChild(chatDotEl);
  wyrTabButton.appendChild(wyrDotEl);
  tabBar.append(chatTabButton, wyrTabButton);

  // -- Game pane ----------------------------------------------------------------------------

  const pane = el("div", "wx-srv-game");
  pane.hidden = true;
  const head = el("div", "wx-srv-game-head");
  const title = el("span", "wx-srv-game-title", "Would you rather…?");
  const nextButton = button("wx-srv-game-next", "Start the next round", "Next ▸", () => deps.startNextRound());
  nextButton.hidden = true;
  const closeButton = button("wx-srv-game-close", "Close the game", "✕", () => close());
  head.append(title, nextButton, closeButton);

  const stage = el("button", "wx-srv-game-stage");
  stage.type = "button";
  stage.setAttribute("data-srv-gesture-boundary", "");
  const imgA = doc.createElement("img");
  imgA.className = "wx-srv-game-img";
  const imgB = doc.createElement("img");
  imgB.className = "wx-srv-game-img";
  const placeholder = el("div", "wx-srv-game-placeholder");
  const chips = el("div", "wx-srv-game-chips");
  const chipA = el("span", "wx-srv-game-chip", "A");
  const chipB = el("span", "wx-srv-game-chip", "B");
  chips.append(chipA, chipB);
  const caption = el("div", "wx-srv-game-caption");
  const captionText = el("span", "wx-srv-game-caption-text");
  const captionPicks = el("span", "wx-srv-game-caption-picks");
  caption.append(captionText, captionPicks);
  stage.append(imgA, imgB, placeholder, chips, caption);
  stage.addEventListener("click", () => {
    shown = shown === "a" ? "b" : "a";
    drawStage();
  });

  const controlsHost = el("div", "wx-srv-game-controls");
  const mini = el("div", "wx-srv-game-mini");
  pane.append(head, stage, controlsHost, mini);

  // -- Pop-up game chat ---------------------------------------------------------------------

  const popup = el("div", "wx-srv-gamepop");
  popup.hidden = true;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Game chat");
  const backdrop = el("button", "wx-srv-gamepop-backdrop");
  backdrop.type = "button";
  backdrop.setAttribute("aria-label", "Close the game chat");
  backdrop.addEventListener("click", () => closePopup());
  const sheet = el("div", "wx-srv-gamepop-sheet");
  const popHead = el("div", "wx-srv-gamepop-head");
  const popTitle = el("span", "wx-srv-gamepop-title", "Game chat");
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

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && popupOpen) closePopup();
  }
  doc.addEventListener("keydown", onKeydown);

  // -- State changes ------------------------------------------------------------------------

  function syncTabs(): void {
    const open = seq !== null;
    tabBar.hidden = !open;
    chatTabButton.classList.toggle("wx-srv-tab-on", tab === "chat");
    wyrTabButton.classList.toggle("wx-srv-tab-on", tab === "wyr");
    chatTabButton.setAttribute("aria-selected", tab === "chat" ? "true" : "false");
    wyrTabButton.setAttribute("aria-selected", tab === "wyr" ? "true" : "false");
    chatDotEl.hidden = !chatDot;
    wyrDotEl.hidden = !wyrDot;
    pane.hidden = !(open && tab === "wyr");
  }

  function showTab(next: WyrTab): void {
    if (seq === null) next = "chat";
    if (next === "chat" && popupOpen) closePopup();
    tab = next;
    if (tab === "wyr") wyrDot = false;
    if (tab === "chat") chatDot = false;
    syncTabs();
    refresh();
    deps.onLayoutChange();
  }

  function setSeq(next: number): void {
    if (seq !== next) {
      if (popupOpen) closePopup();
      seq = next;
      shown = "a";
      clearPopList();
    }
  }

  function open(next: number): void {
    dismissedSeq = null;
    setSeq(next);
    showTab("wyr");
  }

  function offer(next: number): void {
    if (dismissedSeq === next || seq === next) return;
    const wasOpen = seq !== null;
    setSeq(next);
    if (!wasOpen) tab = "chat";
    if (tab !== "wyr") wyrDot = true;
    syncTabs();
    refresh();
    deps.onLayoutChange();
  }

  function close(): void {
    if (popupOpen) closePopup();
    if (seq !== null) dismissedSeq = seq;
    seq = null;
    tab = "chat";
    wyrDot = false;
    chatDot = false;
    clearPopList();
    syncTabs();
    deps.onLayoutChange();
  }

  function reset(): void {
    if (popupOpen) closePopup();
    seq = null;
    tab = "chat";
    dismissedSeq = null;
    wyrDot = false;
    chatDot = false;
    clearPopList();
    syncTabs();
  }

  // -- Drawing ------------------------------------------------------------------------------

  function optionText(view: WyrView, which: "a" | "b"): string {
    return which === "a" ? view.question.a : view.question.b;
  }

  function drawStage(): void {
    if (seq === null) return;
    const view = deps.model.view(seq);
    const message = deps.roundMessage(seq);
    if (view === undefined || message === undefined) return;
    const [urlA, urlB] = wyrPictureUrls(message, "full");
    const url = shown === "a" ? urlA : urlB;
    for (const [img, src] of [[imgA, urlA], [imgB, urlB]] as const) {
      if (src !== null && src !== undefined) {
        if (img.getAttribute("src") !== src) img.src = src;
      } else if (img.hasAttribute("src")) {
        img.removeAttribute("src");
      }
    }
    imgA.classList.toggle("wx-srv-game-img-on", shown === "a" && urlA != null);
    imgB.classList.toggle("wx-srv-game-img-on", shown === "b" && urlB != null);
    const waiting = view.images === "pending" && view.state !== "skipped";
    placeholder.hidden = url != null;
    if (url == null) {
      placeholder.className = `wx-srv-game-placeholder${waiting ? " wx-srv-game-placeholder-loading" : ""}`;
      placeholder.textContent = waiting ? "Painting…" : optionText(view, shown);
    }
    chipA.classList.toggle("wx-srv-game-chip-on", shown === "a");
    chipB.classList.toggle("wx-srv-game-chip-on", shown === "b");
    captionText.textContent = optionText(view, shown);
    // A text-only round already shows the option as the big text: no second copy in the caption.
    captionText.hidden = url == null && !waiting;
    let picks = "";
    if (view.result !== null) {
      const names = view.result.players
        .filter((p) => p.choice === shown)
        .map((p) => (view.you !== null && p.name === view.players[view.you.slot - 1]?.name ? "You" : p.name));
      picks = names.length > 0 ? `Picked by ${names.join(" and ")}` : "";
    }
    captionPicks.textContent = picks;
    stage.setAttribute("aria-label", `Option ${shown.toUpperCase()}: ${optionText(view, shown)}. Tap to see the other one.`);
  }

  function miniItem(text: string | null, sender: string | null, attachments: readonly Message["attachments"][number][]): HTMLElement {
    const row = el("button", "wx-srv-game-mini-msg");
    (row as HTMLButtonElement).type = "button";
    row.setAttribute("data-srv-gesture-boundary", "");
    row.addEventListener("click", () => openPopup());
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

  function drawMini(): void {
    mini.replaceChildren();
    if (seq === null) return;
    const items: HTMLElement[] = [];
    const confirmed = deps.gameMessages(seq);
    const echoes = deps.gameEchoes(seq);
    for (const message of confirmed.slice(-MINI_COUNT)) {
      items.push(miniItem(message.text, deps.isMine(message.sender) ? null : message.sender, message.attachments));
    }
    for (const echo of echoes) items.push(miniItem(echo.text, null, []));
    const last = items.slice(-MINI_COUNT);
    if (last.length === 0) {
      const empty = el("button", "wx-srv-game-mini-msg wx-srv-game-mini-empty", "Chat about this one…");
      (empty as HTMLButtonElement).type = "button";
      empty.setAttribute("data-srv-gesture-boundary", "");
      empty.addEventListener("click", () => openPopup());
      mini.appendChild(empty);
    } else {
      for (const item of last) mini.appendChild(item);
    }
    const expand = button("wx-srv-game-mini-expand", "Open the game chat", "⤢", () => openPopup());
    mini.appendChild(expand);
  }

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
    if (seq === null || !popupOpen) return;
    const messages = deps.gameMessages(seq);
    const echoes = deps.gameEchoes(seq);
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

  function openPopup(): void {
    if (seq === null || popupOpen) return;
    popupOpen = true;
    popup.hidden = false;
    deps.mountComposer(composerSlot);
    drawPopup();
    popList.scrollTop = popList.scrollHeight;
    deps.onLayoutChange();
  }

  function closePopup(): void {
    if (!popupOpen) return;
    popupOpen = false;
    popup.hidden = true;
    deps.mountComposer(null);
    clearPopList();
    deps.onLayoutChange();
  }

  function refresh(): void {
    if (seq === null) return;
    if (deps.roundMessage(seq) === undefined) {
      close();
      return;
    }
    const view = deps.model.view(seq);
    if (view !== undefined) {
      popTitle.textContent = "Game chat";
      nextButton.hidden = !(view.state === "revealed" || view.state === "skipped");
      title.textContent = "Would you rather…?";
    }
    if (tab === "wyr") {
      if (view !== undefined) {
        deps.controls.render(controlsHost, seq, view);
        controlsHost.hidden = false;
      } else {
        controlsHost.replaceChildren(el("p", "wx-srv-wyr-status", "Loading…"));
      }
      drawStage();
      drawMini();
    }
    drawPopup();
    deps.afterChange();
  }

  return {
    pane,
    tabBar,
    popup,
    open,
    offer,
    close,
    showTab,
    activeTab: () => tab,
    gameSeq: () => seq,
    chatTarget: () => (seq !== null && (tab === "wyr" || popupOpen) ? seq : null),
    noteChatActivity() {
      if (seq !== null && tab === "wyr") {
        chatDot = true;
        syncTabs();
      }
    },
    refresh,
    isPopupOpen: () => popupOpen,
    closePopup,
    reset,
  };
}
