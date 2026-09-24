import { afterEach, describe, expect, it, vi } from "vitest";
import { mountMessageActions } from "../src/server/messageActions";
import type { Message } from "../src/server/api/messages";

function message(text: string | null): Message {
  return {
    seq: 1,
    clientId: "client-1234",
    sender: "Purdy",
    text,
    attachments: [],
    createdAt: 1_800_000_000,
  };
}

function mount(text: string | null) {
  const bubble = document.createElement("div");
  document.body.appendChild(bubble);
  const onDelete = vi.fn(async () => {});
  const controller = mountMessageActions({ message: message(text), bubble, win: window, onDelete });
  return { bubble, controller, onDelete };
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
