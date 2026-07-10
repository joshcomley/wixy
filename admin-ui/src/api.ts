// Typed fetch wrapper for `/api/admin/*` (spec/04-server.md §8's M6 subset, plus
// this slice's small `lastModified` extension to `pages`, spec/05-editor.md §5.1's
// pages-panel column). spec/05 §7: "Every fetch has a 10s timeout + retry-with-
// backoff (3x)."

import type { FontSpec } from "./googleFonts";
import type { DraftOp, JsonValue, PageBindings } from "./protocol";

export interface PageSummary {
  slug: string;
  meta: Record<string, JsonValue>;
  /** Newest `ts` among this page's draft overlay ops, or `null` if the page has
   * no draft edits — there's no other "last modified" signal until milestone 9's
   * publish ledger exists. */
  lastModified: string | null;
  /** `false` for a page just staged via `pages/duplicate` (milestone 9 slice
   * 4) — no template exists on disk until publish materializes it, so Edit
   * would 404 a live preview; the pages panel disables Edit until then. */
  editable: boolean;
  /** `true` once staged via `pages/delete` — takes effect at the next
   * publish (spec/04 §5), not immediately. */
  pendingDelete: boolean;
}

/** `PublishStage` mirrors `wixy_server.publisher.PublishStage` exactly (spec/04
 * §5's `pulling -> merging -> committing -> building -> verifying -> swapping
 * -> done`, plus `failed`). */
export type PublishStage =
  | "pulling"
  | "merging"
  | "committing"
  | "building"
  | "verifying"
  | "swapping"
  | "done"
  | "failed";

/** `wixy_server.routes_admin_api._publish_job_to_dict`'s exact shape — surfaced
 * both on `GET /api/admin/state`'s `publishJob` field and every `GET
 * /api/admin/publish/stream` SSE event. */
export interface PublishJobData {
  id: string;
  stage: PublishStage;
  log: string[];
  version: number | null;
  error: string | null;
  isRunning: boolean;
}

export interface UpstreamCommit {
  sha: string;
  subject: string;
  author: string;
  when: string;
}

/** `wixy_server.chats.conversation_summary`'s exact shape (spec/06 §1) — the
 * shared wire type both `GET/POST /api/admin/chat/conversations` and
 * `GET /api/admin/state`'s `chats` field return. */
export interface ConversationSummary {
  convId: string;
  title: string;
  createdAt: string;
  status: "pending" | "ready" | "failed";
  failureReason: string | null;
  failureMessage: string | null;
}

export interface StateResponse {
  project: { slug: string; name: string; domain: string };
  pages: PageSummary[];
  draft: { rev: number; opCount: number };
  live: { version: number; sha: string } | null;
  upstream: {
    aheadOfPublished: UpstreamCommit[];
    fetchedAt: string | null;
  };
  publishJob: PublishJobData | null;
  chats: ConversationSummary[];
}

/** One changed overlay key (`GET /api/admin/publish/preview`'s per-entry
 * shape) — `kind` is a binding kind (text/img/href/bg/attr/list/if) or the
 * synthetic `"theme"` for a `theme.json` key (spec/05 §5's "theme token
 * chips"; theme keys have no `data-wx-*` binding of their own). */
export interface PublishDiffEntry {
  key: string;
  kind: string;
  old: JsonValue;
  new: JsonValue;
}

export interface ValidateError {
  code: string;
  message: string;
  file?: string;
  key?: string;
}

export interface PublishPreview {
  /** Keyed by page slug, `"_global"`, or `"theme"` — same grouping the ledger's
   * own `changed` summary uses. */
  changes: Record<string, PublishDiffEntry[]>;
  validate: { ok: boolean; errors: ValidateError[] };
}

export type PublishOutcome =
  | { kind: "ok"; version: number; sha: string }
  | { kind: "conflict"; message: string }
  | { kind: "failed"; message: string };

/** `GET /api/admin/publishes`'s per-entry shape (spec/04 §6, `wixy_server.
 * ledger.LedgerEntry.to_dict()`) — a publish entry carries `message`/`source`/
 * `changed`; a restore entry carries `action`/`of` instead (never both). */
export interface PublishesEntry {
  version: number;
  sha: string;
  when: string;
  live: boolean;
  message?: string;
  source?: "editor" | "upstream" | "mixed";
  changed?: Record<string, string[]>;
  action?: "restore";
  of?: number;
}

export type RestoreOutcome =
  | { kind: "ok"; version: number; sha: string; of: number }
  | { kind: "conflict"; message: string }
  | { kind: "failed"; message: string };

/** `pages/duplicate` and `pages/delete`'s outcome (milestone 9 slice 4) — a
 * single ok/failed shape rather than `PublishOutcome`'s 3-way kind: neither
 * caller (`pagesPanel.ts`) needs to distinguish a 404/409/422 from each
 * other, only whether it worked and, if not, why (the server's own detail
 * message, shown verbatim). */
export type PageOpOutcome = { ok: true } | { ok: false; message: string };

export interface ContentResponse {
  content: Record<string, JsonValue>;
  bindings: PageBindings;
}

/** `GET /api/admin/media`'s per-item shape (milestone 8 slice 1's extension —
 * `wixy_server/routes_admin_api.py`'s `_media_item`): dimensions/size are always
 * present for a real file on disk; `references` lists the content keys (outermost
 * granularity, decisions/00020 decision 3) using this file, empty if unused. */
export interface MediaItem {
  name: string;
  url: string;
  source: "repo" | "draft";
  sizeBytes: number;
  width: number | null;
  height: number | null;
  references: string[];
}

/** `theme/theme.json`'s shape (spec/02 §4), as returned by `GET /api/admin/theme` —
 * already draft-overlay-merged server-side, same as `ContentResponse.content`. */
export interface ThemeData {
  colors: Record<string, string>;
  shadow: string;
  fonts: Record<string, FontSpec>;
}

export type PatchResult = { kind: "ok"; rev: number } | { kind: "conflict" };

/** `POST .../messages`'s response — `buffered: true` while the conversation
 * is still provisioning (spec/06 §1: cmd buffers the send itself; the
 * composer shows "queued"). */
export interface SendMessageResult {
  accepted: boolean;
  buffered: boolean;
}

/** `GET .../stream`'s per-event `message` payload (spec/06 §1's decoded
 * `/messages` shape, camelCased). */
export interface ChatMessageData {
  index: number;
  role: string;
  kind: string;
  text: string | null;
  timestamp: string;
  toolName: string | null;
  truncated: boolean;
}

/** `GET .../stream`'s per-event `status` payload — `processKind`/
 * `handoverState` are surfaced for completeness even though the status dot
 * (spec/06 §1) is driven primarily by `activity` freshness, not process
 * liveness. */
export interface ChatStatusData {
  activity: string | null;
  processKind: string | null;
  handoverState: string | null;
}

/** `GET .../stream`'s SSE envelope (spec/06 §1: "server-sent message, status,
 * error events") — a plain `data:` event carrying a `type` discriminator
 * (matches `publishDrawer.ts`'s existing convention on this codebase's one
 * other SSE endpoint; also sidesteps `EventSource`'s special-cased `error`
 * event NAME, which would otherwise collide with the connection-level
 * `onerror` callback). */
export type ConversationStreamEvent =
  | { type: "message"; message: ChatMessageData }
  | { type: "status"; status: ChatStatusData }
  | { type: "error"; detail: string };

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

function isDetailBody(value: unknown): value is { detail: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["detail"] === "string"
  );
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // FastAPI's HTTPException bodies are `{"detail": "<message>"}` — surfacing it
    // gives a real, specific error (e.g. DELETE /media's 409 "still referenced
    // by: …") instead of a generic "request failed with status 409" for every
    // endpoint alike.
    const detail = await response
      .json()
      .then((body: unknown) => (isDetailBody(body) ? body.detail : null))
      .catch(() => null);
    throw new ApiError(detail ?? `request failed with status ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

/** Same detail-extraction as `parseJson`, for a response the caller handles as
 * an expected (not thrown) outcome — `POST /publish`'s 409/502 both carry a
 * real, specific `detail` message worth showing verbatim (spec/05 §5: "a
 * failure state with the full error log inline"). */
async function extractDetail(response: Response, fallback: string): Promise<string> {
  const detail = await response
    .json()
    .then((body: unknown) => (isDetailBody(body) ? body.detail : null))
    .catch(() => null);
  return detail ?? fallback;
}

export interface AdminApi {
  getState(): Promise<StateResponse>;
  getContent(page: string): Promise<ContentResponse>;
  patchDraft(expectedRev: number, ops: DraftOp[]): Promise<PatchResult>;
  discardDraft(): Promise<{ rev: number }>;
  getMedia(): Promise<MediaItem[]>;
  uploadMedia(file: File): Promise<MediaItem>;
  deleteMedia(name: string): Promise<{ deleted: boolean }>;
  getTheme(): Promise<ThemeData>;
  getPublishPreview(): Promise<PublishPreview>;
  publish(message: string, expectedRev: number): Promise<PublishOutcome>;
  getPublishes(limit?: number): Promise<PublishesEntry[]>;
  restore(version: number): Promise<RestoreOutcome>;
  duplicatePage(fromSlug: string, slug: string, navLabel: string, expectedRev: number): Promise<PageOpOutcome>;
  deletePage(slug: string, expectedRev: number): Promise<PageOpOutcome>;
  createConversation(firstMessage?: string): Promise<ConversationSummary>;
  getConversations(): Promise<ConversationSummary[]>;
  sendMessage(convId: string, text: string, idempotencyKey: string): Promise<SendMessageResult>;
  renameConversation(convId: string, title: string): Promise<ConversationSummary>;
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
    async uploadMedia(file) {
      const formData = new FormData();
      formData.append("file", file);
      // fetchWithRetry re-sends the same FormData/File on a 5xx retry — safe
      // here specifically because the upload hash is of CONTENT, not a random id
      // (decisions/00020 decision 5): a retried identical upload resolves to the
      // SAME staged filename rather than creating a duplicate.
      const response = await fetchWithRetry("/api/admin/media", { method: "POST", body: formData });
      return parseJson<MediaItem>(response);
    },
    async deleteMedia(name) {
      const response = await fetchWithRetry(`/api/admin/media/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      return parseJson<{ deleted: boolean }>(response);
    },
    async getTheme() {
      const body = await parseJson<{ theme: ThemeData }>(await fetchWithRetry("/api/admin/theme"));
      return body.theme;
    },
    async getPublishPreview() {
      return parseJson<PublishPreview>(await fetchWithRetry("/api/admin/publish/preview"));
    },
    async publish(message, expectedRev) {
      const response = await fetchWithRetry("/api/admin/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, expectedRev }),
      });
      if (response.status === 409) {
        return { kind: "conflict", message: await extractDetail(response, "publish conflict") };
      }
      if (response.status === 502) {
        return { kind: "failed", message: await extractDetail(response, "publish failed") };
      }
      const body = await parseJson<{ version: number; sha: string }>(response);
      return { kind: "ok", version: body.version, sha: body.sha };
    },
    async getPublishes(limit) {
      const query = limit !== undefined ? `?limit=${limit}` : "";
      const body = await parseJson<{ publishes: PublishesEntry[] }>(
        await fetchWithRetry(`/api/admin/publishes${query}`),
      );
      return body.publishes;
    },
    async restore(version) {
      const response = await fetchWithRetry("/api/admin/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (response.status === 409) {
        return { kind: "conflict", message: await extractDetail(response, "restore conflict") };
      }
      if (response.status === 422) {
        return { kind: "failed", message: await extractDetail(response, "restore failed") };
      }
      const body = await parseJson<{ version: number; sha: string; of: number }>(response);
      return { kind: "ok", version: body.version, sha: body.sha, of: body.of };
    },
    async duplicatePage(fromSlug, slug, navLabel, expectedRev) {
      const response = await fetchWithRetry("/api/admin/pages/duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromSlug, slug, navLabel, expectedRev }),
      });
      if (!response.ok) {
        return { ok: false, message: await extractDetail(response, "duplicate failed") };
      }
      return { ok: true };
    },
    async deletePage(slug, expectedRev) {
      const response = await fetchWithRetry("/api/admin/pages/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, expectedRev }),
      });
      if (!response.ok) {
        return { ok: false, message: await extractDetail(response, "delete failed") };
      }
      return { ok: true };
    },
    async createConversation(firstMessage) {
      const response = await fetchWithRetry("/api/admin/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(firstMessage !== undefined ? { firstMessage } : {}),
      });
      return parseJson<ConversationSummary>(response);
    },
    async getConversations() {
      const body = await parseJson<{ conversations: ConversationSummary[] }>(
        await fetchWithRetry("/api/admin/chat/conversations"),
      );
      return body.conversations;
    },
    async sendMessage(convId, text, idempotencyKey) {
      const response = await fetchWithRetry(
        `/api/admin/chat/conversations/${encodeURIComponent(convId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, idempotencyKey }),
        },
      );
      return parseJson<SendMessageResult>(response);
    },
    async renameConversation(convId, title) {
      const response = await fetchWithRetry(
        `/api/admin/chat/conversations/${encodeURIComponent(convId)}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        },
      );
      return parseJson<ConversationSummary>(response);
    },
  };
}

export interface ConversationStreamHandle {
  close(): void;
}

/** Opens the SSE stream for one conversation (spec/06 §1's "Live updates").
 * A free function, not part of `AdminApi` — mirrors `publishDrawer.ts`'s own
 * `openStream` (there's exactly one active stream connection at a time, tied
 * to whichever conversation panel is open, not a general API call). Trusts
 * the event shape (same-origin, our own server) rather than runtime-validating
 * it, matching `publishDrawer.ts`'s precedent — only a genuinely malformed/
 * partial JSON parse is swallowed, never a wrong-shape object.
 *
 * `includeThinking` (spec/06 §1's "show reasoning" toggle, default off) has
 * no dedicated endpoint (spec/04 §8's admin API index lists none) — toggling
 * it means closing this connection and reopening with the flag set, which is
 * the caller's (`chatPanel.ts`) job, not this function's. */
export function openConversationStream(
  convId: string,
  onEvent: (event: ConversationStreamEvent) => void,
  includeThinking = false,
): ConversationStreamHandle {
  const query = includeThinking ? "?includeThinking=true" : "";
  const source = new EventSource(
    `/api/admin/chat/conversations/${encodeURIComponent(convId)}/stream${query}`,
  );
  source.onmessage = (event: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(event.data) as ConversationStreamEvent);
    } catch {
      // A malformed/partial event is never fatal — the next tick carries
      // current state again (routes_chat.py's own poll loop, like
      // publish_stream, re-derives from scratch each tick).
    }
  };
  return { close: () => source.close() };
}
