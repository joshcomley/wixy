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
import { uploadServerAttachment } from "./api/uploads";
import { getHistory, sendMessage, type Message } from "./api/messages";
import type { ServerIdentity } from "./identity";
import { linkifyInto } from "./linkify";
import { disposeAttachmentMedia, renderAttachments } from "./mediaRender";
import { createVoiceRecorder, type VoiceRecorder } from "./recorder";
import type { ServerStreamEvent } from "./stream";
import type { LockHooks, ServerSession } from "./types";

const HISTORY_PAGE_SIZE = 50;
const MIN_VOICE_DURATION_MS = 1_000;
/** A pending echo unmatched by a real message this long is dropped rather
 * than kept forever — mirrors the AI chat's own ECHO_EXPIRY_MS. */
const ECHO_EXPIRY_MS = 30_000;

export interface ServerThreadDeps {
  identity: ServerIdentity;
  hooks: LockHooks;
  win: Window;
  onSettings: () => void;
  document?: Document;
}

export interface ServerThreadView {
  readonly element: HTMLElement;
  /** Loads the newest history page, and on reattach refreshes every loaded
   * page so signed media URLs use the new session's expiry. Returns the
   * newest cursor. Throws `ServerLockedError` on a 401, letting the caller
   * lock; other failures are shown in-thread with a retry affordance. */
  attach(session: ServerSession): Promise<number | null>;
  /** Detaches from the DOM's interactive bits for a lock: closes the
   * lightbox and settings-sheet host, but keeps every message, the draft
   * text, and the scroll/echo state in memory for the next `attach`. */
  detach(): void;
  handleStreamEvent(event: ServerStreamEvent): void;
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
  settingsButton.textContent = "⚙";
  settingsButton.title = "Settings";
  settingsButton.setAttribute("aria-label", "Settings");
  settingsButton.setAttribute("data-srv-gesture-boundary", "");
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
  let currentSession: ServerSession | null = null;
  let voiceRecorder: VoiceRecorder | null = null;
  let composer: ChatComposer;
  const voiceDurations = new WeakMap<File, number>();

  const recordButton = documentRef.createElement("button");
  recordButton.type = "button";
  recordButton.className = "wx-srv-record-button";
  recordButton.textContent = "🎤";
  recordButton.title = "Record a voice note";
  recordButton.setAttribute("aria-label", "Record a voice note");
  const cancelRecordingButton = documentRef.createElement("button");
  cancelRecordingButton.type = "button";
  cancelRecordingButton.className = "wx-srv-record-cancel";
  cancelRecordingButton.textContent = "Cancel";
  cancelRecordingButton.hidden = true;
  const recordingStatus = documentRef.createElement("span");
  recordingStatus.className = "wx-srv-record-status";
  recordingStatus.hidden = true;
  recordingStatus.setAttribute("role", "status");
  recordingStatus.setAttribute("aria-live", "polite");

  function formatRecordingTime(milliseconds: number): string {
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function updateRecorderUi(elapsedMs = voiceRecorder?.elapsedMs ?? 0): void {
    const state = voiceRecorder?.state ?? "idle";
    const active = state !== "idle";
    cancelRecordingButton.hidden = !active;
    recordButton.disabled = state === "starting" || state === "stopping";
    if (state === "recording") {
      recordButton.textContent = "■";
      recordButton.title = "Stop recording";
      recordButton.setAttribute("aria-label", "Stop recording");
      recordingStatus.hidden = false;
      recordingStatus.textContent = `Recording ${formatRecordingTime(elapsedMs)}`;
    } else if (state === "starting") {
      recordButton.textContent = "🎤";
      recordButton.title = "Waiting for microphone";
      recordButton.setAttribute("aria-label", "Waiting for microphone");
      recordingStatus.hidden = false;
      recordingStatus.textContent = "Waiting for microphone…";
    } else if (state === "stopping") {
      recordingStatus.hidden = false;
      recordingStatus.textContent = "Saving voice note…";
    } else {
      recordButton.textContent = "🎤";
      recordButton.title = "Record a voice note";
      recordButton.setAttribute("aria-label", "Record a voice note");
      recordingStatus.hidden = true;
      recordingStatus.textContent = "";
    }
  }

  function createRecorder(): VoiceRecorder {
    return createVoiceRecorder({
      hooks,
      onTimer: (elapsedMs) => updateRecorderUi(elapsedMs),
      onStop: (recording) => {
        if (recording.durationMs < MIN_VOICE_DURATION_MS) {
          composer.setError("Too short. Record for at least one second.");
          updateRecorderUi();
          return;
        }
        // MediaRecorder may add codec parameters (for example
        // `audio/webm;codecs=opus`), while §5.5's declared-MIME allowlist is
        // the container type (`audio/webm`). The bytes are still sniffed and
        // decoded by the server's processing pipeline.
        const mimeType = recording.mimeType.split(";")[0] || "audio/webm";
        const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
        const file = new File([recording.blob], `voice-note.${extension}`, { type: mimeType });
        voiceDurations.set(file, recording.durationMs / 1000);
        composer.addFile(file);
        updateRecorderUi();
      },
      onCancel: () => updateRecorderUi(),
      onError: () => {
        composer.setError("Microphone access failed. Check the browser permission and try again.");
        updateRecorderUi();
      },
    });
  }

  function activeRecorder(): VoiceRecorder {
    voiceRecorder ??= createRecorder();
    return voiceRecorder;
  }

  recordButton.addEventListener("click", () => {
    if (currentSession === null) return;
    const recorder = activeRecorder();
    if (recorder.state === "idle") {
      composer.setError(null);
      const started = recorder.start();
      updateRecorderUi();
      void started.finally(() => updateRecorderUi());
    } else if (recorder.state === "recording") {
      recorder.stop();
      updateRecorderUi();
    }
  });
  cancelRecordingButton.addEventListener("click", () => {
    voiceRecorder?.cancel();
    updateRecorderUi();
  });

  composer = mountChatComposer({
    mode: "composer",
    placeholder: "Message…",
    submitLabel: "Send",
    win,
    accept: "image/*,video/*",
    acceptFile: (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
    onFilePickerOpen: () => hooks.suspend("filePicker"),
    extraButtons: [recordButton, cancelRecordingButton, recordingStatus],
    renderChipPreview: (file, previewUrl) => {
      if (file.type.startsWith("image/")) {
        const thumb = documentRef.createElement("img");
        thumb.className = "wx-chat-attachment-thumb";
        thumb.src = previewUrl;
        thumb.alt = "";
        return thumb;
      }
      const label = documentRef.createElement("span");
      label.className = "wx-srv-attachment-chip-label";
      label.textContent = file.type.startsWith("audio/") ? "🎤 Voice note" : "🎞 Video";
      return label;
    },
    upload: async (file, context) => {
      const session = currentSession;
      if (session === null) throw new Error("Unlock Server before adding media.");
      const kind = file.type.startsWith("audio/") ? "voice" : file.type.startsWith("video/") ? "video" : "photo";
      const durationS = voiceDurations.get(file);
      try {
        const attachment = await uploadServerAttachment(file, kind, session, {
          signal: context.signal,
          ...(durationS === undefined ? {} : { durationS }),
          onProgress: context.onProgress,
        });
        return { attachmentId: attachment.id, width: attachment.width, height: attachment.height };
      } catch (error) {
        if (error instanceof ServerLockedError) hooks.lockNow("unauthorized");
        throw error;
      }
    },
    onSubmit: () => send(),
  });
  composer.setAttachmentsSupported(true);
  const attachButton = composer.element.querySelector<HTMLButtonElement>(".wx-chat-attach-button");
  if (attachButton !== null) {
    attachButton.title = "Attach a photo or video";
    attachButton.setAttribute("aria-label", "Attach a photo or video");
  }
  element.appendChild(composer.element);

  // -- State ---------------------------------------------------------------

  let historyLoaded = false;
  let historyLoading = false;
  let hasMoreHistory = false;
  const confirmedBySeq = new Map<number, Message>();
  const confirmedClientIds = new Set<string>();
  let pendingEchoes: PendingEcho[] = [];
  let echoCounter = 0;
  let pendingClientId: string | null = null;

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

    disposeAttachmentMedia(messageList);
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
      attachmentIds: composer.attachmentIds(),
    })
      .then((result) => {
        composer.setBusy(false);
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
    if (voiceRecorder === null) voiceRecorder = createRecorder();
    const oldestSeqAtAttach = historyLoaded ? oldestLoadedSeq() : null;
    const retainedSeqsAtAttach = new Set(confirmedBySeq.keys());
    historyErrorRow.hidden = true;
    try {
      let before: number | undefined;
      let cursor: number | null = null;
      const refreshedMessages = new Map<number, Message>();
      while (true) {
        const page = await getHistory(
          session,
          before === undefined ? { limit: HISTORY_PAGE_SIZE } : { before, limit: HISTORY_PAGE_SIZE },
        );
        if (cursor === null) cursor = page.cursor;
        for (const message of page.messages) {
          if (oldestSeqAtAttach === null || message.seq >= oldestSeqAtAttach) {
            refreshedMessages.set(message.seq, message);
          }
        }
        if (oldestSeqAtAttach === null || page.messages.length === 0) {
          hasMoreHistory = page.hasMore;
          break;
        }
        if (page.messages.some((message) => message.seq <= oldestSeqAtAttach)) {
          hasMoreHistory = page.hasMore || page.messages.some((message) => message.seq < oldestSeqAtAttach);
          break;
        }
        if (!page.hasMore) {
          hasMoreHistory = false;
          break;
        }
        const nextBefore = Math.min(...page.messages.map((message) => message.seq));
        if (nextBefore === before) {
          hasMoreHistory = page.hasMore;
          break;
        }
        before = nextBefore;
      }
      if (oldestSeqAtAttach !== null) {
        // History omits deleted rows, and a wipe can return an empty first
        // page. Drop retained rows in the refreshed range before returning
        // the newer event cursor, or those events would be skipped on resume.
        for (const seq of retainedSeqsAtAttach) {
          if (seq >= oldestSeqAtAttach && !refreshedMessages.has(seq)) confirmedBySeq.delete(seq);
        }
      }
      for (const message of refreshedMessages.values()) addConfirmed(message);
      historyLoaded = true;
      renderThreadList();
      ensureObserver();
      return cursor;
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
      voiceRecorder?.detach();
      voiceRecorder = null;
      updateRecorderUi();
      disposeAttachmentMedia(messageList);
      lightbox.teardown();
      // ServerChatView.detach()'s contract: pause media, release any
      // mediaPlaying suspension, and exit fullscreen — a lock mid-playback
      // must never leave audio/video running once the subtree is detached.
      if (documentRef.fullscreenElement != null && typeof documentRef.exitFullscreen === "function") {
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
          confirmedBySeq.delete(event.seq);
          renderThreadList(false);
          return;
        case "wiped":
          confirmedBySeq.clear();
          confirmedClientIds.clear();
          pendingEchoes = [];
          hasMoreHistory = false;
          renderThreadList(false);
          return;
        case "locked":
          // The stream's own `locked` event is handled by the caller
          // (chatView.ts), which owns the `ServerStreamHandle` — nothing to
          // do here.
          return;
      }
    },
    refreshNameChip,
    teardown(): void {
      currentSession = null;
      voiceRecorder?.detach();
      voiceRecorder = null;
      disposeAttachmentMedia(messageList);
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
