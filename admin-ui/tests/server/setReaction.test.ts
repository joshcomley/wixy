// `setReaction` (spec/server-chat/04-reactions.md): one PUT that sets the DESIRED state, so a
// retry after a dropped response cannot flip it back, and whose failures are typed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactionRequestError, setReaction } from "../../src/server/api/messages";
import type { ServerSession } from "../../src/server/types";

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };
const INPUT = { emoji: "\u{1F44D}", sender: "Purdy", reacted: true };
const MESSAGE = {
  seq: 7,
  clientId: "client-aaaaaaaa",
  sender: "Josh",
  text: "hi",
  attachments: [],
  reactions: [{ emoji: "\u{1F44D}", count: 1, senders: ["Purdy"] }],
  createdAt: 1_800_000_000,
};

describe("setReaction", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs the desired state to the message's reactions route with the unlock token", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: MESSAGE }));
    await setReaction(SESSION, 7, INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/server/messages/7/reactions");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual(INPUT);
    expect(new Headers(init.headers).get("X-Wixy-Server-Token")).toBe("tok");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("returns the message as the server now holds it", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: MESSAGE }));
    await expect(setReaction(SESSION, 7, INPUT)).resolves.toEqual(MESSAGE);
  });

  it.each([404, 422, 500, 503])("a %i throws a ReactionRequestError carrying the status", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status }));
    const failure = await setReaction(SESSION, 7, INPUT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReactionRequestError);
    expect((failure as ReactionRequestError).status).toBe(status);
  });

  it("a 401 still locks (never mapped to a reaction error)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(setReaction(SESSION, 7, INPUT)).rejects.toMatchObject({ name: "ServerLockedError" });
  });

  it("a network failure propagates", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(setReaction(SESSION, 7, INPUT)).rejects.toBeInstanceOf(TypeError);
  });
});
