import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment, Message } from "../src/server/api/messages";
import { mountMessageActions } from "../src/server/messageActions";
import { formatExactTime, messageInfoRows } from "../src/server/messageInfo";

function message(overrides: Partial<Message> = {}): Message {
  return {
    seq: 12_100,
    clientId: "client-1",
    sender: "Purdy",
    text: "hello there you",
    attachments: [],
    reactions: [],
    createdAt: 1_790_000_000,
    replyTo: null,
    ...overrides,
  };
}

function attachment(overrides: Partial<Attachment>): Attachment {
  return { id: "a", kind: "photo", status: "ready", width: null, height: null, durationS: null, peaks: null, urls: {}, ...overrides };
}

function row(rows: ReturnType<typeof messageInfoRows>, label: string): string | undefined {
  return rows.find((item) => item.label === label)?.value;
}

afterEach(() => document.body.replaceChildren());

describe("messageInfoRows", () => {
  it("gives the exact time to the second, the sender and the kind of message", () => {
    const rows = messageInfoRows(message());
    expect(rows[0]).toEqual({ label: "Sent", value: formatExactTime(1_790_000_000) });
    expect(new Date(1_790_000_000 * 1000).getSeconds().toString().padStart(2, "0")).toBe(
      formatExactTime(1_790_000_000).match(/:(\d{2})\b(?!.*:\d{2})/)?.[1],
    );
    expect(row(rows, "From")).toBe("Purdy");
    expect(row(rows, "Type")).toBe("Text message");
    expect(row(rows, "Length")).toBe("3 words, 15 characters");
    expect(row(rows, "Message number")).toBe((12_100).toLocaleString());
  });

  it("counts an emoji as one character", () => {
    expect(row(messageInfoRows(message({ text: "🎉" })), "Length")).toBe("1 word, 1 character");
  });

  it("describes a voice note, with its length and whether it was transcribed", () => {
    const rows = messageInfoRows(
      message({
        text: null,
        attachments: [
          attachment({
            kind: "voice",
            durationS: 75,
            transcript: { status: "done", text: "secret words", failure: null } as unknown as NonNullable<Attachment["transcript"]>,
          }),
        ],
      }),
    );
    expect(row(rows, "Type")).toBe("Voice note");
    expect(row(rows, "Voice note")).toBe("1:15, transcribed");
    expect(row(rows, "Length")).toBeUndefined();
  });

  it("numbers several attachments and gives photo sizes", () => {
    const rows = messageInfoRows(
      message({ attachments: [attachment({ width: 800, height: 600 }), attachment({ width: 10, height: 20 })] }),
    );
    expect(row(rows, "Type")).toBe("2 Photos");
    expect(row(rows, "Photo 1")).toBe("800 × 600");
    expect(row(rows, "Photo 2")).toBe("10 × 20");
  });

  it("says who a reply answers and who reacted, never repeating the quoted words", () => {
    const rows = messageInfoRows(
      message({
        replyTo: { seq: 1, sender: "Josh", text: "the quoted words", truncated: false, media: null },
        reactions: [{ emoji: "❤️", count: 2, senders: ["Josh", "Purdy"] }],
      }),
    );
    expect(row(rows, "Replying to")).toBe("Josh");
    expect(row(rows, "Reaction ❤️")).toBe("Josh, Purdy");
    expect(JSON.stringify(rows)).not.toContain("the quoted words");
  });

  it("gives a view-once message its time and nothing about its contents", () => {
    const rows = messageInfoRows(
      message({
        text: null,
        viewOnce: { durationS: 5, tease: false },
        attachments: [attachment({ width: 800, height: 600 })],
      }),
    );
    expect(row(rows, "Type")).toBe("View-once photo");
    expect(row(rows, "Shown for")).toBe("5 seconds");
    expect(row(rows, "Photo")).toBeUndefined();
  });

  it("names canvases and games", () => {
    expect(row(messageInfoRows(message({ text: null, canvas: true })), "Type")).toBe("Canvas");
    expect(
      row(messageInfoRows(message({ text: null, wyr: { state: "open", rev: 1 } as unknown as NonNullable<Message["wyr"]> })), "Type"),
    ).toBe("Would You Rather game");
  });
});

describe("Message info in the menu", () => {
  function mount(start: Message) {
    const bubble = document.createElement("div");
    document.body.appendChild(bubble);
    const controller = mountMessageActions({
      message: start,
      bubble,
      win: window,
      onDelete: vi.fn(async () => {}),
      onReact: vi.fn(),
      isReacted: () => false,
      onReply: vi.fn(),
    });
    return { bubble, controller };
  }

  it("opens in place of the menu items, goes back, and starts fresh next time", () => {
    const { bubble, controller } = mount(message());
    const actions = bubble.querySelector<HTMLElement>(".wx-srv-message-actions-list")!;
    const pane = bubble.querySelector<HTMLElement>(".wx-srv-message-info")!;
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")!.click();
    expect(pane.hidden).toBe(true);

    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-action-info")!.click();
    expect(pane.hidden).toBe(false);
    expect(actions.hidden).toBe(true);
    expect(pane.querySelector("dd")!.textContent).toBe(formatExactTime(1_790_000_000));

    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-info-back")!.click();
    expect(pane.hidden).toBe(true);
    expect(actions.hidden).toBe(false);

    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-action-info")!.click();
    controller.close();
    expect(pane.hidden).toBe(true);
    expect(actions.hidden).toBe(false);
    controller.teardown();
  });

  it("stays current when a reaction lands while it is open, and shows names as text", () => {
    const { bubble, controller } = mount(message({ sender: "<b>Purdy</b>" }));
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-actions-trigger")!.click();
    bubble.querySelector<HTMLButtonElement>(".wx-srv-message-action-info")!.click();
    const pane = bubble.querySelector<HTMLElement>(".wx-srv-message-info")!;
    expect(pane.querySelector("b")).toBeNull();
    controller.update(message({ reactions: [{ emoji: "👍", count: 1, senders: ["Josh"] }] }));
    expect(pane.textContent).toContain("Reaction 👍");
    controller.teardown();
  });
});
