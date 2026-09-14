// The server-chat fetch wrapper (spec/server-chat/00-brief.md §5): every
// route under `/api/admin/server` except `POST /unlock` and `GET /media/*`
// requires the `X-Wixy-Server-Token` header (R4), and a missing/invalid/
// expired token always comes back 401 `{"error":"locked"}` — the client
// locks on ANY 401, no exceptions, per R6's fail-closed mandate. This module
// owns that one mapping; each area's own `server/api/<area>.ts` (messages,
// uploads, push) calls through it rather than `fetch` directly, so a token
// never accidentally lands in a query string or gets built by hand twice.

import type { ServerSession } from "../types";

export const SERVER_API_BASE = "/api/admin/server";

/** Thrown by `serverFetch` on any 401 — `panel.ts` is the only place that
 * catches this, turning it into `hooks.lockNow("unauthorized")` (R6: "any
 * 401 or `locked` event from the API" is an instant lock trigger). Callers
 * further out (an area module's own typed wrapper) should let this
 * propagate rather than swallowing it — locking is panel.ts's job, not
 * theirs. */
export class ServerLockedError extends Error {
  constructor() {
    super("server chat: locked (401)");
    this.name = "ServerLockedError";
  }
}

const TIMEOUT_MS = 10_000;

/** `path` is relative to `SERVER_API_BASE` and must start with "/" (e.g.
 * `"/messages"`, `"/unlock"`). `session` is `null` only for `POST /unlock`
 * itself, which runs before a token exists — every other caller has one.
 * Never attaches the token as a query parameter (R4/§5: "A token passed as a
 * query parameter is rejected" — the header is the only accepted form).
 *
 * The 401->`ServerLockedError` mapping applies only when `session` is
 * non-null: that's R6's "any 401 ... from the API" lock trigger, which only
 * makes sense once there WAS a token to invalidate. `POST /unlock` itself is
 * called with `session: null` and legitimately answers 401 for a wrong PIN
 * (§5.1) — an expected outcome `server/api/unlock.ts` maps itself, not a
 * lock-worthy event. */
export async function serverFetch(
  path: string,
  init: RequestInit,
  session: ServerSession | null,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (session !== null) {
    headers.set("X-Wixy-Server-Token", session.token);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${SERVER_API_BASE}${path}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 && session !== null) {
    throw new ServerLockedError();
  }
  return response;
}
