import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "../src/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createApi", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getState parses the state response", async () => {
    const body = {
      project: { slug: "ca", name: "CA", domain: "ca.example" },
      pages: [],
      draft: { rev: 0, opCount: 0 },
      live: null,
      upstream: { aheadOfPublished: [], fetchedAt: null },
      publishJob: null,
      chats: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(body));

    const api = createApi();
    await expect(api.getState()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/state", expect.anything());
  });

  it("getContent URL-encodes the page slug", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: {}, bindings: { page: "a b", fields: [] } }));
    const api = createApi();
    await api.getContent("a b");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/content/a%20b", expect.anything());
  });

  it("patchDraft returns kind ok with the new rev on 200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ rev: 3 }));
    const api = createApi();
    await expect(api.patchDraft(2, [{ file: "index", path: "hero.title", value: "New" }])).resolves.toEqual({
      kind: "ok",
      rev: 3,
    });
  });

  it("patchDraft returns kind conflict on 409 without retrying", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "conflict" }, 409));
    const api = createApi();
    await expect(api.patchDraft(2, [])).resolves.toEqual({ kind: "conflict" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The retry-backoff delay is a real setTimeout (fetchWithRetry's `delay()`) —
  // fake timers + runAllTimersAsync() keep these deterministic and fast instead
  // of actually waiting out the (500ms + 1000ms) backoff in wall-clock time.

  it("retries a 500 up to 3 attempts, then throws", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
      const api = createApi();
      const result = api.getState();
      const assertion = expect(result).rejects.toBeInstanceOf(ApiError);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("succeeds after a transient failure within the retry budget", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 503))
        .mockResolvedValueOnce(jsonResponse({ media: [] }));
      const api = createApi();
      const result = api.getMedia();
      const assertion = expect(result).resolves.toEqual([]);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a network error (fetch rejecting) and eventually throws", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new TypeError("network down"));
      const api = createApi();
      const result = api.getState();
      const assertion = expect(result).rejects.toThrow("network down");
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a 404 — throws immediately", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "not found" }, 404));
    const api = createApi();
    await expect(api.getContent("missing")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
