import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/server/api/messages";
import { createItemChat, type ItemChat, type ItemChatEcho } from "../src/server/itemChat";

// The per-item chat every game shares (itemChat.ts): the mini strip and the one pop-up chat.

function photo(i: number, status: "ready" | "processing" = "ready"): Message["attachments"][number] {
  return {
    id: `att${i}`,
    kind: "photo",
    status,
    width: 100,
    height: 100,
    durationS: null,
    peaks: null,
    urls: { full: `https://example.invalid/full${i}.jpg`, thumb: `https://example.invalid/thumb${i}.jpg` },
  };
}

function attachment(kind: "voice" | "video"): Message["attachments"][number] {
  return { id: kind, kind, status: "ready", width: null, height: null, durationS: 2, peaks: null, urls: {} };
}

function msg(seq: number, ref: number, text: string | null, sender = "Rose", extra: Partial<Message> = {}): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender,
    text,
    attachments: [],
    reactions: [],
    createdAt: Date.now() / 1000,
    replyTo: null,
    wyrRef: ref,
    ...extra,
  };
}

interface Harness {
  itemChat: ItemChat;
  state: { messages: Message[]; echoes: ItemChatEcho[] };
  composer: HTMLElement;
  home: HTMLElement;
  mounts: (HTMLElement | null)[];
  renderBubble: ReturnType<typeof vi.fn<(message: Message) => HTMLElement>>;
  disposeBubble: ReturnType<typeof vi.fn<(element: HTMLElement) => void>>;
  layout: ReturnType<typeof vi.fn>;
  after: ReturnType<typeof vi.fn>;
}

function make(): Harness {
  const state = { messages: [] as Message[], echoes: [] as ItemChatEcho[] };
  const composer = document.createElement("div");
  composer.className = "fake-composer";
  const home = document.createElement("div");
  home.appendChild(composer);
  const mounts: (HTMLElement | null)[] = [];
  const renderBubble = vi.fn<(message: Message) => HTMLElement>((m) => {
    const b = document.createElement("div");
    b.className = "wx-srv-bubble";
    b.dataset["messageSeq"] = String(m.seq);
    b.textContent = m.text ?? "";
    return b;
  });
  const disposeBubble = vi.fn<(element: HTMLElement) => void>();
  const layout = vi.fn();
  const after = vi.fn();
  const itemChat = createItemChat({
    document,
    isMine: (sender) => sender === "Josh",
    gameMessages: (seq) => state.messages.filter((m) => m.wyrRef === seq).sort((a, b) => a.seq - b.seq),
    gameEchoes: () => state.echoes,
    renderBubble,
    disposeBubble,
    mountComposer: (host) => {
      mounts.push(host);
      if (host !== null) host.appendChild(composer);
      else home.appendChild(composer);
    },
    onLayoutChange: layout,
    afterChange: after,
  });
  document.body.append(home, itemChat.popup);
  return { itemChat, state, composer, home, mounts, renderBubble, disposeBubble, layout, after };
}

/** A strip in the document (as a game's pane would hold it), drawn for `seq`. */
function strip(h: Harness, seq: number | null, options?: Parameters<ItemChat["createStrip"]>[0]) {
  const s = h.itemChat.createStrip(options);
  document.body.appendChild(s.element);
  s.draw(seq);
  return s;
}

const rows = (element: HTMLElement) =>
  [...element.querySelectorAll(".wx-srv-game-mini-msg")].map((r) => r.textContent);

afterEach(() => document.body.replaceChildren());

describe("item chat: the mini strip", () => {
  it("invites a first message when the item has no chat", () => {
    const h = make();
    const s = strip(h, 7);
    expect(s.element.classList.contains("wx-srv-game-mini")).toBe(true);
    expect(rows(s.element)).toEqual(["Chat about this one…"]);
    expect(s.element.querySelector(".wx-srv-game-mini-count")).toBeNull();
    expect(s.element.querySelector(".wx-srv-game-mini-expand-label")!.textContent).toBe("Chat");
  });

  it("shows only this item's last two messages, my own without a name, never other chat", () => {
    const h = make();
    h.state.messages = [
      msg(10, 0, "main chat, not this item"),
      msg(11, 7, "first about the item"),
      msg(12, 7, "second about the item", "Josh"),
      msg(13, 7, "third about the item"),
      msg(14, 9, "a different item"),
    ];
    const s = strip(h, 7);
    const lines = rows(s.element);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("second about the item");
    expect(lines[0]).not.toContain("Josh:");
    expect(lines[1]).toContain("Rose: third about the item");
    expect(s.element.textContent).not.toContain("main chat, not this item");
    expect(s.element.textContent).not.toContain("a different item");
    expect(s.element.querySelectorAll(".wx-srv-game-mini-mine")).toHaveLength(1);
    // The button counts every message of the item, not just the two shown.
    expect(s.element.querySelector(".wx-srv-game-mini-count")!.textContent).toBe("3");
  });

  it("puts messages still being sent (echoes) after the confirmed ones, still two lines at most", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "one"), msg(12, 7, "two")];
    const s = strip(h, 7);
    h.state.echoes = [{ clientId: "e1", text: "sending this" }];
    s.draw(7);
    const lines = rows(s.element);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("two");
    expect(lines[1]).toContain("sending this");
    expect(s.element.querySelector(".wx-srv-game-mini-count")!.textContent).toBe("3");
    h.state.echoes = [
      { clientId: "e1", text: "sending this" },
      { clientId: "e2", text: "and this" },
      { clientId: "e3", text: "and that" },
    ];
    s.draw(7);
    expect(rows(s.element)).toHaveLength(2);
    expect(rows(s.element)[1]).toContain("and that");
  });

  it("shows photo attachments as 20 px thumbnails and other kinds as icons", () => {
    const h = make();
    h.state.messages = [
      msg(11, 7, "look", "Rose", { attachments: [photo(0)] }),
      msg(12, 7, null, "Rose", { attachments: [attachment("voice"), attachment("video"), photo(1, "processing")] }),
    ];
    const s = strip(h, 7);
    const thumb = s.element.querySelector<HTMLImageElement>(".wx-srv-game-mini-thumb")!;
    expect(thumb.getAttribute("src")).toBe("https://example.invalid/thumb0.jpg");
    expect(s.element.querySelectorAll(".wx-srv-game-mini-thumb")).toHaveLength(1);
    const icons = [...s.element.querySelectorAll(".wx-srv-game-mini-icon")].map((i) => i.textContent);
    expect(icons).toEqual(["🎤", "🎞", "🖼"]); // a photo that is not ready yet is an icon, not a broken image
  });

  it("is empty when bound to nothing, and a tap then opens nothing", () => {
    const h = make();
    const s = strip(h, null);
    expect(s.element.children).toHaveLength(0);
    s.element.click();
    expect(h.itemChat.isPopupOpen()).toBe(false);
  });

  it("every line, thumbnail and the Chat button open the pop-up for the strip's item", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "look", "Rose", { attachments: [photo(0)] })];
    const s = strip(h, 7);
    s.element.querySelector<HTMLElement>(".wx-srv-game-mini-thumb")!.parentElement!.click();
    expect(h.itemChat.popupSeq()).toBe(7);
    h.itemChat.closePopup();
    s.element.querySelector<HTMLButtonElement>(".wx-srv-game-mini-expand")!.click();
    expect(h.itemChat.popupSeq()).toBe(7);
    h.itemChat.closePopup();
    h.state.messages = [];
    s.draw(7);
    s.element.querySelector<HTMLButtonElement>(".wx-srv-game-mini-empty")!.click();
    expect(h.itemChat.popupSeq()).toBe(7);
  });

  it("opens the pop-up under the heading its game chose (default 'Game chat')", () => {
    const h = make();
    const plain = strip(h, 7);
    plain.element.querySelector<HTMLButtonElement>(".wx-srv-game-mini-expand")!.click();
    expect(h.itemChat.popup.querySelector(".wx-srv-gamepop-title")!.textContent).toBe("Game chat");
    h.itemChat.closePopup();
    const named = strip(h, 9, { popupTitle: "Trip chat" });
    named.element.querySelector<HTMLButtonElement>(".wx-srv-game-mini-expand")!.click();
    expect(h.itemChat.popup.querySelector(".wx-srv-gamepop-title")!.textContent).toBe("Trip chat");
  });
});

describe("item chat: the pop-up", () => {
  it("borrows the one composer, shows the item's whole history and gives the composer back", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "one"), msg(12, 7, "two"), msg(13, 7, "three"), msg(14, 9, "other item")];
    expect(h.itemChat.popup.hidden).toBe(true);
    h.itemChat.openPopup(7, "Game chat");
    expect(h.itemChat.popup.hidden).toBe(false);
    expect(h.itemChat.isPopupOpen()).toBe(true);
    expect(h.itemChat.popupSeq()).toBe(7);
    expect(h.itemChat.popup.querySelector(".wx-srv-gamepop-composer")!.contains(h.composer)).toBe(true);
    expect([...h.itemChat.popup.querySelectorAll(".wx-srv-bubble")].map((b) => b.textContent)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(h.layout).toHaveBeenCalledTimes(1);
    h.itemChat.closePopup();
    expect(h.itemChat.popup.hidden).toBe(true);
    expect(h.itemChat.isPopupOpen()).toBe(false);
    expect(h.itemChat.popupSeq()).toBeNull();
    expect(h.home.contains(h.composer)).toBe(true);
    expect(h.mounts).toHaveLength(2);
    expect(h.mounts[1]).toBeNull();
    expect(h.layout).toHaveBeenCalledTimes(2);
    expect(h.itemChat.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(0); // media released
  });

  it("opening it again for the same item does not move the composer twice or rebuild anything", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "one")];
    h.itemChat.openPopup(7, "Game chat");
    h.itemChat.openPopup(7, "Game chat");
    expect(h.mounts).toHaveLength(1);
    expect(h.renderBubble).toHaveBeenCalledTimes(1);
    expect(h.layout).toHaveBeenCalledTimes(1);
  });

  it("redraws incrementally: an unchanged bubble keeps its node so a playing voice note is never cut off", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "one")];
    h.itemChat.openPopup(7, "Game chat");
    const first = h.itemChat.popup.querySelector('[data-message-seq="11"]');
    expect(h.renderBubble).toHaveBeenCalledTimes(1);
    h.state.messages = [msg(11, 7, "one"), msg(12, 7, "two")];
    h.itemChat.refresh();
    expect(h.renderBubble).toHaveBeenCalledTimes(2); // only the new one
    expect(h.itemChat.popup.querySelector('[data-message-seq="11"]')).toBe(first);
    expect(h.itemChat.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(2);
    expect(h.disposeBubble).not.toHaveBeenCalled();
  });

  it("rebuilds a bubble whose body changed (and releases the old one), drops one that was deleted, keeps order", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "one"), msg(13, 7, "three")];
    h.itemChat.openPopup(7, "Game chat");
    const stale = h.itemChat.popup.querySelector('[data-message-seq="11"]');
    h.state.messages = [msg(11, 7, "one, edited"), msg(12, 7, "two"), msg(13, 7, "three")];
    h.itemChat.refresh();
    const order = [...h.itemChat.popup.querySelectorAll(".wx-srv-bubble")].map((b) => b.textContent);
    expect(order).toEqual(["one, edited", "two", "three"]); // 12 slotted in between
    expect(h.itemChat.popup.contains(stale)).toBe(false);
    expect(h.disposeBubble).toHaveBeenCalledWith(stale);
    const gone = h.itemChat.popup.querySelector('[data-message-seq="13"]');
    h.state.messages = [msg(11, 7, "one, edited"), msg(12, 7, "two")];
    h.itemChat.refresh();
    expect(h.itemChat.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(2);
    expect(h.disposeBubble).toHaveBeenCalledWith(gone);
  });

  it("shows a message that is still being sent as an echo and removes it once it is confirmed", () => {
    const h = make();
    h.itemChat.openPopup(7, "Game chat");
    const empty = h.itemChat.popup.querySelector<HTMLElement>(".wx-srv-gamepop-empty")!;
    expect(empty.hidden).toBe(false);
    h.state.echoes = [{ clientId: "e1", text: "on its way" }];
    h.itemChat.refresh();
    expect(h.itemChat.popup.querySelector(".wx-srv-echo")!.textContent).toBe("on its way");
    expect(empty.hidden).toBe(true);
    h.state.echoes = [];
    h.state.messages = [msg(11, 7, "on its way", "Josh")];
    h.itemChat.refresh();
    expect(h.itemChat.popup.querySelector(".wx-srv-echo")).toBeNull();
    expect(h.itemChat.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(1);
  });

  it("closes by its X and by the backdrop — Escape is left to the panic lock", () => {
    const h = make();
    h.itemChat.openPopup(7, "Game chat");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    h.itemChat.popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.itemChat.isPopupOpen()).toBe(true);
    h.itemChat.popup.querySelector<HTMLButtonElement>(".wx-srv-gamepop-close")!.click();
    expect(h.itemChat.isPopupOpen()).toBe(false);
    h.itemChat.openPopup(7, "Game chat");
    h.itemChat.popup.querySelector<HTMLButtonElement>(".wx-srv-gamepop-backdrop")!.click();
    expect(h.itemChat.isPopupOpen()).toBe(false);
  });

  it("closing when it is not open does nothing", () => {
    const h = make();
    h.itemChat.closePopup();
    expect(h.mounts).toHaveLength(0);
    expect(h.layout).not.toHaveBeenCalled();
  });
});

describe("item chat: several games share it", () => {
  it("two strips draw their own items but open the one pop-up, which is re-aimed between them", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "about seven"), msg(21, 30, "about thirty")];
    const wyr = strip(h, 7);
    const adventure = strip(h, 30, { popupTitle: "Trip chat" });
    expect(rows(wyr.element)[0]).toContain("about seven");
    expect(rows(adventure.element)[0]).toContain("about thirty");
    expect(document.querySelectorAll(".wx-srv-gamepop")).toHaveLength(1);

    adventure.element.querySelector<HTMLButtonElement>(".wx-srv-game-mini-expand")!.click();
    expect(h.itemChat.popupSeq()).toBe(30);
    expect([...h.itemChat.popup.querySelectorAll(".wx-srv-bubble")].map((b) => b.textContent)).toEqual(["about thirty"]);
    expect(h.itemChat.popup.querySelector(".wx-srv-gamepop-title")!.textContent).toBe("Trip chat");

    // Opened for the other item while still open: the composer stays where it is, the content moves.
    wyr.element.querySelector<HTMLButtonElement>(".wx-srv-game-mini-expand")!.click();
    expect(h.itemChat.popupSeq()).toBe(7);
    expect([...h.itemChat.popup.querySelectorAll(".wx-srv-bubble")].map((b) => b.textContent)).toEqual(["about seven"]);
    expect(h.itemChat.popup.querySelector(".wx-srv-gamepop-title")!.textContent).toBe("Game chat");
    expect(h.mounts).toEqual([h.itemChat.popup.querySelector(".wx-srv-gamepop-composer")]);
    expect(h.disposeBubble).toHaveBeenCalledTimes(1); // the other item's bubble was released
  });

  it("refresh redraws every strip and the pop-up, then reports the height may have changed", () => {
    const h = make();
    const a = strip(h, 7);
    const b = strip(h, 30);
    h.itemChat.openPopup(7, "Game chat");
    h.state.messages = [msg(11, 7, "about seven"), msg(21, 30, "about thirty")];
    h.after.mockClear();
    h.itemChat.refresh();
    expect(rows(a.element)[0]).toContain("about seven");
    expect(rows(b.element)[0]).toContain("about thirty");
    expect(h.itemChat.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(1);
    expect(h.after).toHaveBeenCalledTimes(1);
  });

  it("reset (lock or wipe) closes the pop-up, returns the composer and empties every strip", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "about seven")];
    const a = strip(h, 7);
    const b = strip(h, 30);
    h.itemChat.openPopup(7, "Game chat");
    h.itemChat.reset();
    expect(h.itemChat.isPopupOpen()).toBe(false);
    expect(h.home.contains(h.composer)).toBe(true);
    expect(h.itemChat.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(0);
    expect(a.element.children).toHaveLength(0);
    expect(b.element.children).toHaveLength(0);
    h.itemChat.refresh(); // nothing bound any more: nothing comes back
    expect(a.element.children).toHaveLength(0);
  });
});
