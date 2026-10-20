// The "Links" view's HTTP surface (`GET /messages/links`, workspace 00052): only the messages
// whose text holds a web link, the newest page first, paged with `before` (the lowest seq
// already held). Each page's messages come back ascending, exactly like history.

import type { ServerSession } from "../types";
import { serverFetch } from "./http";
import type { Message } from "./messages";

export interface LinksPage {
  readonly messages: readonly Message[];
  readonly hasMore: boolean;
}

export const LINKS_PAGE = 40;

export async function getLinkMessages(
  session: ServerSession,
  opts: { before?: number; limit?: number } = {},
): Promise<LinksPage> {
  const params = new URLSearchParams();
  if (opts.before !== undefined) params.set("before", String(opts.before));
  params.set("limit", String(opts.limit ?? LINKS_PAGE));
  const response = await serverFetch(`/messages/links?${params.toString()}`, { method: "GET" }, session);
  if (!response.ok) throw new Error(`Couldn't load the links (${response.status}).`);
  const body = (await response.json()) as { messages?: unknown; hasMore?: unknown };
  const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
  return { messages, hasMore: body.hasMore === true };
}
