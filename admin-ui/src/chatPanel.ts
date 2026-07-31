// The `#/chat` (list) and `#/chat/<conv>` (conversation) views (spec/05-editor.md
// §6, spec/06-ai-chat.md §1). `shell.ts` remounts this fresh whenever the route's
// `conversation` id changes (router.ts's `sameRoute` already treats a different
// conversation id as a different route) — this module owns no hash-routing of its
// own, just "render whichever one view the current conversation id calls for."
//
// Scope notes (decide-small-things-yourself calls, see decisions/00097):
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
  ChatTaskData,
  ConversationStreamEvent,
  ConversationSummary,
} from "./api";
import { openConversationStream, type ConversationStreamHandle } from "./api";
import { renderMarkdown } from "./markdown";
import { navigateTo, routeToPath } from "./router";

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

function formatWhen(iso: string): string {
  const parsed = new Date(iso);
  // Medium-date/short-time keeps the value compact — on narrow viewports the
  // conversation list stacks it on its own line under the title (same trade
  // the pages and history tables made).
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusLabel(summary: ConversationSummary): string {
  if (summary.status === "pending") return "starting…";
  if (summary.status === "failed") return summary.failureMessage ?? "failed to start";
  return "";
}

function statusDotClass(summary: ConversationSummary): string {
  if (summary.status === "pending") return "wx-chat-dot-pending";
  if (summary.status === "failed") return "wx-chat-dot-failed";
  // decisions/00097: a second, independent signal layered on the ready dot —
  // still green (it's ready), but pulsing while the assistant is actively
  // working on it, so the owner can tell without opening the conversation.
  return summary.working ? "wx-chat-dot-ready wx-chat-dot-working" : "wx-chat-dot-ready";
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

      // Per-cell classes are what the narrow-viewport stylesheet hooks onto
      // to restack each row (dot+title on the first line, timestamp under it —
      // the pages/history tables' pattern). On wide viewports nothing matches
      // them and the table renders unchanged; the when cell's long-standing
      // wx-chat-list-when class doubles as its hook.
      const dotCell = document.createElement("td");
      dotCell.className = "wx-chat-cell-dot";
      const dot = document.createElement("span");
      dot.className = `wx-chat-dot ${statusDotClass(summary)}`;
      dot.title = statusLabel(summary) || "ready";
      dotCell.appendChild(dot);
      row.appendChild(dotCell);

      const titleCell = document.createElement("td");
      titleCell.className = "wx-chat-cell-title";
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
      } else if (summary.working) {
        const note = document.createElement("span");
        note.className = "wx-chat-list-note wx-chat-list-note-working";
        note.textContent = " — working…";
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

/** `status.activity` is cmd's own enum ("active" | "idle" | "done" | "unknown",
 * `engine/chats/session_introspect.py:_activity` — a session-store mtime-age
 * threshold, NOT a timestamp wixy parses itself (spec/06-ai-chat.md: "prefer
 * the `activity` field... over process liveness"). A plain equality check,
 * not a freshness window. Two corrections shipped here, in sequence
 * (decisions/00099, then 00100):
 * 1. A prior version of this function parsed `activity` as a `Date` and
 *    compared elapsed time against a 10s window; since none of the real enum
 *    strings parse as a valid date, that ALWAYS evaluated to idle regardless
 *    of cmd's real state — invisible to every test (the fake cmd server
 *    encoded the same wrong ISO-timestamp assumption), caught only by live
 *    verification against real cmd (decisions/00099).
 * 2. That fix compared `activity === "working"` — the right KIND of check,
 *    but the wrong literal, guessed from spec prose ("working / idle / dead")
 *    and a single live sample that happened to read "idle", never confirmed
 *    against a genuinely active moment. cmd never sends "working" as an
 *    `activity` value — that string belongs to the DIFFERENT `process.
 *    liveness` field this module deliberately doesn't read. Caught only by a
 *    second round of live verification that polled cmd's real `/status`
 *    endpoint directly, time-correlated against wixy's own response, across
 *    a real ~30s active window (decisions/00100). */
function activityState(status: ChatStatusData | null): "working" | "idle" {
  return status?.activity === "active" ? "working" : "idle";
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

  // decisions/00097: the prominent work banner replaces the old small
  // statusStrip — "directly under the conversation header" so it's
  // impossible to miss, `aria-live="polite"` so a screen reader announces
  // state changes without interrupting whatever the owner is doing.
  const workBanner = document.createElement("div");
  workBanner.className = "wx-chat-work-banner";
  workBanner.setAttribute("aria-live", "polite");
  workBanner.hidden = true;
  root.appendChild(workBanner);

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
  previewChip.href = routeToPath({ kind: "pages" });
  previewChip.hidden = true;
  previewChip.addEventListener("click", (evt) => {
    evt.preventDefault();
    navigateTo({ kind: "pages" }, win);
  });
  root.appendChild(previewChip);

  // Sits directly above the thread (which scrolls internally, decisions/
  // NNNNN) so it stays visible while messages scroll past underneath it,
  // without needing its own sticky positioning.
  const taskCard = document.createElement("div");
  taskCard.className = "wx-chat-tasks";
  taskCard.hidden = true;
  root.appendChild(taskCard);

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

  // decisions/00103: pending image attachments, staged via upload before the
  // owner presses Send — a chip per attachment (local preview + cmd's own
  // converted dims once known), independent of composerInput's own text.
  const attachmentRow = document.createElement("div");
  attachmentRow.className = "wx-chat-attachment-row";
  attachmentRow.hidden = true;

  const composer = document.createElement("div");
  composer.className = "wx-chat-composer";
  const composerInput = document.createElement("textarea");
  composerInput.className = "wx-chat-composer-input";
  composerInput.rows = 2;
  composerInput.placeholder = "Message the assistant… (Shift+Enter for a new line)";
  const composerError = document.createElement("span");
  composerError.className = "wx-chat-composer-error";
  composerError.hidden = true;
  const attachButton = document.createElement("button");
  attachButton.type = "button";
  attachButton.className = "wx-chat-attach-button";
  attachButton.textContent = "📎";
  attachButton.setAttribute("aria-label", "Attach an image");
  attachButton.hidden = true; // shown once chatAttachmentsSupported resolves true
  const attachInput = document.createElement("input");
  attachInput.type = "file";
  attachInput.accept = "image/*";
  attachInput.multiple = true;
  attachInput.hidden = true;
  attachButton.addEventListener("click", () => attachInput.click());
  const sendButton = document.createElement("button");
  sendButton.type = "button";
  sendButton.className = "wx-chat-send-button";
  sendButton.textContent = "Send";
  composer.append(attachButton, attachInput, composerInput, sendButton, composerError);
  root.append(attachmentRow, composer);

  let cancelled = false;
  let streamHandle: ConversationStreamHandle | null = null;
  let includeThinking = false;
  const messagesByIndex = new Map<number, ChatMessageData>();
  let latestStatus: ChatStatusData | null = null;
  let latestTasks: ChatTaskData[] | null = null;
  /** Set the instant a send() succeeds, cleared the moment a non-user
   * message arrives — covers the gap between "the owner just sent
   * something" and "the assistant's own activity timestamp (or a task
   * block) first shows it working," which `activityState` alone can't see
   * (decisions/00097: without this, the banner can go quiet for a moment
   * right after Send, before the first status/tasks event lands). */
  let awaitingReply = false;
  let lastUpstreamCheckAt = 0;
  /** Generated once per compose ATTEMPT, not once per `send()` call — spec/06
   * §1: "Include the idempotency key so a UI retry can't double-send," §3:
   * "manual retry with the same idempotency key." Cleared only after a
   * successful send, so a failed attempt's retry click reuses this same key
   * instead of minting a new one (which would defeat the whole point). */
  let pendingIdempotencyKey: string | null = null;
  /** decisions/00103: images staged for the NEXT send, in attach order.
   * `attachmentId` is `null` while the upload is still in flight — Send stays
   * disabled until every pending attachment has either resolved to an id or
   * been removed (a failed upload's chip is dropped, never silently sent
   * without the image the owner thinks is attached). */
  interface PendingAttachment {
    localId: string;
    file: File;
    previewUrl: string;
    attachmentId: string | null;
    uploading: boolean;
  }
  let pendingAttachments: PendingAttachment[] = [];

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

  /** Working: any of — cmd itself reports "working" right now, a send just
   * went out and nothing's come back yet, or the latest task list has
   * anything not yet `done` (decisions/00097 — three independent signals of
   * the same underlying fact, each covering a gap the others miss: activity
   * alone misses the instant right after Send; tasks alone misses a reply
   * with no task block at all; awaitingReply alone would never clear if a
   * task block never arrives). */
  function isWorking(): boolean {
    return (
      activityState(latestStatus) === "working" ||
      awaitingReply ||
      (latestTasks !== null && latestTasks.some((t) => t.status !== "done"))
    );
  }

  function renderWorkBanner(): void {
    const working = isWorking();
    const allDone = !working && latestTasks !== null && latestTasks.every((t) => t.status === "done");

    if (working) {
      workBanner.hidden = false;
      workBanner.className = "wx-chat-work-banner wx-chat-work-banner-working";
      workBanner.innerHTML = "";
      const spinner = document.createElement("span");
      spinner.className = "wx-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = latestTasks !== null ? "Working on your tasks…" : "Thinking…";
      workBanner.append(spinner, label);
      return;
    }
    if (allDone) {
      workBanner.hidden = false;
      workBanner.className = "wx-chat-work-banner wx-chat-work-banner-done";
      workBanner.innerHTML = "";
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "✓";
      const label = document.createElement("span");
      label.textContent = "All tasks completed — review the changes in Edit, then press Publish.";
      workBanner.append(icon, label);
      return;
    }
    workBanner.hidden = true;
  }

  function renderTaskRow(task: ChatTaskData): HTMLElement {
    const row = document.createElement("li");
    row.className = `wx-chat-task wx-chat-task-${task.status}`;
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    if (task.status === "doing") {
      icon.className = "wx-spinner wx-chat-task-icon";
    } else {
      icon.className = "wx-chat-task-icon";
      icon.textContent = task.status === "done" ? "✓" : "○";
    }
    const label = document.createElement("span");
    label.className = "wx-chat-task-label";
    label.textContent = task.label;
    row.append(icon, label);
    return row;
  }

  function renderTaskCard(): void {
    if (latestTasks === null || latestTasks.length === 0) {
      taskCard.hidden = true;
      return;
    }
    taskCard.hidden = false;
    taskCard.innerHTML = "";
    const doneCount = latestTasks.filter((t) => t.status === "done").length;
    const header = document.createElement("p");
    header.className = "wx-chat-tasks-header";
    header.textContent = `Tasks · ${doneCount} of ${latestTasks.length} done`;
    taskCard.appendChild(header);
    const list = document.createElement("ul");
    list.className = "wx-chat-tasks-list";
    for (const task of latestTasks) list.appendChild(renderTaskRow(task));
    taskCard.appendChild(list);
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
      if (event.message.role !== "user") {
        awaitingReply = false;
        maybeCheckUpstream();
      }
      renderWorkBanner();
      return;
    }
    if (event.type === "status") {
      offlineBanner.hidden = true;
      latestStatus = event.status;
      renderWorkBanner();
      return;
    }
    if (event.type === "tasks") {
      offlineBanner.hidden = true;
      latestTasks = event.tasks;
      renderTaskCard();
      renderWorkBanner();
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

  function anyAttachmentUploading(): boolean {
    return pendingAttachments.some((a) => a.uploading);
  }

  function renderAttachmentRow(): void {
    attachmentRow.innerHTML = "";
    attachmentRow.hidden = pendingAttachments.length === 0;
    for (const attachment of pendingAttachments) {
      const chip = document.createElement("div");
      chip.className = "wx-chat-attachment-chip";
      const thumb = document.createElement("img");
      thumb.className = "wx-chat-attachment-thumb";
      thumb.src = attachment.previewUrl;
      thumb.alt = "";
      chip.appendChild(thumb);
      if (attachment.uploading) {
        const spinner = document.createElement("span");
        spinner.className = "wx-spinner wx-chat-attachment-spinner";
        spinner.setAttribute("aria-hidden", "true");
        chip.appendChild(spinner);
      }
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "wx-chat-attachment-remove";
      removeButton.textContent = "✕";
      removeButton.setAttribute("aria-label", "Remove this image");
      removeButton.addEventListener("click", () => removeAttachment(attachment.localId));
      chip.appendChild(removeButton);
      attachmentRow.appendChild(chip);
    }
    sendButton.disabled = anyAttachmentUploading();
  }

  function removeAttachment(localId: string): void {
    const found = pendingAttachments.find((a) => a.localId === localId);
    if (found !== undefined) URL.revokeObjectURL(found.previewUrl);
    pendingAttachments = pendingAttachments.filter((a) => a.localId !== localId);
    renderAttachmentRow();
  }

  function uploadAndAttach(file: File): void {
    if (!file.type.startsWith("image/")) return;
    const localId = cryptoRandomId(win);
    const previewUrl = URL.createObjectURL(file);
    pendingAttachments = [
      ...pendingAttachments,
      { localId, file, previewUrl, attachmentId: null, uploading: true },
    ];
    renderAttachmentRow();
    api
      .uploadChatAttachment(convId, file)
      .then((result) => {
        if (cancelled) return;
        pendingAttachments = pendingAttachments.map((a) =>
          a.localId === localId ? { ...a, attachmentId: result.attachmentId, uploading: false } : a,
        );
        renderAttachmentRow();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A failed upload never sends silently without the image the owner
        // thinks is attached — drop the chip and surface why.
        removeAttachment(localId);
        composerError.hidden = false;
        composerError.textContent =
          error instanceof Error ? error.message : "Couldn't attach that image — try again.";
      });
  }

  function handleFileList(files: FileList | null): void {
    if (files === null) return;
    for (const file of Array.from(files)) uploadAndAttach(file);
  }

  attachInput.addEventListener("change", () => {
    handleFileList(attachInput.files);
    attachInput.value = "";
  });
  composerInput.addEventListener("paste", (evt) => {
    const items = evt.clipboardData?.items;
    if (items === undefined) return;
    const imageFiles = Array.from(items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length === 0) return;
    // Only intercept the paste when it's actually image data — a text paste
    // must still land in the textarea normally.
    evt.preventDefault();
    for (const file of imageFiles) uploadAndAttach(file);
  });
  composer.addEventListener("dragover", (evt) => {
    evt.preventDefault();
  });
  composer.addEventListener("drop", (evt) => {
    evt.preventDefault();
    handleFileList(evt.dataTransfer?.files ?? null);
  });

  function resetToIdleComposer(): void {
    sendButton.disabled = anyAttachmentUploading();
    composerInput.disabled = false;
  }

  function send(): void {
    const text = composerInput.value.trim();
    if (text === "" && pendingAttachments.length === 0) return;
    if (anyAttachmentUploading()) return;
    sendButton.disabled = true;
    composerInput.disabled = true;
    composerError.hidden = true;
    pendingIdempotencyKey ??= `${convId}:${cryptoRandomId(win)}`;
    const idempotencyKey = pendingIdempotencyKey;
    const attachmentIds = pendingAttachments
      .map((a) => a.attachmentId)
      .filter((id): id is string => id !== null);
    const sentAttachments = pendingAttachments;
    api
      .sendMessage(convId, text, idempotencyKey, attachmentIds)
      .then(() => {
        if (cancelled) return;
        pendingIdempotencyKey = null;
        composerInput.value = "";
        for (const attachment of sentAttachments) URL.revokeObjectURL(attachment.previewUrl);
        pendingAttachments = [];
        renderAttachmentRow();
        resetToIdleComposer();
        // decisions/00097: a fresh round of work starts now — the OLD task
        // list (possibly showing "all done") is stale until a new block
        // arrives, and awaitingReply covers the gap until it (or a plain
        // reply, or cmd's own activity flipping to "working") does.
        awaitingReply = true;
        latestTasks = null;
        renderTaskCard();
        renderWorkBanner();
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

  // decisions/00103: a static, one-time check — unlike `maybeCheckUpstream`'s
  // repeated throttled polling, whether the active backend supports
  // attachments never changes mid-conversation. The attach button starts
  // hidden (safe default: never offer an affordance that would 422) and is
  // only ever revealed, never hidden again once shown.
  api
    .getState()
    .then((state) => {
      if (cancelled || !state.chatAttachmentsSupported) return;
      attachButton.hidden = false;
    })
    .catch(() => {
      // Best-effort — the attach button just stays hidden.
    });

  loadTitle();
  connect();

  return {
    element: root,
    teardown(): void {
      cancelled = true;
      streamHandle?.close();
      for (const attachment of pendingAttachments) URL.revokeObjectURL(attachment.previewUrl);
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
