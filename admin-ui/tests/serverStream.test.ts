import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/server/api/messages";
import { mapSseEvent, openServerStream, parseSseFrame, type ServerStreamEvent } from "../src/server/stream";
import type { ServerSession } from "../src/server/types";

// ---------------------------------------------------------------------------
// parseSseFrame / mapSseEvent — the pure parser.
// ---------------------------------------------------------------------------

describe("parseSseFrame", () => {
  it("parses id/event/data into a frame", () => {
    expect(parseSseFrame('id: 42\nevent: message\ndata: {"seq":42}')).toEqual({
      id: 42,
      event: "message",
      data: '{"seq":42}',
    });
  });

  it("defaults the event name to \"message\" when event: is absent", () => {
    expect(parseSseFrame('data: {"seq":1}')).toEqual({ id: null, event: "message", data: '{"seq":1}' });
  });

  it("treats a ping comment line as nothing to dispatch", () => {
    expect(parseSseFrame(": ping")).toBeNull();
  });

  it("returns null for a frame with no data and no explicit event", () => {
    expect(parseSseFrame("id: 5")).toBeNull();
  });

  it("parses a frame with no id (e.g. the wiped/locked shapes)", () => {
    expect(parseSseFrame("event: locked\ndata: {}")).toEqual({ id: null, event: "locked", data: "{}" });
  });

  it("joins multi-line data payloads with newlines", () => {
    expect(parseSseFrame("event: message\ndata: line one\ndata: line two")).toEqual({
      id: null,
      event: "message",
      data: "line one\nline two",
    });
  });
});

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    seq: 1,
    clientId: "c1",
    sender: "Josh",
    text: "hi",
    attachments: [],
    reactions: [],
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

describe("mapSseEvent", () => {
  it("maps a message frame", () => {
    const message = fakeMessage();
    const mapped = mapSseEvent({ id: 1, event: "message", data: JSON.stringify(message) });
    expect(mapped).toEqual({ type: "message", message });
  });

  it("maps a message_updated frame", () => {
    const message = fakeMessage({ seq: 2 });
    const mapped = mapSseEvent({ id: 2, event: "message_updated", data: JSON.stringify(message) });
    expect(mapped).toEqual({ type: "message_updated", message });
  });

  it("maps a message_deleted frame (P8 headroom — not emitted by P1 yet)", () => {
    const mapped = mapSseEvent({ id: 3, event: "message_deleted", data: '{"seq":7}' });
    expect(mapped).toEqual({ type: "message_deleted", seq: 7 });
  });

  it("maps a wiped frame (P8 headroom)", () => {
    expect(mapSseEvent({ id: 4, event: "wiped", data: "{}" })).toEqual({ type: "wiped" });
  });

  it("maps a locked frame", () => {
    expect(mapSseEvent({ id: null, event: "locked", data: "{}" })).toEqual({ type: "locked" });
  });

  it("returns null for an unrecognized event type instead of throwing", () => {
    expect(mapSseEvent({ id: 9, event: "some_future_event", data: "{}" })).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(mapSseEvent({ id: 1, event: "message", data: "{not json" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// openServerStream — connection, event dispatch, reconnect/backoff.
// ---------------------------------------------------------------------------

const SESSION: ServerSession = { token: "tok-1", expiresAt: 9_999_999_999 };

function sseBody(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = frames.map((f) => `${f}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function okResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200 });
}

/** A response whose read() never resolves on its own — only when the fetch
 * call's own AbortSignal fires, at which point it resolves as a clean EOF
 * (mirroring how a real aborted fetch's body reader settles). Lets the
 * watchdog/close() tests drive a "stalled connection" deterministically. */
function stalledResponse(signal: AbortSignal): Response {
  let settled = false;
  const reader = {
    read(): Promise<{ done: true; value?: undefined }> {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          if (!settled) {
            settled = true;
            resolve({ done: true });
          }
        });
      });
    },
    releaseLock(): void {},
  };
  return { status: 200, ok: true, body: { getReader: () => reader } } as unknown as Response;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("openServerStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests the given cursor with the token header", async () => {
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => okResponse(sseBody()));
    openServerStream(SESSION, 41, () => {}, { fetchImpl });
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    if (call === undefined) throw new Error("expected fetchImpl to have been called");
    const [url, init] = call;
    if (init === undefined) throw new Error("expected an init object");
    expect(url).toBe("/api/admin/server/stream?after=41");
    expect((init.headers as Record<string, string>)["X-Wixy-Server-Token"]).toBe("tok-1");
  });

  it("dispatches events parsed from the stream body", async () => {
    const message = fakeMessage();
    const events: ServerStreamEvent[] = [];
    const fetchImpl = vi.fn(async () =>
      okResponse(sseBody(`id: 1\nevent: message\ndata: ${JSON.stringify(message)}`)),
    );
    openServerStream(SESSION, 0, (e) => events.push(e), { fetchImpl });
    await flush();

    expect(events).toEqual([{ type: "message", message }]);
  });

  it("getCursor tracks the highest event id seen, for a future reconnect's after=", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse(sseBody(`id: 5\nevent: message\ndata: ${JSON.stringify(fakeMessage({ seq: 5 }))}`)),
    );
    const handle = openServerStream(SESSION, 2, () => {}, { fetchImpl });
    expect(handle.getCursor()).toBe(2); // unchanged until an id-bearing frame lands
    await flush();

    expect(handle.getCursor()).toBe(5);
    handle.close();
    expect(handle.getCursor()).toBe(5); // survives close(), for the next attach() to resume from
  });

  it("a 401 dispatches locked and does not reconnect", async () => {
    const events: ServerStreamEvent[] = [];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    openServerStream(SESSION, 0, (e) => events.push(e), { fetchImpl });
    await flush();

    expect(events).toEqual([{ type: "locked" }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an in-stream locked event does not reconnect", async () => {
    const events: ServerStreamEvent[] = [];
    const fetchImpl = vi.fn(async () => okResponse(sseBody("event: locked\ndata: {}")));
    openServerStream(SESSION, 0, (e) => events.push(e), { fetchImpl });
    await flush();

    expect(events).toEqual([{ type: "locked" }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reconnects with 1->2->5->10s backoff on repeated connection failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    openServerStream(SESSION, 0, () => {}, { fetchImpl });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // +1s

    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // +2s

    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(4); // +5s

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(5); // +10s, ladder caps here

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(6); // stays at 10s
  });

  it("a successful connection resets the backoff ladder for the next failure", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return okResponse(sseBody()); // connects, then a clean EOF
      throw new Error("down again");
    });
    openServerStream(SESSION, 0, () => {}, { fetchImpl });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The EOF from call 1 reconnects at the RESET 1s rung (not escalated).
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reconnects after 45s with no bytes (watchdog), then close() stops further reconnects", async () => {
    const fetchImpl = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return Promise.resolve(stalledResponse(signal));
    });
    const handle = openServerStream(SESSION, 0, () => {}, { fetchImpl });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(44_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    // Watchdog fired -> aborted -> EOF -> reconnect scheduled at the reset 1s rung.
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    handle.close();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
