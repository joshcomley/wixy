import { describe, expect, it, vi } from "vitest";
import { ServerLockedError } from "../src/server/api/http";
import { createLiveVoiceUploader, type LiveFetch } from "../src/server/liveUpload";

const ID = "u".repeat(32);
const ATTACHMENT = {
  id: "att-1", kind: "voice", status: "processing", width: null, height: null, durationS: null, peaks: null, urls: {},
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: string | null;
}

/** A tiny scripted server. `chunk` decides each PUT; the rest answer happily by default. */
function fakeServer(handlers: {
  init?: () => Response | Promise<Response>;
  chunk?: (index: number, attempt: number) => Response | Promise<Response>;
  complete?: (attempt: number) => Response | Promise<Response>;
  del?: () => Response | Promise<Response>;
} = {}) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const chunkAttempts = new Map<number, number>();
  let completeAttempts = 0;
  const fetchFn: LiveFetch = async (path, init) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : null;
    calls.push({ method, path, body });
    if (method === "POST" && path === "/uploads") {
      return handlers.init ? handlers.init() : json({ uploadId: ID, chunkBytes: 8_388_608, maxBytes: 536_870_912 }, 201);
    }
    const chunk = /\/chunks\/(\d+)/.exec(path);
    if (method === "PUT" && chunk) {
      const index = Number(chunk[1]);
      const attempt = (chunkAttempts.get(index) ?? 0) + 1;
      chunkAttempts.set(index, attempt);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        await Promise.resolve();
        return handlers.chunk ? await handlers.chunk(index, attempt) : new Response(null, { status: 204 });
      } finally {
        inFlight -= 1;
      }
    }
    if (method === "POST" && path.endsWith("/complete")) {
      completeAttempts += 1;
      return handlers.complete ? handlers.complete(completeAttempts) : json({ attachment: ATTACHMENT }, 202);
    }
    if (method === "DELETE") return handlers.del ? handlers.del() : new Response(null, { status: 204 });
    return new Response(null, { status: 500 });
  };
  const fetchSpy = vi.fn(fetchFn);
  return {
    fetch: fetchSpy as unknown as LiveFetch,
    calls,
    puts: () => calls.filter((c) => c.method === "PUT").map((c) => c.path),
    deletes: () => calls.filter((c) => c.method === "DELETE"),
    maxInFlight: () => maxInFlight,
  };
}

function make(server: ReturnType<typeof fakeServer>, extra: { onLocked?: () => void } = {}) {
  return createLiveVoiceUploader({
    fetch: server.fetch,
    mimeType: "audio/webm",
    deviceId: "device-1",
    retryDelayMs: 0,
    sleep: async () => undefined,
    ...extra,
  });
}

const blob = (text: string) => new Blob([text]);

describe("live voice uploader (spec/server-chat/06 §2.3)", () => {
  it("opens a live voice upload for this device, PUTs slices strictly in order one at a time, then completes with the chunk count", async () => {
    const server = fakeServer();
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    uploader.push(blob("b"), 1, 30000);
    uploader.push(blob("c"), 2, 41000);

    const attachment = await uploader.finish();

    expect(attachment).toMatchObject({ id: "att-1" });
    expect(JSON.parse(server.calls[0]?.body ?? "{}")).toEqual({
      kind: "voice", mimeType: "audio/webm", live: true, deviceId: "device-1",
    });
    expect(server.puts()).toEqual([
      `/uploads/${ID}/chunks/0?durationMs=15000`,
      `/uploads/${ID}/chunks/1?durationMs=30000`,
      `/uploads/${ID}/chunks/2?durationMs=41000`,
    ]);
    expect(server.maxInFlight()).toBe(1);
    const complete = server.calls.at(-1);
    expect(complete).toMatchObject({ method: "POST", path: `/uploads/${ID}/complete` });
    expect(JSON.parse(complete?.body ?? "{}")).toEqual({ chunkCount: 3 });
    expect(server.deletes()).toHaveLength(0);
    expect(uploader.uploadId).toBe(ID);
  });

  it("uploads slices while the recording is still going, before finish() is called", async () => {
    const server = fakeServer();
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    await vi.waitFor(() => expect(server.puts()).toHaveLength(1));
    uploader.push(blob("b"), 1, 30000);
    await vi.waitFor(() => expect(server.puts()).toHaveLength(2));
    expect(server.calls.some((c) => c.path.endsWith("/complete"))).toBe(false);
    await uploader.finish();
  });

  it("retries a slice that hit a transient error, without reordering", async () => {
    const server = fakeServer({ chunk: (index, attempt) => (index === 1 && attempt === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 })) });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    uploader.push(blob("b"), 1, 30000);
    uploader.push(blob("c"), 2, 31000);

    expect(await uploader.finish()).not.toBeNull();
    expect(server.puts().map((p) => /chunks\/(\d+)/.exec(p)?.[1])).toEqual(["0", "1", "1", "2"]);
    expect(server.deletes()).toHaveLength(0);
  });

  it("resyncs to the server's `next` on 409 out_of_order and resends from there", async () => {
    // The server lost slice 1: it answers slice 2 with next=1.
    const server = fakeServer({
      chunk: (index, attempt) => (index === 2 && attempt === 1 ? json({ error: "out_of_order", next: 1 }, 409) : new Response(null, { status: 204 })),
    });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    uploader.push(blob("b"), 1, 30000);
    uploader.push(blob("c"), 2, 31000);

    expect(await uploader.finish()).not.toBeNull();
    expect(server.puts().map((p) => /chunks\/(\d+)/.exec(p)?.[1])).toEqual(["0", "1", "2", "1", "2"]);
    expect(JSON.parse(server.calls.at(-1)?.body ?? "{}")).toEqual({ chunkCount: 3 });
  });

  it("treats an out_of_order answer that is AHEAD of the client as a permanent failure and falls back", async () => {
    const server = fakeServer({ chunk: () => json({ error: "out_of_order", next: 9 }, 409) });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);

    expect(await uploader.finish()).toBeNull();
    expect(server.deletes()).toHaveLength(1);
  });

  it("gives up on a server that keeps answering out_of_order", async () => {
    const server = fakeServer({ chunk: () => json({ error: "out_of_order", next: 0 }, 409) });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    expect(await uploader.finish()).toBeNull();
    expect(server.puts().length).toBeLessThanOrEqual(8);
    expect(server.deletes()).toHaveLength(1);
  });

  it("sends the slices the server reports missing at complete, then completes again", async () => {
    const server = fakeServer({
      complete: (attempt) => (attempt === 1 ? json({ error: "incomplete", missing: [1] }, 409) : json({ attachment: ATTACHMENT }, 202)),
    });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    uploader.push(blob("b"), 1, 30000);

    expect(await uploader.finish()).toMatchObject({ id: "att-1" });
    expect(server.puts().map((p) => /chunks\/(\d+)/.exec(p)?.[1])).toEqual(["0", "1", "1"]);
  });

  it("cancel DELETEs the live upload and ignores later slices", async () => {
    const server = fakeServer();
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    await vi.waitFor(() => expect(server.puts()).toHaveLength(1));

    await uploader.cancel();
    uploader.push(blob("b"), 1, 30000);
    await Promise.resolve();

    expect(server.deletes()).toEqual([expect.objectContaining({ path: `/uploads/${ID}` })]);
    expect(server.puts()).toHaveLength(1);
  });

  it("cancel before the init answered still removes the upload once it exists", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = fakeServer({ init: async () => { await gate; return json({ uploadId: ID, chunkBytes: 1, maxBytes: 1 }, 201); } });
    const uploader = make(server);
    const cancelled = uploader.cancel();
    release();
    await cancelled;
    expect(server.deletes()).toEqual([expect.objectContaining({ path: `/uploads/${ID}` })]);
  });

  it("cancel after a completed upload does nothing", async () => {
    const server = fakeServer();
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    await uploader.finish();
    await uploader.cancel();
    expect(server.deletes()).toHaveLength(0);
  });

  it("falls back (null, nothing to delete) when the init is refused", async () => {
    for (const status of [400, 422, 500, 503]) {
      const server = fakeServer({ init: () => json({ error: "x" }, status) });
      const uploader = make(server);
      uploader.push(blob("a"), 0, 15000);
      expect(await uploader.finish()).toBeNull();
      expect(server.puts()).toHaveLength(0);
      expect(server.deletes()).toHaveLength(0);
    }
  });

  it("falls back when the init request cannot reach the server", async () => {
    const server = fakeServer({ init: () => { throw new TypeError("network down"); } });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    expect(await uploader.finish()).toBeNull();
  });

  it.each([413, 507])("a permanent %s on a slice stops the live upload, deletes it, and only then reports the fallback", async (status) => {
    const order: string[] = [];
    const server = fakeServer({
      chunk: (index) => (index === 1 ? json({ error: status === 413 ? "too_large" : "storage_full" }, status) : new Response(null, { status: 204 })),
      del: () => { order.push("deleted"); return new Response(null, { status: 204 }); },
    });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    uploader.push(blob("b"), 1, 30000);
    uploader.push(blob("c"), 2, 31000);

    const result = await uploader.finish();
    order.push("finish returned");

    expect(result).toBeNull();
    expect(order).toEqual(["deleted", "finish returned"]);
    expect(server.puts()).toHaveLength(2); // slice 2 is never sent after the failure
    expect(server.calls.some((c) => c.path.endsWith("/complete"))).toBe(false);
  });

  it("a network failure that outlasts the retries also falls back", async () => {
    const server = fakeServer({ chunk: () => { throw new TypeError("network down"); } });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    expect(await uploader.finish()).toBeNull();
    expect(server.puts()).toHaveLength(3);
    expect(server.deletes()).toHaveLength(1);
  });

  it("falls back when complete is refused for good, deleting the live upload", async () => {
    const server = fakeServer({ complete: () => json({ error: "nope" }, 422) });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    expect(await uploader.finish()).toBeNull();
    expect(server.deletes()).toHaveLength(1);
  });

  it("falls back when no slice ever arrived", async () => {
    const server = fakeServer();
    const uploader = make(server);
    expect(await uploader.finish()).toBeNull();
    expect(server.deletes()).toHaveLength(1);
  });

  it("falls back when slices arrive with a gap", async () => {
    const server = fakeServer();
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    uploader.push(blob("c"), 2, 45000);
    expect(await uploader.finish()).toBeNull();
    expect(server.deletes()).toHaveLength(1);
  });

  it("a dead session is not a failure: finish throws ServerLockedError, and carries on after the next unlock", async () => {
    let dead = true;
    const onLocked = vi.fn();
    const server = fakeServer({
      chunk: () => { if (dead) throw new ServerLockedError(); return new Response(null, { status: 204 }); },
    });
    const uploader = make(server, { onLocked });
    uploader.push(blob("a"), 0, 15000);

    await expect(uploader.finish()).rejects.toBeInstanceOf(ServerLockedError);
    expect(onLocked).toHaveBeenCalled();
    expect(server.deletes()).toHaveLength(0);

    dead = false;
    expect(await uploader.finish()).toMatchObject({ id: "att-1" });
    expect(server.puts()).toHaveLength(2);
    expect(JSON.parse(server.calls.at(-1)?.body ?? "{}")).toEqual({ chunkCount: 1 });
  });

  it("abandon (a lock) leaves the upload on the server and sends nothing more", async () => {
    const server = fakeServer();
    const uploader = make(server);
    uploader.push(blob("a"), 0, 15000);
    await vi.waitFor(() => expect(server.puts()).toHaveLength(1));

    uploader.abandon();
    uploader.push(blob("b"), 1, 30000);
    await uploader.cancel();
    await Promise.resolve();

    expect(server.deletes()).toHaveLength(0);
    expect(server.puts()).toHaveLength(1);
  });
});
