import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Microtask flush (vitest 4 dropped vi.flushPromises; fake timers don't
 * touch microtasks, so plain Promise.resolve() rounds drain the chain). */
async function flushMicro(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
import { createThumbnailService, type ThumbnailApi } from "../src/thumbnailService";

function fakeApi(): ThumbnailApi & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    putThumbnail: vi.fn(async (slug: string, _blob: Blob) => {
      puts.push(slug);
      return { ok: true };
    }),
  };
}

/** A capture fake that records calls and lets the test control completion. */
function fakeCapture() {
  const calls: string[] = [];
  const gates = new Map<string, (blob: Blob) => void>();
  const capture = vi.fn((slug: string) => {
    calls.push(slug);
    return new Promise<Blob>((resolve) => gates.set(slug, resolve));
  });
  return {
    calls,
    capture,
    finish: (slug: string) => gates.get(slug)?.(new Blob(["x"], { type: "image/jpeg" })),
  };
}

describe("createThumbnailService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces a burst of refreshes for the same page into one capture", async () => {
    const api = fakeApi();
    const cap = fakeCapture();
    const service = createThumbnailService({ api, capture: cap.capture });

    service.refresh(["index"]);
    service.refresh(["index"]);
    service.refresh(["index"]);
    await vi.advanceTimersByTimeAsync(1600);

    expect(cap.calls).toEqual(["index"]);
    cap.finish("index");
    await flushMicro();
    expect(api.puts).toEqual(["index"]);
    service.teardown();
  });

  it("captures different pages serially, one iframe at a time", async () => {
    const api = fakeApi();
    const cap = fakeCapture();
    const service = createThumbnailService({ api, capture: cap.capture });

    service.refresh(["index", "about"]);
    await vi.advanceTimersByTimeAsync(1600);

    // only the first capture starts before it resolves
    expect(cap.calls).toEqual(["index"]);
    cap.finish("index");
    await flushMicro();
    await vi.advanceTimersByTimeAsync(0);
    expect(cap.calls).toEqual(["index", "about"]);
    cap.finish("about");
    await flushMicro();
    expect(api.puts).toEqual(["index", "about"]);
    service.teardown();
  });

  it("a failing capture does not stall the queue", async () => {
    const api = fakeApi();
    let calls = 0;
    const service = createThumbnailService({
      api,
      capture: (slug) => {
        calls += 1;
        return slug === "index" ? Promise.reject(new Error("boom")) : Promise.resolve(new Blob(["x"]));
      },
    });

    service.refresh(["index", "about"]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushMicro();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicro();

    expect(calls).toBe(2);
    expect(api.puts).toEqual(["about"]);
    service.teardown();
  });

  it("re-refreshing an already-queued slug does not duplicate it", async () => {
    const api = fakeApi();
    const cap = fakeCapture();
    const service = createThumbnailService({ api, capture: cap.capture });

    service.refresh(["index"]);
    await vi.advanceTimersByTimeAsync(1600); // starts capture for index
    service.refresh(["index"]); // re-queues while in flight
    await vi.advanceTimersByTimeAsync(1600);
    cap.finish("index");
    await flushMicro();

    // the second refresh starts exactly one more capture (not two)
    expect(cap.calls).toEqual(["index", "index"]);
    cap.finish("index");
    await flushMicro();
    expect(api.puts).toEqual(["index", "index"]);
    service.teardown();
  });

  it("teardown cancels pending refreshes", async () => {
    const api = fakeApi();
    const cap = fakeCapture();
    const service = createThumbnailService({ api, capture: cap.capture });

    service.refresh(["index", "about"]);
    service.teardown();
    await vi.advanceTimersByTimeAsync(3000);

    expect(cap.calls).toEqual([]);
  });
});
