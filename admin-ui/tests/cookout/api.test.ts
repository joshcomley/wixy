import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverFetch } = vi.hoisted(() => ({ serverFetch: vi.fn() }));
vi.mock("../../src/server/api/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/http")>()),
  serverFetch,
}));

import {
  ALL_TWISTS,
  CLASSIC_MODE,
  CLASSIC_OPTION,
  allPicks,
  parseBuild,
  parseCookoutOptions,
  parseModeInfo,
  parseModeOptions,
  parsePickSnap,
  searchIngredients,
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
import { FULL_RECIPE, LENTILS, RIBEYE, SALMON, bankedRecipes, bookBody, finishedView, pickingView, picture, type Json } from "./fixtures";
import {
  ALL_TWIST_IDS,
  SOURDOUGH,
  TOASTIE_INTRO,
  TOASTIE_MODE,
  classicOptionWire,
  modeBookBody,
  optionsBody,
  toastieConcept,
  toastieFinished,
  toastieOption,
  toastiePicking,
} from "./modeFixtures";

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
      // A summary without a mode is a Classic round's (09c §5.4).
      mode: "classic",
      blind: true,
      pickedCount: 4,
      concepts: "none",
      bankedCount: 0,
      rev: 3,
      // A core-era summary reads as the twists' "off" values.
      generation: 1,
      waiting: [],
      swap: "none",
      dinnerDecided: false,
      cookedCount: 0,
    });
  });

  it("defaults unknown or out-of-range counts and states rather than trusting them", () => {
    const s = parseCookoutSummary({ state: "finished", blind: "yes", pickedCount: 99, concepts: "odd", bankedCount: -1, rev: 2 });
    expect(s).toEqual({ state: "finished", mode: "classic", blind: false, pickedCount: 0, concepts: "none", bankedCount: 0, rev: 2, generation: 1, waiting: [], swap: "none", dinnerDecided: false, cookedCount: 0 });
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
    expect(view.you).toEqual({ slot: 1, chaosUsed: false, vetoUsed: false });
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

  it("keeps 'banked' with no readable recipe as banked, with no data", () => {
    const recipes = bankedRecipes("a");
    (recipes["a"] as Json)["data"] = { serves: 2 };
    const slot = parseCookoutView(finishedView({ recipes }))?.recipes.a;
    expect(slot?.state).toBe("banked");
    expect(slot?.data).toBeNull();
  });

  it("enforces Blind redaction itself: a partner's pair, role and picks a buggy server sent are dropped", () => {
    // Player 1 viewing Player 2's turn, but the server (wrongly) included everything.
    const leaky = pickingView({ blind: true, you: 1, turn: 4, showOptions: true });
    const view = parseCookoutView(leaky);
    expect(view?.current).toMatchObject({ turn: 4, player: 2, role: null, options: null, offerIndex: null, skipsRemaining: null });
    expect(view?.players[1].picks).toBeNull();
    expect(view?.players[1].pickCount).toBe(1);
    expect(view?.players[0].picks?.map((p) => p.id)).toEqual(["thick-white-toast", "flat-leaf-parsley"]);
    // A non-player sees nobody's picks; the active player keeps their own pair.
    expect(parseCookoutView(pickingView({ blind: true, you: null, turn: 3 }))?.players[0].picks).toBeNull();
    expect(parseCookoutView(pickingView({ blind: true, you: 1, turn: 3 }))?.current?.options).not.toBeNull();
    // Blind history is only ever the viewer's own turns, even after the reveal.
    const withHistory = finishedView({ blind: true });
    withHistory["history"] = [
      { turn: 1, player: 1, offers: [[RIBEYE, SALMON]], choice: RIBEYE },
      { turn: 2, player: 2, offers: [[LENTILS, SALMON]], choice: LENTILS },
    ];
    expect(parseCookoutView(withHistory)?.history.map((t) => t.turn)).toEqual([1]);
    // An abandoned Blind round never reveals; a finished, revealed one shows all ten.
    const abandoned = { ...pickingView({ blind: true, you: 1, turn: 5 }), state: "abandoned", current: null };
    expect(parseCookoutView(abandoned)?.players[1].picks).toBeNull();
    expect(parseCookoutView(finishedView({ blind: true }))?.players[1].picks).toHaveLength(5);
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
      expect(await skipCookout(SESSION, 41, { sender: "Josh", moveId: "m1", turn: 1, offer: 0, optionIds: ["a-b", "c-d"] })).toEqual({ ok: false, kind: error });
    }
    serverFetch.mockResolvedValueOnce(json({ error: "mystery" }, 409));
    expect(await skipCookout(SESSION, 41, { sender: "Josh", moveId: "m1", turn: 1, offer: 0, optionIds: ["a-b", "c-d"] })).toEqual({ ok: false, kind: "bad_state" });
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
    await bankCookoutConcept(SESSION, 41, "b", { sender: "Josh", moveId: "m3", generation: 1 });
    await retryCookoutRecipe(SESSION, 41, "c", { sender: "Josh", generation: 1 });
    const calls = serverFetch.mock.calls.map((c) => [c[0], JSON.parse(String((c[1] as RequestInit).body))]);
    expect(calls).toEqual([
      ["/cookout/41/pick", { sender: "Josh", moveId: "m2", turn: 10, offer: 2, ingredientId: "white-miso" }],
      ["/cookout/41/concepts/b/bank", { sender: "Josh", moveId: "m3", generation: 1 }],
      ["/cookout/41/concepts/c/recipe/retry", { sender: "Josh", generation: 1 }],
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

// -- Game modes (spec/server-chat/09c-cookout-modes.md §5.4, frozen wire A.3, §8.5) -----------------------------

describe("game modes", () => {
  const toastie = (patch: Json = {}) => parseCookoutView({ ...toastiePicking({ turn: 4 }), ...patch });

  it("reads the view's mode block: counts, kinds with their prompts and the anchor kind", () => {
    const view = toastie();
    expect(view?.mode).toEqual({
      id: "toastie",
      label: "Toasted sandwich",
      emoji: "🥪",
      turns: 8,
      picksPerPlayer: 4,
      kinds: [
        { id: "bread", label: "the bread", prompt: "pick the bread" },
        { id: "cheese", label: "a cheese", prompt: "add a cheese" },
        { id: "main", label: "a main filling", prompt: "add a main filling" },
        { id: "produce", label: "veg or fruit", prompt: "add veg or fruit" },
        { id: "finish", label: "a finishing touch", prompt: "add a finishing touch" },
      ],
      anchorKind: "bread",
    });
    expect(parseModeInfo(TOASTIE_MODE)).toEqual(view?.mode);
  });

  it("a view without a mode is Classic: ten turns, five picks each, no kinds, no anchor", () => {
    const view = parseCookoutView(pickingView());
    expect(view?.mode).toEqual(CLASSIC_MODE);
    expect(view?.mode).toMatchObject({ id: "classic", label: "Classic", turns: 10, picksPerPlayer: 5, kinds: [], anchorKind: null });
    for (const junk of [null, "toastie", 7, [], {}, { id: "BAD ID" }, { label: "No id" }]) {
      expect(parseModeInfo(junk), JSON.stringify(junk)).toEqual(CLASSIC_MODE);
    }
  });

  it("an unknown mode id parses as a generic mode that keeps its own label and counts", () => {
    const view = parseCookoutView({
      ...pickingView(),
      mode: { id: "pizza-night", label: "Pizza night", emoji: "🍕", turns: 6, picksPerPlayer: 3, kinds: [{ id: "base", label: "the base", prompt: "pick the base" }], anchorKind: "base" },
    });
    expect(view?.mode).toEqual({
      id: "pizza-night",
      label: "Pizza night",
      emoji: "🍕",
      turns: 6,
      picksPerPlayer: 3,
      kinds: [{ id: "base", label: "the base", prompt: "pick the base" }],
      anchorKind: "base",
    });
    // No label on the wire: the id, spoken.
    expect(parseModeInfo({ id: "pizza-night", turns: 6, picksPerPlayer: 3 }).label).toBe("Pizza night");
  });

  it("counts that disagree fall back to Classic's; an anchor that is not one of the kinds is no anchor", () => {
    for (const counts of [
      { turns: 8, picksPerPlayer: 5 }, // 5 each of 8
      { turns: 7, picksPerPlayer: 3 }, // odd
      { turns: 12, picksPerPlayer: 6 }, // beyond the store's range
      { turns: "8", picksPerPlayer: 4 },
      { picksPerPlayer: undefined },
      { turns: undefined },
    ]) {
      const mode = parseModeInfo({ ...TOASTIE_MODE, ...counts });
      expect(mode, JSON.stringify(counts)).toMatchObject({ id: "toastie", turns: 10, picksPerPlayer: 5 });
    }
    expect(parseModeInfo({ ...TOASTIE_MODE, anchorKind: "crust" }).anchorKind).toBeNull();
    expect(parseModeInfo({ ...TOASTIE_MODE, anchorKind: null }).anchorKind).toBeNull();
  });

  it("drops a malformed or repeated kind and keeps the rest", () => {
    const mode = parseModeInfo({
      ...TOASTIE_MODE,
      kinds: [
        { id: "bread", label: "the bread", prompt: "pick the bread" },
        { id: "bread", label: "the bread again", prompt: "pick again" },
        { id: "BAD ID", label: "x", prompt: "y" },
        { id: "cheese", label: "", prompt: "add a cheese" },
        { id: "main", label: "a main filling", prompt: "  " },
        "nope",
        { id: "finish", label: "a finishing touch", prompt: "add a finishing touch" },
      ],
    });
    expect(mode.kinds.map((k) => k.id)).toEqual(["bread", "finish"]);
    expect(mode.kinds[0]?.label).toBe("the bread");
  });

  it("current.turn is bounded by the mode's turns: turn 9 of an 8-turn mode is no turn at all", () => {
    expect(toastie()?.current?.turn).toBe(4);
    const nine = toastiePicking({ turn: 7 });
    (nine["current"] as Json)["turn"] = 9;
    (nine["current"] as Json)["player"] = 1;
    expect(parseCookoutView(nine)).toBeNull();
    // Classic still has a turn 9 (and a turn 10).
    expect(parseCookoutView(pickingView({ turn: 9 }))?.current?.turn).toBe(9);
    expect(parseCookoutView(pickingView({ turn: 10 }))?.current?.turn).toBe(10);
  });

  it("a player's pick count is bounded by the mode's picks each", () => {
    const five = toastiePicking({ turn: 8 });
    ((five["players"] as Json[])[0] as Json)["pickCount"] = 5;
    expect(parseCookoutView(five)).toBeNull();
    expect(parseCookoutView(toastiePicking({ turn: 8 }))?.players[0].pickCount).toBe(4);
  });

  it("current.role is accepted only when it is a kind of the mode; Classic still reads only its four roles", () => {
    expect(toastie()?.current?.role).toBe("cheese");
    expect(parseCookoutView(toastiePicking({ turn: 4, role: "protein" }))?.current?.role).toBeNull();
    expect(parseCookoutView(toastiePicking({ turn: 4, role: "bread" }))?.current?.role).toBe("bread");
    // Classic: its four bank roles only.
    expect(parseCookoutView(pickingView())?.current?.role).toBe("protein");
    const classicBread = pickingView();
    (classicBread["current"] as Json)["role"] = "bread";
    expect(parseCookoutView(classicBread)?.current?.role).toBeNull();
    for (const role of ["protein", "base", "produce", "accent"]) {
      const view = pickingView();
      (view["current"] as Json)["role"] = role;
      expect(parseCookoutView(view)?.current?.role, role).toBe(role);
    }
  });

  it("PickSnap.kind rides with the pick, and is null when absent or malformed", () => {
    const view = parseCookoutView(toastiePicking({ turn: 5 }));
    expect(view?.players[0].picks?.map((p) => p.kind)).toEqual(["bread", "main"]);
    expect(view?.players[1].picks?.map((p) => p.kind)).toEqual(["main", "cheese"]);
    const classic = parseCookoutView(pickingView({ turn: 3 }));
    expect(classic?.players[0].picks?.[0]?.kind).toBeNull();
    expect(parsePickSnap({ ...SOURDOUGH, turn: 1, kind: "BAD KIND" })?.kind).toBeNull();
    expect(parsePickSnap({ ...SOURDOUGH, turn: 1, kind: 7 })?.kind).toBeNull();
    expect(parsePickSnap({ ...SOURDOUGH, turn: 1, kind: "bread" })?.kind).toBe("bread");
  });

  it("Concept.build is {id, label}, and null when absent or malformed", () => {
    const view = parseCookoutView(toastieFinished());
    expect(view?.concepts.data?.map((c) => c.build)).toEqual([
      { id: "skillet", label: "Skillet-fried" },
      { id: "press", label: "Sandwich-press" },
      { id: "oven", label: "Oven-baked" },
    ]);
    expect(parseBuild({ id: "skillet", label: "Skillet-fried" })).toEqual({ id: "skillet", label: "Skillet-fried" });
    for (const bad of [undefined, null, "skillet", {}, { id: "skillet" }, { id: "Not Valid", label: "x" }, { id: "skillet", label: "  " }, { id: "skillet", label: "x".repeat(61) }]) {
      expect(parseBuild(bad), JSON.stringify(bad)).toBeNull();
    }
    const odd = toastieFinished({}, { concepts: { state: "ready", data: [toastieConcept("a", "Odd One", { id: "BAD ID", label: "x" })], error: null } });
    expect(parseCookoutView(odd)?.concepts.data?.[0]?.build).toBeNull();
    // A Classic dish has no build.
    expect(parseCookoutView(finishedView())?.concepts.data?.every((c) => c.build === null)).toBe(true);
  });

  it("the message summary names its mode, and defaults to Classic", () => {
    expect(parseCookoutSummary({ state: "picking", rev: 3, mode: "toastie", pickedCount: 3 })).toMatchObject({ mode: "toastie", pickedCount: 3 });
    expect(parseCookoutSummary({ state: "picking", rev: 3 })?.mode).toBe("classic");
    expect(parseCookoutSummary({ state: "picking", rev: 3, mode: "Not A Mode" })?.mode).toBe("classic");
    expect(parseCookoutSummary({ state: "picking", rev: 3, mode: 4 })?.mode).toBe("classic");
  });

  describe("GET /cookout/options modes", () => {
    it("reads both modes, Classic first, with every field of the toasted sandwich", () => {
      const options = parseCookoutOptions(optionsBody());
      expect(options?.modes.map((m) => m.id)).toEqual(["classic", "toastie"]);
      expect(options?.modes[1]).toEqual({
        id: "toastie",
        label: "Toasted sandwich",
        emoji: "🥪",
        turns: 8,
        picksPerPlayer: 4,
        blurb: "Pick a bread and 7 fillings, get 3 toasties",
        intro: [...TOASTIE_INTRO],
        twists: [...ALL_TWIST_IDS],
        fridgeKinds: ["bread"],
      });
      expect(options?.modes[0]).toMatchObject({ id: "classic", turns: 10, picksPerPlayer: 5, fridgeKinds: null });
    });

    it("synthesizes Classic when the server lists none (an older server, or only the other mode)", () => {
      expect(parseCookoutOptions({ styles: [], challenges: [], chef: true, pictures: false })?.modes).toEqual([CLASSIC_OPTION]);
      expect(parseCookoutOptions(optionsBody([]))?.modes).toEqual([CLASSIC_OPTION]);
      const onlyToastie = parseCookoutOptions(optionsBody([toastieOption()]));
      expect(onlyToastie?.modes.map((m) => m.id)).toEqual(["classic", "toastie"]);
      expect(onlyToastie?.modes[0]).toEqual(CLASSIC_OPTION);
      expect(parseModeOptions("nope")).toEqual([CLASSIC_OPTION]);
    });

    it("puts Classic first wherever the server put it", () => {
      const options = parseCookoutOptions(optionsBody([toastieOption(), classicOptionWire()]));
      expect(options?.modes.map((m) => m.id)).toEqual(["classic", "toastie"]);
    });

    it("keeps the first of a repeated mode and drops malformed entries", () => {
      const options = parseCookoutOptions(
        optionsBody([
          classicOptionWire(),
          toastieOption({ blurb: "The first one" }),
          toastieOption({ blurb: "A repeat" }),
          { id: "BAD ID", label: "Bad", turns: 8, picksPerPlayer: 4 },
          { label: "No id" },
          null,
          "toastie",
          42,
        ]),
      );
      expect(options?.modes.map((m) => m.id)).toEqual(["classic", "toastie"]);
      expect(options?.modes[1]?.blurb).toBe("The first one");
    });

    it("trusts only the twists it knows, at most three non-blank intro lines, and no twists for a mode that lists none", () => {
      const options = parseCookoutOptions(
        optionsBody([
          classicOptionWire(),
          toastieOption({ twists: ["lucky", "lucky", "levitate", "stars", 3], intro: ["One", "", "Two", "Three", "Four", 9] }),
          toastieOption({ id: "wrap", label: "Wrap", twists: undefined, fridgeKinds: undefined }),
        ]),
      );
      expect(options?.modes[1]?.twists).toEqual(["lucky", "stars"]);
      expect(options?.modes[1]?.intro).toEqual(["One", "Two", "Three"]);
      const wrap = options?.modes[2];
      expect(wrap?.twists).toEqual([]);
      expect(wrap?.fridgeKinds).toBeNull();
      // Classic from a server that predates the twist list still offers all twelve.
      expect(parseModeOptions([{ id: "classic", label: "Classic" }])[0]?.twists).toEqual(ALL_TWISTS);
    });

    it("counts that disagree fall back to Classic's here too", () => {
      const options = parseCookoutOptions(optionsBody([classicOptionWire(), toastieOption({ turns: 8, picksPerPlayer: 3 })]));
      expect(options?.modes[1]).toMatchObject({ turns: 10, picksPerPlayer: 5 });
    });
  });

  describe("the Recipe book entry", () => {
    it("names its mode and build, and a mode-less entry is Classic with no build", () => {
      const recipes = parseRecipeBook(modeBookBody()) ?? [];
      expect(recipes).toHaveLength(2);
      expect(recipes[0]).toMatchObject({ mode: { id: "classic", label: "Classic", emoji: "🍳" }, build: null });
      expect(recipes[1]).toMatchObject({ mode: { id: "toastie", label: "Toasted sandwich", emoji: "🥪" }, build: { id: "skillet", label: "Skillet-fried" } });
    });

    it("a malformed mode or build reads as Classic / none rather than hiding the dish", () => {
      const [first] = bookBody()["recipes"] as Json[];
      const recipes = parseRecipeBook({ recipes: [{ ...first, mode: { id: "BAD ID" }, build: { id: "x" } }] }) ?? [];
      expect(recipes).toHaveLength(1);
      expect(recipes[0]).toMatchObject({ mode: { id: "classic" }, build: null });
    });
  });

  describe("the fridge raid's search", () => {
    const found = () => json({ ingredients: [SOURDOUGH] });

    it("adds &mode=toastie for a mode, and nothing for Classic or no mode", async () => {
      serverFetch.mockResolvedValueOnce(found());
      const result = await searchIngredients(SESSION, "sour", "toastie");
      expect(serverFetch.mock.calls[0]?.[0]).toBe("/cookout/ingredients?q=sour&mode=toastie");
      expect(result.ok && result.ingredients.map((i) => i.id)).toEqual(["sourdough-loaf"]);
      serverFetch.mockResolvedValueOnce(found());
      await searchIngredients(SESSION, "sour", "classic");
      expect(serverFetch.mock.calls[1]?.[0]).toBe("/cookout/ingredients?q=sour");
      serverFetch.mockResolvedValueOnce(found());
      await searchIngredients(SESSION, "sour", null);
      expect(serverFetch.mock.calls[2]?.[0]).toBe("/cookout/ingredients?q=sour");
      serverFetch.mockResolvedValueOnce(found());
      await searchIngredients(SESSION, "sour");
      expect(serverFetch.mock.calls[3]?.[0]).toBe("/cookout/ingredients?q=sour");
    });

    it("encodes the query and the mode", async () => {
      serverFetch.mockResolvedValueOnce(found());
      await searchIngredients(SESSION, " rye bread ", "to&astie");
      expect(serverFetch.mock.calls[0]?.[0]).toBe("/cookout/ingredients?q=rye%20bread&mode=to%26astie");
    });
  });

  it("createCookout sends the mode only when the caller gives one", async () => {
    const message = { seq: 41, sender: "Josh", text: null, attachments: [], reactions: [], createdAt: 1, replyTo: null };
    serverFetch.mockResolvedValueOnce(json({ message }, 201));
    await createCookout(SESSION, { clientId: "c1", sender: "Josh", deviceId: "d", blind: false, mode: "toastie" });
    expect(JSON.parse(String((serverFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ clientId: "c1", sender: "Josh", deviceId: "d", blind: false, mode: "toastie" });
    serverFetch.mockResolvedValueOnce(json({ message }, 201));
    await createCookout(SESSION, { clientId: "c2", sender: "Josh", deviceId: "d", blind: false });
    expect(Object.keys(JSON.parse(String((serverFetch.mock.calls[1]?.[1] as RequestInit).body)))).not.toContain("mode");
  });
});
