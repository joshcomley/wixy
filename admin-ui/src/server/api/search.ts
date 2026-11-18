// The Search screen's HTTP surface (`POST /messages/search`, decisions/00208). A POST so that what
// somebody searched for travels in a request body and never in a URL, which access logs keep.

import type { ServerSession } from "../types";
import { serverFetch } from "./http";

export interface SearchPart {
  readonly text: string;
  /** This part is one of the words searched for. */
  readonly match: boolean;
}

export interface SearchResult {
  readonly seq: number;
  readonly sender: string;
  readonly createdAt: number;
  /** Where the words were found: the message itself, or its voice note's transcript. */
  readonly source: "text" | "transcript";
  /** A short excerpt around the first match. */
  readonly parts: readonly SearchPart[];
  /** The matched words exactly as written in the message, to mark them in its bubble. */
  readonly matched: readonly string[];
}

export interface SearchPage {
  readonly results: readonly SearchResult[];
  readonly hasMore: boolean;
  /** Every match in the chat, whichever page this is. */
  readonly total: number;
}

export const SEARCH_PAGE = 30;
/** Mirrors `MAX_QUERY_CHARS` in wixy_server/livechat/search.py. */
export const SEARCH_MAX_CHARS = 200;

export async function searchMessages(
  session: ServerSession,
  q: string,
  opts: { before?: number; only?: number; limit?: number } = {},
): Promise<SearchPage> {
  const response = await serverFetch(
    "/messages/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q, limit: opts.limit ?? SEARCH_PAGE, before: opts.before, only: opts.only }),
    },
    session,
  );
  if (!response.ok) throw new Error(`Couldn't search the messages (${response.status}).`);
  const body = (await response.json()) as { results?: unknown; hasMore?: unknown; total?: unknown };
  return {
    results: Array.isArray(body.results) ? (body.results as SearchResult[]) : [],
    hasMore: body.hasMore === true,
    total: typeof body.total === "number" ? body.total : 0,
  };
}
