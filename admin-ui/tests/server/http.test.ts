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
});
