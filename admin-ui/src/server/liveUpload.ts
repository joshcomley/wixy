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
  UploadError,
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
  /**
   * A live voice note others hear while it is recorded (spec/server-chat/07 §6.1): the init
   * carries `listen: true`, the server creates the attachment (status `live`) at once, and this
   * uploader then behaves differently in two ways. It never deletes the upload on its own once
   * the message references it (the caller decides: `cancel()` or Delete for everyone), and it is
   * patient: a slice that cannot be sent because the network is down or the server is struggling
   * is retried with backoff for up to `patienceMs`, not given up after three tries, because
   * listeners are hearing the recording right now and the server only ends the note on its own
   * after 60 s of silence.
   */
  readonly listen?: boolean;
  /** How long a listened-to upload keeps retrying one slice (default 45 s). */
  readonly patienceMs?: number;
  /** A slice upload found the session dead (401) while no caller was waiting on it. */
  readonly onLocked?: () => void;
  readonly retryDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

/** How the init of a live upload came out (the first thing a listened-to recording needs to know). */
export type LiveOpenResult =
  /** `attachment` is the server's `live` attachment of a listened-to upload; `null` for a plain one. */
  | { readonly kind: "opened"; readonly attachment: UploadAttachment | null }
  /** The chat already has two live recordings (409 `too_many_live`): record a normal note instead. */
  | { readonly kind: "too_many_live" }
  | { readonly kind: "failed" };

export interface LiveVoiceUploader {
  /** The server's id for the live upload, once it has been opened. */
  readonly uploadId: string | null;
  /** True for a listened-to upload (`listen: true`). */
  readonly listening: boolean;
  /** Settles once the init has been answered. Never rejects. */
  opened(): Promise<LiveOpenResult>;
  /** Tell the server whether the sender is recording or paused (listened-to uploads only). The
   * latest wish wins; failures are retried a few times and a note that has ended is ignored. */
  setLiveState(state: "recording" | "paused"): void;
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

const DEFAULT_LISTEN_PATIENCE_MS = 45_000;
const MAX_LISTEN_BACKOFF_MS = 4_000;
const MAX_STATE_ATTEMPTS = 5;
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
  const listen = opts.listen === true;
  const patienceMs = opts.patienceMs ?? DEFAULT_LISTEN_PATIENCE_MS;
  const now = opts.now ?? (() => Date.now());
  let outcome: LiveOpenResult = { kind: "failed" };
  let desiredState: "recording" | "paused" = "recording";
  let sentState: "recording" | "paused" = "recording";
  let statePump: Promise<void> | null = null;
  let stateRerun = false;
  /** The server answered that the note is not live any more: no more state updates. */
  let stateDead = false;

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
        body: JSON.stringify({
          kind: "voice",
          mimeType: opts.mimeType,
          live: true,
          deviceId: opts.deviceId,
          ...(listen ? { listen: true } : {}),
        }),
      });
      if (!response.ok) {
        if (listen && response.status === 409 && await isTooManyLive(response)) outcome = { kind: "too_many_live" };
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
      const found = (body as unknown as Record<string, unknown>)["attachment"];
      outcome = {
        kind: "opened",
        attachment: listen && isRecord(found) && typeof found["id"] === "string"
          ? (found as unknown as UploadAttachment)
          : null,
      };
      if (listen && outcome.attachment === null) {
        // A listened-to upload without the attachment the message needs cannot be used.
        outcome = { kind: "failed" };
        fail();
        deletion ??= deleteRemote(body.uploadId);
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
    // A listened-to upload that is already open is NOT deleted: a message references it and
    // people may be hearing it, so what the server holds stays until the caller decides (the
    // server ends a note nobody feeds after 60 s and processes what arrived).
    if (remoteId !== null && !listen) deletion ??= deleteRemote(remoteId);
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
      let result: OutOfOrderResult | null = null;
      let firstFailureAt: number | null = null;
      let waits = 0;
      for (;;) {
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
          break;
        } catch (error) {
          if (phase() !== "open") return;
          if (error instanceof ServerLockedError) {
            haltedValue = error;
            opts.onLocked?.();
            return;
          }
          // A listened-to recording outlasts a network blip: keep trying this slice (backing
          // off) while the failure looks temporary, rather than abandoning a note people hear.
          if (listen && isTransient(error)) {
            const at = now();
            firstFailureAt ??= at;
            if (at - firstFailureAt < patienceMs) {
              await sleep(Math.min(MAX_LISTEN_BACKOFF_MS, 500 * 2 ** waits));
              waits += 1;
              if (phase() !== "open") return;
              continue;
            }
          }
          fail();
          return;
        }
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

  /** `POST /uploads/{id}/live-state`. `done`: stored (204) or repeated; `gone`: the note is not live any more. */
  async function postState(id: string, state: "recording" | "paused"): Promise<"done" | "gone" | "retry"> {
    try {
      const response = await opts.fetch(`${endpoint}/${id}/live-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (response.ok) return "done";
      if (response.status === 404 || response.status === 409) return "gone";
      return RETRYABLE_STATUSES.has(response.status) ? "retry" : "gone";
    } catch (error) {
      if (error instanceof ServerLockedError) {
        opts.onLocked?.();
        return "gone";
      }
      return "retry";
    }
  }

  async function runStatePump(): Promise<void> {
    await ready;
    let attempts = 0;
    while (remoteId !== null && phase() === "open" && sentState !== desiredState) {
      const target = desiredState;
      const answer = await postState(remoteId, target);
      if (answer === "done") {
        sentState = target;
        attempts = 0;
      } else if (answer === "gone") {
        stateDead = true;
        return;
      } else if ((attempts += 1) >= MAX_STATE_ATTEMPTS) {
        return;
      } else {
        await sleep(retryDelayMs * 2 ** attempts);
      }
    }
  }

  function kickStatePump(): void {
    if (stateDead) return;
    if (statePump !== null) {
      // A wish that arrives while a request is in flight is picked up when it finishes.
      stateRerun = true;
      return;
    }
    statePump = runStatePump().finally(() => {
      statePump = null;
      if (stateRerun) {
        stateRerun = false;
        kickStatePump();
      }
    });
  }

  return {
    get uploadId() {
      return remoteId;
    },

    listening: listen,

    async opened(): Promise<LiveOpenResult> {
      await ready;
      return outcome;
    },

    setLiveState(state): void {
      if (!listen) return;
      desiredState = state;
      kickStatePump();
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

/** A failure that may pass: the network, a timeout, or a server that is busy or restarting. */
function isTransient(error: unknown): boolean {
  return error instanceof UploadError && (error.status === null || RETRYABLE_STATUSES.has(error.status));
}

async function isTooManyLive(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    return isRecord(body) && body["error"] === "too_many_live";
  } catch {
    return false;
  }
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
