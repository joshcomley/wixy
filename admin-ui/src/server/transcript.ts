// The opt-in voice-note transcript control (spec/server-chat/05-voice-transcription.md).
//
// A ready voice note gets one `.wx-srv-transcript` block beneath it. It is never automatic and
// never on upload: the block starts as a "Transcribe" button (offered only while the server says
// cmd's private mode is live), becomes a spinner while the job runs, then the text with a
// per-device Hide/Show — or a plain error with Retry.
//
// Both devices render the SAME server state from the stream. When a `message_updated` event
// changes only a transcript, `thread.ts` does NOT rebuild the bubble (that would dispose a note
// that is playing — decisions/00166's "playing note survives" rule): it patches the existing
// blocks in place through `patchTranscriptBlocks`. Blocks own no media, so repainting one is safe.

import type { TranscribeAnswer } from "./api/messages";
import type { Attachment, AttachmentTranscript } from "./mediaRender";

/** What `thread.ts` supplies to every transcript block. */
export interface TranscriptionContext {
  /** Whether a new transcription may be requested (cmd's private mode is live). */
  available(): boolean;
  /** Asks the server to transcribe; resolves with its immediate answer. */
  request(attachmentId: string): Promise<TranscribeAnswer>;
  /** The server refused with "not available": hide every Transcribe control. */
  markUnavailable(): void;
  /** Per-device Hide/Show choice for a finished transcript (memory only, never persisted). */
  isHidden(attachmentId: string): boolean;
  setHidden(attachmentId: string, hidden: boolean): void;
}

interface Controller {
  update(transcript: AttachmentTranscript | null): void;
  refresh(): void;
}

const controllers = new WeakMap<HTMLElement, Controller>();

const MESSAGES = {
  failed: "Couldn't transcribe this voice note.",
  unavailable: "Transcription isn't available right now.",
  gone: "This voice note is no longer available.",
  notReady: "This voice note is still being processed — try again in a moment.",
  network: "Couldn't reach the server — try again.",
  empty: "No speech was picked up.",
} as const;

function rateLimitedMessage(retryAfterS: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterS));
  return `That's a lot of transcripts — try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
}

function action(documentRef: Document, className: string, label: string, ariaLabel: string): HTMLButtonElement {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = `wx-srv-transcript-action ${className}`;
  button.textContent = label;
  button.setAttribute("aria-label", ariaLabel);
  return button;
}

export function renderTranscriptBlock(
  attachment: Attachment,
  context: TranscriptionContext,
  documentRef: Document,
): HTMLElement {
  const root = documentRef.createElement("div");
  root.className = "wx-srv-transcript";
  root.dataset["attachmentId"] = attachment.id;

  let server: AttachmentTranscript | null = attachment.transcript ?? null;
  let requesting = false;
  let notice: string | null = null;
  // Counts the server states the STREAM has applied. A quick job can finish, and its update
  // reach us, before the slower HTTP reply to our own request does; that reply then describes
  // an older state ("pending") and must never overwrite the newer one.
  let streamUpdates = 0;

  function start(): void {
    if (requesting) return;
    requesting = true;
    notice = null;
    const updatesAtStart = streamUpdates;
    paint();
    void context.request(attachment.id).then((answer) => {
      requesting = false;
      switch (answer.kind) {
        case "started":
          if (streamUpdates === updatesAtStart) server = answer.transcript;
          break;
        case "done":
          server = answer.transcript; // a stored transcript is final, so never stale
          break;
        case "unavailable":
          notice = MESSAGES.unavailable;
          context.markUnavailable();
          break;
        case "rate_limited":
          notice = rateLimitedMessage(answer.retryAfterS);
          break;
        case "gone":
          notice = MESSAGES.gone;
          break;
        case "not_ready":
          notice = MESSAGES.notReady;
          break;
        case "failed":
          notice = MESSAGES.network;
          break;
      }
      paint();
    });
  }

  function paint(): void {
    const children: HTMLElement[] = [];
    let state: string;
    if (requesting || server?.status === "pending") {
      state = "pending";
      const line = documentRef.createElement("div");
      line.className = "wx-srv-transcript-pending";
      line.setAttribute("role", "status");
      const spinner = documentRef.createElement("span");
      spinner.className = "wx-srv-transcript-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = documentRef.createElement("span");
      label.textContent = "Transcribing…";
      line.append(spinner, label);
      children.push(line);
    } else if (server?.status === "done") {
      const text = server.text;
      const hidden = context.isHidden(attachment.id);
      state = hidden ? "hidden" : "done";
      if (text === "") {
        state = "empty";
        const none = documentRef.createElement("p");
        none.className = "wx-srv-transcript-empty";
        none.textContent = MESSAGES.empty;
        children.push(none);
      } else {
        if (!hidden) {
          const body = documentRef.createElement("p");
          body.className = "wx-srv-transcript-text";
          body.textContent = text;
          children.push(body);
        }
        const toggle = action(
          documentRef,
          "wx-srv-transcript-toggle",
          hidden ? "Show transcript" : "Hide transcript",
          hidden ? "Show transcript" : "Hide transcript",
        );
        toggle.addEventListener("click", () => {
          context.setHidden(attachment.id, !hidden);
          paint();
        });
        children.push(toggle);
      }
    } else if (server?.status === "failed") {
      state = "failed";
      const message = documentRef.createElement("p");
      message.className = "wx-srv-transcript-error";
      message.setAttribute("role", "status");
      message.textContent = notice ?? MESSAGES.failed;
      children.push(message);
      if (context.available()) {
        const retry = action(documentRef, "wx-srv-transcript-retry", "Retry", "Retry transcribing this voice note");
        retry.addEventListener("click", start);
        children.push(retry);
      }
    } else if (context.available()) {
      state = notice === null ? "idle" : "error";
      if (notice !== null) {
        const message = documentRef.createElement("p");
        message.className = "wx-srv-transcript-error";
        message.setAttribute("role", "status");
        message.textContent = notice;
        children.push(message);
      }
      const button = action(documentRef, "wx-srv-transcript-start", "Transcribe", "Transcribe this voice note");
      button.addEventListener("click", start);
      children.push(button);
    } else {
      state = notice === null ? "none" : "error";
      if (notice !== null) {
        const message = documentRef.createElement("p");
        message.className = "wx-srv-transcript-error";
        message.setAttribute("role", "status");
        message.textContent = notice;
        children.push(message);
      }
    }
    root.dataset["state"] = state;
    root.hidden = children.length === 0;
    root.replaceChildren(...children);
  }

  controllers.set(root, {
    update(transcript) {
      // A stale event that still says "never asked" must not undo a request that is in flight.
      if (transcript === null && requesting) return;
      streamUpdates += 1;
      server = transcript;
      if (transcript !== null) notice = null;
      paint();
    },
    refresh: paint,
  });
  paint();
  return root;
}

function transcriptBlocks(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".wx-srv-transcript"));
}

/** Repaint every transcript block under `root` from the server state carried by `attachments`,
 * leaving everything else in the bubble (notably a playing `<audio>`) untouched. */
export function patchTranscriptBlocks(root: ParentNode, attachments: readonly Attachment[]): void {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  for (const block of transcriptBlocks(root)) {
    const attachment = byId.get(block.dataset["attachmentId"] ?? "");
    if (attachment !== undefined) controllers.get(block)?.update(attachment.transcript ?? null);
  }
}

/** Repaint every block (the Transcribe control's availability changed). */
export function refreshTranscriptBlocks(root: ParentNode): void {
  for (const block of transcriptBlocks(root)) controllers.get(block)?.refresh();
}

interface ComparableMessage {
  readonly attachments: readonly Attachment[];
}

function withoutTranscripts(message: ComparableMessage): string {
  return JSON.stringify({
    ...message,
    attachments: message.attachments.map((attachment) => ({ ...attachment, transcript: null })),
  });
}

/** True when `next` differs from `prev` in nothing but voice-note transcripts — the one kind
 * of `message_updated` that can be applied to a live bubble without rebuilding it. Anything else
 * (media finishing processing, a re-signed URL, a text change...) still gets a fresh bubble. */
export function differOnlyInTranscripts(prev: ComparableMessage, next: ComparableMessage): boolean {
  return withoutTranscripts(prev) === withoutTranscripts(next);
}
