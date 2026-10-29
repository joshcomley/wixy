import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/server/api/messages";
import { attachmentLabel, createFloatModel } from "../src/server/gameFloatModel";
import { createGameFloat, type GameFloat } from "../src/server/gameFloat";
import type { GameTab } from "../src/server/gameTabs";

// The chat FAB, floating message and quick reply (gameFloat.ts / gameFloatModel.ts; decisions/00193).

function msg(seq: number, ref: number | null, text: string | null, sender = "Rose", extra: Partial<Message> = {}): Message {
  return {
    seq,
    clientId: `c${seq}`,
    sender,
    text,
    attachments: [],
    reactions: [],
    createdAt: 1,
    replyTo: null,
    wyrRef: ref,
    ...extra,
  };
}

describe("float model: which messages has this device not seen", () => {
  function make(active: number | null) {
    const state = { active };
    return { state, model: createFloatModel({ activeItem: () => state.active }) };
  }

  it("tracks the other person's messages for the open item and for the main chat, nothing else", () => {
    const { model } = make(7);
    expect(model.note(msg(1, 7, "about the item"))).toBe(true);
    expect(model.note(msg(2, null, "main chat"))).toBe(true);
    expect(model.note(msg(3, 9, "a different item"))).toBe(false);
    expect(model.count()).toBe(2);
    expect(model.unreadFor(7)).toBe(true);
    expect(model.unreadFor(9)).toBe(false);
  });

  it("tracks nothing while the Chat tab shows (the main chat shows every message)", () => {
    const { model } = make(null);
    expect(model.note(msg(1, null, "hi"))).toBe(false);
    expect(model.note(msg(2, 7, "hi"))).toBe(false);
    expect(model.count()).toBe(0);
  });

  it("floats the NEWEST unseen message and counts the others; the same message twice counts once", () => {
    const { model } = make(7);
    model.note(msg(1, 7, "one"));
    model.note(msg(2, null, "two"));
    model.note(msg(3, 7, "three"));
    model.note(msg(3, 7, "three"));
    const view = model.floating()!;
    expect(view.message.text).toBe("three");
    expect(view.more).toBe(2);
  });

  it("showing one chat's messages clears only that chat's; the FAB dot follows the item", () => {
    const { model } = make(7);
    model.note(msg(1, 7, "item"));
    model.note(msg(2, null, "main"));
    model.markSeen(7);
    expect(model.unreadFor(7)).toBe(false);
    expect(model.floating()!.message.text).toBe("main");
    model.markSeen(null);
    expect(model.floating()).toBeNull();
  });

  it("dismissing the floating message marks everything on screen seen", () => {
    const { model } = make(7);
    model.note(msg(1, 7, "one"));
    model.note(msg(2, 7, "two"));
    model.markAllSeen();
    expect(model.floating()).toBeNull();
    expect(model.unreadFor(7)).toBe(false);
    // …and a NEW message floats again.
    model.note(msg(3, 7, "three"));
    expect(model.floating()!.message.text).toBe("three");
  });

  it("drops a message whose item is no longer the open one, and a deleted message", () => {
    const { state, model } = make(7);
    model.note(msg(1, 7, "item"));
    model.note(msg(2, null, "main"));
    state.active = 8;
    model.prune();
    expect(model.seqs()).toEqual([2]);
    model.forget(2);
    expect(model.count()).toBe(0);
    state.active = 8;
    model.note(msg(3, 8, "x"));
    state.active = null;
    model.prune();
    expect(model.count()).toBe(0);
  });

  it("labels an attachment-only message", () => {
    expect(attachmentLabel([])).toBeNull();
    const att = (kind: "photo" | "voice" | "video") => ({ id: kind, kind, status: "ready" as const, width: null, height: null, durationS: null, peaks: null, urls: {} });
    expect(attachmentLabel([att("photo")])).toBe("Photo");
    expect(attachmentLabel([att("voice")])).toBe("Voice note");
    expect(attachmentLabel([att("video"), att("photo")])).toBe("Video +1");
  });
});

describe("game float: FAB, floating message, quick reply", () => {
  interface Harness {
    float: GameFloat;
    overlay: HTMLElement;
    composer: HTMLElement;
    home: HTMLElement;
    host: HTMLElement;
    tabBar: HTMLElement;
    state: { tab: GameTab; wyr: number | null; popup: number | null; recording: boolean };
    itemChat: { openPopup: ReturnType<typeof vi.fn>; closePopup: ReturnType<typeof vi.fn> };
    mounts: (HTMLElement | null)[];
  }

  function make(): Harness {
    const state = { tab: "wyr" as GameTab, wyr: 7 as number | null, popup: null as number | null, recording: false };
    const host = document.createElement("div");
    const home = document.createElement("div");
    const composer = document.createElement("div");
    composer.className = "fake-composer";
    const textarea = document.createElement("textarea");
    composer.appendChild(textarea);
    home.appendChild(composer);
    const tabBar = document.createElement("div");
    host.append(home, tabBar);
    const mounts: (HTMLElement | null)[] = [];
    const itemChat = {
      openPopup: vi.fn((seq: number) => {
        state.popup = seq;
        // The real pop-up borrows the composer.
        mounts.push(document.createElement("div"));
      }),
      closePopup: vi.fn(() => {
        state.popup = null;
      }),
      isPopupOpen: () => state.popup !== null,
      popupSeq: () => state.popup,
    };
    const float = createGameFloat({
      document,
      win: window,
      itemChat,
      tabs: { activeTab: () => state.tab, seqOf: (key) => (key === "wyr" ? state.wyr : null) },
      mountComposer: (target) => {
        mounts.push(target);
        if (target !== null) target.appendChild(composer);
        else home.appendChild(composer);
      },
      isRecording: () => state.recording,
      tabBar,
      host,
    });
    const overlay = float.createOverlay({ fabLabel: "Open this card's chat", popupTitle: "Game chat", item: () => state.wyr });
    host.append(overlay, float.quick);
    document.body.appendChild(host);
    return { float, overlay, composer, home, host, tabBar, state, itemChat, mounts };
  }

  const fab = (h: Harness) => h.overlay.querySelector<HTMLButtonElement>(".wx-srv-float-fab")!;
  const dot = (h: Harness) => h.overlay.querySelector<HTMLElement>(".wx-srv-float-dot")!;
  const bubble = (h: Harness) => h.overlay.querySelector<HTMLElement>(".wx-srv-float-bubble")!;
  const open = (h: Harness) => h.overlay.querySelector<HTMLButtonElement>(".wx-srv-float-open")!;

  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => document.body.replaceChildren());

  it("starts quiet: a FAB with a name, no dot, no floating message", () => {
    const h = make();
    expect(fab(h).getAttribute("aria-label")).toBe("Open this card's chat");
    expect(dot(h).hidden).toBe(true);
    expect(bubble(h).hidden).toBe(true);
    expect(h.float.quickTarget()).toBeUndefined();
  });

  it("a message from the other person floats and dots the FAB; the dot is exposed in the name", () => {
    const h = make();
    h.float.note(msg(1, 7, "are we there yet?"));
    expect(bubble(h).hidden).toBe(false);
    expect(bubble(h).textContent).toContain("Rose: ");
    expect(bubble(h).textContent).toContain("are we there yet?");
    expect(bubble(h).querySelector<HTMLElement>(".wx-srv-float-tag")!.hidden).toBe(true); // an item message: no "Chat" label
    expect(dot(h).hidden).toBe(false);
    expect(fab(h).getAttribute("aria-label")).toBe("Open this card's chat — new message");
  });

  it("a main-chat message floats with the Chat label and does not dot the item's FAB", () => {
    const h = make();
    h.float.note(msg(1, null, "dinner?"));
    expect(bubble(h).hidden).toBe(false);
    expect(bubble(h).querySelector<HTMLElement>(".wx-srv-float-tag")!.hidden).toBe(false);
    expect(dot(h).hidden).toBe(true);
  });

  it("newer replaces older and shows +N; nothing floats on the Chat tab", () => {
    const h = make();
    h.float.note(msg(1, 7, "first"));
    h.float.note(msg(2, 7, "second"));
    h.float.note(msg(3, 7, "third"));
    expect(bubble(h).textContent).toContain("third");
    expect(bubble(h).textContent).not.toContain("first");
    expect(bubble(h).querySelector<HTMLElement>(".wx-srv-float-more")!.textContent).toBe("+2");
    h.state.tab = "chat";
    h.float.sync();
    expect(bubble(h).hidden).toBe(true);
    // Coming back finds nothing unread: the Chat tab showed it all.
    h.state.tab = "wyr";
    h.float.sync();
    expect(bubble(h).hidden).toBe(true);
    expect(dot(h).hidden).toBe(true);
  });

  it("an attachment-only message shows its label", () => {
    const h = make();
    h.float.note(
      msg(1, 7, null, "Rose", {
        attachments: [{ id: "v", kind: "voice", status: "ready", width: null, height: null, durationS: 2, peaks: null, urls: {} }],
      }),
    );
    expect(bubble(h).textContent).toContain("Voice note");
  });

  it("the dismiss button clears it and the dot; a swipe down does too; a new message floats again", () => {
    const h = make();
    h.float.note(msg(1, 7, "one"));
    h.overlay.querySelector<HTMLButtonElement>(".wx-srv-float-dismiss")!.click();
    expect(bubble(h).hidden).toBe(true);
    expect(dot(h).hidden).toBe(true);
    h.float.note(msg(2, 7, "two"));
    expect(bubble(h).hidden).toBe(false);
    open(h).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 10 }));
    open(h).dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 52, clientY: 60 }));
    expect(bubble(h).hidden).toBe(true);
    // The click a swipe's release can produce is swallowed: it must not open the quick reply.
    open(h).click();
    expect(h.float.quickTarget()).toBeUndefined();
  });

  it("the FAB opens the item's pop-up and clears that item's dot", () => {
    const h = make();
    h.float.note(msg(1, 7, "one"));
    fab(h).click();
    expect(h.itemChat.openPopup).toHaveBeenCalledWith(7, "Game chat");
    expect(dot(h).hidden).toBe(true);
  });

  it("a message arriving while the pop-up is open on its chat is seen at once", () => {
    const h = make();
    fab(h).click();
    h.float.note(msg(1, 7, "live"));
    expect(dot(h).hidden).toBe(true);
    expect(h.float.model.count()).toBe(0);
    // A main-chat message is tracked, but the floating message is hidden under the pop-up.
    h.float.note(msg(2, null, "main"));
    expect(bubble(h).hidden).toBe(true);
    h.state.popup = null;
    h.float.sync();
    expect(bubble(h).hidden).toBe(false);
  });

  it("tapping the floating message opens the quick reply on the composer, targeted at the message's chat", () => {
    const h = make();
    h.float.note(msg(1, 7, "about the item"));
    open(h).click();
    expect(h.float.quick.hidden).toBe(false);
    expect(h.float.quickTarget()).toBe(7);
    expect(h.float.quick.querySelector(".wx-srv-quick-composer")!.contains(h.composer)).toBe(true);
    expect(h.float.quick.querySelector(".wx-srv-quick-text")!.textContent).toBe("Rose: about the item");
    expect(bubble(h).hidden).toBe(true); // it became the reply box
    expect(dot(h).hidden).toBe(true); // answered through the floating message: seen
  });

  it("a main-chat message's quick reply goes to the main chat (target null)", () => {
    const h = make();
    h.float.note(msg(1, null, "dinner?"));
    open(h).click();
    expect(h.float.quickTarget()).toBeNull();
    expect(h.float.quick.querySelector<HTMLElement>(".wx-srv-quick-tag")!.hidden).toBe(false);
  });

  it("a successful send to that chat closes the box and gives the composer back; another chat's send does not", () => {
    const h = make();
    h.float.note(msg(1, 7, "x"));
    open(h).click();
    h.float.noteSent(null);
    expect(h.float.quick.hidden).toBe(false);
    h.float.noteSent(7);
    expect(h.float.quick.hidden).toBe(true);
    expect(h.float.quickTarget()).toBeUndefined();
    expect(h.home.contains(h.composer)).toBe(true);
  });

  it("not while a voice note is being recorded: neither a send, the X nor the backdrop closes it", () => {
    const h = make();
    h.float.note(msg(1, 7, "x"));
    open(h).click();
    h.state.recording = true;
    h.float.noteSent(7);
    h.float.quick.querySelector<HTMLButtonElement>(".wx-srv-quick-close")!.click();
    h.float.quick.querySelector<HTMLButtonElement>(".wx-srv-quick-backdrop")!.click();
    expect(h.float.quick.hidden).toBe(false);
    h.state.recording = false;
    h.float.quick.querySelector<HTMLButtonElement>(".wx-srv-quick-close")!.click();
    expect(h.float.quick.hidden).toBe(true);
    expect(h.home.contains(h.composer)).toBe(true);
  });

  it("the backdrop (a tap outside) closes it", () => {
    const h = make();
    h.float.note(msg(1, 7, "x"));
    open(h).click();
    h.float.quick.querySelector<HTMLButtonElement>(".wx-srv-quick-backdrop")!.click();
    expect(h.float.quick.hidden).toBe(true);
  });

  it("opening the FAB pop-up while the quick reply is open moves the composer there in one step", () => {
    const h = make();
    h.float.note(msg(1, 7, "x"));
    open(h).click();
    const mountsBefore = h.mounts.length;
    fab(h).click();
    expect(h.float.quick.hidden).toBe(true);
    expect(h.float.quickTarget()).toBeUndefined();
    expect(h.itemChat.openPopup).toHaveBeenCalled();
    // The quick reply did not send the composer home first: only the pop-up's own mount follows.
    expect(h.mounts.slice(mountsBefore).every((m) => m !== null)).toBe(true);
  });

  it("a reply to the same chat that arrives while the box is open updates the quoted line and is seen", () => {
    const h = make();
    h.float.note(msg(1, 7, "first"));
    open(h).click();
    h.float.note(msg(2, 7, "second"));
    expect(h.float.quick.querySelector(".wx-srv-quick-text")!.textContent).toBe("Rose: second");
    expect(h.float.model.count()).toBe(0);
  });

  it("the box closes on the Chat tab, when the item changes, and on reset; the others' floats drop too", () => {
    const h = make();
    h.float.note(msg(1, 7, "x"));
    open(h).click();
    h.state.wyr = 8; // a new round took the tab
    h.float.sync();
    expect(h.float.quick.hidden).toBe(true);
    h.state.wyr = 7;
    h.float.note(msg(2, 7, "y"));
    open(h).click();
    h.state.tab = "chat";
    h.float.sync();
    expect(h.float.quick.hidden).toBe(true);
    h.state.tab = "wyr";
    h.float.note(msg(3, 7, "z"));
    open(h).click();
    h.float.reset();
    expect(h.float.quick.hidden).toBe(true);
    expect(h.float.model.count()).toBe(0);
    expect(h.home.contains(h.composer)).toBe(true);
  });

  it("a message that is deleted stops floating (and ends a quick reply on it)", () => {
    const h = make();
    h.float.note(msg(1, 7, "gone soon"));
    h.float.reconcile(() => false);
    expect(bubble(h).hidden).toBe(true);
    h.float.note(msg(2, 7, "also gone"));
    open(h).click();
    h.float.reconcile(() => false);
    expect(h.float.quick.hidden).toBe(true);
  });

  it("sits above the tab bar", () => {
    const h = make();
    h.tabBar.getBoundingClientRect = () => ({ top: 700, bottom: 744, left: 0, right: 360, width: 360, height: 44, x: 0, y: 700, toJSON() {} }) as DOMRect;
    h.host.getBoundingClientRect = () => ({ top: 0, bottom: 760, left: 0, right: 360, width: 360, height: 760, x: 0, y: 0, toJSON() {} }) as DOMRect;
    h.float.note(msg(1, 7, "x"));
    open(h).click();
    expect(h.float.quick.style.bottom).toBe("60px");
  });
});
