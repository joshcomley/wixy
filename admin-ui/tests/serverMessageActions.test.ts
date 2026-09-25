import { afterEach, describe, expect, it, vi } from "vitest";
import { mountMessageActions } from "../src/server/messageActions";
import { REACTION_EMOJIS, reactionLabel } from "../src/server/reactions";
import type { Message } from "../src/server/api/messages";

function message(text: string | null): Message {
  return {
    seq: 1,
    clientId: "client-1234",
    sender: "Purdy",
    text,
    attachments: [],
    reactions: [],
    createdAt: 1_800_000_000,
  };
}

function mount(text: string | null, isReacted: (message: Message, emoji: string) => boolean = () => false) {
  const bubble = document.createElement("div");
  document.body.appendChild(bubble);
  const onDelete = vi.fn(async () => {});
  const onReact = vi.fn();
  const controller = mountMessageActions({
    message: message(text),
    bubble,
    win: window,
    onDelete,
    onReact,
    isReacted,
  });
  return { bubble, controller, onDelete, onReact };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Server message action menu proof", () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

  afterEach(() => {
    if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, "clipboard");
    else Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    document.body.innerHTML = "";
  });

  it("opens on desktop contextmenu and exposes Delete and Copy actions for text", () => {
    const { bubble, controller, onDelete } = mount("hello from Purdy");
    bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    const menu = bubble.querySelector<HTMLElement>(".wx-srv-message-actions");
    expect(menu?.hidden).toBe(false);
    expect(menu?.querySelector('[role="menuitem"][class*="delete"]')?.textContent).toBe("Delete for everyone");
    expect(menu?.querySelector('[role="menuitem"][class*="copy"]')?.textContent).toBe("Copy text");
    expect(onDelete).not.toHaveBeenCalled();
    controller.teardown();
  });

  it("copies exact text and closes the action menu", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { bubble, controller } = mount("exact message text\nwith a second line");
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-action-copy")?.click();
    await flush();

    expect(writeText).toHaveBeenCalledWith("exact message text\nwith a second line");
    expect(bubble.querySelector<HTMLElement>(".wx-srv-message-actions")?.hidden).toBe(true);
    controller.teardown();
  });

  it("omits Copy for media-only messages and shows clipboard failure", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    const media = mount(null);
    media.bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    expect(media.bubble.querySelector(".wx-srv-message-action-copy")).toBeNull();
    media.controller.teardown();

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    const text = mount("copy will fail");
    text.bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    text.bubble.querySelector<HTMLButtonElement>(".wx-srv-message-action-copy")?.click();
    await flush();
    const error = text.bubble.querySelector<HTMLElement>(".wx-srv-message-action-error");
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe("Couldn't copy the message.");
    text.controller.teardown();
  });
});

describe("Server message action menu: the reaction row", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("puts the six reactions first, in list order, as gesture-boundary menu checkboxes", () => {
    const { bubble, controller } = mount("hello");
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();

    const list = bubble.querySelector<HTMLElement>(".wx-srv-message-actions-list")!;
    expect(list.firstElementChild).toBe(bubble.querySelector(".wx-srv-message-reactions-picker"));
    const buttons = [...bubble.querySelectorAll<HTMLButtonElement>(".wx-srv-message-react")];
    expect(buttons.map((b) => b.textContent)).toEqual([...REACTION_EMOJIS]);
    for (const button of buttons) {
      expect(button.getAttribute("role")).toBe("menuitemcheckbox");
      expect(button.getAttribute("aria-label")).toBe(reactionLabel(button.textContent ?? ""));
      // Opened by the tap that opened this menu: a causal flow, so a gesture boundary (R3 v1.5.2).
      expect(button.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    }
    controller.teardown();
  });

  it("tapping an emoji reports it for that message and closes the menu", () => {
    const { bubble, controller, onReact } = mount("hello");
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    [...bubble.querySelectorAll<HTMLButtonElement>(".wx-srv-message-react")]
      .find((button) => button.dataset["reaction"] === "\u{1F602}")
      ?.click();

    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }), "\u{1F602}");
    expect(bubble.querySelector<HTMLElement>(".wx-srv-message-actions")?.hidden).toBe(true);
    controller.teardown();
  });

  it("marks the emoji the reader already holds as checked", () => {
    const { bubble, controller } = mount("hello", (_message, emoji) => emoji === "\u{1F64F}");
    const states = [...bubble.querySelectorAll<HTMLButtonElement>(".wx-srv-message-react")].map((b) => [
      b.textContent,
      b.getAttribute("aria-checked"),
    ]);
    expect(states).toEqual(REACTION_EMOJIS.map((emoji) => [emoji, String(emoji === "\u{1F64F}")]));
    controller.teardown();
  });

  it("update() refreshes the checked state without closing an open menu", () => {
    let held = false;
    const { bubble, controller } = mount("hello", () => held);
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    held = true;
    controller.update({ ...message("hello"), reactions: [{ emoji: "\u{1F44D}", count: 1, senders: ["Josh"] }] });

    expect(bubble.querySelector<HTMLElement>(".wx-srv-message-actions")?.hidden).toBe(false);
    expect(bubble.querySelector(".wx-srv-message-react")?.getAttribute("aria-checked")).toBe("true");
    controller.teardown();
  });

  it("is hidden along with the other actions while the delete confirmation shows", () => {
    const { bubble, controller } = mount("hello");
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")?.click();
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-action-delete")?.click();

    expect(bubble.querySelector<HTMLElement>(".wx-srv-message-actions-list")?.hidden).toBe(true);
    controller.teardown();
  });
});
