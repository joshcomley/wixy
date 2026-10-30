import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGameTabs,
  type GameKey,
  type GameRegistration,
  type GameTabs,
  type GameTabsDeps,
} from "../src/server/gameTabs";
import { createItemChat } from "../src/server/itemChat";

// The shared game frame (gameTabs.ts): the bottom tab bar, which pane shows, dots, dismissals and
// where a message goes. Two fake games stand in for WYR and Adventure; the pop-up chat is a fake
// whose open item the tests set directly (its real behaviour is serverItemChat.test.ts).

interface FakePopup {
  isPopupOpen(): boolean;
  popupSeq(): number | null;
  closePopup: ReturnType<typeof vi.fn<() => void>>;
  refresh: ReturnType<typeof vi.fn<() => void>>;
  /** Test control: the pop-up is open for this item. */
  openFor(seq: number): void;
}

function fakePopup(): FakePopup {
  let item: number | null = null;
  return {
    isPopupOpen: () => item !== null,
    popupSeq: () => item,
    closePopup: vi.fn<() => void>(() => {
      item = null;
    }),
    refresh: vi.fn<() => void>(),
    openFor(seq) {
      item = seq;
    },
  };
}

interface FakeGame extends GameRegistration {
  exists: ReturnType<typeof vi.fn<(seq: number) => boolean>>;
  refresh: ReturnType<typeof vi.fn<(seq: number) => void>>;
  onShow: ReturnType<typeof vi.fn<(seq: number) => void>>;
  onHide: ReturnType<typeof vi.fn<() => void>>;
  reset: ReturnType<typeof vi.fn<() => void>>;
}

function fakeGame(key: GameKey, label: string): FakeGame {
  const pane = document.createElement("div");
  pane.className = `fake-pane fake-pane-${key}`;
  return {
    key,
    tabLabel: label,
    tabAriaLabel: `${label} game`,
    pane,
    exists: vi.fn<(seq: number) => boolean>(() => true),
    refresh: vi.fn<(seq: number) => void>(),
    onShow: vi.fn<(seq: number) => void>(),
    onHide: vi.fn<() => void>(),
    reset: vi.fn<() => void>(),
  };
}

interface Harness {
  tabs: GameTabs;
  popup: FakePopup;
  layout: ReturnType<typeof vi.fn>;
  wyr: FakeGame;
  adventure: FakeGame;
  cookout: FakeGame;
}

function make(register: readonly GameKey[] = ["wyr", "adventure", "cookout"]): Harness {
  const popup = fakePopup();
  const layout = vi.fn();
  const deps: GameTabsDeps = { document, itemChat: popup, onLayoutChange: layout };
  const tabs = createGameTabs(deps);
  const wyr = fakeGame("wyr", "WYR");
  const adventure = fakeGame("adventure", "Adventure");
  const cookout = fakeGame("cookout", "Cookout");
  for (const game of [wyr, adventure, cookout]) if (register.includes(game.key)) tabs.register(game);
  document.body.append(tabs.tabBar, wyr.pane, adventure.pane, cookout.pane);
  return { tabs, popup, layout, wyr, adventure, cookout };
}

/** The visible tab buttons' texts (without the dots), in bar order. */
function visibleTabs(tabs: GameTabs): string[] {
  return [...tabs.tabBar.querySelectorAll<HTMLButtonElement>(".wx-srv-tab")]
    .filter((b) => !b.hidden)
    .map((b) => b.firstChild?.textContent ?? "");
}

function dotted(tabs: GameTabs, selector: string): boolean {
  return tabs.tabBar.querySelector(`${selector} .wx-srv-tab-dot:not([hidden])`) !== null;
}

afterEach(() => document.body.replaceChildren());

describe("game tabs: the bar", () => {
  it("is hidden with only the Chat tab; opening a game shows the bar, its tab and its pane", () => {
    const h = make();
    expect(h.tabs.tabBar.hidden).toBe(true);
    expect(h.wyr.pane.hidden).toBe(true);
    expect(h.adventure.pane.hidden).toBe(true);
    expect(h.tabs.activeTab()).toBe("chat");
    h.tabs.open("wyr", 7);
    expect(h.tabs.tabBar.hidden).toBe(false);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "WYR"]);
    expect(h.tabs.activeTab()).toBe("wyr");
    expect(h.wyr.pane.hidden).toBe(false);
    expect(h.adventure.pane.hidden).toBe(true);
  });

  it("is a tablist of tabs: roles, accessible names, selection, and the generic and per-game classes", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    expect(h.tabs.tabBar.getAttribute("role")).toBe("tablist");
    const chat = h.tabs.tabBar.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!;
    const wyr = h.tabs.tabBar.querySelector<HTMLButtonElement>(".wx-srv-tab-wyr")!;
    expect(chat.getAttribute("role")).toBe("tab");
    expect(wyr.getAttribute("role")).toBe("tab");
    expect(chat.getAttribute("aria-label")).toBe("Chat");
    expect(wyr.getAttribute("aria-label")).toBe("WYR game");
    expect(wyr.classList.contains("wx-srv-tab-game")).toBe(true);
    expect(wyr.dataset["game"]).toBe("wyr");
    expect(wyr.getAttribute("aria-selected")).toBe("true");
    expect(chat.getAttribute("aria-selected")).toBe("false");
    expect(wyr.classList.contains("wx-srv-tab-on")).toBe(true);
    h.tabs.showTab("chat");
    expect(chat.getAttribute("aria-selected")).toBe("true");
    expect(wyr.getAttribute("aria-selected")).toBe("false");
  });

  it("holds Chat and ONE game tab: the open game's pane shows only while its tab is the active one", () => {
    const h = make();
    h.tabs.open("adventure", 30);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Adventure"]);
    expect(h.tabs.activeTab()).toBe("adventure");
    expect(h.adventure.pane.hidden).toBe(false);
    expect(h.wyr.pane.hidden).toBe(true);
    h.tabs.showTab("chat");
    expect(h.adventure.pane.hidden).toBe(true);
    expect(h.tabs.seqOf("adventure")).toBe(30);
    h.tabs.showTab("adventure");
    expect(h.adventure.pane.hidden).toBe(false);
  });

  it("a tab button switches to its game; asking for a game that is not open shows Chat", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.tabBar.querySelector<HTMLButtonElement>(".wx-srv-tab-chat")!.click();
    expect(h.tabs.activeTab()).toBe("chat");
    h.tabs.tabBar.querySelector<HTMLButtonElement>(".wx-srv-tab-wyr")!.click();
    expect(h.tabs.activeTab()).toBe("wyr");
    h.tabs.showTab("adventure"); // not open
    expect(h.tabs.activeTab()).toBe("chat");
  });

  it("registering the same game twice is a programming error", () => {
    const h = make(["wyr"]);
    expect(() => h.tabs.register(fakeGame("wyr", "again"))).toThrow(/already registered/);
  });

  it("opening or offering a game that was never registered does nothing", () => {
    const h = make(["wyr"]);
    h.tabs.open("adventure", 30);
    h.tabs.offer("adventure", 30);
    h.tabs.close("adventure");
    expect(h.tabs.seqOf("adventure")).toBeNull();
    expect(h.tabs.tabBar.hidden).toBe(true);
  });
});

describe("game tabs: offer, dots and dismissal", () => {
  it("an offered item adds its tab with a dot but leaves the chat showing", () => {
    const h = make();
    h.tabs.offer("wyr", 7);
    expect(h.tabs.tabBar.hidden).toBe(false);
    expect(h.tabs.activeTab()).toBe("chat");
    expect(h.wyr.pane.hidden).toBe(true);
    expect(dotted(h.tabs, ".wx-srv-tab-wyr")).toBe(true);
    expect(h.wyr.refresh).not.toHaveBeenCalled(); // its pane is not on screen
    h.tabs.showTab("wyr");
    expect(dotted(h.tabs, ".wx-srv-tab-wyr")).toBe(false);
    expect(h.wyr.onShow).toHaveBeenCalledWith(7);
  });

  it("an offered game's dot is cleared only by showing it, and a newer offer dots it again", () => {
    const h = make();
    h.tabs.offer("adventure", 30);
    expect(dotted(h.tabs, ".wx-srv-tab-adventure")).toBe(true);
    h.tabs.showTab("adventure");
    expect(dotted(h.tabs, ".wx-srv-tab-adventure")).toBe(false);
    h.tabs.showTab("chat");
    h.tabs.offer("adventure", 31); // a new item for a game that is not showing: dotted again
    expect(dotted(h.tabs, ".wx-srv-tab-adventure")).toBe(true);
    expect(h.tabs.activeTab()).toBe("chat"); // an offer never takes over the screen
    expect(h.tabs.seqOf("adventure")).toBe(31);
  });

  it("offering the item that is already open, or a new item of the showing game, adds no dot", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.offer("wyr", 7);
    expect(dotted(h.tabs, ".wx-srv-tab-wyr")).toBe(false);
    h.tabs.offer("wyr", 9); // someone started the next round while I am looking at the game
    expect(h.tabs.seqOf("wyr")).toBe(9);
    expect(dotted(h.tabs, ".wx-srv-tab-wyr")).toBe(false);
    expect(h.tabs.activeTab()).toBe("wyr");
    expect(h.wyr.refresh).toHaveBeenLastCalledWith(9);
  });

  it("a closed item is not offered again, but a different one is, and open() always reopens it", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.close("wyr");
    h.tabs.offer("wyr", 7);
    expect(h.tabs.seqOf("wyr")).toBeNull();
    expect(h.tabs.tabBar.hidden).toBe(true);
    h.tabs.offer("wyr", 8);
    expect(h.tabs.seqOf("wyr")).toBe(8);
    h.tabs.close("wyr");
    h.tabs.open("wyr", 7); // tapping the card always reopens it, dismissed or not
    expect(h.tabs.seqOf("wyr")).toBe(7);
    h.tabs.close("wyr"); // ...and closing it again dismisses it again
    h.tabs.offer("wyr", 7);
    expect(h.tabs.seqOf("wyr")).toBeNull();
  });

  it("a dismissal belongs to its game and its item", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.close("wyr");
    h.tabs.offer("adventure", 7); // the same number in another game is another item
    expect(h.tabs.seqOf("adventure")).toBe(7);
  });

  it("main-chat activity dots the Chat tab only while a game tab is showing", () => {
    const h = make();
    h.tabs.noteChatActivity();
    expect(dotted(h.tabs, ".wx-srv-tab-chat")).toBe(false);
    h.tabs.open("wyr", 7);
    h.tabs.noteChatActivity();
    expect(dotted(h.tabs, ".wx-srv-tab-chat")).toBe(true);
    h.tabs.showTab("chat");
    expect(dotted(h.tabs, ".wx-srv-tab-chat")).toBe(false);
  });
});

describe("game tabs: close", () => {
  it("removes the tab, hides the pane, shows Chat, forgets the game's view and tells the thread", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.layout.mockClear();
    h.tabs.close("wyr");
    expect(visibleTabs(h.tabs)).toEqual(["Chat"]);
    expect(h.tabs.tabBar.hidden).toBe(true);
    expect(h.wyr.pane.hidden).toBe(true);
    expect(h.tabs.activeTab()).toBe("chat");
    expect(h.tabs.seqOf("wyr")).toBeNull();
    expect(h.wyr.reset).toHaveBeenCalledTimes(1);
    expect(h.layout).toHaveBeenCalled();
  });

  it("closing the game that replaced another leaves the bar hidden and Chat showing", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.open("adventure", 30);
    h.tabs.close("adventure");
    expect(h.tabs.tabBar.hidden).toBe(true);
    expect(visibleTabs(h.tabs)).toEqual(["Chat"]);
    expect(h.tabs.activeTab()).toBe("chat");
    expect(h.tabs.seqOf("wyr")).toBeNull(); // the replaced game does not come back by itself
  });

  it("closing an offered game that is not showing leaves the active tab and the Chat dot alone", () => {
    const h = make();
    h.tabs.offer("adventure", 30);
    h.tabs.showTab("chat");
    h.tabs.noteChatActivity(); // no game tab showing: no Chat dot
    h.tabs.close("adventure");
    expect(h.tabs.activeTab()).toBe("chat");
    expect(dotted(h.tabs, ".wx-srv-tab-chat")).toBe(false);
  });

  it("closing a game closes the pop-up chat when it belonged to that game, and only then", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.offer("adventure", 30);
    h.popup.openFor(30); // somehow open for the other game's item
    h.tabs.close("wyr");
    expect(h.popup.closePopup).not.toHaveBeenCalled();
    h.popup.closePopup.mockClear();
    h.tabs.open("adventure", 30);
    h.popup.openFor(30);
    h.tabs.close("adventure");
    expect(h.popup.closePopup).toHaveBeenCalledTimes(1);
  });

  it("closes a game whose item has vanished (deleted or wiped) on the next refresh", () => {
    const h = make();
    h.tabs.open("adventure", 30);
    h.adventure.exists.mockReturnValue(false);
    h.tabs.refresh();
    expect(h.tabs.seqOf("adventure")).toBeNull();
    expect(h.tabs.activeTab()).toBe("chat");
    expect(h.tabs.tabBar.hidden).toBe(true);
    expect(h.adventure.reset).toHaveBeenCalledTimes(1);
  });
});

describe("game tabs: which chat a message belongs to", () => {
  it("is the showing game's item; Chat and no game mean the main chat", () => {
    const h = make();
    expect(h.tabs.chatTarget()).toBeNull();
    h.tabs.open("wyr", 7);
    expect(h.tabs.chatTarget()).toBe(7);
    h.tabs.open("adventure", 30); // replaces WYR: the target moves to the new game's item
    expect(h.tabs.chatTarget()).toBe(30);
    h.tabs.showTab("chat");
    expect(h.tabs.chatTarget()).toBeNull();
    h.tabs.showTab("adventure");
    expect(h.tabs.chatTarget()).toBe(30);
    h.tabs.close("adventure");
    expect(h.tabs.chatTarget()).toBeNull();
  });

  it("an item with no chat of its own (a canvas, decisions/00206) is never a target: its tab sends to the main chat", () => {
    const h = make();
    const canvas: GameRegistration = { ...fakeGame("canvas", "Canvas"), itemChat: false };
    h.tabs.register(canvas);
    h.tabs.open("canvas", 12);
    expect(h.tabs.activeTab()).toBe("canvas");
    expect(h.tabs.chatTarget()).toBeNull();
    // One second tab: a game replaces the canvas and becomes the target as usual, and back again.
    h.tabs.open("wyr", 7);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "WYR"]);
    expect(h.tabs.chatTarget()).toBe(7);
    h.tabs.open("canvas", 12);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Canvas"]);
    expect(h.tabs.chatTarget()).toBeNull();
  });

  it("an offered (not showing) game is not a target", () => {
    const h = make();
    h.tabs.offer("wyr", 7);
    expect(h.tabs.chatTarget()).toBeNull();
  });

  it("the showing game wins over the pop-up; with Chat showing an open pop-up is the target", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.popup.openFor(99);
    expect(h.tabs.chatTarget()).toBe(7);
    h.tabs.showTab("chat"); // a stale pop-up is closed by the switch, so re-open it for the check
    h.popup.openFor(99);
    expect(h.tabs.chatTarget()).toBe(99);
  });
});

describe("game tabs: the pop-up follows the tab", () => {
  it("leaving a game's tab closes its pop-up; staying on it does not", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.popup.openFor(7);
    h.tabs.showTab("wyr");
    expect(h.popup.closePopup).not.toHaveBeenCalled();
    h.tabs.showTab("chat");
    expect(h.popup.closePopup).toHaveBeenCalledTimes(1);
  });

  it("a game replaced by another takes its pop-up chat with it", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.popup.openFor(7);
    h.tabs.open("adventure", 30);
    expect(h.popup.closePopup).toHaveBeenCalledTimes(1);
    expect(h.popup.isPopupOpen()).toBe(false);
  });

  it("pointing a game at another item closes the pop-up of the old one", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.popup.openFor(7);
    h.tabs.open("wyr", 9);
    expect(h.popup.closePopup).toHaveBeenCalledTimes(1);
    expect(h.tabs.seqOf("wyr")).toBe(9);
  });
});

describe("game tabs: refresh and the game callbacks", () => {
  it("refreshes the open game's pane only while its tab shows, and the shared item chat once", () => {
    const h = make();
    h.tabs.open("adventure", 30);
    h.adventure.refresh.mockClear();
    h.popup.refresh.mockClear();
    h.tabs.refresh();
    expect(h.adventure.refresh).toHaveBeenCalledTimes(1);
    expect(h.adventure.refresh).toHaveBeenCalledWith(30);
    expect(h.wyr.refresh).not.toHaveBeenCalled();
    expect(h.popup.refresh).toHaveBeenCalledTimes(1);
    h.tabs.showTab("chat");
    h.adventure.refresh.mockClear();
    h.tabs.refresh(); // Chat shows: the pane is not on screen, nothing to redraw
    expect(h.adventure.refresh).not.toHaveBeenCalled();
  });

  it("does nothing when no game is open", () => {
    const h = make();
    h.tabs.refresh();
    expect(h.popup.refresh).not.toHaveBeenCalled();
    expect(h.wyr.refresh).not.toHaveBeenCalled();
  });

  it("onShow when a tab comes to the front, onHide when it leaves — not when it is shown again", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    expect(h.wyr.onShow).toHaveBeenCalledTimes(1);
    h.tabs.showTab("wyr");
    expect(h.wyr.onShow).toHaveBeenCalledTimes(1);
    expect(h.wyr.onHide).not.toHaveBeenCalled();
    h.tabs.showTab("chat");
    expect(h.wyr.onHide).toHaveBeenCalledTimes(1);
    h.tabs.showTab("wyr");
    expect(h.wyr.onShow).toHaveBeenCalledTimes(2);
    // A game replaced by another is reset (which stands for "hidden"), not also hidden.
    h.tabs.open("adventure", 30);
    expect(h.wyr.reset).toHaveBeenCalledTimes(1);
    expect(h.wyr.onHide).toHaveBeenCalledTimes(1);
    expect(h.adventure.onShow).toHaveBeenCalledWith(30);
    h.tabs.showTab("chat");
    expect(h.adventure.onHide).toHaveBeenCalledTimes(1);
  });

  it("showing a tab, opening, offering and closing all tell the thread to re-lay-out", () => {
    const h = make();
    for (const act of [
      () => h.tabs.open("wyr", 7),
      () => h.tabs.showTab("chat"),
      () => h.tabs.offer("adventure", 30),
      () => h.tabs.close("wyr"),
    ]) {
      h.layout.mockClear();
      act();
      expect(h.layout).toHaveBeenCalled();
    }
  });
});

describe("game tabs: reset (lock or wipe)", () => {
  it("forgets every game, the dots and the dismissals, closes the pop-up, and tells the thread", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.close("wyr"); // a dismissal to forget
    h.tabs.open("adventure", 31);
    h.tabs.noteChatActivity();
    h.popup.openFor(31);
    h.layout.mockClear();
    h.tabs.reset();
    expect(h.adventure.reset).toHaveBeenCalled();
    expect(h.popup.closePopup).toHaveBeenCalled();
    expect(h.tabs.seqOf("wyr")).toBeNull();
    expect(h.tabs.seqOf("adventure")).toBeNull();
    expect(h.tabs.activeTab()).toBe("chat");
    expect(h.tabs.tabBar.hidden).toBe(true);
    expect(h.wyr.pane.hidden).toBe(true);
    expect(h.adventure.pane.hidden).toBe(true);
    expect(dotted(h.tabs, ".wx-srv-tab-chat")).toBe(false);
    // A hidden thread must come back (decisions/00184, audit round 3 F3): the layout hook runs.
    expect(h.layout).toHaveBeenCalled();
    h.tabs.offer("wyr", 7); // the dismissed item is offerable again
    expect(h.tabs.seqOf("wyr")).toBe(7);
  });

  it("tells the thread even when nothing was open", () => {
    const h = make();
    h.tabs.reset();
    expect(h.layout).toHaveBeenCalledTimes(1);
  });
});

describe("game tabs: one game at a time (spec 08 5.1, operator 2026-10-28)", () => {
  it("opening a game while another is open closes the other first: pane hidden, reset run, tab gone", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    expect(h.wyr.pane.hidden).toBe(false);
    h.layout.mockClear();
    h.tabs.open("adventure", 30);
    expect(h.wyr.reset).toHaveBeenCalledTimes(1);
    expect(h.wyr.pane.hidden).toBe(true);
    expect(h.tabs.seqOf("wyr")).toBeNull();
    expect(h.tabs.seqOf("adventure")).toBe(30);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Adventure"]); // only ever Chat + one game tab
    expect(h.tabs.activeTab()).toBe("adventure");
    expect(h.adventure.pane.hidden).toBe(false);
    expect(h.adventure.onShow).toHaveBeenCalledWith(30);
    expect(h.layout).toHaveBeenCalled();
    // ...and the other way round.
    h.tabs.open("wyr", 8);
    expect(h.adventure.reset).toHaveBeenCalledTimes(1);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "WYR"]);
    expect(h.adventure.pane.hidden).toBe(true);
  });

  it("opening a game replaces the other whether or not it was the tab showing", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.showTab("chat"); // WYR is open but Chat shows
    h.tabs.open("adventure", 30);
    expect(h.wyr.reset).toHaveBeenCalledTimes(1);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Adventure"]);
    expect(h.tabs.activeTab()).toBe("adventure");
  });

  it("offering a game replaces the open one too; the offered tab appears with a dot and does not take over", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.offer("adventure", 30);
    expect(h.wyr.reset).toHaveBeenCalledTimes(1);
    expect(h.wyr.pane.hidden).toBe(true);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Adventure"]);
    expect(dotted(h.tabs, ".wx-srv-tab-adventure")).toBe(true);
    expect(h.tabs.activeTab()).toBe("chat"); // the showing game was retired; the screen falls back to Chat
    expect(h.adventure.pane.hidden).toBe(true);
    expect(h.tabs.chatTarget()).toBeNull();
  });

  it("the replaced game's pop-up chat closes, its pane showing or not", () => {
    const h = make();
    h.tabs.offer("wyr", 7);
    h.popup.openFor(7);
    h.tabs.open("adventure", 30);
    expect(h.popup.closePopup).toHaveBeenCalledTimes(1);
  });

  it("records NO dismissal: the replaced round can be offered and opened again", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.open("adventure", 30); // replaces WYR 7
    h.tabs.offer("wyr", 7); // not dismissed, so it is offerable (and, again, replaces the adventure)
    expect(h.tabs.seqOf("wyr")).toBe(7);
    expect(h.tabs.seqOf("adventure")).toBeNull();
    // A dismissal is still recorded by an explicit close, though.
    h.tabs.close("wyr");
    h.tabs.offer("wyr", 7);
    expect(h.tabs.seqOf("wyr")).toBeNull();
  });

  it("does not call onHide on the replaced game (its reset already stands for it) and leaves other dots alone", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.wyr.onHide.mockClear();
    h.tabs.open("adventure", 30);
    expect(h.wyr.onHide).not.toHaveBeenCalled();
    expect(dotted(h.tabs, ".wx-srv-tab-wyr")).toBe(false);
    expect(dotted(h.tabs, ".wx-srv-tab-adventure")).toBe(false);
  });

  it("pointing the SAME game at another item retires nothing", () => {
    const h = make();
    h.tabs.open("adventure", 30);
    h.tabs.offer("adventure", 31);
    h.tabs.open("adventure", 32);
    expect(h.adventure.reset).not.toHaveBeenCalled();
    expect(h.wyr.reset).not.toHaveBeenCalled();
    expect(h.tabs.seqOf("adventure")).toBe(32);
  });

  it("a Chat dot from the retired game does not outlive the replacement", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.noteChatActivity(); // WYR shows: Chat is dotted
    expect(dotted(h.tabs, ".wx-srv-tab-chat")).toBe(true);
    h.tabs.open("adventure", 30); // the new game is shown: Chat's dot is cleared by showing a tab
    expect(dotted(h.tabs, ".wx-srv-tab-chat")).toBe(false);
  });
});

describe("game tabs with the real item chat", () => {
  it("the open pop-up is the chat target and closes with its game, handing the composer back", () => {
    const composer = document.createElement("div");
    const mounts: (HTMLElement | null)[] = [];
    const layout = vi.fn();
    const itemChat = createItemChat({
      document,
      gameMessages: () => [],
      gameEchoes: () => [],
      renderBubble: () => document.createElement("div"),
      disposeBubble: () => {},
      mountComposer: (host) => {
        mounts.push(host);
        if (host !== null) host.appendChild(composer);
      },
      onLayoutChange: layout,
      afterChange: () => {},
    });
    const tabs = createGameTabs({ document, itemChat, onLayoutChange: layout });
    const game = fakeGame("wyr", "WYR");
    tabs.register(game);
    document.body.append(tabs.tabBar, game.pane, itemChat.popup);
    tabs.open("wyr", 7);
    itemChat.openPopup(7, "Game chat");
    expect(tabs.chatTarget()).toBe(7);
    expect(itemChat.popup.contains(composer)).toBe(true);
    tabs.close("wyr");
    expect(itemChat.isPopupOpen()).toBe(false);
    expect(mounts[mounts.length - 1]).toBeNull();
    expect(tabs.chatTarget()).toBeNull();
  });
});

describe("game tabs: Cookout is the third game (spec 09 5.1)", () => {
  it("GameKey admits wyr, adventure and cookout, and Cookout registers like the others", () => {
    const keys: GameKey[] = ["wyr", "adventure", "cookout"];
    const h = make(keys);
    h.tabs.open("cookout", 50);
    expect(h.tabs.seqOf("cookout")).toBe(50);
    expect(h.tabs.activeTab()).toBe("cookout");
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Cookout"]);
    const tab = h.tabs.tabBar.querySelector<HTMLButtonElement>(".wx-srv-tab-cookout");
    expect(tab?.dataset["game"]).toBe("cookout");
    expect(tab?.getAttribute("aria-label")).toBe("Cookout game");
    expect(h.cookout.pane.hidden).toBe(false);
    expect(h.tabs.chatTarget()).toBe(50);
  });

  it("opening Cookout replaces an open WYR or Adventure tab, and either of them replaces Cookout", () => {
    const h = make();
    h.tabs.open("wyr", 7);
    h.tabs.open("cookout", 50);
    expect(h.wyr.reset).toHaveBeenCalledTimes(1);
    expect(h.tabs.seqOf("wyr")).toBeNull();
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Cookout"]);
    h.tabs.open("adventure", 30);
    expect(h.cookout.reset).toHaveBeenCalledTimes(1);
    expect(h.tabs.seqOf("cookout")).toBeNull();
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Adventure"]);
    h.tabs.open("cookout", 51);
    expect(h.adventure.reset).toHaveBeenCalledTimes(1);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Cookout"]);
  });

  it("offering Cookout replaces the open game with a dotted Cookout tab and leaves the screen on Chat", () => {
    const h = make();
    h.tabs.open("adventure", 30);
    h.tabs.offer("cookout", 50);
    expect(h.adventure.reset).toHaveBeenCalledTimes(1);
    expect(visibleTabs(h.tabs)).toEqual(["Chat", "Cookout"]);
    expect(dotted(h.tabs, ".wx-srv-tab-cookout")).toBe(true);
    expect(h.tabs.activeTab()).toBe("chat");
    expect(h.cookout.pane.hidden).toBe(true);
  });

  it("a closed Cookout round is not offered again, and its pop-up chat closes with it", () => {
    const h = make();
    h.tabs.open("cookout", 50);
    h.popup.openFor(50);
    h.tabs.close("cookout");
    expect(h.popup.closePopup).toHaveBeenCalledTimes(1);
    expect(h.cookout.reset).toHaveBeenCalledTimes(1);
    h.tabs.offer("cookout", 50);
    expect(h.tabs.seqOf("cookout")).toBeNull();
    h.tabs.offer("cookout", 52);
    expect(h.tabs.seqOf("cookout")).toBe(52);
  });
});
