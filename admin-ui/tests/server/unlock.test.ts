// §5.1's contract — stubbed at the fetch boundary (P1's real
// `routes_livechat.py` route doesn't exist yet as this parcel is built,
// wave 1) so this test is correct against the real route the moment P1
// lands, no changes needed here or there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_API_BASE } from "../../src/server/api/http";
import { unlock } from "../../src/server/api/unlock";

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("unlock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the PIN to /unlock with no token header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: 123 }, 200));
    await unlock("1234");
    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVER_API_BASE}/unlock`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ pin: "1234" }) }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has("X-Wixy-Server-Token")).toBe(false);
  });

  it("200 -> ok with the token and expiresAt", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok-abc", expiresAt: 999 }, 200));
    await expect(unlock("1234")).resolves.toEqual({ ok: true, token: "tok-abc", expiresAt: 999 });
  });

  it("a malformed 200 body maps to unavailable rather than throwing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ nonsense: true }, 200));
    await expect(unlock("1234")).resolves.toEqual({ ok: false, kind: "unavailable" });
  });

  it("401 -> wrongPin with attemptsLeft", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "wrong_pin", attemptsLeft: 2 }, 401));
    await expect(unlock("0000")).resolves.toEqual({ ok: false, kind: "wrongPin", attemptsLeft: 2 });
  });

  it("401 with no attemptsLeft reported -> null, not a crash", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "wrong_pin" }, 401));
    await expect(unlock("0000")).resolves.toEqual({ ok: false, kind: "wrongPin", attemptsLeft: null });
  });

  it("429 -> lockedOut, preferring the body's retryAfterS", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked_out", retryAfterS: 30 }, 429, { "Retry-After": "99" }));
    await expect(unlock("0000")).resolves.toEqual({ ok: false, kind: "lockedOut", retryAfterS: 30 });
  });

  it("429 falls back to the Retry-After header when the body omits retryAfterS", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked_out" }, 429, { "Retry-After": "15" }));
    await expect(unlock("0000")).resolves.toEqual({ ok: false, kind: "lockedOut", retryAfterS: 15 });
  });

  it("429 with neither a body value nor a usable header defaults to 0, never negative", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 429));
    await expect(unlock("0000")).resolves.toEqual({ ok: false, kind: "lockedOut", retryAfterS: 0 });
  });

  it("503 not_configured -> unavailable", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not_configured" }, 503));
    await expect(unlock("0000")).resolves.toEqual({ ok: false, kind: "unavailable" });
  });

  it("503 pin_service_unavailable -> unavailable", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "pin_service_unavailable" }, 503));
    await expect(unlock("0000")).resolves.toEqual({ ok: false, kind: "unavailable" });
  });

  it("422 (malformed PIN) -> unavailable, fails closed rather than open", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid" }, 422));
    await expect(unlock("")).resolves.toEqual({ ok: false, kind: "unavailable" });
  });

  it("a network failure (cmd unreachable) -> unavailable, never throws", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network error"));
    await expect(unlock("0000")).resolves.toEqual({ ok: false, kind: "unavailable" });
  });
});
