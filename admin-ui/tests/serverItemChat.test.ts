import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/server/api/messages";
import { createItemChat, type ItemChat, type ItemChatEcho } from "../src/server/itemChat";

// The per-item chat every game shares (itemChat.ts): the one pop-up chat.

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

afterEach(() => document.body.replaceChildren());

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
  it("the one pop-up is re-aimed between items: the composer stays, the content moves", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "about seven"), msg(21, 30, "about thirty")];
    expect(document.querySelectorAll(".wx-srv-gamepop")).toHaveLength(1);

    h.itemChat.openPopup(30, "Trip chat");
    expect(h.itemChat.popupSeq()).toBe(30);
    expect([...h.itemChat.popup.querySelectorAll(".wx-srv-bubble")].map((b) => b.textContent)).toEqual(["about thirty"]);
    expect(h.itemChat.popup.querySelector(".wx-srv-gamepop-title")!.textContent).toBe("Trip chat");

    // Opened for the other item while still open: the composer stays where it is, the content moves.
    h.itemChat.openPopup(7, "Game chat");
    expect(h.itemChat.popupSeq()).toBe(7);
    expect([...h.itemChat.popup.querySelectorAll(".wx-srv-bubble")].map((b) => b.textContent)).toEqual(["about seven"]);
    expect(h.itemChat.popup.querySelector(".wx-srv-gamepop-title")!.textContent).toBe("Game chat");
    expect(h.mounts).toEqual([h.itemChat.popup.querySelector(".wx-srv-gamepop-composer")]);
    expect(h.disposeBubble).toHaveBeenCalledTimes(1); // the other item's bubble was released
  });

  it("refresh redraws the pop-up, then reports the height may have changed", () => {
    const h = make();
    h.itemChat.openPopup(7, "Game chat");
    h.state.messages = [msg(11, 7, "about seven"), msg(21, 30, "about thirty")];
    h.after.mockClear();
    h.itemChat.refresh();
    expect(h.itemChat.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(1);
    expect(h.after).toHaveBeenCalledTimes(1);
  });

  it("reset (lock or wipe) closes the pop-up and returns the composer", () => {
    const h = make();
    h.state.messages = [msg(11, 7, "about seven")];
    h.itemChat.openPopup(7, "Game chat");
    h.itemChat.reset();
    expect(h.itemChat.isPopupOpen()).toBe(false);
    expect(h.home.contains(h.composer)).toBe(true);
    expect(h.itemChat.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(0);
    h.itemChat.refresh(); // nothing bound any more: nothing comes back
    expect(h.itemChat.popup.querySelectorAll(".wx-srv-bubble")).toHaveLength(0);
  });
});
