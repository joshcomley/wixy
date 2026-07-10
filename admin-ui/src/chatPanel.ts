// The `#/chat` (list) and `#/chat/<conv>` (conversation) views (spec/05-editor.md
// §6, spec/06-ai-chat.md §1). `shell.ts` remounts this fresh whenever the route's
// `conversation` id changes (router.ts's `sameRoute` already treats a different
// conversation id as a different route) — this module owns no hash-routing of its
// own, just "render whichever one view the current conversation id calls for."
//
// Scope notes (decide-small-things-yourself calls, see decisions/NNNNN):
// - The list view's status dot reflects `ConversationSummary.status` (pending/
//   ready/failed) only — NOT a live working/idle indicator. spec/06 §1 says the
//   list shows status "from the poll cache," which would need a cross-stream
//   activity cache on the server (no such cache exists — building one is a real,
//   separable backend extension, not built this slice). The OPEN conversation's
//   own status strip DOES show live working/idle, driven by that conversation's
//   own open stream, which is the clearly-specified, unambiguous part of spec/06
//   §1's UI mapping.
// - The "Preview updated" chip (spec/05 §6) links to `#/pages`, not a specific
//   page — commit metadata alone (sha/subject/author/when) doesn't attribute
//   which page(s) changed, and guessing wrong would be worse than a neutral link.

import type {
  AdminApi,
  ChatMessageData,
  ChatStatusData,
  ConversationStreamEvent,
  ConversationSummary,
} from "./api";
import { openConversationStream, type ConversationStreamHandle } from "./api";
import { renderMarkdown } from "./markdown";
import { navigateTo } from "./router";

export interface ChatPanelDeps {
  api: AdminApi;
  win?: Window;
  openStream?: (
    convId: string,
    onEvent: (event: ConversationStreamEvent) => void,
    includeThinking?: boolean,
  ) => ConversationStreamHandle;
}

export interface ChatPanel {
  element: HTMLElement;
  teardown(): void;
}

const LIST_POLL_MS = 2000;
const UPSTREAM_CHECK_THROTTLE_MS = 5000;
/** How fresh `ChatStatusData.activity` must be to show "working" rather than
 * "idle" — generous relative to the stream's own 1.2s poll cadence so a
 * couple of missed ticks don't flicker the indicator. */
const WORKING_FRESHNESS_MS = 10_000;

function formatWhen(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

function statusLabel(summary: ConversationSummary): string {
  if (summary.status === "pending") return "starting…";
  if (summary.status === "failed") return summary.failureMessage ?? "failed to start";
  return "";
}

function statusDotClass(summary: ConversationSummary): string {
  if (summary.status === "pending") return "wx-chat-dot-pending";
  if (summary.status === "failed") return "wx-chat-dot-failed";
  return "wx-chat-dot-ready";
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function mountConversationList(deps: ChatPanelDeps): ChatPanel {
  const { api } = deps;
  const win = deps.win ?? window;

  const root = document.createElement("div");
  root.className = "wx-chat-panel wx-chat-list-view";

  const header = document.createElement("div");
  header.className = "wx-chat-list-header";
  const heading = document.createElement("h2");
  heading.textContent = "Chat";
  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.className = "wx-chat-new-button";
  newButton.textContent = "New conversation";
  header.append(heading, newButton);
  root.appendChild(header);

  const composeBox = document.createElement("div");
  composeBox.className = "wx-chat-compose-box";
  composeBox.hidden = true;
  const composeInput = document.createElement("textarea");
  composeInput.className = "wx-chat-compose-input";
  composeInput.placeholder = "Optional first message… (or start with nothing)";
  composeInput.rows = 3;
  const composeActions = document.createElement("div");
  composeActions.className = "wx-chat-compose-actions";
  const startButton = document.createElement("button");
  startButton.type = "button";
  startButton.textContent = "Start";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  const composeError = document.createElement("span");
  composeError.className = "wx-chat-compose-error";
  composeError.hidden = true;
  composeActions.append(startButton, cancelButton, composeError);
  composeBox.append(composeInput, composeActions);
  root.appendChild(composeBox);

  const body = document.createElement("div");
  body.textContent = "Loading…";
  root.appendChild(body);

  let cancelled = false;
  let pollTimer: number | null = null;

  newButton.addEventListener("click", () => {
    composeBox.hidden = false;
    composeInput.value = "";
    composeError.hidden = true;
    composeInput.focus();
  });
  cancelButton.addEventListener("click", () => {
    composeBox.hidden = true;
  });
  startButton.addEventListener("click", () => {
    startButton.disabled = true;
    cancelButton.disabled = true;
    composeError.hidden = true;
    const text = composeInput.value.trim();
    api
      .createConversation(text === "" ? undefined : text)
      .then((summary) => {
        if (cancelled) return;
        navigateTo({ kind: "chat", conversation: summary.convId }, win);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        startButton.disabled = false;
        cancelButton.disabled = false;
        composeError.hidden = false;
        composeError.textContent =
          error instanceof Error ? error.message : "Couldn't start a new conversation.";
      });
  });

  function renderRows(conversations: ConversationSummary[]): void {
    body.innerHTML = "";
    if (conversations.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wx-chat-empty";
      empty.textContent = "No conversations yet — start one above.";
      body.appendChild(empty);
      return;
    }
    const table = document.createElement("table");
    table.className = "wx-chat-list-table";
    const tbody = document.createElement("tbody");
    for (const summary of conversations) {
      const row = document.createElement("tr");
      row.className = "wx-chat-list-row";

      const dotCell = document.createElement("td");
      const dot = document.createElement("span");
      dot.className = `wx-chat-dot ${statusDotClass(summary)}`;
      dot.title = statusLabel(summary) || "ready";
      dotCell.appendChild(dot);
      row.appendChild(dotCell);

      const titleCell = document.createElement("td");
      const link = document.createElement("a");
      link.className = "wx-chat-list-title";
      link.href = "#";
      link.textContent = summary.title;
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        navigateTo({ kind: "chat", conversation: summary.convId }, win);
      });
      titleCell.appendChild(link);
      if (summary.status !== "ready") {
        const note = document.createElement("span");
        note.className = "wx-chat-list-note";
        note.textContent = ` — ${statusLabel(summary)}`;
        titleCell.appendChild(note);
      }
      row.appendChild(titleCell);

      const whenCell = document.createElement("td");
      whenCell.className = "wx-chat-list-when";
      whenCell.textContent = formatWhen(summary.createdAt);
      row.appendChild(whenCell);

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  function load(): void {
    api
      .getConversations()
      .then((conversations) => {
        if (cancelled) return;
        renderRows(conversations);
      })
      .catch(() => {
        if (cancelled) return;
        body.textContent = "Couldn't load conversations.";
      });
  }

  load();
  pollTimer = setInterval(load, LIST_POLL_MS) as unknown as number;

  return {
    element: root,
    teardown(): void {
      cancelled = true;
      if (pollTimer !== null) clearInterval(pollTimer);
    },
  };
}

// ---------------------------------------------------------------------------
// Conversation (detail) view
// ---------------------------------------------------------------------------

type MessageGroup =
  | { kind: "single"; message: ChatMessageData }
  | { kind: "toolGroup"; messages: ChatMessageData[] };

/** Contiguous `tool_use`/`tool_result` runs collapse into one group (spec/06
 * §1: "contiguous tool_use/tool_result runs -> one collapsed '⚙ n actions'
 * row"); anything else (text/thinking/error) stays its own group and breaks
 * a run. */
function groupMessages(messages: ChatMessageData[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const message of messages) {
    const isTool = message.kind === "tool_use" || message.kind === "tool_result";
    const last = groups[groups.length - 1];
    if (isTool && last?.kind === "toolGroup") {
      last.messages.push(message);
      continue;
    }
    if (isTool) {
      groups.push({ kind: "toolGroup", messages: [message] });
      continue;
    }
    groups.push({ kind: "single", message });
  }
  return groups;
}

function renderToolGroup(messages: ChatMessageData[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "wx-chat-tool-row";
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "wx-chat-tool-summary";
  summary.textContent = `⚙ ${messages.length} action${messages.length === 1 ? "" : "s"}`;
  const details = document.createElement("pre");
  details.className = "wx-chat-tool-details";
  details.hidden = true;
  details.textContent = messages
    .map((m) => `[${m.kind}${m.toolName !== null ? ` ${m.toolName}` : ""}] ${m.text ?? ""}`)
    .join("\n\n");
  summary.addEventListener("click", () => {
    details.hidden = !details.hidden;
  });
  row.append(summary, details);
  return row;
}

function renderMessageRow(message: ChatMessageData): HTMLElement {
  if (message.kind === "error") {
    const row = document.createElement("div");
    row.className = "wx-chat-error-row";
    row.textContent = message.text ?? "An error occurred.";
    return row;
  }
  const row = document.createElement("div");
  row.className = `wx-chat-bubble wx-chat-bubble-${message.role === "user" ? "user" : "assistant"}`;
  const content = renderMarkdown(message.text ?? "");
  row.appendChild(content);
  const timestamp = document.createElement("span");
  timestamp.className = "wx-chat-bubble-timestamp";
  timestamp.textContent = formatWhen(message.timestamp);
  row.appendChild(timestamp);
  return row;
}

function activityState(status: ChatStatusData | null, now: () => number): "working" | "idle" {
  if (status === null || status.activity === null) return "idle";
  const parsed = new Date(status.activity).getTime();
  if (Number.isNaN(parsed)) return "idle";
  return now() - parsed < WORKING_FRESHNESS_MS ? "working" : "idle";
}

function mountConversationView(convId: string, deps: ChatPanelDeps): ChatPanel {
  const { api } = deps;
  const win = deps.win ?? window;
  const openStream = deps.openStream ?? openConversationStream;
  const now = (): number => Date.now();

  const root = document.createElement("div");
  root.className = "wx-chat-panel wx-chat-conversation-view";

  const header = document.createElement("div");
  header.className = "wx-chat-conversation-header";
  const backLink = document.createElement("a");
  backLink.href = "#";
  backLink.className = "wx-chat-back-link";
  backLink.textContent = "← All conversations";
  backLink.addEventListener("click", (evt) => {
    evt.preventDefault();
    navigateTo({ kind: "chat", conversation: null }, win);
  });
  const titleEl = document.createElement("span");
  titleEl.className = "wx-chat-conversation-title";
  titleEl.textContent = "Loading…";
  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.className = "wx-chat-rename-button";
  renameButton.textContent = "Rename";
  header.append(backLink, titleEl, renameButton);
  root.appendChild(header);

  const banner = document.createElement("p");
  banner.className = "wx-chat-banner";
  banner.textContent =
    "Changes the assistant ships land in your draft preview — review them in Edit, then press Publish.";
  root.appendChild(banner);

  const offlineBanner = document.createElement("div");
  offlineBanner.className = "wx-chat-offline-banner";
  offlineBanner.textContent = "Assistant offline — cmd isn't running. Retrying…";
  offlineBanner.hidden = true;
  root.appendChild(offlineBanner);

  const previewChip = document.createElement("a");
  previewChip.className = "wx-chat-preview-chip";
  previewChip.textContent = "Preview updated — review changes";
  previewChip.href = "#/pages";
  previewChip.hidden = true;
  previewChip.addEventListener("click", (evt) => {
    evt.preventDefault();
    navigateTo({ kind: "pages" }, win);
  });
  root.appendChild(previewChip);

  const statusStrip = document.createElement("div");
  statusStrip.className = "wx-chat-status-strip";
  statusStrip.hidden = true;
  root.appendChild(statusStrip);

  const reasoningToggle = document.createElement("button");
  reasoningToggle.type = "button";
  reasoningToggle.className = "wx-chat-reasoning-toggle";
  reasoningToggle.textContent = "Show reasoning";
  reasoningToggle.setAttribute("aria-pressed", "false");
  root.appendChild(reasoningToggle);

  const thread = document.createElement("div");
  thread.className = "wx-chat-thread";
  thread.textContent = "Loading…";
  root.appendChild(thread);

  const composer = document.createElement("div");
  composer.className = "wx-chat-composer";
  const composerInput = document.createElement("textarea");
  composerInput.className = "wx-chat-composer-input";
  composerInput.rows = 2;
  composerInput.placeholder = "Message the assistant… (Shift+Enter for a new line)";
  const composerError = document.createElement("span");
  composerError.className = "wx-chat-composer-error";
  composerError.hidden = true;
  const sendButton = document.createElement("button");
  sendButton.type = "button";
  sendButton.className = "wx-chat-send-button";
  sendButton.textContent = "Send";
  composer.append(composerInput, sendButton, composerError);
  root.appendChild(composer);

  let cancelled = false;
  let streamHandle: ConversationStreamHandle | null = null;
  let includeThinking = false;
  const messagesByIndex = new Map<number, ChatMessageData>();
  let latestStatus: ChatStatusData | null = null;
  let statusStripTimer: number | null = null;
  let lastUpstreamCheckAt = 0;
  /** Generated once per compose ATTEMPT, not once per `send()` call — spec/06
   * §1: "Include the idempotency key so a UI retry can't double-send," §3:
   * "manual retry with the same idempotency key." Cleared only after a
   * successful send, so a failed attempt's retry click reuses this same key
   * instead of minting a new one (which would defeat the whole point). */
  let pendingIdempotencyKey: string | null = null;

  function renderThread(): void {
    thread.innerHTML = "";
    const messages = Array.from(messagesByIndex.values())
      .filter((m) => includeThinking || m.kind !== "thinking")
      .sort((a, b) => a.index - b.index);
    if (messages.length === 0) {
      thread.textContent = "No messages yet.";
      return;
    }
    for (const group of groupMessages(messages)) {
      thread.appendChild(
        group.kind === "toolGroup" ? renderToolGroup(group.messages) : renderMessageRow(group.message),
      );
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function renderStatusStrip(): void {
    if (latestStatus === null) {
      statusStrip.hidden = true;
      return;
    }
    statusStrip.hidden = false;
    const state = activityState(latestStatus, now);
    statusStrip.textContent = state === "working" ? "Assistant is working…" : "Idle";
    statusStrip.className = `wx-chat-status-strip wx-chat-status-${state}`;
  }

  function maybeCheckUpstream(): void {
    const nowMs = now();
    if (nowMs - lastUpstreamCheckAt < UPSTREAM_CHECK_THROTTLE_MS) return;
    lastUpstreamCheckAt = nowMs;
    api
      .getState()
      .then((state) => {
        if (cancelled) return;
        previewChip.hidden = state.upstream.aheadOfPublished.length === 0;
      })
      .catch(() => {
        // Best-effort — the chip just stays as it was.
      });
  }

  function handleStreamEvent(event: ConversationStreamEvent): void {
    if (cancelled) return;
    if (event.type === "message") {
      offlineBanner.hidden = true;
      messagesByIndex.set(event.message.index, event.message);
      renderThread();
      if (event.message.role !== "user") maybeCheckUpstream();
      return;
    }
    if (event.type === "status") {
      offlineBanner.hidden = true;
      latestStatus = event.status;
      renderStatusStrip();
      return;
    }
    // "error" — spec/06 §3: offline banner, auto-retry (the server side
    // already retries on its own cadence; this is purely a display concern).
    offlineBanner.hidden = false;
  }

  function connect(): void {
    streamHandle?.close();
    streamHandle = openStream(convId, handleStreamEvent, includeThinking);
  }

  reasoningToggle.addEventListener("click", () => {
    includeThinking = !includeThinking;
    reasoningToggle.setAttribute("aria-pressed", String(includeThinking));
    reasoningToggle.textContent = includeThinking ? "Hide reasoning" : "Show reasoning";
    renderThread();
    connect();
  });

  function resetToIdleComposer(): void {
    sendButton.disabled = false;
    composerInput.disabled = false;
  }

  function send(): void {
    const text = composerInput.value.trim();
    if (text === "") return;
    sendButton.disabled = true;
    composerInput.disabled = true;
    composerError.hidden = true;
    pendingIdempotencyKey ??= `${convId}:${cryptoRandomId(win)}`;
    const idempotencyKey = pendingIdempotencyKey;
    api
      .sendMessage(convId, text, idempotencyKey)
      .then(() => {
        if (cancelled) return;
        pendingIdempotencyKey = null;
        composerInput.value = "";
        resetToIdleComposer();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        resetToIdleComposer();
        composerError.hidden = false;
        composerError.textContent =
          error instanceof Error ? error.message : "Couldn't deliver — retry.";
      });
  }

  sendButton.addEventListener("click", () => send());
  composerInput.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      send();
    }
  });

  function loadTitle(): void {
    api
      .getConversations()
      .then((conversations) => {
        if (cancelled) return;
        const match = conversations.find((c) => c.convId === convId);
        titleEl.textContent = match?.title ?? "Conversation";
      })
      .catch(() => {
        if (cancelled) return;
        titleEl.textContent = "Conversation";
      });
  }

  renameButton.addEventListener("click", () => {
    const next = win.prompt("Rename conversation", titleEl.textContent ?? "");
    if (next === null || next.trim() === "") return;
    api
      .renameConversation(convId, next.trim())
      .then((summary) => {
        if (cancelled) return;
        titleEl.textContent = summary.title;
      })
      .catch(() => {
        // Best-effort — the title just stays as it was.
      });
  });

  loadTitle();
  connect();
  // Re-render the status strip on a short interval too, so "working" ages
  // back into "idle" even if no NEW status event arrives to trigger a
  // re-render (activity freshness is time-relative, not event-driven).
  statusStripTimer = setInterval(renderStatusStrip, 2000) as unknown as number;

  return {
    element: root,
    teardown(): void {
      cancelled = true;
      streamHandle?.close();
      if (statusStripTimer !== null) clearInterval(statusStripTimer);
    },
  };
}

function cryptoRandomId(win: Window): string {
  const cryptoObj = win.crypto;
  if (typeof cryptoObj?.randomUUID === "function") return cryptoObj.randomUUID();
  // Fallback for a test/jsdom environment without crypto.randomUUID — never
  // used in a real browser, which always has it.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function mountChatPanel(conversation: string | null, deps: ChatPanelDeps): ChatPanel {
  return conversation === null ? mountConversationList(deps) : mountConversationView(conversation, deps);
}
