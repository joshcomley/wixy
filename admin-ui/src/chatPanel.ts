// The `#/chat` (list) and `#/chat/<conv>` (conversation) views (spec/05-editor.md
// §6, spec/06-ai-chat.md §1). `shell.ts` remounts this fresh whenever the route's
// `conversation` id changes (router.ts's `sameRoute` already treats a different
// conversation id as a different route) — this module owns no hash-routing of its
// own, just "render whichever one view the current conversation id calls for."
//
// decisions/00110 (the 2026-08-02 "chat experience" revamp):
// - The conversation view is a FULL-HEIGHT flex column inside `.wx-main`: the
//   header/banners/task card are fixed, ONLY the thread scrolls, and the
//   composer is pinned at the bottom by layout (never `position: sticky`,
//   never reachable only by scrolling) — the old stacked layout scrolled
//   `.wx-main` around a `max-height: 60vh` thread, the "double-scroll" the
//   operator reported, with the composer stranded below the fold.
// - The thread STICKS to the bottom only while you're already there (the old
//   unconditional `scrollTop = scrollHeight` yanked you down on every 1.2s
//   poll); scrolled up reading history + new arrivals = a "↓ New messages"
//   jump pill.
// - Both composers are the shared `chatComposer.ts` component — auto-growing
//   textarea (no more overflow) and image attachments on chat START as well
//   as in an open conversation.
// - A sent message ECHOES instantly (cmd's own UI does the same with its
//   OptimisticAttachment) and reconciles when the server copy streams in;
//   attachments render as thumbnails from wixy's bytes proxy, tap to expand
//   in a lightbox — the raw `Attachments: @C:\...` footer text never reaches
//   the screen (stripped server-side).
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
// - The "Preview updated" chip (spec/05 §6) deep-links (decisions/00113):
//   the publish preview's page-grouped changes attribute the edit — one page
//   → that page's Edit view; anything else (multi-page, `_global`/theme) →
//   the pages list, the neutral fallback. (The original decisions/00097
//   always-links-to-pages note stood while commit metadata alone couldn't
//   attribute pages.)

import type {
  AdminApi,
  ChatAttachmentRefData,
  ChatMessageData,
  ChatStatusData,
  ChatTaskData,
  ConversationStreamEvent,
  ConversationSummary,
  PublishPreview,
} from "./api";
import { chatUploadBytesUrl, openConversationStream, type ConversationStreamHandle } from "./api";
import { mountChatComposer } from "./chatComposer";
import { renderMarkdown } from "./markdown";
import { navigateTo, routeToPath, type Route } from "./router";

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
/** How far from the thread's bottom (px) still counts as "at the bottom" —
 * the stick-to-bottom latch's hysteresis (decisions/00110). */
const BOTTOM_STICK_THRESHOLD_PX = 48;
/** An optimistic echo that no server message matched within this window is
 * dropped — by then the real bubble has surely streamed in (or the send
 * failed and its error is on screen), so keeping it would be a permanent
 * duplicate. */
const ECHO_EXPIRY_MS = 30_000;

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

  // decisions/00110: the "New conversation" box is the SHARED composer now —
  // same auto-growing input, same image attachments as the open conversation
  // (previously impossible here — the operator's report). Its root keeps the
  // legacy `.wx-chat-compose-box` class; shown/hidden via `hidden` as before.
  const composer = mountChatComposer({
    mode: "compose",
    placeholder: "Optional first message… (or start with nothing)",
    submitLabel: "Start",
    allowEmptySubmit: true,
    upload: (file) => api.stageChatUpload(file),
    onSubmit: () => startConversation(),
    onCancel: () => {
      composer.element.hidden = true;
    },
    win,
  });
  composer.element.hidden = true;
  root.appendChild(composer.element);

  const body = document.createElement("div");
  body.textContent = "Loading…";
  root.appendChild(body);

  let cancelled = false;
  let pollTimer: number | null = null;
  let createInFlight = false;

  newButton.addEventListener("click", () => {
    composer.reset();
    composer.element.hidden = false;
    composer.focus();
    // Static, one-time check per open (decisions/00103's convention — the
    // backend's capability never changes mid-session): the attach button is
    // only ever revealed, never offered when it would 422.
    api
      .getState()
      .then((state) => {
        if (cancelled) return;
        composer.setAttachmentsSupported(state.chatAttachmentsSupported);
      })
      .catch(() => {
        // Best-effort — the attach button just stays hidden.
      });
  });

  function startConversation(): void {
    if (createInFlight) return;
    createInFlight = true;
    composer.setBusy(true);
    composer.setError(null);
    const text = composer.text();
    const attachmentIds = composer.attachmentIds();
    api
      .createConversation(
        text === "" ? undefined : text,
        attachmentIds.length > 0 ? attachmentIds : undefined,
      )
      .then((summary) => {
        if (cancelled) return;
        navigateTo({ kind: "chat", conversation: summary.convId }, win);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        createInFlight = false;
        composer.setBusy(false);
        composer.setError(
          error instanceof Error ? error.message : "Couldn't start a new conversation.",
        );
      });
  }

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
      composer.teardown();
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

function mountConversationView(convId: string, deps: ChatPanelDeps): ChatPanel {
  const { api } = deps;
  const win = deps.win ?? window;
  const openStream = deps.openStream ?? openConversationStream;
  const now = (): number => Date.now();

  const root = document.createElement("div");
  root.className = "wx-chat-panel wx-chat-conversation-view";

  const header = document.createElement("div");
  header.className = "wx-chat-conversation-header";
  // decisions/00113: a substantial back ARROW, no "All conversations" text —
  // a full 44px touch target instead of a text link.
  const backLink = document.createElement("a");
  backLink.href = "#";
  backLink.className = "wx-chat-back-link";
  backLink.textContent = "←";
  backLink.setAttribute("aria-label", "All conversations");
  backLink.title = "All conversations";
  backLink.addEventListener("click", (evt) => {
    evt.preventDefault();
    navigateTo({ kind: "chat", conversation: null }, win);
  });
  const titleEl = document.createElement("span");
  titleEl.className = "wx-chat-conversation-title";
  titleEl.textContent = "Loading…";
  // decisions/00113: Rename is a pencil icon (title + aria-label keep the
  // word for screen readers and hover); the "Show reasoning" toggle is GONE
  // entirely — the owner never needs the model's chain-of-thought, and the
  // stream already defaults to excluding thinking messages.
  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.className = "wx-chat-rename-button";
  renameButton.textContent = "✎";
  renameButton.title = "Rename conversation";
  renameButton.setAttribute("aria-label", "Rename conversation");
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

  const offlineBanner = document.createElement("div");
  offlineBanner.className = "wx-chat-offline-banner";
  offlineBanner.textContent = "Assistant offline — cmd isn't running. Retrying…";
  offlineBanner.hidden = true;
  root.appendChild(offlineBanner);

  // decisions/00113: the static "changes land in your draft preview"
  // explainer paragraph is GONE — the chip itself now carries the action:
  // deep-linked to the changed page (or the pages list when the change
  // spans pages, decisions/00097's neutral-link convention generalised).
  const previewChip = document.createElement("a");
  previewChip.className = "wx-chat-preview-chip";
  previewChip.textContent = "Preview updated — review changes";
  previewChip.href = routeToPath({ kind: "pages" });
  previewChip.hidden = true;
  previewChip.addEventListener("click", (evt) => {
    evt.preventDefault();
    navigateTo(previewChipTarget, win);
  });
  root.appendChild(previewChip);

  // Sits directly above the thread (which is now the view's ONLY scroll
  // region, decisions/00110) so it stays visible while messages scroll past
  // underneath it, without needing its own sticky positioning.
  const taskCard = document.createElement("div");
  taskCard.className = "wx-chat-tasks";
  taskCard.hidden = true;
  root.appendChild(taskCard);

  // The thread wrap is the flex:1 region; the jump pill floats above the
  // thread's bottom-right while there are unread arrivals below.
  const threadWrap = document.createElement("div");
  threadWrap.className = "wx-chat-thread-wrap";
  const thread = document.createElement("div");
  thread.className = "wx-chat-thread";
  thread.textContent = "Loading…";
  const jumpPill = document.createElement("button");
  jumpPill.type = "button";
  jumpPill.className = "wx-chat-jump-pill";
  jumpPill.textContent = "↓ New messages";
  jumpPill.hidden = true;
  threadWrap.append(thread, jumpPill);
  root.appendChild(threadWrap);

  const composer = mountChatComposer({
    mode: "composer",
    placeholder: "Message the assistant… (Shift+Enter for a new line)",
    submitLabel: "Send",
    upload: (file) => api.uploadChatAttachment(convId, file),
    onSubmit: () => send(),
    win,
  });
  root.appendChild(composer.element);

  let cancelled = false;
  let streamHandle: ConversationStreamHandle | null = null;
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
  /** decisions/00110: the stick-to-bottom latch — true while the owner is at
   * (or near) the thread's end, so polls snap the newest message into view;
   * false once they've scrolled up to read, so the same polls never yank
   * them away from what they're reading (the jump pill offers the way back). */
  let stickToBottom = true;
  /** decisions/00110: optimistic echoes of what the owner just sent, painted
   * the instant Send fires (cmd's own UI does the same with its
   * OptimisticAttachment). Reconciled FIFO by exact text as the server
   * copies stream in; expired after ECHO_EXPIRY_MS unmatched. Thumbnails
   * come from the SAME bytes-proxy URL the server copy will use, so there's
   * no blob-URL lifetime coupling to the composer (which revokes on reset). */
  interface PendingEcho {
    localId: string;
    text: string;
    attachments: ChatAttachmentRefData[];
    sentAt: number;
  }
  let pendingEchoes: PendingEcho[] = [];
  /** Echo ids are a plain local counter — deliberately NOT cryptoRandomId,
   * so echo bookkeeping can never perturb the idempotency-key sequence
   * (the only consumer of randomness the send path should have). */
  let echoCounter = 0;
  /** decisions/00113: where the Preview-updated chip navigates — refreshed
   * whenever the upstream check runs: the single changed page's Edit view,
   * or the pages list when the change isn't attributable to exactly one page
   * (multi-page edits, `_global`/theme keys, or an unknown shape). */
  let previewChipTarget: Route = { kind: "pages" };
  /** Whether the conversation is still provisioning (drives the thread's
   * friendlier empty state — after typing a first message and pressing
   * Start, "No messages yet." reads as broken while cmd spins up). */
  let conversationPending = false;

  // -- Lightbox --------------------------------------------------------------

  let lightboxCleanup: (() => void) | null = null;

  function closeLightbox(): void {
    lightboxCleanup?.();
    lightboxCleanup = null;
  }

  function openLightbox(src: string, alt: string): void {
    closeLightbox();
    const overlay = document.createElement("div");
    overlay.className = "wx-chat-lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt || "Attached image");
    const image = document.createElement("img");
    image.src = src;
    image.alt = alt;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "wx-chat-lightbox-close";
    closeButton.textContent = "✕";
    closeButton.setAttribute("aria-label", "Close image viewer");
    overlay.append(image, closeButton);
    const previouslyFocused = document.activeElement;
    const onKeydown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        closeLightbox();
      }
    };
    overlay.addEventListener("click", (evt) => {
      if (evt.target === overlay || evt.target === closeButton) closeLightbox();
    });
    document.addEventListener("keydown", onKeydown);
    (document.body ?? root).appendChild(overlay);
    lightboxCleanup = () => {
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
    closeButton.focus();
  }

  // -- Attachment thumbnails --------------------------------------------------

  function renderAttachmentGrid(attachments: readonly ChatAttachmentRefData[]): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "wx-chat-att-grid";
    for (const ref of attachments) {
      const src = chatUploadBytesUrl(ref.uploadId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wx-chat-att-thumb";
      const alt = ref.name ?? "Attached image";
      button.setAttribute("aria-label", `View ${alt} full size`);
      const img = document.createElement("img");
      img.src = src;
      img.alt = alt;
      img.loading = "lazy";
      // Images change scrollHeight when they finish loading — re-stick so a
      // late-loading thumbnail can't push the newest message out of view.
      img.addEventListener("load", () => {
        if (stickToBottom) scrollThreadToBottom();
      });
      button.appendChild(img);
      button.addEventListener("click", () => openLightbox(src, alt));
      grid.appendChild(button);
    }
    return grid;
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
    if (message.text !== null && message.text !== "") {
      row.appendChild(renderMarkdown(message.text));
    }
    if (message.attachments !== undefined && message.attachments.length > 0) {
      row.appendChild(renderAttachmentGrid(message.attachments));
    }
    const timestamp = document.createElement("span");
    timestamp.className = "wx-chat-bubble-timestamp";
    timestamp.textContent = formatWhen(message.timestamp);
    row.appendChild(timestamp);
    return row;
  }

  function renderEchoRow(echo: PendingEcho): HTMLElement {
    const row = document.createElement("div");
    row.className = "wx-chat-bubble wx-chat-bubble-user wx-chat-echo";
    if (echo.text !== "") {
      row.appendChild(renderMarkdown(echo.text));
    }
    if (echo.attachments.length > 0) {
      row.appendChild(renderAttachmentGrid(echo.attachments));
    }
    const timestamp = document.createElement("span");
    timestamp.className = "wx-chat-bubble-timestamp";
    timestamp.textContent = "sending…";
    row.appendChild(timestamp);
    return row;
  }

  function scrollThreadToBottom(): void {
    thread.scrollTop = thread.scrollHeight;
  }

  thread.addEventListener("scroll", () => {
    const atBottom =
      thread.scrollTop + thread.clientHeight >= thread.scrollHeight - BOTTOM_STICK_THRESHOLD_PX;
    stickToBottom = atBottom;
    if (atBottom) jumpPill.hidden = true;
  });

  jumpPill.addEventListener("click", () => {
    stickToBottom = true;
    jumpPill.hidden = true;
    scrollThreadToBottom();
  });

  function renderThread(): void {
    // Expire unmatched echoes first — see ECHO_EXPIRY_MS's note.
    const nowMs = now();
    pendingEchoes = pendingEchoes.filter((e) => nowMs - e.sentAt < ECHO_EXPIRY_MS);

    const wasStuck = stickToBottom;
    thread.innerHTML = "";
    const messages = Array.from(messagesByIndex.values())
      // decisions/00113: thinking messages never render in the owner UI —
      // the "Show reasoning" toggle is gone, so they always filter out.
      .filter((m) => m.kind !== "thinking")
      .sort((a, b) => a.index - b.index);
    if (messages.length === 0 && pendingEchoes.length === 0) {
      thread.textContent = conversationPending
        ? "Starting your conversation — the assistant will be right with you…"
        : "No messages yet — say hello below.";
      return;
    }
    for (const group of groupMessages(messages)) {
      thread.appendChild(
        group.kind === "toolGroup" ? renderToolGroup(group.messages) : renderMessageRow(group.message),
      );
    }
    // Echoes always render BELOW the newest server message — they are, by
    // definition, the most recent things the owner sent.
    for (const echo of pendingEchoes) {
      thread.appendChild(renderEchoRow(echo));
    }
    if (wasStuck) scrollThreadToBottom();
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
    let hadCommits = false;
    api
      .getState()
      .then((state) => {
        if (cancelled) return null;
        hadCommits = state.upstream.aheadOfPublished.length > 0;
        previewChip.hidden = !hadCommits;
        if (!hadCommits) return null;
        // decisions/00113: deep-link the chip — the publish preview's
        // page-grouped changes tell us exactly which page(s) the assistant's
        // edits touch, which the commit metadata alone never could (the
        // original decisions/00097 limitation). One page → that page's Edit
        // view; anything else → the pages list.
        return api.getPublishPreview();
      })
      .then((preview) => {
        if (cancelled || preview === null || preview === undefined) return;
        previewChipTarget = chipTargetFromPreview(preview);
        previewChip.href = routeToPath(previewChipTarget);
      })
      .catch(() => {
        // Best-effort — the chip just stays as it was (hidden, or linked to
        // the pages list from a previous successful check).
      });
  }

  /** decisions/00113: exactly one REAL page in the change set → that page's
   * Edit view; anything else (multiple pages, only `_global`/`theme` keys, an
   * empty set) → the pages list, the neutral fallback. */
  function chipTargetFromPreview(preview: PublishPreview): Route {
    const pages = Object.keys(preview.changes).filter((key) => key !== "_global" && key !== "theme");
    return pages.length === 1 ? { kind: "edit", page: pages[0] as string } : { kind: "pages" };
  }

  function handleStreamEvent(event: ConversationStreamEvent): void {
    if (cancelled) return;
    if (event.type === "message") {
      offlineBanner.hidden = true;
      messagesByIndex.set(event.message.index, event.message);
      if (event.message.role === "user") {
        // Reconcile the optimistic echo this server copy supersedes (FIFO by
        // exact text — the server text is footer-stripped/preamble-stripped
        // by the time it arrives, matching what the composer sent).
        const messageText = event.message.text ?? "";
        const echoIndex = pendingEchoes.findIndex((e) => e.text === messageText);
        if (echoIndex !== -1) pendingEchoes.splice(echoIndex, 1);
      } else {
        awaitingReply = false;
        maybeCheckUpstream();
      }
      renderThread();
      if (!stickToBottom && event.message.role !== "user") {
        jumpPill.hidden = false;
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
    streamHandle = openStream(convId, handleStreamEvent);
  }

  function send(): void {
    const text = composer.text();
    const staged = composer.stagedAttachments();
    composer.setBusy(true);
    composer.setError(null);
    pendingIdempotencyKey ??= `${convId}:${cryptoRandomId(win)}`;
    const idempotencyKey = pendingIdempotencyKey;
    const attachmentIds = composer.attachmentIds();
    // The optimistic echo paints NOW, before the request even resolves —
    // thumbnails from the same proxy URLs the server copy will use (each
    // staged upload already has its id; submit was gated on that).
    const echo: PendingEcho = {
      localId: `echo-${++echoCounter}`,
      text,
      attachments: staged.map((a) => ({
        uploadId: a.attachmentId ?? "",
        name: a.file.name || null,
        width: null,
        height: null,
      })),
      sentAt: now(),
    };
    pendingEchoes.push(echo);
    stickToBottom = true;
    jumpPill.hidden = true;
    renderThread();
    api
      .sendMessage(convId, text, idempotencyKey, attachmentIds)
      .then(() => {
        if (cancelled) return;
        pendingIdempotencyKey = null;
        composer.reset();
        composer.setBusy(false);
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
        // spec/06 §3: the composer keeps the text (and the staged chips) for
        // a manual retry with the same idempotency key — only the echo comes
        // down; it re-paints on the retry click.
        pendingEchoes = pendingEchoes.filter((e) => e.localId !== echo.localId);
        renderThread();
        composer.setBusy(false);
        composer.setError(error instanceof Error ? error.message : "Couldn't deliver — retry.");
      });
  }

  function loadTitle(): void {
    api
      .getConversations()
      .then((conversations) => {
        if (cancelled) return;
        const match = conversations.find((c) => c.convId === convId);
        titleEl.textContent = match?.title ?? "Conversation";
        conversationPending = match?.status === "pending";
        // The first render happens HERE, not on the first stream event: a
        // ready conversation with zero messages would otherwise show
        // "Loading…" forever — the empty state ("Starting your conversation…"
        // / "No messages yet — say hello below.") is the correct idle face.
        if (messagesByIndex.size === 0) renderThread();
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
      composer.setAttachmentsSupported(true);
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
      composer.teardown();
      closeLightbox();
    },
  };
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
