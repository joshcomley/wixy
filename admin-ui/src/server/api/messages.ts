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

export interface Message {
  readonly seq: number;
  readonly clientId: string;
  readonly sender: string;
  readonly text: string | null;
  readonly attachments: readonly Attachment[];
  readonly createdAt: number;
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
}

export type SendMessageResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly kind: "invalid"; readonly detail: string }
  /** Any transport failure, or a status this client doesn't have a specific
   * mapping for — the composer surfaces a generic "couldn't send" error and
   * keeps the draft (retry reuses the same `clientId`, §5.3's idempotency). */
  | { readonly ok: false; readonly kind: "unavailable" };

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
