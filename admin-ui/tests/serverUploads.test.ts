import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_API_BASE } from "../src/server/api/http";
import { uploadServerAttachment } from "../src/server/api/uploads";
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
