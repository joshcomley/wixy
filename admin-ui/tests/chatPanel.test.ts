import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdminApi,
  ChatMessageData,
  ConversationStreamEvent,
  ConversationSummary,
  StateResponse,
} from "../src/api";
import { mountChatPanel, type ChatPanelDeps } from "../src/chatPanel";

function fakeConversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    convId: "c1",
    title: "hi",
    createdAt: "2026-07-10T00:00:00Z",
    status: "ready",
    failureReason: null,
    failureMessage: null,
    ...overrides,
  };
}

function fakeState(overrides: Partial<StateResponse> = {}): StateResponse {
  return {
    project: { slug: "ca", name: "CA", domain: "ca.example" },
    pages: [],
    draft: { rev: 0, opCount: 0 },
    live: null,
    upstream: { aheadOfPublished: [], fetchedAt: null },
    publishJob: null,
    chats: [],
    ...overrides,
  };
}

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(async () => fakeState()),
    getContent: vi.fn(),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    getTheme: vi.fn(),
    getPublishPreview: vi.fn(),
    publish: vi.fn(),
    getPublishes: vi.fn(),
    restore: vi.fn(),
    duplicatePage: vi.fn(),
    deletePage: vi.fn(),
    createConversation: vi.fn(async () => fakeConversation({ status: "pending" })),
    getConversations: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ accepted: true, buffered: false })),
    renameConversation: vi.fn(async () => fakeConversation({ title: "renamed" })),
    ...overrides,
  } as AdminApi;
}

function fakeWindow(overrides: Record<string, unknown> = {}): Window {
  let pathname = "/admin/chat";
  let hash = "";
  return {
    location: {
      get pathname() {
        return pathname;
      },
      get hash() {
        return hash;
      },
      set hash(value: string) {
        hash = value.startsWith("#") ? value : `#${value}`;
      },
    },
    // Path-routed admin (decisions/00087): navigateTo goes through history —
    // record the path (and clear the hash like a real browser).
    history: {
      pushState: (_state: unknown, _title: string, url: string) => {
        pathname = url;
        hash = "";
      },
      replaceState: (_state: unknown, _title: string, url: string) => {
        pathname = url;
        hash = "";
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    prompt: vi.fn(() => null),
    crypto: { randomUUID: () => "test-uuid" },
    ...overrides,
  } as unknown as Window;
}

interface FakeStreamController {
  connectCalls: Array<{ convId: string; includeThinking: boolean }>;
  closeCalls: number;
  emit: (event: ConversationStreamEvent) => void;
  openStream: NonNullable<ChatPanelDeps["openStream"]>;
}

function fakeStreamController(): FakeStreamController {
  let currentListener: ((event: ConversationStreamEvent) => void) | null = null;
  const controller: FakeStreamController = {
    connectCalls: [],
    closeCalls: 0,
    emit: (event) => currentListener?.(event),
    openStream: (convId, onEvent, includeThinking = false) => {
      controller.connectCalls.push({ convId, includeThinking });
      currentListener = onEvent;
      return {
        close: () => {
          controller.closeCalls += 1;
        },
      };
    },
  };
  return controller;
}

function messageEvent(index: number, overrides: Partial<ChatMessageData> = {}): ConversationStreamEvent {
  return {
    type: "message",
    message: {
      index,
      role: "assistant",
      kind: "text",
      text: "hello",
      timestamp: "2026-07-10T00:00:00Z",
      toolName: null,
      truncated: false,
      ...overrides,
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mountChatPanel — list view", () => {
  it("shows an empty state when there are no conversations", async () => {
    const api = fakeApi({ getConversations: vi.fn(async () => []) });
    const panel = mountChatPanel(null, { api, win: fakeWindow() });
    await flush();

    expect(panel.element.querySelector(".wx-chat-empty")).not.toBeNull();
    panel.teardown();
  });

  it("renders a row per conversation with title and status", async () => {
    const api = fakeApi({
      getConversations: vi.fn(async () => [
        fakeConversation({ convId: "c1", title: "first", status: "ready" }),
        fakeConversation({ convId: "c2", title: "second", status: "pending" }),
      ]),
    });
    const panel = mountChatPanel(null, { api, win: fakeWindow() });
    await flush();

    const rows = panel.element.querySelectorAll(".wx-chat-list-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".wx-chat-list-title")?.textContent).toBe("first");
    expect(rows[1]?.querySelector(".wx-chat-list-note")?.textContent).toMatch(/starting/i);
    panel.teardown();
  });

  it("clicking a conversation title navigates to its detail route", async () => {
    const api = fakeApi({
      getConversations: vi.fn(async () => [fakeConversation({ convId: "abc" })]),
    });
    const win = fakeWindow();
    const panel = mountChatPanel(null, { api, win });
    await flush();

    const link = panel.element.querySelector<HTMLAnchorElement>(".wx-chat-list-title");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(win.location.pathname).toBe("/admin/chat/abc");
    panel.teardown();
  });

  it("stamps the narrow-viewport restack hooks: per-cell classes on list rows", async () => {
    const api = fakeApi({
      getConversations: vi.fn(async () => [fakeConversation({ convId: "c1", title: "first" })]),
    });
    const panel = mountChatPanel(null, { api, win: fakeWindow() });
    await flush();

    // The ≤720px stylesheet hooks onto these classes to restack each row
    // (dot+title on the first line, timestamp under it — the pages/history
    // tables' pattern). The when cell's pre-existing wx-chat-list-when class
    // doubles as its hook.
    const row = panel.element.querySelector(".wx-chat-list-row");
    const cells = row?.querySelectorAll("td");
    expect(cells?.[0]?.className).toBe("wx-chat-cell-dot");
    expect(cells?.[1]?.className).toBe("wx-chat-cell-title");
    expect(cells?.[2]?.className).toBe("wx-chat-list-when");
    panel.teardown();
  });

  it("formats the list timestamp medium-date/short-time so it fits the narrow layout", async () => {
    const api = fakeApi({
      getConversations: vi.fn(async () => [fakeConversation({ convId: "c1" })]),
    });
    const panel = mountChatPanel(null, { api, win: fakeWindow() });
    await flush();

    const when = panel.element.querySelector(".wx-chat-list-when");
    expect(when?.textContent).toBe(
      new Date("2026-07-10T00:00:00Z").toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
    panel.teardown();
  });

  it("New conversation -> Start with no text creates without a first message and navigates", async () => {
    const createConversation = vi.fn(async () => fakeConversation({ convId: "new1", status: "pending" }));
    const api = fakeApi({ createConversation });
    const win = fakeWindow();
    const panel = mountChatPanel(null, { api, win });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-chat-new-button")?.click();
    const startButton = panel.element.querySelector<HTMLButtonElement>(
      ".wx-chat-compose-actions button",
    );
    startButton?.click();
    await flush();

    expect(createConversation).toHaveBeenCalledWith(undefined);
    expect(win.location.pathname).toBe("/admin/chat/new1");
    panel.teardown();
  });

  it("New conversation -> Start with text creates with that first message", async () => {
    const createConversation = vi.fn(async () => fakeConversation({ convId: "new2" }));
    const api = fakeApi({ createConversation });
    const panel = mountChatPanel(null, { api, win: fakeWindow() });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-chat-new-button")?.click();
    const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-compose-input");
    expect(textarea).not.toBeNull();
    if (textarea) textarea.value = "please fix the hero title";
    panel.element.querySelector<HTMLButtonElement>(".wx-chat-compose-actions button")?.click();
    await flush();

    expect(createConversation).toHaveBeenCalledWith("please fix the hero title");
    panel.teardown();
  });

  it("Cancel hides the compose box without creating anything", async () => {
    const createConversation = vi.fn();
    const api = fakeApi({ createConversation });
    const panel = mountChatPanel(null, { api, win: fakeWindow() });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-chat-new-button")?.click();
    const [, cancelButton] = panel.element.querySelectorAll<HTMLButtonElement>(
      ".wx-chat-compose-actions button",
    );
    cancelButton?.click();

    expect(panel.element.querySelector<HTMLElement>(".wx-chat-compose-box")?.hidden).toBe(true);
    expect(createConversation).not.toHaveBeenCalled();
    panel.teardown();
  });

  it("polls the conversation list on an interval while mounted, and stops after teardown", async () => {
    vi.useFakeTimers();
    try {
      const getConversations = vi.fn(async () => []);
      const api = fakeApi({ getConversations });
      const panel = mountChatPanel(null, { api, win: fakeWindow() });
      await flush();
      expect(getConversations).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(getConversations).toHaveBeenCalledTimes(2);

      panel.teardown();
      await vi.advanceTimersByTimeAsync(4000);
      expect(getConversations).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mountChatPanel — conversation view", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects the stream for the given conversation id on mount", async () => {
    const stream = fakeStreamController();
    const api = fakeApi({ getConversations: vi.fn(async () => [fakeConversation({ convId: "c1" })]) });
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    expect(stream.connectCalls).toEqual([{ convId: "c1", includeThinking: false }]);
    panel.teardown();
  });

  it("renders a text message as a markdown bubble", async () => {
    const stream = fakeStreamController();
    const api = fakeApi();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    stream.emit(messageEvent(0, { text: "**bold** reply" }));

    const bubble = panel.element.querySelector(".wx-chat-bubble-assistant");
    expect(bubble?.querySelector("strong")?.textContent).toBe("bold");
    panel.teardown();
  });

  it("groups contiguous tool_use/tool_result messages into one collapsed row", async () => {
    const stream = fakeStreamController();
    const api = fakeApi();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    stream.emit(messageEvent(0, { kind: "tool_use", toolName: "Edit", text: "editing file.ts" }));
    stream.emit(messageEvent(1, { kind: "tool_result", text: "ok" }));
    stream.emit(messageEvent(2, { kind: "text", text: "done" }));

    const toolRows = panel.element.querySelectorAll(".wx-chat-tool-row");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]?.querySelector(".wx-chat-tool-summary")?.textContent).toBe("⚙ 2 actions");
    const details = toolRows[0]?.querySelector<HTMLElement>(".wx-chat-tool-details");
    expect(details?.hidden).toBe(true);
    toolRows[0]?.querySelector<HTMLButtonElement>(".wx-chat-tool-summary")?.click();
    expect(details?.hidden).toBe(false);

    const bubbles = panel.element.querySelectorAll(".wx-chat-bubble");
    expect(bubbles).toHaveLength(1);
    panel.teardown();
  });

  it("hides thinking messages by default", async () => {
    const stream = fakeStreamController();
    const api = fakeApi();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    stream.emit(messageEvent(0, { kind: "thinking", text: "pondering" }));
    stream.emit(messageEvent(1, { kind: "text", text: "the answer" }));

    expect(panel.element.querySelectorAll(".wx-chat-bubble")).toHaveLength(1);
    panel.teardown();
  });

  it("shows the offline banner on an error event and clears it on the next message", async () => {
    const stream = fakeStreamController();
    const api = fakeApi();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    stream.emit({ type: "error", detail: "cmd unreachable" });
    expect(panel.element.querySelector<HTMLElement>(".wx-chat-offline-banner")?.hidden).toBe(false);

    stream.emit(messageEvent(0));
    expect(panel.element.querySelector<HTMLElement>(".wx-chat-offline-banner")?.hidden).toBe(true);
    panel.teardown();
  });

  it("send posts the composer text with a fresh idempotency key and clears the input", async () => {
    const sendMessage = vi.fn(async () => ({ accepted: true, buffered: false }));
    const api = fakeApi({ sendMessage });
    const stream = fakeStreamController();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
    if (textarea) textarea.value = "hello there";
    panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
    await flush();

    expect(sendMessage).toHaveBeenCalledWith("c1", "hello there", "c1:test-uuid");
    expect(textarea?.value).toBe("");
    panel.teardown();
  });

  it("Enter sends; Shift+Enter does not", async () => {
    const sendMessage = vi.fn(async () => ({ accepted: true, buffered: false }));
    const api = fakeApi({ sendMessage });
    const stream = fakeStreamController();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
    if (textarea) textarea.value = "shift-enter text";
    textarea?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();

    if (textarea) textarea.value = "plain enter text";
    textarea?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true, cancelable: true }),
    );
    await flush();
    expect(sendMessage).toHaveBeenCalledWith("c1", "plain enter text", "c1:test-uuid");
    panel.teardown();
  });

  it("shows a bubble-level error and re-enables the composer on a failed send", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("couldn't deliver: timeout");
    });
    const api = fakeApi({ sendMessage });
    const stream = fakeStreamController();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
    if (textarea) textarea.value = "hello";
    panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
    await flush();

    const error = panel.element.querySelector<HTMLElement>(".wx-chat-composer-error");
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe("couldn't deliver: timeout");
    expect(panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.disabled).toBe(false);
    expect(textarea?.value).toBe("hello"); // kept, per spec/06 3's "composer keeps the text"
    panel.teardown();
  });

  it("a retry after a failed send reuses the same idempotency key; a new message after success gets a fresh one", async () => {
    let uuidCounter = 0;
    const win = fakeWindow({ crypto: { randomUUID: () => `uuid-${++uuidCounter}` } });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("couldn't deliver: timeout"))
      .mockResolvedValueOnce({ accepted: true, buffered: false })
      .mockResolvedValueOnce({ accepted: true, buffered: false });
    const api = fakeApi({ sendMessage });
    const stream = fakeStreamController();
    const panel = mountChatPanel("c1", { api, win, openStream: stream.openStream });
    await flush();

    const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
    const sendButton = panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button");

    if (textarea) textarea.value = "first attempt";
    sendButton?.click();
    await flush();
    expect(sendMessage).toHaveBeenNthCalledWith(1, "c1", "first attempt", "c1:uuid-1");

    // Retrying the SAME failed message must reuse the SAME key (spec/06 3:
    // "manual retry with the same idempotency key") -- not mint a new one.
    if (textarea) textarea.value = "first attempt";
    sendButton?.click();
    await flush();
    expect(sendMessage).toHaveBeenNthCalledWith(2, "c1", "first attempt", "c1:uuid-1");

    // A genuinely new message composed after a SUCCESSFUL send gets a fresh key.
    if (textarea) textarea.value = "second message";
    sendButton?.click();
    await flush();
    expect(sendMessage).toHaveBeenNthCalledWith(3, "c1", "second message", "c1:uuid-2");

    panel.teardown();
  });

  it("rename prompts, calls the API, and updates the shown title", async () => {
    const renameConversation = vi.fn(async () => fakeConversation({ title: "new title" }));
    const api = fakeApi({ renameConversation });
    const win = fakeWindow({ prompt: vi.fn(() => "new title") });
    const stream = fakeStreamController();
    const panel = mountChatPanel("c1", { api, win, openStream: stream.openStream });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-chat-rename-button")?.click();
    await flush();

    expect(renameConversation).toHaveBeenCalledWith("c1", "new title");
    expect(panel.element.querySelector(".wx-chat-conversation-title")?.textContent).toBe("new title");
    panel.teardown();
  });

  it("the show-reasoning toggle reconnects the stream with includeThinking and reveals thinking messages", async () => {
    const stream = fakeStreamController();
    const api = fakeApi();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    stream.emit(messageEvent(0, { kind: "thinking", text: "pondering" }));
    expect(panel.element.querySelectorAll(".wx-chat-bubble")).toHaveLength(0);

    panel.element.querySelector<HTMLButtonElement>(".wx-chat-reasoning-toggle")?.click();
    expect(stream.connectCalls.at(-1)).toEqual({ convId: "c1", includeThinking: true });
    expect(stream.closeCalls).toBe(1);

    stream.emit(messageEvent(0, { kind: "thinking", text: "pondering" }));
    expect(panel.element.querySelectorAll(".wx-chat-bubble")).toHaveLength(1);
    panel.teardown();
  });

  it("shows the preview-updated chip once an assistant message triggers an upstream check that finds commits", async () => {
    const getState = vi.fn(async () => fakeState({ upstream: { aheadOfPublished: [
      { sha: "a".repeat(40), subject: "AI: tweak copy", author: "agent", when: "2026-07-10T00:00:00Z" },
    ], fetchedAt: "2026-07-10T00:00:00Z" } }));
    const api = fakeApi({ getState });
    const stream = fakeStreamController();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    expect(panel.element.querySelector<HTMLElement>(".wx-chat-preview-chip")?.hidden).toBe(true);
    stream.emit(messageEvent(0, { role: "assistant", text: "shipped it" }));
    await flush();

    expect(getState).toHaveBeenCalled();
    expect(panel.element.querySelector<HTMLElement>(".wx-chat-preview-chip")?.hidden).toBe(false);
    panel.teardown();
  });

  it("does not check upstream on the owner's own messages", async () => {
    const getState = vi.fn(async () => fakeState());
    const api = fakeApi({ getState });
    const stream = fakeStreamController();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();
    getState.mockClear();

    stream.emit(messageEvent(0, { role: "user", text: "please fix this" }));
    await flush();

    expect(getState).not.toHaveBeenCalled();
    panel.teardown();
  });

  it("teardown closes the stream", async () => {
    const stream = fakeStreamController();
    const api = fakeApi();
    const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
    await flush();

    panel.teardown();
    expect(stream.closeCalls).toBe(1);
  });
});
