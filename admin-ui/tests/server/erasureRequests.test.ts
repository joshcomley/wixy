import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteMessage, wipeChat } from "../../src/server/api/messages";
import type { ServerSession } from "../../src/server/types";

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function abortOnSignal(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}

describe("destructive erasure requests", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a DELETE once after a 30-second timeout, then accepts success", async () => {
    fetchMock
      .mockImplementationOnce(abortOnSignal)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const deletion = deleteMessage(SESSION, 17);
    const outcome = deletion.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toEqual({ kind: "resolved", value: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/server/messages/17");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/server/messages/17");
  });

  it("retries a network failure after 1 second", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network failure"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const deletion = deleteMessage(SESSION, 18);
    const outcome = deletion.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toEqual({ kind: "resolved", value: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("restores after the initial DELETE plus all three unknown-outcome retries", async () => {
    fetchMock.mockImplementation(abortOnSignal);
    const deletion = deleteMessage(SESSION, 19);
    const outcome = deletion.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    for (const [attempt, retryDelayMs] of [1_000, 2_000, 4_000].entries()) {
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(retryDelayMs);
      expect(fetchMock).toHaveBeenCalledTimes(attempt + 2);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({
      kind: "rejected",
      error: { name: "ServerErasureOutcomeUnknownError" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry a definite HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(deleteMessage(SESSION, 20)).rejects.toThrow("Couldn't delete message (503).");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never retries a wipe transport failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network failure"));
    const outcome = await wipeChat(SESSION).then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    expect(outcome).toMatchObject({ kind: "rejected", error: { name: "ServerErasureOutcomeUnknownError" } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
