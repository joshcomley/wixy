import { describe, expect, it } from "vitest";
import {
  parseCookoutView,
  parseFacts,
  parseIngredientImage,
  parsePickSnap,
  parseSnap,
  parseWhat,
} from "../../src/server/cookout/api";
import { finishedView, pickingView, RIBEYE, SALMON } from "./fixtures";

// spec/server-chat/09b-cookout-visual.md §E.3: the round-2 read-time fields are parsed defensively — a
// picture URL must be this server's own content-addressed route or the whole picture is dropped, `what` is
// at most 120 characters, `facts` at most three strings of at most 200 — and a pre-round-2 server (no
// fields at all) parses to nulls, so the client works against either server.

const SHA_A = "a".repeat(64);
const SHA_B = "0123456789abcdef".repeat(4);
const CARD = `/admin/cookout-img/${SHA_A}.webp`;
const THUMB = `/admin/cookout-img/${SHA_B}.webp`;

describe("the picture", () => {
  it("accepts both renditions on this server's route", () => {
    expect(parseIngredientImage({ card: CARD, thumb: THUMB })).toEqual({ card: CARD, thumb: THUMB });
  });

  it("drops the whole picture when either URL is malformed", () => {
    for (const bad of [
      { card: CARD, thumb: "/admin/cookout-img/abc.webp" },
      { card: `https://evil.example/admin/cookout-img/${SHA_A}.webp`, thumb: THUMB },
      { card: `/admin/cookout-img/${SHA_A.toUpperCase()}.webp`, thumb: THUMB },
      { card: `/admin/cookout-img/${SHA_A}.png`, thumb: THUMB },
      { card: `/admin/cookout-img/${SHA_A}.webp?x=1`, thumb: THUMB },
      { card: `/admin/cookout-img/../${SHA_A}.webp`, thumb: THUMB },
      { card: CARD },
      { card: CARD, thumb: 7 },
      "nope",
      null,
      [],
    ]) {
      expect(parseIngredientImage(bad)).toBeNull();
    }
  });
});

describe("what it is", () => {
  it("keeps a line of up to 120 characters", () => {
    expect(parseWhat("A large tropical sea crustacean with sweet, lobster-like meat.")).toBe(
      "A large tropical sea crustacean with sweet, lobster-like meat.",
    );
    expect(parseWhat("x".repeat(120))).toBe("x".repeat(120));
  });

  it("is null when too long, blank or not a string", () => {
    expect(parseWhat("x".repeat(121))).toBeNull();
    expect(parseWhat("   ")).toBeNull();
    expect(parseWhat(42)).toBeNull();
    expect(parseWhat(undefined)).toBeNull();
  });
});

describe("fun facts", () => {
  it("keeps up to three strings of up to 200 characters", () => {
    expect(parseFacts(["One.", "Two.", "Three."])).toEqual(["One.", "Two.", "Three."]);
    expect(parseFacts(["x".repeat(200)])).toEqual(["x".repeat(200)]);
    expect(parseFacts([])).toEqual([]);
  });

  it("is null when oversized or malformed (all or nothing)", () => {
    expect(parseFacts(["a", "b", "c", "d"])).toBeNull();
    expect(parseFacts(["ok", "x".repeat(201)])).toBeNull();
    expect(parseFacts(["ok", 3])).toBeNull();
    expect(parseFacts("one fact")).toBeNull();
    expect(parseFacts(null)).toBeNull();
  });
});

describe("snapshots carry the fields", () => {
  it("an ingredient snap parses what and image", () => {
    const snap = parseSnap({ ...RIBEYE, what: "A rich, marbled beef steak.", image: { card: CARD, thumb: THUMB } });
    expect(snap?.what).toBe("A rich, marbled beef steak.");
    expect(snap?.image).toEqual({ card: CARD, thumb: THUMB });
  });

  it("a pick parses its facts", () => {
    const pick = parsePickSnap({ ...RIBEYE, turn: 1, via: "pick", facts: ["Ribeye is cut from the rib section."] });
    expect(pick?.facts).toEqual(["Ribeye is cut from the rib section."]);
  });

  it("an absent field (a pre-round-2 server) parses to null, never to a failed snap", () => {
    const snap = parseSnap(SALMON);
    expect(snap).not.toBeNull();
    expect(snap?.what).toBeNull();
    expect(snap?.image).toBeNull();
    expect(parsePickSnap({ ...SALMON, turn: 2 })?.facts).toBeNull();
  });

  it("a malformed field drops only that field, never the ingredient", () => {
    const snap = parseSnap({ ...SALMON, what: "x".repeat(500), image: { card: "/elsewhere.webp", thumb: THUMB } });
    expect(snap?.name).toBe("Salmon fillet");
    expect(snap?.what).toBeNull();
    expect(snap?.image).toBeNull();
  });

  it("a whole view: the table's pair, the picks and the staples carry their pictures", () => {
    const image = { card: CARD, thumb: THUMB };
    const raw = pickingView({ turn: 3, options: [{ ...RIBEYE, image }, { ...SALMON, image }] });
    raw["staples"] = [
      { id: "salt", name: "Salt", image },
      { id: "water", name: "Water" },
    ];
    const view = parseCookoutView(raw);
    expect(view?.current?.options?.[0].image).toEqual(image);
    expect(view?.staples[0]?.image).toEqual(image);
    expect(view?.staples[1]?.image).toBeNull();
  });

  it("a finished view's picks carry facts", () => {
    const raw = finishedView();
    const players = raw["players"] as Array<Record<string, unknown>>;
    const picks = players[0]?.["picks"] as Array<Record<string, unknown>>;
    picks[0] = { ...picks[0], facts: ["A fact.", "Another fact."] };
    const view = parseCookoutView(raw);
    expect(view?.players[0].picks?.[0]?.facts).toEqual(["A fact.", "Another fact."]);
    expect(view?.players[0].picks?.[1]?.facts).toBeNull();
  });
});
