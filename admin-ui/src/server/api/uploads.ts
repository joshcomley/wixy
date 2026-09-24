// Authenticated adapter for P6a's chunked uploader. Capture the session at
// upload start so the request sequence can finish if the panel locks midway.

import { uploadFile, type UploadAttachment, type UploadKind } from "../upload";
import { serverFetch } from "./http";
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
