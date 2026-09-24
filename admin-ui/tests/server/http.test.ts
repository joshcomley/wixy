import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_API_BASE, ServerLockedError, serverFetch } from "../../src/server/api/http";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("serverFetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("prefixes the path with the server API base", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await serverFetch("/messages", {}, null);
    expect(fetchMock).toHaveBeenCalledWith(`${SERVER_API_BASE}/messages`, expect.anything());
  });

  it("attaches the X-Wixy-Server-Token header when a session is given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await serverFetch("/messages", {}, { token: "tok123", expiresAt: 0 });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("X-Wixy-Server-Token")).toBe("tok123");
  });

  it("attaches no token header when session is null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await serverFetch("/unlock", {}, null);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.has("X-Wixy-Server-Token")).toBe(false);
  });

  it("throws ServerLockedError on a 401 when a session was provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked" }, 401));
    await expect(serverFetch("/messages", {}, { token: "tok", expiresAt: 0 })).rejects.toBeInstanceOf(
      ServerLockedError,
    );
  });

  it("does NOT throw on a 401 when session is null (unlock's own wrong-PIN answer)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "wrong_pin", attemptsLeft: 3 }, 401));
    const response = await serverFetch("/unlock", {}, null);
    expect(response.status).toBe(401);
  });

  it("passes non-401 responses straight through regardless of session", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    const response = await serverFetch("/messages", {}, { token: "tok", expiresAt: 0 });
    expect(response.status).toBe(503);
  });

  it("propagates an upload caller's abort signal through the timeout wrapper", async () => {
    fetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    );
    const caller = new AbortController();
    const request = serverFetch("/uploads", { signal: caller.signal }, { token: "tok", expiresAt: 0 });
    caller.abort();
    await expect(request).rejects.toBeDefined();
  });

  it("uses a longer timeout only when an upload requests one", async () => {
    vi.useFakeTimers();
    let aborted = false;
    fetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init?.signal?.reason);
        }, { once: true });
      }),
    );
    const request = serverFetch("/uploads", {}, { token: "tok", expiresAt: 0 }, 120_000);
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(110_000);
    await rejected;
    expect(aborted).toBe(true);
  });

  it.each([
    ["DELETE", "/messages/42"],
    ["POST", "/wipe"],
  ] as const)("gives %s %s time to finish and reports a timeout as unknown", async (method, path) => {
    vi.useFakeTimers();
    const requestSignals: AbortSignal[] = [];
    fetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal != null) requestSignals.push(init.signal);
        init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason), { once: true });
      }),
    );
    const request = serverFetch(path, { method }, { token: "tok", expiresAt: 0 });
    const outcome = request.then(
      () => { throw new Error("expected request to abort"); },
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestSignals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await outcome).toMatchObject({ name: "ServerErasureOutcomeUnknownError" });
    expect(requestSignals[0]?.aborted).toBe(true);
  });

  it("reports an aborted wipe as unknown instead of an ordinary failure", async () => {
    fetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason), { once: true });
      }),
    );
    const caller = new AbortController();
    const request = serverFetch(
      "/wipe",
      { method: "POST", signal: caller.signal },
      { token: "tok", expiresAt: 0 },
    );
    caller.abort();
    await expect(request).rejects.toMatchObject({ name: "ServerErasureOutcomeUnknownError" });
  });
});
