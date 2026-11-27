import { afterEach, describe, expect, it, vi } from "vitest";
import { textureUrl, setTextureUrls } from "../../src/server/adventure/imagery";
import { parsePackView } from "../../src/server/adventure/api";
import { createPackClient } from "../../src/public/packClient";

afterEach(() => {
  setTextureUrls({});
});

function client(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string; init: RequestInit | undefined }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? "GET", init });
    return respond(url, init);
  });
  const cleared: number[] = [];
  const timers: Array<() => void> = [];
  const pc = createPackClient({
    fetch: fetchImpl,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: (id) => cleared.push(id),
  });
  return { pc, calls, cleared, timers };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const READY = {
  code: "abcdef",
  destinationId: "AAA.a1",
  state: "ready",
  data: { headline: "H", summary: "S", sections: [{ key: "dishes", title: "Local food to try", items: [{ name: "Tarts", detail: "Custard" }] }], bestTime: "", gettingThere: "", travelAdvice: "", sources: [] },
  error: null,
  canRetry: false,
  images: "pending",
  pictures: { hero: [{ thumbUrl: "/media/aa/thumb.jpg", fullUrl: "/media/aa/full.jpg", credit: "A. Person, CC BY-SA 4.0, Wikimedia Commons", page: "https://commons.wikimedia.org/wiki/File:X.jpg", caption: "A view" }], items: { "dishes:0": { thumbUrl: "/media/bb/thumb.jpg", fullUrl: "/media/bb/full.jpg", credit: "B", page: "", caption: "" } } },
  retryAfterS: null,
};

describe("pack client", () => {
  it("GET and POST address /api/pack/<code> on this origin and parse the answer with the game's own parser", async () => {
    const { pc, calls } = client(() => json(READY));
    const got = await pc.get("abcdef");
    const posted = await pc.post("abcdef");
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", "/api/pack/abcdef"], ["POST", "/api/pack/abcdef"]]);
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(got.kind).toBe("ok");
    if (got.kind !== "ok" || posted.kind !== "ok") throw new Error("expected ok");
    expect(got.view.state).toBe("ready");
    expect(got.view.images).toBe("pending");
    expect(got.view.data?.sections[0]?.items[0]?.name).toBe("Tarts");
    expect(got.view.pictures?.hero[0]?.thumbUrl).toBe("/media/aa/thumb.jpg");
    expect(got.view.pictures?.hero[0]?.page).toBe("https://commons.wikimedia.org/wiki/File:X.jpg");
    expect(got.view.pictures?.items.get("dishes:0")?.fullUrl).toBe("/media/bb/full.jpg");
    expect(got.retryAfterS).toBeNull();
    expect(posted.view).toEqual(got.view);
  });

  it("drops a picture that is not on this origin (the same lock the private game has)", async () => {
    const hostile = { ...READY, pictures: { hero: [{ thumbUrl: "https://evil.example/x.jpg", fullUrl: "//evil.example/y.jpg", credit: "", page: "", caption: "" }], items: {} } };
    const { pc } = client(() => json(hostile));
    const got = await pc.get("abcdef");
    if (got.kind !== "ok") throw new Error("expected ok");
    expect(got.view.pictures?.hero).toEqual([]);
  });

  it("encodes the code, reads retryAfterS from the body, and tolerates a body with no pack fields", async () => {
    const { pc, calls } = client(() => json({ state: "failed", error: "The research didn't finish.", canRetry: false, retryAfterS: 600 }));
    const got = await pc.get("a/b");
    expect(calls[0]?.url).toBe("/api/pack/a%2Fb");
    if (got.kind !== "ok") throw new Error("expected ok");
    expect(got.view.state).toBe("failed");
    expect(got.view.canRetry).toBe(false);
    expect(got.retryAfterS).toBe(600);
    expect(parsePackView(null).state).toBe("none");
  });

  it("a 429 carries Retry-After (clamped, defaulted when absent or odd)", async () => {
    expect(await client(() => json({}, 429, { "Retry-After": "120" })).pc.post("abcdef")).toEqual({ kind: "rate_limited", retryAfterS: 120 });
    expect(await client(() => json({}, 429, { "Retry-After": "99999" })).pc.post("abcdef")).toEqual({ kind: "rate_limited", retryAfterS: 3600 });
    expect(await client(() => json({}, 429)).pc.post("abcdef")).toEqual({ kind: "rate_limited", retryAfterS: 60 });
    expect(await client(() => json({}, 429, { "Retry-After": "soon" })).pc.post("abcdef")).toEqual({ kind: "rate_limited", retryAfterS: 60 });
  });

  it("404 is not_found; other failures, a non-JSON body and a network error are error", async () => {
    expect(await client(() => json({}, 404)).pc.get("abcdef")).toEqual({ kind: "not_found" });
    expect(await client(() => json({}, 500)).pc.get("abcdef")).toEqual({ kind: "error" });
    expect(await client(() => json({}, 403)).pc.post("abcdef")).toEqual({ kind: "error" });
    expect(await client(() => new Response("<html>", { status: 200 })).pc.get("abcdef")).toEqual({ kind: "error" });
    expect(await client(() => json([1, 2])).pc.get("abcdef")).toEqual({ kind: "error" });
    expect(await client(() => Promise.reject(new TypeError("offline"))).pc.get("abcdef")).toEqual({ kind: "error" });
  });

  it("times a request out (aborts it) and always clears its timer", async () => {
    const { pc, cleared, timers } = client((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const pending = pc.get("abcdef");
    await Promise.resolve();
    timers[0]?.();
    expect(await pending).toEqual({ kind: "error" });
    expect(cleared.length).toBe(1);
  });
});

describe("imagery URL seam", () => {
  it("the public page points the map pictures at the URLs its boot data gave, and the override can be dropped", () => {
    const before = textureUrl("satellite");
    setTextureUrls({ satellite: "/assets/sat.webp?v=1", atlas: "/assets/atlas.webp?v=2" });
    expect(textureUrl("satellite")).toBe("/assets/sat.webp?v=1");
    expect(textureUrl("atlas")).toBe("/assets/atlas.webp?v=2");
    setTextureUrls({});
    expect(textureUrl("satellite")).toBe(before);
  });
});
