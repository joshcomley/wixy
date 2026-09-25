// Round 2 ruling item 10 (spec/server-chat/04-round2-rulings.md, ITEM 10 —
// REPLY TO A MESSAGE) §(3)/§(4): the client-side mirror of the server's
// `reply_to_json` (`wixy_server/livechat/models.py`) plus the quote content
// renderer shared by the composer's reply bar, a sent bubble's quote header,
// and the optimistic echo (§(4): "the quote (the same renderer as the
// bubble)"; "the echo renders the quote from the client-built replyTo").
//
// `replyToFromMessage` is the DRIFT-GUARD half of §(3)'s required guard: it
// and the server's `reply_to_json` are both asserted against the same shared
// fixture (spec/server-chat/fixtures/reply-to-cases.json) by
// wixy_server/tests/test_livechat_reply_to_driftguard.py and
// admin-ui/tests/server/replyTo.test.ts, so the two independent builders can
// never silently drift apart.

import { formatDuration } from "./mediaRender";
import type { Attachment, Message, ReplyTo, ReplyToMedia } from "./api/messages";

const REPLY_QUOTE_TEXT_MAX_CODEPOINTS = 300;

/** Builds the SAME `ReplyTo` shape the server computes at read time, from an
 * already-loaded target `Message` — used for the composer's reply-bar
 * preview (picked before the server has seen the not-yet-sent reply) and the
 * optimistic echo. Never persisted; rebuilt fresh every time it's needed. */
export function replyToFromMessage(message: Message): ReplyTo {
  const text = message.text;
  let snippet: string | null = text;
  let truncated = false;
  if (text !== null) {
    const codepoints = Array.from(text);
    if (codepoints.length > REPLY_QUOTE_TEXT_MAX_CODEPOINTS) {
      snippet = codepoints.slice(0, REPLY_QUOTE_TEXT_MAX_CODEPOINTS).join("");
      truncated = true;
    }
  }
  return {
    seq: message.seq,
    sender: message.sender,
    text: snippet,
    truncated,
    media: replyToMediaFromAttachments(message.attachments),
  };
}

function replyToMediaFromAttachments(attachments: readonly Attachment[]): ReplyToMedia | null {
  const first = attachments[0];
  if (first === undefined) return null;
  const kinds = new Set(attachments.map((a) => a.kind));
  const kind = kinds.size === 1 ? first.kind : "mixed";
  const count = attachments.length;
  const durationS = count === 1 ? first.durationS : null;
  const thumbUrl =
    first.kind === "photo" ? (first.urls.thumb ?? null)
    : first.kind === "video" ? (first.urls.poster ?? null)
    : null;
  return { kind, count, durationS, thumbUrl };
}

/** §(4)'s exact label set: "Photo", "Video", "Voice note · 0:42", "3
 * photos", "2 videos", "2 voice notes" or "4 attachments". */
export function formatReplyQuoteMediaLabel(media: ReplyToMedia): string {
  if (media.count === 1) {
    if (media.kind === "photo") return "Photo";
    if (media.kind === "video") return "Video";
    if (media.kind === "voice") return `Voice note · ${formatDuration(media.durationS ?? 0)}`;
    return "Attachment";
  }
  if (media.kind === "photo") return `${media.count} photos`;
  if (media.kind === "video") return `${media.count} videos`;
  if (media.kind === "voice") return `${media.count} voice notes`;
  return `${media.count} attachments`;
}

export interface ReplyQuoteContentOptions {
  readonly isMine: (sender: string) => boolean;
  readonly document?: Document;
}

/** §(4)'s shared quote content: an accent bar, the sender name ("You" when
 * `isMine`), the text snippet (clamped to 2 lines by CSS, with "…" when
 * truncated) and — independently, since either can be absent — a 40px
 * thumbnail when the quoted media has one, else its text label. The caller
 * wraps this in whatever interactive shell its context needs (a `<button>`
 * for a sent bubble's tap-to-scroll; a plain `<div>` for the composer's
 * static preview and the optimistic echo). */
export function renderReplyQuoteContent(
  replyTo: ReplyTo,
  options: ReplyQuoteContentOptions,
): HTMLElement {
  const documentRef = options.document ?? document;
  const root = documentRef.createElement("span");
  root.className = "wx-srv-quote-content";

  const bar = documentRef.createElement("span");
  bar.className = "wx-srv-quote-bar";
  bar.setAttribute("aria-hidden", "true");
  root.appendChild(bar);

  const body = documentRef.createElement("span");
  body.className = "wx-srv-quote-body";
  const senderEl = documentRef.createElement("span");
  senderEl.className = "wx-srv-quote-sender";
  senderEl.textContent = options.isMine(replyTo.sender) ? "You" : replyTo.sender;
  body.appendChild(senderEl);

  if (replyTo.text !== null && replyTo.text !== "") {
    const textEl = documentRef.createElement("span");
    textEl.className = "wx-srv-quote-text";
    textEl.textContent = replyTo.truncated ? `${replyTo.text}…` : replyTo.text;
    body.appendChild(textEl);
  }
  if (replyTo.media !== null && replyTo.media.thumbUrl === null) {
    const labelEl = documentRef.createElement("span");
    labelEl.className = "wx-srv-quote-media-label";
    labelEl.textContent = formatReplyQuoteMediaLabel(replyTo.media);
    body.appendChild(labelEl);
  }
  root.appendChild(body);

  if (replyTo.media !== null && replyTo.media.thumbUrl !== null) {
    const thumb = documentRef.createElement("img");
    thumb.className = "wx-srv-quote-thumb";
    thumb.src = replyTo.media.thumbUrl;
    thumb.alt = "";
    root.appendChild(thumb);
  }

  return root;
}
