// The public holiday-pack calls (spec/adventure-public section 2.3): `GET /api/pack/{code}` reads a
// place's pack from the server's shared cache, `POST /api/pack/{code}` starts its research when nobody
// has. Both answer the same body, which is parsed with the SAME defensive parser the private game uses
// (`parsePackView`: the sanitised pack, its pictures as same-origin `/media/...` URLs, the state). A 429
// carries `Retry-After`; nothing here throws.

import { parsePackView, type PackView } from "../server/adventure/api";

export type PackAnswer =
  /** `retryAfterS`: when a failed pack may be asked for again (null when not stated). */
  | { readonly kind: "ok"; readonly view: PackView; readonly retryAfterS: number | null }
  /** Too many research starts (this visitor's or everybody's): wait `retryAfterS` before asking to start again. */
  | { readonly kind: "rate_limited"; readonly retryAfterS: number }
  | { readonly kind: "not_found" }
  | { readonly kind: "error" };

export interface PackClient {
  get(code: string): Promise<PackAnswer>;
  post(code: string): Promise<PackAnswer>;
}

export interface PackClientDeps {
  readonly fetch: typeof fetch;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_RETRY_AFTER_S = 3_600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterSeconds(response: Response): number {
  const header = Number(response.headers.get("Retry-After"));
  return Number.isFinite(header) && header > 0 ? Math.min(MAX_RETRY_AFTER_S, Math.ceil(header)) : DEFAULT_RETRY_AFTER_S;
}

export function createPackClient(deps: PackClientDeps): PackClient {
  async function call(code: string, method: "GET" | "POST"): Promise<PackAnswer> {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = deps.setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
    try {
      const init: RequestInit = {
        method,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        ...(controller !== null ? { signal: controller.signal } : {}),
      };
      const response = await deps.fetch(`/api/pack/${encodeURIComponent(code)}`, init);
      if (response.status === 429) return { kind: "rate_limited", retryAfterS: retryAfterSeconds(response) };
      if (response.status === 404) return { kind: "not_found" };
      if (!response.ok) return { kind: "error" };
      const json: unknown = await response.json();
      if (!isRecord(json)) return { kind: "error" };
      const retry = json["retryAfterS"];
      return {
        kind: "ok",
        view: parsePackView(json),
        retryAfterS: typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? Math.min(MAX_RETRY_AFTER_S, retry) : null,
      };
    } catch {
      return { kind: "error" };
    } finally {
      deps.clearTimeout(timer);
    }
  }

  return { get: (code) => call(code, "GET"), post: (code) => call(code, "POST") };
}
