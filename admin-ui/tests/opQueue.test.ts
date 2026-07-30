import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftOp } from "../src/protocol";
import { DEFAULT_COALESCE_MS, OpQueue, type PatchResult } from "../src/opQueue";

const op = (path: string, value: string): DraftOp => ({ file: "index", path, value });

describe("OpQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not send anything before the coalesce delay elapses", () => {
    const sendPatch = vi.fn<(rev: number, ops: DraftOp[]) => Promise<PatchResult>>();
    const queue = new OpQueue(0, { sendPatch, fetchCurrentRev: vi.fn() });

    queue.enqueue(op("hero.title", "New"));
    vi.advanceTimersByTime(DEFAULT_COALESCE_MS - 1);

    expect(sendPatch).not.toHaveBeenCalled();
  });

  it("coalesces multiple enqueues within the delay into a single PATCH", async () => {
    const sendPatch = vi.fn(async (): Promise<PatchResult> => ({ kind: "ok", rev: 1 }));
    const queue = new OpQueue(0, { sendPatch, fetchCurrentRev: vi.fn() });

    queue.enqueue(op("hero.title", "A"));
    queue.enqueue(op("hero.tag", "B"));
    await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);

    expect(sendPatch).toHaveBeenCalledTimes(1);
    expect(sendPatch).toHaveBeenCalledWith(0, [op("hero.title", "A"), op("hero.tag", "B")]);
  });

  it("advances rev and calls onAccepted after a successful patch", async () => {
    const sendPatch = vi.fn(async (): Promise<PatchResult> => ({ kind: "ok", rev: 5 }));
    const onAccepted = vi.fn();
    const queue = new OpQueue(4, { sendPatch, fetchCurrentRev: vi.fn(), onAccepted });

    queue.enqueue(op("hero.title", "A"));
    await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);

    expect(queue.rev).toBe(5);
    expect(onAccepted).toHaveBeenCalledWith([op("hero.title", "A")], 5);
  });

  it("on a 409 conflict, refetches the rev and replays the same batch immediately", async () => {
    const sendPatch = vi
      .fn<(rev: number, ops: DraftOp[]) => Promise<PatchResult>>()
      .mockResolvedValueOnce({ kind: "conflict" })
      .mockResolvedValueOnce({ kind: "ok", rev: 10 });
    const fetchCurrentRev = vi.fn(async () => 9);
    const queue = new OpQueue(0, { sendPatch, fetchCurrentRev });

    queue.enqueue(op("hero.title", "A"));
    await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);

    expect(fetchCurrentRev).toHaveBeenCalledTimes(1);
    expect(sendPatch).toHaveBeenNthCalledWith(1, 0, [op("hero.title", "A")]);
    expect(sendPatch).toHaveBeenNthCalledWith(2, 9, [op("hero.title", "A")]);
    expect(queue.rev).toBe(10);
  });

  it("an op enqueued while a flush is in-flight is picked up by the same flush loop", async () => {
    let resolveFirst: (result: PatchResult) => void = () => {};
    const sendPatch = vi
      .fn<(rev: number, ops: DraftOp[]) => Promise<PatchResult>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ kind: "ok", rev: 2 });
    const queue = new OpQueue(0, { sendPatch, fetchCurrentRev: vi.fn() });

    queue.enqueue(op("hero.title", "A"));
    await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);
    // first sendPatch call is now in-flight (unresolved) — enqueue during it
    queue.enqueue(op("hero.tag", "B"));
    resolveFirst({ kind: "ok", rev: 1 });
    await vi.waitFor(() => expect(sendPatch).toHaveBeenCalledTimes(2));

    expect(sendPatch).toHaveBeenNthCalledWith(2, 1, [op("hero.tag", "B")]);
  });

  it("keeps a batch queued and retries after a rejected sendPatch", async () => {
    const sendPatch = vi
      .fn<(rev: number, ops: DraftOp[]) => Promise<PatchResult>>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ kind: "ok", rev: 1 });
    const onError = vi.fn();
    const queue = new OpQueue(0, { sendPatch, fetchCurrentRev: vi.fn(), onError });

    queue.enqueue(op("hero.title", "A"));
    await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount).toBe(1);

    // a later enqueue's scheduled flush retries the still-queued op too
    queue.enqueue(op("hero.tag", "B"));
    await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);

    expect(sendPatch).toHaveBeenNthCalledWith(2, 0, [
      op("hero.title", "A"),
      op("hero.tag", "B"),
    ]);
    expect(queue.pendingCount).toBe(0);
  });

  it("drops (never re-queues) a batch the server structurally rejects (decisions/00095)", async () => {
    const sendPatch = vi
      .fn<(rev: number, ops: DraftOp[]) => Promise<PatchResult>>()
      .mockResolvedValueOnce({ kind: "rejected", message: "doesn't match the expected shape" });
    const onRejected = vi.fn();
    const onAccepted = vi.fn();
    const queue = new OpQueue(3, { sendPatch, fetchCurrentRev: vi.fn(), onRejected, onAccepted });

    queue.enqueue(op("hero.title", "A"));
    await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);

    // Unlike a 409 conflict, retrying a 422 can only loop forever — the batch
    // must be gone, not sitting in the queue for the next flush to resend.
    expect(queue.pendingCount).toBe(0);
    expect(onRejected).toHaveBeenCalledWith(
      [op("hero.title", "A")],
      "doesn't match the expected shape",
    );
    expect(onAccepted).not.toHaveBeenCalled();
    // The batch never actually landed — the rev the queue believes is live
    // must not change.
    expect(queue.rev).toBe(3);
  });

  it("a rejected batch does not block a later, independent batch from flushing", async () => {
    const sendPatch = vi
      .fn<(rev: number, ops: DraftOp[]) => Promise<PatchResult>>()
      .mockResolvedValueOnce({ kind: "rejected", message: "bad shape" })
      .mockResolvedValueOnce({ kind: "ok", rev: 1 });
    const queue = new OpQueue(0, { sendPatch, fetchCurrentRev: vi.fn(), onRejected: vi.fn() });

    queue.enqueue(op("hero.title", "A"));
    await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);
    queue.enqueue(op("hero.tag", "B"));
    await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);

    expect(sendPatch).toHaveBeenCalledTimes(2);
    expect(sendPatch).toHaveBeenNthCalledWith(2, 0, [op("hero.tag", "B")]);
    expect(queue.rev).toBe(1);
  });

  it("flushNow sends immediately without waiting for the coalesce delay", async () => {
    const sendPatch = vi.fn(async (): Promise<PatchResult> => ({ kind: "ok", rev: 1 }));
    const queue = new OpQueue(0, { sendPatch, fetchCurrentRev: vi.fn() });

    queue.enqueue(op("hero.title", "A"));
    await queue.flushNow();

    expect(sendPatch).toHaveBeenCalledTimes(1);
  });
});
