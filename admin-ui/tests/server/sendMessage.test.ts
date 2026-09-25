// `sendMessage`'s status mapping (spec/server-chat/00-brief.md §5.3). The voice-note
// flow (F17) needs to tell a DEFINITIVE rejection — the server judged this exact
// payload and will judge it the same way again — from a transient failure worth a
// retry, so every 4xx except the transient 408/429 maps to `rejected`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "../../src/server/api/messages";
import type { ServerSession } from "../../src/server/types";

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };
const INPUT = {
  clientId: "client-aaaaaaaa",
  sender: "Josh",
  deviceId: "device-aaaaaaaa",
  text: null,
  attachmentIds: ["att-1"],
};

describe("sendMessage status mapping", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("422 is invalid, with the server's detail", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "invalid", detail: "attachment x is unknown, already used, or failed" }, { status: 422 }),
    );
    await expect(sendMessage(SESSION, INPUT)).resolves.toEqual({
      ok: false,
      kind: "invalid",
      detail: "attachment x is unknown, already used, or failed",
    });
  });

  it.each([400, 404, 409, 413, 415])("a %i is a definitive rejection, not a transient failure", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status }));
    await expect(sendMessage(SESSION, INPUT)).resolves.toEqual({ ok: false, kind: "rejected", status });
  });

  it.each([408, 429, 500, 502, 503, 504])("a %i stays transient (retryable)", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("later", { status }));
    await expect(sendMessage(SESSION, INPUT)).resolves.toEqual({ ok: false, kind: "unavailable" });
  });

  it("a network failure stays transient", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(sendMessage(SESSION, INPUT)).resolves.toEqual({ ok: false, kind: "unavailable" });
  });

  it("a 401 still locks (never mapped to a send result)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(sendMessage(SESSION, INPUT)).rejects.toMatchObject({ name: "ServerLockedError" });
  });
});
