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
    working: false,
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
    adminSections: [],
    chatAttachmentsSupported: false,
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
    uploadChatAttachment: vi.fn(async () => ({ attachmentId: "att-1", width: 640, height: 480 })),
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

function statusEvent(activity: string | null): ConversationStreamEvent {
  return { type: "status", status: { activity, processKind: "cli", handoverState: null } };
}

function tasksEvent(
  tasks: Array<{ label: string; status: "pending" | "doing" | "done" }>,
  messageIndex = 0,
): ConversationStreamEvent {
  return { type: "tasks", tasks, messageIndex };
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

  it("a working ready conversation pulses its dot and notes it in the title", async () => {
    const api = fakeApi({
      getConversations: vi.fn(async () => [
        fakeConversation({ convId: "c1", title: "idle one", status: "ready", working: false }),
        fakeConversation({ convId: "c2", title: "busy one", status: "ready", working: true }),
      ]),
    });
    const panel = mountChatPanel(null, { api, win: fakeWindow() });
    await flush();

    const rows = panel.element.querySelectorAll(".wx-chat-list-row");
    expect(rows[0]?.querySelector(".wx-chat-dot")?.className).toBe("wx-chat-dot wx-chat-dot-ready");
    expect(rows[0]?.querySelector(".wx-chat-list-note")).toBeNull();
    expect(rows[1]?.querySelector(".wx-chat-dot")?.className).toBe(
      "wx-chat-dot wx-chat-dot-ready wx-chat-dot-working",
    );
    expect(rows[1]?.querySelector(".wx-chat-list-note")?.textContent).toMatch(/working/i);
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

    expect(createConversation).toHaveBeenCalledWith(undefined, undefined);
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

    expect(createConversation).toHaveBeenCalledWith("please fix the hero title", undefined);
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

    expect(sendMessage).toHaveBeenCalledWith("c1", "hello there", "c1:test-uuid", []);
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
    expect(sendMessage).toHaveBeenCalledWith("c1", "plain enter text", "c1:test-uuid", []);
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
    expect(sendMessage).toHaveBeenNthCalledWith(1, "c1", "first attempt", "c1:uuid-1", []);

    // Retrying the SAME failed message must reuse the SAME key (spec/06 3:
    // "manual retry with the same idempotency key") -- not mint a new one.
    if (textarea) textarea.value = "first attempt";
    sendButton?.click();
    await flush();
    expect(sendMessage).toHaveBeenNthCalledWith(2, "c1", "first attempt", "c1:uuid-1", []);

    // A genuinely new message composed after a SUCCESSFUL send gets a fresh key.
    if (textarea) textarea.value = "second message";
    sendButton?.click();
    await flush();
    expect(sendMessage).toHaveBeenNthCalledWith(3, "c1", "second message", "c1:uuid-2", []);

    panel.teardown();
  });

  describe("image attachments (decisions/00103)", () => {
    function pngFile(name = "photo.png"): File {
      return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
    }

    it("the attach button stays hidden when the backend doesn't support attachments", async () => {
      const api = fakeApi({ getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: false })) });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      expect(panel.element.querySelector<HTMLElement>(".wx-chat-attach-button")?.hidden).toBe(true);
      panel.teardown();
    });

    it("the attach button appears once the backend's support is confirmed", async () => {
      const api = fakeApi({ getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })) });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      expect(panel.element.querySelector<HTMLElement>(".wx-chat-attach-button")?.hidden).toBe(false);
      panel.teardown();
    });

    it("picking a file via the attach input uploads it and renders a chip", async () => {
      const uploadChatAttachment = vi.fn(async () => ({ attachmentId: "att-1", width: 640, height: 480 }));
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        uploadChatAttachment,
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const file = pngFile();
      const fileInput = panel.element.querySelector<HTMLInputElement>('input[type="file"]');
      expect(fileInput).not.toBeNull();
      if (fileInput === null) throw new Error("expected a file input");
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      expect(uploadChatAttachment).toHaveBeenCalledWith("c1", file);
      const chips = panel.element.querySelectorAll(".wx-chat-attachment-chip");
      expect(chips).toHaveLength(1);
      expect(panel.element.querySelector<HTMLElement>(".wx-chat-attachment-row")?.hidden).toBe(false);
      panel.teardown();
    });

    it("pasting an image into the composer uploads it instead of inserting text", async () => {
      const uploadChatAttachment = vi.fn(async () => ({ attachmentId: "att-2", width: 100, height: 100 }));
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        uploadChatAttachment,
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const file = pngFile("pasted.png");
      const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
      const pasteEvent = Object.assign(new Event("paste", { cancelable: true }), {
        clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
      });
      textarea?.dispatchEvent(pasteEvent);
      await flush();

      expect(uploadChatAttachment).toHaveBeenCalledWith("c1", file);
      expect(panel.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(1);
      panel.teardown();
    });

    it("a text paste with no image data is left alone", async () => {
      const uploadChatAttachment = vi.fn();
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        uploadChatAttachment,
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
      const pasteEvent = Object.assign(new Event("paste", { cancelable: true }), {
        clipboardData: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] },
      });
      textarea?.dispatchEvent(pasteEvent);
      await flush();

      expect(uploadChatAttachment).not.toHaveBeenCalled();
      panel.teardown();
    });

    it("dropping a file onto the composer uploads it", async () => {
      const uploadChatAttachment = vi.fn(async () => ({ attachmentId: "att-3", width: 50, height: 50 }));
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        uploadChatAttachment,
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const file = pngFile("dropped.png");
      const composer = panel.element.querySelector(".wx-chat-composer");
      const dropEvent = Object.assign(new Event("drop"), { dataTransfer: { files: [file] } });
      composer?.dispatchEvent(dropEvent);
      await flush();

      expect(uploadChatAttachment).toHaveBeenCalledWith("c1", file);
      panel.teardown();
    });

    it("Send is disabled while an attachment is still uploading, and re-enabled once it resolves", async () => {
      let resolveUpload!: (value: { attachmentId: string; width: number; height: number }) => void;
      const uploadChatAttachment = vi.fn(
        () => new Promise<{ attachmentId: string; width: number; height: number }>((resolve) => {
          resolveUpload = resolve;
        }),
      );
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        uploadChatAttachment,
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const fileInput = panel.element.querySelector<HTMLInputElement>('input[type="file"]');
      if (fileInput === null) throw new Error("expected a file input");
      Object.defineProperty(fileInput, "files", { value: [pngFile()], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      const sendButton = panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button");
      expect(sendButton?.disabled).toBe(true);

      resolveUpload({ attachmentId: "att-4", width: 10, height: 10 });
      await flush();
      expect(sendButton?.disabled).toBe(false);
      panel.teardown();
    });

    it("a failed upload drops the chip and shows an error, without blocking further sends", async () => {
      const uploadChatAttachment = vi.fn(async () => {
        throw new Error("image exceeds the 5MB limit");
      });
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        uploadChatAttachment,
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const fileInput = panel.element.querySelector<HTMLInputElement>('input[type="file"]');
      if (fileInput === null) throw new Error("expected a file input");
      Object.defineProperty(fileInput, "files", { value: [pngFile()], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      expect(panel.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(0);
      const error = panel.element.querySelector<HTMLElement>(".wx-chat-composer-error");
      expect(error?.hidden).toBe(false);
      expect(error?.textContent).toBe("image exceeds the 5MB limit");
      expect(panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.disabled).toBe(false);
      panel.teardown();
    });

    it("removing a pending attachment via its chip drops it before send", async () => {
      const uploadChatAttachment = vi.fn(async () => ({ attachmentId: "att-5", width: 20, height: 20 }));
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        uploadChatAttachment,
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const fileInput = panel.element.querySelector<HTMLInputElement>('input[type="file"]');
      if (fileInput === null) throw new Error("expected a file input");
      Object.defineProperty(fileInput, "files", { value: [pngFile()], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();
      expect(panel.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(1);

      panel.element.querySelector<HTMLButtonElement>(".wx-chat-attachment-remove")?.click();
      expect(panel.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(0);
      expect(panel.element.querySelector<HTMLElement>(".wx-chat-attachment-row")?.hidden).toBe(true);
      panel.teardown();
    });

    it("send includes the uploaded attachment ids and clears the chips after a successful send", async () => {
      const uploadChatAttachment = vi.fn(async () => ({ attachmentId: "att-6", width: 30, height: 30 }));
      const sendMessage = vi.fn(async () => ({ accepted: true, buffered: false }));
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        uploadChatAttachment,
        sendMessage,
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const fileInput = panel.element.querySelector<HTMLInputElement>('input[type="file"]');
      if (fileInput === null) throw new Error("expected a file input");
      Object.defineProperty(fileInput, "files", { value: [pngFile()], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();

      expect(sendMessage).toHaveBeenCalledWith("c1", "", "c1:test-uuid", ["att-6"]);
      expect(panel.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(0);
      panel.teardown();
    });

    it("an image-only send (no text) is allowed once an attachment is staged", async () => {
      const uploadChatAttachment = vi.fn(async () => ({ attachmentId: "att-7", width: 30, height: 30 }));
      const sendMessage = vi.fn(async () => ({ accepted: true, buffered: false }));
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        uploadChatAttachment,
        sendMessage,
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const fileInput = panel.element.querySelector<HTMLInputElement>('input[type="file"]');
      if (fileInput === null) throw new Error("expected a file input");
      Object.defineProperty(fileInput, "files", { value: [pngFile()], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      // No text typed at all -- with zero attachments this would be a no-op
      // (the early-return guard in send()); with one staged, it must go through.
      panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();

      expect(sendMessage).toHaveBeenCalledTimes(1);
      panel.teardown();
    });
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

  describe("the work banner and task card (decisions/00097)", () => {
    it("is hidden with no activity, no tasks, and nothing awaiting reply", async () => {
      const stream = fakeStreamController();
      const api = fakeApi();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      expect(panel.element.querySelector<HTMLElement>(".wx-chat-work-banner")?.hidden).toBe(true);
      panel.teardown();
    });

    it("shows a generic working state from cmd's own activity alone (no task block yet)", async () => {
      const stream = fakeStreamController();
      const api = fakeApi();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(statusEvent("active"));

      const banner = panel.element.querySelector<HTMLElement>(".wx-chat-work-banner");
      expect(banner?.hidden).toBe(false);
      expect(banner?.className).toContain("wx-chat-work-banner-working");
      expect(banner?.textContent).toMatch(/thinking/i);
      panel.teardown();
    });

    it("names the task list once one exists, and hides the generic wording", async () => {
      const stream = fakeStreamController();
      const api = fakeApi();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(tasksEvent([{ label: "Add the FAQ link", status: "doing" }]));

      const banner = panel.element.querySelector<HTMLElement>(".wx-chat-work-banner");
      expect(banner?.hidden).toBe(false);
      expect(banner?.textContent).toMatch(/working on your tasks/i);
      panel.teardown();
    });

    it("renders the task card with a done count and a spinner icon for the doing task", async () => {
      const stream = fakeStreamController();
      const api = fakeApi();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(
        tasksEvent([
          { label: "Read the current menu", status: "done" },
          { label: "Add the FAQ link", status: "doing" },
          { label: "Check the preview", status: "pending" },
        ]),
      );

      const card = panel.element.querySelector<HTMLElement>(".wx-chat-tasks");
      expect(card?.hidden).toBe(false);
      expect(card?.querySelector(".wx-chat-tasks-header")?.textContent).toBe("Tasks · 1 of 3 done");
      const rows = card?.querySelectorAll(".wx-chat-task") ?? [];
      expect(rows).toHaveLength(3);
      expect(rows[0]?.className).toContain("wx-chat-task-done");
      expect(rows[1]?.className).toContain("wx-chat-task-doing");
      expect(rows[1]?.querySelector(".wx-spinner")).not.toBeNull();
      expect(rows[2]?.className).toContain("wx-chat-task-pending");
      panel.teardown();
    });

    it("shows the all-done state once every task is done and activity has gone quiet", async () => {
      const stream = fakeStreamController();
      const api = fakeApi();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(tasksEvent([{ label: "Add the FAQ link", status: "done" }]));

      const banner = panel.element.querySelector<HTMLElement>(".wx-chat-work-banner");
      expect(banner?.hidden).toBe(false);
      expect(banner?.className).toContain("wx-chat-work-banner-done");
      expect(banner?.textContent).toMatch(/all tasks completed/i);
      panel.teardown();
    });

    it("re-emitting the block with an updated status keeps the banner in the working state", async () => {
      const stream = fakeStreamController();
      const api = fakeApi();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(tasksEvent([{ label: "Add the FAQ link", status: "doing" }]));
      let banner = panel.element.querySelector<HTMLElement>(".wx-chat-work-banner");
      expect(banner?.className).toContain("wx-chat-work-banner-working");

      stream.emit(tasksEvent([{ label: "Add the FAQ link", status: "done" }]));
      banner = panel.element.querySelector<HTMLElement>(".wx-chat-work-banner");
      expect(banner?.className).toContain("wx-chat-work-banner-done");
      panel.teardown();
    });

    it("awaitingReply covers the gap between a successful send and the first stream event", async () => {
      const sendMessage = vi.fn(async () => ({ accepted: true, buffered: false }));
      const api = fakeApi({ sendMessage });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
      if (textarea) textarea.value = "please fix the hero title";
      panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();

      // Nothing from the stream yet (no status/tasks/message) — awaitingReply
      // alone is what's carrying the working state here.
      let banner = panel.element.querySelector<HTMLElement>(".wx-chat-work-banner");
      expect(banner?.hidden).toBe(false);
      expect(banner?.textContent).toMatch(/thinking/i);

      // The assistant's own reply lands — awaitingReply must clear so a
      // later quiet period doesn't keep the banner stuck on "working"
      // forever.
      stream.emit(messageEvent(1, { role: "assistant", text: "Done." }));
      banner = panel.element.querySelector<HTMLElement>(".wx-chat-work-banner");
      expect(banner?.hidden).toBe(true);
      panel.teardown();
    });

    it("sending a new message after all-done clears the stale task card and dismisses the banner state", async () => {
      const sendMessage = vi.fn(async () => ({ accepted: true, buffered: false }));
      const api = fakeApi({ sendMessage });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(tasksEvent([{ label: "Add the FAQ link", status: "done" }]));
      expect(
        panel.element.querySelector<HTMLElement>(".wx-chat-work-banner")?.className,
      ).toContain("wx-chat-work-banner-done");

      const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
      if (textarea) textarea.value = "now change the footer too";
      panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();

      expect(panel.element.querySelector<HTMLElement>(".wx-chat-tasks")?.hidden).toBe(true);
      const banner = panel.element.querySelector<HTMLElement>(".wx-chat-work-banner");
      expect(banner?.className).toContain("wx-chat-work-banner-working");
      expect(banner?.textContent).toMatch(/thinking/i);
      panel.teardown();
    });

    it("hides the working state the instant a new status event reports cmd has gone idle", async () => {
      // decisions/00099: `activity` is cmd's own ENUM ("active" | "idle" |
      // "done" | "unknown", decisions/00100 — an earlier version of this
      // fix used "working" here, a guess from spec prose never confirmed
      // against real cmd), not a timestamp — there is no freshness window to
      // age out on a timer any more; the banner reacts the moment a fresh
      // status event says "idle" (spec/06 §1's stream already polls cmd
      // every 1.2s and pushes a diffed event on every real change).
      const stream = fakeStreamController();
      const api = fakeApi();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(statusEvent("active"));
      expect(panel.element.querySelector<HTMLElement>(".wx-chat-work-banner")?.hidden).toBe(false);

      stream.emit(statusEvent("idle"));
      expect(panel.element.querySelector<HTMLElement>(".wx-chat-work-banner")?.hidden).toBe(true);
      panel.teardown();
    });
  });
});

describe("mountChatPanel — decisions/00110 chat experience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the optimistic echo", () => {
    it("a sent message paints instantly as a dimmed 'sending…' bubble, replaced when the server copy arrives", async () => {
      const sendMessage = vi.fn(async () => ({ accepted: true, buffered: false }));
      const api = fakeApi({ sendMessage });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
      if (textarea) textarea.value = "make the hero warmer";
      panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();

      // The echo is there IMMEDIATELY — before any stream event.
      const echo = panel.element.querySelector<HTMLElement>(".wx-chat-echo");
      expect(echo).not.toBeNull();
      expect(echo?.textContent).toContain("make the hero warmer");
      expect(echo?.textContent).toContain("sending…");

      // The server copy streams in — the echo is reconciled away, leaving the
      // one real bubble.
      stream.emit(messageEvent(0, { role: "user", text: "make the hero warmer" }));
      expect(panel.element.querySelector(".wx-chat-echo")).toBeNull();
      const userBubbles = panel.element.querySelectorAll(".wx-chat-bubble-user");
      expect(userBubbles).toHaveLength(1);
      panel.teardown();
    });

    it("a failed send removes the echo but keeps the composer text for the retry", async () => {
      const sendMessage = vi.fn(async () => {
        throw new Error("couldn't deliver: timeout");
      });
      const api = fakeApi({ sendMessage });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
      if (textarea) textarea.value = "please try";
      panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();

      expect(panel.element.querySelector(".wx-chat-echo")).toBeNull();
      expect(textarea?.value).toBe("please try");
      expect(panel.element.querySelector<HTMLElement>(".wx-chat-composer-error")?.hidden).toBe(false);
      panel.teardown();
    });

    it("an echo that no server message matches expires rather than duplicating forever", async () => {
      const sendMessage = vi.fn(async () => ({ accepted: true, buffered: false }));
      const api = fakeApi({ sendMessage });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input");
      if (textarea) textarea.value = "lost message";
      panel.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
      await flush();
      expect(panel.element.querySelector(".wx-chat-echo")).not.toBeNull();

      // 31s with no matching server copy (fake timers) + any render trigger.
      await vi.advanceTimersByTimeAsync(31_000);
      stream.emit(messageEvent(0, { role: "assistant", text: "something else" }));
      expect(panel.element.querySelector(".wx-chat-echo")).toBeNull();
      panel.teardown();
    });
  });

  describe("transcript attachment thumbnails", () => {
    it("a message carrying attachments renders thumbs from the bytes proxy, never the raw path", async () => {
      const api = fakeApi();
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(
        messageEvent(0, {
          role: "user",
          text: "what do you see?",
          attachments: [{ uploadId: "u-1", name: "converted.webp", width: 800, height: 600 }],
        }),
      );

      const bubble = panel.element.querySelector<HTMLElement>(".wx-chat-bubble-user");
      expect(bubble?.textContent).toContain("what do you see?");
      const thumb = bubble?.querySelector<HTMLImageElement>(".wx-chat-att-thumb img");
      expect(thumb?.src).toContain("/api/admin/chat/uploads/u-1/bytes");
      panel.teardown();
    });

    it("tapping a thumb opens the lightbox; backdrop, ✕, and Esc each close it", async () => {
      const api = fakeApi();
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(
        messageEvent(0, {
          role: "user",
          text: "see this",
          attachments: [{ uploadId: "u-2", name: "converted.webp", width: 10, height: 10 }],
        }),
      );

      const thumbButton = panel.element.querySelector<HTMLButtonElement>(".wx-chat-att-thumb");
      expect(thumbButton).not.toBeNull();

      // Open.
      thumbButton?.click();
      let lightbox = document.body.querySelector<HTMLElement>(".wx-chat-lightbox");
      expect(lightbox).not.toBeNull();
      expect(lightbox?.querySelector("img")?.src).toContain("/api/admin/chat/uploads/u-2/bytes");

      // Esc closes.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(document.body.querySelector(".wx-chat-lightbox")).toBeNull();

      // Re-open; the close button closes.
      thumbButton?.click();
      lightbox = document.body.querySelector<HTMLElement>(".wx-chat-lightbox");
      expect(lightbox).not.toBeNull();
      lightbox?.querySelector<HTMLButtonElement>(".wx-chat-lightbox-close")?.click();
      expect(document.body.querySelector(".wx-chat-lightbox")).toBeNull();

      // Re-open; a backdrop click closes (a click on the image does not).
      thumbButton?.click();
      lightbox = document.body.querySelector<HTMLElement>(".wx-chat-lightbox");
      lightbox?.querySelector("img")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(document.body.querySelector(".wx-chat-lightbox")).not.toBeNull();
      lightbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(document.body.querySelector(".wx-chat-lightbox")).toBeNull();
      panel.teardown();
    });

    it("teardown closes an open lightbox", async () => {
      const api = fakeApi();
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      stream.emit(
        messageEvent(0, {
          role: "user",
          text: "x",
          attachments: [{ uploadId: "u-3", name: null, width: null, height: null }],
        }),
      );
      panel.element.querySelector<HTMLButtonElement>(".wx-chat-att-thumb")?.click();
      expect(document.body.querySelector(".wx-chat-lightbox")).not.toBeNull();

      panel.teardown();
      expect(document.body.querySelector(".wx-chat-lightbox")).toBeNull();
    });
  });

  describe("the list view's New conversation box (shared composer)", () => {
    it("attaches an image before starting and forwards the ids on create", async () => {
      const stageChatUpload = vi.fn(async () => ({ attachmentId: "att-new-1", width: 10, height: 10 }));
      const createConversation = vi.fn(async () => fakeConversation({ convId: "new9" }));
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        stageChatUpload,
        createConversation,
      });
      const panel = mountChatPanel(null, { api, win: fakeWindow() });
      await flush();

      panel.element.querySelector<HTMLButtonElement>(".wx-chat-new-button")?.click();
      await flush(); // getState resolves -> attach button appears

      const attachButton = panel.element.querySelector<HTMLElement>(".wx-chat-attach-button");
      expect(attachButton?.hidden).toBe(false);

      const fileInput = panel.element.querySelector<HTMLInputElement>('.wx-chat-compose-box input[type="file"]');
      expect(fileInput).not.toBeNull();
      const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
      Object.defineProperty(fileInput!, "files", { value: [file], configurable: true });
      fileInput!.dispatchEvent(new Event("change"));
      await flush();

      expect(stageChatUpload).toHaveBeenCalledWith(file);
      expect(panel.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(1);

      const textarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-chat-compose-input");
      if (textarea) textarea.value = "what is in this photo?";
      panel.element.querySelector<HTMLButtonElement>(".wx-chat-compose-actions button")?.click();
      await flush();

      expect(createConversation).toHaveBeenCalledWith("what is in this photo?", ["att-new-1"]);
      panel.teardown();
    });

    it("an image-only start (no text) creates with attachments and no first message", async () => {
      const stageChatUpload = vi.fn(async () => ({ attachmentId: "att-new-2", width: 10, height: 10 }));
      const createConversation = vi.fn(async () => fakeConversation({ convId: "new10" }));
      const api = fakeApi({
        getState: vi.fn(async () => fakeState({ chatAttachmentsSupported: true })),
        stageChatUpload,
        createConversation,
      });
      const panel = mountChatPanel(null, { api, win: fakeWindow() });
      await flush();

      panel.element.querySelector<HTMLButtonElement>(".wx-chat-new-button")?.click();
      await flush();

      const fileInput = panel.element.querySelector<HTMLInputElement>('.wx-chat-compose-box input[type="file"]');
      const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
      Object.defineProperty(fileInput!, "files", { value: [file], configurable: true });
      fileInput!.dispatchEvent(new Event("change"));
      await flush();

      panel.element.querySelector<HTMLButtonElement>(".wx-chat-compose-actions button")?.click();
      await flush();

      expect(createConversation).toHaveBeenCalledWith(undefined, ["att-new-2"]);
      panel.teardown();
    });
  });

  describe("the thread's empty state", () => {
    it("reads as starting-up while the conversation is still provisioning", async () => {
      const api = fakeApi({
        getConversations: vi.fn(async () => [fakeConversation({ convId: "c1", status: "pending" })]),
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      expect(panel.element.querySelector(".wx-chat-thread")?.textContent).toMatch(/starting your conversation/i);
      panel.teardown();
    });

    it("invites the first message once ready", async () => {
      const api = fakeApi({
        getConversations: vi.fn(async () => [fakeConversation({ convId: "c1", status: "ready" })]),
      });
      const stream = fakeStreamController();
      const panel = mountChatPanel("c1", { api, win: fakeWindow(), openStream: stream.openStream });
      await flush();

      expect(panel.element.querySelector(".wx-chat-thread")?.textContent).toMatch(/no messages yet/i);
      panel.teardown();
    });
  });
});
