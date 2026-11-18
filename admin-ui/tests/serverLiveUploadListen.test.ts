import { describe, expect, it, vi } from "vitest";
import { ServerLockedError } from "../src/server/api/http";
import { createLiveVoiceUploader, type LiveFetch } from "../src/server/liveUpload";

// A live voice note others listen to (spec/server-chat/07 §6.1): the listened-to flavour of the
// spec 06 live uploader.

const ID = "u".repeat(32);
const LIVE_ATTACHMENT = {
  id: ID, kind: "voice", status: "live", liveState: "recording",
  width: null, height: null, durationS: 0, peaks: [], urls: {},
};
const DONE_ATTACHMENT = { ...LIVE_ATTACHMENT, status: "processing" };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Call { method: string; path: string; body: string | null }

function fakeServer(handlers: {
  init?: () => Response;
  chunk?: (index: number, attempt: number) => Response | Promise<Response>;
  liveState?: (state: string, attempt: number) => Response | Promise<Response>;
  complete?: () => Response;
} = {}) {
  const calls: Call[] = [];
  const chunkAttempts = new Map<number, number>();
  const stateAttempts = new Map<string, number>();
  const fetchFn: LiveFetch = async (path, init) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : null;
    calls.push({ method, path, body });
    if (method === "POST" && path === "/uploads") {
      return handlers.init ? handlers.init() : json({ uploadId: ID, chunkBytes: 8_388_608, maxBytes: 536_870_912, attachment: LIVE_ATTACHMENT }, 201);
    }
    const chunk = /\/chunks\/(\d+)/.exec(path);
    if (method === "PUT" && chunk) {
      const index = Number(chunk[1]);
      const attempt = (chunkAttempts.get(index) ?? 0) + 1;
      chunkAttempts.set(index, attempt);
      return handlers.chunk ? handlers.chunk(index, attempt) : new Response(null, { status: 204 });
    }
    if (method === "POST" && path.endsWith("/live-state")) {
      const state = (JSON.parse(body ?? "{}") as { state: string }).state;
      const attempt = (stateAttempts.get(state) ?? 0) + 1;
      stateAttempts.set(state, attempt);
      return handlers.liveState ? handlers.liveState(state, attempt) : new Response(null, { status: 204 });
    }
    if (method === "POST" && path.endsWith("/complete")) {
      return handlers.complete ? handlers.complete() : json({ attachment: DONE_ATTACHMENT }, 202);
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 500 });
  };
  return {
    fetch: vi.fn(fetchFn) as unknown as LiveFetch,
    calls,
    states: () => calls.filter((c) => c.path.endsWith("/live-state")).map((c) => (JSON.parse(c.body ?? "{}") as { state: string }).state),
    puts: () => calls.filter((c) => c.method === "PUT").length,
    deletes: () => calls.filter((c) => c.method === "DELETE"),
  };
}

function make(server: ReturnType<typeof fakeServer>, extra: Partial<Parameters<typeof createLiveVoiceUploader>[0]> = {}) {
  let clock = 0;
  return createLiveVoiceUploader({
    fetch: server.fetch,
    mimeType: "audio/webm",
    deviceId: "device-1",
    listen: true,
    retryDelayMs: 0,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    ...extra,
  });
}

const blob = (text: string) => new Blob([text]);

describe("a listened-to live voice upload", () => {
  it("opens with listen:true and hands back the live attachment the message needs", async () => {
    const server = fakeServer();
    const uploader = make(server);
    const opened = await uploader.opened();
    expect(opened.kind).toBe("opened");
    expect(opened.kind === "opened" && opened.attachment?.id).toBe(ID);
    expect(uploader.listening).toBe(true);
    expect(JSON.parse(server.calls[0]!.body!)).toEqual({
      kind: "voice", mimeType: "audio/webm", live: true, deviceId: "device-1", listen: true,
    });
  });

  it("an ordinary live upload never sends listen and has no attachment", async () => {
    const server = fakeServer({ init: () => json({ uploadId: ID, chunkBytes: 1, maxBytes: 1 }, 201) });
    const uploader = make(server, { listen: false });
    const opened = await uploader.opened();
    expect(opened).toEqual({ kind: "opened", attachment: null });
    expect(JSON.parse(server.calls[0]!.body!)).not.toHaveProperty("listen");
    uploader.setLiveState("paused"); // meaningless for it
    await Promise.resolve();
    expect(server.states()).toEqual([]);
  });

  it("reports 409 too_many_live so the recording can carry on as a normal note", async () => {
    const server = fakeServer({ init: () => json({ error: "too_many_live" }, 409) });
    const uploader = make(server);
    expect(await uploader.opened()).toEqual({ kind: "too_many_live" });
    uploader.push(blob("a"), 0, 1000);
    expect(await uploader.finish()).toBeNull();
    expect(server.puts()).toBe(0);
  });

  it("any other refusal is a plain failure (the kept recording is then uploaded whole)", async () => {
    const uploader = make(fakeServer({ init: () => json({ error: "media_unavailable" }, 503) }));
    expect(await uploader.opened()).toEqual({ kind: "failed" });
    expect(await uploader.finish()).toBeNull();
  });

  it("a response without the attachment cannot be used and is cleaned up", async () => {
    const server = fakeServer({ init: () => json({ uploadId: ID, chunkBytes: 1, maxBytes: 1 }, 201) });
    const uploader = make(server);
    expect(await uploader.opened()).toEqual({ kind: "failed" });
    await uploader.finish();
    expect(server.deletes()).toHaveLength(1);
  });

  it("sends slices as the plain upload does, then completes with the count", async () => {
    const server = fakeServer();
    const uploader = make(server);
    uploader.push(blob("a"), 0, 1000);
    uploader.push(blob("b"), 1, 2000);
    const attachment = await uploader.finish();
    expect(attachment?.id).toBe(ID);
    expect(server.puts()).toBe(2);
    expect(JSON.parse(server.calls.at(-1)!.body!)).toEqual({ chunkCount: 2 });
  });

  it("keeps trying a slice through a network blip instead of giving the note up after three tries", async () => {
    const server = fakeServer({
      chunk: (index, attempt) => (index === 1 && attempt <= 8 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 })),
    });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 1000);
    uploader.push(blob("b"), 1, 2000);
    expect(await uploader.finish()).not.toBeNull();
    expect(server.puts()).toBeGreaterThan(8);
    expect(server.deletes()).toHaveLength(0);
  });

  it("gives up after its patience, WITHOUT deleting what the server holds", async () => {
    const server = fakeServer({ chunk: () => new Response(null, { status: 503 }) });
    const uploader = make(server, { patienceMs: 10_000 });
    uploader.push(blob("a"), 0, 1000);
    expect(await uploader.finish()).toBeNull();
    // the message references the upload and listeners may be hearing it: the caller decides
    expect(server.deletes()).toHaveLength(0);
  });

  it("a definite refusal of a slice (the note has ended) is not retried", async () => {
    const server = fakeServer({ chunk: () => json({ error: "not_live" }, 409) });
    const uploader = make(server);
    uploader.push(blob("a"), 0, 1000);
    expect(await uploader.finish()).toBeNull();
    expect(server.puts()).toBe(1);
    expect(server.deletes()).toHaveLength(0);
  });

  it("a dead session still surfaces as a lock and keeps the recording for the next unlock", async () => {
    const onLocked = vi.fn();
    let locked = true;
    const server = fakeServer({ chunk: () => { if (locked) throw new ServerLockedError(); return new Response(null, { status: 204 }); } });
    const uploader = make(server, { onLocked });
    uploader.push(blob("a"), 0, 1000);
    await expect(uploader.finish()).rejects.toBeInstanceOf(ServerLockedError);
    expect(onLocked).toHaveBeenCalled();
    locked = false;
    expect(await uploader.finish()).not.toBeNull();
  });

  it("cancel still deletes the upload (the caller's choice)", async () => {
    const server = fakeServer();
    const uploader = make(server);
    await uploader.opened();
    await uploader.cancel();
    expect(server.deletes()).toHaveLength(1);
  });
});

describe("telling the server whether the sender is paused (POST /uploads/{id}/live-state)", () => {
  it("posts the state, and the latest wish wins when several arrive in a row", async () => {
    const server = fakeServer();
    const uploader = make(server);
    uploader.setLiveState("paused");
    uploader.setLiveState("recording");
    uploader.setLiveState("paused");
    await vi.waitFor(() => expect(server.states().at(-1)).toBe("paused"));
    const body = server.calls.find((c) => c.path.endsWith("/live-state"))!;
    expect(body.path).toBe(`/uploads/${ID}/live-state`);
    expect(body.method).toBe("POST");
    // never ends on a stale state
    await vi.waitFor(() => expect(server.states().at(-1)).toBe("paused"));
  });

  it("a repeat of the same state sends nothing new", async () => {
    const server = fakeServer();
    const uploader = make(server);
    uploader.setLiveState("recording");
    await uploader.opened();
    await Promise.resolve();
    expect(server.states()).toEqual([]);
  });

  it("retries a transient failure a few times", async () => {
    const server = fakeServer({ liveState: (_s, attempt) => (attempt < 3 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 })) });
    const uploader = make(server);
    uploader.setLiveState("paused");
    await vi.waitFor(() => expect(server.states()).toEqual(["paused", "paused", "paused"]));
  });

  it("stops asking once the server says the note is no longer live", async () => {
    const server = fakeServer({ liveState: () => json({ error: "not_live" }, 409) });
    const uploader = make(server);
    uploader.setLiveState("paused");
    await vi.waitFor(() => expect(server.states()).toEqual(["paused"]));
    uploader.setLiveState("recording");
    await Promise.resolve();
    await Promise.resolve();
    expect(server.states()).toEqual(["paused"]);
  });
});
