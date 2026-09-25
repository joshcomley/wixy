// The server chat's header, message thread (day separators, own/other
// alignment, history paging, optimistic echo) and composer — spec/server-
// chat/00-brief.md §10 P5b. Reuses the AI chat's own shared thread-scroll and
// lightbox extraction (P5a) and its generalized composer, so this view's
// scroll/jump-pill/composer behavior matches the AI chat's exactly. Layout
// mirrors the Inv 24 corollary: a flex column, the thread is the only scroll
// region, the composer is pinned by layout.

import type { ChatComposer, ComposerDraft } from "../chatComposer";
import { mountChatComposer } from "../chatComposer";
import { mountChatThreadScroll, type ChatThreadScroll } from "../chatThreadScroll";
import { mountLightbox, type Lightbox } from "../lightbox";
import {
  ServerErasureOutcomeUnknownError,
  ServerLockedError,
  ServerWipeAbandonedError,
  ServerWipeNotCommittedError,
} from "./api/http";
import { deleteMessage, getHistory, sendMessage, wipeChat, type Message, type ReplyTo } from "./api/messages";
import { uploadServerAttachment } from "./api/uploads";
import type { ServerIdentity } from "./identity";
import { linkifyInto } from "./linkify";
import { mountMessageActions, type MessageActionsController } from "./messageActions";
import { disposeAttachmentMedia, renderAttachments } from "./mediaRender";
import { createVoiceRecorder, type VoiceRecorder } from "./recorder";
import { renderReplyQuoteContent, replyToFromMessage } from "./replyTo";
import type { ServerStreamEvent } from "./stream";
import type { LockHooks, ServerSession } from "./types";
import { UPLOAD_GENERIC_FAILURE_MESSAGE, UploadError, isDefinitiveUploadRejection } from "./upload";

const HISTORY_PAGE_SIZE = 50;
const MIN_VOICE_DURATION_MS = 1_000;
/** A pending echo unmatched by a real message this long is dropped rather
 * than kept forever — mirrors the AI chat's own ECHO_EXPIRY_MS. */
const ECHO_EXPIRY_MS = 30_000;
const DELETE_FADE_MS = 160;
/** Backoff for reconciling an unconfirmed wipe against history: 1 s, 2 s, 4 s … capped. */
const WIPE_RECONCILE_BASE_DELAY_MS = 1_000;
const WIPE_RECONCILE_MAX_DELAY_MS = 15_000;
/** Round 2 ruling item 10 §(4): paging backwards to find a quote's original
 * message uses its own, larger page size than ordinary history scrolling. */
const SCROLL_TO_ORIGINAL_PAGE_SIZE = 100;
/** §(4): "highlights it for about 1.5 s." */
const SCROLL_TO_ORIGINAL_HIGHLIGHT_MS = 1_500;

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
  wipe(onOutcomeUnknown?: () => void): Promise<boolean>;
  /** Updates the header's name chip — called after the settings sheet (or
   * the first-unlock name prompt) commits a new name. */
  refreshNameChip(): void;
  teardown(): void;
}

interface PendingEcho {
  readonly clientId: string;
  readonly text: string | null;
  readonly sentAt: number;
  readonly replyTo: ReplyTo | null;
}

/** The composer's current reply target (round 2 ruling item 10 §(4)) — part
 * of the composer draft, so `takeServerDraft`/`restoreServerDraft` carry it
 * exactly like the text and staged attachments. */
interface PendingReplyTarget {
  readonly seq: number;
  readonly quote: ReplyTo;
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
  let pendingVoiceNote:
    | {
        readonly file: File;
        readonly clientId: string;
        attachmentId: string | null;
        readonly replyTo: PendingReplyTarget | null;
      }
    | null = null;
  let voiceSendBusy = false;

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
  const retryVoiceButton = documentRef.createElement("button");
  retryVoiceButton.type = "button";
  retryVoiceButton.className = "wx-srv-retry-voice-button";
  retryVoiceButton.textContent = "Retry voice note";
  retryVoiceButton.hidden = true;
  // No aria-label: the visible text IS the accessible name (WCAG 2.5.3 label in name).
  const discardVoiceButton = documentRef.createElement("button");
  discardVoiceButton.type = "button";
  discardVoiceButton.className = "wx-srv-discard-voice-button";
  discardVoiceButton.textContent = "Discard";
  discardVoiceButton.hidden = true;
  discardVoiceButton.setAttribute("aria-label", "Discard voice note");
  // Their own row under the composer's error line, shown only while there is a failed
  // note to act on: in the input row they would squeeze the text field to nothing on a
  // phone.
  const voiceFailureRow = documentRef.createElement("div");
  voiceFailureRow.className = "wx-srv-voice-failure-row";
  voiceFailureRow.hidden = true;
  voiceFailureRow.append(retryVoiceButton, discardVoiceButton);

  function formatRecordingTime(milliseconds: number): string {
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function updateRecorderUi(elapsedMs = voiceRecorder?.elapsedMs ?? 0): void {
    const state = voiceRecorder?.state ?? "idle";
    const active = state !== "idle";
    cancelRecordingButton.hidden = !active;
    recordButton.disabled = voiceSendBusy || pendingVoiceNote !== null
      || state === "starting" || state === "stopping";
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
    } else if (voiceSendBusy) {
      recordingStatus.hidden = false;
      recordingStatus.textContent = "Sending voice note…";
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
        // §(4): "A voice note captures the reply target at the moment
        // recording stops: the note becomes a reply and the bar clears."
        const capturedReplyTo = pendingReply;
        setPendingReply(null);
        pendingVoiceNote = {
          file,
          clientId: cryptoRandomId(win),
          attachmentId: null,
          replyTo: capturedReplyTo,
        };
        void sendVoiceNote();
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
    // Sending never disables, blurs or resizes the input (operator report, round 2): the box is
    // cleared at once by `takeDraft()` and the draft comes back on a failed send.
    keepInputLive: true,
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
  composer.element.appendChild(voiceFailureRow);

  // -- Reply bar (round 2 ruling item 10 §(4)) ------------------------------
  // Above the input row. Hidden by default (mount/hide, not append/remove —
  // matches the jump pill's and history-error row's own convention in this
  // file), so cancelling never disturbs layout beyond a plain [hidden] flip.

  const replyBar = documentRef.createElement("div");
  replyBar.className = "wx-srv-reply-bar";
  replyBar.hidden = true;
  const replyBarLabel = documentRef.createElement("span");
  replyBarLabel.className = "wx-srv-reply-bar-label";
  const replyBarQuote = documentRef.createElement("div");
  replyBarQuote.className = "wx-srv-reply-bar-quote";
  const replyBarCancel = documentRef.createElement("button");
  replyBarCancel.type = "button";
  replyBarCancel.className = "wx-srv-reply-bar-cancel";
  replyBarCancel.textContent = "✕";
  replyBarCancel.setAttribute("aria-label", "Cancel reply");
  replyBarCancel.addEventListener("click", () => setPendingReply(null));
  replyBar.append(replyBarLabel, replyBarQuote, replyBarCancel);

  element.appendChild(replyBar);
  element.appendChild(composer.element);

  // -- State ---------------------------------------------------------------

  let historyLoaded = false;
  let historyLoading = false;
  let hasMoreHistory = false;
  const confirmedBySeq = new Map<number, Message>();
  const deletedSeqs = new Set<number>();
  const confirmedClientIds = new Set<string>();
  const inFlightDeletes = new Set<number>();
  const deleteEventsDuringRequest = new Set<number>();
  const deleteFadeTimers = new Map<number, number>();
  const messageActionControllers = new Map<number, MessageActionsController>();
  const renderedMessages = new Map<number, { readonly message: Message; readonly element: HTMLElement }>();
  const daySeparators = new Map<number, HTMLElement>();
  const renderedEchoes = new Map<string, { readonly echo: PendingEcho; readonly element: HTMLElement }>();
  let emptyState: HTMLElement | null = null;
  let pendingEchoes: PendingEcho[] = [];
  let echoCounter = 0;
  let pendingClientId: string | null = null;
  let contentGeneration = 0;
  let contentRevision = 0;
  let latestKnownMessageSeq = 0;
  let pendingReply: PendingReplyTarget | null = null;
  /** Bumped by a lock (detach), a wipe, or another scroll-to-original tap —
   * §(4): "Abort on a lock, a wipe or another tap." */
  let scrollToOriginalGeneration = 0;

  function setPendingReply(target: PendingReplyTarget | null): void {
    const wasStuck = threadScroll.stuck;
    pendingReply = target;
    if (target === null) {
      replyBar.hidden = true;
    } else {
      replyBarLabel.textContent = `Replying to ${identity.isMine(target.quote.sender) ? "You" : target.quote.sender}`;
      replyBarQuote.replaceChildren(
        renderReplyQuoteContent(target.quote, { isMine: identity.isMine, document: documentRef }),
      );
      replyBar.hidden = false;
    }
    // §(4): "If the thread is at the bottom when the bar appears or
    // disappears, it stays at the bottom." `afterContentChange(false)` never
    // reveals the jump pill — this is a layout shift, not new content.
    threadScroll.afterContentChange(false);
  }

  function addConfirmed(message: Message): void {
    if (deletedSeqs.has(message.seq)) return;
    confirmedBySeq.set(message.seq, message);
    latestKnownMessageSeq = Math.max(latestKnownMessageSeq, message.seq);
    confirmedClientIds.add(message.clientId);
    contentRevision += 1;
  }

  /** A failed voice note stays pending so it can be retried (same `clientId`, and the same
   * uploaded attachment once it has one) — and can always be thrown away. */
  function setVoiceRetryOffered(offered: boolean): void {
    retryVoiceButton.hidden = !offered;
    discardVoiceButton.hidden = !offered;
    voiceFailureRow.hidden = !offered;
  }

  function offerVoiceRetry(): void {
    setVoiceRetryOffered(true);
  }

  /** Drops the pending voice note for good and frees the recorder, so the owner is never
   * stuck behind a note that cannot be sent (F17). If it had uploaded, that attachment is
   * left for the server's janitor to reap: the client only holds the attachment id, and
   * the cancel route takes the upload id. */
  function discardPendingVoiceNote(message: string | null): void {
    const focusWasInRow = voiceFailureRow.contains(documentRef.activeElement);
    pendingVoiceNote = null;
    setVoiceRetryOffered(false);
    composer.setError(message);
    updateRecorderUi();
    // Hiding the focused button would drop focus to the top of the page.
    if (focusWasInRow) recordButton.focus();
  }

  async function sendVoiceNote(): Promise<void> {
    const pending = pendingVoiceNote;
    const session = currentSession;
    if (pending === null || session === null || voiceSendBusy) return;
    voiceSendBusy = true;
    const focusWasInRow = voiceFailureRow.contains(documentRef.activeElement);
    retryVoiceButton.disabled = true;
    setVoiceRetryOffered(false);
    recordingStatus.hidden = false;
    recordingStatus.textContent = "Sending voice note…";
    composer.setError(null);
    updateRecorderUi();
    try {
      if (pending.attachmentId === null) {
        const durationS = voiceDurations.get(pending.file);
        const attachment = await uploadServerAttachment(
          pending.file,
          "voice",
          session,
          { ...(durationS === undefined ? {} : { durationS }) },
        );
        pending.attachmentId = attachment.id;
      }
      const sendSession = currentSession;
      if (sendSession === null) return;
      const result = await sendMessage(sendSession, {
        clientId: pending.clientId,
        sender: identity.getName() ?? "",
        deviceId: identity.getDeviceId(),
        text: null,
        attachmentIds: [pending.attachmentId],
        // §(4): "Its retries keep it (same clientId)" — the reply target
        // captured when recording stopped, independent of whatever the
        // composer bar shows now.
        ...(pending.replyTo !== null ? { replyToSeq: pending.replyTo.seq } : {}),
      });
      if (!result.ok) {
        if (result.kind === "invalid" || result.kind === "rejected") {
          // The server judged this exact note (the attachment failed processing, or was
          // reaped) and will judge it the same way again: a retry can never succeed.
          discardPendingVoiceNote("The server couldn't accept that voice note, so it was discarded. Record it again.");
          return;
        }
        composer.setError("Couldn't send voice note. Try again.");
        offerVoiceRetry();
        return;
      }
      if (pendingVoiceNote !== pending) return;
      pendingVoiceNote = null;
      addConfirmed(result.message);
      renderThreadList();
    } catch (error) {
      if (error instanceof ServerLockedError) {
        hooks.lockNow("unauthorized");
      } else if (error instanceof UploadError && isDefinitiveUploadRejection(error)) {
        const reason = error.message === UPLOAD_GENERIC_FAILURE_MESSAGE
          ? "The server couldn't accept that voice note."
          : error.message;
        discardPendingVoiceNote(`${reason} The voice note was discarded — record it again.`);
      } else {
        composer.setError(error instanceof Error && error.message !== ""
          ? `Couldn't send voice note: ${error.message}`
          : "Couldn't send voice note. Try again.");
        offerVoiceRetry();
      }
    } finally {
      voiceSendBusy = false;
      retryVoiceButton.disabled = false;
      if (pendingVoiceNote === null) recordingStatus.hidden = true;
      else if (retryVoiceButton.hidden) recordingStatus.hidden = true;
      updateRecorderUi();
      // Sending hid the Retry the user had focused. Put focus back where it still makes
      // sense: on Retry if it failed again, otherwise on the (now free) mic.
      if (focusWasInRow) {
        if (!retryVoiceButton.hidden) retryVoiceButton.focus();
        else recordButton.focus();
      }
    }
  }

  retryVoiceButton.addEventListener("click", () => void sendVoiceNote());
  discardVoiceButton.addEventListener("click", () => {
    if (voiceSendBusy) return;
    discardPendingVoiceNote(null);
  });

  function teardownMessageActions(seq: number): void {
    messageActionControllers.get(seq)?.teardown();
    messageActionControllers.delete(seq);
  }

  function renderAttachmentsFor(message: Message): HTMLElement | null {
    if (message.attachments.length === 0) return null;
    return renderAttachments(message.attachments, {
      hooks,
      openLightbox: (src, alt) => lightbox.open(src, alt),
      document: documentRef,
    });
  }

  function replyQuoteDisplayName(sender: string): string {
    return identity.isMine(sender) ? "You" : sender;
  }

  /** §(4): a `<button>` whose accessible name reads like "Show the original
   * message from <name>"; tapping it scrolls to the original (paging
   * backwards to find it if needed). It carries `data-srv-gesture-boundary`
   * — its tap makes a different control (the original) appear under the
   * finger, so a double-tap on a quote never locks either. */
  function renderReplyQuoteButton(replyTo: ReplyTo): HTMLButtonElement {
    const button = documentRef.createElement("button");
    button.type = "button";
    button.className = "wx-srv-quote";
    button.dataset["srvGestureBoundary"] = "";
    button.setAttribute(
      "aria-label",
      `Show the original message from ${replyQuoteDisplayName(replyTo.sender)}`,
    );
    button.appendChild(
      renderReplyQuoteContent(replyTo, { isMine: identity.isMine, document: documentRef }),
    );
    button.addEventListener("click", () => void scrollToOriginal(replyTo.seq, button));
    return button;
  }

  function renderBubble(message: Message, mine: boolean): HTMLElement {
    const bubble = documentRef.createElement("div");
    bubble.className = `wx-srv-bubble ${mine ? "wx-srv-bubble-mine" : "wx-srv-bubble-theirs"}`;
    bubble.dataset["messageSeq"] = String(message.seq);
    if (message.replyTo !== null) {
      bubble.appendChild(renderReplyQuoteButton(message.replyTo));
    }
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
    messageActionControllers.set(
      message.seq,
      mountMessageActions({
        message,
        bubble,
        win,
        document: documentRef,
        onDelete: deleteForEveryone,
        onReply: (target) => {
          setPendingReply({ seq: target.seq, quote: replyToFromMessage(target) });
          composer.focus();
        },
      }),
    );
    return bubble;
  }

  function renderEchoBubble(echo: PendingEcho): HTMLElement {
    const bubble = documentRef.createElement("div");
    bubble.className = "wx-srv-bubble wx-srv-bubble-mine wx-srv-echo";
    if (echo.replyTo !== null) {
      const quote = documentRef.createElement("div");
      quote.className = "wx-srv-quote";
      quote.appendChild(
        renderReplyQuoteContent(echo.replyTo, { isMine: identity.isMine, document: documentRef }),
      );
      bubble.appendChild(quote);
    }
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
    const messages = Array.from(confirmedBySeq.values()).sort((a, b) => a.seq - b.seq);
    const visibleEchoes = pendingEchoes.filter((echo) => !confirmedClientIds.has(echo.clientId));
    const desiredNodes: HTMLElement[] = [];
    const activeDays = new Set<number>();
    const nowDate = new Date();

    for (const message of messages) {
      const day = startOfLocalDay(message.createdAt);
      if (!activeDays.has(day)) {
        activeDays.add(day);
        let separator = daySeparators.get(day);
        if (separator === undefined) {
          separator = documentRef.createElement("div");
          separator.className = "wx-srv-day-separator";
          separator.appendChild(documentRef.createElement("span"));
          daySeparators.set(day, separator);
        }
        const label = separator.querySelector("span");
        if (label !== null) label.textContent = formatDaySeparator(message.createdAt, nowDate);
        desiredNodes.push(separator);
      }

      let rendered = renderedMessages.get(message.seq);
      if (rendered === undefined || rendered.message !== message) {
        if (rendered !== undefined) {
          teardownMessageActions(message.seq);
          disposeAttachmentMedia(rendered.element);
          rendered.element.remove();
        }
        rendered = { message, element: renderBubble(message, identity.isMine(message.sender)) };
        renderedMessages.set(message.seq, rendered);
      }
      desiredNodes.push(rendered.element);
    }

    const visibleSeqs = new Set(messages.map((message) => message.seq));
    for (const [seq, rendered] of renderedMessages) {
      if (!visibleSeqs.has(seq)) {
        teardownMessageActions(seq);
        disposeAttachmentMedia(rendered.element);
        rendered.element.remove();
        renderedMessages.delete(seq);
      }
    }
    for (const [day, separator] of daySeparators) {
      if (!activeDays.has(day)) {
        separator.remove();
        daySeparators.delete(day);
      }
    }

    const visibleEchoIds = new Set<string>();
    for (const echo of visibleEchoes) {
      visibleEchoIds.add(echo.clientId);
      let rendered = renderedEchoes.get(echo.clientId);
      if (rendered === undefined || rendered.echo !== echo) {
        rendered?.element.remove();
        rendered = { echo, element: renderEchoBubble(echo) };
        renderedEchoes.set(echo.clientId, rendered);
      }
      desiredNodes.push(rendered.element);
    }
    for (const [clientId, rendered] of renderedEchoes) {
      if (!visibleEchoIds.has(clientId)) {
        rendered.element.remove();
        renderedEchoes.delete(clientId);
      }
    }

    if (messages.length === 0 && visibleEchoes.length === 0) {
      if (emptyState === null) {
        emptyState = documentRef.createElement("p");
        emptyState.className = "wx-srv-thread-empty";
        emptyState.textContent = "No messages yet — say hello below.";
      }
      desiredNodes.push(emptyState);
    } else if (emptyState !== null) {
      emptyState.remove();
      emptyState = null;
    }

    // Reuse unchanged message nodes so ordinary incoming messages do not
    // pause/reset media already playing elsewhere in the thread.
    let current = messageList.firstChild;
    for (const node of desiredNodes) {
      if (node === current) {
        current = current.nextSibling;
      } else {
        messageList.insertBefore(node, current);
      }
    }
    while (current !== null) {
      const next = current.nextSibling;
      messageList.removeChild(current);
      current = next;
    }
    threadScroll.afterContentChange(revealPillIfNotStuck);
  }

  async function deleteForEveryone(message: Message): Promise<void> {
    const session = currentSession;
    if (session === null) return;
    const requestGeneration = contentGeneration;
    contentRevision += 1;
    deletedSeqs.add(message.seq);
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
      if (!deleteArrived && requestGeneration === contentGeneration) {
        deletedSeqs.delete(message.seq);
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
          errorLine.textContent = error instanceof ServerErasureOutcomeUnknownError
            ? "Couldn't confirm the delete — try again"
            : "Couldn't delete message. Try again.";
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
    contentRevision += 1;
    scrollToOriginalGeneration += 1; // §(4): a wipe aborts any in-flight scroll-to-original
    for (const timer of deleteFadeTimers.values()) win.clearTimeout(timer);
    deleteFadeTimers.clear();
    confirmedBySeq.clear();
    deletedSeqs.clear();
    confirmedClientIds.clear();
    pendingEchoes = [];
    pendingClientId = null;
    hasMoreHistory = false;
    // §(4): a wipe cancels the pending reply, same as ✕, a send, or the
    // target's own deletion.
    setPendingReply(null);
    renderThreadList(false);
  }

  async function getAllHistory(session: ServerSession): Promise<readonly Message[]> {
    const messages: Message[] = [];
    let before: number | undefined;
    while (true) {
      const page = await getHistory(
        session,
        before === undefined ? { limit: HISTORY_PAGE_SIZE } : { before, limit: HISTORY_PAGE_SIZE },
      );
      messages.push(...page.messages);
      if (!page.hasMore || page.messages.length === 0) return messages;
      const nextBefore = Math.min(...page.messages.map((message) => message.seq));
      if (nextBefore === before) return messages;
      before = nextBefore;
    }
  }

  /** The one unconfirmed-wipe reconciliation that may be running (F16). `end` settles it
   * from outside: the stream's `wiped` event proves it committed; a lock or teardown
   * abandons it. */
  interface WipeReconcile {
    end(reason: "committed" | "abandoned"): void;
  }
  let pendingWipeReconcile: WipeReconcile | null = null;

  function endWipeReconcile(reason: "committed" | "abandoned"): void {
    pendingWipeReconcile?.end(reason);
  }

  /** A wipe whose request timed out or dropped may or may not have committed, and a wipe
   * is never re-POSTed (it would delete anything sent since). So the thread reconciles
   * against the server's history instead — and keeps doing so, with backoff, until it gets
   * a definite answer: history with nothing at or before the wipe boundary means it
   * committed, history that still holds older messages means it did not, and the stream's
   * `wiped` event settles it either way. It gives up only when the chat locks or is torn
   * down. Resolves `true` (committed; the caller polls the erasure) or rejects with
   * `ServerWipeNotCommittedError` / `ServerLockedError` / `ServerWipeAbandonedError`,
   * which is what lets the settings sheet leave its "checking" state for good. */
  function reconcileUnknownWipe(
    session: ServerSession,
    wipeBoundarySeq: number,
    boundaryKnown: boolean,
  ): Promise<boolean> {
    endWipeReconcile("abandoned");
    return new Promise<boolean>((resolve, reject) => {
      let finished = false;
      let attempts = 0;
      let timer: number | null = null;

      const finish = (settle: () => void): void => {
        if (finished) return;
        finished = true;
        if (timer !== null) win.clearTimeout(timer);
        timer = null;
        if (pendingWipeReconcile === handle) pendingWipeReconcile = null;
        settle();
      };
      const handle: WipeReconcile = {
        end: (reason) =>
          finish(reason === "committed" ? () => resolve(true) : () => reject(new ServerWipeAbandonedError())),
      };
      pendingWipeReconcile = handle;

      const attempt = async (): Promise<void> => {
        timer = null;
        if (finished) return;
        let history: readonly Message[];
        try {
          history = await getAllHistory(session);
        } catch (error) {
          if (finished) return;
          if (error instanceof ServerLockedError) {
            finish(() => reject(error));
            return;
          }
          const delayMs = Math.min(WIPE_RECONCILE_BASE_DELAY_MS * 2 ** attempts, WIPE_RECONCILE_MAX_DELAY_MS);
          attempts += 1;
          timer = win.setTimeout(() => void attempt(), delayMs);
          return;
        }
        if (finished) return;

        // The boundary is the newest message seq the client KNEW about. If the history never
        // loaded, that is 0 and "nothing at or before it" is vacuously true, so a wipe that
        // never committed would be reported as deleted while messages remain. With an
        // unknown boundary the only safe proof of a commit is an EMPTY history (L3).
        const notCommitted = boundaryKnown
          ? history.some((message) => message.seq <= wipeBoundarySeq)
          : history.length > 0;
        if (notCommitted) {
          for (const message of history) addConfirmed(message);
          hasMoreHistory = false;
          renderThreadList(false);
          finish(() => reject(new ServerWipeNotCommittedError()));
          return;
        }

        const messagesArrivingDuringReconciliation = Array.from(confirmedBySeq.values())
          .filter((message) => message.seq > wipeBoundarySeq);
        clearAfterWipe();
        for (const message of messagesArrivingDuringReconciliation) addConfirmed(message);
        for (const message of history) addConfirmed(message);
        historyLoaded = true;
        hasMoreHistory = false;
        renderThreadList(false);
        finish(() => resolve(true));
      };
      void attempt();
    });
  }

  async function wipe(onOutcomeUnknown?: () => void): Promise<boolean> {
    const session = currentSession;
    if (session === null) throw new Error("The server chat is locked.");
    const requestGeneration = contentGeneration;
    const wipeBoundarySeq = latestKnownMessageSeq;
    const boundaryKnown = historyLoaded;
    let erasurePending: boolean;
    try {
      erasurePending = await wipeChat(session);
    } catch (error) {
      if (error instanceof ServerErasureOutcomeUnknownError) {
        onOutcomeUnknown?.();
        return reconcileUnknownWipe(session, wipeBoundarySeq, boundaryKnown);
      }
      throw error;
    }
    const reconcileWithoutClearing = requestGeneration !== contentGeneration;
    if (!reconcileWithoutClearing) clearAfterWipe();
    const refreshGeneration = contentGeneration;
    const refreshRevision = contentRevision;
    // Reconciliation is deliberately detached from this promise: a pending
    // scrub must reach the settings sheet immediately so it can show 202 status
    // and poll /usage without waiting on another history request.
    void getHistory(session, { limit: HISTORY_PAGE_SIZE })
      .then((page) => {
        if (
          currentSession !== session
          || refreshGeneration !== contentGeneration
          || refreshRevision !== contentRevision
        ) return;
        if (reconcileWithoutClearing) clearAfterWipe();
        for (const message of page.messages) addConfirmed(message);
        hasMoreHistory = page.hasMore;
        renderThreadList(false);
      })
      .catch((error: unknown) => {
        if (error instanceof ServerLockedError) hooks.lockNow("unauthorized");
      });
    return erasurePending;
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

  /** `"blocked"` — a DIFFERENT load (ordinary scroll paging, or a sibling
   * `scrollToOriginal` run) is already in flight — is distinct from
   * `"exhausted"` (`hasMoreHistory` is false) precisely so a caller racing
   * another load (§(4): "another tap") can retell them apart: worth
   * retrying vs. genuinely nothing more to page. `limit` defaults to the
   * ordinary scroll-driven page size; `scrollToOriginal` passes its own
   * larger one. */
  async function loadOlderPage(
    limit: number = HISTORY_PAGE_SIZE,
  ): Promise<"loaded" | "blocked" | "exhausted" | "error"> {
    if (currentSession === null) return "error";
    if (historyLoading) return "blocked";
    if (!hasMoreHistory) return "exhausted";
    const requestGeneration = contentGeneration;
    const session = currentSession;
    const before = oldestLoadedSeq();
    if (before === null) return "exhausted";
    historyLoading = true;
    try {
      const page = await getHistory(session, { before, limit });
      if (requestGeneration !== contentGeneration) return "error";
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
      return "loaded";
    } catch {
      // Best-effort — the sentinel simply becomes visible again on the next
      // scroll-near-top and retries.
      return "error";
    } finally {
      historyLoading = false;
    }
  }

  /** §(2)'s client mechanism for erasure, and §(4)'s "not found" fallback for
   * a scroll-to-original that never finds its target: remove the quote
   * element IN PLACE from every loaded bubble and pending echo that quotes
   * `seq`, and cancel the composer's pending reply if it targets `seq`.
   * Never re-renders a whole bubble — the same voice/video cut-off trap as
   * reactions. */
  function removeQuotesTargeting(seq: number): void {
    for (const rendered of renderedMessages.values()) {
      if (rendered.message.replyTo?.seq === seq) {
        rendered.element.querySelector(".wx-srv-quote")?.remove();
      }
    }
    for (const rendered of renderedEchoes.values()) {
      if (rendered.echo.replyTo?.seq === seq) {
        rendered.element.querySelector(".wx-srv-quote")?.remove();
      }
    }
    if (pendingReply?.seq === seq) setPendingReply(null);
  }

  /** §(4): tapping a quote scrolls to the original, paging backwards (the
   * quote shows busy meanwhile) if it isn't loaded yet. Not found after
   * paging exhausts → the target was deleted meanwhile; remove the quote.
   * Aborts on a lock, a wipe, or another tap — all three bump
   * `scrollToOriginalGeneration`. */
  async function scrollToOriginal(seq: number, button: HTMLButtonElement): Promise<void> {
    scrollToOriginalGeneration += 1;
    const generation = scrollToOriginalGeneration;
    button.classList.add("wx-srv-quote-busy");
    button.setAttribute("aria-busy", "true");
    try {
      while (!renderedMessages.has(seq)) {
        if (!hasMoreHistory) break;
        const result = await loadOlderPage(SCROLL_TO_ORIGINAL_PAGE_SIZE);
        if (generation !== scrollToOriginalGeneration) return;
        if (result === "loaded") continue;
        if (result === "blocked") {
          // A sibling load (ordinary scroll paging, or another
          // scrollToOriginal run) owns the single history-load slot right
          // now — yield and retry rather than treating this as exhausted.
          await Promise.resolve();
          continue;
        }
        break; // "exhausted" or "error" — nothing more to try.
      }
      if (generation !== scrollToOriginalGeneration) return;
      const rendered = renderedMessages.get(seq);
      if (rendered === undefined) {
        removeQuotesTargeting(seq);
        return;
      }
      const targetElement = rendered.element;
      const prefersReducedMotion =
        win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
      targetElement.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "center",
      });
      targetElement.classList.add("wx-srv-bubble-highlighted");
      win.setTimeout(() => {
        targetElement.classList.remove("wx-srv-bubble-highlighted");
      }, SCROLL_TO_ORIGINAL_HIGHLIGHT_MS);
    } finally {
      button.classList.remove("wx-srv-quote-busy");
      button.removeAttribute("aria-busy");
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

  /** §(4): "the reply target is part of the composer draft." A thin wrapper
   * around `chatComposer.ts`'s own (frozen, shared-with-the-AI-chat)
   * `takeDraft`/`restoreDraft`/`discardDraft` — only server chat uses
   * `keepInputLive`'s draft mechanism at all, so the reply target is carried
   * alongside it here rather than widening that shared component's type. */
  interface ServerComposerDraft {
    readonly base: ComposerDraft;
    readonly replyTo: PendingReplyTarget | null;
  }

  function takeServerDraft(): ServerComposerDraft {
    const base = composer.takeDraft();
    const replyTo = pendingReply;
    setPendingReply(null);
    return { base, replyTo };
  }

  function restoreServerDraft(draft: ServerComposerDraft): void {
    composer.restoreDraft(draft.base);
    // Never clobber a different reply the owner picked while the failed
    // send was in flight.
    if (draft.replyTo !== null && pendingReply === null) {
      setPendingReply(draft.replyTo);
    }
  }

  function discardServerDraft(draft: ServerComposerDraft): void {
    composer.discardDraft(draft.base);
  }

  function send(): void {
    if (currentSession === null) return;
    const session = currentSession;
    const requestGeneration = contentGeneration;
    // Lift the text and attachments out and clear the box at once: the optimistic echo below
    // already says "sending...", so the input itself never needs a busy state. It is never
    // disabled, blurred or resized (a disabled input drops focus, which on a phone closes and
    // reopens the soft keyboard - the flicker the operator reported), and a failed send gets
    // its draft back via `restoreDraft`.
    const draft = takeServerDraft();
    const text = draft.base.text;
    composer.setBusy(true);
    // §5.3: clientId is 8-64 chars — a single UUID (36 chars) both stays in
    // range and is already globally unique on its own; concatenating the
    // deviceId in front (measured live: 73 chars) blew the 64-char cap and
    // made every real send 422 while the optimistic echo masked it.
    pendingClientId ??= cryptoRandomId(win);
    const clientId = pendingClientId;
    const echo: PendingEcho = {
      clientId,
      text: text === "" ? null : text,
      sentAt: now(),
      replyTo: draft.replyTo?.quote ?? null,
    };
    pendingEchoes.push(echo);
    contentRevision += 1;
    threadScroll.scrollToBottom();
    renderThreadList();

    sendMessage(session, {
      clientId,
      sender: identity.getName() ?? "",
      deviceId: identity.getDeviceId(),
      text: text === "" ? null : text,
      attachmentIds: [...draft.base.attachmentIds],
      ...(draft.replyTo !== null ? { replyToSeq: draft.replyTo.seq } : {}),
    })
      .then((result) => {
        composer.setBusy(false);
        if (requestGeneration !== contentGeneration) {
          if (pendingClientId === clientId) pendingClientId = null;
          pendingEchoes = pendingEchoes.filter((e) => e.clientId !== clientId);
          renderThreadList(false);
          if (result.ok) discardServerDraft(draft);
          else restoreServerDraft(draft);
          return;
        }
        if (result.ok) {
          pendingClientId = null;
          discardServerDraft(draft);
          addConfirmed(result.message);
          renderThreadList();
          return;
        }
        pendingEchoes = pendingEchoes.filter((e) => e.clientId !== clientId);
        renderThreadList();
        restoreServerDraft(draft);
        composer.setError(result.kind === "invalid" ? result.detail : "Couldn't send — retry.");
      })
      .catch((error: unknown) => {
        composer.setBusy(false);
        restoreServerDraft(draft);
        if (error instanceof ServerLockedError) {
          hooks.lockNow("unauthorized");
          return;
        }
        pendingEchoes = pendingEchoes.filter((e) => e.clientId !== clientId);
        renderThreadList();
        composer.setError(error instanceof Error ? error.message : "Couldn't send — retry.");
      });
  }

  // -- attach / detach / stream events -----------------------------------------

  async function attach(session: ServerSession): Promise<number | null> {
    currentSession = session;
    if (voiceRecorder === null) voiceRecorder = createRecorder();
    const requestGeneration = contentGeneration;
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
        if (requestGeneration !== contentGeneration) return null;
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
      if (pendingVoiceNote !== null) void sendVoiceNote();
      return cursor;
    } catch (error) {
      if (requestGeneration !== contentGeneration) return null;
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
      endWipeReconcile("abandoned");
      // §(4): a lock aborts an in-flight scroll-to-original, but the pending
      // reply itself survives a lock exactly like the draft text (§(4)'s own
      // "A lock keeps it in memory exactly like the draft text").
      scrollToOriginalGeneration += 1;
      for (const controller of messageActionControllers.values()) controller.close();
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
          deletedSeqs.add(event.seq);
          contentRevision += 1;
          confirmedBySeq.delete(event.seq);
          // §(2)'s client mechanism: this seq's quote vanishes everywhere it
          // was shown, patched in place — the server does NOT fan out a
          // message_updated for replies on delete.
          removeQuotesTargeting(event.seq);
          if (inFlightDeletes.has(event.seq)) {
            deleteEventsDuringRequest.add(event.seq);
            renderThreadList(false);
            return;
          }
          renderThreadList(false);
          return;
        case "wiped":
          clearAfterWipe();
          // Truth arrives over the stream: if an unconfirmed wipe was still being
          // reconciled, this settles it as committed (F16).
          endWipeReconcile("committed");
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
      endWipeReconcile("abandoned");
      for (const controller of messageActionControllers.values()) controller.teardown();
      messageActionControllers.clear();
      for (const timer of deleteFadeTimers.values()) win.clearTimeout(timer);
      deleteFadeTimers.clear();
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
