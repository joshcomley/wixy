import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverFetch } = vi.hoisted(() => ({ serverFetch: vi.fn() }));
vi.mock("../../src/server/api/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/http")>()),
  serverFetch,
}));

import {
  bankCookoutConcept,
  cancelSwap,
  chaosCookout,
  chooseSwap,
  createCookout,
  getCookoutOptions,
  getRoundPhotos,
  linkRecipePhoto,
  luckyCookout,
  markCooked,
  parseCookoutOptions,
  parseCookoutSummary,
  parseCookoutView,
  parseFullRecipe,
  parseRecipeBook,
  parseRoundPhotos,
  proposeSwap,
  rateRecipe,
  retryCookoutConcepts,
  retryCookoutPictures,
  retryCookoutRecipe,
  searchIngredients,
  starCookout,
  vetoCookout,
  voteCookout,
  wildcardCookout,
} from "../../src/server/cookout/api";
import { ServerLockedError } from "../../src/server/api/http";
import { CONCEPTS, FULL_RECIPE, PARSLEY, RIBEYE, SALMON, bookBody, finishedView, picture, pickingView, snap, type Json } from "./fixtures";
import {
  CHALLENGE_PAN,
  DURIAN,
  NATTO,
  STYLE_COSY,
  TOMATOES,
  bankedSlot,
  cookedInfo,
  earlierSet,
  gated,
  pick,
  readyVote,
  setup,
  stars,
  swap,
  twistFinished,
  twistPicking,
  v,
} from "./twistFixtures";

// The twists' wire parsers and calls (spec/server-chat/09a-cookout-twists.md §4): every new field is read
// defensively, a core-era server's view parses to the "off" values, and the secrets that stay hidden from the
// partner in BOTH modes (the stars, the dinner vote) are dropped by a second lock even if a server sent them.

// A couple of snaps only this file needs.
const LENTILS_WILD = snap("red-lentils", "Red lentils", "legumes-nuts-seeds", "🫘", "Cook down to a silky purée.");
const KIMCHI_SNAP = snap("aged-kimchi", "Aged kimchi", "sauces-stocks-fermented", "🥬");

const SESSION = { token: "tok", expiresAt: 9_999_999_999 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  serverFetch.mockReset();
});

describe("the message summary's twist fields", () => {
  it("reads a well-formed twisty summary", () => {
    expect(
      parseCookoutSummary({
        state: "finished",
        blind: true,
        pickedCount: 10,
        concepts: "ready",
        bankedCount: 2,
        rev: 7,
        generation: 2,
        waiting: ["stars", "wildcard"],
        swap: "proposed",
        dinnerDecided: true,
        cookedCount: 1,
      }),
    ).toEqual({
      state: "finished",
      blind: true,
      pickedCount: 10,
      concepts: "ready",
      bankedCount: 2,
      rev: 7,
      generation: 2,
      waiting: ["stars", "wildcard"],
      swap: "proposed",
      dinnerDecided: true,
      cookedCount: 1,
    });
  });

  it("falls back to the off values for anything missing or garbage", () => {
    const s = parseCookoutSummary({
      state: "finished",
      rev: 2,
      generation: "two",
      waiting: ["stars", "stars", "bogus", 5, null],
      swap: "sideways",
      dinnerDecided: "yes",
      cookedCount: 99,
    });
    expect(s).toMatchObject({ generation: 1, waiting: ["stars"], swap: "none", dinnerDecided: false, cookedCount: 0 });
    expect(parseCookoutSummary({ state: "picking", rev: 1, generation: 0, waiting: "stars" })).toMatchObject({ generation: 1, waiting: [] });
    expect(parseCookoutSummary({ state: "picking", rev: 1, generation: -3 })?.generation).toBe(1);
  });
});

describe("a core-era view (no twist keys at all)", () => {
  it("parses to the twists' off values", () => {
    const view = v(finishedView());
    expect(view.setup).toEqual({ style: null, styleSpun: false, challenge: null, wildcard: false, stars: false, fridgeRaid: false, encore: null });
    expect(view.generation).toBe(1);
    expect(view.starters).toEqual([]);
    expect(view.basket).toBeNull();
    expect(view.gate).toEqual({ waitingFor: [] });
    expect(view.wildcard).toEqual({ state: "off", ingredient: null });
    expect(view.stars).toEqual({ enabled: false, mine: null, partnerChosen: false, revealed: false, partner: null });
    expect(view.vote).toBeNull();
    expect(view.swap).toEqual({ state: "none", available: false, by: null, out: null, pair: null, in: null });
    expect(view.generations).toEqual([]);
    expect(view.you).toEqual({ slot: 1, chaosUsed: false, vetoUsed: false });
    expect(view.players.map((p) => [p.chaosUsed, p.vetoUsed])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(view.recipes.a).toMatchObject({ generation: 1, cooked: null });
    expect(view.concepts.data?.[0]).toMatchObject({ challengeNote: null, totalMinutes: null });
  });

  it("parses to the off values when every twist key is garbage", () => {
    const view = v(
      twistFinished(
        {},
        {
          setup: "x",
          generation: "two",
          starters: { not: "a list" },
          basket: "x",
          gate: 7,
          wildcard: [],
          stars: "x",
          vote: "x",
          swap: [],
          generations: "x",
        },
      ),
    );
    expect(view.setup.style).toBeNull();
    expect(view.setup.encore).toBeNull();
    expect(view.generation).toBe(1);
    expect(view.starters).toEqual([]);
    expect(view.basket).toBeNull();
    expect(view.gate.waitingFor).toEqual([]);
    expect(view.wildcard).toEqual({ state: "off", ingredient: null });
    expect(view.stars).toEqual({ enabled: false, mine: null, partnerChosen: false, revealed: false, partner: null });
    expect(view.vote).toBeNull();
    expect(view.swap.state).toBe("none");
    expect(view.generations).toEqual([]);
  });
});

describe("the setup, generation, starters, basket, wildcard and swap", () => {
  it("reads the round's twists", () => {
    const view = v(
      twistFinished(
        {},
        {
          setup: setup({
            style: STYLE_COSY,
            styleSpun: true,
            challenge: CHALLENGE_PAN,
            wildcard: true,
            stars: true,
            fridgeRaid: true,
            encore: { kind: "remix", fromSeq: 30, fromTitle: "Lentil Traybake" },
          }),
          generation: 2,
          starters: [pick(TOMATOES, 1, "seed")],
          basket: [pick(TOMATOES, 1, "seed"), pick(LENTILS_WILD, null, "wildcard")],
          wildcard: { state: "lifted", ingredient: LENTILS_WILD },
          swap: swap({ state: "done", by: 2, out: PARSLEY, in: SALMON }),
        },
      ),
    );
    expect(view.setup).toEqual({
      style: { id: "cosy-pub", label: "Cosy pub", emoji: "🍺" },
      styleSpun: true,
      challenge: { id: "one-pan", label: "One pan only", emoji: "🍳" },
      wildcard: true,
      stars: true,
      fridgeRaid: true,
      encore: { kind: "remix", fromSeq: 30, fromTitle: "Lentil Traybake" },
    });
    expect(view.generation).toBe(2);
    expect(view.starters.map((s) => [s.id, s.turn, s.via])).toEqual([["cherry-tomatoes", 1, "seed"]]);
    expect(view.basket?.map((s) => [s.id, s.turn, s.via])).toEqual([
      ["cherry-tomatoes", 1, "seed"],
      ["red-lentils", null, "wildcard"],
    ]);
    expect(view.wildcard.state).toBe("lifted");
    expect(view.wildcard.ingredient?.id).toBe("red-lentils");
    expect(view.swap).toMatchObject({ state: "done", by: 2, out: { id: "flat-leaf-parsley" }, in: { id: "salmon-fillet" }, pair: null });
  });

  it("drops a style or challenge that is not in the catalogue, and a spun flag with no style", () => {
    const view = v(
      twistFinished(
        {},
        {
          setup: {
            style: { id: "mystery-meal", label: "Mystery", emoji: "?" },
            styleSpun: true,
            challenge: { id: "one-pan", label: "  " },
            encore: { kind: "sideways", fromSeq: 3 },
          },
        },
      ),
    );
    expect(view.setup.style).toBeNull();
    expect(view.setup.styleSpun).toBe(false);
    expect(view.setup.challenge).toBeNull();
    expect(view.setup.encore).toBeNull();
  });

  it("reads a pick's turn and how it got in, defending against nonsense", () => {
    const view = v(
      twistFinished({}, { starters: [{ ...TOMATOES, turn: 11, via: "bogus" }, { ...DURIAN, turn: 2, via: "chaos" }] }),
    );
    expect(view.starters.map((s) => [s.turn, s.via])).toEqual([
      [null, "pick"],
      [2, "chaos"],
    ]);
    // A starter list with a hole in it is not drawn at all (it would miscount the basket).
    expect(v(twistFinished({}, { starters: [TOMATOES, { id: "no-name" }] })).starters).toEqual([]);
    // More than two starters is not a valid wire.
    expect(v(twistFinished({}, { starters: [TOMATOES, DURIAN, NATTO] })).starters).toEqual([]);
  });

  it("the swap's pair and result only show in the state that owns them", () => {
    const proposed = v(twistFinished({}, { swap: swap({ state: "proposed", by: 1, out: PARSLEY, pair: [TOMATOES, DURIAN], in: SALMON }) })).swap;
    expect(proposed.pair?.map((s) => s.id)).toEqual(["cherry-tomatoes", "fresh-durian"]);
    expect(proposed.in).toBeNull();
    const none = v(twistFinished({}, { swap: swap({ state: "none", available: true, by: 1, out: PARSLEY, pair: [TOMATOES, DURIAN] }) })).swap;
    expect(none).toEqual({ state: "none", available: true, by: null, out: null, pair: null, in: null });
    // A pair of the same ingredient twice is nonsense.
    expect(v(twistFinished({}, { swap: swap({ state: "proposed", by: 1, out: PARSLEY, pair: [TOMATOES, TOMATOES] }) })).swap.pair).toBeNull();
  });

  it("the cloche's ingredient exists only once lifted", () => {
    expect(v(twistFinished({}, { wildcard: { state: "offered", ingredient: LENTILS_WILD } })).wildcard).toEqual({ state: "offered", ingredient: null });
    expect(v(twistFinished({}, { wildcard: { state: "warp", ingredient: LENTILS_WILD } })).wildcard.state).toBe("off");
  });

  it("the gate is read only on a finished round the chef has not started", () => {
    expect(v(gated(["stars", "wildcard", "stars", "x"])).gate.waitingFor).toEqual(["stars", "wildcard"]);
    expect(v(twistFinished({}, { gate: { waitingFor: ["stars"] } })).gate.waitingFor).toEqual([]);
    expect(v({ ...pickingView(), gate: { waitingFor: ["stars"] } }).gate.waitingFor).toEqual([]);
  });
});

describe("the table's twist flags and the history seed", () => {
  it("reads the pair's chaos flag, the swept option and the three can-flags", () => {
    const view = v(
      twistPicking(
        { you: 2, turn: 1 },
        { you: { slot: 2, chaosUsed: true, vetoUsed: false } },
        { chaosPair: true, vetoed: { snap: SALMON }, canChaos: false, canLucky: true, canVeto: true },
      ),
    );
    expect(view.current).toMatchObject({ chaosPair: true, vetoed: { id: "salmon-fillet" }, canChaos: false, canLucky: true, canVeto: true });
    expect(view.you).toEqual({ slot: 2, chaosUsed: true, vetoUsed: false });
  });

  it("a flag that is not a boolean, or a swept option that is not an ingredient, reads as unknown", () => {
    const view = v(twistPicking({}, {}, { chaosPair: "yes", vetoed: { snap: { id: "" } }, canChaos: 1, canLucky: null, canVeto: "no" }));
    expect(view.current).toMatchObject({ chaosPair: null, vetoed: null, canChaos: null, canLucky: null, canVeto: null });
  });

  it("flags are dropped when no pair is shown to this viewer", () => {
    const view = v(twistPicking({ you: 2, turn: 1, showOptions: false }, {}, { chaosPair: true, vetoed: { snap: SALMON }, canChaos: true, canLucky: true }));
    expect(view.current).toMatchObject({ options: null, chaosPair: null, vetoed: null, canChaos: null, canLucky: null });
  });

  it("reads a turn's starter seed, swept and chaos-replaced options, chaos offer and lucky flag", () => {
    const view = v({
      ...pickingView({ turn: 3 }),
      history: [
        {
          turn: 1,
          player: 1,
          offers: [[RIBEYE, SALMON]],
          choice: RIBEYE,
          seed: null,
          replaced: [
            { offer: 0, snap: SALMON, by: "veto" },
            { offer: 1, snap: PARSLEY, by: "chaos" },
            { offer: 1, snap: PARSLEY, by: "nobody" },
            { offer: 7, snap: PARSLEY, by: "veto" },
            "junk",
          ],
          chaosOffer: 1,
          lucky: true,
        },
        { turn: 2, player: 2, offers: [], choice: null, seed: TOMATOES, replaced: "x", chaosOffer: 9, lucky: "yes" },
      ],
    });
    const [first, second] = view.history;
    expect(first?.replaced.map((r) => [r.offer, r.snap.id, r.by])).toEqual([
      [0, "salmon-fillet", "veto"],
      [1, "flat-leaf-parsley", "chaos"],
    ]);
    expect(first).toMatchObject({ chaosOffer: 1, lucky: true, seed: null });
    expect(second).toMatchObject({ seed: { id: "cherry-tomatoes" }, replaced: [], chaosOffer: null, lucky: false });
  });
});

describe("the recipes, the cooked corner and the dishes", () => {
  it("a recipe slot names its dish set and carries its cooked corner", () => {
    const view = v(
      twistFinished(
        {},
        {
          generation: 2,
          recipes: {
            a: bankedSlot(2, { cooked: cookedInfo({ ratings: { "1": 5, "2": 9 }, photo: picture(3), photoMessageSeq: 12 }) }),
            b: { state: "pending", requestedBy: "Josh", bankedAt: null, error: null, data: null, cooked: cookedInfo() },
            c: { state: "banked", requestedBy: null, bankedAt: 1, error: null, data: FULL_RECIPE },
          },
        },
      ),
    );
    expect(view.recipes.a.generation).toBe(2);
    expect(view.recipes.a.cooked).toMatchObject({
      cookedAt: 1793300000,
      cookedBy: "Josh",
      // 9 hearts is out of range: not rated.
      ratings: { 1: 5, 2: null },
      photo: { attachmentId: "att-3" },
      photoMessageSeq: 12,
    });
    // Only a banked recipe can be cooked.
    expect(view.recipes.b.cooked).toBeNull();
    // A slot with no generation of its own takes the round's current one.
    expect(view.recipes.c.generation).toBe(2);
    expect(view.recipes.c.cooked).toBeNull();
  });

  it("a cooked corner with no time, or with a third-party photo, is read defensively", () => {
    const noTime = v(twistFinished({}, { recipes: { a: bankedSlot(1, { cooked: { ratings: { "1": 3 } } }) } }));
    expect(noTime.recipes.a.cooked).toBeNull();
    const foreign = v(
      twistFinished(
        {},
        { recipes: { a: bankedSlot(1, { cooked: cookedInfo({ photo: { attachmentId: "x", thumbUrl: "https://evil.example/p.jpg", fullUrl: "https://evil.example/p.jpg" }, photoMessageSeq: -4 }) }) } },
      ),
    );
    expect(foreign.recipes.a.cooked?.photo).toBeNull();
    expect(foreign.recipes.a.cooked?.photoMessageSeq).toBeNull();
  });

  it("a concept's challenge note and total time are read, and garbage reads as none", () => {
    const view = v(
      twistFinished({}, {
        concepts: {
          state: "ready",
          data: [
            { ...CONCEPTS[0], challengeNote: "Everything in one pan", totalMinutes: 28 },
            { ...CONCEPTS[1], challengeNote: 12, totalMinutes: "soon" },
            { ...CONCEPTS[2], challengeNote: "x".repeat(400), totalMinutes: 0 },
          ],
          error: null,
        },
      }),
    );
    const [a, b, c] = view.concepts.data ?? [];
    expect([a?.challengeNote, a?.totalMinutes]).toEqual(["Everything in one pan", 28]);
    expect([b?.challengeNote, b?.totalMinutes]).toEqual([null, null]);
    expect([c?.challengeNote, c?.totalMinutes]).toEqual([null, null]);
  });

  it("a recipe's cookware list keeps only real strings", () => {
    const recipe = parseFullRecipe({ ...FULL_RECIPE, cookware: ["Large frying pan", "", 7, null, "Tongs", "x".repeat(200)] });
    expect(recipe?.cookware).toEqual(["Large frying pan", "Tongs"]);
    expect(parseFullRecipe({ ...FULL_RECIPE, cookware: "pan" })?.cookware).toEqual([]);
    expect(parseFullRecipe(FULL_RECIPE)?.cookware).toEqual([]);
  });

  it("earlier dish sets are read, and never the one on the table", () => {
    const view = v(
      twistFinished({}, {
        generation: 2,
        generations: [earlierSet(1), earlierSet(2), earlierSet(1), { generation: "x" }],
      }),
    );
    expect(view.generations.map((g) => g.generation)).toEqual([1]);
    expect(view.generations[0]?.concepts.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(view.generations[0]?.pictures.a?.attachmentId).toBe("att-11");
    expect(view.generations[0]?.recipes.a.generation).toBe(1);
  });
});

describe("the second locks (secrets stay secret in BOTH modes until their own reveal)", () => {
  const revealedStars = (extra: Json = {}): Json => stars({ mine: "thick-white-toast", partnerChosen: true, revealed: true, partner: "ribeye-steak", ...extra });

  it("the partner's star is dropped unless revealed, in Open and in Blind", () => {
    for (const blind of [false, true]) {
      const leaked = v(twistFinished({ blind }, { stars: stars({ mine: "thick-white-toast", partnerChosen: true, revealed: false, partner: "ribeye-steak" }) }));
      expect(leaked.stars, `blind=${blind}`).toMatchObject({ revealed: false, partner: null, mine: "thick-white-toast", partnerChosen: true });
      const shown = v(twistFinished({ blind }, { stars: revealedStars() }));
      expect(shown.stars, `blind=${blind}`).toMatchObject({ revealed: true, partner: "ribeye-steak" });
    }
  });

  it("stars never reveal on a round that is not finished", () => {
    const abandoned = v({ ...pickingView(), state: "abandoned", current: null, stars: revealedStars() });
    expect(abandoned.stars.revealed).toBe(false);
    expect(abandoned.stars.partner).toBeNull();
    const picking = v({ ...pickingView(), stars: revealedStars() });
    expect(picking.stars).toMatchObject({ revealed: false, partner: null });
  });

  it("a star that is not a valid ingredient id is dropped", () => {
    const view = v(twistFinished({}, { stars: revealedStars({ mine: "Not An Id!", partner: 12 }) }));
    expect(view.stars).toMatchObject({ mine: null, partner: null, revealed: true });
  });

  it("the dinner votes are dropped unless revealed", () => {
    const leaked = v(twistFinished({}, { vote: readyVote({ you: "a", partnerVoted: true, revealed: false, votes: { "1": "a", "2": "b" }, match: "a" }) }));
    expect(leaked.vote).toEqual({ you: "a", partnerVoted: true, revealed: false, votes: null, match: null });
  });

  it("a revealed vote needs BOTH votes, and its match is worked out from them, never trusted", () => {
    const oneSided = v(twistFinished({}, { vote: readyVote({ you: "a", partnerVoted: true, revealed: true, votes: { "1": "a" }, match: "a" }) }));
    expect(oneSided.vote).toMatchObject({ revealed: false, votes: null, match: null });
    const split = v(twistFinished({}, { vote: readyVote({ you: "a", partnerVoted: true, revealed: true, votes: { "1": "a", "2": "b" }, match: "a" }) }));
    expect(split.vote).toMatchObject({ revealed: true, votes: { 1: "a", 2: "b" }, match: null });
    const agreed = v(twistFinished({}, { vote: readyVote({ you: "b", partnerVoted: true, revealed: true, votes: { "1": "b", "2": "b" } }) }));
    expect(agreed.vote).toMatchObject({ revealed: true, votes: { 1: "b", 2: "b" }, match: "b" });
  });

  it("there is no vote unless the dishes are ready", () => {
    expect(v(twistFinished({ concepts: "pending" }, { vote: readyVote({ you: "a" }) })).vote).toBeNull();
    expect(v(twistFinished({ concepts: "ready" }, { vote: readyVote({ you: "a" }) })).vote?.you).toBe("a");
  });

  it("an archived dish set with only one vote is {votes: null, match: null} even if the server sent it", () => {
    const view = v(
      twistFinished({}, {
        generation: 2,
        generations: [earlierSet(1, { vote: { votes: { "1": "a" }, match: "a" } })],
      }),
    );
    expect(view.generations[0]?.vote).toEqual({ votes: null, match: null });
    const bothSet = v(
      twistFinished({}, {
        generation: 2,
        generations: [earlierSet(1, { vote: { votes: { "1": "a", "2": "a" }, match: "c" } })],
      }),
    );
    // A forged match is replaced by the one the two votes really make.
    expect(bothSet.generations[0]?.vote).toEqual({ votes: { 1: "a", 2: "a" }, match: "a" });
    expect(v(twistFinished({}, { generation: 2, generations: [earlierSet(1, { vote: { votes: null, match: "a" } })] })).generations[0]?.vote).toEqual({ votes: null, match: null });
  });

  it("in an unrevealed Blind round the partner's chaos token, the basket and the other table's flags are dropped", () => {
    const view = v(
      twistPicking(
        { blind: true, you: 1, turn: 4, p2Picks: null, p2Count: 1 },
        {
          players: [
            { slot: 1, name: "Josh", pickCount: 2, picks: [pick(RIBEYE, 1)], chaosUsed: true, vetoUsed: false },
            { slot: 2, name: "Cupcake", pickCount: 1, picks: [pick(NATTO, 2, "chaos")], chaosUsed: true, vetoUsed: true },
          ],
          you: { slot: 1, chaosUsed: true, vetoUsed: false },
          basket: [pick(RIBEYE, 1), pick(NATTO, 2, "chaos")],
        },
        {
          options: [DURIAN, NATTO],
          offerIndex: 0,
          skipsRemaining: 2,
          role: "protein",
          chaosPair: true,
          vetoed: { snap: KIMCHI_SNAP },
          canChaos: true,
          canLucky: true,
          canVeto: true,
        },
      ),
    );
    expect(view.players[0].chaosUsed).toBe(true);
    expect(view.players[1]).toMatchObject({ chaosUsed: null, picks: null });
    expect(view.basket).toBeNull();
    expect(view.current).toMatchObject({
      options: null,
      offerIndex: null,
      role: null,
      chaosPair: null,
      vetoed: null,
      canChaos: null,
      canLucky: null,
      canVeto: null,
    });
  });

  it("the active Blind player keeps their own table's flags, but still has no veto", () => {
    const view = v(twistPicking({ blind: true, you: 1, turn: 3 }, {}, { chaosPair: true, canChaos: true, canLucky: false, canVeto: true }));
    expect(view.current).toMatchObject({ chaosPair: true, canChaos: true, canLucky: false, canVeto: null });
  });

  it("once a Blind round is revealed the partner's chaos token and the basket are shown", () => {
    const view = v(
      twistFinished({ blind: true }, {
        players: [
          { slot: 1, name: "Josh", pickCount: 5, picks: [RIBEYE, TOMATOES, PARSLEY, SALMON, DURIAN], chaosUsed: true, vetoUsed: false },
          { slot: 2, name: "Cupcake", pickCount: 5, picks: [NATTO, snap("a-b", "A B", "fruit", "x"), snap("c-d", "C D", "fruit", "x"), snap("e-f", "E F", "fruit", "x"), snap("g-h", "G H", "fruit", "x")], chaosUsed: false, vetoUsed: false },
        ],
        basket: [pick(RIBEYE, 1)],
      }),
    );
    expect(view.players.map((p) => p.chaosUsed)).toEqual([true, false]);
    expect(view.basket).toHaveLength(1);
  });

  it("an Open round keeps the partner's token and the pair's flags", () => {
    const view = v(
      twistPicking(
        { you: 2, turn: 1 },
        { players: [
          { slot: 1, name: "Josh", pickCount: 0, picks: [], chaosUsed: true, vetoUsed: false },
          { slot: 2, name: "Cupcake", pickCount: 0, picks: [], chaosUsed: false, vetoUsed: true },
        ] },
        { chaosPair: true, canVeto: true },
      ),
    );
    expect(view.players.map((p) => p.chaosUsed)).toEqual([true, false]);
    expect(view.current).toMatchObject({ chaosPair: true, canVeto: true });
  });
});

describe("the start-sheet options", () => {
  it("reads the catalogues and the chef's availability, dropping unknown ids and duplicates", () => {
    const options = parseCookoutOptions({
      styles: [
        { id: "cosy-pub", label: "Cosy pub", emoji: "🍺", blurb: "Warm and hearty" },
        { id: "mystery-meal", label: "Mystery" },
        { id: "cosy-pub", label: "Cosy pub again" },
        { id: "picnic", label: "  " },
        "junk",
      ],
      challenges: [{ id: "one-pan", label: "One pan only", emoji: "🍳" }, { id: "no-fryer", label: "No fryer" }],
      chef: true,
      pictures: "yes",
    });
    expect(options?.styles.map((s) => s.id)).toEqual(["cosy-pub"]);
    expect(options?.styles[0]).toEqual({ id: "cosy-pub", label: "Cosy pub", emoji: "🍺", blurb: "Warm and hearty" });
    expect(options?.challenges.map((c) => c.id)).toEqual(["one-pan"]);
    expect(options?.chef).toBe(true);
    expect(options?.pictures).toBe(false);
  });

  it("is null for anything that is not an object, and chef-less when the flag is missing", () => {
    expect(parseCookoutOptions(null)).toBeNull();
    expect(parseCookoutOptions([])).toBeNull();
    expect(parseCookoutOptions("x")).toBeNull();
    expect(parseCookoutOptions({})).toEqual({ styles: [], challenges: [], chef: false, pictures: false });
    expect(parseCookoutOptions({ styles: "x", challenges: 4, chef: "true" })).toEqual({ styles: [], challenges: [], chef: false, pictures: false });
  });

  it("is fetched from /cookout/options, and null when the route is missing or the read fails", async () => {
    serverFetch.mockResolvedValueOnce(json({ styles: [], challenges: [], chef: true, pictures: true }));
    expect(await getCookoutOptions(SESSION)).toEqual({ styles: [], challenges: [], chef: true, pictures: true });
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/cookout/options");
    serverFetch.mockResolvedValueOnce(json({}, 404));
    expect(await getCookoutOptions(SESSION)).toBeNull();
    serverFetch.mockRejectedValueOnce(new TypeError("offline"));
    expect(await getCookoutOptions(SESSION)).toBeNull();
    serverFetch.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await getCookoutOptions(SESSION)).toBeNull();
    serverFetch.mockRejectedValueOnce(new ServerLockedError());
    await expect(getCookoutOptions(SESSION)).rejects.toBeInstanceOf(ServerLockedError);
  });
});

describe("the round's linkable photos", () => {
  it("has one entry per message and drops what cannot be linked or shown", () => {
    const photos = parseRoundPhotos({
      photos: [
        { messageSeq: 9, attachmentId: "att-9", sender: "Josh", createdAt: 1793300100, picture: picture(9) },
        // a second photo of the same message is not offered
        { messageSeq: 9, attachmentId: "att-10", sender: "Josh", createdAt: 1793300100, picture: picture(10) },
        { messageSeq: 7, attachmentId: "att-7", sender: "Cupcake", createdAt: 1793300000, picture: picture(7) },
        // a picture from a third-party host is never kept
        { messageSeq: 6, attachmentId: "att-6", sender: "Josh", createdAt: 1, picture: { attachmentId: "att-6", thumbUrl: "https://evil.example/a.jpg", fullUrl: "https://evil.example/a.jpg" } },
        { messageSeq: 5, attachmentId: "", sender: "Josh", createdAt: 1, picture: picture(5) },
        { messageSeq: 0, attachmentId: "att-0", picture: picture(4) },
        { messageSeq: 3, attachmentId: "att-3", picture: null },
        "junk",
        null,
      ],
    });
    expect(photos?.map((p) => [p.messageSeq, p.attachmentId, p.sender])).toEqual([
      [9, "att-9", "Josh"],
      [7, "att-7", "Cupcake"],
    ]);
  });

  it("is null when the body has no photo list", () => {
    expect(parseRoundPhotos({})).toBeNull();
    expect(parseRoundPhotos({ photos: "x" })).toBeNull();
    expect(parseRoundPhotos(null)).toBeNull();
  });

  it("is fetched for the viewer, and a non-player or a missing round is told apart", async () => {
    serverFetch.mockResolvedValueOnce(json({ photos: [{ messageSeq: 9, attachmentId: "att-9", sender: "Josh", createdAt: 5, picture: picture(9) }] }));
    const result = await getRoundPhotos(SESSION, 41, "Cupcake & co");
    expect(result.ok).toBe(true);
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/cookout/41/photos?as=Cupcake%20%26%20co");
    serverFetch.mockResolvedValueOnce(json({ error: "not_player" }, 409));
    expect(await getRoundPhotos(SESSION, 41, "x")).toEqual({ ok: false, kind: "not_player" });
    serverFetch.mockResolvedValueOnce(json({}, 404));
    expect(await getRoundPhotos(SESSION, 41, "x")).toEqual({ ok: false, kind: "not_found" });
    serverFetch.mockResolvedValueOnce(json({ photos: "x" }));
    expect(await getRoundPhotos(SESSION, 41, "x")).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockRejectedValueOnce(new TypeError("offline"));
    expect(await getRoundPhotos(SESSION, 41, "x")).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockRejectedValueOnce(new ServerLockedError());
    await expect(getRoundPhotos(SESSION, 41, "x")).rejects.toBeInstanceOf(ServerLockedError);
  });
});

describe("the Recipe book's twist fields", () => {
  it("a core-era entry reads as not cooked, no style, nothing to remix", () => {
    const [first] = parseRecipeBook(bookBody()) ?? [];
    expect(first).toMatchObject({ generation: 1, cooked: null, dinnerPick: false, style: null, challenge: null, ingredients: [], leftovers: [] });
  });

  it("reads the generation, the cooked corner with both ratings, the dinner pick, style, challenge and the encore lists", () => {
    const [entry] =
      parseRecipeBook({
        recipes: [
          {
            ...(bookBody()["recipes"] as Json[])[0],
            generation: 2,
            cooked: { cookedAt: 1793300000, ratings: [{ name: "Josh", rating: 4 }, { name: "Cupcake", rating: 9 }, { name: "Third", rating: 1 }, "junk"], photo: picture(5) },
            dinnerPick: true,
            style: STYLE_COSY,
            challenge: CHALLENGE_PAN,
            ingredients: [RIBEYE, RIBEYE, { id: "" }, SALMON],
            leftovers: [TOMATOES],
          },
        ],
      }) ?? [];
    expect(entry?.generation).toBe(2);
    expect(entry?.cooked?.cookedAt).toBe(1793300000);
    // Two players: a third rating is ignored; a rating out of range is "not rated".
    expect(entry?.cooked?.ratings).toEqual([
      { name: "Josh", rating: 4 },
      { name: "Cupcake", rating: null },
    ]);
    expect(entry?.cooked?.photo?.attachmentId).toBe("att-5");
    expect(entry?.dinnerPick).toBe(true);
    expect(entry?.style).toEqual({ id: "cosy-pub", label: "Cosy pub", emoji: "🍺" });
    expect(entry?.challenge?.id).toBe("one-pan");
    expect(entry?.ingredients.map((s) => s.id)).toEqual(["ribeye-steak", "salmon-fillet"]);
    expect(entry?.leftovers.map((s) => s.id)).toEqual(["cherry-tomatoes"]);
  });

  it("garbage in the new fields reads as off", () => {
    const [entry] =
      parseRecipeBook({
        recipes: [{ ...(bookBody()["recipes"] as Json[])[0], generation: "two", cooked: { ratings: [] }, dinnerPick: "yes", style: { id: "mystery", label: "x" }, challenge: 3, ingredients: "x", leftovers: {} }],
      }) ?? [];
    expect(entry).toMatchObject({ generation: 1, cooked: null, dinnerPick: false, style: null, challenge: null, ingredients: [], leftovers: [] });
  });
});

describe("the twist calls: path and body", () => {
  const FINISHED = (): Response => json(finishedView());

  async function sent(call: () => Promise<unknown>): Promise<{ path: string; method: string; body: unknown; contentType: string | undefined }> {
    serverFetch.mockResolvedValueOnce(FINISHED());
    const result = (await call()) as { ok: boolean };
    expect(result.ok).toBe(true);
    const [path, init] = serverFetch.mock.calls[serverFetch.mock.calls.length - 1] as [string, RequestInit];
    return {
      path,
      method: init.method ?? "",
      body: JSON.parse(String(init.body)) as unknown,
      contentType: (init.headers as Record<string, string> | undefined)?.["Content-Type"],
    };
  }

  const table: ReadonlyArray<[string, () => Promise<unknown>, string, unknown]> = [
    ["lucky", () => luckyCookout(SESSION, 41, { sender: "Josh", moveId: "m1", turn: 3, offer: 1, optionIds: ["ribeye-steak", "salmon-fillet"] }), "/cookout/41/lucky", { sender: "Josh", moveId: "m1", turn: 3, offer: 1, optionIds: ["ribeye-steak", "salmon-fillet"] }],
    ["chaos", () => chaosCookout(SESSION, 41, { sender: "Josh", moveId: "m2", turn: 3, offer: 0, optionIds: ["a-b", "c-d"] }), "/cookout/41/chaos", { sender: "Josh", moveId: "m2", turn: 3, offer: 0, optionIds: ["a-b", "c-d"] }],
    ["veto", () => vetoCookout(SESSION, 41, { sender: "Cupcake", moveId: "m3", turn: 3, offer: 2, ingredientId: "salmon-fillet" }), "/cookout/41/veto", { sender: "Cupcake", moveId: "m3", turn: 3, offer: 2, ingredientId: "salmon-fillet" }],
    ["star", () => starCookout(SESSION, 41, { sender: "Josh", ingredientId: "thick-white-toast" }), "/cookout/41/star", { sender: "Josh", ingredientId: "thick-white-toast" }],
    ["wildcard lift", () => wildcardCookout(SESSION, 41, { sender: "Josh", moveId: "m4", lift: true }), "/cookout/41/wildcard", { sender: "Josh", moveId: "m4", lift: true }],
    ["wildcard decline", () => wildcardCookout(SESSION, 41, { sender: "Josh", moveId: "m5", lift: false }), "/cookout/41/wildcard", { sender: "Josh", moveId: "m5", lift: false }],
    ["vote", () => voteCookout(SESSION, 41, { sender: "Josh", generation: 2, conceptId: "b" }), "/cookout/41/vote", { sender: "Josh", generation: 2, conceptId: "b" }],
    ["swap propose", () => proposeSwap(SESSION, 41, { sender: "Josh", moveId: "m6", ingredientId: "flat-leaf-parsley" }), "/cookout/41/swap/propose", { sender: "Josh", moveId: "m6", ingredientId: "flat-leaf-parsley" }],
    ["swap choose", () => chooseSwap(SESSION, 41, { sender: "Cupcake", moveId: "m7", ingredientId: "red-lentils" }), "/cookout/41/swap/choose", { sender: "Cupcake", moveId: "m7", ingredientId: "red-lentils" }],
    ["swap cancel", () => cancelSwap(SESSION, 41, { sender: "Cupcake" }), "/cookout/41/swap/cancel", { sender: "Cupcake" }],
    ["mark cooked", () => markCooked(SESSION, 41, 2, "a", { sender: "Josh", cooked: true }), "/cookout/41/recipes/2/a/cooked", { sender: "Josh", cooked: true }],
    ["unmark cooked", () => markCooked(SESSION, 41, 1, "c", { sender: "Josh", cooked: false }), "/cookout/41/recipes/1/c/cooked", { sender: "Josh", cooked: false }],
    ["rating", () => rateRecipe(SESSION, 41, 1, "b", { sender: "Josh", rating: 4 }), "/cookout/41/recipes/1/b/rating", { sender: "Josh", rating: 4 }],
    ["clear rating", () => rateRecipe(SESSION, 41, 1, "b", { sender: "Josh", rating: null }), "/cookout/41/recipes/1/b/rating", { sender: "Josh", rating: null }],
    ["link photo", () => linkRecipePhoto(SESSION, 41, 1, "a", { sender: "Josh", messageSeq: 9, attachmentId: "att-9" }), "/cookout/41/recipes/1/a/photo", { sender: "Josh", messageSeq: 9, attachmentId: "att-9" }],
    ["unlink photo", () => linkRecipePhoto(SESSION, 41, 1, "a", { sender: "Josh", messageSeq: null, attachmentId: null }), "/cookout/41/recipes/1/a/photo", { sender: "Josh", messageSeq: null, attachmentId: null }],
    ["bank (with generation)", () => bankCookoutConcept(SESSION, 41, "b", { sender: "Josh", moveId: "m8", generation: 2 }), "/cookout/41/concepts/b/bank", { sender: "Josh", moveId: "m8", generation: 2 }],
    ["concepts retry (with generation)", () => retryCookoutConcepts(SESSION, 41, { sender: "Josh", generation: 2 }), "/cookout/41/concepts/retry", { sender: "Josh", generation: 2 }],
    ["pictures retry (with generation)", () => retryCookoutPictures(SESSION, 41, { sender: "Josh", generation: 2 }), "/cookout/41/pictures/retry", { sender: "Josh", generation: 2 }],
    ["recipe retry (with generation)", () => retryCookoutRecipe(SESSION, 41, "c", { sender: "Josh", generation: 2 }), "/cookout/41/concepts/c/recipe/retry", { sender: "Josh", generation: 2 }],
  ];

  for (const [name, call, path, body] of table) {
    it(`${name} POSTs ${path} with its JSON body`, async () => {
      const out = await sent(call);
      expect(out.path).toBe(path);
      expect(out.method).toBe("POST");
      expect(out.contentType).toBe("application/json");
      expect(out.body).toEqual(body);
    });
  }

  it("a 409 names its kind: token_used and recipe_pending are their own, the rest keep theirs", async () => {
    for (const error of ["token_used", "recipe_pending", "exhausted", "skip_exhausted", "not_player", "not_your_turn", "bad_state"]) {
      serverFetch.mockResolvedValueOnce(json({ error }, 409));
      expect(await chaosCookout(SESSION, 41, { sender: "Josh", moveId: "m", turn: 1, offer: 0, optionIds: ["a-b", "c-d"] }), error).toEqual({ ok: false, kind: error });
    }
    serverFetch.mockResolvedValueOnce(json({ error: "mystery" }, 409));
    expect(await vetoCookout(SESSION, 41, { sender: "Josh", moveId: "m", turn: 1, offer: 0, ingredientId: "x-y" })).toEqual({ ok: false, kind: "bad_state" });
    serverFetch.mockResolvedValueOnce(json({ error: "recipe_pending" }, 409));
    expect(await proposeSwap(SESSION, 41, { sender: "Josh", moveId: "m", ingredientId: "x-y" })).toEqual({ ok: false, kind: "recipe_pending" });
  });

  it("other statuses map as the core calls do, and a lock is rethrown", async () => {
    serverFetch.mockResolvedValueOnce(json({}, 422));
    expect(await voteCookout(SESSION, 41, { sender: "Josh", generation: 1, conceptId: "a" })).toEqual({ ok: false, kind: "invalid" });
    serverFetch.mockResolvedValueOnce(json({}, 503));
    expect(await voteCookout(SESSION, 41, { sender: "Josh", generation: 1, conceptId: "a" })).toEqual({ ok: false, kind: "game_unavailable" });
    serverFetch.mockResolvedValueOnce(json({}, 404));
    expect(await markCooked(SESSION, 41, 1, "a", { sender: "Josh", cooked: true })).toEqual({ ok: false, kind: "not_found" });
    serverFetch.mockRejectedValueOnce(new TypeError("offline"));
    expect(await starCookout(SESSION, 41, { sender: "Josh", ingredientId: "x-y" })).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockRejectedValueOnce(new ServerLockedError());
    await expect(cancelSwap(SESSION, 41, { sender: "Josh" })).rejects.toBeInstanceOf(ServerLockedError);
  });
});

describe("starting a round with twists", () => {
  it("POSTs every chosen twist, and a 422 reads as 'invalid'", async () => {
    const message = { seq: 41, cookout: { state: "picking", rev: 1 } };
    serverFetch.mockResolvedValueOnce(json({ message }, 201));
    const input = {
      clientId: "c1",
      sender: "Josh",
      deviceId: "d1",
      blind: true,
      style: "spin" as const,
      challenge: "one-pan" as const,
      wildcard: true,
      stars: true,
      fridgeSeedId: "cherry-tomatoes",
      encore: { fromSeq: 30, generation: 2, conceptId: "c" as const, kind: "leftovers" as const, seedIds: ["aged-kimchi"] },
    };
    const result = await createCookout(SESSION, input);
    expect(result.ok).toBe(true);
    const [path, init] = serverFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/cookout");
    expect(JSON.parse(String(init.body))).toEqual(input);
    serverFetch.mockResolvedValueOnce(json({ error: "invalid" }, 422));
    expect(await createCookout(SESSION, input)).toEqual({ ok: false, kind: "invalid" });
    serverFetch.mockResolvedValueOnce(json({}, 503));
    expect(await createCookout(SESSION, input)).toEqual({ ok: false, kind: "game_unavailable" });
  });
});

describe("the fridge raid's search", () => {
  it("does not even ask the server for a query shorter than two characters (after trimming) or longer than forty", async () => {
    for (const q of ["", "a", "  a  ", " ", "x".repeat(41)]) {
      expect(await searchIngredients(SESSION, q), JSON.stringify(q)).toEqual({ ok: false, kind: "invalid" });
    }
    expect(serverFetch).not.toHaveBeenCalled();
  });

  it("asks for the trimmed, encoded query and reads at most twenty distinct bank entries", async () => {
    const many = Array.from({ length: 30 }, (_, i) => snap(`item-${i}`, `Item ${i}`, "vegetables", "🥕"));
    serverFetch.mockResolvedValueOnce(json({ ingredients: [...many, many[0], { id: "" }] }));
    const result = await searchIngredients(SESSION, "  ripe tom ");
    expect(serverFetch.mock.calls[0]?.[0]).toBe("/cookout/ingredients?q=ripe%20tom");
    expect(result.ok && result.ingredients).toHaveLength(20);
  });

  it("maps a 422, a 503, other failures and a lock", async () => {
    serverFetch.mockResolvedValueOnce(json({}, 422));
    expect(await searchIngredients(SESSION, "to")).toEqual({ ok: false, kind: "invalid" });
    serverFetch.mockResolvedValueOnce(json({}, 503));
    expect(await searchIngredients(SESSION, "to")).toEqual({ ok: false, kind: "game_unavailable" });
    serverFetch.mockResolvedValueOnce(json({}, 500));
    expect(await searchIngredients(SESSION, "to")).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockResolvedValueOnce(json({ ingredients: "x" }));
    expect(await searchIngredients(SESSION, "to")).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockRejectedValueOnce(new TypeError("offline"));
    expect(await searchIngredients(SESSION, "to")).toEqual({ ok: false, kind: "unavailable" });
    serverFetch.mockRejectedValueOnce(new ServerLockedError());
    await expect(searchIngredients(SESSION, "to")).rejects.toBeInstanceOf(ServerLockedError);
  });
});
