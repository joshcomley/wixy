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

  it("getTheme parses the theme response", async () => {
    const theme = {
      colors: { cream: "#F1E8D9" },
      shadow: "0 18px 44px rgba(62,49,42,.14)",
      fonts: { serif: { family: "Cormorant Garamond", weights: ["400"], italics: true } },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ theme }));
    const api = createApi();
    await expect(api.getTheme()).resolves.toEqual(theme);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/theme", expect.anything());
  });

  it("getMedia parses the extended per-item shape (slice 1's dimensions/size/references)", async () => {
    const item = {
      name: "hero.jpg",
      url: "/images/hero.jpg",
      source: "repo",
      sizeBytes: 2048,
      width: 800,
      height: 600,
      references: ["hero.bg"],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ media: [item] }));
    const api = createApi();
    await expect(api.getMedia()).resolves.toEqual([item]);
  });

  it("uploadMedia posts a multipart body and parses the created MediaItem", async () => {
    const created = {
      name: "a1b2c3d4-photo.jpg",
      url: "/admin/draft-media/a1b2c3d4-photo.jpg",
      source: "draft",
      sizeBytes: 512,
      width: 400,
      height: 300,
      references: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(created));
    const api = createApi();
    const file = new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" });

    await expect(api.uploadMedia(file)).resolves.toEqual(created);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/admin/media");
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBe(file);
  });

  it("uploadMedia surfaces the server's detail message on a 422", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "file exceeds the 15MB limit" }, 422));
    const api = createApi();
    const file = new File([new Uint8Array([1])], "big.jpg", { type: "image/jpeg" });
    await expect(api.uploadMedia(file)).rejects.toThrow("file exceeds the 15MB limit");
  });

  it("deleteMedia URL-encodes the filename and parses the result", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ deleted: true }));
    const api = createApi();
    await expect(api.deleteMedia("a b.jpg")).resolves.toEqual({ deleted: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/media/a%20b.jpg",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("deleteMedia surfaces the server's detail message on a 409 (still referenced)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: "'hero.jpg' is still referenced by: hero.bg" }, 409),
    );
    const api = createApi();
    await expect(api.deleteMedia("hero.jpg")).rejects.toThrow("still referenced by: hero.bg");
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

  it("createConversation posts the first message and parses the summary", async () => {
    const summary = {
      convId: "c1",
      title: "hi",
      createdAt: "2026-07-10T00:00:00Z",
      status: "pending",
      failureReason: null,
      failureMessage: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(summary));

    const api = createApi();
    await expect(api.createConversation("hi")).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/chat/conversations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ firstMessage: "hi" }),
      }),
    );
  });

  it("createConversation with no first message sends an empty body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        convId: "c1",
        title: "New conversation",
        createdAt: "2026-07-10T00:00:00Z",
        status: "pending",
        failureReason: null,
        failureMessage: null,
      }),
    );

    const api = createApi();
    await api.createConversation();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/chat/conversations",
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it("getConversations unwraps the conversations array", async () => {
    const conversations = [
      {
        convId: "c1",
        title: "hi",
        createdAt: "2026-07-10T00:00:00Z",
        status: "ready",
        failureReason: null,
        failureMessage: null,
      },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations }));

    const api = createApi();
    await expect(api.getConversations()).resolves.toEqual(conversations);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/chat/conversations", expect.anything());
  });

  it("sendMessage posts text + idempotencyKey and parses accepted/buffered", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accepted: true, buffered: false }));

    const api = createApi();
    await expect(api.sendMessage("c1", "hello", "c1:msg1")).resolves.toEqual({
      accepted: true,
      buffered: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/chat/conversations/c1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "hello", idempotencyKey: "c1:msg1" }),
      }),
    );
  });

  it("sendMessage throws an ApiError on a 502 (couldn't deliver)", async () => {
    // A 5xx retries (fetchWithRetry) up to MAX_ATTEMPTS before giving up --
    // mockResolvedValue (not ...Once) so every attempt sees the same 502,
    // matching the existing "retries a network error" test's fake-timers
    // pattern above.
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(jsonResponse({ detail: "couldn't deliver: timeout" }, 502));
      const api = createApi();
      const result = api.sendMessage("c1", "hello", "c1:msg1");
      const assertion = expect(result).rejects.toBeInstanceOf(ApiError);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("renameConversation posts the new title and parses the summary", async () => {
    const summary = {
      convId: "c1",
      title: "renamed",
      createdAt: "2026-07-10T00:00:00Z",
      status: "ready",
      failureReason: null,
      failureMessage: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(summary));

    const api = createApi();
    await expect(api.renameConversation("c1", "renamed")).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/chat/conversations/c1/rename",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "renamed" }),
      }),
    );
  });
});
