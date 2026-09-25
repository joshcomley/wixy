// The device-grant routes (spec/server-chat/03-permanent-unlock.md §3). Every one of them
// carries the same request guard `POST /unlock` does — a JSON content type and the
// `X-Wixy-Server-Unlock: 1` header — because each either charges a PIN attempt or hands out
// a token, and a page the owner merely visits must not be able to send them.

import type { ServerSession } from "../types";
import type { StoredDeviceGrant } from "../deviceGrant";
import { ServerLockedError, serverFetch } from "./http";
import { UNLOCK_GUARD_HEADER } from "./unlock";

const GUARD_HEADERS = { "Content-Type": "application/json", [UNLOCK_GUARD_HEADER]: "1" } as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export type CreateGrantResult =
  | {
      readonly ok: true;
      readonly grant: StoredDeviceGrant;
      readonly token: string;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly kind: "wrongPin"; readonly attemptsLeft: number | null }
  | { readonly ok: false; readonly kind: "lockedOut"; readonly retryAfterS: number }
  | { readonly ok: false; readonly kind: "pinChanged" }
  | { readonly ok: false; readonly kind: "invalid" }
  | { readonly ok: false; readonly kind: "unexpected" }
  | { readonly ok: false; readonly kind: "unavailable" };

/** `POST /device-grants`: needs the unlock token AND the PIN. A wrong PIN is a 401 like a
 * locked chat is, so the token is attached by hand and the body decides which one it was —
 * `serverFetch` would turn any 401 into "locked". A genuinely locked chat still throws
 * `ServerLockedError`, which the caller lets propagate to the panel. */
export async function createDeviceGrant(
  session: ServerSession,
  pin: string,
  label: string | null,
): Promise<CreateGrantResult> {
  let response: Response;
  try {
    response = await serverFetch(
      "/device-grants",
      {
        method: "POST",
        headers: { ...GUARD_HEADERS, "X-Wixy-Server-Token": session.token },
        body: JSON.stringify({ pin, label }),
      },
      null,
    );
  } catch {
    return { ok: false, kind: "unavailable" };
  }

  if (response.status === 201) {
    const body = asRecord(await response.json().catch(() => null));
    const grantId = body?.["grantId"];
    const secret = body?.["secret"];
    const token = body?.["token"];
    const expiresAt = body?.["expiresAt"];
    if (
      typeof grantId === "string" &&
      typeof secret === "string" &&
      typeof token === "string" &&
      isFiniteNumber(expiresAt)
    ) {
      return { ok: true, grant: { grantId, secret }, token, expiresAt };
    }
    return { ok: false, kind: "unexpected" };
  }

  if (response.status === 401) {
    const body = asRecord(await response.json().catch(() => null));
    if (body?.["error"] === "wrong_pin") {
      const attemptsLeft = body["attemptsLeft"];
      return { ok: false, kind: "wrongPin", attemptsLeft: isFiniteNumber(attemptsLeft) ? attemptsLeft : null };
    }
    // `{"error":"locked"}` (or anything else a 401 can mean here): the chat is locked.
    throw new ServerLockedError();
  }

  if (response.status === 429) {
    const body = asRecord(await response.json().catch(() => null));
    const bodyRetry = body?.["retryAfterS"];
    const headerRetry = Number(response.headers.get("Retry-After"));
    const retryAfterS = isFiniteNumber(bodyRetry) ? bodyRetry : Number.isFinite(headerRetry) ? headerRetry : 0;
    return { ok: false, kind: "lockedOut", retryAfterS: Math.max(0, retryAfterS) };
  }

  if (response.status === 409) return { ok: false, kind: "pinChanged" };
  if (response.status === 422) return { ok: false, kind: "invalid" };
  if (response.status === 503) return { ok: false, kind: "unavailable" };
  return { ok: false, kind: "unexpected" };
}

export type GrantUnlockResult =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number }
  /** 401 `grant_invalid`: revoked, expired, unknown or not this identity's. The device
   * should forget its grant. */
  | { readonly ok: false; readonly kind: "invalid" }
  | { readonly ok: false; readonly kind: "rateLimited"; readonly retryAfterS: number }
  /** Offline, a proxy error, an unexpected status: the grant may still be good. */
  | { readonly ok: false; readonly kind: "unavailable" };

/** `POST /unlock-with-grant`: no PIN, no token (the device is locked when it asks). */
export async function unlockWithGrant(grant: StoredDeviceGrant): Promise<GrantUnlockResult> {
  let response: Response;
  try {
    response = await serverFetch(
      "/unlock-with-grant",
      { method: "POST", headers: GUARD_HEADERS, body: JSON.stringify({ grantId: grant.grantId, secret: grant.secret }) },
      null,
    );
  } catch {
    return { ok: false, kind: "unavailable" };
  }

  if (response.status === 200) {
    const body = asRecord(await response.json().catch(() => null));
    const token = body?.["token"];
    const expiresAt = body?.["expiresAt"];
    if (typeof token === "string" && isFiniteNumber(expiresAt)) return { ok: true, token, expiresAt };
    return { ok: false, kind: "unavailable" };
  }
  if (response.status === 401) return { ok: false, kind: "invalid" };
  if (response.status === 429) {
    const body = asRecord(await response.json().catch(() => null));
    const bodyRetry = body?.["retryAfterS"];
    const headerRetry = Number(response.headers.get("Retry-After"));
    const retryAfterS = isFiniteNumber(bodyRetry) ? bodyRetry : Number.isFinite(headerRetry) ? headerRetry : 0;
    return { ok: false, kind: "rateLimited", retryAfterS: Math.max(0, retryAfterS) };
  }
  return { ok: false, kind: "unavailable" };
}

/** `DELETE /device-grants/{id}`. A 404 (already gone, or never this identity's) is the same
 * outcome as a 204 for the caller: the grant is not usable. Any other failure throws, and
 * the caller clears its local copy regardless (the server's 30-day expiry mops up). */
export async function revokeDeviceGrant(session: ServerSession, grantId: string): Promise<void> {
  const response = await serverFetch(
    `/device-grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE", headers: GUARD_HEADERS },
    session,
  );
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`Couldn't turn this off on the server (${response.status})`);
  }
}

/** `DELETE /device-grants`: "Sign out other devices" — revokes every grant of this identity,
 * this device's included. */
export async function revokeAllDeviceGrants(session: ServerSession): Promise<void> {
  const response = await serverFetch("/device-grants", { method: "DELETE", headers: GUARD_HEADERS }, session);
  if (response.status !== 204) {
    throw new Error(`Couldn't sign the other devices out (${response.status})`);
  }
}
