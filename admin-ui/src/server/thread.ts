// The server chat's header, message thread (day separators, own/other
// alignment, history paging, optimistic echo) and composer — spec/server-
// chat/00-brief.md §10 P5b. Reuses the AI chat's own shared thread-scroll and
// lightbox extraction (P5a) and its generalized composer, so this view's
// scroll/jump-pill/composer behavior matches the AI chat's exactly. Layout
// mirrors the Inv 24 corollary: a flex column, the thread is the only scroll
// region, the composer is pinned by layout.

import type { ChatComposer } from "../chatComposer";
import { mountChatComposer } from "../chatComposer";
import { mountChatThreadScroll, type ChatThreadScroll } from "../chatThreadScroll";
import { mountLightbox, type Lightbox } from "../lightbox";
import { ServerLockedError } from "./api/http";
import { deleteMessage, getHistory, sendMessage, wipeChat, type Message } from "./api/messages";
import type { ServerIdentity } from "./identity";
import { linkifyInto } from "./linkify";
import { mountMessageActions, type MessageActionsController } from "./messageActions";
import { renderAttachments } from "./mediaRender";
import type { ServerStreamEvent } from "./stream";
import type { LockHooks, ServerSession } from "./types";

const HISTORY_PAGE_SIZE = 50;
/** A pending echo unmatched by a real message this long is dropped rather
 * than kept forever — mirrors the AI chat's own ECHO_EXPIRY_MS. */
const ECHO_EXPIRY_MS = 30_000;
const DELETE_FADE_MS = 160;

export interface ServerThreadDeps {
  identity: ServerIdentity;
  hooks: LockHooks;
  win: Window;
  onSettings: () => void;
  document?: Document;
}

export interface ServerThreadView {
  readonly element: HTMLElement;
  /** First call: loads the newest history page and returns its cursor.
   * Every later call (the view already has history): a no-op that returns
   * `null` — the caller keeps using whatever cursor it already has. Throws
   * `ServerLockedError` on a 401, letting the caller lock; any other
   * failure is shown in-thread with a retry affordance instead. */
  attach(session: ServerSession): Promise<number | null>;
  /** Detaches from the DOM's interactive bits for a lock: closes the
   * lightbox and settings-sheet host, but keeps every message, the draft
   * text, and the scroll/echo state in memory for the next `attach`. */
  detach(): void;
  handleStreamEvent(event: ServerStreamEvent): void;
  wipe(): Promise<void>;
  /** Updates the header's name chip — called after the settings sheet (or
   * the first-unlock name prompt) commits a new name. */
  refreshNameChip(): void;
  teardown(): void;
}

interface PendingEcho {
  readonly clientId: string;
  readonly text: string | null;
  readonly sentAt: number;
}

function startOfLocalDay(epochS: number): number {
  const date = new Date(epochS * 1000);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatDaySeparator(epochS: number, now: Date): string {
  const day = startOfLocalDay(epochS);
  const today = startOfLocalDay(now.getTime() / 1000);
  const oneDayMs = 86_400_000;
  if (day === today) return "Today";
  if (day === today - oneDayMs) return "Yesterday";
  return new Date(epochS * 1000).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: day < today - 300 * oneDayMs ? "numeric" : undefined,
  });
}

function formatTime(epochS: number): string {
  return new Date(epochS * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function mountServerThread(deps: ServerThreadDeps): ServerThreadView {
  const { identity, hooks, win } = deps;
  const documentRef = deps.document ?? document;
  const now = (): number => Date.now();

  const element = documentRef.createElement("div");
  element.className = "wx-srv-thread-view";

  // -- Header ------------------------------------------------------------

  const header = documentRef.createElement("div");
  header.className = "wx-srv-thread-header";
  const title = documentRef.createElement("span");
  title.className = "wx-srv-thread-title";
  title.textContent = "Server";
  const nameChip = documentRef.createElement("span");
  nameChip.className = "wx-srv-name-chip";
  const settingsButton = documentRef.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "wx-srv-settings-button";
  settingsButton.dataset["srvGestureBoundary"] = "";
  settingsButton.textContent = "⚙";
  settingsButton.title = "Settings";
  settingsButton.setAttribute("aria-label", "Settings");
  settingsButton.addEventListener("click", () => deps.onSettings());
  const panicButton = documentRef.createElement("button");
  panicButton.type = "button";
  panicButton.className = "wx-srv-panic-button";
  panicButton.textContent = "✕";
  panicButton.setAttribute("aria-label", "Close");
  panicButton.addEventListener("click", () => hooks.lockNow("panic"));
  header.append(title, nameChip, settingsButton, panicButton);
  element.appendChild(header);

  function refreshNameChip(): void {
    nameChip.textContent = identity.getName() ?? "";
  }
  refreshNameChip();

  // -- Thread + composer ---------------------------------------------------

  const threadWrap = documentRef.createElement("div");
  threadWrap.className = "wx-srv-thread-wrap";
  const thread = documentRef.createElement("div");
  thread.className = "wx-srv-thread";
  const sentinel = documentRef.createElement("div");
  sentinel.className = "wx-srv-thread-sentinel";
  const historyErrorRow = documentRef.createElement("div");
  historyErrorRow.className = "wx-srv-history-error";
  historyErrorRow.hidden = true;
  const retryButton = documentRef.createElement("button");
  retryButton.type = "button";
  retryButton.textContent = "Retry";
  const historyErrorText = documentRef.createElement("span");
  historyErrorRow.append(historyErrorText, retryButton);
  const messageList = documentRef.createElement("div");
  messageList.className = "wx-srv-message-list";
  thread.append(sentinel, historyErrorRow, messageList);
  const jumpPill = documentRef.createElement("button");
  jumpPill.type = "button";
  jumpPill.className = "wx-srv-jump-pill";
  jumpPill.textContent = "↓ New messages";
  jumpPill.hidden = true;
  threadWrap.append(thread, jumpPill);
  element.appendChild(threadWrap);

  const threadScroll: ChatThreadScroll = mountChatThreadScroll(thread, jumpPill);
  const lightbox: Lightbox = mountLightbox();

  const composer: ChatComposer = mountChatComposer({
    mode: "composer",
    placeholder: "Message…",
    submitLabel: "Send",
    win,
    // Attachments are wired in by P6b (spec/server-chat/00-brief.md §10) —
    // the 📎 button stays hidden by default (setAttachmentsSupported is
    // simply never called true), so this is never actually invoked.
    upload: () => Promise.reject(new Error("Attachments aren't available yet.")),
    onSubmit: () => send(),
  });
  element.appendChild(composer.element);

  // -- State ---------------------------------------------------------------

  let currentSession: ServerSession | null = null;
  let historyLoaded = false;
  let historyLoading = false;
  let hasMoreHistory = false;
  const confirmedBySeq = new Map<number, Message>();
  const confirmedClientIds = new Set<string>();
  const inFlightDeletes = new Set<number>();
  const deleteEventsDuringRequest = new Set<number>();
  const deleteFadeTimers = new Map<number, number>();
  const messageActionControllers: MessageActionsController[] = [];
  let pendingEchoes: PendingEcho[] = [];
  let echoCounter = 0;
  let pendingClientId: string | null = null;
  let contentGeneration = 0;

  function addConfirmed(message: Message): void {
    confirmedBySeq.set(message.seq, message);
    confirmedClientIds.add(message.clientId);
  }

  function renderAttachmentsFor(message: Message): HTMLElement | null {
    if (message.attachments.length === 0) return null;
    return renderAttachments(message.attachments, {
      hooks,
      openLightbox: (src, alt) => lightbox.open(src, alt),
      document: documentRef,
    });
  }

  function renderBubble(message: Message, mine: boolean): HTMLElement {
    const bubble = documentRef.createElement("div");
    bubble.className = `wx-srv-bubble ${mine ? "wx-srv-bubble-mine" : "wx-srv-bubble-theirs"}`;
    bubble.dataset["messageSeq"] = String(message.seq);
    if (!mine) {
      const sender = documentRef.createElement("span");
      sender.className = "wx-srv-bubble-sender";
      sender.textContent = message.sender;
      bubble.appendChild(sender);
    }
    if (message.text !== null && message.text !== "") {
      const textEl = documentRef.createElement("div");
      textEl.className = "wx-srv-bubble-text";
      linkifyInto(textEl, message.text, documentRef);
      bubble.appendChild(textEl);
    }
    const attachmentsEl = renderAttachmentsFor(message);
    if (attachmentsEl !== null) bubble.appendChild(attachmentsEl);
    const time = documentRef.createElement("span");
    time.className = "wx-srv-bubble-time";
    time.textContent = formatTime(message.createdAt);
    bubble.appendChild(time);
    messageActionControllers.push(
      mountMessageActions({
        message,
        bubble,
        win,
        document: documentRef,
        onDelete: deleteForEveryone,
      }),
    );
    return bubble;
  }

  function renderEchoBubble(echo: PendingEcho): HTMLElement {
    const bubble = documentRef.createElement("div");
    bubble.className = "wx-srv-bubble wx-srv-bubble-mine wx-srv-echo";
    if (echo.text !== null && echo.text !== "") {
      const textEl = documentRef.createElement("div");
      textEl.className = "wx-srv-bubble-text";
      linkifyInto(textEl, echo.text, documentRef);
      bubble.appendChild(textEl);
    }
    const time = documentRef.createElement("span");
    time.className = "wx-srv-bubble-time";
    time.textContent = "sending…";
    bubble.appendChild(time);
    return bubble;
  }

  function renderThreadList(revealPillIfNotStuck = false): void {
    const nowMs = now();
    pendingEchoes = pendingEchoes.filter((e) => nowMs - e.sentAt < ECHO_EXPIRY_MS);

    for (const controller of messageActionControllers) controller.teardown();
    messageActionControllers.length = 0;
    messageList.innerHTML = "";
    const messages = Array.from(confirmedBySeq.values()).sort((a, b) => a.seq - b.seq);
    if (messages.length === 0 && pendingEchoes.length === 0) {
      const empty = documentRef.createElement("p");
      empty.className = "wx-srv-thread-empty";
      empty.textContent = "No messages yet — say hello below.";
      messageList.appendChild(empty);
      threadScroll.afterContentChange(revealPillIfNotStuck);
      return;
    }

    let lastDay: number | null = null;
    const nowDate = new Date();
    for (const message of messages) {
      const day = startOfLocalDay(message.createdAt);
      if (day !== lastDay) {
        const separator = documentRef.createElement("div");
        separator.className = "wx-srv-day-separator";
        const label = documentRef.createElement("span");
        label.textContent = formatDaySeparator(message.createdAt, nowDate);
        separator.appendChild(label);
        messageList.appendChild(separator);
        lastDay = day;
      }
      messageList.appendChild(renderBubble(message, identity.isMine(message.sender)));
    }
    for (const echo of pendingEchoes) {
      if (confirmedClientIds.has(echo.clientId)) continue; // superseded by the real message
      messageList.appendChild(renderEchoBubble(echo));
    }
    threadScroll.afterContentChange(revealPillIfNotStuck);
  }

  async function deleteForEveryone(message: Message): Promise<void> {
    const session = currentSession;
    if (session === null) return;
    inFlightDeletes.add(message.seq);
    confirmedBySeq.delete(message.seq);
    const bubble = messageList.querySelector<HTMLElement>(
      `[data-message-seq="${message.seq}"]`,
    );
    if (bubble === null) {
      renderThreadList(false);
    } else {
      bubble.classList.add("wx-srv-bubble-deleting");
      const menu = bubble.querySelector<HTMLElement>(".wx-srv-message-actions");
      if (menu !== null) menu.hidden = true;
      deleteFadeTimers.set(
        message.seq,
        win.setTimeout(() => {
          deleteFadeTimers.delete(message.seq);
          if (!confirmedBySeq.has(message.seq)) renderThreadList(false);
        }, DELETE_FADE_MS),
      );
    }
    try {
      await deleteMessage(session, message.seq);
    } catch (error) {
      const deleteArrived = deleteEventsDuringRequest.has(message.seq);
      if (!deleteArrived) {
        const fadeTimer = deleteFadeTimers.get(message.seq);
        if (fadeTimer !== undefined) win.clearTimeout(fadeTimer);
        deleteFadeTimers.delete(message.seq);
        addConfirmed(message);
        renderThreadList(false);
        const restored = messageList.querySelector<HTMLElement>(
          `[data-message-seq="${message.seq}"]`,
        );
        if (restored !== null) {
          const errorLine = documentRef.createElement("span");
          errorLine.className = "wx-srv-message-delete-error";
          errorLine.textContent = "Couldn't delete message. Try again.";
          restored.appendChild(errorLine);
        }
      }
      if (error instanceof ServerLockedError) hooks.lockNow("unauthorized");
    } finally {
      inFlightDeletes.delete(message.seq);
      deleteEventsDuringRequest.delete(message.seq);
    }
  }

  function clearAfterWipe(): void {
    contentGeneration += 1;
    for (const timer of deleteFadeTimers.values()) win.clearTimeout(timer);
    deleteFadeTimers.clear();
    confirmedBySeq.clear();
    confirmedClientIds.clear();
    pendingEchoes = [];
    pendingClientId = null;
    hasMoreHistory = false;
    renderThreadList(false);
  }

  async function wipe(): Promise<void> {
    const session = currentSession;
    if (session === null) throw new Error("The server chat is locked.");
    await wipeChat(session);
    clearAfterWipe();
  }

  // -- History paging --------------------------------------------------------

  let observer: IntersectionObserver | null = null;

  function oldestLoadedSeq(): number | null {
    let oldest: number | null = null;
    for (const seq of confirmedBySeq.keys()) {
      if (oldest === null || seq < oldest) oldest = seq;
    }
    return oldest;
  }

  async function loadOlderPage(): Promise<void> {
    if (currentSession === null || historyLoading || !hasMoreHistory) return;
    const before = oldestLoadedSeq();
    if (before === null) return;
    historyLoading = true;
    try {
      const page = await getHistory(currentSession, { before, limit: HISTORY_PAGE_SIZE });
      const wasStuck = threadScroll.stuck;
      const prevScrollHeight = thread.scrollHeight;
      const prevScrollTop = thread.scrollTop;
      for (const message of page.messages) addConfirmed(message);
      hasMoreHistory = page.hasMore;
      renderThreadList(false);
      if (!wasStuck) {
        // Prepending older content must never visually jump the viewport —
        // restore the same distance from the (now-taller) top.
        thread.scrollTop = prevScrollTop + (thread.scrollHeight - prevScrollHeight);
      }
    } catch {
      // Best-effort — the sentinel simply becomes visible again on the next
      // scroll-near-top and retries.
    } finally {
      historyLoading = false;
    }
  }

  function ensureObserver(): void {
    if (observer !== null) return;
    const Ctor = (win as unknown as { IntersectionObserver?: typeof IntersectionObserver })
      .IntersectionObserver;
    if (Ctor === undefined) return; // no-op in an environment without it (e.g. a bare unit test)
    observer = new Ctor(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) void loadOlderPage();
        }
      },
      { root: thread },
    );
    observer.observe(sentinel);
  }

  // -- Send / echo reconciliation ---------------------------------------------

  function send(): void {
    if (currentSession === null) return;
    const session = currentSession;
    const requestGeneration = contentGeneration;
    const text = composer.text();
    composer.setBusy(true);
    composer.setError(null);
    // §5.3: clientId is 8-64 chars — a single UUID (36 chars) both stays in
    // range and is already globally unique on its own; concatenating the
    // deviceId in front (measured live: 73 chars) blew the 64-char cap and
    // made every real send 422 while the optimistic echo masked it.
    pendingClientId ??= cryptoRandomId(win);
    const clientId = pendingClientId;
    const echo: PendingEcho = { clientId, text: text === "" ? null : text, sentAt: now() };
    pendingEchoes.push(echo);
    threadScroll.scrollToBottom();
    renderThreadList();

    sendMessage(session, {
      clientId,
      sender: identity.getName() ?? "",
      deviceId: identity.getDeviceId(),
      text: text === "" ? null : text,
      attachmentIds: [],
      })
      .then((result) => {
        composer.setBusy(false);
        if (requestGeneration !== contentGeneration) {
          if (pendingClientId === clientId) pendingClientId = null;
          pendingEchoes = pendingEchoes.filter((e) => e.clientId !== clientId);
          renderThreadList(false);
          return;
        }
        if (result.ok) {
          pendingClientId = null;
          composer.reset();
          addConfirmed(result.message);
          renderThreadList();
          return;
        }
        pendingEchoes = pendingEchoes.filter((e) => e.clientId !== clientId);
        renderThreadList();
        composer.setError(result.kind === "invalid" ? result.detail : "Couldn't send — retry.");
      })
      .catch((error: unknown) => {
        if (error instanceof ServerLockedError) {
          hooks.lockNow("unauthorized");
          return;
        }
        composer.setBusy(false);
        pendingEchoes = pendingEchoes.filter((e) => e.clientId !== clientId);
        renderThreadList();
        composer.setError(error instanceof Error ? error.message : "Couldn't send — retry.");
      });
  }

  // -- attach / detach / stream events -----------------------------------------

  async function attach(session: ServerSession): Promise<number | null> {
    currentSession = session;
    if (historyLoaded) return null;
    historyErrorRow.hidden = true;
    try {
      const page = await getHistory(session, { limit: HISTORY_PAGE_SIZE });
      for (const message of page.messages) addConfirmed(message);
      hasMoreHistory = page.hasMore;
      historyLoaded = true;
      renderThreadList();
      ensureObserver();
      return page.cursor;
    } catch (error) {
      if (error instanceof ServerLockedError) throw error;
      historyErrorText.textContent =
        error instanceof Error ? error.message : "Couldn't load messages.";
      historyErrorRow.hidden = false;
      return null;
    }
  }

  retryButton.addEventListener("click", () => {
    if (currentSession !== null) void attach(currentSession);
  });

  return {
    element,
    attach,
    detach(): void {
      currentSession = null;
      for (const controller of messageActionControllers) controller.close();
      lightbox.teardown();
      // ServerChatView.detach()'s contract: pause media and exit fullscreen
      // — a lock (panic/idle/escape/…) mid-playback must never leave audio
      // or video running once the chat subtree is detached.
      for (const media of messageList.querySelectorAll("audio, video")) {
        (media as HTMLMediaElement).pause();
      }
      if (documentRef.fullscreenElement !== null) {
        void documentRef.exitFullscreen().catch(() => {});
      }
    },
    handleStreamEvent(event: ServerStreamEvent): void {
      switch (event.type) {
        case "message":
        case "message_updated":
          addConfirmed(event.message);
          renderThreadList(event.message.sender !== "" && !identity.isMine(event.message.sender));
          return;
        case "message_deleted":
          if (inFlightDeletes.has(event.seq)) {
            deleteEventsDuringRequest.add(event.seq);
            return;
          }
          confirmedBySeq.delete(event.seq);
          renderThreadList(false);
          return;
        case "wiped":
          clearAfterWipe();
          return;
        case "locked":
          // The stream's own `locked` event is handled by the caller
          // (chatView.ts), which owns the `ServerStreamHandle` — nothing to
          // do here.
          return;
      }
    },
    wipe,
    refreshNameChip,
    teardown(): void {
      currentSession = null;
      for (const controller of messageActionControllers) controller.teardown();
      messageActionControllers.length = 0;
      for (const timer of deleteFadeTimers.values()) win.clearTimeout(timer);
      deleteFadeTimers.clear();
      observer?.disconnect();
      lightbox.teardown();
      threadScroll.teardown();
      composer.teardown();
    },
  };
}

function cryptoRandomId(win: Window): string {
  const cryptoObj = win.crypto;
  if (typeof cryptoObj?.randomUUID === "function") return cryptoObj.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
