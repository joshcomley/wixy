// Authenticated adapter for P6a's chunked uploader. Capture the session at
// upload start so the request sequence can finish if the panel locks midway.

import { uploadFile, type UploadAttachment, type UploadKind } from "../upload";
import { serverFetch } from "./http";
import type { ServerSession } from "../types";

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
    fetch: (input, init) => serverFetch(String(input), init ?? {}, session),
  });
}
