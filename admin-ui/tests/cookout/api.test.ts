import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverFetch } = vi.hoisted(() => ({ serverFetch: vi.fn() }));
vi.mock("../../src/server/api/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/http")>()),
  serverFetch,
}));

import {
  allPicks,
  bankCookoutConcept,
  createCookout,
  formatMinutes,
  getCookout,
  getRecipeBook,
  parseCookoutSummary,
  parseCookoutView,
  parseFullRecipe,
  parseRecipeBook,
  pickCookout,
  retryCookoutRecipe,
  skipCookout,
} from "../../src/server/cookout/api";
import { ServerLockedError } from "../../src/server/api/http";
import { parseWyrRefKind } from "../../src/server/api/messages";
import { FULL_RECIPE, bankedRecipes, bookBody, finishedView, pickingView, picture, type Json } from "./fixtures";

// The Cookout wire parsers (spec/server-chat/09-cookout.md §4.2): every response is read defensively, a
// half-understood round is never drawn, and nothing the server leaves out (Blind mode) is invented.

const SESSION = { token: "tok", expiresAt: 9_999_999_999 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  serverFetch.mockReset();
});

describe("the message summary", () => {
  it("reads a well-formed summary", () => {
    expect(parseCookoutSummary({ state: "picking", blind: true, pickedCount: 4, concepts: "none", bankedCount: 0, rev: 3 })).toEqual({
      state: "picking",
      blind: true,
      pickedCount: 4,
      concepts: "none",
      bankedCount: 0,
      rev: 3,
    });
  });

  it("defaults unknown or out-of-range counts and states rather than trusting them", () => {
    const s = parseCookoutSummary({ state: "finished", blind: "yes", pickedCount: 99, concepts: "odd", bankedCount: -1, rev: 2 });
    expect(s).toEqual({ state: "finished", blind: false, pickedCount: 0, concepts: "none", bankedCount: 0, rev: 2 });
  });

  it("is null for anything that is not a summary", () => {
    expect(parseCookoutSummary(null)).toBeNull();
    expect(parseCookoutSummary(undefined)).toBeNull();
    expect(parseCookoutSummary([])).toBeNull();
    expect(parseCookoutSummary({ state: "cooking", rev: 1 })).toBeNull();
    expect(parseCookoutSummary({ state: "picking", rev: 0 })).toBeNull();
    expect(parseCookoutSummary({ state: "picking" })).toBeNull();
  });
});

describe("wyrRefKind", () => {
  it("knows the three games and nothing else", () => {
    expect(parseWyrRefKind("cookout")).toBe("cookout");
    expect(parseWyrRefKind("adventure")).toBe("adventure");
    expect(parseWyrRefKind("wyr")).toBe("wyr");
    expect(parseWyrRefKind("chess")).toBeNull();
    expect(parseWyrRefKind(null)).toBeNull();
    expect(parseWyrRefKind(undefined)).toBeNull();
  });
});

describe("the round view", () => {
  it("reads an Open round being picked: players, the turn, the pair and the staples", () => {
    const view = parseCookoutView(pickingView({ turn: 3, offerIndex: 1 }));
    expect(view).not.toBeNull();
    if (view === null) return;
    expect(view.state).toBe("picking");
    expect(view.players[0].name).toBe("Josh");
    expect(view.players[0].picks?.map((p) => p.id)).toEqual(["thick-white-toast"]);
    expect(view.players[1].picks?.map((p) => p.id)).toEqual(["ribeye-steak"]);
    expect(view.you).toEqual({ slot: 1 });
    expect(view.current).toMatchObject({ turn: 3, player: 1, role: "protein", offerIndex: 1, skipsRemaining: 1 });
    expect(view.current?.options?.map((o) => o.id)).toEqual(["ribeye-steak", "salmon-fillet"]);
    expect(view.staples).toHaveLength(8);
  });

  it("reads a Blind round as the partner sees it: no pair, no role, the partner's picks only counted", () => {
    const view = parseCookoutView(pickingView({ blind: true, you: 1, turn: 4, showOptions: false, p2Picks: null, p2Count: 1 }));
    expect(view?.blind).toBe(true);
    expect(view?.current).toMatchObject({ turn: 4, player: 2, role: null, options: null, offerIndex: null, skipsRemaining: null });
    expect(view?.players[1].picks).toBeNull();
    expect(view?.players[1].pickCount).toBe(1);
  });

  it("reads Slot 2 unbound and the wait for Join", () => {
    const view = parseCookoutView(pickingView({ player2: null, turn: 2, showOptions: false, waitingForJoin: true }));
    expect(view?.players[1].name).toBeNull();
    expect(view?.current?.waitingForJoin).toBe(true);
  });

  it("refuses a round being picked with no readable turn, or a turn on the wrong player's parity", () => {
    expect(parseCookoutView({ ...pickingView(), current: null })).toBeNull();
    const wrong = pickingView({ turn: 3 });
    (wrong["current"] as Json)["player"] = 2;
    expect(parseCookoutView(wrong)).toBeNull();
  });

  it("refuses a pair without the offer it belongs to, a pair of one item twice, or a broken basket", () => {
    const noOffer = pickingView();
    (noOffer["current"] as Json)["offerIndex"] = null;
    expect(parseCookoutView(noOffer)).toBeNull();
    const twin = pickingView();
    const options = (twin["current"] as Json)["options"] as Json[];
    (twin["current"] as Json)["options"] = [options[0], options[0]];
    expect(parseCookoutView(twin)).toBeNull();
    const broken = pickingView({ turn: 3 });
    ((broken["players"] as Json[])[0] as Json)["picks"] = [{ id: "BAD ID", name: "x" }];
    expect(parseCookoutView(broken)).toBeNull();
  });

  it("refuses anything that is not two players in slot order", () => {
    const one = pickingView();
    one["players"] = [(one["players"] as Json[])[0]];
    expect(parseCookoutView(one)).toBeNull();
    const swapped = pickingView();
    swapped["players"] = [...(swapped["players"] as Json[])].reverse();
    expect(parseCookoutView(swapped)).toBeNull();
  });

  it("reads a finished round: all ten revealed, three concepts in a/b/c order, pictures and recipes", () => {
    const raw = finishedView({ images: "pending", pictures: { a: picture(1) }, recipes: bankedRecipes("b") });
    (raw["concepts"] as Json)["data"] = [...((raw["concepts"] as Json)["data"] as Json[])].reverse();
    const view = parseCookoutView(raw);
    expect(view?.revealed).toBe(true);
    expect(view === null ? [] : allPicks(view)).toHaveLength(10);
    expect(view?.current).toBeNull();
    expect(view?.concepts.data?.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(view?.concepts.data?.[0]?.omitted[0]?.ingredient.id).toBe("tinned-baked-beans");
    expect(view?.images.pictures.a?.thumbUrl).toBe("/api/admin/server/media/thumb-1.jpg");
    expect(view?.images.pictures.b).toBeNull();
    expect(view?.recipes.b.state).toBe("banked");
    expect(view?.recipes.b.data?.totalMinutes).toBe(35);
    expect(view?.recipes.a.state).toBe("none");
  });

  it("never keeps a dish picture that is not on this server", () => {
    const raw = finishedView({ pictures: { a: { attachmentId: "x", thumbUrl: "https://evil.example/p.jpg", fullUrl: "//evil.example/p.jpg" } } });
    expect(parseCookoutView(raw)?.images.pictures.a).toBeNull();
  });

  it("reads 'banked' with no readable recipe as not finished, so the card offers Try again", () => {
    const recipes = bankedRecipes("a");
    (recipes["a"] as Json)["data"] = { serves: 2 };
    expect(parseCookoutView(finishedView({ recipes }))?.recipes.a.state).toBe("failed");
  });

  it("drops a malformed concept but keeps the good ones", () => {
    const raw = finishedView();
    const data = (raw["concepts"] as Json)["data"] as Json[];
    (raw["concepts"] as Json)["data"] = [data[0], { id: "z", title: "Nope" }, data[2]];
    expect(parseCookoutView(raw)?.concepts.data?.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("is null for something that is not a round", () => {
    expect(parseCookoutView(null)).toBeNull();
    expect(parseCookoutView({ seq: 1 })).toBeNull();
    expect(parseCookoutView({ ...pickingView(), state: "cooking" })).toBeNull();
  });
});

describe("the full recipe", () => {
  it("reads the recipe and works out the total when the server leaves it out", () => {
    const { totalMinutes: _omit, ...rest } = FULL_RECIPE;
    const recipe = parseFullRecipe(rest);
    expect(recipe?.totalMinutes).toBe(35);
    expect(recipe?.ingredients[0]).toEqual({ id: "ribeye-steak", name: null, quantity: "2 steaks (approx. 220g each)", note: "room temperature" });
    expect(recipe?.steps[2]?.minutes).toBeNull();
    expect(recipe?.tips).toHaveLength(1);
  });

  it("is null without ingredients or steps", () => {
    expect(parseFullRecipe({ ...FULL_RECIPE, steps: [] })).toBeNull();
    expect(parseFullRecipe({ ...FULL_RECIPE, ingredients: [] })).toBeNull();
  });
});

describe("the Recipe book", () => {
  it("reads the entries newest first as sent, skipping malformed ones", () => {
    const body = bookBody();
    (body["recipes"] as Json[]).push({ seq: 3, conceptId: "q", title: "bad" });
    const recipes = parseRecipeBook(body);
    expect(recipes?.map((r) => [r.seq, r.conceptId])).toEqual([
      [41, "a"],
      [30, "c"],
    ]);
    expect(recipes?.[0]?.picture?.thumbUrl).toBe("/api/admin/server/media/thumb-1.jpg");
    expect(recipes?.[1]?.picture).toBeNull();
    expect(recipes?.[1]?.totalMinutes).toBe(80);
  });

  it("GET /cookout/bank: ok, unavailable, lock", async () => {
    serverFetch.mockResolvedValueOnce(json(bookBody()));
    const ok = await getRecipeBook(SESSION);
    expect(ok.ok && ok.recipes.length).toBe(2);
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/cookout/bank");
    serverFetch.mockResolvedValueOnce(json({}, 500));
    expect(await getRecipeBook(SESSION)).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockRejectedValueOnce(new ServerLockedError());
    await expect(getRecipeBook(SESSION)).rejects.toBeInstanceOf(ServerLockedError);
  });
});

describe("the calls", () => {
  it("GET asks as the viewer", async () => {
    serverFetch.mockResolvedValueOnce(json(pickingView()));
    const outcome = await getCookout(SESSION, 41, "Cupcake & co");
    expect(outcome.ok).toBe(true);
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/cookout/41?as=Cupcake%20%26%20co");
  });

  it("maps the server's conflicts to their own kinds", async () => {
    for (const error of ["not_your_turn", "not_player", "skip_exhausted", "exhausted", "bad_state"]) {
      serverFetch.mockResolvedValueOnce(json({ error }, 409));
      expect(await skipCookout(SESSION, 41, { sender: "Josh", moveId: "m1", turn: 1, offer: 0 })).toEqual({ ok: false, kind: error });
    }
    serverFetch.mockResolvedValueOnce(json({ error: "mystery" }, 409));
    expect(await skipCookout(SESSION, 41, { sender: "Josh", moveId: "m1", turn: 1, offer: 0 })).toEqual({ ok: false, kind: "bad_state" });
    serverFetch.mockResolvedValueOnce(json({}, 404));
    expect((await getCookout(SESSION, 41, "Josh")).ok).toBe(false);
    serverFetch.mockResolvedValueOnce(json({}, 422));
    expect(await getCookout(SESSION, 41, "Josh")).toEqual({ ok: false, kind: "invalid" });
    serverFetch.mockResolvedValueOnce(json({}, 503));
    expect(await getCookout(SESSION, 41, "Josh")).toEqual({ ok: false, kind: "game_unavailable" });
  });

  it("a body that is not a round, or a network failure, is 'unavailable'; a lock is thrown", async () => {
    serverFetch.mockResolvedValueOnce(json({ seq: "x" }));
    expect(await getCookout(SESSION, 41, "Josh")).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockRejectedValueOnce(new TypeError("offline"));
    expect(await getCookout(SESSION, 41, "Josh")).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockRejectedValueOnce(new ServerLockedError());
    await expect(getCookout(SESSION, 41, "Josh")).rejects.toBeInstanceOf(ServerLockedError);
  });

  it("sends a pick, a bank and a recipe retry to their routes with their bodies", async () => {
    serverFetch.mockResolvedValue(json(finishedView()));
    await pickCookout(SESSION, 41, { sender: "Josh", moveId: "m2", turn: 10, offer: 2, ingredientId: "white-miso" });
    await bankCookoutConcept(SESSION, 41, "b", { sender: "Josh", moveId: "m3" });
    await retryCookoutRecipe(SESSION, 41, "c", { sender: "Josh" });
    const calls = serverFetch.mock.calls.map((c) => [c[0], JSON.parse(String((c[1] as RequestInit).body))]);
    expect(calls).toEqual([
      ["/cookout/41/pick", { sender: "Josh", moveId: "m2", turn: 10, offer: 2, ingredientId: "white-miso" }],
      ["/cookout/41/concepts/b/bank", { sender: "Josh", moveId: "m3" }],
      ["/cookout/41/concepts/c/recipe/retry", { sender: "Josh" }],
    ]);
  });

  it("POST /cookout: created, replayed, unsupported, unavailable", async () => {
    const message = { seq: 41, sender: "Josh", text: null, attachments: [], reactions: [], createdAt: 1, replyTo: null };
    serverFetch.mockResolvedValueOnce(json({ message }, 201));
    const created = await createCookout(SESSION, { clientId: "c1", sender: "Josh", deviceId: "d", blind: true });
    expect(created.ok && created.message.seq).toBe(41);
    expect(JSON.parse(String((serverFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      clientId: "c1",
      sender: "Josh",
      deviceId: "d",
      blind: true,
    });
    serverFetch.mockResolvedValueOnce(json({ message }, 200));
    expect((await createCookout(SESSION, { clientId: "c1", sender: "Josh", deviceId: "d", blind: true })).ok).toBe(true);
    serverFetch.mockResolvedValueOnce(json({}, 404));
    expect(await createCookout(SESSION, { clientId: "c2", sender: "Josh", deviceId: "d", blind: false })).toEqual({
      ok: false,
      kind: "unsupported",
    });
    serverFetch.mockResolvedValueOnce(json({}, 503));
    expect((await createCookout(SESSION, { clientId: "c3", sender: "Josh", deviceId: "d", blind: false })).ok).toBe(false);
  });
});

describe("helpers", () => {
  it("formats minutes the way a recipe card says them", () => {
    expect(formatMinutes(35)).toBe("35 min");
    expect(formatMinutes(60)).toBe("1 hr");
    expect(formatMinutes(80)).toBe("1 hr 20 min");
  });
});
