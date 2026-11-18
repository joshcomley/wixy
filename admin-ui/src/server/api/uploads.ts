// Authenticated adapter for P6a's chunked uploader. Capture the session at
// upload start so the request sequence can finish if the panel locks midway.

import { uploadFile, uploadResponseError, UploadError, type UploadAttachment, type UploadKind } from "../upload";
import { createLiveVoiceUploader, type LiveVoiceUploader } from "../liveUpload";
import { ServerLockedError, serverFetch } from "./http";
import type { ServerSession } from "../types";

/** Chunk requests can carry 8 MiB by default, so they get more than the
 * short timeout used for ordinary chat API calls. The caller's AbortSignal
 * still cancels immediately on chip removal or view disposal. */
export const SERVER_UPLOAD_REQUEST_TIMEOUT_MS = 120_000;

export interface ServerUploadOptions {
  readonly signal?: AbortSignal;
  readonly durationS?: number;
  readonly onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

export function uploadServerAttachment(
  file: Blob,
  kind: UploadKind,
  session: ServerSession,
  options: ServerUploadOptions = {},
): Promise<UploadAttachment> {
  return uploadFile(file, kind, {
    endpoint: "/uploads",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.durationS === undefined ? {} : { durationS: options.durationS }),
    ...(options.onProgress === undefined ? {} : {
      onProgress: (progress) => options.onProgress?.(progress.uploadedBytes, progress.totalBytes),
    }),
    fetch: (input, init) => serverFetch(String(input), init ?? {}, session, SERVER_UPLOAD_REQUEST_TIMEOUT_MS),
  });
}

/** The live voice-note uploader, authenticated with whichever session is current: a recording
 * can outlive the token it began with, and a lock must make the next request a 401 rather than
 * reuse a dead one. */
export function createServerLiveUploader(
  getSession: () => ServerSession | null,
  options: {
    readonly mimeType: string;
    readonly deviceId: string;
    /** A live voice note people hear while it is recorded (spec/server-chat/07). */
    readonly listen?: boolean;
    readonly onLocked?: () => void;
  },
): LiveVoiceUploader {
  return createLiveVoiceUploader({
    mimeType: options.mimeType,
    deviceId: options.deviceId,
    ...(options.listen === true ? { listen: true } : {}),
    ...(options.onLocked === undefined ? {} : { onLocked: options.onLocked }),
    fetch: (path, init) => {
      const session = getSession();
      if (session === null) return Promise.reject(new ServerLockedError());
      return serverFetch(path, init, session, SERVER_UPLOAD_REQUEST_TIMEOUT_MS);
    },
  });
}

/** One live voice upload of this device that was never completed (spec/server-chat/06 §2.1). */
export interface UnsentUpload {
  readonly uploadId: string;
  readonly durationMs: number;
  readonly sizeBytes: number;
  readonly startedAt: number;
  readonly lastChunkAt: number | null;
}

/** `GET /uploads/unsent`. A server that predates live uploads answers 404/405: nothing to offer. */
export async function listUnsentUploads(session: ServerSession, deviceId: string): Promise<UnsentUpload[]> {
  const response = await serverFetch(
    `/uploads/unsent?deviceId=${encodeURIComponent(deviceId)}`,
    { method: "GET" },
    session,
  );
  if (response.status === 404 || response.status === 405) return [];
  if (!response.ok) throw new Error(`Couldn't load unsent voice notes (${response.status}).`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  const raw = (body as { unsent?: unknown } | null)?.unsent;
  if (!Array.isArray(raw)) return [];
  const entries: UnsentUpload[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.uploadId !== "string" || record.uploadId === "") continue;
    entries.push({
      uploadId: record.uploadId,
      durationMs: typeof record.durationMs === "number" && Number.isFinite(record.durationMs) ? record.durationMs : 0,
      sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : 0,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : 0,
      lastChunkAt: typeof record.lastChunkAt === "number" ? record.lastChunkAt : null,
    });
  }
  return entries;
}

/** Complete an unsent live upload with every contiguous chunk the server holds (no `chunkCount`). */
export async function completeUnsentUpload(session: ServerSession, uploadId: string): Promise<UploadAttachment> {
  const response = await serverFetch(
    `/uploads/${encodeURIComponent(uploadId)}/complete`,
    { method: "POST" },
    session,
    SERVER_UPLOAD_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) throw await uploadResponseError(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const attachment = (body as { attachment?: UploadAttachment } | null)?.attachment;
  if (!attachment) throw new UploadError("The server returned an invalid completed upload.", response.status);
  return attachment;
}

/** `DELETE /uploads/{id}`. An upload that is already gone (404) counts as discarded. */
export async function discardUpload(session: ServerSession, uploadId: string): Promise<void> {
  const response = await serverFetch(`/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" }, session);
  if (!response.ok && response.status !== 404) {
    throw new Error(`Couldn't discard the voice note (${response.status}).`);
  }
}
