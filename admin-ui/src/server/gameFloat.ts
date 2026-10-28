// The game's CHAT FAB, FLOATING MESSAGE and QUICK REPLY (decisions/00194; spec/server-chat/
// 08-adventure-time.md §5.1). In a game tab the chat header and the composer are hidden so the game
// has the whole screen; the conversation is reached in three ways, all from this module:
//
//   the FAB             a round chat-bubble button at the bottom-right of the game pane. Tap it for the
//                       item's pop-up chat (`itemChat.ts`). A dot while the other person has written
//                       something this device has not seen.
//   the FLOATING MESSAGE the newest unseen message from the other person, floating at the bottom of the
//                       pane left of the FAB (text clamped to two lines, "+N" when several). It stays
//                       until tapped, dismissed (its ✕ or a swipe down) or its chat is opened — never a
//                       timer. Messages of the main chat float too, labelled "Chat".
//   the QUICK REPLY     tap the floating message and a compact box opens above the tab bar: the message
//                       being answered and the ONE ordinary composer, re-parented in exactly like the
//                       pop-up does (`mountComposer`), so typing, the microphone and Send all work and
//                       the draft survives the move. A send goes to the chat the message came from, then
//                       the box closes.
//
// Each game pane embeds an overlay (`createOverlay`) in a positioned slot that sits above the pane's own
// pinned dock, so the FAB never covers (or is covered by) the game's buttons. There is one quick-reply box
// for the whole chat view (`quick`). The unseen-message rules live in `gameFloatModel.ts`.

import type { Message } from "./api/messages";
import { attachmentLabel, createFloatModel, type FloatModel, type FloatSource, type UnseenMessage } from "./gameFloatModel";
import type { GameTab } from "./gameTabs";
import type { ItemChat } from "./itemChat";

export interface GameFloatDeps {
  readonly document: Document;
  readonly win: Window;
  readonly itemChat: Pick<ItemChat, "openPopup" | "closePopup" | "isPopupOpen" | "popupSeq">;
  /** Which tab shows and which item each game has open. */
  readonly tabs: { activeTab(): GameTab; seqOf(key: "wyr" | "adventure"): number | null };
  /** Puts the ordinary composer into `host` (the quick-reply box) — `null` returns it to the thread. */
  mountComposer(host: HTMLElement | null): void;
  /** Whether a voice note is being recorded (the box must not close under it). */
  isRecording(): boolean;
  /** The tab bar: the box sits above it. */
  readonly tabBar: HTMLElement;
  /** The element the quick-reply box is positioned in (the thread view). */
  readonly host: HTMLElement;
}

export interface OverlayOptions {
  /** The FAB's accessible name. */
  readonly fabLabel: string;
  /** The pop-up's heading. */
  readonly popupTitle: string;
  /** The item this game has open, or null. */
  item(): number | null;
}

export interface GameFloat {
  /** The quick-reply box: put it in the thread view. */
  readonly quick: HTMLElement;
  /** A FAB + floating-message overlay for one game pane; put it in the pane's positioned slot. */
  createOverlay(options: OverlayOptions): HTMLElement;
  /** The other person's message arrived. */
  note(message: Message): void;
  /** A message of this person's own was sent to `source`'s chat. */
  noteSent(source: FloatSource): void;
  /** Where a message sent now goes while the quick-reply box is open: an item's seq, or null for the
   * main chat. `undefined` while it is closed. */
  quickTarget(): FloatSource | undefined;
  /** Closes the quick-reply box (the composer goes home). */
  closeQuick(): void;
  /** The visible tab or the pop-up changed. */
  sync(): void;
  /** Data changed: a message that no longer exists (deleted, wiped) can no longer float. */
  reconcile(exists: (seq: number) => boolean): void;
  /** Lock / wipe: forget everything. */
  reset(): void;
  readonly model: FloatModel;
}

const SWIPE_PX = 32;

export function createGameFloat(deps: GameFloatDeps): GameFloat {
  const doc = deps.document;
  const win = deps.win;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
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

  const model = createFloatModel({
    activeItem() {
      const tab = deps.tabs.activeTab();
      return tab === "chat" ? null : deps.tabs.seqOf(tab);
    },
  });

  // -- The quick-reply box ----------------------------------------------------------------------------

  interface Quick {
    readonly source: FloatSource;
    message: UnseenMessage;
  }
  let quickState: Quick | null = null;

  const quick = el("div", "wx-srv-quick");
  quick.hidden = true;
  quick.setAttribute("role", "dialog");
  quick.setAttribute("aria-label", "Quick reply");
  const quickBackdrop = el("button", "wx-srv-quick-backdrop");
  quickBackdrop.type = "button";
  quickBackdrop.setAttribute("aria-label", "Close the quick reply");
  quickBackdrop.addEventListener("click", () => closeByUser());
  const quickBox = el("div", "wx-srv-quick-box");
  const quickHead = el("div", "wx-srv-quick-head");
  const quickTag = el("span", "wx-srv-quick-tag", "Chat");
  const quickText = el("span", "wx-srv-quick-text");
  const quickClose = button("wx-srv-quick-close", "Close the quick reply", "✕", () => closeByUser());
  quickHead.append(quickTag, quickText, quickClose);
  const quickComposer = el("div", "wx-srv-quick-composer");
  quickBox.append(quickHead, quickComposer);
  quick.append(quickBackdrop, quickBox);

  function describe(message: UnseenMessage): string {
    const text = message.text !== null && message.text !== "" ? message.text : null;
    const label = attachmentLabel(message.attachments);
    return text ?? label ?? "";
  }

  function drawQuickHead(): void {
    if (quickState === null) return;
    quickTag.hidden = quickState.source !== null;
    quickText.textContent = `${quickState.message.sender}: ${describe(quickState.message)}`;
  }

  /** The box sits above the tab bar — or, with the on-screen keyboard up, right above the keyboard. */
  function placeQuick(): void {
    if (quick.hidden) return;
    const viewport = win.visualViewport;
    const hostRect = deps.host.getBoundingClientRect();
    let bottom = deps.tabBar.hidden ? 0 : hostRect.bottom - deps.tabBar.getBoundingClientRect().top;
    if (viewport !== null && viewport !== undefined) {
      const keyboardTop = viewport.offsetTop + viewport.height;
      const hidden = hostRect.bottom - keyboardTop;
      if (hidden > bottom + 1) bottom = hidden;
    }
    quick.style.bottom = `${Math.max(0, Math.round(bottom))}px`;
  }
  const viewportListener = (): void => placeQuick();
  win.visualViewport?.addEventListener("resize", viewportListener);
  win.visualViewport?.addEventListener("scroll", viewportListener);

  function openQuick(message: UnseenMessage): void {
    // The quick reply replaces the pop-up if somehow both were asked for: the composer moves once.
    if (deps.itemChat.isPopupOpen()) deps.itemChat.closePopup();
    const wasOpen = quickState !== null;
    quickState = { source: message.source, message };
    model.markSeen(message.source);
    drawQuickHead();
    if (!wasOpen) {
      quick.hidden = false;
      deps.mountComposer(quickComposer);
    }
    placeQuick();
    redraw();
    quickComposer.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }

  function closeQuick(): void {
    if (quickState === null) return;
    quickState = null;
    quick.hidden = true;
    deps.mountComposer(null);
    redraw();
  }

  /** ✕ or a tap outside: never while a voice note is being recorded (the recording would be lost). */
  function closeByUser(): void {
    if (deps.isRecording()) return;
    closeQuick();
  }

  // -- The overlays -----------------------------------------------------------------------------------

  interface Overlay {
    readonly element: HTMLElement;
    readonly options: OverlayOptions;
    draw(): void;
  }
  const overlays: Overlay[] = [];

  function chatIcon(): SVGElement {
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.9");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
    svg.append(path);
    return svg;
  }

  function createOverlay(options: OverlayOptions): HTMLElement {
    const element = el("div", "wx-srv-float");
    const fab = el("button", "wx-srv-float-fab");
    fab.type = "button";
    fab.setAttribute("data-srv-gesture-boundary", "");
    fab.append(chatIcon());
    const dot = el("span", "wx-srv-float-dot");
    dot.hidden = true;
    fab.append(dot);
    fab.addEventListener("click", () => {
      const item = options.item();
      if (item === null) return;
      // The pop-up takes the composer from the quick reply cleanly: one move, no stop at home.
      if (quickState !== null) {
        quickState = null;
        quick.hidden = true;
      }
      model.markSeen(item);
      deps.itemChat.openPopup(item, options.popupTitle);
      redraw();
    });

    const bubble = el("div", "wx-srv-float-bubble");
    bubble.hidden = true;
    bubble.setAttribute("role", "status");
    bubble.setAttribute("aria-live", "polite");
    const open = el("button", "wx-srv-float-open");
    open.type = "button";
    open.setAttribute("data-srv-gesture-boundary", "");
    const tag = el("span", "wx-srv-float-tag", "Chat");
    const who = el("span", "wx-srv-float-who");
    const body = el("span", "wx-srv-float-text");
    const thumb = doc.createElement("img");
    thumb.className = "wx-srv-float-thumb";
    thumb.alt = "";
    thumb.hidden = true;
    const more = el("span", "wx-srv-float-more");
    open.append(tag, who, body, thumb, more);
    const dismiss = button("wx-srv-float-dismiss", "Dismiss the message", "✕", () => {
      model.markAllSeen();
      redraw();
    });
    bubble.append(open, dismiss);

    // A tap opens the quick reply; a swipe down dismisses (touch-action is none on the bubble, so the
    // page never scrolls under the finger).
    let startY: number | null = null;
    let startX = 0;
    let swiped = false;
    open.addEventListener("pointerdown", (event) => {
      startY = event.clientY;
      startX = event.clientX;
      swiped = false;
    });
    open.addEventListener("pointerup", (event) => {
      if (startY === null) return;
      const dy = event.clientY - startY;
      const dx = event.clientX - startX;
      startY = null;
      if (dy >= SWIPE_PX && Math.abs(dx) < dy) {
        swiped = true;
        model.markAllSeen();
        redraw();
      }
    });
    open.addEventListener("pointercancel", () => {
      startY = null;
    });
    open.addEventListener("click", () => {
      if (swiped) {
        swiped = false;
        return;
      }
      const view = model.floating();
      if (view !== null) openQuick(view.message);
    });

    element.append(bubble, fab);

    function draw(): void {
      const item = options.item();
      const unread = item !== null && model.unreadFor(item);
      dot.hidden = !unread;
      fab.setAttribute("aria-label", unread ? `${options.fabLabel} — new message` : options.fabLabel);
      fab.dataset["unread"] = unread ? "1" : "0";
      const view = deps.tabs.activeTab() === "chat" || deps.itemChat.isPopupOpen() || quickState !== null ? null : model.floating();
      bubble.hidden = view === null;
      if (view === null) return;
      const message = view.message;
      tag.hidden = message.source !== null;
      who.textContent = `${message.sender}: `;
      const text = message.text !== null && message.text !== "" ? message.text : null;
      const label = attachmentLabel(message.attachments);
      body.textContent = text ?? label ?? "";
      const first = message.attachments[0];
      const src = first !== undefined && first.kind === "photo" && first.status === "ready" ? (first.urls.thumb ?? first.urls.full) : undefined;
      thumb.hidden = src === undefined || text !== null;
      if (src !== undefined && thumb.getAttribute("src") !== src) thumb.src = src;
      more.hidden = view.more === 0;
      more.textContent = `+${view.more}`;
      open.setAttribute(
        "aria-label",
        `Reply to ${message.sender}: ${text ?? label ?? "message"}${view.more > 0 ? `, and ${view.more} more` : ""}`,
      );
    }

    const overlay: Overlay = { element, options, draw };
    overlays.push(overlay);
    draw();
    return element;
  }

  function redraw(): void {
    for (const overlay of overlays) overlay.draw();
  }

  // -- Events from the thread ---------------------------------------------------------------------------

  function note(message: Message): void {
    const ref = message.wyrRef ?? null;
    // Shown the moment it arrives: this chat's pop-up is open on it, or the quick reply is open on it.
    if (ref !== null && deps.itemChat.isPopupOpen() && deps.itemChat.popupSeq() === ref) return;
    if (quickState !== null && quickState.source === ref) {
      quickState.message = {
        seq: message.seq,
        source: ref,
        sender: message.sender,
        text: message.text,
        attachments: message.attachments,
      };
      drawQuickHead();
      return;
    }
    if (model.note(message)) redraw();
  }

  function noteSent(source: FloatSource): void {
    if (quickState === null || quickState.source !== source) return;
    if (deps.isRecording()) return;
    closeQuick();
  }

  function sync(): void {
    const tab = deps.tabs.activeTab();
    const item = tab === "chat" ? null : deps.tabs.seqOf(tab);
    if (item === null) {
      model.clear();
      if (quickState !== null) closeQuick();
    } else {
      model.prune();
      // The quick reply is about an item's chat: a new round in the same tab ends it.
      if (quickState !== null && quickState.source !== null && quickState.source !== item) closeQuick();
    }
    redraw();
    placeQuick();
  }

  function reconcile(exists: (seq: number) => boolean): void {
    let changed = false;
    for (const seq of model.seqs()) {
      if (!exists(seq)) {
        model.forget(seq);
        changed = true;
      }
    }
    if (quickState !== null && !exists(quickState.message.seq)) closeQuick();
    else if (changed) redraw();
  }

  function reset(): void {
    model.clear();
    closeQuick();
    redraw();
  }

  return {
    quick,
    createOverlay,
    note,
    noteSent,
    quickTarget: () => (quickState === null ? undefined : quickState.source),
    closeQuick,
    sync,
    reconcile,
    reset,
    model,
  };
}
