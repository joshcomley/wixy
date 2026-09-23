// `POST /unlock` (spec/server-chat/00-brief.md §5.1). P1's real
// `routes_livechat.py` route doesn't exist yet as this parcel is being built
// (wave 1, concurrent) — this module only depends on the FROZEN wire
// contract in §5.1, so it's correct against the real route the moment P1
// lands, no changes needed here. Tests stub the network boundary rather than
// waiting on P1 (this parcel's own vitest) or run against a fake backend
// (e2e's `page.route` interception — see `e2e/tests/server-lock.spec.ts`).

import { serverFetch } from "./http";

export interface UnlockOk {
  readonly ok: true;
  readonly token: string;
  readonly expiresAt: number;
}

export type UnlockFailure =
  | { readonly ok: false; readonly kind: "wrongPin"; readonly attemptsLeft: number | null }
  | { readonly ok: false; readonly kind: "lockedOut"; readonly retryAfterS: number }
  /** Covers both 503 variants (`not_configured`, `pin_service_unavailable`)
   * plus any transport failure, a malformed 200 body, and 422 — every one of
   * them must read as "Server settings unavailable" (R4: closed, never
   * open). There is no operator-facing distinction between "cmd doesn't
   * know this app key" and "cmd is unreachable" — both mean the same thing
   * from here: no verifier answered. */
  | { readonly ok: false; readonly kind: "unavailable" };

export type UnlockResult = UnlockOk | UnlockFailure;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export async function unlock(pin: string): Promise<UnlockResult> {
  let response: Response;
  try {
    response = await serverFetch(
      "/unlock",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      },
      null,
    );
  } catch {
    return { ok: false, kind: "unavailable" };
  }

  if (response.status === 200) {
    const body: unknown = await response.json().catch(() => null);
    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as Record<string, unknown>)["token"] === "string" &&
      isFiniteNumber((body as Record<string, unknown>)["expiresAt"])
    ) {
      const typed = body as { token: string; expiresAt: number };
      return { ok: true, token: typed.token, expiresAt: typed.expiresAt };
    }
    return { ok: false, kind: "unavailable" };
  }

  if (response.status === 401) {
    const body: unknown = await response.json().catch(() => null);
    const attemptsLeft =
      typeof body === "object" && body !== null && isFiniteNumber((body as Record<string, unknown>)["attemptsLeft"])
        ? (body as { attemptsLeft: number }).attemptsLeft
        : null;
    return { ok: false, kind: "wrongPin", attemptsLeft };
  }

  if (response.status === 429) {
    const body: unknown = await response.json().catch(() => null);
    const bodyRetry =
      typeof body === "object" && body !== null && isFiniteNumber((body as Record<string, unknown>)["retryAfterS"])
        ? (body as { retryAfterS: number }).retryAfterS
        : null;
    const headerRetry = Number(response.headers.get("Retry-After"));
    const retryAfterS = bodyRetry ?? (Number.isFinite(headerRetry) ? headerRetry : 0);
    return { ok: false, kind: "lockedOut", retryAfterS: Math.max(0, retryAfterS) };
  }

  // 503 (not_configured / pin_service_unavailable), 422, and anything else
  // unrecognized — fail closed, never open (R4).
  return { ok: false, kind: "unavailable" };
}
