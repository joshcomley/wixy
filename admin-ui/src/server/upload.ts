/** Client-side implementation of the server-chat chunked upload contract. */

export type UploadKind = "photo" | "video" | "voice";

export const UPLOAD_MAX_BYTES: Readonly<Record<UploadKind, number>> = {
  photo: 30 * 1024 * 1024,
  voice: 25 * 1024 * 1024,
  video: 1024 * 1024 * 1024,
};

export const UPLOAD_MAX_DURATION_S: Readonly<Partial<Record<UploadKind, number>>> = {
  voice: 15 * 60,
  video: 10 * 60,
};

const DEFAULT_UPLOAD_PATH = "/api/admin/server/uploads";
const MAX_CHUNK_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface UploadInit {
  readonly uploadId: string;
  readonly chunkBytes: number;
  readonly maxBytes: number;
}

export interface UploadAttachment {
  readonly id: string;
  readonly kind: UploadKind;
  readonly status: "processing" | "ready" | "failed";
  readonly width: number | null;
  readonly height: number | null;
  readonly durationS: number | null;
  readonly peaks: number[] | null;
  readonly urls: {
    readonly full?: string;
    readonly thumb?: string;
    readonly poster?: string;
    readonly play?: string;
  };
}

export interface UploadProgress {
  readonly uploadedBytes: number;
  readonly totalBytes: number;
  readonly fraction: number;
}

export interface UploadOptions {
  readonly signal?: AbortSignal;
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly onProgress?: (progress: UploadProgress) => void;
  /** Optional duration metadata, when the caller has already inspected media. */
  readonly durationS?: number;
  readonly retryDelayMs?: number;
  /** Sleep is injectable so callers and tests can avoid real backoff waits. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** The message an `UploadError` carries when the server gave no more specific reason. */
export const UPLOAD_GENERIC_FAILURE_MESSAGE = "The upload could not be completed. Please try again.";

export class UploadError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

export function validateUploadSize(kind: UploadKind, sizeBytes: number): void {
  const maxBytes = UPLOAD_MAX_BYTES[kind];
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new UploadError("This file has an invalid size.");
  }
  if (sizeBytes > maxBytes) {
    throw new UploadError(`This ${kind} is too large (maximum ${formatBytes(maxBytes)}).`);
  }
}

/** Upload one file/blob, preserving the server's init → chunks → complete order. */
export async function uploadFile(
  file: Blob,
  kind: UploadKind,
  options: UploadOptions = {},
): Promise<UploadAttachment> {
  validateUploadSize(kind, file.size);
  validateUploadDuration(kind, options.durationS);
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? DEFAULT_UPLOAD_PATH;
  const signal = options.signal;
  throwIfAborted(signal);

  const filename = typeof File !== "undefined" && file instanceof File ? file.name : null;
  const initResponse = await request(endpoint, withSignal({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind,
      mimeType: file.type,
      sizeBytes: file.size,
      filename,
    }),
  }, signal));
  if (!initResponse.ok) {
    throw await uploadResponseError(initResponse);
  }
  const init = await parseJson<UploadInit>(initResponse);
  if (!isUploadInit(init)) {
    throw new UploadError("The server returned an invalid upload session.");
  }

  let cancellableUploadId: string | null = init.uploadId;
  try {
    const report = options.onProgress;
    report?.({ uploadedBytes: 0, totalBytes: file.size, fraction: file.size === 0 ? 1 : 0 });
    let uploadedBytes = 0;
    const chunkCount = Math.ceil(file.size / init.chunkBytes);
    for (let index = 0; index < chunkCount; index += 1) {
      throwIfAborted(signal);
      const start = index * init.chunkBytes;
      const chunk = file.slice(start, Math.min(start + init.chunkBytes, file.size));
      await putChunkWithRetry({ request, endpoint, uploadId: init.uploadId, index, chunk, signal, options });
      uploadedBytes += chunk.size;
      report?.({
        uploadedBytes,
        totalBytes: file.size,
        fraction: file.size === 0 ? 1 : uploadedBytes / file.size,
      });
    }

    throwIfAborted(signal);
    const completeResponse = await request(`${endpoint}/${init.uploadId}/complete`, withSignal({
      method: "POST",
    }, signal));
    if (!completeResponse.ok) {
      throw await uploadResponseError(completeResponse);
    }
    // A successful complete promotes the upload to an attachment; DELETE is
    // only for sessions that are still pending.
    cancellableUploadId = null;
    const complete = await parseJson<{ attachment?: UploadAttachment }>(completeResponse);
    if (!complete.attachment) {
      throw new UploadError("The server returned an invalid completed upload.");
    }
    report?.({ uploadedBytes: file.size, totalBytes: file.size, fraction: 1 });
    return complete.attachment;
  } catch (error) {
    if (cancellableUploadId !== null) {
      try {
        // Do not reuse the aborted upload signal: cleanup is best-effort but
        // should still reach the authenticated server after a user cancels.
        await request(`${endpoint}/${cancellableUploadId}`, { method: "DELETE" });
      } catch {
        // Keep the original upload/cancellation failure as the caller's result.
      }
    }
    throw error;
  }
}

/** Alias matching the terminology used by the server-chat composer. */
export const uploadAttachment = uploadFile;

interface ChunkRequest {
  readonly request: typeof globalThis.fetch;
  readonly endpoint: string;
  readonly uploadId: string;
  readonly index: number;
  readonly chunk: Blob;
  readonly signal: AbortSignal | undefined;
  readonly options: UploadOptions;
}

async function putChunkWithRetry(input: ChunkRequest): Promise<void> {
  const delayMs = input.options.retryDelayMs ?? 250;
  const sleep = input.options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt += 1) {
    throwIfAborted(input.signal);
    try {
      const response = await input.request(
        `${input.endpoint}/${input.uploadId}/chunks/${input.index}`,
        withSignal({
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: input.chunk,
        }, input.signal),
      );
      if (response.ok) return;
      const error = await uploadResponseError(response);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_CHUNK_ATTEMPTS - 1) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      if (isAbortError(error) || input.signal?.aborted) throw error;
      if (error instanceof UploadError && !RETRYABLE_STATUSES.has(error.status ?? -1)) throw error;
      lastError = error;
      if (attempt === MAX_CHUNK_ATTEMPTS - 1) break;
    }
    await sleep(delayMs * 2 ** attempt);
  }

  if (lastError instanceof UploadError) throw lastError;
  throw new UploadError(UPLOAD_GENERIC_FAILURE_MESSAGE, null);
}

async function uploadResponseError(response: Response): Promise<UploadError> {
  const messageByStatus: Readonly<Record<number, string>> = {
    413: "This file is too large.",
    415: "This file type isn't supported.",
    507: "Not enough storage is available.",
    503: "Media processing is currently unavailable.",
  };
  const statusMessage = messageByStatus[response.status];
  if (statusMessage) return new UploadError(statusMessage, response.status);

  let serverError: unknown;
  try {
    serverError = await response.clone().json();
  } catch {
    serverError = null;
  }
  if (isErrorPayload(serverError)) {
    const payloadMessages: Readonly<Record<string, string>> = {
      too_large: "This file is too large.",
      unsupported_type: "This file type isn't supported.",
      storage_full: "Not enough storage is available.",
      media_unavailable: "Media processing is currently unavailable.",
    };
    const payloadMessage = payloadMessages[serverError.error];
    if (payloadMessage) return new UploadError(payloadMessage, response.status);
  }
  return new UploadError(UPLOAD_GENERIC_FAILURE_MESSAGE, response.status);
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new UploadError("The server returned an invalid response.", response.status);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The upload was aborted.", "AbortError");
}

function validateUploadDuration(kind: UploadKind, durationS: number | undefined): void {
  if (durationS === undefined) return;
  if (!Number.isFinite(durationS) || durationS < 0) {
    throw new UploadError("This file has an invalid duration.");
  }
  const maxDuration = UPLOAD_MAX_DURATION_S[kind];
  if (maxDuration !== undefined && durationS > maxDuration) {
    throw new UploadError(`This ${kind} is too long (maximum ${formatDuration(maxDuration)}).`);
  }
}

function withSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal ? { ...init, signal } : init;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isUploadInit(value: unknown): value is UploadInit {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.uploadId === "string"
    && typeof candidate.chunkBytes === "number"
    && candidate.chunkBytes > 0
    && typeof candidate.maxBytes === "number";
}

function isErrorPayload(value: unknown): value is { readonly error: string } {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as Record<string, unknown>).error === "string";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${bytes / (1024 * 1024 * 1024)} GiB`;
  return `${bytes / (1024 * 1024)} MiB`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes} minutes` : `${minutes} minutes ${remainder} seconds`;
}
