/**
 * Live voice-note upload (spec/server-chat/06-long-voice-notes.md §2.3).
 *
 * The recorder hands over a slice every 15 s. This uploads them while the note is still being
 * recorded: an init with `live: true`, the slices PUT strictly in order with one request in
 * flight (the shared per-chunk retry), and on stop a `complete` carrying the chunk count. Any
 * permanent failure stops the live upload, deletes it (best effort) and tells the caller to fall
 * back to uploading the whole kept recording the ordinary way — `finish()` resolves `null` and
 * has already finished deleting by then, so the fallback's own init can never be refused for the
 * space the abandoned live upload still holds.
 *
 * Nothing here touches browser storage (round-2 ruling): the recording lives in memory and on
 * the server.
 */

import { ServerLockedError } from "./api/http";
import {
  putChunkWithRetry,
  type OutOfOrderResult,
  type UploadAttachment,
  type UploadInit,
  type UploadOptions,
} from "./upload";

/** Fetch relative to the server-chat API base (`/uploads/...`), already authenticated. */
export type LiveFetch = (path: string, init: RequestInit) => Promise<Response>;

export interface LiveVoiceUploaderOptions {
  readonly fetch: LiveFetch;
  /** The recorder's container type without codec parameters, e.g. `audio/webm`. */
  readonly mimeType: string;
  readonly deviceId: string;
  readonly endpoint?: string;
  /** A slice upload found the session dead (401) while no caller was waiting on it. */
  readonly onLocked?: () => void;
  readonly retryDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface LiveVoiceUploader {
  /** The server's id for the live upload, once it has been opened. */
  readonly uploadId: string | null;
  /** Queue the next slice. Slices must arrive as index 0, 1, 2, ... */
  push(blob: Blob, index: number, elapsedMs: number): void;
  /**
   * Flush every slice and complete the upload. Resolves the attachment, or `null` when the live
   * upload failed for good (it is already deleted) and the caller must upload the whole
   * recording itself. Throws `ServerLockedError` when the session died: nothing is lost, and
   * calling `finish()` again after the next unlock carries on where it stopped.
   */
  finish(): Promise<UploadAttachment | null>;
  /** Discard: stop and DELETE the server's partial recording. */
  cancel(): Promise<void>;
  /** The chat locked: stop without deleting, so the recording is offered back as an unsent
   * voice note after the next unlock. */
  abandon(): void;
}

const MAX_RESYNCS = 5;
const MAX_COMPLETE_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

interface Slice {
  readonly blob: Blob;
  readonly elapsedMs: number;
}

type Phase = "open" | "failed" | "done" | "cancelled" | "abandoned";

export function createLiveVoiceUploader(opts: LiveVoiceUploaderOptions): LiveVoiceUploader {
  const endpoint = opts.endpoint ?? "/uploads";
  const request = ((input: RequestInfo | URL, init?: RequestInit) =>
    opts.fetch(String(input), init ?? {})) as typeof globalThis.fetch;
  const chunkOptions: UploadOptions = {
    ...(opts.retryDelayMs === undefined ? {} : { retryDelayMs: opts.retryDelayMs }),
    ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
  };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const retryDelayMs = opts.retryDelayMs ?? 250;

  // Read through functions, not bare variables: these change across awaits and in closures,
  // which flow analysis cannot see.
  let phaseValue: Phase = "open";
  const phase = (): Phase => phaseValue;
  let haltedValue: ServerLockedError | null = null;
  const halted = (): ServerLockedError | null => haltedValue;
  let pumpingValue: Promise<void> | null = null;
  const pumping = (): Promise<void> | null => pumpingValue;

  const slices: Slice[] = [];
  /** Index of the next slice to PUT; also this client's count of slices the server holds. */
  let nextToSend = 0;
  let resyncs = 0;
  let deletion: Promise<void> | null = null;
  let attachment: UploadAttachment | null = null;
  let remoteId: string | null = null;

  const ready: Promise<UploadInit | null> = open();

  async function open(): Promise<UploadInit | null> {
    try {
      const response = await opts.fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "voice", mimeType: opts.mimeType, live: true, deviceId: opts.deviceId }),
      });
      if (!response.ok) {
        fail();
        return null;
      }
      const body: unknown = await response.json();
      if (!isUploadInit(body)) {
        fail();
        return null;
      }
      remoteId = body.uploadId;
      if (phase() !== "open") {
        // Cancelled (or failed) while the init was still in flight: the upload now exists and
        // must not be left behind. An abandoned one is kept on purpose.
        if (phase() === "cancelled" || phase() === "failed") deletion ??= deleteRemote(body.uploadId);
        return null;
      }
      return body;
    } catch (error) {
      if (error instanceof ServerLockedError) opts.onLocked?.();
      fail();
      return null;
    }
  }

  /** The live upload cannot go on: stop sending and remove what the server holds. */
  function fail(): void {
    if (phase() !== "open") return;
    phaseValue = "failed";
    // Before the init answered there is nothing to delete yet: `open()` removes it if it lands.
    if (remoteId !== null) deletion ??= deleteRemote(remoteId);
  }

  async function deleteRemote(id: string): Promise<void> {
    try {
      await opts.fetch(`${endpoint}/${id}`, { method: "DELETE" });
    } catch {
      // Best effort: the janitor reaps an upload that is never completed.
    }
  }

  /** Everything the server will have been told to drop, once the init has settled. */
  async function settledDeletion(): Promise<void> {
    await ready;
    await deletion;
  }

  function ensurePump(): Promise<void> {
    pumpingValue ??= runPump().finally(() => { pumpingValue = null; });
    return pumpingValue;
  }

  async function runPump(): Promise<void> {
    const init = await ready;
    if (init === null) return;
    while (phase() === "open" && nextToSend < slices.length) {
      const slice = slices[nextToSend];
      if (slice === undefined) return;
      let result: OutOfOrderResult | null;
      try {
        result = await putChunkWithRetry({
          request,
          endpoint,
          uploadId: init.uploadId,
          index: nextToSend,
          chunk: slice.blob,
          signal: undefined,
          options: chunkOptions,
          durationMs: slice.elapsedMs,
        });
      } catch (error) {
        if (phase() !== "open") return;
        if (error instanceof ServerLockedError) {
          haltedValue = error;
          opts.onLocked?.();
          return;
        }
        fail();
        return;
      }
      if (phase() !== "open") return;
      if (result === null) {
        nextToSend += 1;
        continue;
      }
      // 409 out_of_order: the server holds fewer slices than this client thinks it sent. Resync
      // to the server's `next` — but only backwards (or in place); a server that is AHEAD of us
      // is not a state this client can reconcile.
      if (result.outOfOrderNext <= nextToSend && resyncs < MAX_RESYNCS) {
        resyncs += 1;
        nextToSend = result.outOfOrderNext;
        continue;
      }
      fail();
      return;
    }
  }

  /** Re-send slices the server reported missing at complete. False when one cannot be sent. */
  async function resendMissing(id: string, missing: readonly number[]): Promise<boolean> {
    for (const index of missing) {
      const slice = slices[index];
      if (slice === undefined) return false;
      try {
        const result = await putChunkWithRetry({
          request,
          endpoint,
          uploadId: id,
          index,
          chunk: slice.blob,
          signal: undefined,
          options: chunkOptions,
          durationMs: slice.elapsedMs,
        });
        if (result !== null) return false;
      } catch (error) {
        if (error instanceof ServerLockedError) throw error;
        return false;
      }
    }
    return true;
  }

  async function complete(id: string): Promise<UploadAttachment | null> {
    const chunkCount = slices.length;
    for (let attempt = 0; attempt < MAX_COMPLETE_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await opts.fetch(`${endpoint}/${id}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chunkCount }),
        });
      } catch (error) {
        if (error instanceof ServerLockedError) throw error;
        if (attempt === MAX_COMPLETE_ATTEMPTS - 1) return null;
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      if (response.ok) {
        const body = await readJson(response);
        const found = isRecord(body) ? body.attachment : undefined;
        return isRecord(found) ? (found as unknown as UploadAttachment) : null;
      }
      if (response.status === 409) {
        // `incomplete`: some slice below the count never landed. Send what is missing and ask again.
        const body = await readJson(response);
        const missing = isRecord(body) ? body.missing : undefined;
        if (Array.isArray(missing) && missing.every((value) => typeof value === "number")
          && await resendMissing(id, missing as number[])) {
          continue;
        }
        return null;
      }
      if (!RETRYABLE_STATUSES.has(response.status)) return null;
      if (attempt < MAX_COMPLETE_ATTEMPTS - 1) await sleep(retryDelayMs * 2 ** attempt);
    }
    return null;
  }

  return {
    get uploadId() {
      return remoteId;
    },

    push(blob, index, elapsedMs): void {
      if (phase() !== "open") return;
      if (index !== slices.length) {
        // A gap or a repeat: this upload can no longer be trusted to be one continuous stream.
        fail();
        return;
      }
      slices.push({ blob, elapsedMs });
      void ensurePump();
    },

    async finish(): Promise<UploadAttachment | null> {
      if (phase() === "done") return attachment;
      haltedValue = null;
      while (phase() === "open" && halted() === null && (nextToSend < slices.length || pumping() !== null)) {
        await ensurePump();
      }
      if (phase() === "open" && halted() === null && slices.length === 0) fail();
      if (phase() === "failed") {
        await settledDeletion();
        return null;
      }
      const lockedError = halted();
      if (lockedError !== null) throw lockedError;
      if (phase() !== "open") return null;
      const id = remoteId;
      const result = id === null ? null : await complete(id);
      if (result === null) {
        fail();
        await settledDeletion();
        return null;
      }
      phaseValue = "done";
      attachment = result;
      return result;
    },

    async cancel(): Promise<void> {
      const before = phase();
      if (before === "done" || before === "cancelled" || before === "abandoned") return;
      phaseValue = "cancelled";
      if (before === "open") {
        await ready;
        if (remoteId !== null) deletion ??= deleteRemote(remoteId);
      }
      await settledDeletion();
    },

    abandon(): void {
      const before = phase();
      if (before === "done" || before === "cancelled") return;
      phaseValue = "abandoned";
      slices.length = 0;
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isUploadInit(value: unknown): value is UploadInit {
  if (!isRecord(value)) return false;
  return typeof value.uploadId === "string"
    && value.uploadId !== ""
    && typeof value.chunkBytes === "number"
    && typeof value.maxBytes === "number";
}
