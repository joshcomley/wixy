import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverFetch } = vi.hoisted(() => ({ serverFetch: vi.fn() }));
vi.mock("../../src/server/api/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/http")>()),
  serverFetch,
}));

import {
  createAdventure,
  decideAdventure,
  firstDishPicture,
  getAdventure,
  getAdventureBank,
  getAdventureSettings,
  parseAdventureLiveFrame,
  parseAdventureSummary,
  parseAdventureView,
  parseBank,
  parsePack,
  pictureKey,
  postAdventureLive,
  putAdventureSettings,
  retryAdventurePack,
  safeLink,
  sameOriginMediaUrl,
  spinAdventure,
  stopAdventure,
} from "../../src/server/adventure/api";
import { ServerLockedError } from "../../src/server/api/http";
import { mapSseEvent } from "../../src/server/stream";
import { NOW, dishesPack, readyPack, spin, view, wire } from "./adventureFixtures";

const SESSION = { token: "tok", expiresAt: 9_999_999_999 };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

beforeEach(() => {
  serverFetch.mockReset();
});

describe("the message summary", () => {
  it("reads a well-formed summary and defaults an unknown pack state to none", () => {
    expect(parseAdventureSummary({ state: "chosen", pack: "pending", rev: 4 })).toEqual({ state: "chosen", pack: "pending", rev: 4 });
    expect(parseAdventureSummary({ state: "chosen", pack: "weird", rev: 4 })?.pack).toBe("none");
  });

  it("is null for anything that is not a summary", () => {
    for (const bad of [null, "x", [], {}, { state: "nope", pack: "none", rev: 1 }, { state: "chosen", pack: "none", rev: 0 }, { state: "chosen", pack: "none", rev: 1.5 }]) {
      expect(parseAdventureSummary(bad)).toBeNull();
    }
  });
});

describe("the round view", () => {
  it("round-trips a view in every state of the round's life", () => {
    for (const state of ["spin_lng", "spin_lat", "country", "destination", "chosen", "banked", "rejected", "abandoned"] as const) {
      const v = view(state);
      const parsed = parseAdventureView(wire(v));
      expect(parsed, state).not.toBeNull();
      expect(parsed?.state).toBe(state);
      expect(parsed?.seq).toBe(7);
      expect(parsed?.spins.lng?.delta ?? null).toBe(v.spins.lng?.delta ?? null);
      expect(parsed?.destination?.chosen?.id ?? null).toBe(v.destination?.chosen?.id ?? null);
    }
  });

  it("keeps the numbers the animation depends on exactly as sent", () => {
    const v = parseAdventureView(wire(view("country", { lat: spin("Bea", -15.5, -900.25, 4321, NOW - 3.25) })));
    expect(v?.spins.lat).toEqual({ by: "Bea", from: -15.5, delta: -900.25, durationMs: 4321, at: NOW - 3.25 });
    expect(v?.country?.rouletteAt).toBe(NOW + 5);
    expect(v?.country?.seed).toBe(12345);
    expect(v?.serverNow).toBe(NOW);
  });

  it("refuses a view that claims a stage whose data is missing or broken", () => {
    const broken = (patch: (w: Record<string, unknown>) => void, state: Parameters<typeof view>[0]): void => {
      const w = wire(view(state));
      patch(w);
      expect(parseAdventureView(w), `${state} ${patch.toString()}`).toBeNull();
    };
    broken((w) => ((w["spins"] as Record<string, unknown>)["lng"] = null), "spin_lat");
    broken((w) => (w["landing"] = null), "country");
    broken((w) => (w["country"] = null), "country");
    broken((w) => ((w["country"] as Record<string, unknown>)["seed"] = -1), "country");
    broken((w) => ((w["country"] as Record<string, unknown>)["candidates"] = [{ id: "AAA" }, 5]), "country");
    broken((w) => (w["destination"] = null), "chosen");
    broken((w) => ((w["destination"] as Record<string, unknown>)["chosen"] = null), "banked");
    broken((w) => ((w["destination"] as Record<string, unknown>)["seed"] = null), "destination");
    broken((w) => (w["serverNow"] = "later"), "spin_lng");
    broken((w) => (w["rev"] = 0), "spin_lng");
    broken((w) => (w["seq"] = -2), "spin_lng");
    broken((w) => (w["state"] = "wat"), "spin_lng");
  });

  it("drops a spin that could freeze the animation loop", () => {
    for (const patch of [{ delta: Number.POSITIVE_INFINITY }, { delta: 0 }, { delta: 1e9 }, { durationMs: 0 }, { durationMs: 1e9 }, { from: 1e12 }]) {
      const w = wire(view("spin_lat"));
      (w["spins"] as Record<string, Record<string, unknown>>)["lng"] = { ...(w["spins"] as Record<string, Record<string, unknown>>)["lng"], ...patch };
      // JSON has no Infinity: a string stands in for any non-number
      expect(parseAdventureView(JSON.parse(JSON.stringify(w))), JSON.stringify(patch)).toBeNull();
    }
  });

  it("requires a destination's seed and start time together (both or neither)", () => {
    const w = wire(view("chosen"));
    (w["destination"] as Record<string, unknown>)["rouletteAt"] = null; // seed still set
    expect(parseAdventureView(w)).toBeNull();
    const single = wire(view("chosen"));
    (single["destination"] as Record<string, unknown>)["rouletteAt"] = null;
    (single["destination"] as Record<string, unknown>)["seed"] = null; // the one-place-left case
    expect(parseAdventureView(single)?.destination?.seed).toBeNull();
  });

  it("lists eligible units only while spinning", () => {
    expect(parseAdventureView(wire(view("spin_lng")))?.eligible).toEqual(["AAA", "BBB", "CCC"]);
    expect(parseAdventureView(wire(view("country")))?.eligible).toBeNull();
  });

  it("tolerates an older server's pack block (no images, no pictures)", () => {
    const parsed = parseAdventureView(wire(view("chosen", { pack: readyPack() })));
    expect(parsed?.pack.state).toBe("ready");
    expect(parsed?.pack.images).toBe("none");
    expect(parsed?.pack.pictures).toBeNull();
    expect(parsed?.pack.data?.headline).toBe("Sun and tiles");
  });
});

describe("links and pictures", () => {
  it("keeps only plain http(s) links with a host", () => {
    expect(safeLink("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeLink("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com", "//example.com", "example.com", "", null, 5, "https://", "x".repeat(700)]) {
      expect(safeLink(bad), String(bad)).toBeNull();
    }
  });

  it("drops a pack link that is not http(s), but keeps the item", () => {
    const pack = parsePack({
      headline: "H",
      summary: "S",
      sections: [{ key: "food", title: "Food", items: [{ name: "Tarts", detail: "d", url: "javascript:alert(1)" }, { name: "Fish", detail: "e", url: "https://example.com/f" }] }],
      sources: [{ title: "bad", url: "javascript:1" }, { title: "ok", url: "https://example.com/s" }],
    });
    expect(pack?.sections[0]?.items.map((i) => i.url)).toEqual([null, "https://example.com/f"]);
    expect(pack?.sources).toEqual([{ title: "ok", url: "https://example.com/s" }]);
  });

  it("keeps each item's index in the server's list when an earlier item is unusable", () => {
    const pack = parsePack({
      headline: "H",
      sections: [{ key: "food", title: "Food", items: [{ name: "", detail: "x" }, { name: "Second" }, 7, { name: "Fourth" }] }],
    });
    const section = pack?.sections[0];
    expect(section?.items.map((i) => i.index)).toEqual([1, 3]);
    expect(section && section.items[0] ? pictureKey(section, section.items[0]) : "").toBe("food:1");
  });

  it("is not a pack when nothing in it can be shown", () => {
    expect(parsePack({})).toBeNull();
    expect(parsePack("x")).toBeNull();
    expect(parsePack({ headline: "H" })?.sections).toEqual([]);
  });

  it("only ever lets a picture come from THIS origin", () => {
    expect(sameOriginMediaUrl("/api/admin/server/media/a.jpg?sig=1")).toBe("/api/admin/server/media/a.jpg?sig=1");
    expect(sameOriginMediaUrl(`${window.location.origin}/api/x.jpg`)).toBe(`${window.location.origin}/api/x.jpg`);
    for (const bad of ["//evil.example/x.jpg", "https://evil.example/x.jpg", "http://upload.wikimedia.org/x.jpg", "javascript:1", "data:image/png;base64,AA", "\\\\evil\\x", "/ok\\evil", "", 5, null]) {
      expect(sameOriginMediaUrl(bad), String(bad)).toBeNull();
    }
  });

  it("parses the pack's pictures and drops any whose URL is not ours", () => {
    const w = wire(view("chosen", { pack: readyPack() }));
    (w["pack"] as Record<string, unknown>)["images"] = "pending";
    (w["pack"] as Record<string, unknown>)["pictures"] = {
      hero: [
        { thumbUrl: "/m/h1-t.jpg", fullUrl: "/m/h1.jpg", credit: "Ann / CC BY", page: "https://commons.example/h1", caption: "The bay" },
        { thumbUrl: "https://evil.example/t.jpg", fullUrl: "https://evil.example/f.jpg", credit: "x" },
        "nope",
      ],
      items: { "food:0": { thumbUrl: "/m/i0-t.jpg", fullUrl: "/m/i0.jpg", credit: "Bob" }, "bad key": { thumbUrl: "/m/z.jpg", fullUrl: "/m/z.jpg" }, "food:1": { fullUrl: "https://evil.example/z.jpg" } },
    };
    const pack = parseAdventureView(w)?.pack;
    expect(pack?.images).toBe("pending");
    expect(pack?.pictures?.hero).toEqual([{ thumbUrl: "/m/h1-t.jpg", fullUrl: "/m/h1.jpg", credit: "Ann / CC BY", page: "https://commons.example/h1", caption: "The bay" }]);
    expect([...(pack?.pictures?.items.keys() ?? [])]).toEqual(["food:0"]);
    expect(pack?.pictures?.items.get("food:0")?.page).toBeNull();
  });
});

describe("calls", () => {
  it("starts a round: 201 and 200 give the message; 404/405 say unsupported; 503 says unavailable game", async () => {
    const message = { seq: 3, clientId: "c", sender: "Ann" };
    serverFetch.mockResolvedValueOnce(json({ message }, 201));
    expect(await createAdventure(SESSION, { clientId: "cid-0001", sender: "Ann", deviceId: "dev-00001" })).toEqual({ ok: true, message });
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/adventure");
    expect(JSON.parse(String((serverFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ clientId: "cid-0001", sender: "Ann", deviceId: "dev-00001" });
    serverFetch.mockResolvedValueOnce(json({ message }, 200));
    expect((await createAdventure(SESSION, { clientId: "cid-0001", sender: "Ann", deviceId: "dev-00001" })).ok).toBe(true);
    serverFetch.mockResolvedValueOnce(json({}, 404));
    expect(await createAdventure(SESSION, { clientId: "c1234567", sender: "A", deviceId: "d1234567" })).toEqual({ ok: false, kind: "unsupported" });
    serverFetch.mockResolvedValueOnce(json({}, 405));
    expect(await createAdventure(SESSION, { clientId: "c1234567", sender: "A", deviceId: "d1234567" })).toEqual({ ok: false, kind: "unsupported" });
    serverFetch.mockResolvedValueOnce(json({ error: "game_unavailable" }, 503));
    expect(await createAdventure(SESSION, { clientId: "c1234567", sender: "A", deviceId: "d1234567" })).toEqual({ ok: false, kind: "game_unavailable" });
    serverFetch.mockResolvedValueOnce(json({ message: 5 }, 201));
    expect(await createAdventure(SESSION, { clientId: "c1234567", sender: "A", deviceId: "d1234567" })).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await createAdventure(SESSION, { clientId: "c1234567", sender: "A", deviceId: "d1234567" })).toEqual({ ok: false, kind: "unavailable" });
  });

  it("rethrows a lock (401) from every call instead of treating it as unavailable", async () => {
    serverFetch.mockImplementation(() => {
      const rejected = Promise.reject(new ServerLockedError());
      rejected.catch(() => {}); // the mock keeps the promise it returned: nobody else handles it
      return rejected;
    });
    const locked = async (call: () => Promise<unknown>): Promise<boolean> => {
      try {
        await call();
        return false;
      } catch (error) {
        return error instanceof ServerLockedError;
      }
    };
    expect(await locked(() => createAdventure(SESSION, { clientId: "c1234567", sender: "A", deviceId: "d1234567" }))).toBe(true);
    expect(await locked(() => getAdventure(SESSION, 7))).toBe(true);
    expect(await locked(() => spinAdventure(SESSION, 7, { sender: "A", axis: "lng", from: 0, delta: 900, durationMs: 4000 }))).toBe(true);
    expect(await locked(() => getAdventureBank(SESSION))).toBe(true);
    expect(await locked(() => getAdventureSettings(SESSION))).toBe(true);
    expect(await locked(() => putAdventureSettings(SESSION, true))).toBe(true);
    expect(await locked(() => postAdventureLive(SESSION, { anchorSeq: 7, clientId: "drag-0001", axis: "lng", rotation: [0, 0], points: [], frame: 0, end: false }))).toBe(true);
  });

  it("reads a view, and maps the status codes to the failure the pane acts on", async () => {
    serverFetch.mockResolvedValueOnce(json(wire(view("spin_lng"))));
    const ok = await getAdventure(SESSION, 7);
    expect(ok.ok && ok.view.state).toBe("spin_lng");
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/adventure/7");
    serverFetch.mockResolvedValueOnce(json({ error: "not_found" }, 404));
    expect(await getAdventure(SESSION, 7)).toEqual({ ok: false, kind: "not_found" });
    for (const [error, kind] of [["bad_state", "bad_state"], ["too_early", "too_early"], ["exhausted", "exhausted"], ["unknown", "bad_state"]] as const) {
      serverFetch.mockResolvedValueOnce(json({ error }, 409));
      expect(await getAdventure(SESSION, 7), error).toEqual({ ok: false, kind });
    }
    serverFetch.mockResolvedValueOnce(json({ error: "invalid" }, 422));
    expect(await getAdventure(SESSION, 7)).toEqual({ ok: false, kind: "invalid" });
    serverFetch.mockResolvedValueOnce(json({}, 500));
    expect(await getAdventure(SESSION, 7)).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockResolvedValueOnce(json({ rubbish: true }, 200));
    expect(await getAdventure(SESSION, 7)).toEqual({ ok: false, kind: "unavailable" });
  });

  it("posts a lng spin with no result and a lat spin with the landing, as the server wants them", async () => {
    serverFetch.mockResolvedValue(json(wire(view("spin_lat"))));
    await spinAdventure(SESSION, 7, { sender: "Ann", axis: "lng", from: 10, delta: 900, durationMs: 4000 });
    const lng = JSON.parse(String((serverFetch.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/adventure/7/spin");
    expect(lng).toEqual({ sender: "Ann", axis: "lng", from: 10, delta: 900, durationMs: 4000 });
    await spinAdventure(SESSION, 7, {
      sender: "Bea",
      axis: "lat",
      from: -15,
      delta: -800,
      durationMs: 5000,
      result: { point: [5, 5], sea: true, land: [6, 5], centre: [7, 5], landUnit: "AAA", candidates: ["AAA", "BBB"] },
    });
    const lat = JSON.parse(String((serverFetch.mock.calls[1]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(lat["result"]).toEqual({ point: [5, 5], sea: true, land: [6, 5], centre: [7, 5], landUnit: "AAA", candidates: ["AAA", "BBB"] });
  });

  it("posts Stop, decide and the pack retry to their routes", async () => {
    serverFetch.mockResolvedValue(json(wire(view("destination"))));
    await stopAdventure(SESSION, 7, { sender: "Ann", stage: "country", choice: "AAA" });
    await decideAdventure(SESSION, 7, { sender: "Ann", decision: "bank" });
    await retryAdventurePack(SESSION, 7, { sender: "Ann" });
    expect(serverFetch.mock.calls.map((c) => c[0])).toEqual(["/adventure/7/stop", "/adventure/7/decide", "/adventure/7/pack/retry"]);
    expect(JSON.parse(String((serverFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ sender: "Ann", stage: "country", choice: "AAA" });
    expect(JSON.parse(String((serverFetch.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ sender: "Ann", decision: "bank" });
  });

  it("reads the Holiday bank, skipping entries that are not trips", async () => {
    const good = { seq: 9, unitId: "PRT", unitName: "Portugal", destination: { id: "PRT.lisbon", name: "Lisbon", region: "Lisbon", lat: 38.7, lng: -9.1, kind: "city", blurb: "Hilltop city." }, headline: "Tiles", pack: "ready" };
    serverFetch.mockResolvedValueOnce(json({ trips: [good, { seq: "x" }, null, { ...good, seq: 10, headline: "", pack: "weird", destination: { ...good.destination, id: "PRT.porto", name: "Porto" } }] }));
    const result = await getAdventureBank(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trips.map((t) => [t.seq, t.destination.name, t.headline, t.pack])).toEqual([[9, "Lisbon", "Tiles", "ready"], [10, "Porto", null, "none"]]);
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/adventure/bank");
    serverFetch.mockResolvedValueOnce(json({ trips: "no" }));
    expect(await getAdventureBank(SESSION)).toEqual({ ok: false, kind: "unavailable" });
    expect(parseBank(null)).toBeNull();
  });

  it("reads and writes the shared settings", async () => {
    serverFetch.mockResolvedValueOnce(json({ includeAdvised: false, advisedUnits: [{ id: "AFG", name: "Afghanistan" }, { nope: 1 }] }));
    const got = await getAdventureSettings(SESSION);
    expect(got).toEqual({ ok: true, settings: { includeAdvised: false, advisedUnits: [{ id: "AFG", name: "Afghanistan" }] } });
    serverFetch.mockResolvedValueOnce(json({ includeAdvised: true, advisedUnits: [] }));
    const put = await putAdventureSettings(SESSION, true);
    expect(put.ok && put.settings.includeAdvised).toBe(true);
    const init = serverFetch.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ includeAdvised: true });
    serverFetch.mockResolvedValueOnce(json({ includeAdvised: "yes" }));
    expect(await getAdventureSettings(SESSION)).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockResolvedValueOnce(json({}, 500));
    expect(await putAdventureSettings(SESSION, false)).toEqual({ ok: false, kind: "unavailable" });
  });
});

describe("the live swipe frame", () => {
  const frame = { anchorSeq: 7, clientId: "drag-0001", axis: "lng", rotation: [12.5, -15], points: [[0.1, -0.2, 0], [0.3, -0.2, 16]], frame: 3, end: false };

  it("reads a valid frame", () => {
    expect(parseAdventureLiveFrame(frame)).toEqual({ ...frame, end: false });
    expect(parseAdventureLiveFrame({ ...frame, end: true, points: [] })?.end).toBe(true);
  });

  it("refuses anything outside the server's own bounds", () => {
    const bad = (patch: Record<string, unknown>): void => expect(parseAdventureLiveFrame({ ...frame, ...patch }), JSON.stringify(patch)).toBeNull();
    bad({ anchorSeq: 0 });
    bad({ clientId: "short" });
    bad({ clientId: "x".repeat(65) });
    bad({ axis: "diag" });
    bad({ rotation: [1] });
    bad({ rotation: [1e9, 0] });
    bad({ rotation: ["a", 0] });
    bad({ frame: -1 });
    bad({ frame: 1.5 });
    bad({ points: Array.from({ length: 33 }, () => [0, 0, 0]) });
    bad({ points: [[4, 0, 0]] });
    bad({ points: [[0, -4, 0]] });
    bad({ points: [[0, 0, -1]] });
    bad({ points: [[0, 0, 600_001]] });
    bad({ points: [[0, 0]] });
    expect(parseAdventureLiveFrame(null)).toBeNull();
    expect(parseAdventureLiveFrame([])).toBeNull();
  });

  it("is mapped from the stream's `adventure_live` event, and a malformed one is skipped", () => {
    const event = mapSseEvent({ id: null, event: "adventure_live", data: JSON.stringify(frame) });
    expect(event?.type).toBe("adventure_live");
    expect(mapSseEvent({ id: null, event: "adventure_live", data: JSON.stringify({ ...frame, axis: "x" }) })).toBeNull();
    expect(mapSseEvent({ id: null, event: "adventure_live", data: "{not json" })).toBeNull();
  });

  it("posts a frame, asking nothing back, and reads a 429's Retry-After", async () => {
    serverFetch.mockResolvedValueOnce(json({ ok: true }));
    const live = { anchorSeq: 7, clientId: "drag-0001", axis: "lat", rotation: [1, 2], points: [[0.5, 0.5, 3]], frame: 0, end: true } as const;
    expect(await postAdventureLive(SESSION, live)).toEqual({ kind: "ok" });
    const sent = JSON.parse(String((serverFetch.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/adventure/live");
    expect(sent).toEqual({ anchorSeq: 7, clientId: "drag-0001", axis: "lat", rotation: [1, 2], points: [[0.5, 0.5, 3]], frame: 0, end: true });
    serverFetch.mockResolvedValueOnce(json({ error: "rate_limited", retryAfterS: 2 }, 429));
    expect(await postAdventureLive(SESSION, live)).toEqual({ kind: "rate_limited", retryAfterMs: 2000 });
    serverFetch.mockResolvedValueOnce(json({}, 429, { "Retry-After": "99" }));
    expect(await postAdventureLive(SESSION, live)).toEqual({ kind: "rate_limited", retryAfterMs: 10_000 }); // capped
    serverFetch.mockResolvedValueOnce(json({}, 422));
    expect(await postAdventureLive(SESSION, live)).toEqual({ kind: "failed" });
    serverFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await postAdventureLive(SESSION, live)).toEqual({ kind: "failed" });
    // `end` is left off a frame that is not the last.
    serverFetch.mockResolvedValueOnce(json({ ok: true }));
    await postAdventureLive(SESSION, { ...live, end: false });
    expect(Object.keys(JSON.parse(String((serverFetch.mock.calls[5]?.[1] as RequestInit).body)) as object)).not.toContain("end");
  });
});

describe("the dishes section (spec 4.3b)", () => {
  const wireDishes = (): Record<string, unknown> => {
    const w = wire(view("chosen", { pack: dishesPack() }));
    return w;
  };

  it("reads a pack whose first section is the dishes, with their indexes, and tolerates the `wikipedia` key and unknown keys", () => {
    const w = wireDishes();
    const data = (w["pack"] as Record<string, Record<string, unknown>>)["data"]!;
    const sections = data["sections"] as Array<Record<string, unknown>>;
    sections[0]!["items"] = (sections[0]!["items"] as Array<Record<string, unknown>>).map((item, i) => ({ ...item, wikipedia: i === 0 ? "Pastel de nata" : null, futureKey: { x: 1 } }));
    data["futureTopLevel"] = true;
    const pack = parseAdventureView(w)?.pack;
    expect(pack?.data?.sections[0]?.key).toBe("dishes");
    expect(pack?.data?.sections[0]?.title).toBe("Local food to try");
    expect(pack?.data?.sections[0]?.items.map((i) => [i.index, i.name])).toEqual([[0, "Pastel de nata"], [1, "Caldo verde"], [2, "Bacalhau com natas"], [3, "Ginjinha"], [4, "Bifana"]]);
    expect(pack?.data?.sections[1]?.key).toBe("food");
  });

  it("reads the dish pictures keyed dishes:0..dishes:5, only from this origin", () => {
    const w = wireDishes();
    (w["pack"] as Record<string, unknown>)["images"] = "pending";
    (w["pack"] as Record<string, unknown>)["pictures"] = {
      hero: [],
      items: {
        "dishes:0": { thumbUrl: "/m/d0-t.jpg", fullUrl: "/m/d0.jpg", credit: "Ann, CC BY-SA 4.0", page: "https://commons.example/d0", caption: "Pastel de nata" },
        "dishes:5": { thumbUrl: "/m/d5-t.jpg", fullUrl: "/m/d5.jpg", credit: "Bob" },
        "dishes:2": { thumbUrl: "https://evil.example/d2.jpg", fullUrl: "https://evil.example/d2.jpg", credit: "x" },
      },
    };
    const pack = parseAdventureView(w)?.pack;
    expect([...(pack?.pictures?.items.keys() ?? [])]).toEqual(["dishes:0", "dishes:5"]);
    expect(pack?.pictures?.items.get("dishes:0")).toMatchObject({ thumbUrl: "/m/d0-t.jpg", credit: "Ann, CC BY-SA 4.0" });
  });

  it("the first dish photo is the lowest-indexed dish that has one, and nothing else's", () => {
    const base = dishesPack();
    const withPictures = (items: Record<string, string>): typeof base => ({
      ...base,
      pictures: {
        hero: [{ thumbUrl: "/m/hero-t.jpg", fullUrl: "/m/hero.jpg", credit: "", page: null, caption: "" }],
        items: new Map(Object.entries(items).map(([key, name]) => [key, { thumbUrl: `/m/${name}-t.jpg`, fullUrl: `/m/${name}.jpg`, credit: "", page: null, caption: "" }])),
      },
    });
    expect(firstDishPicture(withPictures({ "dishes:3": "gin", "dishes:1": "caldo" }))?.thumbUrl).toBe("/m/caldo-t.jpg");
    expect(firstDishPicture(withPictures({ "food:0": "tarts", "sights:0": "tower" }))).toBeNull(); // another section's photo is not a dish
    expect(firstDishPicture(withPictures({}))).toBeNull(); // the hero is not a dish
    expect(firstDishPicture({ ...base, pictures: null })).toBeNull();
    expect(firstDishPicture(readyPack())).toBeNull(); // no dishes section
    expect(firstDishPicture({ ...base, data: null })).toBeNull();
  });
});
