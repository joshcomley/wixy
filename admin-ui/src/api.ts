// Typed fetch wrapper for `/api/admin/*` (spec/04-server.md §8's M6 subset, plus
// this slice's small `lastModified` extension to `pages`, spec/05-editor.md §5.1's
// pages-panel column). spec/05 §7: "Every fetch has a 10s timeout + retry-with-
// backoff (3x)."

import type { DraftOp, JsonValue, PageBindings } from "./protocol";

export interface PageSummary {
  slug: string;
  meta: Record<string, JsonValue>;
  /** Newest `ts` among this page's draft overlay ops, or `null` if the page has
   * no draft edits — there's no other "last modified" signal until milestone 9's
   * publish ledger exists. */
  lastModified: string | null;
}

export interface StateResponse {
  project: { slug: string; name: string; domain: string };
  pages: PageSummary[];
  draft: { rev: number; opCount: number };
  live: { version: number; sha: string } | null;
  upstream: {
    aheadOfPublished: Array<{ sha: string; subject: string; author: string; when: string }>;
    fetchedAt: string | null;
  };
  publishJob: JsonValue | null;
  chats: JsonValue[];
}

export interface ContentResponse {
  content: Record<string, JsonValue>;
  bindings: PageBindings;
}

export interface MediaItem {
  name: string;
  url: string;
  source: "repo" | "draft";
}

export type PatchResult = { kind: "ok"; rev: number } | { kind: "conflict" };

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

export class ApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** spec/05 §7's fetch discipline: a 10s timeout per attempt, up to 3 attempts
 * with a linear backoff. Retries network failures and 5xx only — a 4xx is the
 * server's considered answer (e.g. PATCH /draft's 409 is an expected outcome the
 * OpQueue itself handles, never something blind retrying would resolve). */
async function fetchWithRetry(input: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
        lastError = new ApiError(`${input} -> ${response.status}`, response.status);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) await delay(RETRY_BASE_MS * attempt);
  }
  throw lastError instanceof Error ? lastError : new ApiError("request failed");
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiError(`request failed with status ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

export interface AdminApi {
  getState(): Promise<StateResponse>;
  getContent(page: string): Promise<ContentResponse>;
  patchDraft(expectedRev: number, ops: DraftOp[]): Promise<PatchResult>;
  discardDraft(): Promise<{ rev: number }>;
  getMedia(): Promise<MediaItem[]>;
}

export function createApi(): AdminApi {
  return {
    async getState() {
      return parseJson<StateResponse>(await fetchWithRetry("/api/admin/state"));
    },
    async getContent(page) {
      return parseJson<ContentResponse>(
        await fetchWithRetry(`/api/admin/content/${encodeURIComponent(page)}`),
      );
    },
    async patchDraft(expectedRev, ops) {
      const response = await fetchWithRetry("/api/admin/draft", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRev, ops }),
      });
      if (response.status === 409) return { kind: "conflict" };
      const body = await parseJson<{ rev: number }>(response);
      return { kind: "ok", rev: body.rev };
    },
    async discardDraft() {
      return parseJson<{ rev: number }>(
        await fetchWithRetry("/api/admin/draft", { method: "DELETE" }),
      );
    },
    async getMedia() {
      const body = await parseJson<{ media: MediaItem[] }>(await fetchWithRetry("/api/admin/media"));
      return body.media;
    },
  };
}
