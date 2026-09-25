// The four device-grant routes (spec/server-chat/03-permanent-unlock.md §3). Each carries the
// request guard `POST /unlock` does (a JSON content type + `X-Wixy-Server-Unlock: 1`); the
// token, where there is one, travels only in the `X-Wixy-Server-Token` header — never in a URL;
// and a wrong PIN (401 `wrong_pin`) must not be mistaken for a locked chat (401 `locked`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeviceGrant,
  revokeAllDeviceGrants,
  revokeDeviceGrant,
  unlockWithGrant,
} from "../../src/server/api/grants";
import { ServerLockedError } from "../../src/server/api/http";
import type { StoredDeviceGrant } from "../../src/server/deviceGrant";
import type { ServerSession } from "../../src/server/types";

const SESSION: ServerSession = { token: "tok-secret-123", expiresAt: 9_999_999_999 };
const GRANT: StoredDeviceGrant = { grantId: "0123456789abcdef0123456789abcdef", secret: "S".repeat(43) };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe("device-grant API", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastCall(): { readonly url: string; readonly init: RequestInit; readonly headers: Headers } {
    const call = fetchMock.mock.calls.at(-1);
    if (call === undefined) throw new Error("fetch was not called");
    const init = call[1] as RequestInit;
    return { url: String(call[0]), init, headers: init.headers as Headers };
  }

  function expectGuard(headers: Headers): void {
    expect(headers.get("X-Wixy-Server-Unlock")).toBe("1");
    expect(headers.get("Content-Type")).toBe("application/json");
  }

  function expectTokenOnlyInHeader(url: string): void {
    expect(url).not.toContain(SESSION.token);
    expect(url).not.toContain("token");
  }

  describe("createDeviceGrant (POST /device-grants)", () => {
    const CREATED = { grantId: GRANT.grantId, secret: GRANT.secret, token: "fresh-token", expiresAt: 1_800_000_000 };

    it("returns the grant, the fresh token and its expiry on a 201", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(CREATED, 201));
      const result = await createDeviceGrant(SESSION, "1234", "Android · Chrome");
      expect(result).toEqual({
        ok: true,
        grant: { grantId: GRANT.grantId, secret: GRANT.secret },
        token: "fresh-token",
        expiresAt: 1_800_000_000,
      });
    });

    it("sends a POST with the guard headers, the token header, the PIN and the label — and no token in the URL", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(CREATED, 201));
      await createDeviceGrant(SESSION, "482913", "Windows · Edge");
      const { url, init, headers } = lastCall();
      expect(url).toBe("/api/admin/server/device-grants");
      expect(init.method).toBe("POST");
      expectGuard(headers);
      expect(headers.get("X-Wixy-Server-Token")).toBe(SESSION.token);
      expect(JSON.parse(String(init.body))).toEqual({ pin: "482913", label: "Windows · Edge" });
      expectTokenOnlyInHeader(url);
    });

    it("sends a null label as null", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(CREATED, 201));
      await createDeviceGrant(SESSION, "1234", null);
      expect(JSON.parse(String(lastCall().init.body))).toEqual({ pin: "1234", label: null });
    });

    it.each([
      ["a missing secret", { grantId: GRANT.grantId, token: "t", expiresAt: 1 }],
      ["a missing grantId", { secret: GRANT.secret, token: "t", expiresAt: 1 }],
      ["a missing token", { grantId: GRANT.grantId, secret: GRANT.secret, expiresAt: 1 }],
      ["a missing expiry", { grantId: GRANT.grantId, secret: GRANT.secret, token: "t" }],
      ["a non-finite expiry", { ...CREATED, expiresAt: "soon" }],
      ["a numeric token", { ...CREATED, token: 5 }],
      ["a null body", null],
      ["an array body", []],
    ])("treats a 201 with %s as unexpected", async (_name, body) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(body, 201));
      expect(await createDeviceGrant(SESSION, "1234", null)).toEqual({ ok: false, kind: "unexpected" });
    });

    it("treats a 201 whose body is not JSON as unexpected", async () => {
      fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 201 }));
      expect(await createDeviceGrant(SESSION, "1234", null)).toEqual({ ok: false, kind: "unexpected" });
    });

    it("maps 401 wrong_pin to wrongPin with the attempts left", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "wrong_pin", attemptsLeft: 3 }, 401));
      expect(await createDeviceGrant(SESSION, "0000", null)).toEqual({ ok: false, kind: "wrongPin", attemptsLeft: 3 });
    });

    it("maps 401 wrong_pin without a usable attemptsLeft to null", async () => {
      for (const body of [{ error: "wrong_pin" }, { error: "wrong_pin", attemptsLeft: "3" }]) {
        fetchMock.mockResolvedValueOnce(jsonResponse(body, 401));
        expect(await createDeviceGrant(SESSION, "0000", null)).toEqual({
          ok: false,
          kind: "wrongPin",
          attemptsLeft: null,
        });
      }
    });

    it("does NOT mistake a wrong PIN for a locked chat", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "wrong_pin", attemptsLeft: 0 }, 401));
      await expect(createDeviceGrant(SESSION, "0000", null)).resolves.toMatchObject({ kind: "wrongPin" });
    });

    it("throws ServerLockedError on a 401 {error: locked} — the token no longer works", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked" }, 401));
      await expect(createDeviceGrant(SESSION, "1234", null)).rejects.toBeInstanceOf(ServerLockedError);
    });

    it("throws ServerLockedError on a 401 with no JSON body, or with an unrecognised error", async () => {
      fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
      await expect(createDeviceGrant(SESSION, "1234", null)).rejects.toBeInstanceOf(ServerLockedError);
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "something_else" }, 401));
      await expect(createDeviceGrant(SESSION, "1234", null)).rejects.toBeInstanceOf(ServerLockedError);
      fetchMock.mockResolvedValueOnce(jsonResponse(null, 401));
      await expect(createDeviceGrant(SESSION, "1234", null)).rejects.toBeInstanceOf(ServerLockedError);
    });

    it("maps 429 to lockedOut using the body's retryAfterS, else the Retry-After header, else 0", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked_out", retryAfterS: 90 }, 429, { "Retry-After": "5" }));
      expect(await createDeviceGrant(SESSION, "1234", null)).toEqual({ ok: false, kind: "lockedOut", retryAfterS: 90 });

      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked_out" }, 429, { "Retry-After": "45" }));
      expect(await createDeviceGrant(SESSION, "1234", null)).toEqual({ ok: false, kind: "lockedOut", retryAfterS: 45 });

      fetchMock.mockResolvedValueOnce(new Response("slow down", { status: 429 }));
      expect(await createDeviceGrant(SESSION, "1234", null)).toEqual({ ok: false, kind: "lockedOut", retryAfterS: 0 });
    });

    it("never reports a negative wait", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ retryAfterS: -20 }, 429));
      expect(await createDeviceGrant(SESSION, "1234", null)).toEqual({ ok: false, kind: "lockedOut", retryAfterS: 0 });
    });

    it.each([
      [409, "pinChanged"],
      [422, "invalid"],
      [503, "unavailable"],
      [500, "unexpected"],
      [502, "unexpected"],
      [404, "unexpected"],
      [403, "unexpected"],
      [415, "unexpected"],
      [200, "unexpected"],
    ])("maps HTTP %i to %s", async (status, kind) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "x" }, status));
      expect(await createDeviceGrant(SESSION, "1234", null)).toEqual({ ok: false, kind });
    });

    it("reports unavailable when the network fails", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      expect(await createDeviceGrant(SESSION, "1234", null)).toEqual({ ok: false, kind: "unavailable" });
    });
  });

  describe("unlockWithGrant (POST /unlock-with-grant)", () => {
    it("returns the token and expiry on a 200", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ token: "minted", expiresAt: 1_800_000_500 }));
      expect(await unlockWithGrant(GRANT)).toEqual({ ok: true, token: "minted", expiresAt: 1_800_000_500 });
    });

    it("sends the grant id and secret with the guard headers and NO token header (the device is locked)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ token: "minted", expiresAt: 1 }));
      await unlockWithGrant(GRANT);
      const { url, init, headers } = lastCall();
      expect(url).toBe("/api/admin/server/unlock-with-grant");
      expect(init.method).toBe("POST");
      expectGuard(headers);
      expect(headers.has("X-Wixy-Server-Token")).toBe(false);
      expect(JSON.parse(String(init.body))).toEqual({ grantId: GRANT.grantId, secret: GRANT.secret });
      expect(url).not.toContain(GRANT.secret);
      expect(url).not.toContain(GRANT.grantId);
    });

    it.each([
      ["a missing token", { expiresAt: 1 }],
      ["a missing expiry", { token: "t" }],
      ["a non-finite expiry", { token: "t", expiresAt: "later" }],
      ["a null body", null],
    ])("treats a 200 with %s as unavailable — the grant may still be good", async (_name, body) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(body));
      expect(await unlockWithGrant(GRANT)).toEqual({ ok: false, kind: "unavailable" });
    });

    it("treats a 200 whose body is not JSON as unavailable", async () => {
      fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
      expect(await unlockWithGrant(GRANT)).toEqual({ ok: false, kind: "unavailable" });
    });

    it("maps 401 to invalid and does NOT throw ServerLockedError (there was no token to lock)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "grant_invalid" }, 401));
      await expect(unlockWithGrant(GRANT)).resolves.toEqual({ ok: false, kind: "invalid" });
    });

    it("maps 429 to rateLimited using the body's wait, else the header, else 0", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "rate_limited", retryAfterS: 12 }, 429, { "Retry-After": "3" }));
      expect(await unlockWithGrant(GRANT)).toEqual({ ok: false, kind: "rateLimited", retryAfterS: 12 });

      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "rate_limited" }, 429, { "Retry-After": "33" }));
      expect(await unlockWithGrant(GRANT)).toEqual({ ok: false, kind: "rateLimited", retryAfterS: 33 });

      fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
      expect(await unlockWithGrant(GRANT)).toEqual({ ok: false, kind: "rateLimited", retryAfterS: 0 });
    });

    it.each([403, 404, 415, 422, 500, 502, 503])("maps HTTP %i to unavailable — the grant is not judged bad", async (status) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "x" }, status));
      expect(await unlockWithGrant(GRANT)).toEqual({ ok: false, kind: "unavailable" });
    });

    it("reports unavailable when the network fails", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      expect(await unlockWithGrant(GRANT)).toEqual({ ok: false, kind: "unavailable" });
    });
  });

  describe("revokeDeviceGrant (DELETE /device-grants/{id})", () => {
    it("resolves on 204", async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      await expect(revokeDeviceGrant(SESSION, GRANT.grantId)).resolves.toBeUndefined();
    });

    it("resolves on 404 — already gone is the same outcome", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404));
      await expect(revokeDeviceGrant(SESSION, GRANT.grantId)).resolves.toBeUndefined();
    });

    it("sends a DELETE with the guard headers and the token header only", async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      await revokeDeviceGrant(SESSION, GRANT.grantId);
      const { url, init, headers } = lastCall();
      expect(url).toBe(`/api/admin/server/device-grants/${GRANT.grantId}`);
      expect(init.method).toBe("DELETE");
      expectGuard(headers);
      expect(headers.get("X-Wixy-Server-Token")).toBe(SESSION.token);
      expectTokenOnlyInHeader(url);
    });

    it("percent-encodes the id so it can never change the path", async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      await revokeDeviceGrant(SESSION, "../x?y=1#z");
      expect(lastCall().url).toBe("/api/admin/server/device-grants/..%2Fx%3Fy%3D1%23z");
    });

    it("throws ServerLockedError on 401", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked" }, 401));
      await expect(revokeDeviceGrant(SESSION, GRANT.grantId)).rejects.toBeInstanceOf(ServerLockedError);
    });

    it.each([400, 403, 415, 429, 500, 503])("throws on HTTP %i", async (status) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "x" }, status));
      const failure = revokeDeviceGrant(SESSION, GRANT.grantId);
      await expect(failure).rejects.toThrow(String(status));
      await expect(failure).rejects.not.toBeInstanceOf(ServerLockedError);
    });

    it("lets a network failure reject", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(revokeDeviceGrant(SESSION, GRANT.grantId)).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe("revokeAllDeviceGrants (DELETE /device-grants)", () => {
    it("resolves on 204", async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      await expect(revokeAllDeviceGrants(SESSION)).resolves.toBeUndefined();
    });

    it("sends a DELETE to the collection with the guard headers and the token header only", async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      await revokeAllDeviceGrants(SESSION);
      const { url, init, headers } = lastCall();
      expect(url).toBe("/api/admin/server/device-grants");
      expect(init.method).toBe("DELETE");
      expectGuard(headers);
      expect(headers.get("X-Wixy-Server-Token")).toBe(SESSION.token);
      expectTokenOnlyInHeader(url);
    });

    it("throws ServerLockedError on 401", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked" }, 401));
      await expect(revokeAllDeviceGrants(SESSION)).rejects.toBeInstanceOf(ServerLockedError);
    });

    it.each([200, 404, 403, 415, 500, 503])("throws on HTTP %i — only 204 counts as signed out", async (status) => {
      fetchMock.mockResolvedValueOnce(status === 200 ? jsonResponse({}, 200) : jsonResponse({ error: "x" }, status));
      await expect(revokeAllDeviceGrants(SESSION)).rejects.toThrow(String(status));
    });

    it("lets a network failure reject", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(revokeAllDeviceGrants(SESSION)).rejects.toBeInstanceOf(TypeError);
    });
  });
});
