import { describe, expect, it, vi } from "vitest";
import { uploadFile, UploadError } from "../src/server/upload";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function initResponse(): Response {
  return response({ uploadId: "a".repeat(32), chunkBytes: 2, maxBytes: 100 });
}

describe("server upload", () => {
  it("initializes, uploads every chunk in order, reports progress and completes", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) return initResponse();
      if (String(input).includes("/complete")) return response({ attachment: { id: "a" } }, 202);
      return new Response(null, { status: 204 });
    });
    const progress: number[] = [];
    const file = new File(["abcde"], "note.webm", { type: "audio/webm" });

    const result = await uploadFile(file, "voice", {
      fetch: fetchMock,
      onProgress: ({ uploadedBytes }) => progress.push(uploadedBytes),
    });

    expect(result.id).toBe("a");
    expect(calls.map(({ url }) => url)).toEqual([
      "/api/admin/server/uploads",
      "/api/admin/server/uploads/" + "a".repeat(32) + "/chunks/0",
      "/api/admin/server/uploads/" + "a".repeat(32) + "/chunks/1",
      "/api/admin/server/uploads/" + "a".repeat(32) + "/chunks/2",
      "/api/admin/server/uploads/" + "a".repeat(32) + "/complete",
    ]);
    expect(progress).toEqual([0, 2, 4, 5, 5]);
    expect(calls[1]?.init?.method).toBe("PUT");
  });

  it("retries a failed chunk and then succeeds", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/uploads")) return initResponse();
      if (url.includes("/chunks/")) {
        attempts += 1;
        if (attempts < 3) return response({ error: "temporary" }, 503);
        return new Response(null, { status: 204 });
      }
      return response({ attachment: { id: "a" } }, 202);
    });

    await uploadFile(new File(["x"], "x", { type: "audio/webm" }), "voice", {
      fetch: fetchMock,
      sleep: async () => undefined,
    });
    expect(attempts).toBe(3);
  });

  it("fails after three chunk attempts", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith("/uploads")) return initResponse();
      return response({ error: "media_unavailable" }, 503);
    });

    await expect(uploadFile(new File(["x"], "x"), "voice", {
      fetch: fetchMock,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ message: "Media processing is currently unavailable.", status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[4]?.[0])).toBe("/api/admin/server/uploads/" + "a".repeat(32));
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it.each([
    [413, "This file is too large."],
    [415, "This file type isn't supported."],
    [507, "Not enough storage is available."],
    [503, "Media processing is currently unavailable."],
  ])("maps init status %s to a user-facing error", async (status, message) => {
    const fetchMock = vi.fn(async () => response({ error: "x" }, status));
    await expect(uploadFile(new File(["x"], "x"), "voice", { fetch: fetchMock }))
      .rejects.toMatchObject({ message, status });
  });

  it("rejects a file over the client cap before starting a request", async () => {
    const fetchMock = vi.fn();
    await expect(uploadFile(new Blob([new Uint8Array(30 * 1024 * 1024 + 1)]), "photo", { fetch: fetchMock }))
      .rejects.toBeInstanceOf(UploadError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops before completion when aborted between chunks", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/uploads")) return initResponse();
      if (url.includes("/chunks/")) controller.abort();
      return new Response(null, { status: 204 });
    });

    await expect(uploadFile(new Blob(["abcd"]), "voice", {
      fetch: fetchMock,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/complete"))).toBe(false);
    expect(calls).toEqual([
      "/api/admin/server/uploads",
      "/api/admin/server/uploads/" + "a".repeat(32) + "/chunks/0",
      "/api/admin/server/uploads/" + "a".repeat(32),
    ]);
  });
});
