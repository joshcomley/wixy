// The live message stream (spec/server-chat/00-brief.md §5.4, §10 P5b) —
// fetch-SSE rather than the browser's native `EventSource`: `EventSource`
// can't send the `X-Wixy-Server-Token` header §5's auth requires, so this
// module hand-parses `text/event-stream` frames off a plain `fetch()` body
// reader instead.

import { SERVER_API_BASE } from "./api/http";
import type { Message } from "./api/messages";
import type { ServerSession } from "./types";

export type ServerStreamEvent =
  | { readonly type: "message"; readonly message: Message }
  | { readonly type: "message_updated"; readonly message: Message }
  /** §17.2's A1 amendment — P1 already emits the schema/stream headroom for
   * this; nothing produces it for real until P8. Handled here defensively so
   * this parser never chokes on it once P8 lands. */
  | { readonly type: "message_deleted"; readonly seq: number }
  /** Same A1 headroom as `message_deleted` — no real emitter until P8. */
  | { readonly type: "wiped" }
  /** Either the initial connection got a 401, or an in-stream `event: locked`
   * arrived (the token expired mid-stream, §5.4) — both are R6's single
   * "401/locked" lock trigger; the caller maps this to
   * `hooks.lockNow("unauthorized")`. */
  | { readonly type: "locked" };

export interface ServerStreamHandle {
  close(): void;
  /** The highest event id processed so far (starting from the `after` this
   * handle was opened with) — read this right after `close()` to know what
   * `after` a future `openServerStream` reconnect should resume from (e.g.
   * `thread.ts` across a detach/attach cycle). Keeps updating live while
   * connected; safe to call at any time. */
  getCursor(): number;
}

export interface OpenServerStreamDeps {
  win?: Window;
  fetchImpl?: typeof fetch;
}

/** §5.4: "reconnects if it receives no bytes for 45s." */
const WATCHDOG_MS = 45_000;
/** §5.4/§10: "reconnect/backoff (1→2→5→10s)." */
const RECONNECT_BACKOFF_S = [1, 2, 5, 10] as const;

export interface SseFrame {
  readonly id: number | null;
  readonly event: string;
  readonly data: string;
}

/** A `: ping\n\n` comment frame (§5.4, every 15s) has no `event:`/`data:`
 * lines at all — parsed as `null` (nothing to dispatch), same treatment as a
 * genuinely empty frame. Exported (along with `mapSseEvent`) so the parser
 * itself gets direct unit coverage, independent of the reconnect machinery
 * around it. */
export function parseSseFrame(raw: string): SseFrame | null {
  if (raw.startsWith(":")) return null;
  let id: number | null = null;
  let event = "message"; // SSE's own default event name when `event:` is absent
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) {
      const parsed = Number(line.slice(3).trim());
      if (Number.isFinite(parsed)) id = parsed;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0 && event === "message") return null;
  return { id, event, data: dataLines.join("\n") };
}

/** Maps one parsed SSE frame to this module's own event union — an
 * unrecognized `event:` name (a future addition the client hasn't been
 * taught yet, or a stray/malformed frame) is silently skipped rather than
 * thrown, so the stream itself never dies on it (the brief's own directive:
 * "code your event switch to not choke on an unrecognized-but-hardwired-
 * in-spec event type"). A malformed `data:` payload is treated the same way. */
export function mapSseEvent(frame: SseFrame): ServerStreamEvent | null {
  try {
    switch (frame.event) {
      case "message":
        return { type: "message", message: JSON.parse(frame.data) as Message };
      case "message_updated":
        return { type: "message_updated", message: JSON.parse(frame.data) as Message };
      case "message_deleted": {
        const parsed = JSON.parse(frame.data) as { seq: number };
        return { type: "message_deleted", seq: parsed.seq };
      }
      case "wiped":
        return { type: "wiped" };
      case "locked":
        return { type: "locked" };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Opens the live stream from `after` (the history page's own cursor, or the
 * last event id this handle has already delivered on a reconnect) and calls
 * `onEvent` for every real event. Reconnects on its own with backoff; the
 * caller only needs `close()` on detach/dispose. */
export function openServerStream(
  session: ServerSession,
  after: number,
  onEvent: (event: ServerStreamEvent) => void,
  deps: OpenServerStreamDeps = {},
): ServerStreamHandle {
  const win = deps.win ?? window;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let cursor = after;
  let closed = false;
  let controller: AbortController | null = null;
  let backoffIndex = 0;
  let watchdogTimer: ReturnType<typeof win.setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof win.setTimeout> | null = null;

  function clearWatchdog(): void {
    if (watchdogTimer !== null) {
      win.clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function armWatchdog(): void {
    clearWatchdog();
    watchdogTimer = win.setTimeout(() => controller?.abort(), WATCHDOG_MS);
  }

  function scheduleReconnect(): void {
    if (closed) return;
    // The `?? 10` fallback is unreachable (Math.min always clamps the index
    // in-bounds) — it exists only to satisfy noUncheckedIndexedAccess.
    const delayS = RECONNECT_BACKOFF_S[Math.min(backoffIndex, RECONNECT_BACKOFF_S.length - 1)] ?? 10;
    backoffIndex += 1;
    reconnectTimer = win.setTimeout(() => {
      void connect();
    }, delayS * 1000);
  }

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    armWatchdog();

    let response: Response;
    try {
      response = await fetchImpl(`${SERVER_API_BASE}/stream?after=${cursor}`, {
        headers: { "X-Wixy-Server-Token": session.token, Accept: "text/event-stream" },
        signal: controller.signal,
      });
    } catch {
      clearWatchdog();
      scheduleReconnect();
      return;
    }

    if (response.status === 401) {
      clearWatchdog();
      onEvent({ type: "locked" });
      closed = true;
      return;
    }
    if (!response.ok || response.body === null) {
      clearWatchdog();
      scheduleReconnect();
      return;
    }

    // A connection actually succeeded — the next failure starts the backoff
    // ladder over from its shortest rung.
    backoffIndex = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let receivedLocked = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armWatchdog();
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
          const rawFrame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const frame = parseSseFrame(rawFrame);
          if (frame === null) continue;
          if (frame.id !== null) cursor = frame.id;
          const mapped = mapSseEvent(frame);
          if (mapped === null) continue;
          onEvent(mapped);
          if (mapped.type === "locked") receivedLocked = true;
        }
      }
    } catch {
      // Aborted (watchdog timeout or close()) or a network error mid-read —
      // either way, fall through to the reconnect decision below.
    } finally {
      clearWatchdog();
    }
    if (receivedLocked) {
      // §5.4: "the server closes after it" — a locked stream is terminal,
      // never worth reconnecting (the same token would just 401 again).
      closed = true;
      return;
    }
    if (!closed) scheduleReconnect();
  }

  void connect();

  return {
    close(): void {
      closed = true;
      controller?.abort();
      if (reconnectTimer !== null) win.clearTimeout(reconnectTimer);
      clearWatchdog();
    },
    getCursor(): number {
      return cursor;
    },
  };
}
