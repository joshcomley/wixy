// The game TABS of the Server chat (spec/server-chat/08-adventure-time.md §5.1; extracted from
// wyrGame.ts, workspace 00045, decisions/00184). When a game is opened the chat gets a tab bar at
// the bottom — "Chat" plus one tab per OPEN game, in registration order — and the active game's
// pane takes the thread's place, FULL SCREEN (decisions/00194):
//
//   [ the game's pane, from the very top of the chat view to the tab bar ]
//   [ Chat | WYR | Adventure | Cookout ]            <- this bar (holding Chat + ONE game)
//
// While a game tab shows, the chat header and the chat composer are hidden (the thread does this on
// every layout change, keyed on `activeTab()`): the conversation is reached through the pane's chat
// FAB, floating message and quick reply (`gameFloat.ts`) and the pop-up item chat (`itemChat.ts`).
// The one exception is a call that is not idle, whose controls live in that header (Inv 55).
//
// With only the Chat tab left (no game open) the bar disappears. ONE GAME AT A TIME (operator,
// 2026-10-28: "it would replace the Would You Rather tab… there's only ever two tabs at the bottom"):
// opening or offering a game while ANOTHER game is open closes that other game first, so the bar
// only ever holds Chat plus one game tab.
//
// This module is the FRAME and knows nothing of any particular game: each game registers its own
// pane, tab label and a few callbacks (`GameRegistration`), and the frame decides which pane
// shows, which tab has a dot, what a message sent right now belongs to (`chatTarget`), and when
// the shared pop-up chat (`itemChat.ts`) must close. A game keeps only its per-round view state.

import type { ItemChat } from "./itemChat";

/** A game, or a canvas (decisions/00206): anything that takes the one second tab. */
export type GameKey = "wyr" | "adventure" | "cookout" | "canvas";
export type GameTab = "chat" | GameKey;

export interface GameRegistration {
  readonly key: GameKey;
  /** The tab's visible text ("WYR", "Adventure"). */
  readonly tabLabel: string;
  /** The tab's accessible name ("Would you rather game"). */
  readonly tabAriaLabel: string;
  /** False for an item with no chat of its own (a canvas): while its tab shows, a message sent
   * goes to the main chat. Default true. */
  readonly itemChat?: boolean;
  /** The game's pane; the frame shows it only while this game's tab is the active one. The
   * caller puts it in the thread view (it takes the thread's place). */
  readonly pane: HTMLElement;
  /** Whether the item `seq` still exists (not deleted or wiped); when it does not the frame
   * closes the game. */
  exists(seq: number): boolean;
  /** Redraw the pane for `seq`. Called only while this game's tab is the active one (and the
   * pane's own seq may have changed since the last call: compare, then reset per-item state). */
  refresh(seq: number): void;
  /** The tab was just brought to the front (not on every refresh). */
  onShow?(seq: number): void;
  /** The tab left the front (another tab was chosen). The game stays open. */
  onHide?(): void;
  /** Forget this game's per-item view state: the game was closed, or the chat locked or was
   * wiped. */
  reset(): void;
}

export interface GameTabsDeps {
  readonly document: Document;
  /** The shared pop-up chat: the frame closes it with the game it belongs to, and counts it in
   * `chatTarget`. */
  readonly itemChat: Pick<ItemChat, "isPopupOpen" | "popupSeq" | "closePopup" | "refresh">;
  /** The visible tab, or whether a game is open, changed: the thread adjusts its own layout. */
  onLayoutChange(): void;
  /** Data changed and the visible pane was redrawn: the chat FAB and floating message follow. */
  onRefresh?(): void;
}

export interface GameTabs {
  /** The bottom tab bar (hidden unless a game is open). */
  readonly tabBar: HTMLElement;
  /** Adds a game. Its tab sits in the bar in registration order, appearing once it is opened. */
  register(game: GameRegistration): void;
  /** Opens the game's tab for `seq` and shows it (clears the dismissal of that game). Another game
   * that is open is replaced (see `replaceOthers`). */
  open(key: GameKey, seq: number): void;
  /** An item started elsewhere: the tab appears (with a dot) without taking over the screen. A
   * `seq` the person closed is not offered again. Another game that is open is replaced. */
  offer(key: GameKey, seq: number): void;
  /** Closes the game: its tab goes (the dismissal is remembered), Chat shows if it was active,
   * and the pop-up chat closes if it belonged to it. */
  close(key: GameKey): void;
  showTab(tab: GameTab): void;
  activeTab(): GameTab;
  /** The open item of the game, or null. */
  seqOf(key: GameKey): number | null;
  /** The item a message sent right now belongs to: the active game's item while a game tab is
   * showing, else the pop-up's item while the pop-up is open, else null (the main chat). The quick
   * reply (`gameFloat.ts`) overrides this for as long as it is open — the thread asks it first. */
  chatTarget(): number | null;
  /** The main chat got a message while a game tab is showing: dot the Chat tab. */
  noteChatActivity(): void;
  /** Data changed: redraw what is visible (and close any game whose item is gone). */
  refresh(): void;
  /** Lock / wipe: forget everything — and tell the thread, or a hidden thread never comes back. */
  reset(): void;
}

interface Entry {
  readonly game: GameRegistration;
  readonly button: HTMLButtonElement;
  readonly dotEl: HTMLElement;
  seq: number | null;
  dot: boolean;
  /** The item the person closed; not offered again. */
  dismissed: number | null;
}

export function createGameTabs(deps: GameTabsDeps): GameTabs {
  const doc = deps.document;
  const itemChat = deps.itemChat;

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

  function tabButton(className: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-label", label);
    b.setAttribute("data-srv-gesture-boundary", "");
    b.addEventListener("click", onClick);
    return b;
  }

  // Insertion order of the map = registration order = the order of the tabs.
  const entries = new Map<GameKey, Entry>();
  let active: GameTab = "chat";
  let chatDot = false;

  const tabBar = el("div", "wx-srv-tabs");
  tabBar.setAttribute("role", "tablist");
  tabBar.hidden = true;
  const chatButton = tabButton("wx-srv-tab wx-srv-tab-chat", "Chat", "Chat", () => showTab("chat"));
  const chatDotEl = el("span", "wx-srv-tab-dot");
  chatDotEl.hidden = true;
  chatButton.appendChild(chatDotEl);
  tabBar.appendChild(chatButton);

  function register(game: GameRegistration): void {
    if (entries.has(game.key)) throw new Error(`game "${game.key}" is already registered`);
    const button = tabButton(
      `wx-srv-tab wx-srv-tab-game wx-srv-tab-${game.key}`,
      game.tabAriaLabel,
      game.tabLabel,
      () => showTab(game.key),
    );
    button.setAttribute("data-game", game.key);
    button.hidden = true;
    const dotEl = el("span", "wx-srv-tab-dot");
    dotEl.hidden = true;
    button.appendChild(dotEl);
    tabBar.appendChild(button);
    game.pane.hidden = true;
    entries.set(game.key, { game, button, dotEl, seq: null, dot: false, dismissed: null });
  }

  function activeEntry(): Entry | undefined {
    return active === "chat" ? undefined : entries.get(active);
  }

  // -- State changes ------------------------------------------------------------------------

  function sync(): void {
    let anyOpen = false;
    for (const [key, entry] of entries) {
      const open = entry.seq !== null;
      const on = open && active === key;
      if (open) anyOpen = true;
      entry.button.hidden = !open;
      entry.button.classList.toggle("wx-srv-tab-on", on);
      entry.button.setAttribute("aria-selected", on ? "true" : "false");
      entry.dotEl.hidden = !(open && entry.dot);
      entry.game.pane.hidden = !on;
    }
    tabBar.hidden = !anyOpen;
    chatButton.classList.toggle("wx-srv-tab-on", active === "chat");
    chatButton.setAttribute("aria-selected", active === "chat" ? "true" : "false");
    chatDotEl.hidden = !chatDot;
  }

  function showTab(next: GameTab): void {
    let target: GameTab = next;
    let entry: Entry | undefined;
    if (target !== "chat") {
      entry = entries.get(target);
      if (entry === undefined || entry.seq === null) {
        target = "chat";
        entry = undefined;
      }
    }
    const previous = activeEntry();
    if (previous !== undefined && previous !== entry) previous.game.onHide?.();
    // The pop-up is the chat of one item: it stays only while that item's tab is the one showing.
    if (itemChat.isPopupOpen() && (entry === undefined || itemChat.popupSeq() !== entry.seq)) {
      itemChat.closePopup();
    }
    const changed = active !== target;
    active = target;
    if (entry === undefined) chatDot = false;
    else entry.dot = false;
    sync();
    if (changed && entry !== undefined && entry.seq !== null) entry.game.onShow?.(entry.seq);
    refresh();
    deps.onLayoutChange();
  }

  /**
   * One game at a time: before `key` takes the bar, every OTHER open game is retired — its pop-up
   * closes, its pane hides, its `reset()` runs (so a spin animation, a live relay or an idle-lock
   * suspension it holds stops) and its tab goes. Unlike `close`, no dismissal is recorded: the
   * person did not turn that game away, a newer one simply took its place, and its own card in the
   * chat still opens it again.
   */
  function replaceOthers(key: GameKey): void {
    for (const other of entries.values()) {
      if (other.game.key === key || other.seq === null) continue;
      other.game.reset();
      if (itemChat.isPopupOpen() && itemChat.popupSeq() === other.seq) itemChat.closePopup();
      other.seq = null;
      other.dot = false;
      // Like `close`, `reset()` already stands for "the pane left the screen": no `onHide` on top.
      if (active === other.game.key) {
        active = "chat";
        chatDot = false;
      }
    }
  }

  /** Points a game at another item. The pop-up closes if it was about the old one. */
  function setSeq(entry: Entry, next: number): void {
    if (entry.seq === next) return;
    if (entry.seq !== null && itemChat.isPopupOpen() && itemChat.popupSeq() === entry.seq) {
      itemChat.closePopup();
    }
    entry.seq = next;
  }

  function open(key: GameKey, seq: number): void {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entry.dismissed = null;
    replaceOthers(key);
    setSeq(entry, seq);
    showTab(key);
  }

  function offer(key: GameKey, seq: number): void {
    const entry = entries.get(key);
    if (entry === undefined) return;
    if (entry.dismissed === seq || entry.seq === seq) return;
    replaceOthers(key);
    setSeq(entry, seq);
    if (active !== key) entry.dot = true;
    sync();
    refresh();
    deps.onLayoutChange();
  }

  function close(key: GameKey): void {
    const entry = entries.get(key);
    if (entry === undefined) return;
    const wasActive = active === key;
    entry.game.reset();
    if (entry.seq !== null) {
      if (itemChat.isPopupOpen() && itemChat.popupSeq() === entry.seq) itemChat.closePopup();
      entry.dismissed = entry.seq;
    }
    entry.seq = null;
    entry.dot = false;
    if (wasActive) {
      active = "chat";
      chatDot = false;
    }
    sync();
    deps.onLayoutChange();
  }

  function reset(): void {
    for (const entry of entries.values()) entry.game.reset();
    if (itemChat.isPopupOpen()) itemChat.closePopup();
    for (const entry of entries.values()) {
      entry.seq = null;
      entry.dot = false;
      entry.dismissed = null;
    }
    active = "chat";
    chatDot = false;
    sync();
    // The thread may be hidden for a game tab: a lock or a wipe must give it back, or the
    // chat is blank after the next unlock (decisions/00184, audit round 3 F3).
    deps.onLayoutChange();
  }

  function refresh(): void {
    for (const entry of [...entries.values()]) {
      if (entry.seq !== null && !entry.game.exists(entry.seq)) close(entry.game.key);
    }
    let anyOpen = false;
    for (const entry of entries.values()) if (entry.seq !== null) anyOpen = true;
    if (!anyOpen) return;
    const current = activeEntry();
    if (current !== undefined && current.seq !== null) current.game.refresh(current.seq);
    itemChat.refresh();
    deps.onRefresh?.();
  }

  return {
    tabBar,
    register,
    open,
    offer,
    close,
    showTab,
    activeTab: () => active,
    seqOf: (key) => entries.get(key)?.seq ?? null,
    chatTarget() {
      const current = activeEntry();
      if (current !== undefined && current.seq !== null) return current.game.itemChat === false ? null : current.seq;
      return itemChat.isPopupOpen() ? itemChat.popupSeq() : null;
    },
    noteChatActivity() {
      if (active !== "chat") {
        chatDot = true;
        sync();
      }
    },
    refresh,
    reset,
  };
}
