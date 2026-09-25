// History + send (spec/server-chat/00-brief.md §5.2/§5.3/§5.9/§5.7) — this
// parcel's own `server/api/<area>.ts`, calling through P4's `serverFetch` so
// the token/401 handling stays in one place (`http.ts`'s own docstring).

import { ServerErasureOutcomeUnknownError, ServerLockedError, serverFetch } from "./http";
import type { ServerSession } from "../types";

export type AttachmentKind = "photo" | "video" | "voice";
export type AttachmentStatus = "processing" | "ready" | "failed";

export interface Attachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly status: AttachmentStatus;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationS: number | null;
  readonly peaks: readonly number[] | null;
  readonly urls: {
    readonly full?: string;
    readonly thumb?: string;
    readonly poster?: string;
    readonly play?: string;
  };
}

/** Round 2 ruling item 10 §(3): the `media` member of a quote — `null` for a
 * text-only target. `kind` is the quoted attachments' shared kind, or
 * `"mixed"`; `durationS` is the single voice note's or video's duration only
 * when `count === 1`; `thumbUrl` is a freshly signed URL for the FIRST
 * attachment's `thumb` (photo) or `poster` (video) rendition, only when that
 * attachment is `ready` — never `full`/`play`, and never present for voice. */
export interface ReplyToMedia {
  readonly kind: AttachmentKind | "mixed";
  readonly count: number;
  readonly durationS: number | null;
  readonly thumbUrl: string | null;
}

/** Round 2 ruling item 10 §(3): the `replyTo` member of the `Message` wire
 * shape — `null` for an ordinary message. Built fresh by the server from the
 * LIVE target row on every read (Inv 40/Inv 46): deleting the target makes
 * this `null` everywhere it was quoted, with no chat-visible tombstone. */
export interface ReplyTo {
  readonly seq: number;
  readonly sender: string;
  readonly text: string | null;
  readonly truncated: boolean;
  readonly media: ReplyToMedia | null;
}

export interface Message {
  readonly seq: number;
  readonly clientId: string;
  readonly sender: string;
  readonly text: string | null;
  readonly attachments: readonly Attachment[];
  readonly createdAt: number;
  readonly replyTo: ReplyTo | null;
}

export interface HistoryPage {
  readonly messages: readonly Message[];
  readonly hasMore: boolean;
  readonly cursor: number;
}

/** §5.2: `before` omitted fetches the newest page; the client walks OLDER
 * pages by passing the oldest loaded message's `seq` back in as `before`. */
export async function getHistory(
  session: ServerSession,
  opts: { before?: number; limit?: number } = {},
): Promise<HistoryPage> {
  const params = new URLSearchParams();
  if (opts.before !== undefined) params.set("before", String(opts.before));
  params.set("limit", String(opts.limit ?? 50));
  const response = await serverFetch(`/messages?${params.toString()}`, { method: "GET" }, session);
  if (!response.ok) throw new Error(`Couldn't load history (${response.status}).`);
  return (await response.json()) as HistoryPage;
}

export interface SendMessageInput {
  readonly clientId: string;
  readonly sender: string;
  readonly deviceId: string;
  readonly text: string | null;
  readonly attachmentIds: readonly string[];
  /** Round 2 ruling item 10 §(3): omit the key entirely for an ordinary
   * message — never send it as `undefined` explicitly. */
  readonly replyToSeq?: number;
}

export type SendMessageResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly kind: "invalid"; readonly detail: string }
  /** Any other 4xx except the transient 408/429: the server has judged this exact
   * payload and will judge it the same way again, so a retry cannot succeed. */
  | { readonly ok: false; readonly kind: "rejected"; readonly status: number }
  /** Any transport failure, or a status this client doesn't have a specific
   * mapping for — the composer surfaces a generic "couldn't send" error and
   * keeps the draft (retry reuses the same `clientId`, §5.3's idempotency). */
  | { readonly ok: false; readonly kind: "unavailable" };

/** A verdict on the SEND: a 4xx other than the transient 408 (timeout) and 429 (rate limit)
 * — and other than 403, which wixy's own send route never answers, so it can only come
 * from Cloudflare Access or a WAF in front of it (an expired session, a false positive)
 * and says nothing about the recording. (A 401 never gets here: `serverFetch` turns it into
 * a lock.) */
export function isDefinitiveSendRejectionStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 403 && status !== 408 && status !== 429;
}

export async function sendMessage(
  session: ServerSession,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  let response: Response;
  try {
    response = await serverFetch(
      "/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      session,
    );
  } catch (error) {
    // A 401 must keep propagating as a lock trigger (R6) — only a genuine
    // transport failure (network down, timeout) becomes "unavailable".
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  if (response.status === 201 || response.status === 200) {
    const body = (await response.json()) as { message: Message };
    return { ok: true, message: body.message };
  }
  if (response.status === 422) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null;
    return { ok: false, kind: "invalid", detail: body?.detail ?? "Couldn't send that message." };
  }
  if (isDefinitiveSendRejectionStatus(response.status)) {
    return { ok: false, kind: "rejected", status: response.status };
  }
  return { ok: false, kind: "unavailable" };
}

const DELETE_UNKNOWN_RETRY_MS = [1_000, 2_000, 4_000] as const;

function waitForDeleteRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function deleteMessage(session: ServerSession, seq: number): Promise<boolean> {
  const path = `/messages/${encodeURIComponent(String(seq))}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await serverFetch(path, { method: "DELETE" }, session);
      if (!response.ok) throw new Error(`Couldn't delete message (${response.status}).`);
      if (response.status === 202) {
        const body = (await response.json()) as { erasurePending: boolean };
        return body.erasurePending;
      }
      return false;
    } catch (error) {
      if (error instanceof ServerLockedError) throw error;
      if (!(error instanceof ServerErasureOutcomeUnknownError) || attempt >= DELETE_UNKNOWN_RETRY_MS.length) {
        throw error;
      }
      await waitForDeleteRetry(DELETE_UNKNOWN_RETRY_MS[attempt] ?? 4_000);
    }
  }
}

/** After a request was sent, a 408 or any 5xx says nothing about whether the server acted
 * on it: wixy's own commit may have landed, and Cloudflare (502/504/524...) sits in front
 * and answers for the origin. Only a 4xx says the request was refused. */
function isUnknownOutcomeStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

export async function wipeChat(session: ServerSession): Promise<boolean> {
  const response = await serverFetch(
    "/wipe",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "WIPE" }),
    },
    session,
  );
  // A wipe is not idempotent: reporting a committed wipe as a definite failure would invite
  // a second one that deletes everything sent since. Treat it like a dropped connection and
  // let the thread reconcile against history (never re-POSTing).
  if (isUnknownOutcomeStatus(response.status)) throw new ServerErasureOutcomeUnknownError();
  if (!response.ok) throw new Error(`Couldn't delete messages (${response.status}).`);
  if (response.status === 202) {
    const body = (await response.json()) as { erasurePending: boolean };
    return body.erasurePending;
  }
  return false;
}

export interface UsageInfo {
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly freeBytes: number;
  readonly mediaAvailable: boolean;
  readonly erasurePending: boolean;
}

export async function getUsage(session: ServerSession): Promise<UsageInfo> {
  const response = await serverFetch("/usage", { method: "GET" }, session);
  if (!response.ok) throw new Error(`Couldn't load storage usage (${response.status}).`);
  return (await response.json()) as UsageInfo;
}
