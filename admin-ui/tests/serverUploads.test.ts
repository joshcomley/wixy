import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_API_BASE, ServerLockedError } from "../src/server/api/http";
import {
  completeUnsentUpload,
  createServerLiveUploader,
  discardUpload,
  listUnsentUploads,
  uploadServerAttachment,
} from "../src/server/api/uploads";
import type { ServerSession } from "../src/server/types";

const SESSION: ServerSession = { token: "session-token", expiresAt: 999 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("uploadServerAttachment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authenticates each chunked upload request with the session captured at start", async () => {
    const paths: string[] = [];
    let chunkIndex = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Wixy-Server-Token")).toBe(SESSION.token);
      if (path === `${SERVER_API_BASE}/uploads`) {
        return jsonResponse({ uploadId: "a".repeat(32), chunkBytes: 3, maxBytes: 100 }, 201);
      }
      if (path.endsWith(`/chunks/${chunkIndex}`)) {
        chunkIndex += 1;
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ attachment: {
        id: "a".repeat(32), kind: "photo", status: "processing", width: null, height: null,
        durationS: null, peaks: null, urls: {},
      } }, 202);
    });
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const result = await uploadServerAttachment(
      new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "image/jpeg" }),
      "photo",
      SESSION,
      { onProgress: progress },
    );

    expect(result.id).toBe("a".repeat(32));
    expect(paths).toEqual([
      `${SERVER_API_BASE}/uploads`,
      `${SERVER_API_BASE}/uploads/${"a".repeat(32)}/chunks/0`,
      `${SERVER_API_BASE}/uploads/${"a".repeat(32)}/chunks/1`,
      `${SERVER_API_BASE}/uploads/${"a".repeat(32)}/complete`,
    ]);
    expect(progress).toHaveBeenCalledWith(0, 5);
    expect(progress).toHaveBeenCalledWith(5, 5);
  });

  it("best-effort deletes a canceled pending upload with the captured session", async () => {
    const controller = new AbortController();
    const calls: Array<{ path: string; method: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, method: init?.method });
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Wixy-Server-Token")).toBe(SESSION.token);
      if (path === `${SERVER_API_BASE}/uploads`) {
        return jsonResponse({ uploadId: "a".repeat(32), chunkBytes: 3, maxBytes: 100 }, 201);
      }
      if (path.endsWith("/chunks/0")) {
        controller.abort();
        return new Response(null, { status: 204 });
      }
      if (init?.method === "DELETE") {
        expect(init.signal?.aborted).toBe(false);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected upload request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadServerAttachment(
      new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "image/jpeg" }),
      "photo",
      SESSION,
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });

    expect(calls).toEqual([
      { path: `${SERVER_API_BASE}/uploads`, method: "POST" },
      { path: `${SERVER_API_BASE}/uploads/${"a".repeat(32)}/chunks/0`, method: "PUT" },
      { path: `${SERVER_API_BASE}/uploads/${"a".repeat(32)}`, method: "DELETE" },
    ]);
  });
});

describe("unsent voice notes API (spec/server-chat/06 §2.1)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(respond: (path: string, init: RequestInit | undefined) => Response) {
    const calls: Array<{ path: string; method: string | undefined; token: string | null; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: String(input),
        method: init?.method,
        token: new Headers(init?.headers).get("X-Wixy-Server-Token"),
        body: init?.body ?? null,
      });
      return respond(String(input), init);
    }));
    return calls;
  }

  it("lists this device's unsent uploads, with the device id encoded and the token in the header", async () => {
    const calls = stub(() => jsonResponse({ unsent: [
      { uploadId: "u1", durationMs: 751000, sizeBytes: 5, startedAt: 10, lastChunkAt: 20 },
      { durationMs: 1 },
      "junk",
    ] }));
    const entries = await listUnsentUploads(SESSION, "dev ice/1");
    expect(calls).toEqual([{
      path: `${SERVER_API_BASE}/uploads/unsent?deviceId=dev%20ice%2F1`,
      method: "GET",
      token: SESSION.token,
      body: null,
    }]);
    expect(entries).toEqual([{ uploadId: "u1", durationMs: 751000, sizeBytes: 5, startedAt: 10, lastChunkAt: 20 }]);
  });

  it.each([404, 405])("an older server (%s) has nothing to offer", async (status) => {
    stub(() => new Response("nope", { status }));
    expect(await listUnsentUploads(SESSION, "d")).toEqual([]);
  });

  it("a server error is an error (the caller shows nothing), and a 401 locks", async () => {
    stub(() => new Response("x", { status: 500 }));
    await expect(listUnsentUploads(SESSION, "d")).rejects.toThrow();
    stub(() => jsonResponse({ error: "locked" }, 401));
    await expect(listUnsentUploads(SESSION, "d")).rejects.toBeInstanceOf(ServerLockedError);
  });

  it("completes an unsent upload with no body (every contiguous chunk) and returns the attachment", async () => {
    const attachment = { id: "att", kind: "voice", status: "processing", width: null, height: null, durationS: null, peaks: null, urls: {} };
    const calls = stub(() => jsonResponse({ attachment }, 202));
    expect(await completeUnsentUpload(SESSION, "u1")).toEqual(attachment);
    expect(calls).toEqual([{ path: `${SERVER_API_BASE}/uploads/u1/complete`, method: "POST", token: SESSION.token, body: null }]);
  });

  it("a refused complete is an UploadError carrying the status", async () => {
    stub(() => jsonResponse({ error: "incomplete" }, 409));
    await expect(completeUnsentUpload(SESSION, "u1")).rejects.toMatchObject({ name: "UploadError", status: 409 });
  });

  it("discards with DELETE, counting an already-gone upload (404) as discarded", async () => {
    const calls = stub((_path, init) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(null, { status: 500 })));
    await discardUpload(SESSION, "u1");
    expect(calls).toEqual([{ path: `${SERVER_API_BASE}/uploads/u1`, method: "DELETE", token: SESSION.token, body: null }]);
    stub(() => new Response(null, { status: 404 }));
    await discardUpload(SESSION, "u1");
    stub(() => new Response(null, { status: 500 }));
    await expect(discardUpload(SESSION, "u1")).rejects.toThrow();
  });
});

describe("createServerLiveUploader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authenticates with whichever session is current, and a lock makes the next request fail as locked", async () => {
    const tokens: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get("X-Wixy-Server-Token"));
      return jsonResponse({ uploadId: "u1", chunkBytes: 100, maxBytes: 1000 }, 201);
    }));
    let session: ServerSession | null = SESSION;
    const uploader = createServerLiveUploader(() => session, { mimeType: "audio/webm", deviceId: "d" });
    uploader.push(new Blob(["a"]), 0, 15000);
    await vi.waitFor(() => expect(tokens.length).toBeGreaterThanOrEqual(2));
    expect(tokens.every((token) => token === SESSION.token)).toBe(true);

    session = null;
    const locked = createServerLiveUploader(() => session, { mimeType: "audio/webm", deviceId: "d" });
    const onLockedFree = await locked.finish();
    expect(onLockedFree).toBeNull(); // init could not even start: falls back, nothing to delete
  });
});
